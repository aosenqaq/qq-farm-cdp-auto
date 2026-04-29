"use strict";

const { ensureGameCtl, callGameCtl } = require("./game-ctl-utils");
const { runAutoFarmCycle } = require("./auto-farm-executor");
const {
  recordFriendHelpRound,
  normalizeFriendHelpState,
  serializeFriendHelpState,
  toLocalDateKey: toFriendHelpDateKey,
  resolveFriendHelpDailyLimit,
} = require("./friend-help-exp-cache");
const {
  AUTO_FARM_DAILY_STATS_RETENTION_DAYS,
  createEmptyAutoFarmDailyStats,
  normalizeAutoFarmDailyStats,
  serializeAutoFarmDailyStats,
} = require("./auto-farm-daily-stats");

const AUTO_FARM_RECENT_EVENT_LIMIT = 400;
const AUTO_FERTILIZER_STATE_VERSION = 2;
const WAREHOUSE_SELL_CATEGORY_OPTIONS = ["fruit", "seed", "tool", "material"];
const AUTO_FARM_SCHEDULER_TASK_IDS = ["own_base", "own_collect", "own_plant", "own_fertilizer", "friend_steal", "friend_help"];
const AUTO_FARM_SCHEDULER_TASK_DEFS = {
  own_base: {
    label: "自己农场基础任务",
    defaultPriority: 100,
  },
  own_collect: {
    label: "自动收获",
    defaultPriority: 95,
  },
  own_plant: {
    label: "自动种植",
    defaultPriority: 90,
  },
  own_fertilizer: {
    label: "自动施肥",
    defaultPriority: 85,
  },
  friend_steal: {
    label: "好友偷菜",
    defaultPriority: 70,
  },
  friend_help: {
    label: "好友帮忙",
    defaultPriority: 65,
  },
};

