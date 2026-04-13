"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const { getProfilePlantLevel, normalizeProfile } = require("./player-profile-resolver");

const PLAYER_PROFILE_CACHE_VERSION = 1;
const PLAYER_PROFILE_CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

function resolveProjectRoot(projectRoot) {
  return projectRoot || path.join(__dirname, "..");
}

function getPlayerProfileCachePath(projectRoot) {
  return path.join(resolveProjectRoot(projectRoot), "data", "player-profile-cache.json");
}

function buildEmptyCacheRecord() {
  return {
    version: PLAYER_PROFILE_CACHE_VERSION,
    updatedAt: null,
    expiresAt: null,
    dateKey: null,
    profile: null,
  };
}

function toDateKey(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return null;
  return date.toISOString().slice(0, 10);
}

function hasProfileIdentity(profile) {
  const normalized = normalizeProfile(profile);
  return Boolean(
    (Number(normalized.gid) || 0) > 0 ||
    (Number(normalized.playerId) || 0) > 0 ||
    (typeof normalized.name === "string" && normalized.name.trim())
  );
}

function isProfileCacheUsable(profile) {
  return hasProfileIdentity(profile) && getProfilePlantLevel(profile) > 0;
}

function sanitizeLevelProgress(value) {
  const progress = value && typeof value === "object" ? value : null;
  if (!progress) return null;
  const out = {};
  const level = Number(progress.level);
  const current = Number(progress.current);
  const needed = Number(progress.needed);
  const remaining = Number(progress.remaining);
  const percent = Number(progress.percent);
  const nextLevel = Number(progress.nextLevel);
  const totalExp = Number(progress.totalExp);
  const rawExp = Number(progress.rawExp);
  const currentFloor = Number(progress.currentFloor);
  const nextLevelTotalExp = Number(progress.nextLevelTotalExp);
  const expMode = String(progress.expMode || "").trim();
  if (Number.isFinite(level) && level > 0) out.level = level;
  if (Number.isFinite(current) && current >= 0) out.current = current;
  if (Number.isFinite(needed) && needed > 0) out.needed = needed;
  if (Number.isFinite(remaining) && remaining >= 0) out.remaining = remaining;
  if (Number.isFinite(percent) && percent >= 0) out.percent = percent;
  if (Number.isFinite(nextLevel) && nextLevel > 0) out.nextLevel = nextLevel;
  if (Number.isFinite(totalExp) && totalExp >= 0) out.totalExp = totalExp;
  if (Number.isFinite(rawExp) && rawExp >= 0) out.rawExp = rawExp;
  if (Number.isFinite(currentFloor) && currentFloor >= 0) out.currentFloor = currentFloor;
  if (Number.isFinite(nextLevelTotalExp) && nextLevelTotalExp > 0) out.nextLevelTotalExp = nextLevelTotalExp;
  if (expMode) out.expMode = expMode;
  return Object.keys(out).length > 0 ? out : null;
}

function normalizeProfileForCache(profile) {
  const normalized = normalizeProfile(profile);
  if (!isProfileCacheUsable(normalized)) return null;
  const cached = { ...normalized };
  const totalExp = Number(profile && profile.totalExp);
  if (Number.isFinite(totalExp) && totalExp >= 0) {
    cached.totalExp = totalExp;
  }
  const expMode = String(profile && profile.expMode || "").trim();
  if (expMode) {
    cached.expMode = expMode;
  }
  const levelProgress = sanitizeLevelProgress(profile && profile.levelProgress);
  if (levelProgress) {
    cached.levelProgress = levelProgress;
  }
  return cached;
}

function profilesMatchIdentity(left, right) {
  const a = normalizeProfile(left);
  const b = normalizeProfile(right);
  if ((Number(a.gid) || 0) > 0 && (Number(b.gid) || 0) > 0) {
    return Number(a.gid) === Number(b.gid);
  }
  if ((Number(a.playerId) || 0) > 0 && (Number(b.playerId) || 0) > 0) {
    return Number(a.playerId) === Number(b.playerId);
  }
  if (a.name && b.name) {
    return String(a.name).trim() === String(b.name).trim();
  }
  return true;
}

