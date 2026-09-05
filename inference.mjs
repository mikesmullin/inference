#!/usr/bin/env bun
// inference.mjs — launch a llama-server profile via the configured launcher
// backend (a Ghostty window, or a floating pane in the current zellij session).
//
// Usage:
//   ~/inference.mjs <profile> [--dry-run] [--launcher ghostty|zellij]
//                                       start (or restart) the server
//   ~/inference.mjs list                show available profiles
//   ~/inference.mjs kill                stop the tracked llama-server (lock pid)
//   ~/inference.mjs last [--wait <sec>] [--no-wait]
//                                       relaunch the last non-kill profile
//                                       (blocks until /health is 200;
//                                       --no-wait returns after spawn,
//                                       --wait <sec> sets the timeout)
//
// Reads ~/.config/inference/config.yaml. For each launch it:
//   1. stops any running llama-server (frees 127.0.0.1:1234),
//   2. writes a launcher script to <script_dir>/<profile>.sh,
//   3. points the AGL default_model at the new server,
//   4. opens the launcher in a new Ghostty window (logs stay visible, window
//      kept open after exit while wait_after_exit is true) or in a zellij
//      floating pane in the target session (pane kept open after exit).
//
// Later: a process monitor / health check can wrap step 4 (e.g. restart
// loop inside the launcher script, or a systemd user unit). For now the
// visible window is the monitor.

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync, unlinkSync } from "node:fs";
import { join } from "node:path";

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
    const alias = m?.server_alias ?? name;
    console.log(`  ${name}\n    -> llama-server:${alias}\n    -> ${m?.model ?? "(no model!)"}`);
  }
}

function pidsOfServer() {
  const r = spawnSync("pgrep", ["-x", "llama-server"], { encoding: "utf8" });
  if (r.status !== 0) return [];
  return r.stdout.split(/\s+/).filter(Boolean).map(Number).filter((pid) => pid !== process.pid);
}

// --- lock + state -----------------------------------------------------------
// Lock: <script_dir>/server.lock  (JSON: { pid, profile, alias, startedAt })
// State: `last_profile` key persisted back into config.yaml (top-level).

function lockPath(cfg) {
  return join(expand(cfg.script_dir ?? "~/.cache/inference"), "server.lock");
}

