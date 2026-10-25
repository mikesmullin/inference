#!/usr/bin/env bun
// inference.mjs — launch an LLM server profile via the configured launcher
// backend (a Ghostty window, or a tiled pane in the current zellij session).
// Profiles are stock llama-server invocations by default. server_bin selects a
// custom binary: a compatible fork (llama-style flags, needs `model`) or a
// different OpenAI-compatible backend (ninfer-style, needs `artifact`). Either
// way it serves the same :1234 slot and /health contract.
//
// Usage:
//   ~/inference.mjs <profile> [--dry-run] [--launcher ghostty|zellij]
//                                       start (or restart) the server
//   ~/inference.mjs list                show available profiles
//   ~/inference.mjs kill                stop the tracked llama-server (lock pid);
//                                       blocks until the process is gone
//   ~/inference.mjs last [--wait <sec>] [--no-wait]
//                                       relaunch the last non-kill profile
//                                       (blocks until /health is 200;
//                                       --no-wait returns after spawn,
//                                       --wait <sec> sets the timeout)
//   ~/inference.mjs comfy [args...]     launch ComfyUI (config: comfyui:),
//                                       backgrounded, log in <script_dir>/comfy.log;
//                                       passthrough args are appended and a
//                                       passthrough --listen/--port overrides
//                                       the defaults; blocks until /system_stats is 200
//   ~/inference.mjs comfy-kill          stop the tracked ComfyUI (comfy.lock);
//                                       blocks until the process is gone
//
// GPU hand-off pair (one tool call, so the shell outlives the LLM kill):
//   ~/inference.mjs kill && ~/inference.mjs comfy && <assetgen job> \
//     && ~/inference.mjs comfy-kill && ~/inference.mjs last
//
// Reads ~/.config/inference/config.yaml. For each launch it:
//   1. stops any running llama-server (frees 127.0.0.1:1234),
//   2. writes a launcher script to <script_dir>/<profile>.sh,
//   3. syncs consumers: AGL default_model (= llama-server:default, stable)
//      + llama-server default window, and pi llama-server/default
//      contextWindow, all set to the profile's context_window,
//   4. opens the launcher in a new Ghostty window (logs stay visible, window
//      kept open after exit while wait_after_exit is true) or in a zellij
//      tiled pane in the target session (pane kept open after exit).
//      llama-server itself is owned by a detached monitor process (not this
//      script): it restarts on crash (e.g. CUDA abort) but not on
//      SIGTERM/SIGINT/SIGHUP/SIGKILL or a clean exit. inference.mjs waits
//      for /health then returns; the monitor keeps running.

import { processSlot } from "./process-slots.mjs";
import { launchGroupedView } from "./zellij-panes.mjs";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync, unlinkSync, openSync, closeSync } from "node:fs";
import { join, dirname } from "node:path";

const HOME = process.env.HOME ?? "";
const CONFIG_PATH = join(HOME, ".config/inference/config.yaml");

const expand = (p) =>
  typeof p === "string" && p.startsWith("~/") ? join(HOME, p.slice(2)) : p;

// POSIX sh single-quote: 'foo' , embedded ' becomes '"'"'
const shQuote = (s) => `'${String(s).replaceAll("'", "'\"'\"'")}'`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function loadConfig() {
  if (!existsSync(CONFIG_PATH)) {
    console.error(`error: config not found: ${CONFIG_PATH}`);
    process.exit(1);
  }
  const cfg = Bun.YAML.parse(readFileSync(CONFIG_PATH, "utf8"));
  if (!cfg || typeof cfg !== "object" || !cfg.models || typeof cfg.models !== "object") {
    console.error(`error: ${CONFIG_PATH} must define a top-level 'models' mapping`);
    process.exit(1);
  }
  return cfg;
}

function listProfiles(cfg) {
  console.log("available profiles:");
  for (const [name, m] of Object.entries(cfg.models)) {
    const slot = slotFor(m);
    const port = healthPortFor(m);
    const ctx = contextWindowFor(m);
    // Every profile serves model id `default` on :1234; second line is the
    // real binary. Profile identity lives in lock.profile / last_profile.
    const src = m?.server_bin
      ? `${m.server_process ?? m.server_bin} ${m?.artifact ?? "(no artifact!)"}`
      : (m?.model ?? "(no model!)");
    console.log(`  ${name} [${slot} :${port}]\n    -> llama-server:default${ctx != null ? ` (context ${ctx})` : ""}\n    -> ${src}`);
  }
}

// Independent slots: llm :1234, systemone :1237, ocr :1239.
// Launching one slot never stops the others; kill-all stops all four.
function slotFor(m) {
  return ["systemone", "ocr", "vision"].includes(m?.slot) ? m.slot : "llm";
}

function slotPort(slot) {
  return slot === "vision" ? 1246 : slot === "ocr" ? 1239 : slot === "systemone" ? 1237 : 1234;
}

function pidsOfServer(slot) {
  // Generic llama-server processes can belong to either :1234 or :1237.
  // Classify by actual argv so stopping text does not kill a resident H2O model.
  const candidates=new Set();
  for(const args of [
    ["-x","(llama-server|ninfer-serve|strata-serve|h2o-serve|vllm|laya-serve|paddle-ocr)"],
    ["-f","h2o_lightning_shim"],
  ]) {
    const r=spawnSync("pgrep",args,{encoding:"utf8"});
    if(r.status===0)for(const p of r.stdout.trim().split(/\s+/))candidates.add(Number(p));
  }
  return [...candidates].filter(pid=>{
    if(!Number.isFinite(pid)||pid===process.pid)return false;
    try {
      const comm=readFileSync(`/proc/${pid}/comm`,"utf8").trim();
      const argv=readFileSync(`/proc/${pid}/cmdline`,"utf8").split("\0").filter(Boolean);
      const actual=processSlot(comm,argv);
      return actual!==null&&(!slot||actual===slot);
    } catch { return false; } // exited during inspection
  });
}

