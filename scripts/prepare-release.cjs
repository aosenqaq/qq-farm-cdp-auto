#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const projectRoot = path.join(__dirname, "..");
const args = new Set(process.argv.slice(2));
const publishMode = args.has("--publish");
const keepNodeModules = args.has("--keep-node-modules");

const runtimeFiles = [
  "data/farm-config.json",
  "data/auto-fertilizer-state.json",
  "data/friend-help-exp-cache.json",
  "data/message-push-state.json",
  "data/player-profile-cache.json",
  "data/task-events.ndjson",
];

const runtimeDirs = [
  "data/account-stats",
  "dist",
  "logs",
  "_miniapp_extracted_images",
];

const publishOnlyDirs = [
  "qq-ws-test",
];

function rel(...parts) {
  return path.join(projectRoot, ...parts);
}

function ensureInsideProject(targetPath) {
  const resolved = path.resolve(targetPath);
  const rootWithSep = path.resolve(projectRoot) + path.sep;
  if (resolved !== path.resolve(projectRoot) && !resolved.startsWith(rootWithSep)) {
    throw new Error(`拒绝操作项目外路径: ${resolved}`);
  }
  return resolved;
}

function removeIfExists(targetPath) {
  const resolved = ensureInsideProject(targetPath);
  if (!fs.existsSync(resolved)) return false;
  fs.rmSync(resolved, { recursive: true, force: true });
  return true;
}

function recreateDir(relativeDir) {
  const dirPath = ensureInsideProject(rel(relativeDir));
  fs.mkdirSync(dirPath, { recursive: true });
}

function writeFile(relativePath, content) {
  const filePath = ensureInsideProject(rel(relativePath));
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, "utf8");
}

function main() {
  const removed = [];

  for (const relativeFile of runtimeFiles) {
    if (removeIfExists(rel(relativeFile))) {
      removed.push(relativeFile);
    }
  }

  for (const relativeDir of runtimeDirs) {
    if (removeIfExists(rel(relativeDir))) {
      removed.push(relativeDir + "/");
    }
  }

  if (publishMode) {
    for (const relativeDir of publishOnlyDirs) {
      if (removeIfExists(rel(relativeDir))) {
        removed.push(relativeDir + "/");
      }
    }
    if (!keepNodeModules && removeIfExists(rel("node_modules"))) {
      removed.push("node_modules/");
    }
  }

  recreateDir("data/account-stats/auto-farm-daily");
  recreateDir("logs");

  writeFile("data/.gitkeep", "");
  writeFile("data/account-stats/auto-farm-daily/.gitkeep", "");
  writeFile("logs/.gitkeep", "");

  console.log(`[release] mode=${publishMode ? "publish" : "runtime"} keepNodeModules=${keepNodeModules}`);
  if (removed.length === 0) {
    console.log("[release] nothing to clean");
  } else {
    removed.forEach((item) => console.log(`[release] removed ${item}`));
  }
  console.log("[release] ensured data/account-stats/auto-farm-daily/");
  console.log("[release] ensured logs/");
}

main();