function toPositiveInt(value) {
  const n = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function toNonNegativeInt(value) {
  const n = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

function toFiniteNumberOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function normalizeAutoFertilizerAppliedType(value) {
  const type = String(value == null ? "" : value).trim().toLowerCase();
  if (type === "inorganic") return "normal";
  return type === "organic" ? "organic" : "normal";
}

function normalizeAutoFertilizerEvidence(raw) {
  if (!raw || typeof raw !== "object") return null;
  const source = String(raw.source || "").trim().toLowerCase();
  const at = raw.at ? String(raw.at) : null;
  const beforeMatureInSec = toFiniteNumberOrNull(raw.beforeMatureInSec);
  const afterMatureInSec = toFiniteNumberOrNull(raw.afterMatureInSec);
  const deltaMatureInSec = toFiniteNumberOrNull(raw.deltaMatureInSec);
  if (!source && !at && beforeMatureInSec == null && afterMatureInSec == null && deltaMatureInSec == null) {
    return null;
  }
  return {
    source: source || null,
    at,
    beforeMatureInSec,
    afterMatureInSec,
    deltaMatureInSec,
  };
}

function normalizeAutoFertilizerState(raw) {
  const src = raw && typeof raw === "object" ? raw : {};
  const markSource = src.landMarks && typeof src.landMarks === "object" ? src.landMarks : {};
  const normalizedMarks = Object.create(null);
  const keys = Object.keys(markSource).sort((a, b) => {
    const diff = toPositiveInt(a) - toPositiveInt(b);
    return diff !== 0 ? diff : String(a).localeCompare(String(b));
  });
  for (let i = 0; i < keys.length; i += 1) {
    const item = markSource[keys[i]];
    if (!item || typeof item !== "object") continue;
    const landId = toPositiveInt(item.landId || keys[i]);
    const plantId = toPositiveInt(item.plantId);
    const currentSeason = toPositiveInt(item.currentSeason);
    const totalSeason = Math.max(1, toPositiveInt(item.totalSeason) || currentSeason || 1);
    if (landId <= 0 || plantId <= 0 || currentSeason <= 0) continue;
    normalizedMarks[String(landId)] = {
      landId,
      seasonKey: String(item.seasonKey || `${landId}:${plantId}:${currentSeason}`),
      plantId,
      currentSeason,
      totalSeason,
      normalApplied: item.normalApplied === true,
      organicApplied: item.organicApplied === true,
      normalBlocked: item.normalBlocked === true,
      organicBlocked: item.organicBlocked === true,
      normalNoEffectCount: toNonNegativeInt(item.normalNoEffectCount),
      organicNoEffectCount: toNonNegativeInt(item.organicNoEffectCount),
      normalBlockedReason: item.normalBlockedReason ? String(item.normalBlockedReason) : null,
      organicBlockedReason: item.organicBlockedReason ? String(item.organicBlockedReason) : null,
      normalEvidence: normalizeAutoFertilizerEvidence(item.normalEvidence),
      organicEvidence: normalizeAutoFertilizerEvidence(item.organicEvidence),
      updatedAt: item.updatedAt ? String(item.updatedAt) : null,
    };
  }
  return {
    version: AUTO_FERTILIZER_STATE_VERSION,
    updatedAt: src.updatedAt ? String(src.updatedAt) : null,
    landMarks: normalizedMarks,
  };
}

function cloneAutoFertilizerStateForSave(state) {
  return normalizeAutoFertilizerState(state);
}

function serializeAutoFertilizerState(state) {
  const normalized = normalizeAutoFertilizerState(state);
  return {
    version: normalized.version,
    landMarks: normalized.landMarks,
  };
}

function toBool(value, defaultValue) {
  if (value == null) return defaultValue;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  const text = String(value).trim().toLowerCase();
  if (!text) return defaultValue;
  if (["1", "true", "yes", "on"].includes(text)) return true;
  if (["0", "false", "no", "off"].includes(text)) return false;
  return defaultValue;
}

function toInt(value, defaultValue, min, max) {
  const n = Number.parseInt(String(value ?? ""), 10);
  const fallback = Number.isFinite(n) ? n : defaultValue;
  return Math.min(max, Math.max(min, fallback));
}

function toErrorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function isAutomationStoppedError(error) {
  return !!(error && (error.code === "AUTOMATION_STOPPED" || error.message === "automation_stopped"));
}

function toPlantMode(value, defaultValue) {
  const mode = String(value == null ? "" : value).trim().toLowerCase();
  if (!mode) return defaultValue;
  if (mode === "max_level") return "highest_level";
  if ([
    "none",
    "backpack_first",
    "specified_seed",
    "highest_level",
    "max_exp",
    "max_fert_exp",
    "max_profit",
    "max_fert_profit",
  ].includes(mode)) {
    return mode;
  }
  return defaultValue;
}

function toFertilizerMode(value, defaultValue) {
  const mode = String(value == null ? "" : value).trim().toLowerCase();
  if (!mode) return defaultValue;
  if (mode === "inorganic") return "normal";
  if (["none", "normal", "organic", "both", "both_legacy"].includes(mode)) {
    return mode;
  }
  return defaultValue;
}

function normalizeStringList(value) {
  if (Array.isArray(value)) {
    return value
      .map((item) => String(item == null ? "" : item).trim())
      .filter(Boolean);
  }
  if (typeof value === "string") {
    return value
      .split(/[\r\n,，;；]+/)
      .map((item) => item.trim())
      .filter(Boolean);
  }
  return [];
}

function normalizePositiveIntList(value) {
  const source = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(/[\r\n,，;；]+/)
      : [];
  const next = [];
  for (const item of source) {
    const num = Number.parseInt(String(item == null ? "" : item).trim(), 10);
    if (!Number.isFinite(num) || num <= 0 || next.includes(num)) continue;
    next.push(num);
  }
  return next;
}

function normalizeFertilizerLandTypes(value) {
  const allLandTypes = ["gold", "black", "red", "normal"];
  const source = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(/[\r\n,，;；]+/)
      : allLandTypes;
  const next = [];
  for (const item of source) {
    const text = String(item == null ? "" : item).trim().toLowerCase();
    if (!text || !allLandTypes.includes(text) || next.includes(text)) continue;
    next.push(text);
  }
  return next.length ? next : [...allLandTypes];
}

function normalizeWarehouseSellCategoryList(value) {
  if (value == null) return [...WAREHOUSE_SELL_CATEGORY_OPTIONS];
  const source = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(/[\r\n,，;；]+/)
      : [];
  const next = [];
  for (const item of source) {
    const text = String(item == null ? "" : item).trim().toLowerCase();
    if (!text || !WAREHOUSE_SELL_CATEGORY_OPTIONS.includes(text) || next.includes(text)) continue;
    next.push(text);
  }
  return next;
}

function normalizeFriendRuleScopeList(value) {
  const source = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(/[\r\n,，;；]+/)
      : [];
  const next = [];
  for (const item of source) {
    const text = String(item == null ? "" : item).trim().toLowerCase();
    if (!text || !["steal", "help"].includes(text) || next.includes(text)) continue;
    next.push(text);
  }
  return next;
}

function normalizeClockText(value, defaultValue) {
  const text = String(value == null ? "" : value).trim();
  if (!text) return defaultValue;
  const match = /^(\d{1,2}):(\d{1,2})$/.exec(text);
  if (!match) return defaultValue;
  const hours = Number.parseInt(match[1], 10);
  const minutes = Number.parseInt(match[2], 10);
  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return defaultValue;
  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return defaultValue;
  return String(hours).padStart(2, "0") + ":" + String(minutes).padStart(2, "0");
}

function buildDefaultAutoFarmSchedulerTasks() {
  const next = {};
  AUTO_FARM_SCHEDULER_TASK_IDS.forEach((taskId) => {
    const def = AUTO_FARM_SCHEDULER_TASK_DEFS[taskId];
    next[taskId] = {
      priority: Number(def && def.defaultPriority) || 50,
    };
  });
  return next;
}

function normalizeAutoFarmSchedulerTaskConfig(taskId, raw) {
  const def = AUTO_FARM_SCHEDULER_TASK_DEFS[taskId] || { defaultPriority: 50 };
  const src = raw && typeof raw === "object" ? raw : {};
  return {
    priority: toInt(src.priority, Number(def.defaultPriority) || 50, 1, 999),
  };
}

function normalizeAutoFarmSchedulerConfig(raw) {
  const src = raw && typeof raw === "object" ? raw : {};
  const taskSource = src.autoFarmSchedulerTasks && typeof src.autoFarmSchedulerTasks === "object"
    ? src.autoFarmSchedulerTasks
    : {};
  const tasks = {};
  AUTO_FARM_SCHEDULER_TASK_IDS.forEach((taskId) => {
    tasks[taskId] = normalizeAutoFarmSchedulerTaskConfig(taskId, taskSource[taskId]);
  });
  return {
    autoFarmSchedulerEnabled: toBool(src.autoFarmSchedulerEnabled, true),
    autoFarmSchedulerMinGapMs: toInt(src.autoFarmSchedulerMinGapMs, 350, 0, 10000),
    autoFarmSchedulerTasks: tasks,
  };
}

function createEmptyAutoFarmSchedulerTaskState(taskId) {
  const def = AUTO_FARM_SCHEDULER_TASK_DEFS[taskId] || {};
  return {
    taskId,
    taskLabel: def.label || taskId,
    lastStartedAt: null,
    lastFinishedAt: null,
    lastSuccessAt: null,
    lastDurationMs: 0,
    lastError: null,
    runCount: 0,
    busy: false,
    lastResultSummary: null,
  };
}

function normalizeAutoFarmConfig(raw) {
  const src = raw && typeof raw === "object" ? raw : {};
  const scheduler = normalizeAutoFarmSchedulerConfig(src);
  const whitelistScopes = normalizeFriendRuleScopeList(src.autoFarmFriendWhitelistScopes);
  const blacklistScopesRaw = normalizeFriendRuleScopeList(src.autoFarmFriendBlacklistScopes);
  const blacklistScopes = blacklistScopesRaw.filter((scope) => !whitelistScopes.includes(scope));
  return {
    autoFarmOwnEnabled: toBool(src.autoFarmOwnEnabled, true),
    autoFarmOwnCollectEnabled: toBool(src.autoFarmOwnCollectEnabled, true),
    autoFarmOwnCollectOnlyWhenOwnFarm: toBool(src.autoFarmOwnCollectOnlyWhenOwnFarm, true),
    autoFarmOwnEraseGrassEnabled: toBool(src.autoFarmOwnEraseGrassEnabled, true),
    autoFarmOwnWaterEnabled: toBool(src.autoFarmOwnWaterEnabled, true),
    autoFarmOwnKillBugEnabled: toBool(src.autoFarmOwnKillBugEnabled, true),
    autoFarmFriendEnabled: toBool(src.autoFarmFriendEnabled, false),
    autoFarmFriendHelpEnabled: toBool(src.autoFarmFriendHelpEnabled, false),
    autoFarmFriendHelpDailyLimit: resolveFriendHelpDailyLimit(src.autoFarmFriendHelpDailyLimit),
    autoFarmOwnIntervalSec: toInt(src.autoFarmOwnIntervalSec, 30, 5, 3600),
    autoFarmOwnBaseIntervalSec: toInt(src.autoFarmOwnBaseIntervalSec ?? src.autoFarmOwnIntervalSec, 30, 5, 3600),
    autoFarmOwnCollectIntervalSec: toInt(src.autoFarmOwnCollectIntervalSec ?? src.autoFarmOwnIntervalSec, 30, 5, 3600),
    autoFarmPlantIntervalSec: toInt(src.autoFarmPlantIntervalSec ?? src.autoFarmOwnIntervalSec, 30, 5, 3600),
    autoFarmFriendStealIntervalSec: toInt(src.autoFarmFriendStealIntervalSec ?? src.autoFarmFriendIntervalSec, 90, 10, 3600),
    autoFarmFriendHelpIntervalSec: toInt(src.autoFarmFriendHelpIntervalSec ?? src.autoFarmFriendIntervalSec, 90, 10, 3600),
    autoFarmMaxFriends: toInt(src.autoFarmMaxFriends, 5, 1, 50),
    autoFarmEnterWaitMs: toInt(src.autoFarmEnterWaitMs, 1800, 0, 15000),
    autoFarmActionWaitMs: toInt(src.autoFarmActionWaitMs, 1200, 0, 10000),
    autoFarmRpcTimeoutMs: toInt(src.autoFarmRpcTimeoutMs, 90 * 1000, 5000, 10 * 60 * 1000),
    autoFarmRefreshFriendList: toBool(src.autoFarmRefreshFriendList, true),
    autoFarmReturnHome: toBool(src.autoFarmReturnHome, true),
    autoFarmStopOnError: toBool(src.autoFarmStopOnError, false),
    autoFarmPlantMode: toPlantMode(src.autoFarmPlantMode, "none"),
    autoFarmPlantPrimaryMode: toPlantMode(src.autoFarmPlantPrimaryMode ?? src.autoFarmPlantMode, "none"),
    autoFarmPlantSecondaryMode: toPlantMode(src.autoFarmPlantSecondaryMode, "none"),
    autoFarmPlantSeedId: toInt(src.autoFarmPlantSeedId, 0, 0, 99999999),
    autoFarmPlantBackpackSeedPriority: normalizePositiveIntList(src.autoFarmPlantBackpackSeedPriority),
    autoFarmPlantBackpackForcePriority: toBool(src.autoFarmPlantBackpackForcePriority, false),
    autoFarmPlantMaxLevel: toInt(src.autoFarmPlantMaxLevel, 0, 0, 999),
    autoFarmFertilizerEnabled: toBool(src.autoFarmFertilizerEnabled, false),
    autoFarmFertilizerMode: toFertilizerMode(src.autoFarmFertilizerMode, "none"),
    autoFarmFertilizerMultiSeason: toBool(src.autoFarmFertilizerMultiSeason, false),
    autoFarmFertilizerHarvestLinkEnabled: toBool(src.autoFarmFertilizerHarvestLinkEnabled, false),
    autoFarmFertilizerLandTypes: normalizeFertilizerLandTypes(src.autoFarmFertilizerLandTypes),
    autoFarmFertilizerIntervalSec: toInt(src.autoFarmFertilizerIntervalSec ?? src.autoFarmOwnIntervalSec, 30, 5, 3600),
    autoFarmFertilizerRushThresholdSec: toInt(src.autoFarmFertilizerRushThresholdSec, 300, 0, 999999),
    autoFarmFertilizerBatchChunkSize: toInt(src.autoFarmFertilizerBatchChunkSize, 2, 1, 12),
    autoFarmFertilizeBatchCallTimeoutMs: toInt(src.autoFarmFertilizeBatchCallTimeoutMs, 180 * 1000, 30 * 1000, 10 * 60 * 1000),
    autoFarmFertilizeSingleCallTimeoutMs: toInt(src.autoFarmFertilizeSingleCallTimeoutMs, 90 * 1000, 15 * 1000, 10 * 60 * 1000),
    autoFarmFriendQuietHoursEnabled: toBool(src.autoFarmFriendQuietHoursEnabled, false),
    autoFarmFriendQuietHoursStart: normalizeClockText(src.autoFarmFriendQuietHoursStart, "23:00"),
    autoFarmFriendQuietHoursEnd: normalizeClockText(src.autoFarmFriendQuietHoursEnd, "07:00"),
    autoFarmFriendWhitelistEnabled: toBool(src.autoFarmFriendWhitelistEnabled, false),
    autoFarmFriendWhitelistScopes: whitelistScopes,
    autoFarmFriendWhitelist: normalizeStringList(src.autoFarmFriendWhitelist),
    autoFarmFriendBlacklistEnabled: toBool(src.autoFarmFriendBlacklistEnabled, false),
    autoFarmFriendBlacklistScopes: blacklistScopes,
    autoFarmFriendBlockMaskedStealers: toBool(src.autoFarmFriendBlockMaskedStealers, true),
    autoFarmFriendBlacklist: normalizeStringList(src.autoFarmFriendBlacklist),
    autoFarmFriendMaskedBlacklistEnabled: toBool(
      src.autoFarmFriendMaskedBlacklistEnabled,
      toBool(src.autoFarmFriendBlockMaskedStealers, true)
    ),
    autoFarmFriendMaskedBlacklistMaxLevel: toInt(src.autoFarmFriendMaskedBlacklistMaxLevel, 1, 1, 999),
    autoFarmOwnCollectConcurrentEnabled: toBool(src.autoFarmOwnCollectConcurrentEnabled, false),
    autoFarmFriendStealPlantBlacklistEnabled: toBool(src.autoFarmFriendStealPlantBlacklistEnabled, false),
    autoFarmFriendStealPlantBlacklistStrategy: toInt(src.autoFarmFriendStealPlantBlacklistStrategy, 1, 1, 2),
    autoFarmFriendStealPlantBlacklist: normalizePositiveIntList(src.autoFarmFriendStealPlantBlacklist),
    autoFarmAutoStartEnabled: toBool(src.autoFarmAutoStartEnabled, false),
    autoWarehouseSellEnabled: toBool(src.autoWarehouseSellEnabled, false),
    autoWarehouseSellIntervalHour: toInt(src.autoWarehouseSellIntervalHour, 12, 0, 24 * 30),
    autoWarehouseSellCategories: normalizeWarehouseSellCategoryList(src.autoWarehouseSellCategories),
    autoFarmSchedulerEnabled: scheduler.autoFarmSchedulerEnabled,
    autoFarmSchedulerMinGapMs: scheduler.autoFarmSchedulerMinGapMs,
    autoFarmSchedulerTasks: scheduler.autoFarmSchedulerTasks,
  };
}

function getTodayKey(now) {
  return toFriendHelpDateKey(now) || toFriendHelpDateKey() || "";
}

function createEmptyTodayStats(dateKey) {
  return createEmptyAutoFarmDailyStats(dateKey || getTodayKey());
}

function normalizeTodayStats(raw, dateKey) {
  return normalizeAutoFarmDailyStats(raw, null, dateKey || getTodayKey());
}

function normalizeTodayStatsHistory(rawHistory, now) {
  const source = Array.isArray(rawHistory) ? rawHistory : [];
  const historyMap = Object.create(null);
  for (let i = 0; i < source.length; i += 1) {
    const normalized = normalizeTodayStats(source[i], source[i] && source[i].dateKey);
    if (!normalized.dateKey) continue;
    historyMap[normalized.dateKey] = normalized;
  }
  const todayKey = getTodayKey(now);
  if (todayKey && !historyMap[todayKey]) {
    historyMap[todayKey] = createEmptyTodayStats(todayKey);
  }
  return pruneTodayStatsHistoryMap(historyMap);
}

function buildTodayStatsHistoryEntries(historyMap) {
  const map = historyMap && typeof historyMap === "object" ? historyMap : {};
  return Object.keys(map)
    .sort((a, b) => b.localeCompare(a))
    .map((dateKey) => normalizeTodayStats(map[dateKey], dateKey));
}

function pruneTodayStatsHistoryMap(historyMap) {
  const entries = buildTodayStatsHistoryEntries(historyMap).slice(0, AUTO_FARM_DAILY_STATS_RETENTION_DAYS);
  const nextMap = Object.create(null);
  for (let i = 0; i < entries.length; i += 1) {
    const item = entries[i];
    nextMap[item.dateKey] = item;
  }
  return nextMap;
}

function normalizeDelta(before, after) {
  const beforeNum = Number(before);
  const afterNum = Number(after);
  if (!Number.isFinite(beforeNum) || !Number.isFinite(afterNum)) return 0;
  return Math.max(0, beforeNum - afterNum);
}

function normalizeHelpCounts(value) {
  const src = value && typeof value === "object" ? value : {};
  return {
    water: Math.max(0, Number(src.water) || 0),
    eraseGrass: Math.max(0, Number(src.eraseGrass) || 0),
    killBug: Math.max(0, Number(src.killBug) || 0),
  };
}

function getHelpProgressFromVisit(visit) {
  const before = normalizeHelpCounts(visit && visit.helpBeforeCounts);
  const after = normalizeHelpCounts(visit && visit.helpAfterCounts);
  return {
    water: normalizeDelta(before.water, after.water),
    eraseGrass: normalizeDelta(before.eraseGrass, after.eraseGrass),
    killBug: normalizeDelta(before.killBug, after.killBug),
  };
}

function mergeCycleResultIntoTodayStats(stats, cycle) {
  const target = stats && typeof stats === "object"
    ? stats
    : createEmptyTodayStats();
  const result = cycle && cycle.result && typeof cycle.result === "object" ? cycle.result : cycle;
  if (!result || typeof result !== "object") return target;

  target.runs += 1;
  if (result.ownFarmEnabled) target.ownRuns += 1;
  if (result.friendStealEnabled) target.friendRuns += 1;

  const ownFarm = result.ownFarm && typeof result.ownFarm === "object" ? result.ownFarm : null;
  const tasks = ownFarm && ownFarm.tasks && typeof ownFarm.tasks === "object" ? ownFarm.tasks : null;
  const actions = Array.isArray(tasks && tasks.actions) ? tasks.actions : [];
  actions.forEach((action) => {
    if (!action || action.ok !== true) return;
    const delta = normalizeDelta(action.beforeCount, action.afterCount);
    if (action.key === "collect") target.collect += delta;
    if (action.key === "water") target.water += delta;
    if (action.key === "eraseGrass") target.eraseGrass += delta;
    if (action.key === "killBug") target.killBug += delta;
  });

  const specialCollect = tasks && tasks.specialCollect && typeof tasks.specialCollect === "object"
    ? tasks.specialCollect
    : null;
  if (specialCollect && specialCollect.ok === true && Number(specialCollect.candidateCount) > 0) {
    target.collect += Number(specialCollect.candidateCount) || 0;
  }

  const plantResult = ownFarm && ownFarm.plantResult && typeof ownFarm.plantResult === "object"
    ? ownFarm.plantResult
    : null;
  if (plantResult && plantResult.ok === true && plantResult.action === "planted") {
    const plantedCount = Number(
      plantResult.plantResult && plantResult.plantResult.plantedCount != null
        ? plantResult.plantResult.plantedCount
        : plantResult.emptyCount
    ) || 0;
    target.plant += Math.max(0, plantedCount);
  }

  const fertilizerResult = ownFarm && ownFarm.fertilizerResult && typeof ownFarm.fertilizerResult === "object"
    ? ownFarm.fertilizerResult
    : null;
  if (fertilizerResult && fertilizerResult.skipped !== true) {
    target.fertilize += Math.max(0, Number(fertilizerResult.successCount) || 0);
    const linkedHarvest = fertilizerResult.linkedHarvest && typeof fertilizerResult.linkedHarvest === "object"
      ? fertilizerResult.linkedHarvest
      : null;
    if (linkedHarvest && linkedHarvest.skipped !== true) {
      target.collect += Math.max(0, Number(linkedHarvest.collectCount) || 0);
    }
  }

  const friendSteal = result.friendSteal && typeof result.friendSteal === "object" ? result.friendSteal : null;
  const visits = Array.isArray(friendSteal && friendSteal.visits) ? friendSteal.visits : [];
  visits.forEach((visit) => {
    if (!visit || visit.ok !== true) return;
    target.steal += normalizeDelta(visit.collectBefore, visit.collectAfter);
    const helpProgress = getHelpProgressFromVisit(visit);
    target.helpWater += helpProgress.water;
    target.helpEraseGrass += helpProgress.eraseGrass;
    target.helpKillBug += helpProgress.killBug;
  });

  return target;
}

const FRIEND_VISIT_COOLDOWN_MS = 5 * 60 * 1000;
const FRIEND_BLACKLIST_ONLY_COOLDOWN_MS = 10 * 60 * 1000;

function shouldApplyFriendCooldown(visit) {
  if (!visit || typeof visit !== "object") return null;
  if (visit.reason === "no_collectable_after_enter") {
    return { ms: FRIEND_VISIT_COOLDOWN_MS, reason: "no_collectable_after_enter" };
  }
  if (visit.reason === "no_actionable_after_enter") {
    return { ms: FRIEND_VISIT_COOLDOWN_MS, reason: "no_actionable_after_enter" };
  }
  if (visit.reason === "all_collectable_blacklisted") {
    return { ms: FRIEND_BLACKLIST_ONLY_COOLDOWN_MS, reason: "all_collectable_blacklisted" };
  }
  if (visit.reason === "blacklist_strategy_skip_whole_farm") {
    return { ms: FRIEND_BLACKLIST_ONLY_COOLDOWN_MS, reason: "blacklist_strategy_skip_whole_farm" };
  }
  const helpProgress = getHelpProgressFromVisit(visit);
  const totalHelpProgress = helpProgress.water + helpProgress.eraseGrass + helpProgress.killBug;
  if (
    visit.ok === true
    && Number(visit.collectBefore) > 0
    && Number(visit.collectAfter) >= Number(visit.collectBefore)
    && totalHelpProgress <= 0
  ) {
    return { ms: FRIEND_VISIT_COOLDOWN_MS, reason: "no_progress_after_visit" };
  }
  if (visit.ok === true && Number(visit.collectBefore) <= 0 && totalHelpProgress <= 0) {
    const helpBefore = normalizeHelpCounts(visit.helpBeforeCounts);
    if ((helpBefore.water + helpBefore.eraseGrass + helpBefore.killBug) > 0) {
      return { ms: FRIEND_VISIT_COOLDOWN_MS, reason: "no_help_progress_after_visit" };
    }
  }
  const errorText = String(visit.error || "").toLowerCase();
  if (visit.ok === false && errorText) {
    if (
      errorText.includes("被偷走")
      || errorText.includes("already")
      || errorText.includes("stolen")
      || errorText.includes("no_collectable")
    ) {
      return { ms: FRIEND_VISIT_COOLDOWN_MS, reason: "collect_race_or_stale_state" };
    }
  }
  return null;
}

function formatAutoFarmActionLabel(key) {
  if (key === "collect") return "一键收获";
  if (key === "water") return "一键浇水";
  if (key === "eraseGrass") return "一键除草";
  if (key === "killBug") return "一键杀虫";
  return key ? String(key) : "未知动作";
}

function formatAutoFarmPlantModeLabel(mode) {
  if (mode === "backpack_first") return "背包优先";
  if (mode === "specified_seed") return "指定作物";
  if (mode === "highest_level") return "最大等级";
  if (mode === "max_exp") return "最大经验";
  if (mode === "max_fert_exp") return "施肥最大经验";
  if (mode === "max_profit") return "最大收益";
  if (mode === "max_fert_profit") return "施肥最大收益";
  if (mode === "none") return "关闭";
  return mode ? String(mode) : "未知策略";
}

function formatAutoFarmSeedSourceLabel(source) {
  const text = String(source || "").trim().toLowerCase();
  if (!text) return "未知来源";
  if (text === "backpack") return "背包";
  if (text === "backpack_explicit") return "背包指定";
  if (text === "backpack_partial") return "背包部分种植";
  if (text === "backpack_plus_shop_lookup") return "背包 + 商店补购";
  if (text === "shop") return "商店";
  if (text === "shop_lookup") return "商店查找购买";
  if (text === "shop_explicit") return "商店指定";
  if (text === "shop_lookup_deferred") return "商店延后确认";
  if (text === "shop_buy_highest") return "商店最高级";
  if (text === "shop_buy_lowest") return "商店最低级";
  if (text === "unavailable") return "当前不可用";
  return String(source);
}

function formatAutoFarmDecisionReason(reason) {
  const text = String(reason || "").trim().toLowerCase();
  if (!text) return "未说明原因";
  const map = {
    backpack_seed_available: "背包中有可用种子",
    no_seeds_in_backpack: "背包里没有可用种子",
    seed_id_required: "尚未配置指定种子",
    specified_seed_in_backpack: "指定种子在背包中",
    specified_seed_in_shop: "指定种子可在商店购买",
    specified_seed_shop_lookup_deferred: "商店查询延后确认",
    seed_not_available: "当前背包和商店都不可用",
    no_plant_candidates: "当前等级下没有候选作物",
    strategy_seed_in_backpack: "排行候选在背包中",
    strategy_seed_in_shop: "排行候选可在商店购买",
    strategy_shop_lookup_deferred: "商店查询延后确认",
    buy_failed: "购买失败",
    plant_verify_failed: "种植后校验失败",
  };
  return map[text] || String(reason);
}

function formatAutoFarmLevelSourceLabel(source) {
  const text = String(source || "").trim().toLowerCase();
  if (text === "config") return "手动等级上限";
  if (text === "profile") return "账号等级";
  if (text === "profile_plant_level") return "可种等级";
  if (text === "none") return "未识别等级";
  return source ? String(source) : "未知来源";
}

function formatAutoFarmStageCounts(stageCounts) {
  const src = stageCounts && typeof stageCounts === "object" ? stageCounts : {};
  const defs = [
    ["mature", "成熟"],
    ["growing", "生长中"],
    ["empty", "空地"],
    ["dead", "枯萎"],
    ["other", "其他"],
    ["unknown", "未知"],
    ["error", "异常"],
  ];
  const parts = [];
  defs.forEach(([key, label]) => {
    const value = Number(src[key]) || 0;
    if (value > 0) parts.push(label + value);
  });
  return parts.join("，");
}

function formatAutoFarmWorkCounts(workCounts) {
  const src = workCounts && typeof workCounts === "object" ? workCounts : {};
  const defs = [
    ["collect", "可收"],
    ["water", "待浇水"],
    ["eraseGrass", "待除草"],
    ["killBug", "待杀虫"],
    ["eraseDead", "待清理枯萎"],
  ];
  const parts = [];
  defs.forEach(([key, label]) => {
    const value = Number(src[key]) || 0;
    if (value > 0) parts.push(label + value);
  });
  return parts.join("，");
}

function formatAutoFarmSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== "object") return "无状态信息";
  const parts = [];
  if (snapshot.farmType) parts.push("农场=" + snapshot.farmType);
  if (snapshot.totalGrids != null) parts.push("地块 " + snapshot.totalGrids);
  const stageText = formatAutoFarmStageCounts(snapshot.stageCounts);
  const workText = formatAutoFarmWorkCounts(snapshot.workCounts);
  if (stageText) parts.push("阶段 " + stageText);
  if (workText) parts.push("待处理 " + workText);
  return parts.join(" · ") || "无状态信息";
}