// --- lock + state -----------------------------------------------------------
// Lock: <script_dir>/server.lock
//   JSON: { pid, monitorPid, profile, alias, startedAt }
//   pid        = llama-server (updated by the monitor on every spawn)
//   monitorPid = detached crash-restart wrapper (process-group leader)
// State: `last_profile` key persisted back into config.yaml (top-level).

function lockPath(cfg, slot) {
  const base = slot === "vision" ? "vision.lock" : slot === "ocr" ? "ocr.lock" : slot === "systemone" ? "systemone.lock" : "server.lock";
  return join(expand(cfg.script_dir ?? "~/.cache/inference"), base);
}

function logPath(cfg, slot) {
  const base = slot === "vision" ? "vision.log" : slot === "ocr" ? "ocr.log" : slot === "systemone" ? "systemone.log" : "llama.log";
  return join(expand(cfg.script_dir ?? "~/.cache/inference"), base);
}

function occupancyAlive(lock) {
  return pidAlive(lock?.pid) || pidAlive(lock?.monitorPid);
}

function readLock(cfg, slot) {
  try {
    const p = lockPath(cfg, slot);
    if (!existsSync(p)) return null;
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

function writeLock(cfg, slot, entry) {
  mkdirSync(expand(cfg.script_dir ?? "~/.cache/inference"), { recursive: true });
  writeFileSync(lockPath(cfg, slot), JSON.stringify(entry, null, 2) + "\n");
}

function clearLock(cfg, slot) {
  try { unlinkSync(lockPath(cfg, slot)); } catch { /* already gone */ }
}

function pidAlive(pid) {
  if (!pid || !Number.isFinite(Number(pid))) return false;
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch {
    return false;
  }
}

function fmtElapsed(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h) return `${h}h ${m}m ${sec}s`;
  if (m) return `${m}m ${sec}s`;
  return `${sec}s`;
}

function fmtTime(ts) {
  try {
    return new Date(ts).toLocaleString();
  } catch {
    return String(ts);
  }
}

function saveLastProfile(name, slot) {
  // Persist `last_profile` (llm slot) or `last_systemone` (systemone slot) as
  // program state in config.yaml (top-level keys, siblings of `models:`).
  // Minimal edit: replace or append one line.
  const key = slot === "vision" ? "last_vision" : slot === "ocr" ? "last_ocr" : slot === "systemone" ? "last_systemone" : "last_profile";
  try {
    const text = readFileSync(CONFIG_PATH, "utf8");
    const line = `${key}: ${name}`;
    const re = new RegExp(`^${key}:.*$`, "m");
    const next = re.test(text)
      ? text.replace(re, line)
      : text.replace(/\n?$/, "\n") + line + "\n";
    writeFileSync(CONFIG_PATH, next);
  } catch (err) {
    console.warn(`warning: could not persist ${key}: ${err.message}`);
  }
}

async function killServer(cfg, slot) {
  // Prefer the lockfile; fall back to pgrep. Remove stale locks.
  // Blocks until the process is actually gone (the driver reclaims its
  // VRAM on exit), so callers can start the next GPU workload right after.
  // No slot = both slots (free the whole GPU); a slot kills only its own.
  if (!slot) {
    await stopLlama(cfg, { verbose: true, slot: "llm" });
    await stopLlama(cfg, { verbose: true, slot: "systemone" });
    await stopLlama(cfg, { verbose: true, slot: "ocr" });
    await stopLlama(cfg, { verbose: true, slot: "vision" });
    return;
  }
  await stopLlama(cfg, { verbose: true, slot });
}

// Stop the detached monitor (process group) and any llama-server pids.
// Signaling the group reaps the wrapper even if it is in the 2s crash-restart
// delay, when lock.pid is already dead and pgrep would see nothing.
async function stopLlama(cfg, { verbose = false, slot = "llm" } = {}) {
  const lock = readLock(cfg, slot);
  const label = cfg.models?.[lock?.profile]?.server_process ?? (slot === "ocr" ? "paddle-ocr" : slot === "systemone" ? "h2o-serve" : "llama-server");
  const monitorPid = pidAlive(lock?.monitorPid) ? Number(lock.monitorPid) : null;
  const serverPids = pidsOfServer(slot);
  if (pidAlive(lock?.pid) && !serverPids.includes(Number(lock.pid))) {
    serverPids.push(Number(lock.pid));
  }

  if (!monitorPid && !serverPids.length) {
    if (lock) {
      if (verbose) console.log(`stale lock (pid ${lock.pid} not running) — clearing`);
      clearLock(cfg, slot);
    }
    if (verbose) console.log(`no ${label} running.`);
    return;
  }

  if (verbose) {
    if (lock?.profile) {
      const elapsed = fmtElapsed(Date.now() - (lock.startedAt ?? Date.now()));
      console.log(`killing profile '${lock.profile}' (alias ${lock.alias ?? "?"}), pid ${lock.pid ?? "?"}, monitor ${monitorPid ?? "?"}, launched ${fmtTime(lock.startedAt)} (${elapsed} ago)`);
    } else {
      console.log(`killing ${label}: ${serverPids.join(" ") || "(none)"} monitor ${monitorPid ?? "(none)"} (no lock match — pkill fallback)`);
    }
  } else {
    const listed = [...serverPids, ...(monitorPid ? [monitorPid] : [])];
    console.log(`stopping existing ${label}: ${listed.join(" ")}`);
  }

  // Process-group TERM reaps the wrapper even during the 2s restart delay.
  // Individual TERM covers the case where the monitor is not the group leader.
  if (monitorPid) spawnSync("kill", ["--", `-${monitorPid}`]);
  const extra = [...serverPids, ...(monitorPid ? [monitorPid] : [])];
  if (extra.length) spawnSync("kill", extra.map(String));

  const tracked = [...new Set([...(monitorPid ? [monitorPid] : []), ...serverPids])];
  let deadline = Date.now() + 10_000;
  while (Date.now() < deadline && (tracked.some(pidAlive) || pidsOfServer(slot).length)) await sleep(200);

  const still = [...new Set([...tracked.filter(pidAlive), ...pidsOfServer(slot)])];
  if (still.length) {
    console.log(`still alive after 10s, SIGKILL: ${still.join(" ")}`);
    if (monitorPid && pidAlive(monitorPid)) spawnSync("kill", ["-9", "--", `-${monitorPid}`]);
    const leftoverPids = [...new Set([...tracked.filter(pidAlive), ...pidsOfServer(slot)])];
    if (leftoverPids.length) spawnSync("kill", ["-9", ...leftoverPids.map(String)]);
    deadline = Date.now() + 10_000;
    while (Date.now() < deadline && (tracked.some(pidAlive) || pidsOfServer(slot).length)) await sleep(200);
    const leftover = [...new Set([...tracked.filter(pidAlive), ...pidsOfServer(slot)])];
    if (leftover.length) {
      console.error(`error: ${label} still alive after SIGKILL: ${leftover.join(" ")}`);
      process.exit(1);
    }
  }
  clearLock(cfg, slot);
  if (verbose) console.log(`${label} stopped (lock cleared, GPU freed).`);
}

// --- GPU memory ---------------------------------------------------------------
// nvidia-smi is used for the pre-launch check in `comfy`: warn when the GPU
// is nearly full (the text LLM may still be loaded) instead of OOMing blind.

function vramStats() {
  try {
    const r = spawnSync(
      "nvidia-smi",
      ["--query-gpu=memory.used,memory.total", "--format=csv,noheader,nounits"],
      { encoding: "utf8" },
    );
    if (r.status !== 0) return null;
    const m = r.stdout.trim().split("\n")[0]?.match(/(\d+)\s*,\s*(\d+)/);
    return m ? { used: Number(m[1]), total: Number(m[2]) } : null;
  } catch {
    return null;
  }
}

// --- ComfyUI (assetgen / diffusion workloads) ----------------------------------
// `comfy` / `comfy-kill` are the GPU hand-off pair to `kill` / `last`.
// ComfyUI runs in the background (no GUI window), logs to
// <script_dir>/comfy.log, and is tracked in <script_dir>/comfy.lock.
// Both commands block until they are truly done (health / death).

const COMFY_DEFAULTS = {
  dir: "/workspace/tmp/ComfyUI",
  python: ".venv/bin/python",
  args: ["main.py", "--listen", "127.0.0.1", "--port", "8188"],
};

function comfyConfig(cfg) {
  const c = cfg.comfyui ?? {};
  return {
    dir: c.dir ?? COMFY_DEFAULTS.dir,
    python: c.python ?? COMFY_DEFAULTS.python,
    args: c.args ? [...c.args] : [...COMFY_DEFAULTS.args],
  };
}

function comfyLockPath(cfg) {
  return join(expand(cfg.script_dir ?? "~/.cache/inference"), "comfy.lock");
}

function readComfyLock(cfg) {
  try {
    const p = comfyLockPath(cfg);
    if (!existsSync(p)) return null;
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

function writeComfyLock(cfg, entry) {
  const p = comfyLockPath(cfg);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(entry, null, 2) + "\n");
}

function clearComfyLock(cfg) {
  try {
    unlinkSync(comfyLockPath(cfg));
  } catch { /* already gone */ }
}

// Value of the last occurrence of `flag` in args (null if absent or valueless).
function flagValue(args, flag) {
  const i = args.lastIndexOf(flag);
  if (i >= 0 && i + 1 < args.length && !String(args[i + 1]).startsWith("--")) return String(args[i + 1]);
  return null;
}

// Defaults + passthrough; a passthrough --listen/--port drops the default pair.
function mergeComfyArgs(defaults, passthrough) {
  const overridden = new Set(["--listen", "--port"].filter((f) => flagValue(passthrough, f) != null));
  const out = [];
  for (let i = 0; i < defaults.length; i++) {
    if (overridden.has(String(defaults[i])) && i + 1 < defaults.length) {
      i++; // drop the default value too
      continue;
    }
    out.push(defaults[i]);
  }
  return [...out, ...passthrough];
}

async function comfyUp(port) {
  // NOTE: /system_stats, not /system — ComfyUI 0.30.0 has no /system route
  // (it 404s), so probing /system waits forever on a healthy server.
  try {
    const res = await fetch(`http://127.0.0.1:${port}/system_stats`, { signal: AbortSignal.timeout(1500) });
    return res.ok;
  } catch {
    return false;
  }
}

async function waitForComfy(port, { timeoutMs = 300_000, pollMs = 1000 } = {}) {
  const url = `http://127.0.0.1:${port}/system_stats`;
  console.log(`waiting for ${url} ...`);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return true;
    } catch {
      // connection refused while ComfyUI is still starting — keep polling
    }
    await sleep(pollMs);
  }
  console.error(`error: timed out after ${Math.round(timeoutMs / 1000)}s waiting for ${url}`);
  return false;
}

