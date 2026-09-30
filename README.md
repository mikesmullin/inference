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
```

## Launchers

`launcher:` in `config.yaml` picks where the server opens:

- `ghostty` — new Ghostty window (the original behavior, needs a
  graphical session)
- `zellij` — tiled pane in the target zellij session (run mari
  inside zellij; hotkey `q` then just works)
- `auto` — zellij when `$ZELLIJ_SESSION_NAME` is set, else ghostty

`--launcher` overrides the config per invocation. The zellij backend
opens a tiled pane named after the server alias, without stealing
focus (`focus: false`). Optional `zellij.direction` (`right` / `down` /
`left` / `up`) picks the split; omit it for zellij's default. The pane
runs `tail -F` on the server log so crash output stays readable,
mirroring `wait_after_exit` for Ghostty. Set `zellij.session` only if
launching from outside the target session.

Each launch:

1. Stops any running `llama-server` **and** its detached monitor (SIGTERM, then SIGKILL after 10s) to free `127.0.0.1:1234`
2. Writes a monitor script (`<script_dir>/<profile>.sh`) and a log-view script (`<profile>.view.sh`)
3. Syncs consumers of the :1234 slot: AGL `default_model` (stable
   `llama-server:default`) plus the AGL `llama-server` default window, and
   the pi `llama-server/default` contextWindow — all set to the profile's
   `context_window`
4. Opens Ghostty/zellij on `tail -F <script_dir>/llama.log`
5. Spawns the monitor as a detached process (stdio → `llama.log`), waits for `/health`, then exits

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