function formatAutoFarmFriendName(friend) {
  if (!friend || typeof friend !== "object") return "未知好友";
  const name = friend.displayName || friend.name || friend.remark || (friend.gid != null ? "gid=" + friend.gid : "未知好友");
  return friend.gid != null ? `${name} (gid=${friend.gid})` : String(name);
}

function formatFriendHelpStateSummary(state) {
  const src = state && typeof state === "object" ? state : null;
  if (!src) return "帮忙状态未知";
  const helpCount = Math.max(0, Number(src.helpCount) || 0);
  const dailyLimit = Math.max(1, Number(src.dailyLimit) || 0);
  const remaining = Math.max(0, dailyLimit - helpCount);
  if (src.limitReached === true) return `今日已暂停（${helpCount}/${dailyLimit}）`;
  if (helpCount > 0) return `今日已帮 ${helpCount}/${dailyLimit}，剩余 ${remaining} 次`;
  return `今日未帮忙（上限 ${dailyLimit} 次）`;
}

function formatAutoFarmIdList(list, limit) {
  const rows = Array.isArray(list) ? list : [];
  const max = Math.max(1, Number(limit) || 6);
  const ids = rows
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value) && value > 0);
  if (ids.length <= max) return ids.join(",");
  return ids.slice(0, max).join(",") + ` 等${ids.length}块`;
}

function normalizeAutoFarmIdArray(list) {
  const source = Array.isArray(list) ? list : [];
  const next = [];
  for (let i = 0; i < source.length; i += 1) {
    const value = Number(source[i]);
    if (!Number.isFinite(value) || value <= 0 || next.includes(value)) continue;
    next.push(value);
  }
  return next;
}

function buildAutoFarmLandDetailParts(beforeLandIds, afterLandIds) {
  const parts = [];
  const targetIds = normalizeAutoFarmIdArray(beforeLandIds);
  const remainingIds = normalizeAutoFarmIdArray(afterLandIds);
  if (targetIds.length > 0) parts.push("目标地块 " + formatAutoFarmIdList(targetIds, 12));
  if (remainingIds.length > 0) parts.push("剩余地块 " + formatAutoFarmIdList(remainingIds, 12));
  return parts;
}

function formatAutoFarmFertilizerTypeLabel(type) {
  return String(type || "").trim().toLowerCase() === "organic" ? "有机" : "无机";
}

function formatAutoFarmFertilizerPhaseLabel(actionOrPhase) {
  const action = actionOrPhase && typeof actionOrPhase === "object" ? actionOrPhase : null;
  const text = String(action ? action.phase : actionOrPhase || "").trim().toLowerCase();
  const fertilizerReason = String(action && action.fertilizerReason || "").trim().toLowerCase();
  const currentSeason = Number(action && action.currentSeason);
  const totalSeason = Number(action && action.totalSeason);
  const followUpSeason = (
    Number.isFinite(totalSeason)
    && totalSeason > 1
    && Number.isFinite(currentSeason)
    && currentSeason > 1
  );
  if (text === "season_start") {
    if (fertilizerReason === "season_start_normal" || !fertilizerReason) {
      return followUpSeason ? "第二季智能无机轮" : "智能无机轮";
    }
    return followUpSeason ? "第二季智能无机轮" : "智能无机轮";
  }
  if (text === "rush_normal") return "无机催熟轮";
  if (text === "rush_organic") return "有机催熟轮";
  return text ? text : null;
}

function getAutoFarmFertilizerPhaseSummaryLabel(phase) {
  const text = String(phase || "").trim().toLowerCase();
  if (text === "season_start") return "智能无机";
  if (text === "rush_normal") return "无机催熟";
  if (text === "rush_organic") return "有机催熟";
  return text || "未知阶段";
}

function formatAutoFarmFertilizerReason(action) {
  if (!action || typeof action !== "object") return "unknown";
  if (action.displayReason) return String(action.displayReason);
  const text = String(action.reason || action.error || "").trim();
  if (!text) return "unknown";
  if (text === "same_fertilizer_type_already_used") return "该化肥对同一作物仅能使用1次";
  return text;
}

function formatAutoFarmFertilizerStageHint(action) {
  if (!action || typeof action !== "object") return null;
  const currentSeason = Number(action.currentSeason);
  const totalSeason = Number(action.totalSeason);
  const currentStage = Number(action.currentStage);
  const phaseName = String(action.phaseName || "").trim();
  const parts = [];
  if (Number.isFinite(totalSeason) && totalSeason > 1 && Number.isFinite(currentSeason) && currentSeason > 0) {
    parts.push(`第${currentSeason}/${totalSeason}季`);
  }
  if (phaseName && Number.isFinite(currentStage) && currentStage > 0) {
    parts.push(`${phaseName}·第${currentStage}阶段`);
  } else if (phaseName) {
    parts.push(phaseName);
  } else if (Number.isFinite(currentStage) && currentStage > 0) {
    parts.push(`第${currentStage}阶段`);
  }
  return parts.length > 0 ? parts.join(" · ") : null;
}

function formatAutoFarmFertilizerBatchReason(reason) {
  const text = String(reason || "").trim();
  if (!text) return "unknown";
  if (text === "runtime_missing_gameCtl.fertilizeLandsBatch") {
    return "当前小程序运行时未加载批量施肥接口";
  }
  return text;
}

function formatAutoFarmMatureSecLabel(value) {
  const seconds = Number(value);
  return Number.isFinite(seconds) ? `${seconds}s` : null;
}

function pushAutoFarmPlantAttemptMessages(messages, attempts) {
  const rows = Array.isArray(attempts) ? attempts : [];
  rows.forEach((attempt, index) => {
    if (!attempt) return;
    const parts = [`第${index + 1}次`, `候选 ${attempt.candidateSeedId || "unknown"}`];
    const requestedLandIds = normalizeAutoFarmIdArray(attempt.requestedLandIds);
    const skippedLandIds = normalizeAutoFarmIdArray(attempt.skippedLandIds);
    if (requestedLandIds.length > 0) parts.push("目标地块 " + formatAutoFarmIdList(requestedLandIds, 12));
    if (skippedLandIds.length > 0) parts.push("跳过地块 " + formatAutoFarmIdList(skippedLandIds, 12));
    parts.push("已种 " + (Number(attempt.plantedCount) || 0));
    if (attempt.dispatchError) parts.push("失败 " + attempt.dispatchError);
    messages.push({
      level: attempt.ok ? "info" : "warn",
      message: `自动农场 / 自己农场 / 自动种植尝试：${parts.join(" · ")}`,
    });
  });
}

