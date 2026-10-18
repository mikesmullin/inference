#!/usr/bin/env python3
"""Adapter so inference.mjs can launch H2O-Lightning-4B as the :1237 System One slot.

inference.mjs builds non-llama backends as

    <server_bin> <artifact> --model-id <alias> [args...]

`server_bin` is bin/h2o-serve (a symlink to the mail1 venv python, so the
process shows up as `h2o-serve` for pgrep/kill instead of a bare `python`),
and this file is the `artifact`. It stands up the two processes the model
needs — stock vLLM serving the weights, plus the repo's own
`h2o_lightning_shim.py` translating the System One wire format — and stays in
the foreground as the process inference.mjs tracks:

    vllm serve <weights> --port <vllm-port> [--max-model-len …] [--gpu-memory-utilization …]
    python <weights>/h2o_lightning_shim.py --config <weights>/serve_config.json \
        --vllm http://127.0.0.1:<vllm-port> --port <port>

A SIGTERM/SIGINT to this process stops both children, so `inference.mjs
kill-son` frees the GPU. The monitor restarts this wrapper on crash — note a
restart reloads the weights into vLLM, which takes a minute or two.

The weights live with the other models (~/.lmstudio/models/h2oai/…); the venv
is mail1's (uv, python 3.12, vllm 0.30.0+cu129).
"""
import argparse
import os
import signal
import subprocess
import sys
import time
import urllib.request

VLLM_PORT = 18000  # internal; the shim's :1237 is the only public port


def wait_for(url, what, timeout=600):
    t0 = time.time()
    while time.time() - t0 < timeout:
        try:
            with urllib.request.urlopen(url, timeout=5) as r:
                if r.status < 400:
                    print(f"h2o-serve: {what} up at {url}", flush=True)
                    return True
        except Exception:
            pass
        time.sleep(5)
    return False


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model-id", default="default")  # dropped; the shim names the model
    ap.add_argument("--weights", required=True)
    ap.add_argument("--venv", required=True)
    ap.add_argument("--vllm-port", type=int, default=VLLM_PORT)
    ap.add_argument("--port", type=int, default=1237)
    ap.add_argument("--max-model-len", type=int, default=40960)
    ap.add_argument("--gpu-memory-utilization", type=float, default=0.90)
    args = ap.parse_args()

    # inference.mjs expands ~/ only for server_bin/artifact/-m, not for custom
    # args, so a `--weights ~/.lmstudio/…` arrives with the tilde intact.
    args.weights = os.path.expanduser(args.weights)
    args.venv = os.path.expanduser(args.venv)
    vllm_bin = os.path.join(args.venv, "bin", "vllm")
    vllm = [
        vllm_bin, "serve", args.weights,
        "--served-model-name", "h2oai/h2o-lightning-4b",
        "--host", "127.0.0.1", "--port", str(args.vllm_port),
        "--max-model-len", str(args.max_model_len),
        "--gpu-memory-utilization", str(args.gpu_memory_utilization),
        "--limit-mm-per-prompt", '{"image": 4, "video": 0}',
        "--mm-processor-kwargs", '{"max_pixels": 1048576}',
    ]
    shim = [
        os.path.join(args.venv, "bin", "python"),
        os.path.join(args.weights, "h2o_lightning_shim.py"),
        "--config", os.path.join(args.weights, "serve_config.json"),
        "--vllm", f"http://127.0.0.1:{args.vllm_port}",
        "--port", str(args.port),
    ]

    kids = []

    def stop(signum=None, frame=None):
        for p in kids:
            try:
                p.terminate()
            except Exception:
                pass
        for p in kids:
            try:
                p.wait(timeout=30)
            except Exception:
                try:
                    p.kill()
                except Exception:
                    pass
        sys.exit(0 if signum in (None, signal.SIGTERM, signal.SIGINT) else 1)

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)

    print(f"h2o-serve: starting vLLM ({' '.join(vllm)})", flush=True)
    kids.append(subprocess.Popen(vllm))
    if not wait_for(f"http://127.0.0.1:{args.vllm_port}/v1/models", "vllm"):
        print("h2o-serve: vLLM never came up; exiting", flush=True)
        stop()
    print(f"h2o-serve: starting shim ({' '.join(shim)})", flush=True)
    kids.append(subprocess.Popen(shim))
    if not wait_for(f"http://127.0.0.1:{args.port}/health", "shim"):
        print("h2o-serve: shim never came up; exiting", flush=True)
        stop()
    print(f"h2o-serve: System One on http://127.0.0.1:{args.port}/v1/systemone", flush=True)

    # Stay in the foreground as the tracked process; a child dying is a crash.
    while True:
        for p in kids:
            if p.poll() is not None:
                print(f"h2o-serve: child {p.args[0]} exited with {p.returncode}; exiting", flush=True)
                stop()
        time.sleep(5)


if __name__ == "__main__":
    main()