async function killComfy(cfg) {
  const lock = readComfyLock(cfg);
  let victims = [];
  if (lock?.pid && pidAlive(lock.pid)) {
    victims = [Number(lock.pid)];
  } else if (lock) {
    console.log(`stale comfyui lock (pid ${lock.pid} not running) — clearing`);
    clearComfyLock(cfg);
  }
  if (!victims.length) {
    console.log("no tracked comfyui running.");
    return;
  }
  const elapsed = fmtElapsed(Date.now() - (lock?.startedAt ?? Date.now()));
  console.log(`killing comfyui pid ${victims.join(" ")} (launched ${fmtTime(lock?.startedAt ?? Date.now())} (${elapsed} ago), log ${lock?.log ?? "?"})`);
  spawnSync("kill", victims.map(String));
  let deadline = Date.now() + 10_000;
  while (Date.now() < deadline && victims.some(pidAlive)) await sleep(200);
  let still = victims.filter(pidAlive);
  if (still.length) {
    console.log(`still alive after 10s, SIGKILL: ${still.join(" ")}`);
    spawnSync("kill", ["-9", ...still.map(String)]);
    deadline = Date.now() + 10_000;
    while (Date.now() < deadline && still.some(pidAlive)) await sleep(200);
    still = victims.filter(pidAlive);
    if (still.length) {
      console.error(`error: comfyui still alive after SIGKILL: ${still.join(" ")}`);
      process.exit(1);
    }
  }
  clearComfyLock(cfg);
  console.log("comfyui stopped (lock cleared, GPU freed).");
}

