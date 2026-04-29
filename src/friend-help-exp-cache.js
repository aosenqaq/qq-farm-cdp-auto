"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");

const FRIEND_HELP_LIMIT_CACHE_VERSION = 3;
const FRIEND_HELP_DAILY_LIMIT = 30;
const FRIEND_HELP_UTC_OFFSET_MS = 8 * 60 * 60 * 1000;

function resolveProjectRoot(projectRoot) {
  return projectRoot || path.join(__dirname, "..");
}

function getFriendHelpCachePath(projectRoot) {
  return path.join(resolveProjectRoot(projectRoot), "data", "friend-help-exp-cache.json");
}

function toLocalDateKey(value) {
  const date = value instanceof Date ? value : new Date(value || Date.now());
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return null;
  const utc8Date = new Date(date.getTime() + FRIEND_HELP_UTC_OFFSET_MS);
  const year = utc8Date.getUTCFullYear();
  const month = String(utc8Date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(utc8Date.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function resolveFriendHelpDailyLimit(value) {
  const limit = Math.floor(Number(value));
  return Number.isFinite(limit) && limit > 0 ? limit : FRIEND_HELP_DAILY_LIMIT;
}

function buildEmptyFriendHelpState(now, dailyLimit) {
  return {
    version: FRIEND_HELP_LIMIT_CACHE_VERSION,
    updatedAt: null,
    dateKey: toLocalDateKey(now),
    helpCount: 0,
    dailyLimit: resolveFriendHelpDailyLimit(dailyLimit),
    limitReached: false,
    limitReachedAt: null,
    lastHelpAt: null,
    lastFriendGid: null,
  };
}

function normalizeFriendHelpState(raw, now, dailyLimit) {
  const todayKey = toLocalDateKey(now);
  const source = raw && typeof raw === "object" ? raw : {};
  const sourceDateKey = typeof source.dateKey === "string" ? source.dateKey.trim() : null;
  const sameDay = !!(todayKey && sourceDateKey && todayKey === sourceDateKey);
  const state = buildEmptyFriendHelpState(now, dailyLimit != null ? dailyLimit : source.dailyLimit);
  state.dateKey = todayKey || sourceDateKey || state.dateKey;
  if (!sameDay) {
    return state;
  }
  state.updatedAt = source.updatedAt ? String(source.updatedAt) : null;
  state.helpCount = Math.max(0, Math.floor(Number(source.helpCount) || 0));
  state.dailyLimit = resolveFriendHelpDailyLimit(dailyLimit != null ? dailyLimit : source.dailyLimit);
  state.limitReached = state.helpCount >= state.dailyLimit;
  state.limitReachedAt = source.limitReachedAt ? String(source.limitReachedAt) : null;
  state.lastHelpAt = source.lastHelpAt ? String(source.lastHelpAt) : null;
  const lastFriendGid = Number(source.lastFriendGid);
  state.lastFriendGid = Number.isFinite(lastFriendGid) && lastFriendGid > 0 ? lastFriendGid : null;
  if (state.limitReached && !state.limitReachedAt) {
    state.limitReachedAt = state.updatedAt || state.lastHelpAt || null;
  }
  if (!state.limitReached) {
    state.limitReachedAt = null;
  }
  return state;
}

function serializeFriendHelpState(state, now, dailyLimit) {
  const normalized = normalizeFriendHelpState(state, now, dailyLimit);
  return {
    version: normalized.version,
    updatedAt: normalized.updatedAt,
    dateKey: normalized.dateKey,
    helpCount: normalized.helpCount,
    dailyLimit: normalized.dailyLimit,
    limitReached: normalized.limitReached,
    limitReachedAt: normalized.limitReachedAt,
    lastHelpAt: normalized.lastHelpAt,
    lastFriendGid: normalized.lastFriendGid,
  };
}

function syncMutableFriendHelpState(target, now, dailyLimit) {
  const normalized = normalizeFriendHelpState(target, now, dailyLimit);
  if (!target || typeof target !== "object") {
    return normalized;
  }
  Object.keys(target).forEach((key) => {
    delete target[key];
  });
  Object.assign(target, normalized);
  return target;
}

function isFriendHelpLimitReached(state, dailyLimit) {
  return normalizeFriendHelpState(state, null, dailyLimit).limitReached === true;
}

function recordFriendHelpRound(state, opts) {
  const options = opts && typeof opts === "object" ? opts : {};
  const at = options.at || Date.now();
  const target = syncMutableFriendHelpState(state, at, options.dailyLimit);
  target.updatedAt = new Date(at).toISOString();
  if (target.limitReached) {
    return {
      state: target,
      helpCount: target.helpCount,
      dailyLimit: target.dailyLimit,
      remainingCount: 0,
      limitReached: true,
      skipped: true,
    };
  }
  const friendGid = Number(options.friendGid);
  if (Number.isFinite(friendGid) && friendGid > 0) {
    target.lastFriendGid = friendGid;
  }
  target.helpCount += 1;
  target.lastHelpAt = target.updatedAt;
  target.limitReached = target.helpCount >= target.dailyLimit;
  target.limitReachedAt = target.limitReached ? target.updatedAt : null;
  return {
    state: target,
    helpCount: target.helpCount,
    dailyLimit: target.dailyLimit,
    remainingCount: Math.max(0, target.dailyLimit - target.helpCount),
    limitReached: target.limitReached,
    skipped: false,
  };
}

async function ensureFriendHelpCacheFile(projectRoot) {
  const cachePath = getFriendHelpCachePath(projectRoot);
  await fs.mkdir(path.dirname(cachePath), { recursive: true });
  try {
    await fs.access(cachePath);
  } catch (_) {
    await fs.writeFile(cachePath, JSON.stringify(buildEmptyFriendHelpState(), null, 2), "utf8");
  }
  return cachePath;
}

async function readFriendHelpCache(projectRoot, now, dailyLimit) {
  const cachePath = await ensureFriendHelpCacheFile(projectRoot);
  let parsed = buildEmptyFriendHelpState(now, dailyLimit);
  try {
    const raw = await fs.readFile(cachePath, "utf8");
    const next = JSON.parse(raw);
    parsed = normalizeFriendHelpState(next, now, dailyLimit);
    const normalizedText = JSON.stringify(serializeFriendHelpState(parsed, now, dailyLimit), null, 2);
    if (raw.trim() !== normalizedText.trim()) {
      await fs.writeFile(cachePath, normalizedText, "utf8");
    }
  } catch (_) {
    parsed = buildEmptyFriendHelpState(now, dailyLimit);
    await fs.writeFile(cachePath, JSON.stringify(parsed, null, 2), "utf8");
  }
  return {
    path: cachePath,
    state: parsed,
  };
}

async function writeFriendHelpCache(projectRoot, state, now, dailyLimit) {
  const cachePath = await ensureFriendHelpCacheFile(projectRoot);
  const normalized = normalizeFriendHelpState(state, now, dailyLimit);
  normalized.updatedAt = new Date(now || Date.now()).toISOString();
  await fs.writeFile(cachePath, JSON.stringify(serializeFriendHelpState(normalized, now, dailyLimit), null, 2), "utf8");
  return normalized;
}

module.exports = {
  FRIEND_HELP_DAILY_LIMIT,
  FRIEND_HELP_LIMIT_CACHE_VERSION,
  buildEmptyFriendHelpState,
  ensureFriendHelpCacheFile,
  getFriendHelpCachePath,
  isFriendHelpLimitReached,
  normalizeFriendHelpState,
  readFriendHelpCache,
  recordFriendHelpRound,
  resolveFriendHelpDailyLimit,
  serializeFriendHelpState,
  syncMutableFriendHelpState,
  toLocalDateKey,
  writeFriendHelpCache,
};
