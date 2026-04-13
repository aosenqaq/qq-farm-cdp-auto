"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { findLatestQqMiniappByAppId } = require("./qq-miniapp-discovery");

function isDirectory(targetPath) {
  try {
    return fs.statSync(targetPath).isDirectory();
  } catch (_) {
    return false;
  }
}

function isFile(targetPath) {
  try {
    return fs.statSync(targetPath).isFile();
  } catch (_) {
    return false;
  }
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function walkFiles(rootDir) {
  const out = [];
  if (!isDirectory(rootDir)) return out;
  const stack = [rootDir];
  while (stack.length) {
    const current = stack.pop();
    const entries = fs.readdirSync(current, { withFileTypes: true });
    for (let i = 0; i < entries.length; i += 1) {
      const entry = entries[i];
      const abs = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(abs);
      } else if (entry.isFile()) {
        out.push(abs);
      }
    }
  }
  out.sort((a, b) => a.localeCompare(b));
  return out;
}

function sanitizeLabel(value) {
  return String(value == null ? "" : value)
    .trim()
    .replace(/^db:\/+assets\/?/i, "")
    .replace(/^db:\/+internal\/?/i, "internal/")
    .replace(/^\/+/, "")
    .replace(/[\\/]+/g, "_")
    .replace(/[^0-9A-Za-z_\-.]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();
}

function loadJsonSafe(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (_) {
    return null;
  }
}

function normalizeUuidKey(value) {
  return String(value == null ? "" : value).trim();
}

function scoreAssetPath(assetPath) {
  const text = String(assetPath || "");
  let score = 0;
  if (!text) return -1;
  if (!/\/texture$/i.test(text)) score += 8;
  if (!/\/spriteframe$/i.test(text)) score += 6;
  if (!/^db:/i.test(text)) score += 4;
  if (!/\/config$/i.test(text)) score += 3;
  score -= text.length / 1000;
  return score;
}

function buildUuidAssetPathMap(assetsRoot) {
  const map = new Map();
  const configFiles = walkFiles(assetsRoot).filter((filePath) => /[\\/]config\.[^\\/]+\.json$/i.test(filePath));
  for (let i = 0; i < configFiles.length; i += 1) {
    const configPath = configFiles[i];
    const config = loadJsonSafe(configPath);
    if (!config || !Array.isArray(config.uuids) || !config.paths || typeof config.paths !== "object") continue;
    const bundleDir = path.dirname(configPath);
    const importBase = String(config.importBase || "import");
    const rawUuidByIndex = new Map();
    const importVersions = config.versions && Array.isArray(config.versions.import) ? config.versions.import : [];
    for (let j = 0; j < importVersions.length; j += 2) {
      const index = Number(importVersions[j]);
      const version = String(importVersions[j + 1] || "");
      if (!Number.isInteger(index) || !version) continue;
      const prefix = String(config.uuids[index] || "").slice(0, 2);
      if (!prefix) continue;
      const importDir = path.join(bundleDir, importBase, prefix);
      if (!isDirectory(importDir)) continue;
      const files = fs.readdirSync(importDir);
      const matched = files.find((name) => new RegExp(`^([0-9a-f-]+)\\.${version}\\.(json|bin)$`, "i").test(name));
      if (!matched) continue;
      const rawUuid = matched.replace(new RegExp(`\\.${version}\\.(json|bin)$`, "i"), "");
      if (rawUuid) rawUuidByIndex.set(index, rawUuid.toLowerCase());
    }
    const pathEntries = Object.entries(config.paths);
    for (let j = 0; j < pathEntries.length; j += 1) {
      const [rawIndex, rawValue] = pathEntries[j];
      const index = Number(rawIndex);
      if (!Number.isInteger(index) || index < 0) continue;
      const rawUuid = normalizeUuidKey(rawUuidByIndex.get(index));
      if (!rawUuid) continue;
      const assetPath = Array.isArray(rawValue) ? String(rawValue[0] || "").trim() : "";
      if (!assetPath) continue;
      const list = map.get(rawUuid) || [];
      list.push(assetPath);
      map.set(rawUuid, list);
    }
  }
  return map;
}

function pickBestAssetPath(assetPaths) {
  const list = Array.isArray(assetPaths) ? assetPaths.filter(Boolean) : [];
  if (!list.length) return "";
  return [...list].sort((a, b) => scoreAssetPath(b) - scoreAssetPath(a) || a.length - b.length || a.localeCompare(b))[0];
}

function buildOutputName(state, preferredLabel, ext) {
  const normalizedLabel = String(preferredLabel || "").replace(/\.(png|jpg|jpeg|webp|gif)$/i, "");
  const base = sanitizeLabel(normalizedLabel) || `image_${state.nextIndex}`;
  const count = state.labelCounts.get(base) || 0;
  state.labelCounts.set(base, count + 1);
  if (count === 0) return `${base}${ext}`;
  return `${base}_${count + 1}${ext}`;
}

function resolveMiniappDir(options = {}) {
  if (options.miniappDir) {
    const direct = path.resolve(String(options.miniappDir));
    if (!isDirectory(direct)) {
      throw new Error(`QQ 小程序缓存目录不存在: ${direct}`);
    }
    return {
      miniappDir: direct,
      appId: options.appId ? String(options.appId) : null,
      resolvedBy: "miniapp_dir",
      discovery: null,
    };
  }

  const discovery = findLatestQqMiniappByAppId({
    appId: options.appId,
    srcRoot: options.srcRoot,
  });
  return {
    miniappDir: discovery.selected.dirPath,
    appId: discovery.appId,
    resolvedBy: "appid",
    discovery,
  };
}

function extractQqMiniappImages(options = {}) {
  const resolved = resolveMiniappDir(options);
  const miniappDir = resolved.miniappDir;
  const assetsRoot = path.join(miniappDir, "assets");
  const outputDir = path.resolve(options.outputDir || path.join(process.cwd(), "_miniapp_extracted_images"));
  ensureDir(outputDir);

  const uuidAssetPathMap = buildUuidAssetPathMap(assetsRoot);
  const imageFiles = walkFiles(miniappDir).filter((filePath) => /\.(png|jpg|jpeg|webp|gif)$/i.test(filePath));
  const state = { labelCounts: new Map(), nextIndex: 1, nextUuidIndex: 1 };
  const manifest = [];

  for (let i = 0; i < imageFiles.length; i += 1) {
    const sourcePath = imageFiles[i];
    const relPath = path.relative(miniappDir, sourcePath);
    const ext = path.extname(sourcePath).toLowerCase();
    const sourceName = path.basename(sourcePath);
    const nativeMatch = /^([0-9a-f-]+)\.([0-9a-f]+)\.(png|jpg|jpeg|webp|gif)$/i.exec(sourceName);
    const uuidRaw = nativeMatch ? nativeMatch[1] : "";
    const version = nativeMatch ? nativeMatch[2] : null;
    const uuidKey = uuidRaw ? uuidRaw.toLowerCase() : "";
    const assetPath = uuidKey ? pickBestAssetPath(uuidAssetPathMap.get(uuidKey)) : "";
    const isNativeAsset = /(^|[\\/])assets[\\/]resources[\\/]native([\\/]|$)/i.test(sourcePath);
    const preferredLabel = assetPath
      || (isNativeAsset ? `uuid_${state.nextUuidIndex}` : relPath);
    if (!assetPath && isNativeAsset) {
      state.nextUuidIndex += 1;
    }
    const outputName = buildOutputName(state, preferredLabel, ext);
    state.nextIndex += 1;
    const outputPath = path.join(outputDir, outputName);
    fs.copyFileSync(sourcePath, outputPath);
    manifest.push({
      label: path.basename(outputName, ext),
      source: sourcePath,
      output: outputPath,
      relativeSource: relPath.split(path.sep).join("/"),
      uuid: uuidKey || null,
      version,
      assetPath: assetPath || null,
    });
  }

  const manifestPath = path.join(outputDir, "manifest.json");
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), "utf8");

  return {
    ok: true,
    miniappDir,
    outputDir,
    count: manifest.length,
    manifestPath,
    appId: resolved.appId || null,
    resolvedBy: resolved.resolvedBy,
    discovery: resolved.discovery,
    files: manifest,
  };
}

module.exports = {
  extractQqMiniappImages,
  resolveMiniappDir,
};
