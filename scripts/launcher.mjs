#!/usr/bin/env node

import { createHash, createHmac, randomBytes } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { CdpPipeBrowser } from "./codex-cdp-pipe.mjs";
import { startGameServer } from "../server/game-server.mjs";

const scriptPath = fileURLToPath(import.meta.url);
const projectRoot = path.resolve(path.dirname(scriptPath), "..");
const defaultAppCandidates = [
  "/Applications/ChatGPT.app",
  path.join(os.homedir(), "Applications/ChatGPT.app"),
  "/Applications/Codex.app",
  path.join(os.homedir(), "Applications/Codex.app"),
];
const profilePath = path.resolve(process.env.CODEX_DOUDIZHU_PROFILE || "/private/tmp/codex-doudizhu-independent-profile-v1");
const sourceProfilePath = path.resolve(process.env.CODEX_DOUDIZHU_SOURCE_PROFILE || path.join(os.homedir(), "Library/Application Support/Codex"));
const gameRoot = path.resolve(process.env.CODEX_DOUDIZHU_GAME_ROOT || path.join(projectRoot, "game/web-desktop"));
const injectionPath = path.join(projectRoot, "inject/codex-doudizhu.user.js");
const appPath = path.resolve(process.env.CODEX_DOUDIZHU_APP_PATH || defaultAppCandidates.find((candidate) => existsSync(candidate)) || defaultAppCandidates[0]);
const diagnostic = process.env.CODEX_DOUDIZHU_DIAGNOSTIC === "1";

let serverRuntime = null;
let codexChild = null;
let browser = null;
let stopping = false;
let openRequested = false;
const sessions = new Map();
let diagnosticTargetSignature = "";

function existsSync(target) {
  try {
    return Boolean(spawnSync("/usr/bin/test", ["-e", target]).status === 0);
  } catch {
    return false;
  }
}

function cleanEnvironment(environment = process.env) {
  return Object.fromEntries(Object.entries(environment).filter(([name]) => (
    !name.startsWith("CODEX_DOUDIZHU_")
  )));
}

function executablePath(bundlePath) {
  return process.platform === "win32"
    ? bundlePath
    : path.join(bundlePath, "Contents", "MacOS", path.basename(bundlePath, ".app"));
}

function managedProcesses() {
  const result = spawnSync("/bin/ps", ["-ww", "-axo", "pid=,command="], { encoding: "utf8", env: cleanEnvironment(), maxBuffer: 4 * 1024 * 1024 });
  if (result.status !== 0) return [];
  const executable = executablePath(appPath);
  const marker = `--user-data-dir=${profilePath}`;
  return result.stdout.split("\n").flatMap((line) => {
    const match = line.match(/^\s*(\d+)\s+(.+)$/);
    if (!match || !match[2].startsWith(`${executable} `) || !match[2].includes(` ${marker} `)) return [];
    return [{ pid: Number(match[1]), command: match[2] }];
  });
}

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function stopPid(pid) {
  if (!processAlive(pid)) return;
  try { process.kill(pid, "SIGTERM"); } catch (_) {}
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline && processAlive(pid)) await new Promise((resolve) => setTimeout(resolve, 100));
  if (processAlive(pid)) {
    try { process.kill(pid, "SIGKILL"); } catch (_) {}
  }
}

async function importCodexBrowserProfile() {
  if (sourceProfilePath === profilePath) return;
  const marker = path.join(profilePath, ".codex-doudizhu-profile-imported-v1");
  if (existsSync(marker)) return;
  const relativePaths = [
    "Default/Partitions/codex-browser-app/Cookies",
    "Default/Partitions/codex-browser-app/Login Data",
    "Default/Partitions/codex-browser-app/Login Data For Account",
  ];
  let sqlite;
  try { sqlite = await import("node:sqlite"); } catch { return; }
  const sources = relativePaths.filter((relativePath) => existsSync(path.join(sourceProfilePath, relativePath)));
  if (!sources.length) return;
  await mkdir(profilePath, { recursive: true });
  for (const relativePath of sources) {
    const sourcePath = path.join(sourceProfilePath, relativePath);
    const destinationPath = path.join(profilePath, relativePath);
    await mkdir(path.dirname(destinationPath), { recursive: true });
    const sourceDatabase = new sqlite.DatabaseSync(sourcePath, { readOnly: true });
    try { await sqlite.backup(sourceDatabase, destinationPath); } finally { sourceDatabase.close(); }
  }
  await writeFile(marker, "1\n", { mode: 0o600 });
}

