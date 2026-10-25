#!/usr/bin/env python3
"""Adapter so inference.mjs can launch Strata's OpenAI/Anthropic server.

inference.mjs builds non-llama backends as

    <server_bin> <artifact> --model-id <alias> [args...]

(see the `qwen3.6-35b-a3b-ninfer` profile). Strata's server is a Python module
that instead wants

    python serve/server.py --engine strata --config <json> --port <n>

and has no --model-id: it takes the served model id from `model_name` in the
engine config that Strata's own setup.py generates. So this file stands in as
the `artifact` and reconciles the two:

  * drops --model-id and adds --engine strata;
  * copies the setup.py-generated config to <script_dir>/strata-served-<tag>.json
    with `model_name` set to the alias, so GET /v1/models reports `default`
    like every other profile on the :1234 slot. The generated config is left
    untouched, so `./setup.sh --setup` and `--calibrate` keep owning it;
  * calls serve.server.main() in place, so the process inference.mjs tracks is
    the server itself.

`server_bin` is .venv/bin/strata-serve, a symlink to that venv's python, so the
process is named `strata-serve` for pgrep/kill instead of a bare `python`.
"""
import json
import sys
from pathlib import Path

# Strata checkout: holds the serve/ package, the engine binary and the venv.
STRATA_ROOT = Path("/workspace/tmp/strata")
# Same script_dir as config.yaml, so the derived config sits with the launcher
# scripts rather than in STRATA_ROOT (setup.py globs strata-*.json there and
# would offer a derived file as an installed model).
SCRIPT_DIR = Path.home() / ".cache" / "inference"

sys.path.insert(0, str(STRATA_ROOT))

argv = sys.argv[1:]
alias, out = None, []
text_only = "--text-only" in argv
argv = [a for a in argv if a != "--text-only"]
i = 0
while i < len(argv):
    if argv[i] == "--model-id" and i + 1 < len(argv):
        alias = argv[i + 1]
        i += 2
        continue
    out.append(argv[i])
    i += 1

# Re-point --config at a copy whose model_name is the alias inference.mjs asked for.
if alias:
    for j, a in enumerate(out):
        if a == "--config" and j + 1 < len(out):
            src = Path(out[j + 1])
            cfg = json.loads(src.read_text(encoding="utf-8-sig"))  # setup.py may leave a BOM
            if cfg.get("model_name") != alias or text_only:
                cfg["model_name"] = alias
                if text_only:
                    cfg.pop("vision", None)
                    cfg["args"] = [a for a in cfg.get("args", []) if a != "--vision"]
                SCRIPT_DIR.mkdir(parents=True, exist_ok=True)
                dst = SCRIPT_DIR / f"strata-served-{src.stem}.json"
                dst.write_text(json.dumps(cfg, indent=1), encoding="utf-8")
                out[j + 1] = str(dst)
            break

sys.argv = ["strata-serve", "--engine", "strata", *out]

from serve.server import main  # noqa: E402  (import after sys.path is set)

raise SystemExit(main())
