#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const projectRoot = path.join(__dirname, "..");
const targetArg = process.argv[2] ? path.resolve(process.argv[2]) : projectRoot;

const REQUIRED_PATHS = [
  "run.cjs",
  "start.bat",
  "public/index.html",
  "src/game-config.js",
  "src/plant-analytics.js",
  "gameConfig/Plant.json",
  "gameConfig/ItemInfo.json",
  "gameConfig/RoleLevel.json",
];

const WARN_PATHS = [
  "gameConfig/plant_images/default/400.jpg",
];

function normalizeEntryPath(value) {
  return String(value || "")
    .replace(/\\/g, "/")
    .replace(/^\.?\//, "")
    .replace(/\/+/g, "/")
    .trim();
}

function readZipEntries(zipPath) {
  let stdout = "";
  try {
    stdout = execFileSync("tar", ["-tf", zipPath], {
      cwd: projectRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    const stderr = error && typeof error.stderr === "string" ? error.stderr.trim() : "";
    throw new Error(`无法读取压缩包内容：${stderr || error.message}`);
  }
  return stdout
    .split(/\r?\n/)
    .map((line) => normalizeEntryPath(line))
    .filter(Boolean);
}

function verifyDirectory(dirPath) {
  const missing = [];
  const warnings = [];
  REQUIRED_PATHS.forEach((relativePath) => {
    if (!fs.existsSync(path.join(dirPath, relativePath))) {
      missing.push(relativePath);
    }
  });
  WARN_PATHS.forEach((relativePath) => {
    if (!fs.existsSync(path.join(dirPath, relativePath))) {
      warnings.push(relativePath);
    }
  });
  return {
    mode: "directory",
    target: dirPath,
    missing,
    warnings,
  };
}

function verifyZip(zipPath) {
  const entrySet = new Set(readZipEntries(zipPath));
  const hasEntry = (relativePath) => entrySet.has(normalizeEntryPath(relativePath));
  const missing = REQUIRED_PATHS.filter((relativePath) => !hasEntry(relativePath));
  const warnings = WARN_PATHS.filter((relativePath) => !hasEntry(relativePath));
  return {
    mode: "zip",
    target: zipPath,
    missing,
    warnings,
  };
}

function printResult(result) {
  console.log(`[verify-release] target=${result.target}`);
  console.log(`[verify-release] mode=${result.mode}`);

  if (result.missing.length === 0) {
    console.log("[verify-release] required files: OK");
  } else {
    console.log("[verify-release] required files: MISSING");
    result.missing.forEach((item) => console.log(`  - ${item}`));
  }

  if (result.warnings.length > 0) {
    console.log("[verify-release] optional warnings:");
    result.warnings.forEach((item) => console.log(`  - ${item}`));
  }

  if (result.missing.length > 0) {
    console.log("[verify-release] 该发布包会导致作物分析或等级进度异常，请重新打包后再分发。");
    process.exitCode = 1;
    return;
  }

  console.log("[verify-release] 发布包核心文件完整。");
}

function main() {
  if (!fs.existsSync(targetArg)) {
    throw new Error(`目标不存在：${targetArg}`);
  }

  const stat = fs.statSync(targetArg);
  const result = stat.isDirectory()
    ? verifyDirectory(targetArg)
    : verifyZip(targetArg);
  printResult(result);
}

try {
  main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[verify-release] ${message}`);
  process.exit(1);
}