async function launchCodex() {
  await mkdir(profilePath, { recursive: true });
  await importCodexBrowserProfile();
  for (const processRecord of managedProcesses()) await stopPid(processRecord.pid);
  const launchArguments = [
    `--user-data-dir=${profilePath}`,
    "--remote-debugging-pipe",
  ];
  const child = spawn(executablePath(appPath), launchArguments, {
    cwd: projectRoot,
    env: cleanEnvironment(),
    detached: false,
    stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"],
  });
  codexChild = child;
  browser = new CdpPipeBrowser(child);
  await browser.open();
  child.once("exit", (code, signal) => {
    if (!stopping) console.error(`Codex exited (${signal || code})`);
  });
}

function isCodexTarget(target) {
  return target?.type === "page" && (
    target.url?.startsWith("app://")
    || target.title === "Codex"
    || target.title === "ChatGPT"
  );
}

async function runtimeSource() {
  const userScript = await readFile(injectionPath, "utf8");
  const gameHtml = await readFile(path.join(gameRoot, "index.html"), "utf8");
  const source = `window.__CODEX_DOUDIZHU_URL__=${JSON.stringify(serverRuntime.gameUrl)};\nwindow.__CODEX_DOUDIZHU_BOOTSTRAP_HTML__=${JSON.stringify(gameHtml)};\nwindow.__CODEX_DOUDIZHU_AUTO_OPEN__=true;\n${userScript}`;
  const sourceHash = createHash("sha256").update(source).digest("hex");
  return { source: `window.__CODEX_DOUDIZHU_SOURCE_HASH__=${JSON.stringify(sourceHash)};\n${source}`, sourceHash };
}

async function injectTarget(target, sourceInfo) {
  if (sessions.has(target.targetId)) return sessions.get(target.targetId);
  const session = await browser.connect(target.targetId);
  if (diagnostic) {
    session.on("Page.frameNavigated", (event) => {
      if (event.frame?.url?.startsWith("http://127.0.0.1:")) console.error(`[renderer ${target.targetId}] frame ${JSON.stringify(event.frame)}`);
    });
    session.on("Network.loadingFailed", (event) => {
      console.error(`[renderer ${target.targetId}] load failed ${JSON.stringify(event)}`);
    });
    session.on("Network.responseReceived", (event) => {
      if (event.response?.url?.startsWith("http://127.0.0.1:")) console.error(`[renderer ${target.targetId}] response ${event.response.status} ${event.response.mimeType} ${event.response.url}`);
    });
    session.on("Log.entryAdded", (event) => {
      if (event.entry?.source !== "network" || event.entry?.level === "error") console.error(`[renderer ${target.targetId}] log ${JSON.stringify(event.entry || {})}`);
    });
    session.on("Runtime.consoleAPICalled", (event) => {
      const values = (event.args || []).map((argument) => argument.value ?? argument.description ?? "");
      const line = values.join(" ");
      if (/codex|doudizhu|gameScene|error|exception/i.test(line)) console.error(`[renderer ${target.targetId}] ${line}`);
    });
    session.on("Runtime.exceptionThrown", (event) => {
      console.error(`[renderer ${target.targetId}] exception ${JSON.stringify(event.exceptionDetails || {})}`);
    });
    session.on("Runtime.executionContextCreated", (event) => {
      if (event.context?.origin?.startsWith("http://127.0.0.1:")) console.error(`[renderer ${target.targetId}] game context ${event.context.origin}`);
    });
  }
  await session.send("Page.enable");
  await session.send("Page.setBypassCSP", { enabled: true });
  if (diagnostic) {
    await session.send("Network.enable");
    await session.send("Log.enable");
  }
  await session.send("Runtime.enable");
  await session.send("Page.addScriptToEvaluateOnNewDocument", {
    source: `${sourceInfo.source}\n//# sourceURL=codex-doudizhu.user.js`,
  });
  await session.send("Runtime.evaluate", { expression: sourceInfo.source, returnByValue: true });
  sessions.set(target.targetId, session);
  if (diagnostic) {
    const state = await session.send("Runtime.evaluate", {
      expression: "JSON.stringify({url:location.href,entry:Boolean(window.__codexDoudizhuInjection__),gameUrl:window.__CODEX_DOUDIZHU_URL__,iframes:document.querySelectorAll('iframe').length,active:document.documentElement.hasAttribute('data-codex-doudizhu-open')})",
      returnByValue: true,
    });
    console.error(`[renderer ${target.targetId}] state ${state?.result?.value || "unknown"}`);
    setTimeout(async () => {
      if (session.closed) return;
      try {
        const later = await session.send("Runtime.evaluate", {
          expression: "(() => { const frame=document.querySelector('#codex-doudizhu-frame'); return JSON.stringify({url:location.href,origin:location.origin,entry:Boolean(window.__codexDoudizhuInjection__),ready:Boolean(window.__codexDoudizhuInjection__?.ready),frameTag:frame?.tagName || '',webviewExecute:typeof document.createElement('webview').executeJavaScript,active:document.documentElement.hasAttribute('data-codex-doudizhu-open'),frameSrc:frame?.src || '',frameLoaded:frame?.dataset.codexDoudizhuLoaded || '',frameBridge:frame?.dataset.codexDoudizhuBridge || '',frameError:frame?.dataset.codexDoudizhuError || '',status:document.querySelector('#codex-doudizhu-status')?.textContent || ''}); })()",
          returnByValue: true,
        });
        console.error(`[renderer ${target.targetId}] delayed ${later?.result?.value || "unknown"}`);
      } catch (error) {
        console.error(`[renderer ${target.targetId}] delayed diagnostic failed ${error.message}`);
      }
    }, 12_000);
  }
  if (openRequested) await openTarget(session);
  return session;
}

