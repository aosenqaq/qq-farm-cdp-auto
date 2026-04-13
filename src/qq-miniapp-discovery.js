"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

function trimToString(value) {
  return String(value == null ? "" : value).trim();
}

function statSafe(targetPath) {
  try {
    return fs.statSync(targetPath);
  } catch (_) {
    return null;
  }
}

function isFile(targetPath) {
  const stat = statSafe(targetPath);
  return !!(stat && stat.isFile());
}

function isDirectory(targetPath) {
  const stat = statSafe(targetPath);
  return !!(stat && stat.isDirectory());
}

function toIsoTime(mtimeMs) {
  return Number.isFinite(mtimeMs) && mtimeMs > 0 ? new Date(mtimeMs).toISOString() : null;
}

function normalizeQqAppId(rawAppId) {
  const appId = trimToString(rawAppId);
  if (!appId) return "";
  if (!/^\d+$/.test(appId)) {
    throw new Error(`QQ appid 格式不正确: ${appId}`);
  }
  return appId;
}

function getDefaultAppDataRoot() {
  return process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
}

function getDefaultQqMiniappSrcRoot() {
  const appDataRoot = getDefaultAppDataRoot();
  const candidates = [
    path.join(appDataRoot, "QQ", "miniapp", "temps", "miniapp_src"),
    path.join(appDataRoot, "QQEX", "miniapp", "temps", "miniapp_src"),
  ];
  for (let i = 0; i < candidates.length; i += 1) {
    if (isDirectory(candidates[i])) {
      return candidates[i];
    }
  }
  return candidates[0];
}

function getDefaultQqMiniappSrcRootCandidates() {
  const appDataRoot = getDefaultAppDataRoot();
  const candidates = [
    path.join(appDataRoot, "QQ", "miniapp", "temps", "miniapp_src"),
    path.join(appDataRoot, "QQEX", "miniapp", "temps", "miniapp_src"),
  ].map((targetPath) => path.resolve(targetPath));
  return [...new Set(candidates)];
}

function getDefaultQqMiniappPkgRoot(srcRoot) {
  return path.join(path.dirname(path.resolve(srcRoot || getDefaultQqMiniappSrcRoot())), "miniapp_pkgs");
}

function resolveQqMiniappRoots(options = {}) {
  const srcRootRaw = trimToString(options.srcRoot) || getDefaultQqMiniappSrcRoot();
  const srcRoot = path.resolve(srcRootRaw);
  const pkgRoot = path.resolve(getDefaultQqMiniappPkgRoot(srcRoot));
  return {
    srcRoot,
    pkgRoot,
  };
}

function resolveQqMiniappRootCandidates(options = {}) {
  const explicitSrcRoot = trimToString(options.srcRoot);
  if (explicitSrcRoot) {
    return [resolveQqMiniappRoots({ srcRoot: explicitSrcRoot })];
  }
  return getDefaultQqMiniappSrcRootCandidates().map((srcRoot) => resolveQqMiniappRoots({ srcRoot }));
}

function collectPkgFiles(pkgRoot, versionPrefix) {
  if (!isDirectory(pkgRoot)) return [];
  return fs
    .readdirSync(pkgRoot, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.startsWith(versionPrefix))
    .map((entry) => {
      const filePath = path.join(pkgRoot, entry.name);
      const stat = statSafe(filePath);
      const mtimeMs = stat ? stat.mtimeMs : 0;
      return {
        name: entry.name,
        path: filePath,
        mtimeMs,
        mtimeAt: toIsoTime(mtimeMs),
      };
    })
    .sort((a, b) => (b.mtimeMs || 0) - (a.mtimeMs || 0) || String(a.name).localeCompare(String(b.name)));
}

function summarizeCandidate(candidate) {
  return {
    versionDirName: candidate.versionDirName,
    versionSegment: candidate.versionSegment,
    releaseHash: candidate.releaseHash,
    dirPath: candidate.dirPath,
    gameJsPath: candidate.gameJsPath,
    gameJsonPath: candidate.gameJsonPath,
    lastTouchedAt: candidate.lastTouchedAt,
    pkgMatchCount: candidate.pkgMatchCount,
    pkgMatches: candidate.pkgFiles,
  };
}