async function comfyCommand(cfg, cmd, rest, { dryRun, noWait, waitMs }) {
  if (cmd === "comfy-kill") {
    if (rest.length) {
      console.error(`error: unexpected extra argument: ${rest.join(" ")}`);
      process.exit(1);
    }
    await killComfy(cfg);
    return;
  }
  // cmd === "comfy": rest is passthrough CLI args for ComfyUI.
  const c = comfyConfig(cfg);
  if (!existsSync(c.dir)) {
    console.error(`error: comfyui dir not found: ${c.dir} (set comfyui.dir in ${CONFIG_PATH})`);
    process.exit(1);
  }
  const py = expand(c.python.startsWith("~") ? c.python : join(c.dir, c.python));
  if (!existsSync(py)) {
    console.error(`error: comfyui python not found: ${py} (set comfyui.python in ${CONFIG_PATH})`);
    process.exit(1);
  }
  const args = mergeComfyArgs(c.args, rest);
  const port = Number(flagValue(args, "--port")) || 8188;

  if (await comfyUp(port)) {
    const lock = readComfyLock(cfg);
    console.log(`comfyui already healthy on http://127.0.0.1:${port} (pid ${lock?.pid ?? "untracked"}) — nothing to do.`);
    return;
  }

  const lock = readComfyLock(cfg);
  if (lock?.pid && pidAlive(lock.pid)) {
    console.error(`error: comfyui already running (pid ${lock.pid}, log ${lock.log ?? "?"}). Stop it first with: ~/inference.mjs comfy-kill`);
    process.exit(1);
  }
  if (lock) clearComfyLock(cfg);

  const vram = vramStats();
  if (vram && vram.total > 0 && vram.used / vram.total > 0.75) {
    console.warn(
      `warning: GPU nearly full (${vram.used}/${vram.total} MiB) — the text LLM may still be loaded. Free it first with: ~/inference.mjs kill`,
    );
  }

  const argv = [py, ...args];
  if (dryRun) {
    console.log(`[dry-run] comfyui: ${argv.join(" ")}`);
    console.log(`[dry-run] health: http://127.0.0.1:${port}/system_stats`);
    return;
  }

  const logPath = join(expand(cfg.script_dir ?? "~/.cache/inference"), "comfy.log");
  mkdirSync(dirname(logPath), { recursive: true });
  const logFd = openSync(logPath, "w");
  console.log(`launch: ${argv.join(" ")}  (log: ${logPath})`);
  const child = spawn(py, args, { cwd: c.dir, detached: true, stdio: ["ignore", logFd, logFd] });
  child.on("error", (e) => console.error(`error: comfyui spawn failed: ${e.message}`));
  child.unref();
  closeSync(logFd);
  if (!child.pid) {
    clearComfyLock(cfg);
    console.error("error: comfyui spawn failed — see log above.");
    process.exit(1);
  }
  writeComfyLock(cfg, { pid: child.pid, startedAt: Date.now(), port, argv, log: logPath });
  console.log(`comfyui starting (pid ${child.pid})`);
  if (noWait) {
    console.log(`comfyui spawned (pid ${child.pid}) — not waiting (--no-wait).`);
    return;
  }
  const ok = await waitForComfy(port, { timeoutMs: waitMs, pollMs: 1000 });
  if (!ok) {
    console.error(`error: comfyui not healthy — check ${logPath}`);
    process.exit(1);
  }
  console.log(`comfyui healthy on http://127.0.0.1:${port} (pid ${child.pid}, log ${logPath})`);
}

