"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");

const FRIEND_HELP_EXP_CACHE_VERSION = 1;
const FRIEND_HELP_EXP_DAILY_LIMIT = 1500;

function resolveProjectRoot(projectRoot) {
  return projectRoot || path.join(__dirname, "..");
}

function getFriendHelpExpCachePath(projectRoot) {
  return path.join(resolveProjectRoot(projectRoot), "data", "friend-help-exp-cache.json");
}

function toLocalDateKey(value) {
  const date = value instanceof Date ? value : new Date(value || Date.now());
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return null;
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function resolveFriendHelpExpLimit(value) {
  const limit = Math.floor(Number(value));
  return Number.isFinite(limit) && limit > 0 ? limit : FRIEND_HELP_EXP_DAILY_LIMIT;
}

function buildEmptyFriendHelpExpState(now) {
  return {
    version: FRIEND_HELP_EXP_CACHE_VERSION,
    updatedAt: null,
    dateKey: toLocalDateKey(now),
    dailyLimit: FRIEND_HELP_EXP_DAILY_LIMIT,
    earnedExp: 0,
    lastDelta: 0,
    lastAwardAt: null,
    lastFriendGid: null,
  };
}

function normalizeFriendHelpExpState(raw, now) {
  const todayKey = toLocalDateKey(now);
  const source = raw && typeof raw === "object" ? raw : {};
  const sourceDateKey = typeof source.dateKey === "string" ? source.dateKey.trim() : null;
  const sameDay = !!(todayKey && sourceDateKey && todayKey === sourceDateKey);
  const state = buildEmptyFriendHelpExpState(now);
  state.dateKey = todayKey || sourceDateKey || state.dateKey;
  state.dailyLimit = resolveFriendHelpExpLimit(source.dailyLimit);
  if (!sameDay) {
    return state;
  }
  state.updatedAt = source.updatedAt ? String(source.updatedAt) : null;
  state.earnedExp = Math.max(0, Math.floor(Number(source.earnedExp) || 0));
  state.lastDelta = Math.max(0, Math.floor(Number(source.lastDelta) || 0));
  state.lastAwardAt = source.lastAwardAt ? String(source.lastAwardAt) : null;
  const lastFriendGid = Number(source.lastFriendGid);
  state.lastFriendGid = Number.isFinite(lastFriendGid) && lastFriendGid > 0 ? lastFriendGid : null;
  return state;
}

function serializeFriendHelpExpState(state, now) {
  const normalized = normalizeFriendHelpExpState(state, now);
  return {
    version: normalized.version,
    updatedAt: normalized.updatedAt,
    dateKey: normalized.dateKey,
    dailyLimit: normalized.dailyLimit,
    earnedExp: normalized.earnedExp,
    lastDelta: normalized.lastDelta,
    lastAwardAt: normalized.lastAwardAt,
    lastFriendGid: normalized.lastFriendGid,
  };
}

function syncMutableFriendHelpExpState(target, now) {
  const normalized = normalizeFriendHelpExpState(target, now);
  if (!target || typeof target !== "object") {
    return normalized;
  }
  Object.keys(target).forEach((key) => {
    delete target[key];
  });
  Object.assign(target, normalized);
  return target;
}

function isFriendHelpExpLimitReached(state, limit) {
  const dailyLimit = resolveFriendHelpExpLimit(limit != null ? limit : (state && state.dailyLimit));
  return (Math.max(0, Math.floor(Number(state && state.earnedExp) || 0))) >= dailyLimit;
}

function addFriendHelpExp(state, delta, opts) {
  const options = opts && typeof opts === "object" ? opts : {};
  const at = options.at || Date.now();
  const target = syncMutableFriendHelpExpState(state, at);
  const requested = Math.max(0, Math.floor(Number(delta) || 0));
  const dailyLimit = resolveFriendHelpExpLimit(options.dailyLimit != null ? options.dailyLimit : target.dailyLimit);
  target.dailyLimit = dailyLimit;
  if (requested <= 0) {
    target.lastDelta = 0;
    return {
      state: target,
      requested,
      applied: 0,
      earnedExp: target.earnedExp,
      remainingExp: Math.max(0, dailyLimit - target.earnedExp),
      limitReached: isFriendHelpExpLimitReached(target, dailyLimit),
    };
  }
  const remainingBefore = Math.max(0, dailyLimit - target.earnedExp);
  const applied = Math.min(remainingBefore, requested);
  target.earnedExp += applied;
  target.lastDelta = applied;
  target.updatedAt = new Date(at).toISOString();
  if (applied > 0) {
    target.lastAwardAt = target.updatedAt;
    const friendGid = Number(options.friendGid);
    if (Number.isFinite(friendGid) && friendGid > 0) {
      target.lastFriendGid = friendGid;
    }
  }
  return {
    state: target,
    requested,
    applied,
    earnedExp: target.earnedExp,
    remainingExp: Math.max(0, dailyLimit - target.earnedExp),
    limitReached: isFriendHelpExpLimitReached(target, dailyLimit),
  };
}

function markFriendHelpExpLimitReached(state, opts) {
  const options = opts && typeof opts === "object" ? opts : {};
  const at = options.at || Date.now();
  const target = syncMutableFriendHelpExpState(state, at);
  const dailyLimit = resolveFriendHelpExpLimit(options.dailyLimit != null ? options.dailyLimit : target.dailyLimit);
  target.dailyLimit = dailyLimit;
  target.earnedExp = dailyLimit;
  target.lastDelta = 0;
  target.updatedAt = new Date(at).toISOString();
  const friendGid = Number(options.friendGid);
  if (Number.isFinite(friendGid) && friendGid > 0) {
    target.lastFriendGid = friendGid;
  }
  return {
    state: target,
    requested: 0,
    applied: 0,
    earnedExp: target.earnedExp,
    remainingExp: 0,
    limitReached: true,
    marked: true,
  };
}

async function ensureFriendHelpExpCacheFile(projectRoot) {
  const cachePath = getFriendHelpExpCachePath(projectRoot);
  await fs.mkdir(path.dirname(cachePath), { recursive: true });
  try {
    await fs.access(cachePath);
  } catch (_) {
    await fs.writeFile(cachePath, JSON.stringify(buildEmptyFriendHelpExpState(), null, 2), "utf8");
  }
  return cachePath;
}

async function readFriendHelpExpCache(projectRoot, now) {
  const cachePath = await ensureFriendHelpExpCacheFile(projectRoot);
  let parsed = buildEmptyFriendHelpExpState(now);
  try {
    const raw = await fs.readFile(cachePath, "utf8");
    const next = JSON.parse(raw);
    parsed = normalizeFriendHelpExpState(next, now);
    const normalizedText = JSON.stringify(serializeFriendHelpExpState(parsed, now), null, 2);
    if (raw.trim() !== normalizedText.trim()) {
      await fs.writeFile(cachePath, normalizedText, "utf8");
    }
  } catch (_) {
    parsed = buildEmptyFriendHelpExpState(now);
    await fs.writeFile(cachePath, JSON.stringify(parsed, null, 2), "utf8");
  }
  return {
    path: cachePath,
    state: parsed,
  };
}

async function writeFriendHelpExpCache(projectRoot, state, now) {
  const cachePath = await ensureFriendHelpExpCacheFile(projectRoot);
  const normalized = normalizeFriendHelpExpState(state, now);
  normalized.updatedAt = new Date(now || Date.now()).toISOString();
  await fs.writeFile(cachePath, JSON.stringify(serializeFriendHelpExpState(normalized, now), null, 2), "utf8");
  return normalized;
}

module.exports = {
  FRIEND_HELP_EXP_CACHE_VERSION,
  FRIEND_HELP_EXP_DAILY_LIMIT,
  addFriendHelpExp,
  buildEmptyFriendHelpExpState,
  ensureFriendHelpExpCacheFile,
  getFriendHelpExpCachePath,
  isFriendHelpExpLimitReached,
  markFriendHelpExpLimitReached,
  normalizeFriendHelpExpState,
  readFriendHelpExpCache,
  resolveFriendHelpExpLimit,
  serializeFriendHelpExpState,
  syncMutableFriendHelpExpState,
  writeFriendHelpExpCache,
};
