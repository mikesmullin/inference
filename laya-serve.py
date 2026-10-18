#!/usr/bin/env python3
"""Adapter so inference.mjs can launch Laya as the :1237 System One slot.

mail1's rule engine (server/src/rules.rs::SystemOne) talks to a "System One"
shim over a fixed wire contract:

    GET  /health
    POST /v1/systemone  body = {"state": <premise string>,
                               "questions": {<key>: {type, instructions,
                                                      criteria, …}}}
       -> {"answers": {<key>: <answer object>}}

  choice answer: {choice, confidence, probabilities: {option: float}}
  noul   answer: {noul, confidence}
  score  answer: {score, confidence}

Laya (convaiinnovations/laya, 421M ModernBERT-large) is an in-process
decision model: it is loaded once and answers `predict(text, questions)`,
which takes a *dict of many questions at once* and returns one answer per key.
That maps directly onto mail1 sending all of a rule set's prompts in one POST.
So this process **is** the worker — no vLLM child, no fork pool. One laya agent
per process ≈ 4.2 GB VRAM (see /workspace/email2/docs/JEVLIKE.md §7); keep it
at one instance when sharing the GPU with the :1234 text model.

Conventions that keep this drop-in with inference.mjs:
  * argv[0] is the launcher's server_bin (a symlink named `laya-serve`), so
    pgrep -x laya-serve finds it (see pidsOfServer in inference.mjs).
  * inference.mjs prepends `--model-id default`; that is accepted and ignored.
  * SIGTERM/SIGINT from `~/inference.mjs kill-son` sets the shutdown event and
    exits cleanly, so the monitor reaps it and `kill-son` clears the lock.
"""
import argparse
import ctypes
import json
import os
import signal
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

# Force the process name (comm) to `laya-serve` so the launcher's pgrep
# (`pidsOfServer`, pattern "laya-serve") can find and manage it — even though
# we were exec'd as a python running a `.py` file, whose comm would otherwise
# be `python`/`python3.12`. PR_SET_NAME is a Linux-specific no-op on other
# platforms.
def _set_process_name(name: str):
    """Set the 15-char process name. Must run before heavy libs import.

    PR_SET_NAME passes the name as a char* (argval); ctypes defaults args to
    c_int, so the name buffer must be declared c_void_p explicitly or the call
    is silent-garbage. (PR_SET_NAME = 15.)
    """
    try:
        libc = ctypes.CDLL(None)
        libc.argtypes = [ctypes.c_int, ctypes.c_void_p, ctypes.c_int, ctypes.c_int, ctypes.c_int]
        libc.prctl(15, name.encode("utf8")[:15], 0, 0, 0)
    except Exception:
        pass

_set_process_name("laya-serve")

MODEL_ID = "convaiinnovations/laya"
DEFAULT_PORT = 1237
DEFAULT_DEVICE = "cuda"
DEFAULT_THREADS = 8

agent = None
ask_lock = threading.Lock()
shutting = threading.Event()


def _shutdown(signum=None, frame=None):
    shutting.set()
    sys.stdout.write("laya-serve: shutdown signalled\n")
    sys.stdout.flush()
    time.sleep(0.2)
    sys.exit(0)


def load_agent(device, threads):
    global agent
    import torch
    torch.set_num_threads(threads)
    import laya
    t0 = time.perf_counter()
    agent = laya.load(MODEL_ID, device=device)
    # one warm pass so the first real mail1 request does not carry the
    # CUDA-context allocation
    agent.predict("From: someone.\nSubject: hello.\nBody: nothing.",
                  {"w": {"type": "choice", "instructions": "What should be done with this email?",
                         "criteria": {"archive": "noise", "skip": "judgment"}}})
    sys.stdout.write(f"laya loaded on {device} in {time.perf_counter() - t0:.1f}s "
                     f"(1 worker, ~4.2 GB)\n")
    sys.stdout.flush()


def normalize(question: dict) -> dict:
    """Keep only the keys laya's predict contract expects, per question type."""
    out = {
        "type": str(question.get("type") or "choice"),
        "instructions": str(question.get("instructions")
                            or "What should be done with this email?"),
    }
    if question.get("criteria") is not None:
        out["criteria"] = question["criteria"]
    return out


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):  # keep the log clean for the tail -F pane
        pass

    def _send(self, code: int, obj: dict):
        data = json.dumps(obj).encode("utf8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self.path.rstrip("/") in ("/", "/health"):
            self._send(200, {"ok": True, "model": MODEL_ID})
        else:
            self._send(404, {"error": "GET /health or POST /v1/systemone"})

    def do_POST(self):
        if self.path.rstrip("/") != "/v1/systemone":
            self._send(404, {"error": "POST /v1/systemone"})
            return
        length = int(self.headers.get("Content-Length", 0) or 0)
        body = self.rfile.read(length) if length else b"{}"
        try:
            payload = json.loads(body or b"{}")
        except json.JSONDecodeError as e:
            self._send(400, {"error": f"bad JSON: {e}"})
            return
        state = str(payload.get("state") or "")
        questions = payload.get("questions") or {}
        if shutting.is_set():
            self._send(503, {"error": "shutting down"})
            return
        if not isinstance(questions, dict) or not questions:
            self._send(400, {"error": "questions must be a non-empty object"})
            return
        try:
            qmap = {str(k): normalize(v) for k, v in questions.items()}
            with ask_lock:
                res = agent.predict(state, qmap)
            self._send(200, {"answers": res.get("answers", {})})
        except Exception as e:
            self._send(502, {"error": f"laya predict failed: {e}"})


def main():
    ap = argparse.ArgumentParser(prog="laya-serve")
    # --model-id is prepended by inference.mjs; accepted so the shim never
    # chokes on it (Laya serves one model named by the profile, not per-id).
    ap.add_argument("--model-id", default="default", help="ignored; kept for launcher parity")
    ap.add_argument("--device", default=DEFAULT_DEVICE, choices=["cuda", "cpu"])
    ap.add_argument("--port", type=int, default=DEFAULT_PORT)
    ap.add_argument("--workers", type=int, default=1,
                    help="accepted for config parity; this shim is always a single in-process worker")
    ap.add_argument("--threads", type=int, default=DEFAULT_THREADS)
    args = ap.parse_args()

    signal.signal(signal.SIGTERM, _shutdown)
    signal.signal(signal.SIGINT, _shutdown)

    load_agent(args.device, args.threads)

    server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    sys.stdout.write(f"laya-serve: listening on http://127.0.0.1:{args.port} "
                     f"(GET /health, POST /v1/systemone)\n")
    sys.stdout.flush()
    try:
        server.serve_forever()
    finally:
        server.server_close()
        sys.stdout.write("laya-serve: closed\n")
        sys.stdout.flush()


if __name__ == "__main__":
    main()