// Health: poll GET <healthUrl> until 2xx or timeout. Used by `last`
// (and fresh profile launches) so callers — e.g. a pi tool call that just
// killed the server to free the GPU — block until the text LLM is back
// instead of racing the model load.
async function waitForHealth(cfg, m, { timeoutMs = 300_000, pollMs = 2_000 } = {}) {
  const port = healthPortFor(m);
  const url = `http://127.0.0.1:${port}/health`;
  console.log(`waiting for ${url} ...`);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) {
        console.log(`healthy: ${url}`);
        return true;
      }
    } catch {
      // connection refused while the server is still starting — keep polling
    }
    await sleep(pollMs);
  }
  console.error(`error: timed out after ${Math.round(timeoutMs / 1000)}s waiting for ${url}`);
  process.exit(1);
}

function healthPortFor(m) {
  // Find the --port value in the profile's args, defaulting to 1234.
  const args = m?.args ?? [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (Array.isArray(a)) {
      for (let j = 0; j < a.length - 1; j++) {
        if (a[j] === "--port") return Number(a[j + 1]) || 1234;
      }
    } else if (a === "--port") {
      const next = args[i + 1];
      const v = Array.isArray(next) ? next[0] : next;
      return Number(v) || 1234;
    }
  }
  return 1234;
}

async function stopExistingServer(cfg, slot = "llm") {
  await stopLlama(cfg, { verbose: false, slot });
}

function buildServerArgv(name, m) {
  if (!m || typeof m !== "object") {
    console.error(`error: profile '${name}' must be a mapping`);
    process.exit(1);
  }
  // Every profile serves model id `default` (the pi harness sends "default"
  // literally and ninfer validates the id). Identity lives in the profile
  // name (lock.profile / last_profile), not the served id.
  const serverAlias = "default";
  const procName = m.server_process ?? "llama-server";
  // args accepts bare "flag" items and [flag, value] pairs (one pair per line)
  const pushArgs = (argv) => {
    for (const a of m.args ?? []) {
      if (Array.isArray(a)) for (const x of a) argv.push(String(x));
      else argv.push(String(a));
    }
  };
  if (m.server_bin && m.artifact) {
    // Non-llama backend (e.g. ninfer-serve): argv is
    // <bin> <artifact> --model-id default + args.
    const argv = [expand(m.server_bin), expand(m.artifact), "--model-id", String(serverAlias)];
    pushArgs(argv);
    return { serverAlias, argv, procName, extraFiles: [argv[0], argv[1]] };
  }
  if (!m.model) {
    console.error(`error: profile '${name}' must define 'model' (or server_bin + artifact)`);
    process.exit(1);
  }
  // stock llama-server, or a compatible fork via server_bin (e.g. PrismML
  // ternary kernels): <bin> --alias default -m <model> [--mmproj] [-md] + args.
  const argv = [m.server_bin ? expand(m.server_bin) : "llama-server", "--alias", String(serverAlias), "-m", expand(m.model)];
  if (m.mmproj) argv.push("--mmproj", expand(m.mmproj));
  if (m.draft) argv.push("-md", expand(m.draft));
  pushArgs(argv);
  return { serverAlias, argv, procName, extraFiles: m.server_bin ? [argv[0]] : [] };
}

function checkFilesExist(argv) {
  // argv flags whose values are file paths that must exist
  const fileFlags = new Set(["-m", "--mmproj", "-md"]);
  for (let i = 0; i < argv.length - 1; i++) {
    if (fileFlags.has(argv[i]) && !existsSync(argv[i + 1])) {
      console.error(`error: file not found for ${argv[i]}: ${argv[i + 1]}`);
      process.exit(1);
    }
  }
}

// Usable context length for a profile: explicit `context_window:` first,
// else derived from the `-c` (llama) / `--max-context` (ninfer) flag.
function contextWindowFor(m) {
  const explicit = Number(m?.context_window);
  if (Number.isFinite(explicit) && explicit > 0) return Math.floor(explicit);
  const flat = [];
  for (const a of m?.args ?? []) {
    if (Array.isArray(a)) for (const x of a) flat.push(String(x));
    else flat.push(String(a));
  }
  for (let i = 0; i < flat.length - 1; i++) {
    if (flat[i] === "-c" || flat[i] === "--max-context") {
      const n = Number(flat[i + 1]);
      if (Number.isFinite(n) && n > 0) return Math.floor(n);
    }
  }
  return null;
}

// Replace the `default:` value inside the `llama-server:` section of the AGL
// config text (comment-preserving; no YAML round-trip). Returns null when
// the section/key is missing.
function setAglLlamaDefaultWindow(text, ctx) {
  const lines = String(text).split("\n");
  const provIdx = lines.findIndex((l) => /^  llama-server:\s*$/.test(l));
  if (provIdx < 0) return null;
  for (let i = provIdx + 1; i < lines.length; i++) {
    if (/^  \S/.test(lines[i])) break; // next provider section
    if (/^    default:\s*\S/.test(lines[i])) {
      lines[i] = `    default: ${ctx}`;
      return lines.join("\n");
    }
  }
  return null;
}

