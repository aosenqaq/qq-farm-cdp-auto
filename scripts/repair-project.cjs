#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { execSync } = require("node:child_process");

const projectRoot = path.join(__dirname, "..");
const envPath = path.join(projectRoot, ".env");
const examplePath = path.join(projectRoot, ".env.example");

function parseEnvKeys(text) {
  const out = {};
  const lines = String(text || "").split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    let line = lines[i].trim();
    if (!line || line.startsWith("#")) continue;
    if (line.startsWith("export ")) line = line.slice(7).trim();
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const k = line.slice(0, eq).trim();
    let v = line.slice(eq + 1).trim();
    const hash = v.search(/\s#/);
    if (hash >= 0) v = v.slice(0, hash).trimEnd();
    out[k] = v;
  }
  return out;
}

function upsertEnvLine(text, key, value) {
  const hadCrLf = text.includes("\r\n");
  const nl = hadCrLf ? "\r\n" : "\n";
  const lines = text.split(/\r?\n/);
  let hit = false;
  const next = lines.map((line) => {
    const trimmed = line.trim();
    if (trimmed.startsWith("#")) return line;
    if (new RegExp(`^\\s*${key}=`).test(line)) {
      hit = true;
      return `${key}=${value}`;
    }
    return line;
  });
  if (!hit) next.push(`${key}=${value}`);
  return next.join(nl);
}

function normalizeHttpPathLocal(raw) {
  if (raw == null || raw === "") return "";
  let p = String(raw).split("?")[0].split("#")[0].trim();
  if (!p.startsWith("/")) p = "/" + p;
  while (p.length > 1 && p.endsWith("/")) p = p.slice(0, -1);
  return p;
}

function ensureEnvFile() {
  if (!fs.existsSync(envPath)) {
    if (!fs.existsSync(examplePath)) {
      throw new Error("缺少 .env 与 .env.example，无法自动恢复");
    }
    fs.copyFileSync(examplePath, envPath);
    console.log("[repair] 已从 .env.example 创建 .env");
  }
}

function repairEnvWsUrl() {
  let text = fs.readFileSync(envPath, "utf8");
  const keys = parseEnvKeys(text);
  const host = keys.FARM_GATEWAY_HOST || "127.0.0.1";
  const port = keys.FARM_GATEWAY_PORT || "8787";
  const qqPath = normalizeHttpPathLocal(keys.FARM_QQ_WS_PATH) || "/miniapp";
  const expected = `ws://${host}:${port}${qqPath}`;
  const current = keys.FARM_QQ_HOST_WS_URL || "";
  if (current !== expected) {
    text = upsertEnvLine(text, "FARM_QQ_HOST_WS_URL", expected);
    fs.writeFileSync(envPath, text, "utf8");
    console.log("[repair] 已对齐 FARM_QQ_HOST_WS_URL -> " + expected);
  } else {
    console.log("[repair] FARM_QQ_HOST_WS_URL 已正确: " + expected);
  }
}

function ensureModule(fileRel, hint) {
  const p = path.join(projectRoot, fileRel);
  if (!fs.existsSync(p)) {
    throw new Error(`缺少 ${fileRel}，${hint}`);
  }
}

function main() {
  console.log("[repair] 项目根目录: " + projectRoot);
  ensureEnvFile();
  repairEnvWsUrl();

  try {
    execSync("npm install", { cwd: projectRoot, stdio: "inherit" });
  } catch (_) {
    process.exit(1);
  }

  require(path.join(projectRoot, "load-env.cjs")).loadEnvFiles(projectRoot);
  const { getConfig } = require(path.join(projectRoot, "src", "config.js"));
  const { buildQqBundle, patchQqGameFile, resolveQqPatchTarget } = require(path.join(projectRoot, "src", "qq-bundle.js"));

  ensureModule("src/auto-farm-plant-config.js", "请从上游同步或重新拉取仓库");
  const hostRaw = fs.readFileSync(path.join(projectRoot, "qq-host.js"), "utf8");
  if (hostRaw.includes("__QQ_FARM_ALLOWED_RPC_PATHS__")) {
    throw new Error("qq-host.js 仍为旧版占位符，请 git pull 或从上游恢复 qq-host.js");
  }
  if (!hostRaw.includes("__QQ_FARM_HOST_RPC_PATHS__")) {
    throw new Error("qq-host.js 模板异常，缺少 __QQ_FARM_HOST_RPC_PATHS__");
  }

  const config = getConfig();
  const built = buildQqBundle({ config, projectRoot });
  console.log("[repair] bundle 校验通过 scriptHash=" + built.meta.scriptHash + " ws=" + built.meta.hostWsUrl);

  const target = resolveQqPatchTarget({
    targetPath: config.qqGameJsPath,
    appId: config.qqAppId,
    fallbackTargetPath: config.qqGameJsPath,
    fallbackAppId: config.qqAppId,
    srcRoot: config.qqMiniappSrcRoot,
  });

  let patchPath = target.targetPath;
  if (!patchPath) {
    try {
      const { findLatestQqMiniappAnyApp } = require(path.join(projectRoot, "src", "qq-miniapp-discovery.js"));
      const any = findLatestQqMiniappAnyApp({ srcRoot: config.qqMiniappSrcRoot });
      patchPath = any.selected.gameJsPath;
      console.log("[repair] 已自动发现 QQ game.js appId=" + any.appId + " -> " + patchPath);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.log("[repair] 无法自动发现 game.js: " + msg);
    }
  }

  if (patchPath) {
    const patch = patchQqGameFile(patchPath, built.bundleText, { noBackup: false });
    console.log("[repair] 已写入 QQ 补丁: " + patch.targetPath);
  } else {
    console.log("[repair] 未找到可补丁的 game.js（请安装 QQ 并运行过一次农场小程序）");
  }

  const distDir = path.join(projectRoot, "dist");
  if (!fs.existsSync(distDir)) fs.mkdirSync(distDir, { recursive: true });
  const outJs = path.join(distDir, "qq-miniapp-bootstrap.js");
  fs.writeFileSync(outJs, built.bundleText, "utf8");
  console.log("[repair] 已写入 " + outJs);

  console.log("[repair] 完成");
}

main();