function pickPositiveNumber(overlayValue, baseValue) {
  const overlayNum = Number(overlayValue);
  if (Number.isFinite(overlayNum) && overlayNum > 0) return overlayNum;
  const baseNum = Number(baseValue);
  if (Number.isFinite(baseNum) && baseNum > 0) return baseNum;
  if (overlayValue != null && baseValue == null && Number.isFinite(overlayNum)) return overlayNum;
  return baseValue != null ? baseValue : (overlayValue != null ? overlayValue : null);
}

function mergeProfileWithFallback(baseProfile, overlayProfile) {
  const base = normalizeProfile(baseProfile);
  const overlay = normalizeProfile(overlayProfile);
  const plantLevel = Math.max(
    getProfilePlantLevel(base),
    getProfilePlantLevel(overlay),
  );
  return {
    gid: pickPositiveNumber(overlay.gid, base.gid),
    name: overlay.name || base.name || null,
    level: pickPositiveNumber(overlay.level, base.level),
    plantLevel: plantLevel > 0 ? plantLevel : null,
    farmMaxLandLevel: pickPositiveNumber(overlay.farmMaxLandLevel, base.farmMaxLandLevel),
    exp: pickPositiveNumber(overlay.exp, base.exp),
    nextLevelExp: pickPositiveNumber(overlay.nextLevelExp, base.nextLevelExp),
    playerId: pickPositiveNumber(overlay.playerId, base.playerId),
    gold: pickPositiveNumber(overlay.gold, base.gold),
    coupon: pickPositiveNumber(overlay.coupon, base.coupon),
    diamond: pickPositiveNumber(overlay.diamond, base.diamond),
    bean: pickPositiveNumber(overlay.bean, base.bean),
  };
}

async function ensurePlayerProfileCacheFile(projectRoot) {
  const cachePath = getPlayerProfileCachePath(projectRoot);
  await fs.mkdir(path.dirname(cachePath), { recursive: true });
  try {
    await fs.access(cachePath);
  } catch (_) {
    await fs.writeFile(cachePath, JSON.stringify(buildEmptyCacheRecord(), null, 2), "utf8");
  }
  return cachePath;
}

async function readPlayerProfileCache(projectRoot, opts) {
  const options = opts && typeof opts === "object" ? opts : {};
  const maxAgeMs = Number(options.maxAgeMs) > 0 ? Number(options.maxAgeMs) : PLAYER_PROFILE_CACHE_MAX_AGE_MS;
  const cachePath = await ensurePlayerProfileCacheFile(projectRoot);
  let parsed = buildEmptyCacheRecord();
  try {
    const raw = await fs.readFile(cachePath, "utf8");
    const next = JSON.parse(raw);
    if (next && typeof next === "object") {
      parsed = { ...parsed, ...next };
    }
  } catch (_) {
    await fs.writeFile(cachePath, JSON.stringify(parsed, null, 2), "utf8");
  }

  const normalizedProfile = normalizeProfileForCache(parsed.profile);
  const updatedAtMs = parsed.updatedAt ? new Date(parsed.updatedAt).getTime() : NaN;
  const fresh = Number.isFinite(updatedAtMs) && (Date.now() - updatedAtMs) <= maxAgeMs;
  return {
    path: cachePath,
    updatedAt: parsed.updatedAt || null,
    expiresAt: parsed.expiresAt || null,
    dateKey: parsed.dateKey || null,
    profile: normalizedProfile,
    fresh,
    usableProfile: fresh ? normalizedProfile : null,
  };
}

async function writePlayerProfileCache(projectRoot, profile) {
  const normalizedProfile = normalizeProfileForCache(profile);
  const cachePath = await ensurePlayerProfileCacheFile(projectRoot);
  if (!normalizedProfile) {
    return null;
  }
  const now = new Date();
  const record = {
    version: PLAYER_PROFILE_CACHE_VERSION,
    updatedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + PLAYER_PROFILE_CACHE_MAX_AGE_MS).toISOString(),
    dateKey: toDateKey(now),
    profile: normalizedProfile,
  };
  await fs.writeFile(cachePath, JSON.stringify(record, null, 2), "utf8");
  return record;
}

module.exports = {
  PLAYER_PROFILE_CACHE_MAX_AGE_MS,
  ensurePlayerProfileCacheFile,
  getPlayerProfileCachePath,
  isProfileCacheUsable,
  normalizeProfileForCache,
  profilesMatchIdentity,
  readPlayerProfileCache,
  mergeProfileWithFallback,
  writePlayerProfileCache,
};