// Sync consumers of the :1234 slot after a profile launch:
//   AGL — default_model is stable (llama-server:default); the
//           context_windows llama-server default tracks the profile.
//   pi  — llama-server/default contextWindow tracks the profile.
function updateConsumerConfigs(cfg, name, m, dryRun) {
  // The :1234 slot feeds the text-LLM consumers. A systemone profile serves a
  // different port and a different API — syncing its context window into the
  // text slots would point agents at a model that cannot chat.
  if (slotFor(m) !== "llm") {
    console.log(`profile '${name}' is a ${slotFor(m)} (:${slotPort(slotFor(m))}) profile — leaving text-LLM consumers unchanged`);
    return;
  }
  const ctx = contextWindowFor(m);
  if (cfg.agl_config) {
    const aglPath = expand(cfg.agl_config);
    if (!existsSync(aglPath)) {
      console.warn(`warning: agl config not found (${aglPath}), skipping agl update`);
    } else {
      const next = `default_model: llama-server:default`;
      let text = readFileSync(aglPath, "utf8");
      text = /^default_model:/m.test(text)
        ? text.replace(/^default_model:.*$/m, next)
        : text.replace(/\n?$/, "\n") + next + "\n";
      if (ctx != null) {
        const withWindow = setAglLlamaDefaultWindow(text, ctx);
        if (withWindow == null) {
          console.warn(`warning: llama-server section/default not found in ${aglPath}, leaving context window unchanged`);
        } else {
          text = withWindow;
        }
      }
      if (!dryRun) writeFileSync(aglPath, text);
      console.log(`agl default_model ${dryRun ? "would become" : "set to"}: llama-server:default${ctx != null ? ` (context window ${ctx})` : ""}`);
    }
  }
  if (cfg.pi_models) {
    const piPath = expand(cfg.pi_models);
    if (!existsSync(piPath)) {
      console.warn(`warning: pi models not found (${piPath}), skipping pi update`);
    } else if (ctx == null) {
      console.warn(`warning: no context window for profile '${name}', leaving pi models unchanged`);
    } else {
      const pi = JSON.parse(readFileSync(piPath, "utf8"));
      const entries = pi?.providers?.["llama-server"]?.models;
      const row = Array.isArray(entries) ? entries.find((e) => e?.id === "default") : null;
      if (!row) {
        console.warn(`warning: llama-server/default not found in ${piPath}, leaving pi models unchanged`);
      } else {
        row.contextWindow = ctx;
        // Explicit per-preset modality override; infer legacy vision presets too.
        const args = (m.args ?? []).flat();
        row.input = m.input_modalities ?? ((m.mmproj || args.includes("--vision")) ? ["text", "image"] : ["text"]);
        if (!dryRun) writeFileSync(piPath, JSON.stringify(pi, null, 2) + "\n");
        console.log(`pi llama-server/default contextWindow ${dryRun ? "would become" : "set to"}: ${ctx}`);
      }
    }
  }
}

async function main() {
  const rawArgs = process.argv.slice(2);
  const dryRun = rawArgs.includes("--dry-run");
  const noWait = rawArgs.includes("--no-wait");
  // --wait <seconds> overrides the health-wait timeout (default 300s).
  let waitMs = 300_000;
  // --launcher <ghostty|zellij> overrides the config file's `launcher` setting
  let launcherOverride;
  const scrubbed = [];
  for (let i = 0; i < rawArgs.length; i++) {
    if (rawArgs[i] === "--launcher") {
      launcherOverride = rawArgs[i + 1];
      i++;
    } else if (rawArgs[i] === "--wait") {
      const secs = Number(rawArgs[i + 1]);
      if (!Number.isFinite(secs) || secs <= 0) {
        console.error("error: --wait needs a positive number of seconds");
        process.exit(1);
      }
      waitMs = secs * 1000;
      i++;
    } else {
      scrubbed.push(rawArgs[i]);
    }
  }
  if (rawArgs.includes("--launcher") && launcherOverride === undefined) {
    console.error("error: --launcher needs a value (ghostty|zellij)");
    process.exit(1);
  }
  if (rawArgs.includes("--wait") && noWait) {
    console.error("error: --wait and --no-wait are mutually exclusive");
    process.exit(1);
  }
  const positional = scrubbed.filter((a) => a !== "--dry-run" && a !== "--no-wait");
  const cfg = loadConfig();
  const launcher = resolveLauncher(cfg, launcherOverride);
  const launchOpts = { launcher, dryRun, noWait, waitMs };

  const [cmd, ...rest] = positional;
  if (!cmd || cmd === "help" || cmd === "-h" || cmd === "--help") {
    console.log("usage: ~/inference.mjs <profile> [--dry-run] [--launcher ghostty|zellij] [--wait <sec>] [--no-wait] | ~/inference.mjs list|kill|kill-son|kill-ocr|kill-vision|kill-all|last|son-last|ocr-last [--wait <sec>] [--no-wait] | ~/inference.mjs comfy [--no-wait] [ComfyUI args...] | ~/inference.mjs comfy-kill");
    listProfiles(cfg);
    process.exit(cmd ? 0 : 1);
  }
  if (cmd === "list") {
    listProfiles(cfg);
    return;
  }
  if (cmd === "kill" || cmd === "kill-son" || cmd === "kill-ocr" || cmd === "kill-vision" || cmd === "kill-all") {
    if (rest.length) {
      console.error(`error: unexpected extra argument: ${rest.join(" ")}`);
      process.exit(1);
    }
    // `kill` keeps its historical meaning (the :1234 text slot). `kill-son`
    // stops the :1237 System One slot, `kill-all` frees the whole GPU.
    if (cmd === "kill") await killServer(cfg, "llm");
    else if (cmd === "kill-son") await killServer(cfg, "systemone");
    else if (cmd === "kill-ocr") await killServer(cfg, "ocr");
    else if (cmd === "kill-vision") await killServer(cfg, "vision");
    else await killServer(cfg);
    return;
  }
  if (cmd === "comfy" || cmd === "comfy-kill") {
    await comfyCommand(cfg, cmd, rest, { dryRun, noWait, waitMs });
    return;
  }
  if (cmd === "last" || cmd === "son-last" || cmd === "ocr-last") {
    if (rest.length) {
      console.error(`error: unexpected extra argument: ${rest.join(" ")}`);
      process.exit(1);
    }
    const key = cmd === "ocr-last" ? "last_ocr" : cmd === "son-last" ? "last_systemone" : "last_profile";
    const last = cfg[key];
    if (!last || !cfg.models[last]) {
      console.error(`error: no ${key} recorded yet (launch a ${cmd === "son-last" ? "systemone" : "<profile>"} first).`);
      listProfiles(cfg);
      process.exit(1);
    }
    console.log(`relaunching last profile: ${last}`);
    await launchProfile(cfg, last, launchOpts);
    return;
  }
  if (rest.length) {
    console.error(`error: unexpected extra argument: ${rest.join(" ")}`);
    process.exit(1);
  }
  if (!cfg.models[cmd]) {
    console.error(`error: unknown profile '${cmd}'`);
    listProfiles(cfg);
    process.exit(1);
  }

  // Refuse to double-launch within the profile's own slot: a live lock means a
  // server is already up *there*. The other slot is untouched, so text (:1234)
  // and systemone (:1237) coexist.
  const slot = slotFor(cfg.models[cmd]);
  const existing = readLock(cfg, slot);
  const livePids = pidsOfServer(slot);
  const stopHint = slot === "vision" ? "~/inference.mjs kill-vision" : slot === "ocr" ? "~/inference.mjs kill-ocr" : slot === "systemone" ? "~/inference.mjs kill-son" : "~/inference.mjs kill";
  if (existing && occupancyAlive(existing)) {
    const elapsed = fmtElapsed(Date.now() - (existing.startedAt ?? Date.now()));
    console.error(
      `refusing to launch '${cmd}': profile '${existing.profile ?? "?"}' (alias ${existing.alias ?? "?"}) ` +
      `already running as pid ${existing.pid ?? "?"}, monitor ${existing.monitorPid ?? "?"}, launched ${fmtTime(existing.startedAt)} (${elapsed} ago).\n` +
      `stop it first with: ${stopHint}`,
    );
    process.exit(1);
  }
  if (existing && !occupancyAlive(existing)) {
    console.log(`clearing stale lock for pid ${existing.pid}`);
    clearLock(cfg, slot);
  } else if (!existing && livePids.length && !dryRun) {
    // Untracked server (lock deleted or launched by hand) — keep old
    // stop-and-replace behavior instead of refusing.
    console.log(`untracked server running (${livePids.join(" ")}) — stopping before launch`);
  }

  await launchProfile(cfg, cmd, launchOpts);
}