function buildCandidate(roots, entry) {
  const dirPath = path.join(roots.srcRoot, entry.name);
  const gameJsPath = path.join(dirPath, "game.js");
  const gameJsonPath = path.join(dirPath, "game.json");
  if (!isFile(gameJsPath) || !isFile(gameJsonPath)) return null;

  const dirStat = statSafe(dirPath);
  const gameJsStat = statSafe(gameJsPath);
  const gameJsonStat = statSafe(gameJsonPath);
  const pkgFiles = collectPkgFiles(roots.pkgRoot, entry.name);
  const pkgLatestMs = pkgFiles.length ? Math.max(...pkgFiles.map((item) => item.mtimeMs || 0)) : 0;
  const lastTouchedMs = Math.max(
    dirStat ? dirStat.mtimeMs : 0,
    gameJsStat ? gameJsStat.mtimeMs : 0,
    gameJsonStat ? gameJsonStat.mtimeMs : 0,
    pkgLatestMs,
  );
  const parts = entry.name.split("_");

  return {
    versionDirName: entry.name,
    versionSegment: parts[1] || null,
    releaseHash: parts.length >= 3 ? parts.slice(2).join("_") : null,
    dirPath,
    gameJsPath,
    gameJsonPath,
    pkgFiles,
    pkgMatchCount: pkgFiles.length,
    lastTouchedMs,
    lastTouchedAt: toIsoTime(lastTouchedMs),
  };
}

function compareCandidates(a, b) {
  const timeDiff = (b.lastTouchedMs || 0) - (a.lastTouchedMs || 0);
  if (timeDiff !== 0) return timeDiff;
  const pkgDiff = (b.pkgMatchCount || 0) - (a.pkgMatchCount || 0);
  if (pkgDiff !== 0) return pkgDiff;
  return String(a.versionDirName).localeCompare(String(b.versionDirName));
}

function findLatestQqMiniappByAppId(options = {}) {
  const appId = normalizeQqAppId(options.appId);
  if (!appId) {
    throw new Error("缺少 QQ appid");
  }

  const rootCandidates = resolveQqMiniappRootCandidates(options);
  const existingRoots = rootCandidates.filter((roots) => isDirectory(roots.srcRoot));
  if (!existingRoots.length) {
    const expected = rootCandidates[0] || resolveQqMiniappRoots(options);
    throw new Error(`QQ miniapp_src 目录不存在: ${expected.srcRoot}`);
  }

  const candidates = existingRoots
    .flatMap((roots) =>
      fs
        .readdirSync(roots.srcRoot, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && entry.name.startsWith(appId + "_"))
        .map((entry) => buildCandidate(roots, entry))
        .filter(Boolean)
    )
    .sort(compareCandidates);

  if (!candidates.length) {
    throw new Error(`未找到 appid=${appId} 的可用 QQ 小程序目录`);
  }

  const selected = candidates[0];
  return {
    appId,
    srcRoot: selected ? path.dirname(selected.dirPath) : null,
    pkgRoot: selected && isDirectory(path.dirname(selected.dirPath).replace(/miniapp_src$/i, "miniapp_pkgs"))
      ? path.dirname(selected.dirPath).replace(/miniapp_src$/i, "miniapp_pkgs")
      : null,
    candidateCount: candidates.length,
    candidateGameJsPaths: candidates.map((item) => item.gameJsPath),
    selected: summarizeCandidate(selected),
    candidates: candidates.slice(0, 8).map(summarizeCandidate),
  };
}

module.exports = {
  findLatestQqMiniappByAppId,
  getDefaultQqMiniappPkgRoot,
  getDefaultQqMiniappSrcRoot,
  getDefaultQqMiniappSrcRootCandidates,
  normalizeQqAppId,
  resolveQqMiniappRoots,
  resolveQqMiniappRootCandidates,
};
