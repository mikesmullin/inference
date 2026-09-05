#!/usr/bin/env bun
// inference.mjs — launch a llama-server profile in its own Ghostty window.
//
// Usage:
//   ~/inference.mjs <profile> [--dry-run]   start (or restart) the server
//   ~/inference.mjs list                    show available profiles
//
// Reads ~/.config/inference/config.yaml. For each launch it:
//   1. stops any running llama-server (frees 127.0.0.1:1234),
//   2. writes a launcher script to <script_dir>/<profile>.sh,
//   3. points the AGL default_model at the new server,
//   4. opens a new Ghostty window running the launcher, so server logs
//      stay visible and a crash is obvious (the window is kept open
//      after exit while wait_after_exit is true).
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
  for (const a of m.args ?? []) argv.push(String(a));
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
  const positional = rawArgs.filter((a) => a !== "--dry-run");
  const cfg = loadConfig();

  const [cmd, ...rest] = positional;
  if (!cmd || cmd === "help" || cmd === "-h" || cmd === "--help") {
    console.log("usage: ~/inference.mjs <profile> [--dry-run] | ~/inference.mjs list");
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

  const ghosttyBin = cfg.ghostty ?? "ghostty";
  const ghosttyArgv = [];
  if (cfg.wait_after_exit !== false) ghosttyArgv.push("--wait-after-command=true");
  ghosttyArgv.push("-e", scriptPath);

  if (dryRun) {
    console.log(`[dry-run] profile:      ${cmd}`);
    console.log(`[dry-run] server alias: ${serverAlias}`);
    console.log(`[dry-run] script:       ${scriptPath}`);
    console.log(`[dry-run] --- script body ---`);
    console.log(scriptBody.trimEnd());
    console.log(`[dry-run] --- ghostty invocation ---`);
    console.log(`[dry-run] ${ghosttyBin} ${ghosttyArgv.map(shQuote).join(" ")}`);
    updateAglDefault(cfg.agl_config, serverAlias, true);
    return;
  }

  if (!process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
    console.error("error: no DISPLAY or WAYLAND_DISPLAY — ghostty needs a graphical session");
    process.exit(1);
  }
  if (typeof Bun.which === "function" && !Bun.which(ghosttyBin)) {
    console.error(`error: ghostty binary not found on PATH: ${ghosttyBin}`);
    process.exit(1);
  }

  await stopExistingServer();

  mkdirSync(scriptDir, { recursive: true });
  writeFileSync(scriptPath, scriptBody);
  chmodSync(scriptPath, 0o755);
  console.log(`wrote launcher: ${scriptPath}`);

  updateAglDefault(cfg.agl_config, serverAlias, false);

  console.log(`launch: ${ghosttyBin} ${ghosttyArgv.map(shQuote).join(" ")}`);
  const child = spawn(ghosttyBin, ghosttyArgv, { detached: true, stdio: "ignore" });
  child.unref();
  console.log(`server 'llama-server:${serverAlias}' starting in a new Ghostty window — logs visible there.`);
}

await main();