function buildMonitorScript(name, serverAlias, argv, lockFile, procName = "llama-server") {
  // Restart on unexpected death (CUDA abort is 134). Do not restart when the
  // operator (or `inference.mjs kill`) signaled the process: 0 clean exit,
  // 129 SIGHUP, 130 SIGINT, 137 SIGKILL (killServer stage 2), 143 SIGTERM.
  const cmd = argv.map(shQuote).join(" ");
  const lock = shQuote(lockFile);
  return `#!/bin/sh
# Generated by ~/inference.mjs for profile '${name}' — do not edit.
# Re-generated on every launch. Detached crash-restart monitor.

write_lock() {
  printf '{"pid":%s,"monitorPid":%s,"profile":"%s","alias":"%s","startedAt":%s000}\\n' "$1" "$$" ${shQuote(name)} ${shQuote(serverAlias)} "$(date +%s)" > ${lock}
}

pid=
on_stop() {
  if [ -n "$pid" ]; then
    kill -s TERM "$pid" 2>/dev/null
    wait "$pid" 2>/dev/null
  fi
  exit 0
}
trap on_stop INT TERM HUP

while :; do
  ${cmd} &
  pid=$!
  write_lock "$pid"
  wait "$pid"
  status=$?
  pid=
  printf '\\n${procName} (profile ${name}) exited with status %s\\n' "$status"
  case $status in
    0|129|130|137|143) printf 'not restarting (clean or signaled stop)\\n'; break ;;
  esac
  printf 'crash — restarting\\n'
  sleep 2
done
`;
}

function buildViewScript(name, llamaLog) {
  return `#!/bin/sh
# Generated by ~/inference.mjs for profile '${name}' — do not edit.
exec tail -n +1 -F ${shQuote(llamaLog)}
`;
}

function launchMonitor(scriptPath, llamaLog) {
  const logFd = openSync(llamaLog, "a");
  const child = spawn(scriptPath, [], { detached: true, stdio: ["ignore", logFd, logFd] });
  child.on("error", (e) => console.error(`error: monitor spawn failed: ${e.message}`));
  child.unref();
  closeSync(logFd);
  return child.pid;
}

