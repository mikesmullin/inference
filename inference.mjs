#!/usr/bin/env bun
// inference.mjs — launch a llama-server profile via the configured launcher
// backend (a Ghostty window, or a floating pane in the current zellij session).
//
// Usage:
//   ~/inference.mjs <profile> [--dry-run] [--launcher ghostty|zellij]
//                                       start (or restart) the server
//   ~/inference.mjs list                    show available profiles
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
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
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
  // --launcher <ghostty|zellij> overrides the config file's `launcher` setting
  let launcherOverride;
  const scrubbed = [];
  for (let i = 0; i < rawArgs.length; i++) {
    if (rawArgs[i] === "--launcher") {
      launcherOverride = rawArgs[i + 1];
      i++;
    } else {
      scrubbed.push(rawArgs[i]);
    }
  }
  if (rawArgs.includes("--launcher") && launcherOverride === undefined) {
    console.error("error: --launcher needs a value (ghostty|zellij)");
    process.exit(1);
  }
  const positional = scrubbed.filter((a) => a !== "--dry-run");
  const cfg = loadConfig();
  const launcher = resolveLauncher(cfg, launcherOverride);

  const [cmd, ...rest] = positional;
  if (!cmd || cmd === "help" || cmd === "-h" || cmd === "--help") {
    console.log("usage: ~/inference.mjs <profile> [--dry-run] [--launcher ghostty|zellij] | ~/inference.mjs list");
    listProfiles(cfg);
    process.exit(cmd ? 0 : 1);
  }
  if (cmd === "list") {
    listProfiles(cfg);
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

  const { serverAlias, argv } = buildServerArgv(cmd, cfg.models[cmd]);
  checkFilesExist(argv);

  const scriptDir = expand(cfg.script_dir ?? "~/.cache/inference");
  const scriptPath = join(scriptDir, `${cmd}.sh`);
  const scriptBody =
    `#!/bin/sh\n` +
    `# Generated by ~/inference.mjs for profile '${cmd}' — do not edit.\n` +
    `# Re-generated on every launch.\n` +
    `${argv.map(shQuote).join(" ")}\n` +
    `status=$?\n` +
    `printf '\\nllama-server (profile ${cmd}) exited with status %s\\n' "$status"\n`;

  if (dryRun) {
    console.log(`[dry-run] profile:      ${cmd}`);
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

  if (launcher === "zellij") launchZellij(cfg, serverAlias, scriptPath);
  else launchGhostty(cfg, scriptPath, serverAlias);
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