function buildAutoFarmCycleLogMessages({ due, injectState, result, cooldownApplied }) {
  const messages = [];
  const ownEnabled = !!(due && due.ownDue);
  const friendStealEnabled = !!(due && due.friendStealDue);
  const friendHelpEnabled = !!(due && due.friendHelpDue);
  const friendPatrolEnabled = !!(friendStealEnabled || friendHelpEnabled);
  const ownFarm = result && result.ownFarm && typeof result.ownFarm === "object" ? result.ownFarm : null;
  const friendSteal = result && result.friendSteal && typeof result.friendSteal === "object" ? result.friendSteal : null;

  messages.push({
    level: "info",
    message: `自动农场 / 开始调度：自己农场=${ownEnabled ? "执行" : "跳过"}，好友偷菜=${friendStealEnabled ? "执行" : "跳过"}，好友帮忙=${friendHelpEnabled ? "执行" : "跳过"}${injectState && injectState.injected ? "，已自动注入脚本" : ""}`,
  });

  if (ownEnabled) {
    if (ownFarm && ownFarm.skipped && ownFarm.skipReason === "no_own_tasks_enabled") {
      messages.push({
        level: "info",
        message: "自动农场 / 自己农场 / 本轮跳过：基础动作未勾选，且未配置自动种植或自动施肥",
      });
    }

    if (ownFarm && ownFarm.enterOwn) {
      messages.push({
        level: ownFarm.enterOwn.ok ? "info" : "warn",
        message: `自动农场 / 自己农场 / 进场：${ownFarm.enterOwn.ok ? "已回到自己农场" : ("失败 " + (ownFarm.enterOwn.error || "unknown"))}`,
      });
    }

    if (ownFarm && ownFarm.tasks) {
      messages.push({
        level: "info",
        message: `自动农场 / 自己农场 / 巡检前：${formatAutoFarmSnapshot(ownFarm.tasks.before)}`,
      });

      const actions = Array.isArray(ownFarm.tasks.actions) ? ownFarm.tasks.actions : [];
      if (actions.length === 0) {
        messages.push({
          level: "info",
          message: "自动农场 / 自己农场 / 一键动作：无待处理项",
        });
      }
      actions.forEach((action) => {
        if (!action) return;
        const label = formatAutoFarmActionLabel(action.key);
        const landParts = buildAutoFarmLandDetailParts(action.beforeLandIds, action.afterLandIds);
        if (action.ok) {
          messages.push({
            level: "info",
            message: `自动农场 / 自己农场 / ${label}：${Number(action.beforeCount) || 0} → ${Number(action.afterCount) || 0}${landParts.length > 0 ? (" · " + landParts.join(" · ")) : ""}`,
          });
        } else {
          messages.push({
            level: "warn",
            message: `自动农场 / 自己农场 / ${label}：失败 ${action.error || action.reason || "unknown"}${landParts.length > 0 ? (" · " + landParts.join(" · ")) : ""}`,
          });
        }
      });

      const specialCollect = ownFarm.tasks.specialCollect;
      if (specialCollect && (specialCollect.candidateCount > 0 || specialCollect.ok === false)) {
        if (specialCollect.ok === false) {
          const candidateLandIds = normalizeAutoFarmIdArray(specialCollect.candidateLandIds);
          messages.push({
            level: "warn",
            message: `自动农场 / 自己农场 / 补充逐块收取：失败 ${specialCollect.error || "unknown"}${candidateLandIds.length > 0 ? (" · 候选地块 " + formatAutoFarmIdList(candidateLandIds, 12)) : ""}`,
          });
        } else {
          const successActions = Array.isArray(specialCollect.actions)
            ? specialCollect.actions.filter((item) => item && item.ok === true)
            : [];
          const failedActions = Array.isArray(specialCollect.actions)
            ? specialCollect.actions.filter((item) => item && item.ok !== true)
            : [];
          const candidateLandIds = normalizeAutoFarmIdArray(specialCollect.candidateLandIds);
          const successLandIds = normalizeAutoFarmIdArray(successActions.map((item) => item.landId));
          const remainingLandIds = normalizeAutoFarmIdArray(specialCollect.remainingLandIds);
          const successCount = Array.isArray(successActions) ? successActions.length : 0;
          const parts = [
            `候选 ${Number(specialCollect.candidateCount) || 0} 块`,
            `成功 ${successCount} 块`,
            `剩余 ${Number(specialCollect.remainingCount) || 0} 块`,
          ];
          if (candidateLandIds.length > 0) parts.push("候选地块 " + formatAutoFarmIdList(candidateLandIds, 12));
          if (remainingLandIds.length > 0) parts.push("剩余地块 " + formatAutoFarmIdList(remainingLandIds, 12));
          messages.push({
            level: "info",
            message: `自动农场 / 自己农场 / 补充逐块收取：${parts.join(" · ")}`,
          });
          if (successLandIds.length > 0) {
            messages.push({
              level: "info",
              message: `自动农场 / 自己农场 / 补充逐块收取成功：地块 ${formatAutoFarmIdList(successLandIds, 12)}`,
            });
          }
          failedActions.forEach((item) => {
            if (!item) return;
            messages.push({
              level: "warn",
              message: `自动农场 / 自己农场 / 补充逐块收取失败：地块 ${Number(item.landId) || "unknown"} · ${item.error || item.reason || "unknown"}`,
            });
          });
        }
      }
    }

    const plantResult = ownFarm && ownFarm.plantResult && typeof ownFarm.plantResult === "object" ? ownFarm.plantResult : null;
    if (plantResult) {
      const nested = plantResult.plantResult && typeof plantResult.plantResult === "object" ? plantResult.plantResult : null;
      pushAutoFarmPlantAttemptMessages(messages, nested && nested.attempts);
      const decisionLog = Array.isArray(plantResult.decisionLog) ? plantResult.decisionLog : [];
      decisionLog.forEach((item) => {
        if (!item) return;
        const prefix = `自动农场 / 自己农场 / 种植决策：第${Number(item.step) || 0}步 ${formatAutoFarmPlantModeLabel(item.mode)}`;
        if (item.phase === "fallback") {
          messages.push({
            level: "warn",
            message: `${prefix} 失败（${formatAutoFarmDecisionReason(item.reason)}），回退到 ${formatAutoFarmPlantModeLabel(item.fallbackToMode)}`,
          });
          return;
        }
        const parts = [];
        if (item.selectedSeedName || item.selectedSeedId) parts.push("目标 " + (item.selectedSeedName || item.selectedSeedId));
        if (item.source) parts.push("来源 " + formatAutoFarmSeedSourceLabel(item.source));
        if (item.backpackCount != null) parts.push("背包 " + item.backpackCount);
        if (item.shopGoodsId != null) parts.push("商品 " + item.shopGoodsId);
        if (item.effectiveMaxLevel != null) parts.push(formatAutoFarmLevelSourceLabel(item.levelSource) + " Lv." + item.effectiveMaxLevel);
        parts.push("原因 " + formatAutoFarmDecisionReason(item.reason));
        messages.push({
          level: item.phase === "failed" ? "warn" : "info",
          message: `${prefix} · ${parts.join(" · ")}`,
        });
      });

      if (plantResult.ok && plantResult.action === "planted") {
        const plantedCount = Number(nested && nested.plantedCount != null ? nested.plantedCount : plantResult.emptyCount) || 0;
        const requestedLandIds = normalizeAutoFarmIdArray(
          nested && Array.isArray(nested.requestedLandIds)
            ? nested.requestedLandIds
            : (nested && Array.isArray(nested.beforeEmptyIds) ? nested.beforeEmptyIds : [])
        );
        const skippedLandIds = normalizeAutoFarmIdArray(nested && nested.skippedLandIds);
        const parts = [];
        parts.push(formatAutoFarmPlantModeLabel(plantResult.resolvedMode || plantResult.mode));
        parts.push("成功种植 " + (plantResult.seedName || plantResult.seedId || "unknown"));
        parts.push("x" + plantedCount);
        if (requestedLandIds.length > 0) parts.push("目标地块 " + formatAutoFarmIdList(requestedLandIds, 12));
        if (skippedLandIds.length > 0) parts.push("跳过地块 " + formatAutoFarmIdList(skippedLandIds, 12));
        if (plantResult.seedSource) parts.push("来源 " + formatAutoFarmSeedSourceLabel(plantResult.seedSource));
        messages.push({
          level: "info",
          message: `自动农场 / 自己农场 / 自动种植：${parts.join(" · ")}`,
        });
      } else if (plantResult.ok && plantResult.action === "no_empty_lands") {
        messages.push({
          level: "info",
          message: `自动农场 / 自己农场 / 自动种植：${formatAutoFarmPlantModeLabel(plantResult.resolvedMode || plantResult.mode)} 检测无空地`,
        });
      } else if (plantResult.ok && plantResult.action === "skip") {
        messages.push({
          level: "info",
          message: "自动农场 / 自己农场 / 自动种植：当前已关闭",
        });
      } else {
        const attempts = Array.isArray(nested && nested.attempts) ? nested.attempts : [];
        messages.push({
          level: "warn",
          message: `自动农场 / 自己农场 / 自动种植：失败 ${plantResult.reason || plantResult.error || "unknown"}${attempts.length > 0 ? ` · 共尝试 ${attempts.length} 次` : ""}`,
        });
      }
    }

    const fertilizerResult = ownFarm && ownFarm.fertilizerResult && typeof ownFarm.fertilizerResult === "object" ? ownFarm.fertilizerResult : null;
    if (fertilizerResult) {
      const fertilizerBefore = fertilizerResult.before && typeof fertilizerResult.before === "object"
        ? fertilizerResult.before
        : null;
      const fertilizerStageCounts = fertilizerBefore && fertilizerBefore.stageCounts && typeof fertilizerBefore.stageCounts === "object"
        ? fertilizerBefore.stageCounts
        : null;
      const fertilizerEmptyCount = Number(fertilizerStageCounts && fertilizerStageCounts.empty) || 0;
      const fertilizerGrowingCount = Number(fertilizerStageCounts && fertilizerStageCounts.growing) || 0;
      if (fertilizerResult.skipped) {
        messages.push({
          level: "info",
          message: `自动农场 / 自己农场 / 自动施肥：跳过 ${fertilizerResult.reason || fertilizerResult.executedMode || "unknown"}`,
        });
      } else if (fertilizerEmptyCount > 0 || fertilizerGrowingCount > 0) {
        const summaryParts = [];
        if (fertilizerEmptyCount > 0) summaryParts.push(`空地已忽略 ${fertilizerEmptyCount} 块`);
        if (fertilizerGrowingCount > 0) summaryParts.push(`生长期候选 ${fertilizerGrowingCount} 块`);
        const phaseResults = Array.isArray(fertilizerResult.phases) ? fertilizerResult.phases : [];
        phaseResults.forEach((item) => {
          const candidateCount = Number(item && item.candidateCount) || 0;
          if (candidateCount <= 0) return;
          summaryParts.push(`${getAutoFarmFertilizerPhaseSummaryLabel(item && item.phase)} ${candidateCount} 块`);
        });
        messages.push({
          level: "info",
          message: `自动农场 / 自己农场 / 自动施肥预筛选：${summaryParts.join(" · ")}`,
        });
      }
      if (!fertilizerResult.skipped && fertilizerResult.ok) {
        messages.push({
          level: "info",
          message: `自动农场 / 自己农场 / 自动施肥：成功 ${Number(fertilizerResult.successCount) || 0} 块，跳过 ${Number(fertilizerResult.skippedCount) || 0} 块，失败 ${Number(fertilizerResult.failureCount) || 0} 块`,
        });
      } else if (!fertilizerResult.skipped) {
        messages.push({
          level: "warn",
          message: `自动农场 / 自己农场 / 自动施肥：失败 ${fertilizerResult.error || fertilizerResult.reason || "unknown"} · 成功 ${Number(fertilizerResult.successCount) || 0} 块，跳过 ${Number(fertilizerResult.skippedCount) || 0} 块，失败 ${Number(fertilizerResult.failureCount) || 0} 块`,
        });
      }
      if (fertilizerResult.batchUnavailableReason) {
        messages.push({
          level: "info",
          message: `自动农场 / 自己农场 / 自动施肥：批量未启用 ${formatAutoFarmFertilizerBatchReason(fertilizerResult.batchUnavailableReason)}${fertilizerResult.runtimeScriptHash ? (" · 脚本 " + fertilizerResult.runtimeScriptHash) : ""}`,
        });
      }
      const fertilizerDispatchStats = fertilizerResult.dispatchStats && typeof fertilizerResult.dispatchStats === "object"
        ? fertilizerResult.dispatchStats
        : null;
      if (fertilizerDispatchStats) {
        const batchAttemptedCount = Number(fertilizerDispatchStats.batchAttemptedCount) || 0;
        const fallbackBatchCount = Number(fertilizerDispatchStats.fallbackBatchCount) || 0;
        const fallbackSingleCount = Number(fertilizerDispatchStats.fallbackSingleCount) || 0;
        const duplicateFallbackBlockedCount = Number(fertilizerDispatchStats.duplicateFallbackBlockedCount) || 0;
        if (batchAttemptedCount > 0 || fallbackBatchCount > 0 || fallbackSingleCount > 0 || duplicateFallbackBlockedCount > 0) {
          messages.push({
            level: "info",
            message: `自动农场 / 自己农场 / 自动施肥调度：批量主跑 ${batchAttemptedCount} 块 · 批量补跑 ${fallbackBatchCount} 块 · 单块补跑 ${fallbackSingleCount} 块 · 拦截重复补跑 ${duplicateFallbackBlockedCount} 块`,
          });
        }
      }
      const fertilizerActions = Array.isArray(fertilizerResult.actions) ? fertilizerResult.actions : [];
      fertilizerActions.forEach((action) => {
        if (!action) return;
        const parts = [`地块 ${Number(action.landId) || "unknown"}`, formatAutoFarmFertilizerTypeLabel(action.fertilizerType)];
        const phaseLabel = formatAutoFarmFertilizerPhaseLabel(action);
        if (phaseLabel) parts.push(phaseLabel);
        const stageHint = formatAutoFarmFertilizerStageHint(action);
        if (stageHint) parts.push(stageHint);
        if (action.skipped === true) {
          parts.push("跳过 " + formatAutoFarmFertilizerReason(action));
          messages.push({
            level: "info",
            message: `自动农场 / 自己农场 / 自动施肥：${parts.join(" · ")}`,
          });
          return;
        }
        if (action.ok === true) {
          const beforeMature = formatAutoFarmMatureSecLabel(action.beforeMatureInSec);
          const afterMature = formatAutoFarmMatureSecLabel(action.afterMatureInSec);
          const deltaMature = Number(action.deltaMatureInSec);
          if (Number.isFinite(deltaMature) && deltaMature !== 0) {
            parts.push("成熟缩短 " + Math.abs(deltaMature) + "s");
          }
          if (beforeMature || afterMature) {
            parts.push(`成熟 ${beforeMature || "?"} -> ${afterMature || "?"}`);
          }
          messages.push({
            level: "info",
            message: `自动农场 / 自己农场 / 自动施肥：${parts.join(" · ")}`,
          });
          return;
        }
        parts.push("失败 " + formatAutoFarmFertilizerReason(action));
        messages.push({
          level: "warn",
          message: `自动农场 / 自己农场 / 自动施肥：${parts.join(" · ")}`,
        });
      });
      const linkedHarvest = fertilizerResult.linkedHarvest && typeof fertilizerResult.linkedHarvest === "object"
        ? fertilizerResult.linkedHarvest
        : null;
      if (linkedHarvest && linkedHarvest.enabled === true && linkedHarvest.skipped !== true) {
        const detailParts = [
          `轮次 ${Number(linkedHarvest.roundCount) || 0}`,
          `收获 ${Number(linkedHarvest.collectCount) || 0} 块`,
        ];
        if (linkedHarvest.reason) detailParts.push(`结束 ${linkedHarvest.reason}`);
        messages.push({
          level: linkedHarvest.ok === false ? "warn" : "info",
          message: `自动农场 / 自己农场 / 催熟联动收获：${detailParts.join(" · ")}`,
        });
      }
    }

    if (ownFarm && ownFarm.tasks) {
      messages.push({
        level: "info",
        message: `自动农场 / 自己农场 / 巡检后：${formatAutoFarmSnapshot(ownFarm.tasks.after)}`,
      });
    }
  }

  if (friendPatrolEnabled && friendSteal) {
    if (friendSteal.skipped && friendSteal.skipReason === "quiet_hours") {
      messages.push({
        level: "info",
        message: `自动农场 / 好友巡检：静默时段暂停 (${friendSteal.quietHours && friendSteal.quietHours.start ? friendSteal.quietHours.start : "--:--"} - ${friendSteal.quietHours && friendSteal.quietHours.end ? friendSteal.quietHours.end : "--:--"})`,
      });
    } else {
      const parts = [];
      parts.push("候选 " + (Number(friendSteal.totalCandidates) || 0));
      parts.push("可偷 " + (Number(friendSteal.stealableCandidates) || 0));
      if (friendSteal.helpEnabled) {
        parts.push("可帮 " + (Number(friendSteal.helpableCandidates) || 0));
        parts.push(formatFriendHelpStateSummary(friendSteal.helpState));
        if (friendSteal.helpLimitReached) {
          parts.push("今日帮忙已暂停");
        }
      }
      if (friendSteal.blacklistPolicy && friendSteal.blacklistPolicy.enabled) {
        parts.push(friendSteal.blacklistPolicy.strategyLabel || "黑名单策略");
      }
      if ((Number(friendSteal.explicitBlacklistedCount) || 0) > 0) {
        parts.push("手动黑名单 " + friendSteal.explicitBlacklistedCount);
      }
      if ((Number(friendSteal.maskedBlockedCount) || 0) > 0) {
        parts.push("等级规则屏蔽 " + friendSteal.maskedBlockedCount);
      }
      if ((Number(friendSteal.cooldownBlockedCount) || 0) > 0) {
        parts.push("冷却中 " + friendSteal.cooldownBlockedCount);
      }
      messages.push({
        level: "info",
        message: `自动农场 / 好友巡检：${parts.join(" · ")}`,
      });
      if (friendSteal.helpEnabled && (Number(friendSteal.helpableCandidates) || 0) > 0 && (Number(friendSteal.stealableCandidates) || 0) <= 0) {
        messages.push({
          level: "info",
          message: "自动农场 / 好友巡检：本轮无可偷好友，仅执行帮忙巡检",
        });
      } else if ((Number(friendSteal.stealableCandidates) || 0) <= 0) {
        messages.push({
          level: "info",
          message: "自动农场 / 好友巡检：本轮无可偷好友",
        });
      }
    }

    const visits = Array.isArray(friendSteal.visits) ? friendSteal.visits : [];
    visits.forEach((visit) => {
      if (!visit) return;
      const friendLabel = formatAutoFarmFriendName(visit.friend);
      const selective = visit.selective && typeof visit.selective === "object" ? visit.selective : null;
      const selectiveParts = [];
      if (selective && selective.enabled) {
        if (selective.mode === "targeted") selectiveParts.push("逐块收取");
        else if (selective.mode === "skip_whole_farm") selectiveParts.push("整场跳过");
        else if (selective.mode === "one_click") selectiveParts.push("一键收取");
        const skipped = Array.isArray(selective.skipped) ? selective.skipped : [];
        if (skipped.length > 0) selectiveParts.push("跳过黑名单 " + skipped.length + " 块");
        const allowed = Array.isArray(selective.allowedLandIds) ? selective.allowedLandIds : [];
        if (allowed.length > 0) selectiveParts.push("处理地块 " + formatAutoFarmIdList(allowed, 8));
      }
      const helpBefore = normalizeHelpCounts(visit.helpBeforeCounts);
      const helpAfter = normalizeHelpCounts(visit.helpAfterCounts);
      const helpProgress = getHelpProgressFromVisit(visit);
      const helpBeforeTotal = helpBefore.water + helpBefore.eraseGrass + helpBefore.killBug;
      const helpProgressTotal = helpProgress.water + helpProgress.eraseGrass + helpProgress.killBug;
      const visitAction = String(visit.action || "").toLowerCase();
      const harvested = visitAction.includes("harvest")
        || (Number(visit.collectBefore) || 0) > 0
        || (Number(visit.collectAfter) || 0) > 0;
      if (!visit.ok) {
        messages.push({
          level: "warn",
          message: `自动农场 / 好友偷菜 / ${friendLabel}：失败 ${visit.error || visit.reason || "unknown"}${selectiveParts.length ? " · " + selectiveParts.join(" · ") : ""}`,
        });
        return;
      }
      if (visit.reason === "blacklist_strategy_skip_whole_farm") {
        messages.push({
          level: "info",
          message: `自动农场 / 好友偷菜 / ${friendLabel}：命中黑名单作物，跳过整个农场${selectiveParts.length ? " · " + selectiveParts.join(" · ") : ""}`,
        });
        return;
      }
      if (visit.reason === "all_collectable_blacklisted") {
        messages.push({
          level: "info",
          message: `自动农场 / 好友偷菜 / ${friendLabel}：当前可偷地块全部命中黑名单，跳过收取${selectiveParts.length ? " · " + selectiveParts.join(" · ") : ""}`,
        });
        return;
      }
      if (visit.reason === "no_collectable_after_enter") {
        messages.push({
          level: "info",
          message: `自动农场 / 好友偷菜 / ${friendLabel}：进场后无可摘作物${selectiveParts.length ? " · " + selectiveParts.join(" · ") : ""}`,
        });
        return;
      }
      if (visit.reason === "no_actionable_after_enter") {
        messages.push({
          level: "info",
          message: `自动农场 / 好友巡检 / ${friendLabel}：进场后无可偷可帮地块${selectiveParts.length ? " · " + selectiveParts.join(" · ") : ""}`,
        });
        return;
      }
      if (harvested) {
        messages.push({
          level: "info",
          message: `自动农场 / 好友偷菜 / ${friendLabel}：${Number(visit.collectBefore) || 0} → ${Number(visit.collectAfter) || 0}${selectiveParts.length ? " · " + selectiveParts.join(" · ") : ""}`,
        });
      } else if (!visit.helpPerformed) {
        messages.push({
          level: "info",
          message: `自动农场 / 好友偷菜 / ${friendLabel}：已访问${selectiveParts.length ? " · " + selectiveParts.join(" · ") : ""}`,
        });
      }

      if (visit.helpSkipReason === "daily_limit_reached") {
        messages.push({
          level: "info",
          message: `自动农场 / 好友帮忙 / ${friendLabel}：今日已暂停帮忙，跳过`,
        });
        return;
      }

      if (helpBeforeTotal > 0 || helpProgressTotal > 0 || visit.helpPerformed) {
        const helpParts = [];
        if (helpBefore.water > 0 || helpProgress.water > 0) helpParts.push(`浇水 ${helpBefore.water} → ${helpAfter.water}`);
        if (helpBefore.eraseGrass > 0 || helpProgress.eraseGrass > 0) helpParts.push(`除草 ${helpBefore.eraseGrass} → ${helpAfter.eraseGrass}`);
        if (helpBefore.killBug > 0 || helpProgress.killBug > 0) helpParts.push(`除虫 ${helpBefore.killBug} → ${helpAfter.killBug}`);
        if (visit.helpTracked && Number(visit.helpTracked.helpCount) > 0 && Number(visit.helpTracked.dailyLimit) > 0) {
          helpParts.push(`今日累计 ${visit.helpTracked.helpCount}/${visit.helpTracked.dailyLimit}`);
        }
        if (visit.helpLimitReached) {
          helpParts.push("今日帮忙已暂停");
        }
        messages.push({
          level: helpProgressTotal > 0 ? "info" : "warn",
          message: `自动农场 / 好友帮忙 / ${friendLabel}：${helpParts.length ? helpParts.join(" · ") : "无进展"}`,
        });
      }
    });

    if (friendSteal.helpEnabled && friendSteal.helpLimitReached) {
      messages.push({
        level: "info",
        message: `自动农场 / 好友帮忙：今日已暂停，后续帮忙将在北京时间次日恢复（${formatFriendHelpStateSummary(friendSteal.helpState)}）`,
      });
    }

    if (friendSteal.returnHome) {
      messages.push({
        level: friendSteal.returnHome.ok ? "info" : "warn",
        message: `自动农场 / 回家：${friendSteal.returnHome.ok ? "已返回自己农场" : ("失败 " + (friendSteal.returnHome.error || "unknown"))}`,
      });
    }
  }

  const ownActionCount = Array.isArray(ownFarm && ownFarm.tasks && ownFarm.tasks.actions) ? ownFarm.tasks.actions.length : 0;
  const friendVisitCount = Array.isArray(friendSteal && friendSteal.visits) ? friendSteal.visits.length : 0;
  const summary = [
    `自己 ${ownActionCount} 动作`,
    `好友 ${friendVisitCount} 次`,
  ];
  if ((Number(cooldownApplied) || 0) > 0) {
    summary.push(`新增冷却 ${cooldownApplied}`);
  }
  messages.push({
    level: "info",
    message: `自动农场 / 调度完成：${summary.join(" · ")}`,
  });

  return messages;
}