async function launchProfile(cfg, name, { launcher, dryRun, noWait, waitMs }) {
  const opts = { noWait, waitMs };
  const slot = slotFor(cfg.models[name]);
  const { serverAlias, argv, procName, extraFiles } = buildServerArgv(name, cfg.models[name]);
  checkFilesExist(argv);
  for (const f of extraFiles ?? []) {
    if (!existsSync(f)) {
      console.error(`error: file not found: ${f}`);
      process.exit(1);
    }
  }

  const scriptDir = expand(cfg.script_dir ?? "~/.cache/inference");
  const scriptPath = join(scriptDir, `${name}.sh`);
  const viewPath = join(scriptDir, `${name}.view.sh`);
  const llamaLog = logPath(cfg, slot);
  const scriptBody = buildMonitorScript(name, serverAlias, argv, lockPath(cfg, slot), procName);
  const viewBody = buildViewScript(name, llamaLog);

  if (dryRun) {
    console.log(`[dry-run] profile:      ${name}`);
    console.log(`[dry-run] launcher:     ${launcher}`);
    console.log(`[dry-run] server model id: default (profile: ${name})`);
    console.log(`[dry-run] monitor:      ${scriptPath} (detached)`);
    console.log(`[dry-run] log:          ${llamaLog}`);
    console.log(`[dry-run] view:         ${viewPath}`);
    console.log(`[dry-run] --- monitor script ---`);
    console.log(scriptBody.trimEnd());
    console.log(`[dry-run] --- view script ---`);
    console.log(viewBody.trimEnd());
    if (launcher === "zellij") {
      console.log(`[dry-run] --- zellij invocation ---`);
      console.log(`[dry-run] reuse/create ${slot} pane in the current tab; replace only this group’s log pane`);
    } else {
      const ghosttyBin = cfg.ghostty ?? "ghostty";
      console.log(`[dry-run] --- ghostty invocation ---`);
      console.log(`[dry-run] ${ghosttyBin} ${buildGhosttyArgv(cfg, viewPath).map(shQuote).join(" ")}`);
    }
    updateConsumerConfigs(cfg, name, cfg.models[name], true);
    return;
  }

  await stopExistingServer(cfg, slot);

  mkdirSync(scriptDir, { recursive: true });
  writeFileSync(scriptPath, scriptBody);
  chmodSync(scriptPath, 0o755);
  writeFileSync(viewPath, viewBody);
  chmodSync(viewPath, 0o755);
  writeFileSync(llamaLog, "");
  console.log(`wrote monitor: ${scriptPath}`);
  console.log(`wrote view:    ${viewPath}`);

  updateConsumerConfigs(cfg, name, cfg.models[name], false);

  if (launcher === "zellij") launchGroupedView(cfg, slot, name, viewPath);
  else launchGhostty(cfg, viewPath, name);

  const monitorPid = launchMonitor(scriptPath, llamaLog);
  if (!monitorPid) {
    console.error("error: monitor spawn failed — see log above.");
    process.exit(1);
  }
  writeLock(cfg, slot, { monitorPid, profile: name, alias: serverAlias, startedAt: Date.now() });
  console.log(`monitor pid ${monitorPid} (detached); log ${llamaLog}`);

  // Record llama-server pid for `kill` / `last`. The monitor writes the lock
  // again once it has the child pid; we also fill it in from pgrep.
  let serverPid = null;
  for (let i = 0; i < 50; i++) {
    await sleep(200);
    const pids = pidsOfServer(slot);
    if (pids.length) {
      serverPid = Math.max(...pids);
      break;
    }
  }
  if (serverPid) {
    const latest = readLock(cfg, slot) ?? {};
    writeLock(cfg, slot, { ...latest, pid: serverPid, monitorPid, profile: name, alias: serverAlias, startedAt: latest.startedAt ?? Date.now() });
    console.log(`tracking pid ${serverPid} in ${lockPath(cfg, slot)}`);
  } else {
    console.warn(`warning: no ${procName} pid found after 10s — kill will use monitor pid / pgrep.`);
  }
  saveLastProfile(name, slot);

  // Block until the server is actually serving again, so a caller that just
  // freed the GPU (e.g. `kill; sleep 8; last` from a pi tool call) doesn't
  // return while the model is still loading. Honors --no-wait. This process
  // then exits; the monitor keeps running on its own.
  if (!opts.noWait) {
    await waitForHealth(cfg, cfg.models[name], { timeoutMs: opts.waitMs, pollMs: 2_000 });
  }
}

function resolveLauncher(cfg, override) {
  const want = override ?? cfg.launcher ?? "auto";
  if (!["ghostty", "zellij", "auto"].includes(want)) {
    console.error(`error: unknown launcher '${want}' (want ghostty|zellij|auto)`);
    process.exit(1);
  }
  if (want === "auto") return process.env.ZELLIJ_SESSION_NAME ? "zellij" : "ghostty";
  return want;
}

function buildGhosttyArgv(cfg, scriptPath) {
  const argv = [];
  if (cfg.wait_after_exit !== false) argv.push("--wait-after-command=true");
  argv.push("-e", scriptPath);
  return argv;
}

function launchGhostty(cfg, scriptPath, serverAlias) {
  if (!process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
    console.error("error: no DISPLAY or WAYLAND_DISPLAY — ghostty needs a graphical session");
    process.exit(1);
  }
  const ghosttyBin = cfg.ghostty ?? "ghostty";
  if (typeof Bun.which === "function" && !Bun.which(ghosttyBin)) {
    console.error(`error: ghostty binary not found on PATH: ${ghosttyBin}`);
    process.exit(1);
  }
  const ghosttyArgv = buildGhosttyArgv(cfg, scriptPath);
  console.log(`launch: ${ghosttyBin} ${ghosttyArgv.map(shQuote).join(" ")}`);
  const child = spawn(ghosttyBin, ghosttyArgv, { detached: true, stdio: "ignore" });
  child.unref();
  console.log(`logs for 'llama-server:${serverAlias}' in a new Ghostty window (tail -F).`);
}


await main();