async function openTarget(session) {
  try {
    // Re-assert immediately before creating the loopback frame. Recent Codex
    // builds install their renderer CSP during app hydration.
    await session.send("Page.setBypassCSP", { enabled: true });
    await session.send("Runtime.evaluate", {
      expression: "window.__codexDoudizhuInjection__?.open?.()",
      returnByValue: true,
    });
    await session.send("Page.bringToFront");
  } catch (error) {
    if (!stopping) console.error(`Open panel failed: ${error.message}`);
  }
}

async function scanTargets(sourceInfo) {
  if (!browser || browser.closed) return;
  const allTargets = await browser.targets();
  if (diagnostic) {
    const targetSignature = JSON.stringify(allTargets.map(({ targetId, type, url, title }) => ({ targetId, type, url, title })));
    if (targetSignature !== diagnosticTargetSignature) {
      diagnosticTargetSignature = targetSignature;
      console.error(`[targets] ${targetSignature}`);
    }
  }
  const targets = allTargets.filter(isCodexTarget);
  const targetIds = new Set(targets.map((target) => target.targetId));
  for (const [targetId, session] of sessions) {
    if (!targetIds.has(targetId)) {
      session.close();
      sessions.delete(targetId);
    }
  }
  for (const target of targets) {
    try { await injectTarget(target, sourceInfo); } catch (error) {
      if (!stopping) console.error(`Inject target failed: ${error.message}`);
    }
  }
}

async function verifyServer() {
  const challenge = randomBytes(32).toString("hex");
  const response = await fetch(serverRuntime.healthUrl, {
    headers: { "x-codex-doudizhu-challenge": challenge },
  });
  if (!response.ok) throw new Error(`Game server health returned HTTP ${response.status}`);
  const body = await response.json();
  const proof = createHmac("sha256", serverRuntime.secret).update(challenge).digest("hex");
  if (body?.product !== "codex-doudizhu" || body.proof !== proof) throw new Error("Game server identity verification failed");
}

async function openPanel() {
  openRequested = true;
  for (const session of sessions.values()) await openTarget(session);
}

async function stop() {
  if (stopping) return;
  stopping = true;
  for (const session of sessions.values()) session.close();
  sessions.clear();
  browser?.close();
  browser = null;
  if (codexChild && !codexChild.killed) {
    try { codexChild.kill("SIGTERM"); } catch (_) {}
  }
  codexChild = null;
  await serverRuntime?.close?.();
  serverRuntime = null;
}

async function main() {
  const args = new Set(process.argv.slice(2));
  process.on("SIGUSR1", () => { void openPanel(); });
  process.once("SIGTERM", () => { void stop().finally(() => process.exit(0)); });
  process.once("SIGINT", () => { void stop().finally(() => process.exit(0)); });
  serverRuntime = await startGameServer({ gameRoot });
  await verifyServer();
  await launchCodex();
  const sourceInfo = await runtimeSource();
  openRequested = args.has("--open") || !args.has("--no-open");
  const deadline = Date.now() + 30_000;
  while (!stopping && Date.now() < deadline && sessions.size === 0) {
    await scanTargets(sourceInfo);
    if (sessions.size === 0) await new Promise((resolve) => setTimeout(resolve, 150));
  }
  if (sessions.size === 0) throw new Error("Codex renderer did not become available");
  console.log(JSON.stringify({ product: "codex-doudizhu", gameUrl: serverRuntime.gameUrl, pid: process.pid, appPath }, null, 2));
  while (!stopping) {
    await scanTargets(sourceInfo);
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
}

main().catch(async (error) => {
  console.error(error?.stack || error);
  await stop();
  process.exitCode = 1;
});