class AutoFarmManager {
  /**
   * @param {{
   *   ensureSession?: () => Promise<any>,
   *   getSession?: () => any,
   *   ensureGameCtl?: (session: any) => Promise<{ injected: boolean, state?: any }>,
   *   callGameCtl?: (session: any, pathName: string, args: any[]) => Promise<any>,
   *   getTransportState?: () => any,
   *   ensureCdp?: () => Promise<any>,
   *   getCdp?: () => any,
   *   projectRoot: string,
   * }} opts
   */
  constructor(opts) {
    this.projectRoot = opts.projectRoot;
    this.ensureSession = typeof opts.ensureSession === "function"
      ? opts.ensureSession
      : opts.ensureCdp;
    this.getSession = typeof opts.getSession === "function"
      ? opts.getSession
      : opts.getCdp;
    this.getTransportState = typeof opts.getTransportState === "function"
      ? opts.getTransportState
      : () => null;
    this.ensureGameCtlImpl = typeof opts.ensureGameCtl === "function"
      ? opts.ensureGameCtl
      : this._ensureGameCtlViaCdp.bind(this);
    this.callGameCtlImpl = typeof opts.callGameCtl === "function"
      ? opts.callGameCtl
      : this._callGameCtlDirect.bind(this);
    this.timer = null;
    this.running = false;
    this.busy = false;
    this.concurrentCollectBusy = false;
    this.externalRuntimeLockCount = 0;
    this.externalRuntimeLockReason = null;
    this.currentRunContext = null;
    this.nextRunAt = null;
    this.lastStartedAt = null;
    this.lastFinishedAt = null;
    this.lastOwnRunAt = 0;
    this.lastFriendRunAt = 0;
    this.lastFriendStealRunAt = 0;
    this.lastFriendHelpRunAt = 0;
    this.lastOwnBaseRunAt = 0;
    this.lastOwnCollectRunAt = 0;
    this.lastOwnPlantRunAt = 0;
    this.lastOwnFertilizerRunAt = 0;
    this.lastError = null;
    this.lastResult = null;
    this.recentEvents = [];
    this.taskStates = Object.fromEntries(
      AUTO_FARM_SCHEDULER_TASK_IDS.map((taskId) => [taskId, createEmptyAutoFarmSchedulerTaskState(taskId)])
    );
    this.todayStatsHistory = Object.create(null);
    this.todayStats = createEmptyTodayStats();
    this.friendVisitCooldowns = new Map();
    this.persistAutoFertilizerStateImpl = typeof opts.persistAutoFertilizerState === "function"
      ? opts.persistAutoFertilizerState
      : null;
    this.persistFriendHelpStateImpl = typeof opts.persistFriendHelpState === "function"
      ? opts.persistFriendHelpState
      : null;
    this.persistTodayStatsImpl = typeof opts.persistTodayStats === "function"
      ? opts.persistTodayStats
      : null;
    this.persistEventImpl = typeof opts.persistEvent === "function"
      ? opts.persistEvent
      : null;
    this.autoFertilizerState = normalizeAutoFertilizerState(opts.initialAutoFertilizerState);
    this.friendHelpState = normalizeFriendHelpState(opts.initialFriendHelpState, null, opts.friendHelpDailyLimit);
    this.autoFertilizerStatePersistChain = Promise.resolve(false);
    this.friendHelpStatePersistChain = Promise.resolve(false);
    this.todayStatsPersistChain = Promise.resolve(false);
    this.lastPersistedAutoFertilizerStateSerialized = JSON.stringify(serializeAutoFertilizerState(this.autoFertilizerState));
    this.lastPersistedFriendHelpStateSerialized = JSON.stringify(serializeFriendHelpState(this.friendHelpState, null, opts.friendHelpDailyLimit));
    this.lastPersistedTodayStatsSerialized = null;
    this.config = normalizeAutoFarmConfig({});
    this.replaceTodayStatsHistory(opts.initialTodayStatsHistory, { persist: false });
  }

  updateConfig(raw) {
    this.config = normalizeAutoFarmConfig({ ...this.config, ...(raw && typeof raw === "object" ? raw : {}) });
    return this.config;
  }

  _getTaskState(taskId) {
    if (!this.taskStates[taskId]) {
      this.taskStates[taskId] = createEmptyAutoFarmSchedulerTaskState(taskId);
    }
    return this.taskStates[taskId];
  }

  _getTaskLabel(taskId) {
    const def = AUTO_FARM_SCHEDULER_TASK_DEFS[taskId] || {};
    return def.label || taskId;
  }

  _getTaskStaticOrder(taskId) {
    const index = AUTO_FARM_SCHEDULER_TASK_IDS.indexOf(taskId);
    return index >= 0 ? index : AUTO_FARM_SCHEDULER_TASK_IDS.length + 1;
  }

  _getTaskSchedulerConfig(taskId) {
    const src = this.config && this.config.autoFarmSchedulerTasks && typeof this.config.autoFarmSchedulerTasks === "object"
      ? this.config.autoFarmSchedulerTasks[taskId]
      : null;
    return normalizeAutoFarmSchedulerTaskConfig(taskId, src);
  }

  _getTaskIntervalSec(taskId) {
    if (taskId === "own_base") return Math.max(1, Number(this.config.autoFarmOwnBaseIntervalSec) || 30);
    if (taskId === "own_collect") return Math.max(1, Number(this.config.autoFarmOwnCollectIntervalSec) || 30);
    if (taskId === "own_plant") return Math.max(1, Number(this.config.autoFarmPlantIntervalSec) || 30);
    if (taskId === "own_fertilizer") return Math.max(1, Number(this.config.autoFarmFertilizerIntervalSec) || 30);
    if (taskId === "friend_steal") return Math.max(1, Number(this.config.autoFarmFriendStealIntervalSec) || 90);
    if (taskId === "friend_help") return Math.max(1, Number(this.config.autoFarmFriendHelpIntervalSec) || 90);
    return 60;
  }

  _isOwnBaseTaskEnabled() {
    const ownEnabled = this.config.autoFarmOwnEnabled === true;
    const hasBaseAction = (
      this.config.autoFarmOwnEraseGrassEnabled === true
      || this.config.autoFarmOwnWaterEnabled === true
      || this.config.autoFarmOwnKillBugEnabled === true
    );
    return ownEnabled && hasBaseAction;
  }

  _isOwnPlantTaskEnabled() {
    const ownEnabled = this.config.autoFarmOwnEnabled === true;
    const plantConfigured = (
      String(this.config.autoFarmPlantPrimaryMode || this.config.autoFarmPlantMode || "none") !== "none"
      || String(this.config.autoFarmPlantSecondaryMode || "none") !== "none"
    );
    return ownEnabled && plantConfigured;
  }

  _isTaskEnabled(taskId) {
    if (taskId === "own_base") return this._isOwnBaseTaskEnabled();
    if (taskId === "own_collect") return this.config.autoFarmOwnEnabled === true && this.config.autoFarmOwnCollectEnabled === true;
    if (taskId === "own_plant") return this._isOwnPlantTaskEnabled();
    if (taskId === "own_fertilizer") {
      return (
        this.config.autoFarmOwnEnabled === true
        && this.config.autoFarmFertilizerEnabled === true
        && String(this.config.autoFarmFertilizerMode || "none") !== "none"
      );
    }
    if (taskId === "friend_steal") return this.config.autoFarmFriendEnabled === true;
    if (taskId === "friend_help") return this._isFriendHelpTaskEnabled();
    return false;
  }

  _getTaskLastRunAtMs(taskId) {
    if (taskId === "own_base") return this.lastOwnBaseRunAt;
    if (taskId === "own_collect") return this.lastOwnCollectRunAt;
    if (taskId === "own_plant") return this.lastOwnPlantRunAt;
    if (taskId === "own_fertilizer") return this.lastOwnFertilizerRunAt;
    if (taskId === "friend_steal") return this.lastFriendStealRunAt;
    if (taskId === "friend_help") return this.lastFriendHelpRunAt;
    return 0;
  }

  _setTaskLastRunAt(taskId, now) {
    if (taskId === "own_base") {
      this.lastOwnBaseRunAt = now;
      this.lastOwnRunAt = now;
      return;
    }
    if (taskId === "own_collect") {
      this.lastOwnCollectRunAt = now;
      this.lastOwnRunAt = Math.max(this.lastOwnRunAt || 0, now);
      return;
    }
    if (taskId === "own_plant") {
      this.lastOwnPlantRunAt = now;
      this.lastOwnRunAt = Math.max(this.lastOwnRunAt || 0, now);
      return;
    }
    if (taskId === "own_fertilizer") {
      this.lastOwnFertilizerRunAt = now;
      this.lastOwnRunAt = Math.max(this.lastOwnRunAt || 0, now);
      return;
    }
    if (taskId === "friend_steal") {
      this.lastFriendStealRunAt = now;
      this.lastFriendRunAt = Math.max(this.lastFriendRunAt || 0, now);
      return;
    }
    if (taskId === "friend_help") {
      this.lastFriendHelpRunAt = now;
      this.lastFriendRunAt = Math.max(this.lastFriendRunAt || 0, now);
    }
  }

  _getTaskDueAtMs(taskId, now, force) {
    if (!this._isTaskEnabled(taskId)) return null;
    if (force) return Number(now) || Date.now();
    const lastRunAt = this._getTaskLastRunAtMs(taskId);
    if (!lastRunAt || lastRunAt <= 0) return Number(now) || Date.now();
    return lastRunAt + this._getTaskIntervalSec(taskId) * 1000;
  }

  _getOrderedTaskIds() {
    return AUTO_FARM_SCHEDULER_TASK_IDS.slice().sort((a, b) => {
      const priorityDiff = this._getTaskSchedulerConfig(b).priority - this._getTaskSchedulerConfig(a).priority;
      if (priorityDiff !== 0) return priorityDiff;
      return this._getTaskStaticOrder(a) - this._getTaskStaticOrder(b);
    });
  }

  _getSchedulerStateSnapshot() {
    const now = Date.now();
    const tasks = this._getOrderedTaskIds().map((taskId) => {
      const runtime = this._getTaskState(taskId);
      const dueAtMs = this._getTaskDueAtMs(taskId, now, false);
      return {
        taskId,
        label: this._getTaskLabel(taskId),
        enabled: this._isTaskEnabled(taskId),
        priority: this._getTaskSchedulerConfig(taskId).priority,
        intervalSec: this._getTaskIntervalSec(taskId),
        dueAt: dueAtMs ? new Date(dueAtMs).toISOString() : null,
        lastStartedAt: runtime.lastStartedAt,
        lastFinishedAt: runtime.lastFinishedAt,
        lastSuccessAt: runtime.lastSuccessAt,
        lastDurationMs: runtime.lastDurationMs,
        lastError: runtime.lastError,
        lastResultSummary: runtime.lastResultSummary,
        runCount: runtime.runCount,
        busy: runtime.busy === true,
      };
    });
    return {
      enabled: this.config.autoFarmSchedulerEnabled !== false,
      minGapMs: Number(this.config.autoFarmSchedulerMinGapMs) || 0,
      runningTaskId: this.currentRunContext && this.currentRunContext.taskId ? this.currentRunContext.taskId : null,
      tasks,
    };
  }

