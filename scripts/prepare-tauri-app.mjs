#!/usr/bin/env node

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmod, copyFile, cp, link, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const nodeVersion = "22.23.2";
const nodeArchitectures = ["arm64", "x64"];
const nodeChecksums = {
  arm64: "61130f394c1630d211dd50aecc4353d379480f36d3ac913cd85dbba1aed585c6",
  x64: "58e99022c2ff89395576cc7fd4d98cea24bb68081475d5f88b801ee8729fb026",
};
const scriptPath = fileURLToPath(import.meta.url);
const projectRoot = path.resolve(path.dirname(scriptPath), "..");
const tauriRoot = path.join(projectRoot, "src-tauri");
const resourcesRoot = path.join(tauriRoot, "resources");
const binariesRoot = path.join(tauriRoot, "binaries");
const cacheRoot = path.join(projectRoot, ".tauri-runtime-cache");

async function exists(target) {
  try { await stat(target); return true; } catch { return false; }
}

async function sha256(target) {
  return createHash("sha256").update(await readFile(target)).digest("hex");
}

async function download(url, target) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Download failed: ${response.status} ${url}`);
  const temporary = `${target}.download`;
  await writeFile(temporary, Buffer.from(await response.arrayBuffer()));
  await rename(temporary, target);
}

async function nodeArchive(architecture) {
  const archive = `node-v${nodeVersion}-darwin-${architecture}.tar.gz`;
  const target = path.join(cacheRoot, archive);
  await mkdir(cacheRoot, { recursive: true });
  if (!(await exists(target)) || await sha256(target) !== nodeChecksums[architecture]) {
    await download(`https://nodejs.org/dist/v${nodeVersion}/${archive}`, target);
  }
  if (await sha256(target) !== nodeChecksums[architecture]) throw new Error(`Checksum mismatch for ${archive}`);
  return target;
}

function run(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr.trim() || `${command} failed`);
  return result.stdout.trim();
}

async function prepareNode() {
  const extractedRoot = path.join(cacheRoot, "extracted");
  const runtimes = new Map();
  for (const architecture of nodeArchitectures) {
    const archive = await nodeArchive(architecture);
    const destination = path.join(extractedRoot, architecture);
    await rm(destination, { recursive: true, force: true });
    await mkdir(destination, { recursive: true });
    run("/usr/bin/tar", ["-xzf", archive, "-C", destination]);
    runtimes.set(architecture, path.join(destination, `node-v${nodeVersion}-darwin-${architecture}`));
  }
  await mkdir(binariesRoot, { recursive: true });
  const universal = path.join(binariesRoot, "node-universal-apple-darwin");
  run("/usr/bin/lipo", ["-create", path.join(runtimes.get("arm64"), "bin/node"), path.join(runtimes.get("x64"), "bin/node"), "-output", universal]);
  await chmod(universal, 0o755);
  await rm(path.join(binariesRoot, "node-aarch64-apple-darwin"), { force: true });
  await rm(path.join(binariesRoot, "node-x86_64-apple-darwin"), { force: true });
  await link(universal, path.join(binariesRoot, "node-aarch64-apple-darwin"));
  await link(universal, path.join(binariesRoot, "node-x86_64-apple-darwin"));
  await mkdir(path.join(resourcesRoot, "licenses"), { recursive: true });
  await copyFile(path.join(runtimes.get("arm64"), "LICENSE"), path.join(resourcesRoot, "licenses/Node-LICENSE"));
  await rm(extractedRoot, { recursive: true, force: true });
}

async function prepareResources() {
  await rm(resourcesRoot, { recursive: true, force: true });
  const appRoot = path.join(resourcesRoot, "app");
  await mkdir(appRoot, { recursive: true });
  await cp(path.join(projectRoot, "game"), path.join(appRoot, "game"), { recursive: true });
  await cp(path.join(projectRoot, "server"), path.join(appRoot, "server"), { recursive: true });
  await cp(path.join(projectRoot, "inject"), path.join(appRoot, "inject"), { recursive: true });
  await mkdir(path.join(appRoot, "scripts"), { recursive: true });
  for (const name of ["launcher.mjs", "codex-cdp-pipe.mjs"]) {
    await copyFile(path.join(projectRoot, "scripts", name), path.join(appRoot, "scripts", name));
  }
  await mkdir(path.join(resourcesRoot, "licenses"), { recursive: true });
  await copyFile(path.join(projectRoot, "UPSTREAM-DASHI-LICENSE"), path.join(resourcesRoot, "licenses/UPSTREAM-DASHI-LICENSE"));
  await writeFile(path.join(resourcesRoot, "licenses/DOUDIZHU-NOTICE.txt"), [
    "Codex 斗地主 embeds the web build from VYuLinLin/doudizhu-stand-alone.",
    "Pinned source commit: 98ef391bb0f04828d6fcf9af244fc2de4d6c2253.",
    "This personal build is not for redistribution; review upstream and third-party rights before sharing.",
    "",
  ].join("\n"));
}

await prepareResources();
await prepareNode();
console.log(`Prepared Codex 斗地主 resources with Node.js ${nodeVersion}`);

