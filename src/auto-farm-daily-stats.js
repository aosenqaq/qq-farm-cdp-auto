"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const { toLocalDateKey } = require("./friend-help-exp-cache");

const AUTO_FARM_DAILY_STATS_VERSION = 2;
const AUTO_FARM_DAILY_STATS_RETENTION_DAYS = 30;
const AUTO_FARM_DAILY_STATS_COUNTER_KEYS = [
  "collect",
  "water",
  "eraseGrass",
  "killBug",
  "fertilize",
  "plant",
  "steal",
  "helpWater",
  "helpEraseGrass",
  "helpKillBug",
  "task",
  "sell",
  "sellGold",
  "runs",
  "ownRuns",
  "friendRuns",
];

function resolveProjectRoot(projectRoot) {
  return projectRoot || path.join(__dirname, "..");
}

function getAutoFarmDailyStatsDir(projectRoot) {
  return path.join(resolveProjectRoot(projectRoot), "data", "account-stats", "auto-farm-daily");
}

function isValidDateKey(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || "").trim());
}

function clampRetentionDays(value) {
  const days = Math.floor(Number(value));
  return Number.isFinite(days) && days > 0 ? days : AUTO_FARM_DAILY_STATS_RETENTION_DAYS;
}

function toSafeCount(value) {
  const count = Math.floor(Number(value));
  return Number.isFinite(count) && count > 0 ? count : 0;
}

function createEmptyAutoFarmDailyStats(dateKey) {
  const resolvedDateKey = isValidDateKey(dateKey) ? String(dateKey).trim() : (toLocalDateKey() || null);
  const state = {
    version: AUTO_FARM_DAILY_STATS_VERSION,
    updatedAt: null,
    dateKey: resolvedDateKey,
  };
  AUTO_FARM_DAILY_STATS_COUNTER_KEYS.forEach((key) => {
    state[key] = 0;
  });
  return state;
}

function normalizeAutoFarmDailyStats(raw, now, fallbackDateKey) {
  const source = raw && typeof raw === "object" ? raw : {};
  const sourceDateKey = isValidDateKey(source.dateKey) ? String(source.dateKey).trim() : null;
  const defaultDateKey = isValidDateKey(fallbackDateKey)
    ? String(fallbackDateKey).trim()
    : (toLocalDateKey(now) || toLocalDateKey() || null);
  const state = createEmptyAutoFarmDailyStats(sourceDateKey || defaultDateKey);
  state.updatedAt = source.updatedAt ? String(source.updatedAt) : null;
  AUTO_FARM_DAILY_STATS_COUNTER_KEYS.forEach((key) => {
    state[key] = toSafeCount(source[key]);
  });
  return state;
}

function serializeAutoFarmDailyStats(state, now, fallbackDateKey) {
  const normalized = normalizeAutoFarmDailyStats(state, now, fallbackDateKey);
  const serialized = {
    version: normalized.version,
    updatedAt: normalized.updatedAt,
    dateKey: normalized.dateKey,
  };
  AUTO_FARM_DAILY_STATS_COUNTER_KEYS.forEach((key) => {
    serialized[key] = normalized[key];
  });
  return serialized;
}

async function ensureAutoFarmDailyStatsDir(projectRoot) {
  const dirPath = getAutoFarmDailyStatsDir(projectRoot);
  await fs.mkdir(dirPath, { recursive: true });
  return dirPath;
}

function getAutoFarmDailyStatsFilePath(projectRoot, dateKey) {
  const resolvedDateKey = isValidDateKey(dateKey) ? String(dateKey).trim() : (toLocalDateKey() || "unknown-date");
  return path.join(getAutoFarmDailyStatsDir(projectRoot), `${resolvedDateKey}.json`);
}

async function listAutoFarmDailyStatsDateKeys(projectRoot) {
  const dirPath = await ensureAutoFarmDailyStatsDir(projectRoot);
  let entries = [];
  try {
    entries = await fs.readdir(dirPath, { withFileTypes: true });
  } catch (_) {
    return [];
  }
  return entries
    .filter((entry) => entry && entry.isFile && entry.isFile())
    .map((entry) => path.basename(entry.name || "", ".json"))
    .filter((dateKey) => isValidDateKey(dateKey))
    .sort((a, b) => b.localeCompare(a));
}

async function pruneAutoFarmDailyStats(projectRoot, opts) {
  const options = opts && typeof opts === "object" ? opts : {};
  const retentionDays = clampRetentionDays(options.retentionDays);
  const keepDateKeys = new Set(
    Array.isArray(options.keepDateKeys)
      ? options.keepDateKeys.filter((item) => isValidDateKey(item)).map((item) => String(item).trim())
      : []
  );
  const dateKeys = await listAutoFarmDailyStatsDateKeys(projectRoot);
  const removable = [];
  let kept = 0;
  for (let i = 0; i < dateKeys.length; i += 1) {
    const dateKey = dateKeys[i];
    if (keepDateKeys.has(dateKey)) {
      kept += 1;
      continue;
    }
    if (kept < retentionDays) {
      kept += 1;
      continue;
    }
    removable.push(dateKey);
  }
  await Promise.all(removable.map((dateKey) => fs.rm(getAutoFarmDailyStatsFilePath(projectRoot, dateKey), { force: true })));
  return removable;
}