function readLock(cfg) {
  try {
    const p = lockPath(cfg);
    if (!existsSync(p)) return null;
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

function writeLock(cfg, entry) {
  mkdirSync(expand(cfg.script_dir ?? "~/.cache/inference"), { recursive: true });
  writeFileSync(lockPath(cfg), JSON.stringify(entry, null, 2) + "\n");
}

function clearLock(cfg) {
  try { unlinkSync(lockPath(cfg)); } catch { /* already gone */ }
}

// --- zellij pane reuse ------------------------------------------------------
// Find panes whose TITLE or COMMAND matches one of our launcher scripts
// (i.e. panes previously opened by inference.mjs), so a relaunch can close
// the stale one first instead of stacking a new floating pane each time.
function findInferencePanes(cfg, session) {
  try {
    const args = ["action", "list-panes", "-j"];
    if (session) args.unshift("--session", String(session));
    const r = spawnSync("zellij", args, { encoding: "utf8" });
    if (r.status !== 0 || !r.stdout) return [];
    const panes = JSON.parse(r.stdout);
    const scriptDir = expand(cfg.script_dir ?? "~/.cache/inference");
    const list = Array.isArray(panes) ? panes : panes?.panes ?? [];
    return list
      .filter((p) => {
        if (p?.is_plugin) return false;
        const hay = `${p?.title ?? ""}\n${p?.terminal_command ?? ""}\n${p?.command ?? ""}`;
        return hay.includes(scriptDir);
      })
      // close-pane -p accepts a bare integer or terminal_<n>
      .map((p) => p?.pane_id ?? (p?.id != null ? `terminal_${p.id}` : null))
      .filter(Boolean);
  } catch {
    return [];
  }
}

function closePanes(cfg, session, paneIds) {
  for (const id of paneIds) {
    const args = ["action", "close-pane", "-p", String(id)];
    if (session) args.unshift("--session", String(session));
    spawnSync("zellij", args, { encoding: "utf8" });
    console.log(`closed stale inference pane ${id}`);
  }
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

function saveLastProfile(name) {
  // Persist `last_profile` as program state in config.yaml (top-level key,
  // sibling of `models:`). Minimal edit: replace or append one line.
  try {
    const text = readFileSync(CONFIG_PATH, "utf8");
    const line = `last_profile: ${name}`;
    const next = /^last_profile:.*$/m.test(text)
      ? text.replace(/^last_profile:.*$/m, line)
      : text.replace(/\n?$/, "\n") + line + "\n";
    writeFileSync(CONFIG_PATH, next);
  } catch (err) {
    console.warn(`warning: could not persist last_profile: ${err.message}`);
  }
}

function killServer(cfg) {
  // Prefer the lockfile PID; fall back to pgrep. Remove stale locks.
  const lock = readLock(cfg);
  let victims = [];
  if (lock?.pid && pidAlive(lock.pid)) {
    victims = [Number(lock.pid)];
  } else {
    if (lock) {
      console.log(`stale lock (pid ${lock.pid} not running) — clearing`);
      clearLock(cfg);
    }
    victims = pidsOfServer();
  }
  if (!victims.length) {
    console.log("no llama-server running.");
    return;
  }
  if (lock?.pid && victims.includes(Number(lock.pid))) {
    const elapsed = fmtElapsed(Date.now() - (lock.startedAt ?? Date.now()));
    console.log(`killing profile '${lock.profile ?? "?"}' (alias ${lock.alias ?? "?"}), pid ${lock.pid}, launched ${fmtTime(lock.startedAt)} (${elapsed} ago)`);
  } else {
    console.log(`killing llama-server: ${victims.join(" ")} (no lock match — pkill fallback)`);
  }
  spawnSync("kill", victims.map(String));
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline && victims.some(pidAlive)) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
  }
  const still = victims.filter(pidAlive);
  if (still.length) {
    console.log(`still alive after 10s, SIGKILL: ${still.join(" ")}`);
    spawnSync("kill", ["-9", ...still.map(String)]);
  }
  clearLock(cfg);
  console.log("llama-server stopped (lock cleared, GPU freed).");
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

async function stopExistingServer() {
  let victims = pidsOfServer();
  if (!victims.length) return;
  console.log(`stopping existing llama-server: ${victims.join(" ")}`);
  spawnSync("kill", victims.map(String));
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline && pidsOfServer().length) await sleep(200);
  const still = pidsOfServer();
  if (still.length) {
    console.log(`still alive after 10s, SIGKILL: ${still.join(" ")}`);
    spawnSync("kill", ["-9", ...still.map(String)]);
  }
}

function buildServerArgv(name, m) {
  if (!m || typeof m !== "object" || !m.model) {
    console.error(`error: profile '${name}' must define at least 'model'`);
    process.exit(1);
  }
  const serverAlias = m.server_alias ?? name;
  const argv = ["llama-server", "--alias", String(serverAlias), "-m", expand(m.model)];
  if (m.mmproj) argv.push("--mmproj", expand(m.mmproj));
  if (m.draft) argv.push("-md", expand(m.draft));
  // args accepts bare "flag" items and [flag, value] pairs (one pair per line)
  for (const a of m.args ?? []) {
    if (Array.isArray(a)) for (const x of a) argv.push(String(x));
    else argv.push(String(a));
  }
  return { serverAlias, argv };
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

function updateAglDefault(aglConfig, serverAlias, dryRun) {
  if (!aglConfig) return;
  const aglPath = expand(aglConfig);
  if (!existsSync(aglPath)) {
    console.warn(`warning: agl config not found (${aglPath}), skipping default_model update`);
    return;
  }
  const next = `default_model: llama-server:${serverAlias}`;
  const text = readFileSync(aglPath, "utf8");
  const updated = /^default_model:/m.test(text)
    ? text.replace(/^default_model:.*$/m, next)
    : text.replace(/\n?$/, "\n") + next + "\n";
  if (!dryRun) writeFileSync(aglPath, updated);
  console.log(`agl default_model ${dryRun ? "would become" : "set to"}: llama-server:${serverAlias}`);
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
    console.log("usage: ~/inference.mjs <profile> [--dry-run] [--launcher ghostty|zellij] [--wait <sec>] [--no-wait] | ~/inference.mjs list|kill|last [--wait <sec>] [--no-wait]");
    listProfiles(cfg);
    process.exit(cmd ? 0 : 1);
  }
  if (cmd === "list") {
    listProfiles(cfg);
    return;
  }
  if (cmd === "kill") {
    if (rest.length) {
      console.error(`error: unexpected extra argument: ${rest.join(" ")}`);
      process.exit(1);
    }
    killServer(cfg);
    return;
  }
  if (cmd === "last") {
    if (rest.length) {
      console.error(`error: unexpected extra argument: ${rest.join(" ")}`);
      process.exit(1);
    }
    const last = cfg.last_profile;
    if (!last || !cfg.models[last]) {
      console.error("error: no last profile recorded yet (launch a <profile> first).");
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

  // Refuse to double-launch: a live lock means a server is already up.
  const existing = readLock(cfg);
  const livePids = pidsOfServer();
  if (existing && pidAlive(existing.pid)) {
    const elapsed = fmtElapsed(Date.now() - (existing.startedAt ?? Date.now()));
    console.error(
      `refusing to launch '${cmd}': profile '${existing.profile ?? "?"}' (alias ${existing.alias ?? "?"}) ` +
      `already running as pid ${existing.pid}, launched ${fmtTime(existing.startedAt)} (${elapsed} ago).\n` +
      `stop it first with: ~/inference.mjs kill`,
    );
    process.exit(1);
  }
  if (existing && !pidAlive(existing.pid)) {
    console.log(`clearing stale lock for pid ${existing.pid}`);
    clearLock(cfg);
  } else if (!existing && livePids.length && !dryRun) {
    // Untracked server (lock deleted or launched by hand) — keep old
    // stop-and-replace behavior instead of refusing.
    console.log(`untracked llama-server running (${livePids.join(" ")}) — stopping before launch`);
  }

  await launchProfile(cfg, cmd, launchOpts);
}

async function launchProfile(cfg, name, { launcher, dryRun, noWait, waitMs }) {
  const opts = { noWait, waitMs };
  const { serverAlias, argv } = buildServerArgv(name, cfg.models[name]);
  checkFilesExist(argv);

  const scriptDir = expand(cfg.script_dir ?? "~/.cache/inference");
  const scriptPath = join(scriptDir, `${name}.sh`);
  const scriptBody =
    `#!/bin/sh\n` +
    `# Generated by ~/inference.mjs for profile '${name}' — do not edit.\n` +
    `# Re-generated on every launch.\n` +
    `${argv.map(shQuote).join(" ")}\n` +
    `status=$?\n` +
    `printf '\\nllama-server (profile ${name}) exited with status %s\\n' "$status"\n`;

  if (dryRun) {
    console.log(`[dry-run] profile:      ${name}`);
    console.log(`[dry-run] launcher:     ${launcher}`);
    console.log(`[dry-run] server alias: ${serverAlias}`);
    console.log(`[dry-run] script:       ${scriptPath}`);
    console.log(`[dry-run] --- script body ---`);
    console.log(scriptBody.trimEnd());
    if (launcher === "zellij") {
      console.log(`[dry-run] --- zellij invocation ---`);
      console.log(`[dry-run] zellij ${buildZellijArgv(cfg, serverAlias, scriptPath).map(shQuote).join(" ")}`);
    } else {
      const ghosttyBin = cfg.ghostty ?? "ghostty";
      console.log(`[dry-run] --- ghostty invocation ---`);
      console.log(`[dry-run] ${ghosttyBin} ${buildGhosttyArgv(cfg, scriptPath).map(shQuote).join(" ")}`);
    }
    updateAglDefault(cfg.agl_config, serverAlias, true);
    return;
  }

  await stopExistingServer();

  mkdirSync(scriptDir, { recursive: true });
  writeFileSync(scriptPath, scriptBody);
  chmodSync(scriptPath, 0o755);
  console.log(`wrote launcher: ${scriptPath}`);

  updateAglDefault(cfg.agl_config, serverAlias, false);

  if (launcher === "zellij") {
    // Reuse: close stale inference panes first so relaunches replace the
    // existing floating pane instead of stacking a new one each time.
    const session = cfg.zellij?.session ?? process.env.ZELLIJ_SESSION_NAME;
    closePanes(cfg, session, findInferencePanes(cfg, session));
    launchZellij(cfg, serverAlias, scriptPath);
  } else launchGhostty(cfg, scriptPath, serverAlias);

  // Record state for `kill` / `last`: find the freshly started server pid.
  // The launcher (ghostty/zellij) spawns the script, which execs
  // llama-server — give it a moment to appear, then take the newest pid.
  let serverPid = null;
  for (let i = 0; i < 50; i++) {
    await sleep(200);
    const pids = pidsOfServer();
    if (pids.length) {
      serverPid = Math.max(...pids);
      break;
    }
  }
  if (serverPid) {
    writeLock(cfg, { pid: serverPid, profile: name, alias: serverAlias, startedAt: Date.now() });
    console.log(`tracking pid ${serverPid} in ${lockPath(cfg)}`);
  } else {
    console.warn("warning: no llama-server pid found after 10s — lock not written (kill/last guard disabled).");
  }
  saveLastProfile(name);

  // Block until the server is actually serving again, so a caller that just
  // freed the GPU (e.g. `kill; sleep 8; last` from a pi tool call) doesn't
  // return while the model is still loading. Honors --no-wait.
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

function buildZellijArgv(cfg, serverAlias, scriptPath) {
  const z = cfg.zellij ?? {};
  const argv = [];
  const session = z.session ?? process.env.ZELLIJ_SESSION_NAME;
  if (session) argv.push("--session", String(session));
  argv.push(
    "action", "new-pane",
    "--floating",
    "--x", String(z.x ?? "0%"),
    "--y", String(z.y ?? "0%"),
    "--width", String(z.width ?? "60%"),
    "--height", String(z.height ?? "50%"),
    "--name", String(serverAlias),
  );
  if (z.focus !== true) argv.push("--no-focus"); // default: mari keeps focus
  if (z.pinned === true) argv.push("--pinned", "true");
  // no --close-on-exit: like ghostty's wait_after_exit, the pane stays open
  // after exit so crash output stays readable
  argv.push("--", scriptPath);
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
  console.log(`server 'llama-server:${serverAlias}' starting in a new Ghostty window — logs visible there.`);
}

function launchZellij(cfg, serverAlias, scriptPath) {
  const session = cfg.zellij?.session ?? process.env.ZELLIJ_SESSION_NAME;
  if (!session && !process.env.ZELLIJ) {
    console.error("error: zellij launcher needs a target session — run inside zellij or set zellij.session in config.yaml");
    process.exit(1);
  }
  if (typeof Bun.which === "function" && !Bun.which("zellij")) {
    console.error("error: zellij binary not found on PATH");
    process.exit(1);
  }
  const argv = buildZellijArgv(cfg, serverAlias, scriptPath);
  console.log(`launch: zellij ${argv.map(shQuote).join(" ")}`);
  const r = spawnSync("zellij", argv, { encoding: "utf8" });
  if (r.error) {
    console.error(`error: failed to spawn zellij: ${r.error.message}`);
    process.exit(1);
  }
  if (r.status !== 0) {
    console.error(`error: zellij exited with status ${r.status}`);
    if (r.stderr) console.error(r.stderr.trimEnd());
    process.exit(1);
  }
  const paneId = (r.stdout ?? "").trim();
  console.log(`server 'llama-server:${serverAlias}' starting in floating pane ${paneId || "(see zellij)"} — logs visible there.`);
}

await main();