  getState() {
    void this._rolloverFriendHelpStateIfNeeded(Date.now(), {
      reason: "state_read_rollover_check",
      awaitPersist: false,
    });
    this._ensureTodayStatsFresh();
    this._pruneFriendVisitCooldowns();
    return {
      running: this.running,
      busy: this.busy,
      concurrentCollectBusy: this.concurrentCollectBusy,
      runtimeExclusiveBusy: this.externalRuntimeLockCount > 0,
      runtimeExclusiveReason: this.externalRuntimeLockReason,
      nextRunAt: this.nextRunAt,
      lastStartedAt: this.lastStartedAt,
      lastFinishedAt: this.lastFinishedAt,
      lastOwnRunAt: this.lastOwnRunAt ? new Date(this.lastOwnRunAt).toISOString() : null,
      lastOwnBaseRunAt: this.lastOwnBaseRunAt ? new Date(this.lastOwnBaseRunAt).toISOString() : null,
      lastOwnCollectRunAt: this.lastOwnCollectRunAt ? new Date(this.lastOwnCollectRunAt).toISOString() : null,
      lastOwnPlantRunAt: this.lastOwnPlantRunAt ? new Date(this.lastOwnPlantRunAt).toISOString() : null,
      lastOwnFertilizerRunAt: this.lastOwnFertilizerRunAt ? new Date(this.lastOwnFertilizerRunAt).toISOString() : null,
      lastFriendRunAt: this.lastFriendRunAt ? new Date(this.lastFriendRunAt).toISOString() : null,
      lastFriendStealRunAt: this.lastFriendStealRunAt ? new Date(this.lastFriendStealRunAt).toISOString() : null,
      lastFriendHelpRunAt: this.lastFriendHelpRunAt ? new Date(this.lastFriendHelpRunAt).toISOString() : null,
      lastError: this.lastError,
      lastResult: this.lastResult,
      todayStats: { ...this.todayStats },
      statsHistory: this.getTodayStatsHistorySnapshot(),
      config: { ...this.config },
      scheduler: this._getSchedulerStateSnapshot(),
      friendVisitCooldowns: Array.from(this.friendVisitCooldowns.entries()).map(([gid, untilMs]) => ({
        gid,
        untilMs,
        untilAt: new Date(untilMs).toISOString(),
      })),
      friendHelpState: this.getFriendHelpStateSnapshot(),
      recentEvents: [...this.recentEvents],
      runtime: this.getTransportState(),
    };
  }

  getAutoFertilizerStateSnapshot() {
    return cloneAutoFertilizerStateForSave(this.autoFertilizerState);
  }

  replaceAutoFertilizerState(raw, opts) {
    this.autoFertilizerState = normalizeAutoFertilizerState(raw);
    const snapshot = this.getAutoFertilizerStateSnapshot();
    this.lastPersistedAutoFertilizerStateSerialized = JSON.stringify(serializeAutoFertilizerState(snapshot));
    if (opts && opts.persist === true) {
      void this._persistAutoFertilizerState("replace");
    }
    return snapshot;
  }

  getFriendHelpStateSnapshot() {
    return normalizeFriendHelpState(this.friendHelpState, null, this.config.autoFarmFriendHelpDailyLimit);
  }

  getTodayStatsHistorySnapshot() {
    const entries = buildTodayStatsHistoryEntries(this.todayStatsHistory);
    return {
      retentionDays: AUTO_FARM_DAILY_STATS_RETENTION_DAYS,
      todayKey: this.todayStats && this.todayStats.dateKey ? this.todayStats.dateKey : getTodayKey(),
      availableDateKeys: entries.map((item) => item.dateKey),
      days: entries.map((item) => ({ ...item })),
    };
  }

  replaceTodayStatsHistory(rawHistory, opts) {
    const source = Array.isArray(rawHistory) ? rawHistory : [];
    const todayKey = getTodayKey();
    const hasPersistedToday = source.some((item) => item && item.dateKey === todayKey);
    const historyMap = normalizeTodayStatsHistory(rawHistory, Date.now());
    this.todayStatsHistory = historyMap;
    this.todayStats = historyMap[todayKey]
      ? normalizeTodayStats(historyMap[todayKey], todayKey)
      : createEmptyTodayStats(todayKey);
    this.todayStatsHistory[this.todayStats.dateKey] = this.todayStats;
    this.lastPersistedTodayStatsSerialized = hasPersistedToday
      ? JSON.stringify(serializeAutoFarmDailyStats(this.todayStats))
      : null;
    if (opts && opts.persist === true) {
      void this._persistTodayStats("replace");
    }
    return this.getTodayStatsHistorySnapshot();
  }

  replaceFriendHelpState(raw, opts) {
    this.friendHelpState = normalizeFriendHelpState(raw, null, this.config.autoFarmFriendHelpDailyLimit);
    const snapshot = this.getFriendHelpStateSnapshot();
    this.lastPersistedFriendHelpStateSerialized = JSON.stringify(serializeFriendHelpState(snapshot, null, this.config.autoFarmFriendHelpDailyLimit));
    if (opts && opts.persist === true) {
      void this._persistFriendHelpState("replace");
    }
    return snapshot;
  }

  async _rolloverFriendHelpStateIfNeeded(now, opts) {
    const at = now || Date.now();
    const options = opts && typeof opts === "object" ? opts : {};
    const beforeSerialized = JSON.stringify(serializeFriendHelpState(this.friendHelpState, at, this.config.autoFarmFriendHelpDailyLimit));
    const normalized = normalizeFriendHelpState(this.friendHelpState, at, this.config.autoFarmFriendHelpDailyLimit);
    const afterSerialized = JSON.stringify(serializeFriendHelpState(normalized, at, this.config.autoFarmFriendHelpDailyLimit));
    if (beforeSerialized === afterSerialized) {
      return false;
    }
    this.friendHelpState = normalized;
    if (options.persist !== false) {
      const reason = options.reason ? String(options.reason) : "friend_help_rollover";
      if (options.awaitPersist === false) {
        void this._persistFriendHelpState(reason);
      } else {
        await this._persistFriendHelpState(reason);
      }
    }
    return true;
  }

  async recordFriendHelpRound(opts) {
    await this._rolloverFriendHelpStateIfNeeded((opts && opts.at) || Date.now(), {
      reason: "record_friend_help_rollover_check",
    });
    const mergedOpts = {
      ...(opts && typeof opts === "object" ? opts : {}),
      dailyLimit: this.config.autoFarmFriendHelpDailyLimit,
    };
    const result = recordFriendHelpRound(this.friendHelpState, mergedOpts);
    if (!(opts && opts.persist === false)) {
      await this._persistFriendHelpState(opts && opts.reason ? opts.reason : "record_friend_help");
    }
    return result;
  }

  async recordFertilizerGrid(grid, type, opts) {
    const entry = grid && typeof grid === "object" ? grid : {};
    const landId = toPositiveInt(entry.landId);
    const plantId = toPositiveInt(entry.plantId);
    const currentSeason = toPositiveInt(entry.currentSeason);
    const totalSeason = Math.max(1, toPositiveInt(entry.totalSeason) || currentSeason || 1);
    if (landId <= 0 || plantId <= 0 || currentSeason <= 0) {
      return { ok: false, reason: "invalid_grid" };
    }
    const landKey = String(landId);
    const nextType = normalizeAutoFertilizerAppliedType(type);
    const seasonKey = `${landId}:${plantId}:${currentSeason}`;
    const marks = this.autoFertilizerState.landMarks && typeof this.autoFertilizerState.landMarks === "object"
      ? this.autoFertilizerState.landMarks
      : (this.autoFertilizerState.landMarks = Object.create(null));
    const current = marks[landKey];
    const next = current && current.seasonKey === seasonKey
      ? current
      : {
          landId,
          seasonKey,
          plantId,
          currentSeason,
          totalSeason,
          normalApplied: false,
          organicApplied: false,
          normalBlocked: false,
          organicBlocked: false,
          normalNoEffectCount: 0,
          organicNoEffectCount: 0,
          normalBlockedReason: null,
          organicBlockedReason: null,
          normalEvidence: null,
          organicEvidence: null,
          updatedAt: null,
        };
    next.plantId = plantId;
    next.currentSeason = currentSeason;
    next.totalSeason = totalSeason;
    const recordedAt = new Date().toISOString();
    const evidence = {
      source: "manual_record",
      at: recordedAt,
      beforeMatureInSec: toFiniteNumberOrNull(entry.matureInSec),
      afterMatureInSec: null,
      deltaMatureInSec: null,
    };
    if (nextType === "organic") {
      next.organicApplied = true;
      next.organicBlocked = false;
      next.organicNoEffectCount = 0;
      next.organicBlockedReason = null;
      next.organicEvidence = evidence;
    } else {
      next.normalApplied = true;
      next.normalBlocked = false;
      next.normalNoEffectCount = 0;
      next.normalBlockedReason = null;
      next.normalEvidence = evidence;
    }
    next.updatedAt = recordedAt;
    marks[landKey] = next;
    this.autoFertilizerState.updatedAt = next.updatedAt;
    if (!(opts && opts.persist === false)) {
      await this._persistAutoFertilizerState(opts && opts.reason ? opts.reason : `record_${nextType}`);
    }
    return {
      ok: true,
      mark: { ...next },
    };
  }

  async recordWarehouseSell(opts) {
    const input = opts && typeof opts === "object" ? opts : {};
    const soldCount = Math.max(0, Number(input.soldCount != null ? input.soldCount : input.totalSoldCount) || 0);
    const soldDistinct = Math.max(0, Number(input.soldDistinct) || 0);
    const estimatedSellPrice = Math.max(0, Number(input.totalEstimatedSellPrice != null ? input.totalEstimatedSellPrice : input.estimatedSellPrice) || 0);
    if (soldCount <= 0 && soldDistinct <= 0 && estimatedSellPrice <= 0) {
      return {
        ok: false,
        reason: "empty_sell",
      };
    }
    const dateKey = getTodayKey(input.at || Date.now());
    this._ensureTodayStatsFresh(input.at || Date.now());
    if (!this.todayStats || this.todayStats.dateKey !== dateKey) {
      const existing = this.todayStatsHistory[dateKey];
      this.todayStats = existing
        ? normalizeTodayStats(existing, dateKey)
        : createEmptyTodayStats(dateKey);
      this.todayStatsHistory[dateKey] = this.todayStats;
    }
    const recordedSoldCount = soldCount > 0 ? soldCount : soldDistinct;
    const recordedSellGold = Math.max(0, Math.floor(estimatedSellPrice));
    this.todayStats.sell += recordedSoldCount;
    this.todayStats.sellGold += recordedSellGold;
    this.todayStatsHistory[this.todayStats.dateKey] = normalizeTodayStats(this.todayStats, this.todayStats.dateKey);
    this.todayStatsHistory = pruneTodayStatsHistoryMap(this.todayStatsHistory);
    await this._persistTodayStats(input.reason || "warehouse_sell");
    return {
      ok: true,
      dateKey: this.todayStats.dateKey,
      soldCount: recordedSoldCount,
      soldDistinct,
      estimatedSellPrice,
      sellGold: recordedSellGold,
    };
  }

  start(rawConfig) {
    if (rawConfig) this.updateConfig(rawConfig);
    if (this._getOrderedTaskIds().filter((taskId) => this._isTaskEnabled(taskId)).length <= 0) {
      throw new Error("自动化已启动的项目为空，请至少启用自己农场、好友偷菜或好友帮忙");
    }
    this.running = true;
    this._pushEvent("info", "自动化已启动");
    this._schedule(50);
    return this.getState();
  }

  stop(reason = "manual") {
    if (this.busy && this.currentRunContext) {
      this.currentRunContext.cancelled = true;
      this.currentRunContext.reason = String(reason || "manual");
    }
    this.running = false;
    this.nextRunAt = null;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this._pushEvent("info", `自动化已停止: ${reason}`);
    return this.getState();
  }

  async runOnce(rawConfig) {
    if (rawConfig) this.updateConfig(rawConfig);
    const runnableTaskIds = this._getOrderedTaskIds().filter((taskId) => this._isTaskEnabled(taskId));
    if (runnableTaskIds.length <= 0) {
      throw new Error("自动化已启动的项目为空，请至少启用自己农场、好友偷菜或好友帮忙");
    }
    if (this.busy || this.externalRuntimeLockCount > 0) {
      throw new Error("自动化正在执行中");
    }
    for (let i = 0; i < runnableTaskIds.length; i += 1) {
      await this._runCycle(true, runnableTaskIds[i]);
    }
    return this.getState();
  }

  async runTaskNow(taskId, rawConfig) {
    if (rawConfig) this.updateConfig(rawConfig);
    const selectedTaskId = String(taskId || "").trim();
    if (!AUTO_FARM_SCHEDULER_TASK_IDS.includes(selectedTaskId)) {
      throw new Error(`unknown task: ${selectedTaskId || "empty"}`);
    }
    if (!this._isTaskEnabled(selectedTaskId)) {
      throw new Error(`task disabled: ${selectedTaskId}`);
    }
    if (this.busy || this.externalRuntimeLockCount > 0) {
      throw new Error("自动化正在执行中");
    }
    return await this._runCycle(true, selectedTaskId);
  }

