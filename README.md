# inference

Local LLM server profiles + launcher. Each profile describes one
`llama-server` invocation; `inference.mjs <profile>` stops any running
server and starts the new one in its **own Ghostty window**, so server
logs stay visible and a crash is obvious (the window is kept open after
exit — the window is the process monitor for now).

Born from the [mari](https://github.com/mikesmullin/mari) `ai` activity:
long hotkey shell commands moved here behind model-name aliases, so mari
hotkeys are one-liners like `~/inference.mjs qwen3.8-27b-nvfp4-mtp-q8attn`.

## Files

- `config.yaml` — model profiles and global settings
- `inference.mjs` — the launcher (Bun)

## Usage

```bash
inference.mjs <profile> [--dry-run]   # launch (or relaunch) a server
inference.mjs list                    # show available profiles
```

Each launch:

1. Stops any running `llama-server` (SIGTERM, then SIGKILL after 10s) to free `127.0.0.1:1234`
2. Writes a launcher script to `<script_dir>/<profile>.sh` (re-generated every time)
3. Points `default_model` in the AGL agent config at the new server
4. Opens a new Ghostty window running the launcher (`-e` + `--wait-after-command`)

`--dry-run` prints the assembled command, script body, and Ghostty
invocation without touching anything.

## config.yaml

```yaml
ghostty: ghostty                 # binary used to open the server window
wait_after_exit: true            # keep window open after exit (read crashes)
agl_config: ~/.config/agl/config.yaml  # default_model updated on launch (null to skip)
script_dir: ~/.cache/inference   # generated launcher scripts live here

models:
  qwen3.8-27b-nvfp4-mtp-q8attn:
    server_alias: qwen3.8-27b-nvfp4-mtp-q8attn  # --alias (defaults to profile name)
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

## Requirements

- [llama.cpp](https://github.com/ggml-org/llama.cpp) `llama-server` (recent build for `--reasoning-effort`)
- [Ghostty](https://ghostty.org) (new-window log visibility)
- [Bun](https://bun.sh) (runs `inference.mjs`, parses YAML)

## License

MIT — see [LICENSE](LICENSE).
