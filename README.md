# inference

Local LLM server profiles + launcher. Each profile describes one
`llama-server` invocation; `inference.mjs <profile>` stops any running
server and starts the new one via the configured **launcher backend** —
a Ghostty window, or a tiled pane in the current zellij session — so
server logs stay visible (`tail -F` of the server log). `inference.mjs`
itself waits until `/health` is 200 and then **returns**; a detached
monitor process owns `llama-server` and restarts it on crash (e.g. CUDA
abort). The monitor does **not** restart after `inference.mjs kill`
(SIGTERM/SIGKILL). Closing the log window only stops `tail`, not the
server — use `inference.mjs kill` to stop it.

Born from the [mari](https://github.com/mikesmullin/mari) `ai` activity:
long hotkey shell commands moved here behind model-name aliases, so mari
hotkeys are one-liners like `~/inference.mjs qwen3.8-27b-nvfp4-mtp-q8attn`.

## Files

- `config.yaml` — model profiles and global settings
- `inference.mjs` — the launcher (Bun)

## Usage

```bash
inference.mjs <profile> [--dry-run] [--launcher ghostty|zellij]
                                       # launch (or relaunch) a server
inference.mjs list                    # show available profiles
inference.mjs kill                    # stop the :1234 text slot
inference.mjs kill-son                # stop the :1237 System One slot
inference.mjs kill-all                # stop text, System One, and OCR slots
inference.mjs kill-ocr                # stop only OCR on :1239
inference.mjs last | son-last | ocr-last          # relaunch the last profile per slot
```

## Slots

Three independent ports, locks, and logs. Launching one slot never stops
the others:

- `llm` — text models on **:1234** (`server.lock`, `llama.log`). The AGL
  `default_model` and pi `llama-server/default` consumers track this slot.
- `systemone` — System One decision models on **:1237** (`systemone.lock`,
  `systemone.log`). A profile opts in with `slot: systemone`; consumer sync is
  skipped (a decision endpoint cannot chat). First resident:
  `h2o-lightning-4b` (mari hotkey `l`) — H2O-Lightning-4B via stock vLLM plus
  the repo's `h2o_lightning_shim.py`, fronted by `h2o-serve.py`, weights in
  `~/.lmstudio/models/h2oai/`, venv in mail1's `.venv`.

- `ocr` — PaddleOCR PP-OCRv6 medium on **:1239** (`ocr.lock`, `ocr.log`).
  Preset `paddleocr`, Mari AI hotkey `o`; `k`/`kill-all` includes it.
  Uses `/workspace/mcp-computer-use/scripts/ocr-server.py` and that project's
  `.venv-ocr`. It warms the model before reporting health. The MCP is only an
  HTTP client; absent service means CPU fallback, never automatic GPU startup.
  `kill-ocr` stops the monitor/process group and handles untracked `paddle-ocr`
  processes, escalating to SIGKILL if necessary. Roughly 1.8 GiB process VRAM
  sampled on RTX 5090; warm screenshot inference about one second.

## Launchers

`launcher:` in `config.yaml` picks where the server opens:

- `ghostty` — new Ghostty window (the original behavior, needs a
  graphical session)
- `zellij` — tiled pane in the target zellij session (run mari
  inside zellij; hotkey `q` then just works)
- `auto` — zellij when `$ZELLIJ_SESSION_NAME` is set, else ghostty

`--launcher` overrides the config per invocation. Zellij uses one reusable **pane**
per slot inside whichever tab is currently active. It never creates a tab.

| Pane group | Port | Presets |
|---|---|---|
| Text/misc (`llm`) | 1234 | Text/misc models |
| Jev-like (`systemone`) | 1237 | H2O, Laya, qwen3.8-27b-simplejev |
| OCR (`ocr`) | 1239 | PaddleOCR |

A launch replaces its existing group pane in place if that pane is in the current
tab. Otherwise it opens a pane in the current tab, then closes only that group's
old log viewers elsewhere in the session. This keeps one viewer per group while
preserving the other groups and unrelated panes (Mari, htop, nvtop, shells).
The new viewer must open successfully before any old viewer is removed.
`focus: false` preserves focus; `direction` sets the split for new panes.
`zellij.session` targets a session when launching from outside it. `--dry-run`
reports the group/current-tab behavior without changing panes.

Port grouping does not change backend APIs: the SimpleJev preset still speaks
its llama.cpp API, but now listens on **1237**. Its consumers must use that port.
Only one profile may occupy a slot; stop that slot before switching profiles.
Process discovery distinguishes a Jev llama-server on :1237 from text on :1234.

Each launch:

1. Stops untracked servers in the selected slot (TERM, then KILL after 10s); refuses double-launch when a live tracked profile already occupies it. Other slots are untouched.
2. Writes a monitor script (`<script_dir>/<profile>.sh`) and a log-view script (`<profile>.view.sh`)
3. Syncs consumers of the :1234 slot: AGL `default_model` (stable
   `llama-server:default`) plus the AGL `llama-server` default window, and
   the pi `llama-server/default` contextWindow — all set to the profile's
   `context_window`
4. Opens Ghostty or reuses the group’s Zellij pane on `tail -F` of that slot’s log
5. Spawns the monitor as a detached process (stdio → the slot’s log), waits for `/health`, then exits

`--dry-run` prints the assembled command, script body, and Ghostty
invocation without touching anything.

## config.yaml

```yaml
ghostty: ghostty                 # binary used to open the server window
wait_after_exit: true            # keep window open after exit (read crashes)
agl_config: ~/.config/agl/config.yaml  # default_model updated on launch (null to skip)
script_dir: ~/.cache/inference   # generated launcher scripts live here
launcher: auto                   # ghostty | zellij | auto (zellij if $ZELLIJ_SESSION_NAME)
zellij:
  session: null                  # null = current session
  direction: null                # null = default split; or right/down/left/up
  focus: false                   # false = --no-focus, keep focus in mari

models:
  qwen3.8-27b-nvfp4-mtp-q8attn:
    context_window: 262144  # synced to AGL + pi on launch (else -c/--max-context)
    model: ~/.lmstudio/models/.../model.gguf   # -m (required)
    mmproj: ~/.lmstudio/models/.../mmproj.gguf # --mmproj (vision models)
    draft: ~/.lmstudio/models/.../draft.gguf   # -md (speculative draft model)
    args:                                      # bare "flag" or [flag, value] pairs
      - [--spec-type, draft-mtp]
      - [--spec-draft-n-max, 4]
      - [-c, 262144]
      - --jinja
```

Notes:

- Quote YAML-significant values: `"on"` (else boolean `true`), and any
  value containing `,` or `: ` inside a pair, e.g.
  `[--override-kv, "a=1,b=2"]`.
- The launcher fail-fasts if a profile is unknown or a model file is missing.
- Every profile serves model id `default` on :1234 (the pi harness sends
  model "default" literally and ninfer validates the id). Profile identity
  lives in the profile name (`lock.profile` / `last_profile`), not the id.
- Custom binaries: set `server_bin`. With `model`/`mmproj`/`draft` the command
  stays llama-style (`<bin> --alias default -m ... + args`) — for compatible
  forks, e.g. PrismML's ternary-kernel build (see `ternary-bonsai-2-27b`).
  With `artifact` instead, the command becomes
  `<bin> <artifact> --model-id default + args` for non-llama backends
  (see `qwen3.6-35b-a3b-ninfer` / ninfer-serve). Either way the backend must
  serve OpenAI-compatible routes on the `--port` in `args` with a llama-style
  `GET /health`. `server_process` overrides the
  pgrep name for stop/kill tracking (default `llama-server`).

## Requirements

- [llama.cpp](https://github.com/ggml-org/llama.cpp) `llama-server` (recent build for `--reasoning-effort`)
- [Ghostty](https://ghostty.org) (new-window log visibility)
- [Bun](https://bun.sh) (runs `inference.mjs`, parses YAML)

## License

MIT — see [LICENSE](LICENSE).