  async waitForRuntimeIdle(opts) {
    const options = opts && typeof opts === "object" ? opts : {};
    const timeoutMs = Math.max(1000, Number(options.timeoutMs) || 90 * 1000);
    const pollMs = Math.max(100, Number(options.pollMs) || 250);
    const waitLabel = options.waitLabel ? String(options.waitLabel) : "当前操作";
    const startedAt = Date.now();
    while (this.busy || this.externalRuntimeLockCount > 0) {
      const waitedMs = Date.now() - startedAt;
      if (waitedMs >= timeoutMs) {
        const error = new Error(`等待自动农场空闲超时，${waitLabel}已顺延`);
        error.code = "AUTO_FARM_RUNTIME_BUSY_TIMEOUT";
        error.waitedMs = waitedMs;
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, Math.min(pollMs, timeoutMs - waitedMs)));
    }
    return {
      waitedMs: Math.max(0, Date.now() - startedAt),
    };
  }

  async runWithRuntimeExclusive(label, task, opts) {
    if (typeof task !== "function") {
      throw new Error("runtime exclusive task is required");
    }
    const waitResult = await this.waitForRuntimeIdle({
      ...(opts && typeof opts === "object" ? opts : {}),
      waitLabel: opts && opts.waitLabel ? opts.waitLabel : label,
    });
    this.externalRuntimeLockCount += 1;
    if (label) this.externalRuntimeLockReason = String(label);
    try {
      return await task(waitResult);
    } finally {
      this.externalRuntimeLockCount = Math.max(0, this.externalRuntimeLockCount - 1);
      if (this.externalRuntimeLockCount <= 0) {
        this.externalRuntimeLockCount = 0;
        this.externalRuntimeLockReason = null;
      }
    }
  }

  _pushEvent(level, message, extra) {
    const payload = extra && typeof extra === "object" ? { ...extra } : null;
    const entry = {
      time: new Date().toISOString(),
      level,
      message,
    };
    if (payload && payload.cycleId) {
      entry.cycleId = String(payload.cycleId);
      delete payload.cycleId;
    }
    if (payload && payload.cycleSeq != null) {
      entry.cycleSeq = Number(payload.cycleSeq) || 0;
      delete payload.cycleSeq;
    }
    if (payload && payload.category) {
      entry.category = String(payload.category);
      delete payload.category;
    }
    if (payload && payload.taskId) {
      entry.taskId = String(payload.taskId);
      delete payload.taskId;
    }
    if (payload && payload.taskLabel) {
      entry.taskLabel = String(payload.taskLabel);
      delete payload.taskLabel;
    }
    if (payload && Object.keys(payload).length > 0) entry.extra = payload;
    this.recentEvents.push(entry);
    if (this.recentEvents.length > AUTO_FARM_RECENT_EVENT_LIMIT) {
      this.recentEvents.splice(0, this.recentEvents.length - AUTO_FARM_RECENT_EVENT_LIMIT);
    }
    if (this.persistEventImpl) {
      void Promise.resolve()
        .then(() => this.persistEventImpl(entry))
        .catch(() => {});
    }
  }

  _ensureTodayStatsFresh(now) {
    const dateKey = getTodayKey(now);
    if (!this.todayStats || this.todayStats.dateKey !== dateKey) {
      const existing = this.todayStatsHistory[dateKey];
      this.todayStats = existing
        ? normalizeTodayStats(existing, dateKey)
        : createEmptyTodayStats(dateKey);
      this.todayStatsHistory[dateKey] = this.todayStats;
      this.todayStatsHistory = pruneTodayStatsHistoryMap(this.todayStatsHistory);
      this.lastPersistedTodayStatsSerialized = existing
        ? JSON.stringify(serializeAutoFarmDailyStats(this.todayStats))
        : null;
      void this._persistTodayStats("rollover");
    }
    return this.todayStats;
  }

  _schedule(delayMs) {
    if (!this.running) return;
    if (this.timer) clearTimeout(this.timer);
    const delay = Math.max(25, Number(delayMs) || 25);
    this.nextRunAt = new Date(Date.now() + delay).toISOString();
    this.timer = setTimeout(() => {
      this.timer = null;
      void this._tick().catch((error) => {
        const err = error instanceof Error ? error : new Error(String(error));
        this.lastFinishedAt = new Date().toISOString();
        this.lastError = err.message;
        this._pushEvent("error", `调度异常: ${err.message}`);
        if (this.config.autoFarmStopOnError) {
          this.stop(`error: ${err.message}`);
          return;
        }
        if (this.running) {
          this._schedule(1000);
        }
      });
    }, delay);
  }

  _pruneFriendVisitCooldowns(nowMs) {
    const now = Number.isFinite(nowMs) ? nowMs : Date.now();
    for (const [gid, untilMs] of this.friendVisitCooldowns.entries()) {
      if (!Number.isFinite(untilMs) || untilMs <= now) {
        this.friendVisitCooldowns.delete(gid);
      }
    }
  }

  async _persistTodayStats(reason) {
    if (!this.persistTodayStatsImpl) return false;
    const persist = this.persistTodayStatsImpl;
    this.todayStatsPersistChain = this.todayStatsPersistChain
      .catch(() => false)
      .then(async () => {
        this._ensureTodayStatsFresh();
        const snapshot = normalizeTodayStats(this.todayStats, this.todayStats.dateKey);
        const serialized = JSON.stringify(serializeAutoFarmDailyStats(snapshot));
        if (serialized === this.lastPersistedTodayStatsSerialized) {
          return false;
        }
        snapshot.updatedAt = new Date().toISOString();
        this.todayStatsHistory[snapshot.dateKey] = snapshot;
        this.todayStatsHistory = pruneTodayStatsHistoryMap(this.todayStatsHistory);
        try {
          await persist(snapshot, { reason: reason || "unknown" });
          this.todayStats = snapshot;
          this.lastPersistedTodayStatsSerialized = JSON.stringify(serializeAutoFarmDailyStats(snapshot));
          return true;
        } catch (error) {
          this._pushEvent("warn", `每日统计持久化失败: ${toErrorMessage(error)}`, {
            category: "today_stats_persist_failed",
            reason: reason || "unknown",
          });
          return false;
        }
      });
    return await this.todayStatsPersistChain;
  }

  async _persistAutoFertilizerState(reason) {
    if (!this.persistAutoFertilizerStateImpl) return false;
    const persist = this.persistAutoFertilizerStateImpl;
    this.autoFertilizerStatePersistChain = this.autoFertilizerStatePersistChain
      .catch(() => false)
      .then(async () => {
        const serialized = JSON.stringify(serializeAutoFertilizerState(this.autoFertilizerState));
        if (serialized === this.lastPersistedAutoFertilizerStateSerialized) {
          return false;
        }
        const snapshot = this.getAutoFertilizerStateSnapshot();
        snapshot.updatedAt = new Date().toISOString();
        try {
          await persist(snapshot, { reason: reason || "unknown" });
          this.autoFertilizerState.updatedAt = snapshot.updatedAt;
          this.lastPersistedAutoFertilizerStateSerialized = serialized;
          return true;
        } catch (error) {
          this._pushEvent("warn", `自动施肥状态持久化失败: ${toErrorMessage(error)}`, {
            category: "auto_fertilizer_state_persist_failed",
            reason: reason || "unknown",
          });
          return false;
        }
      });
    return await this.autoFertilizerStatePersistChain;
  }

  async _persistFriendHelpState(reason) {
    if (!this.persistFriendHelpStateImpl) return false;
    const persist = this.persistFriendHelpStateImpl;
    this.friendHelpStatePersistChain = this.friendHelpStatePersistChain
      .catch(() => false)
      .then(async () => {
        const serialized = JSON.stringify(serializeFriendHelpState(this.friendHelpState, null, this.config.autoFarmFriendHelpDailyLimit));
        if (serialized === this.lastPersistedFriendHelpStateSerialized) {
          return false;
        }
        const snapshot = this.getFriendHelpStateSnapshot();
        snapshot.updatedAt = new Date().toISOString();
        try {
          await persist(snapshot, { reason: reason || "unknown" });
          this.friendHelpState.updatedAt = snapshot.updatedAt;
          this.lastPersistedFriendHelpStateSerialized = JSON.stringify(serializeFriendHelpState(snapshot, null, this.config.autoFarmFriendHelpDailyLimit));
          return true;
        } catch (error) {
          this._pushEvent("warn", `好友帮忙次数状态持久化失败: ${toErrorMessage(error)}`, {
            category: "friend_help_state_persist_failed",
            reason: reason || "unknown",
          });
          return false;
        }
      });
    return await this.friendHelpStatePersistChain;
  }

  _buildFriendVisitCooldownEntries(nowMs) {
    this._pruneFriendVisitCooldowns(nowMs);
    return Array.from(this.friendVisitCooldowns.entries()).map(([gid, untilMs]) => ({
      gid,
      untilMs,
    }));
  }

  _isFriendHelpTaskEnabled() {
    return this.config.autoFarmFriendHelpEnabled === true;
  }

  _applyFriendVisitCooldowns(friendSteal, nowMs) {
    this._pruneFriendVisitCooldowns(nowMs);
    const visits = Array.isArray(friendSteal && friendSteal.visits) ? friendSteal.visits : [];
    let applied = 0;
    for (let i = 0; i < visits.length; i += 1) {
      const visit = visits[i];
      const gid = Number(visit && visit.friend && visit.friend.gid);
      if (!Number.isFinite(gid) || gid <= 0) continue;
      const cooldown = shouldApplyFriendCooldown(visit);
      if (!cooldown) continue;
      const untilMs = nowMs + cooldown.ms;
      const current = this.friendVisitCooldowns.get(gid) || 0;
      if (untilMs > current) {
        this.friendVisitCooldowns.set(gid, untilMs);
        applied += 1;
      }
    }
    return applied;
  }

  _computeNextDelayMs(now) {
    const baseNow = Number(now) || Date.now();
    const delays = AUTO_FARM_SCHEDULER_TASK_IDS
      .map((taskId) => this._getTaskDueAtMs(taskId, baseNow, false))
      .filter((dueAtMs) => Number.isFinite(dueAtMs) && dueAtMs != null)
      .map((dueAtMs) => Math.max(0, dueAtMs - baseNow));
    if (delays.length <= 0) return 1000;
    return Math.max(250, Math.min(...delays));
  }

  _pickNextDueTask(now, force) {
    const baseNow = Number(now) || Date.now();
    const candidates = AUTO_FARM_SCHEDULER_TASK_IDS
      .map((taskId) => {
        const dueAtMs = this._getTaskDueAtMs(taskId, baseNow, force);
        if (dueAtMs == null) return null;
        return {
          taskId,
          taskLabel: this._getTaskLabel(taskId),
          dueAtMs,
          priority: this._getTaskSchedulerConfig(taskId).priority,
        };
      })
      .filter(Boolean)
      .filter((item) => force || item.dueAtMs <= baseNow);
    if (candidates.length <= 0) return null;
    candidates.sort((a, b) => {
      if (b.priority !== a.priority) return b.priority - a.priority;
      if (a.dueAtMs !== b.dueAtMs) return a.dueAtMs - b.dueAtMs;
      return this._getTaskStaticOrder(a.taskId) - this._getTaskStaticOrder(b.taskId);
    });
    return candidates[0];
  }

  _buildDueFlagsForTask(taskId) {
    return {
      ownDue: taskId === "own_base" || taskId === "own_collect" || taskId === "own_plant" || taskId === "own_fertilizer",
      friendStealDue: taskId === "friend_steal",
      friendHelpDue: taskId === "friend_help",
      friendDue: taskId === "friend_steal" || taskId === "friend_help",
    };
  }

  _buildTaskCycleOptions(taskId, runContext) {
    const baseOptions = {
      timeoutMs: this.config.autoFarmRpcTimeoutMs,
      autoPlantMode: "none",
      autoPlantPrimaryMode: "none",
      autoPlantSecondaryMode: "none",
      autoPlantSeedId: this.config.autoFarmPlantSeedId || 0,
      autoPlantBackpackSeedPriority: Array.isArray(this.config.autoFarmPlantBackpackSeedPriority)
        ? [...this.config.autoFarmPlantBackpackSeedPriority]
        : [],
      autoPlantBackpackForcePriority: !!this.config.autoFarmPlantBackpackForcePriority,
      autoPlantMaxLevel: this.config.autoFarmPlantMaxLevel || 0,
      autoFertilizerEnabled: false,
      autoFertilizerMode: this.config.autoFarmFertilizerMode || "none",
      autoFertilizerMultiSeason: !!this.config.autoFarmFertilizerMultiSeason,
      autoFertilizerHarvestLinkEnabled: !!this.config.autoFarmFertilizerHarvestLinkEnabled,
      autoFertilizerLandTypes: Array.isArray(this.config.autoFarmFertilizerLandTypes)
        ? [...this.config.autoFarmFertilizerLandTypes]
        : ["gold", "black", "red", "normal"],
      autoFertilizerRushThresholdSec: this.config.autoFarmFertilizerRushThresholdSec != null
        ? this.config.autoFarmFertilizerRushThresholdSec
        : 300,
      autoFertilizerBatchChunkSize: this.config.autoFarmFertilizerBatchChunkSize,
      fertilizeBatchCallTimeoutMs: this.config.autoFarmFertilizeBatchCallTimeoutMs,
      fertilizeSingleCallTimeoutMs: this.config.autoFarmFertilizeSingleCallTimeoutMs,
      autoFertilizerState: this.autoFertilizerState,
      enterWaitMs: this.config.autoFarmEnterWaitMs,
      actionWaitMs: this.config.autoFarmActionWaitMs,
      maxFriends: this.config.autoFarmMaxFriends,
      refreshFriendList: this.config.autoFarmRefreshFriendList,
      returnHome: this.config.autoFarmReturnHome,
      friendHelpDailyLimit: this.config.autoFarmFriendHelpDailyLimit,
      friendHelpState: this.friendHelpState,
      friendQuietHoursEnabled: !!this.config.autoFarmFriendQuietHoursEnabled,
      friendQuietHoursStart: this.config.autoFarmFriendQuietHoursStart || "23:00",
      friendQuietHoursEnd: this.config.autoFarmFriendQuietHoursEnd || "07:00",
      friendWhitelistEnabled: this.config.autoFarmFriendWhitelistEnabled === true,
      friendWhitelistScopes: Array.isArray(this.config.autoFarmFriendWhitelistScopes)
        ? [...this.config.autoFarmFriendWhitelistScopes]
        : [],
      friendWhitelist: Array.isArray(this.config.autoFarmFriendWhitelist)
        ? [...this.config.autoFarmFriendWhitelist]
        : [],
      friendBlacklistEnabled: this.config.autoFarmFriendBlacklistEnabled === true,
      friendBlacklistScopes: Array.isArray(this.config.autoFarmFriendBlacklistScopes)
        ? [...this.config.autoFarmFriendBlacklistScopes]
        : [],
      friendBlockMaskedStealers: this.config.autoFarmFriendBlockMaskedStealers !== false,
      friendBlacklist: Array.isArray(this.config.autoFarmFriendBlacklist)
        ? [...this.config.autoFarmFriendBlacklist]
        : [],
      friendMaskedBlacklistEnabled: this.config.autoFarmFriendMaskedBlacklistEnabled === true,
      friendMaskedBlacklistMaxLevel: this.config.autoFarmFriendMaskedBlacklistMaxLevel,
      friendVisitCooldowns: this._buildFriendVisitCooldownEntries(Date.now()),
      friendStealPlantBlacklistEnabled: this.config.autoFarmFriendStealPlantBlacklistEnabled === true,
      friendStealPlantBlacklistStrategy: this.config.autoFarmFriendStealPlantBlacklistStrategy,
      friendStealPlantBlacklist: Array.isArray(this.config.autoFarmFriendStealPlantBlacklist)
        ? [...this.config.autoFarmFriendStealPlantBlacklist]
        : [],
      stopOnError: this.config.autoFarmStopOnError,
      runContext,
      ownFarmEnabled: false,
      includeCollect: false,
      includeEraseGrass: false,
      includeWater: false,
      includeKillBug: false,
      friendStealEnabled: false,
      friendHelpEnabled: false,
    };

    if (taskId === "own_base") {
      return {
        ...baseOptions,
        ownFarmEnabled: true,
        includeCollect: false,
        includeEraseGrass: this.config.autoFarmOwnEraseGrassEnabled !== false,
        includeWater: this.config.autoFarmOwnWaterEnabled !== false,
        includeKillBug: this.config.autoFarmOwnKillBugEnabled !== false,
        reportProgress: (event) => {
          if (!event || !event.message) return;
          this._pushEvent(event.level || "info", `自动农场 / 基础任务 / ${event.message}`, {
            category: "task_progress",
            taskId,
            taskLabel: this._getTaskLabel(taskId),
            event,
          });
        },
      };
    }

    if (taskId === "own_collect") {
      return {
        ...baseOptions,
        ownFarmEnabled: true,
        includeCollect: true,
        collectOnlyWhenOwnFarm: this.config.autoFarmOwnCollectOnlyWhenOwnFarm !== false,
        reportProgress: (event) => {
          if (!event || !event.message) return;
          this._pushEvent(event.level || "info", `自动农场 / 自动收获 / ${event.message}`, {
            category: "task_progress",
            taskId,
            taskLabel: this._getTaskLabel(taskId),
            event,
          });
        },
      };
    }

    if (taskId === "own_plant") {
      return {
        ...baseOptions,
        ownFarmEnabled: true,
        autoPlantMode: this.config.autoFarmPlantMode || "none",
        autoPlantPrimaryMode: this.config.autoFarmPlantPrimaryMode || this.config.autoFarmPlantMode || "none",
        autoPlantSecondaryMode: this.config.autoFarmPlantSecondaryMode || "none",
        reportProgress: (event) => {
          if (!event || !event.message) return;
          this._pushEvent(event.level || "info", `自动农场 / 自动种植 / ${event.message}`, {
            category: "task_progress",
            taskId,
            taskLabel: this._getTaskLabel(taskId),
            event,
          });
        },
      };
    }

    if (taskId === "own_fertilizer") {
      return {
        ...baseOptions,
        ownFarmEnabled: true,
        autoFertilizerEnabled: !!this.config.autoFarmFertilizerEnabled,
        reportProgress: (event) => {
          if (!event || !event.message) return;
          this._pushEvent(event.level || "info", `自动农场 / 自动施肥 / ${event.message}`, {
            category: "task_progress",
            taskId,
            taskLabel: this._getTaskLabel(taskId),
            event,
          });
        },
      };
    }

    if (taskId === "friend_steal") {
      return {
        ...baseOptions,
        friendStealEnabled: this.config.autoFarmFriendEnabled === true,
        reportProgress: (event) => {
          if (!event || !event.message) return;
          this._pushEvent(event.level || "info", `自动农场 / 好友偷菜 / ${event.message}`, {
            category: "task_progress",
            taskId,
            taskLabel: this._getTaskLabel(taskId),
            event,
          });
        },
      };
    }

    if (taskId === "friend_help") {
      return {
        ...baseOptions,
        friendHelpEnabled: this.config.autoFarmFriendHelpEnabled === true,
        reportProgress: (event) => {
          if (!event || !event.message) return;
          this._pushEvent(event.level || "info", `自动农场 / 好友帮忙 / ${event.message}`, {
            category: "task_progress",
            taskId,
            taskLabel: this._getTaskLabel(taskId),
            event,
          });
        },
      };
    }

    return baseOptions;
  }

  _buildTaskResultSummary(taskId, result, error) {
    if (error) return `失败：${error}`;
    if (!result || typeof result !== "object") return "未返回结果";
    if (taskId === "own_collect") {
      const ownFarm = result.ownFarm && typeof result.ownFarm === "object" ? result.ownFarm : null;
      const tasks = ownFarm && ownFarm.tasks && typeof ownFarm.tasks === "object" ? ownFarm.tasks : null;
      const actions = Array.isArray(tasks && tasks.actions) ? tasks.actions : [];
      const collectAction = actions.find((item) => item && item.key === "collect") || null;
      const beforeCount = Number(collectAction && collectAction.beforeCount) || 0;
      const afterCount = Number(collectAction && collectAction.afterCount) || 0;
      return `收获 ${Math.max(0, beforeCount - afterCount)} 块`;
    }
    if (taskId === "own_plant") {
      const ownFarm = result.ownFarm && typeof result.ownFarm === "object" ? result.ownFarm : null;
      const plantResult = ownFarm && ownFarm.plantResult && typeof ownFarm.plantResult === "object" ? ownFarm.plantResult : null;
      if (!plantResult) return "未执行自动种植";
      if (plantResult.ok && plantResult.action === "planted") {
        return `种植 ${plantResult.seedName || plantResult.seedId || "unknown"}`;
      }
      if (plantResult.ok && plantResult.action === "no_empty_lands") return "无空地";
      return plantResult.reason || plantResult.error || "自动种植结束";
    }
    if (taskId === "own_fertilizer") {
      const ownFarm = result.ownFarm && typeof result.ownFarm === "object" ? result.ownFarm : null;
      const fertilizerResult = ownFarm && ownFarm.fertilizerResult && typeof ownFarm.fertilizerResult === "object"
        ? ownFarm.fertilizerResult
        : null;
      if (!fertilizerResult) return "未执行自动施肥";
      return `施肥成功 ${Number(fertilizerResult.successCount) || 0} 块`;
    }
    if (taskId === "friend_steal" || taskId === "friend_help") {
      const friendSteal = result.friendSteal && typeof result.friendSteal === "object" ? result.friendSteal : null;
      const visits = Array.isArray(friendSteal && friendSteal.visits) ? friendSteal.visits : [];
      return `巡查 ${visits.length} 位好友`;
    }
    return "执行完成";
  }

  async _tick() {
    if (!this.running) return;
    if (this.busy && this._shouldRunConcurrentCollect(Date.now())) {
      void this._runConcurrentCollectCycle().catch(() => {});
    }
    if (this.busy || this.externalRuntimeLockCount > 0) {
      this._schedule(500);
      return;
    }
    if (this.config.autoFarmSchedulerEnabled === false) {
      this._schedule(500);
      return;
    }
    const now = Date.now();
    const task = this._pickNextDueTask(now, false);
    if (!task) {
      this._schedule(this._computeNextDelayMs(now));
      return;
    }
    let shouldReschedule = true;
    try {
      await this._runCycle(false, task.taskId);
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      if (this.config.autoFarmStopOnError) {
        shouldReschedule = false;
        this.stop(`error: ${err.message}`);
        return;
      }
    } finally {
      if (shouldReschedule && this.running) {
        const delay = this.config.autoFarmSchedulerMinGapMs != null
          ? Math.max(this._computeNextDelayMs(Date.now()), Number(this.config.autoFarmSchedulerMinGapMs) || 0)
          : this._computeNextDelayMs(Date.now());
        this._schedule(delay);
      }
    }
  }

  async _ensureGameCtlViaCdp(session) {
    return await ensureGameCtl(session, this.projectRoot, [
      "getFarmOwnership",
      "getFarmStatus",
      "getFriendList",
      "enterOwnFarm",
      "enterFriendFarm",
      "triggerOneClickOperation",
      "clickMatureEffect",
      "dismissRewardPopup",
      "inspectLandDetail",
      "inspectFarmModelRuntime",
      "inspectMainUiRuntime",
      "inspectFarmComponentCandidates",
      "getPlayerProfile",
      "scanSystemAccountCandidates",
      "fertilizeLand",
      "getSeedList",
      "requestShopData",
      "getShopSeedList",
      "autoReconnectIfNeeded",
      "autoPlant",
    ]);
  }

  async _callGameCtlDirect(session, pathName, args, callOptions) {
    return await callGameCtl(session, pathName, args, callOptions);
  }

  _shouldRunConcurrentCollect(now) {
    const baseNow = Number(now) || Date.now();
    if (this.config.autoFarmOwnCollectConcurrentEnabled !== true) return false;
    if (this.externalRuntimeLockCount > 0) return false;
    if (this.concurrentCollectBusy) return false;
    if (!this._isTaskEnabled("own_collect")) return false;
    if (this.currentRunContext && this.currentRunContext.taskId === "own_collect") return false;
    const dueAtMs = this._getTaskDueAtMs("own_collect", baseNow, false);
    return Number.isFinite(dueAtMs) && dueAtMs != null && dueAtMs <= baseNow;
  }

  async _runConcurrentCollectCycle() {
    const taskId = "own_collect";
    const taskLabel = `${this._getTaskLabel(taskId)}(并发实验)`;
    const now = Date.now();
    const runtimeTaskState = this._getTaskState(taskId);
    this.concurrentCollectBusy = true;
    runtimeTaskState.busy = true;
    runtimeTaskState.lastStartedAt = new Date().toISOString();
    this._setTaskLastRunAt(taskId, now);
    this._pushEvent("warn", `自动农场 / 任务开始：${taskLabel}`, {
      category: "task_start_concurrent",
      taskId,
      taskLabel,
    });
    const runContext = {
      cancelled: false,
      reason: null,
      taskId,
      taskLabel,
      concurrent: true,
    };
    try {
      const session = await this.ensureSession();
      await this.ensureGameCtlImpl(session);
      const result = await runAutoFarmCycle({
        session,
        callGameCtl: this.callGameCtlImpl.bind(this),
        options: {
          ...this._buildTaskCycleOptions(taskId, runContext),
          reportProgress: (event) => {
            if (!event || !event.message) return;
            this._pushEvent(event.level || "info", `自动农场 / 自动收获 / ${event.message}`, {
              category: "task_progress_concurrent",
              taskId,
              taskLabel,
              event,
            });
          },
        },
      });
      mergeCycleResultIntoTodayStats(this.todayStats, result);
      this.todayStatsHistory[this.todayStats.dateKey] = normalizeTodayStats(this.todayStats, this.todayStats.dateKey);
      this.todayStatsHistory = pruneTodayStatsHistoryMap(this.todayStatsHistory);
      await this._persistTodayStats("concurrent_collect_cycle");
      runtimeTaskState.lastFinishedAt = new Date().toISOString();
      runtimeTaskState.lastSuccessAt = runtimeTaskState.lastFinishedAt;
      runtimeTaskState.lastDurationMs = Math.max(0, Date.now() - now);
      runtimeTaskState.lastError = null;
      runtimeTaskState.runCount += 1;
      runtimeTaskState.lastResultSummary = this._buildTaskResultSummary(taskId, result, null);
      this._pushEvent("warn", `自动农场 / 任务结束：${taskLabel}`, {
        category: "task_done_concurrent",
        taskId,
        taskLabel,
      });
    } catch (error) {
      const message = toErrorMessage(error);
      runtimeTaskState.lastFinishedAt = new Date().toISOString();
      runtimeTaskState.lastDurationMs = Math.max(0, Date.now() - now);
      runtimeTaskState.lastError = message;
      runtimeTaskState.lastResultSummary = this._buildTaskResultSummary(taskId, null, message);
      this._pushEvent("error", `自动农场 / 并发收获失败：${message}`, {
        category: "task_failed_concurrent",
        taskId,
        taskLabel,
      });
    } finally {
      runtimeTaskState.busy = false;
      this.concurrentCollectBusy = false;
    }
  }

  async _runCycle(force, taskId) {
    const now = Date.now();
    const selectedTaskId = String(taskId || "").trim();
    if (!selectedTaskId) {
      const picked = this._pickNextDueTask(now, force);
      if (!picked) return this.getState();
      return await this._runCycle(force, picked.taskId);
    }
    await this._rolloverFriendHelpStateIfNeeded(now, {
      reason: "cycle_rollover_check",
    });
    const cycleId = new Date(now).toISOString();
    const taskLabel = this._getTaskLabel(selectedTaskId);
    const beforeAutoFertilizerStateSerialized = JSON.stringify(serializeAutoFertilizerState(this.autoFertilizerState));
    const beforeFriendHelpStateSerialized = JSON.stringify(serializeFriendHelpState(this.friendHelpState, now, this.config.autoFarmFriendHelpDailyLimit));
    const runtimeTaskState = this._getTaskState(selectedTaskId);
    let cycleSeq = 0;
    const pushCycleEvent = (level, message, extra) => {
      cycleSeq += 1;
      this._pushEvent(level, message, {
        ...(extra && typeof extra === "object" ? extra : {}),
        cycleId,
        cycleSeq,
        taskId: selectedTaskId,
        taskLabel,
      });
    };
    this._pruneFriendVisitCooldowns(now);
    this._ensureTodayStatsFresh(now);
    if (!this._isTaskEnabled(selectedTaskId)) {
      return this.getState();
    }
    const dueAtMs = this._getTaskDueAtMs(selectedTaskId, now, force);
    if (!force && (!Number.isFinite(dueAtMs) || dueAtMs > now)) return this.getState();
    const due = this._buildDueFlagsForTask(selectedTaskId);

    this.busy = true;
    this.currentRunContext = {
      cancelled: false,
      reason: null,
      cycleId,
      taskId: selectedTaskId,
      taskLabel,
    };
    this.lastStartedAt = new Date().toISOString();
    runtimeTaskState.busy = true;
    runtimeTaskState.lastStartedAt = this.lastStartedAt;
    this.lastError = null;
    this._setTaskLastRunAt(selectedTaskId, now);
    pushCycleEvent("info", `自动农场 / 任务开始：${taskLabel}`, {
      category: "task_start",
    });

    try {
      const session = await this.ensureSession();
      const injectState = await this.ensureGameCtlImpl(session);
      const cycleOpts = this._buildTaskCycleOptions(selectedTaskId, this.currentRunContext);
      const result = await runAutoFarmCycle({
        session,
        callGameCtl: this.callGameCtlImpl.bind(this),
        options: cycleOpts,
      });
      if (result && result.friendSteal && result.friendSteal.helpEnabled === true) {
        this.replaceFriendHelpState(result.friendSteal.helpState, { persist: false });
      }
      this.lastFinishedAt = new Date().toISOString();
      runtimeTaskState.lastFinishedAt = this.lastFinishedAt;
      runtimeTaskState.lastSuccessAt = this.lastFinishedAt;
      runtimeTaskState.lastDurationMs = Math.max(0, Date.now() - now);
      runtimeTaskState.lastError = null;
      runtimeTaskState.runCount += 1;
      runtimeTaskState.lastResultSummary = this._buildTaskResultSummary(selectedTaskId, result, null);
      this.lastResult = {
        injected: injectState.injected,
        taskId: selectedTaskId,
        taskLabel,
        due,
        result,
      };
      const cooldownApplied = this._applyFriendVisitCooldowns(result && result.friendSteal, now);
      mergeCycleResultIntoTodayStats(this.todayStats, result);
      this.todayStatsHistory[this.todayStats.dateKey] = normalizeTodayStats(this.todayStats, this.todayStats.dateKey);
      this.todayStatsHistory = pruneTodayStatsHistoryMap(this.todayStatsHistory);
      await this._persistTodayStats("cycle");
      buildAutoFarmCycleLogMessages({
        due,
        injectState,
        result,
        cooldownApplied,
      }).forEach((item, index) => {
        // 第一条“开始调度”在本轮开始时已经单独写入，这里跳过重复项。
        if (index === 0) return;
        pushCycleEvent(item.level || "info", item.message, {
          category: "cycle_detail",
        });
      });
      pushCycleEvent("info", `自动农场 / 任务结束：${taskLabel}`, {
        category: "task_done",
      });
      return this.getState();
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      this.lastFinishedAt = new Date().toISOString();
      runtimeTaskState.lastFinishedAt = this.lastFinishedAt;
      runtimeTaskState.lastDurationMs = Math.max(0, Date.now() - now);
      if (isAutomationStoppedError(err)) {
        this.lastError = null;
        runtimeTaskState.lastError = null;
        runtimeTaskState.lastResultSummary = "已停止";
        pushCycleEvent("info", `自动农场 / 当前轮已停止：${err.message || "manual"}`, {
          category: "cycle_stopped",
        });
        return this.getState();
      }
      this.lastError = err.message;
      runtimeTaskState.lastError = err.message;
      runtimeTaskState.lastResultSummary = this._buildTaskResultSummary(selectedTaskId, null, err.message);
      pushCycleEvent("error", `自动农场 / 调度失败：${err.message}`, {
        category: "cycle_failed",
      });
      throw err;
    } finally {
      const afterAutoFertilizerStateSerialized = JSON.stringify(serializeAutoFertilizerState(this.autoFertilizerState));
      if (afterAutoFertilizerStateSerialized !== beforeAutoFertilizerStateSerialized) {
        await this._persistAutoFertilizerState("cycle");
      }
      const afterFriendHelpStateSerialized = JSON.stringify(serializeFriendHelpState(this.friendHelpState, null, this.config.autoFarmFriendHelpDailyLimit));
      if (afterFriendHelpStateSerialized !== beforeFriendHelpStateSerialized) {
        await this._persistFriendHelpState("cycle");
      }
      runtimeTaskState.busy = false;
      this.currentRunContext = null;
      this.busy = false;
    }
  }
}

module.exports = {
  AutoFarmManager,
  normalizeAutoFarmConfig,
  normalizeAutoFertilizerState,
};