async function readAutoFarmDailyStats(projectRoot, dateKey, opts) {
  const options = opts && typeof opts === "object" ? opts : {};
  const resolvedDateKey = isValidDateKey(dateKey)
    ? String(dateKey).trim()
    : (toLocalDateKey(options.now) || toLocalDateKey() || null);
  const filePath = getAutoFarmDailyStatsFilePath(projectRoot, resolvedDateKey);
  const createIfMissing = options.createIfMissing !== false;
  try {
    const raw = await fs.readFile(filePath, "utf8");
    const parsed = JSON.parse(raw);
    const normalized = normalizeAutoFarmDailyStats(parsed, options.now, resolvedDateKey);
    const normalizedText = JSON.stringify(serializeAutoFarmDailyStats(normalized, options.now, resolvedDateKey), null, 2);
    if (raw.trim() !== normalizedText.trim()) {
      await fs.writeFile(filePath, normalizedText, "utf8");
    }
    return {
      path: filePath,
      state: normalized,
    };
  } catch (error) {
    if (!createIfMissing) {
      return {
        path: filePath,
        state: null,
      };
    }
    const empty = createEmptyAutoFarmDailyStats(resolvedDateKey);
    await ensureAutoFarmDailyStatsDir(projectRoot);
    await fs.writeFile(filePath, JSON.stringify(serializeAutoFarmDailyStats(empty, options.now, resolvedDateKey), null, 2), "utf8");
    return {
      path: filePath,
      state: empty,
    };
  }
}

async function writeAutoFarmDailyStats(projectRoot, state, opts) {
  const options = opts && typeof opts === "object" ? opts : {};
  const retentionDays = clampRetentionDays(options.retentionDays);
  const normalized = normalizeAutoFarmDailyStats(state, options.now);
  normalized.updatedAt = new Date(options.now || Date.now()).toISOString();
  const filePath = getAutoFarmDailyStatsFilePath(projectRoot, normalized.dateKey);
  await ensureAutoFarmDailyStatsDir(projectRoot);
  await fs.writeFile(filePath, JSON.stringify(serializeAutoFarmDailyStats(normalized, options.now, normalized.dateKey), null, 2), "utf8");
  await pruneAutoFarmDailyStats(projectRoot, {
    retentionDays,
    keepDateKeys: [normalized.dateKey],
  });
  return normalized;
}

async function readRecentAutoFarmDailyStats(projectRoot, opts) {
  const options = opts && typeof opts === "object" ? opts : {};
  const retentionDays = clampRetentionDays(options.retentionDays);
  const createToday = options.createToday !== false;
  const dirPath = await ensureAutoFarmDailyStatsDir(projectRoot);
  const dateKeys = await listAutoFarmDailyStatsDateKeys(projectRoot);
  const keepDateKeys = dateKeys.slice(0, retentionDays);
  const removable = dateKeys.slice(retentionDays);
  await Promise.all(removable.map((dateKey) => fs.rm(getAutoFarmDailyStatsFilePath(projectRoot, dateKey), { force: true })));

  const days = [];
  for (let i = 0; i < keepDateKeys.length; i += 1) {
    const dateKey = keepDateKeys[i];
    const entry = await readAutoFarmDailyStats(projectRoot, dateKey, {
      now: options.now,
      createIfMissing: true,
    });
    if (entry && entry.state) {
      days.push(entry.state);
    }
  }

  const todayKey = toLocalDateKey(options.now) || toLocalDateKey() || null;
  if (createToday && todayKey && !days.some((item) => item && item.dateKey === todayKey)) {
    const entry = await readAutoFarmDailyStats(projectRoot, todayKey, {
      now: options.now,
      createIfMissing: true,
    });
    if (entry && entry.state) {
      days.push(entry.state);
    }
  }

  days.sort((a, b) => String(b && b.dateKey || "").localeCompare(String(a && a.dateKey || "")));
  const trimmed = days.slice(0, retentionDays).map((item) => serializeAutoFarmDailyStats(item, options.now, item && item.dateKey));
  await pruneAutoFarmDailyStats(projectRoot, {
    retentionDays,
    keepDateKeys: trimmed.map((item) => item.dateKey),
  });

  return {
    dir: dirPath,
    retentionDays,
    days: trimmed,
  };
}

module.exports = {
  AUTO_FARM_DAILY_STATS_COUNTER_KEYS,
  AUTO_FARM_DAILY_STATS_RETENTION_DAYS,
  AUTO_FARM_DAILY_STATS_VERSION,
  createEmptyAutoFarmDailyStats,
  ensureAutoFarmDailyStatsDir,
  getAutoFarmDailyStatsDir,
  getAutoFarmDailyStatsFilePath,
  normalizeAutoFarmDailyStats,
  pruneAutoFarmDailyStats,
  readAutoFarmDailyStats,
  readRecentAutoFarmDailyStats,
  serializeAutoFarmDailyStats,
  writeAutoFarmDailyStats,
};
