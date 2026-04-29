/**
 * HTTP 静态页（public/）+ WebSocket（路径 /ws）→ CDP → 小游戏。
 *
 * WS 消息（JSON 文本）：
 * - { "id": "任意", "op": "ping" }
 * - { "id": "任意", "op": "eval", "code": "return typeof gameCtl" }
 * - { "id": "任意", "op": "call", "path": "gameCtl.getFarmStatus", "args": [{ "includeGrids": true }] }
 * - { "id": "任意", "op": "injectFile", "path": "button.js" }
 */

const http = require("node:http");
const fsSync = require("node:fs");
const WebSocket = require("ws");
const path = require("node:path");
const fs = require("node:fs/promises");
const { CdpSession } = require("./cdp-session");
const { WmpfCdpSession } = require("./cdp-wmpf-session");
const { AutoFarmManager, normalizeAutoFertilizerState } = require("./auto-farm-manager");
const { PreviewManager } = require("./preview-manager");
const { QqWsSession } = require("./qq-ws-session");
const { ensureGameCtl, callGameCtl } = require("./game-ctl-utils");
const {
  buildQqBundle,
  getQqBundleState,
  inspectPatchedQqGameFile,
  patchQqGameFiles,
  resolveQqPatchTarget,
} = require("./qq-bundle");
const { QQ_RPC_GAME_CTL_METHODS } = require("./qq-rpc-spec");
const {
  getPlantAnalyticsList,
  getPlantStrategyModes,
  filterAnalyticsByLevel,
  filterShopEligiblePlants,
  sortAnalyticsList,
  pickBestPlantByMode,
} = require("./plant-analytics");
const {
  getPlantById,
  getPlantBySeedId,
  getPlantByFruitId,
  getItemInfoById,
  getExternalItemMetaByItemId,
  getExternalItemImagePathByItemId,
  getLevelExpProgress,
  getPlantGrowTimeSec,
  getPlantStageImagePathBySeedId,
  formatGrowTime,
  getSeedImagePathBySeedId,
} = require("./game-config");
const { getProfilePlantLevel, resolveProfileWithCandidates } = require("./player-profile-resolver");
const { STEAL_CROP_BLACKLIST_OPTIONS } = require("./steal-crop-blacklist-options");
const {
  ensureFriendHelpCacheFile,
  readFriendHelpCache,
  resolveFriendHelpDailyLimit,
  writeFriendHelpCache,
} = require("./friend-help-exp-cache");
const {
  ensurePlayerProfileCacheFile,
  isProfileCacheUsable,
  profilesMatchIdentity,
  readPlayerProfileCache,
  writePlayerProfileCache,
} = require("./player-profile-cache");
const {
  AUTO_FARM_DAILY_STATS_RETENTION_DAYS,
  ensureAutoFarmDailyStatsDir,
  readRecentAutoFarmDailyStats,
  writeAutoFarmDailyStats,
} = require("./auto-farm-daily-stats");
const {
  MessagePushManager,
  normalizeMessagePushConfig,
} = require("./message-push-manager");
const {
  getBackpackSeedPlantability,
  pickBackpackSeed,
} = require("./backpack-seed-priority");
const {
  TaskEventLogStore,
  formatTaskEventTextLine,
  normalizeTaskEventEntry,
} = require("./task-event-log-store");

const WS_PATH = "/ws";
const REQUIRED_GAME_CTL_METHODS = [...QQ_RPC_GAME_CTL_METHODS];
const DEFAULT_PLANT_IMAGE_URL = "/api/default-plant-image";
const DEFAULT_PLANT_IMAGE_PATH = path.join(__dirname, "..", "gameConfig", "plant_images", "default", "400.jpg");
const UI_SCHEDULER_TASK_IDS = ["health", "autoFarm", "rewardPopup", "lands", "account"];
const WAREHOUSE_REFRESH_INTERVAL_MS = 5 * 60 * 1000;
const WAREHOUSE_AUTO_SELL_DEFAULT_HOURS = 12;
const WAREHOUSE_SELL_CATEGORY_OPTIONS = ["fruit", "seed", "tool", "material"];
const WAREHOUSE_AUTOFARM_WAIT_TIMEOUT_MS = 90 * 1000;
const WAREHOUSE_BUSY_RETRY_DELAY_MS = 20 * 1000;

function buildDefaultUiSchedulerTasks() {
  return {
    health: {
      enabled: true,
      priority: 100,
      intervalMs: 2500,
      mode: "always",
    },
    autoFarm: {
      enabled: true,
      priority: 90,
      intervalMs: 5000,
      mode: "tab_active",
    },
    rewardPopup: {
      enabled: true,
      priority: 80,
      intervalMs: 5000,
      mode: "tab_active",
    },
    lands: {
      enabled: true,
      priority: 60,
      intervalMs: 15000,
      mode: "tab_active",
    },
    account: {
      enabled: true,
      priority: 55,
      intervalMs: 15000,
      mode: "tab_active",
    },
  };
}

function normalizeUiSchedulerTaskMode(value, fallback = "tab_active") {
  const text = String(value == null ? "" : value).trim().toLowerCase();
  return ["always", "tab_active", "manual"].includes(text) ? text : fallback;
}

function normalizeUiSchedulerTaskConfig(taskId, input) {
  const defaults = buildDefaultUiSchedulerTasks();
  const base = defaults[taskId] || {
    enabled: true,
    priority: 50,
    intervalMs: 5000,
    mode: "tab_active",
  };
  const src = input && typeof input === "object" ? input : {};
  return {
    enabled: src.enabled !== false,
    priority: Math.min(999, Math.max(1, Number(src.priority) || base.priority)),
    intervalMs: Math.min(300000, Math.max(1000, Number(src.intervalMs) || base.intervalMs)),
    mode: normalizeUiSchedulerTaskMode(src.mode, base.mode),
  };
}

function normalizeUiSchedulerConfig(input) {
  const src = input && typeof input === "object" ? input : {};
  const taskSource = src.uiSchedulerTasks && typeof src.uiSchedulerTasks === "object"
    ? src.uiSchedulerTasks
    : (src.tasks && typeof src.tasks === "object" ? src.tasks : {});
  const tasks = {};
  for (const taskId of UI_SCHEDULER_TASK_IDS) {
    tasks[taskId] = normalizeUiSchedulerTaskConfig(taskId, taskSource[taskId]);
  }
  return {
    uiSchedulerEnabled: src.uiSchedulerEnabled !== false,
    uiSchedulerMinGapMs: Math.min(10000, Math.max(0, Number(src.uiSchedulerMinGapMs) || 350)),
    uiSchedulerTasks: tasks,
  };
}

/** 农场功能开关默认值（与页面一致；可 POST /api/farm-config 持久化） */
const FARM_CONFIG_DEFAULT = {
  autoInjectButton: false,
  showLandOverlay: true,
  enableOneClickHarvest: true,
  enableFriendSteal: false,
  verboseLog: false,
  autoFarmOwnEnabled: true,
  autoFarmOwnCollectEnabled: true,
  autoFarmOwnCollectOnlyWhenOwnFarm: true,
  autoFarmOwnEraseGrassEnabled: true,
  autoFarmOwnWaterEnabled: true,
  autoFarmOwnKillBugEnabled: true,
  autoFarmFriendEnabled: false,
  autoFarmFriendHelpEnabled: false,
  autoFarmFriendHelpDailyLimit: 30,
  autoFarmOwnIntervalSec: 30,
  autoFarmOwnBaseIntervalSec: 30,
  autoFarmOwnCollectIntervalSec: 30,
  autoFarmPlantIntervalSec: 30,
  autoFarmFriendStealIntervalSec: 90,
  autoFarmFriendHelpIntervalSec: 90,
  autoFarmMaxFriends: 5,
  autoFarmEnterWaitMs: 1800,
  autoFarmActionWaitMs: 1200,
  autoFarmRefreshFriendList: true,
  autoFarmReturnHome: true,
  autoFarmStopOnError: false,
  autoFarmPlantMode: "none",
  autoFarmPlantPrimaryMode: "none",
  autoFarmPlantSecondaryMode: "none",
  autoFarmPlantSeedId: 0,
  autoFarmPlantBackpackSeedPriority: [],
  autoFarmPlantBackpackForcePriority: false,
  autoFarmPlantMaxLevel: 0,
  autoFarmFertilizerEnabled: false,
  autoFarmFertilizerMode: "none",
  autoFarmFertilizerMultiSeason: false,
  autoFarmFertilizerHarvestLinkEnabled: false,
  autoFarmFertilizerLandTypes: ["gold", "black", "red", "normal"],
  autoFarmFertilizerIntervalSec: 30,
  autoFarmFertilizerRushThresholdSec: 300,
  autoFarmFriendQuietHoursEnabled: false,
  autoFarmFriendQuietHoursStart: "23:00",
  autoFarmFriendQuietHoursEnd: "07:00",
  autoFarmFriendWhitelistEnabled: false,
  autoFarmFriendWhitelistScopes: [],
  autoFarmFriendWhitelist: [],
  autoFarmFriendBlacklistEnabled: false,
  autoFarmFriendBlacklistScopes: [],
  autoFarmFriendBlacklist: [],
  autoFarmFriendMaskedBlacklistEnabled: true,
  autoFarmFriendMaskedBlacklistMaxLevel: 1,
  autoFarmOwnCollectConcurrentEnabled: false,
  autoFarmFriendBlockMaskedStealers: true,
  autoFarmFriendStealPlantBlacklistEnabled: false,
  autoFarmFriendStealPlantBlacklistStrategy: 1,
  autoFarmFriendStealPlantBlacklist: [],
  autoFarmAutoStartEnabled: false,
  autoWarehouseSellEnabled: false,
  autoWarehouseSellIntervalHour: WAREHOUSE_AUTO_SELL_DEFAULT_HOURS,
  autoWarehouseSellCategories: [...WAREHOUSE_SELL_CATEGORY_OPTIONS],
  autoFarmSchedulerEnabled: true,
  autoFarmSchedulerMinGapMs: 350,
  autoFarmSchedulerTasks: {
    own_base: { priority: 100 },
    own_collect: { priority: 95 },
    own_plant: { priority: 90 },
    own_fertilizer: { priority: 85 },
    friend_steal: { priority: 70 },
    friend_help: { priority: 65 },
  },
  uiSchedulerEnabled: true,
  uiSchedulerMinGapMs: 350,
  uiSchedulerTasks: buildDefaultUiSchedulerTasks(),
  messagePush: normalizeMessagePushConfig({}),
};

function decoratePlayerProfile(profile) {
  const base = profile && typeof profile === "object" ? { ...profile } : null;
  if (!base) return null;
  const plantLevel = getProfilePlantLevel(base);
  if (plantLevel > 0) {
    base.plantLevel = plantLevel;
    if (!(Number(base.farmMaxLandLevel) > 0) && plantLevel > (Number(base.level) || 0)) {
      base.farmMaxLandLevel = plantLevel;
    }
  }
  const level = Number(base.level);
  const exp = Number(base.exp);
  if (Number.isFinite(level) && level > 0 && Number.isFinite(exp) && exp >= 0) {
    const progress = getLevelExpProgress(level, exp);
    if (progress) {
      base.levelProgress = progress;
      base.totalExp = progress.totalExp;
      base.expMode = progress.expMode;
      if (!(Number(base.nextLevelExp) > 0) && progress.needed != null) {
        base.nextLevelExp = progress.needed;
      }
    }
  }
  return base;
}

function hasStableProfileIdentity(profile) {
  const cur = profile && typeof profile === "object" ? profile : null;
  if (!cur) return false;
  return Boolean(
    (Number(cur.gid) || 0) > 0 ||
    (typeof cur.name === "string" && cur.name.trim()) ||
    (Number(cur.level) || 0) > 0
  );
}

function hasUsableProfileLevel(profile) {
  return getProfilePlantLevel(profile) > 0;
}

function getActiveQqClientKey(getQqWsSnapshot) {
  if (typeof getQqWsSnapshot !== "function") return null;
  const snapshot = getQqWsSnapshot();
  const clients = Array.isArray(snapshot && snapshot.clients) ? snapshot.clients : [];
  const activeId = snapshot && snapshot.activeClientId ? snapshot.activeClientId : null;
  const client = clients.find((item) => item && item.id === activeId) || clients[0] || null;
  if (!client) return null;
  return [
    client.id || "",
    client.lastHelloAt || "",
    client.scriptHash || "",
  ].join("|");
}

function getQqScriptSyncState(getQqWsSnapshot, getQqBundleSnapshot) {
  const wsSnapshot = typeof getQqWsSnapshot === "function" ? getQqWsSnapshot() : null;
  const clients = Array.isArray(wsSnapshot && wsSnapshot.clients) ? wsSnapshot.clients : [];
  const activeId = wsSnapshot && wsSnapshot.activeClientId ? wsSnapshot.activeClientId : null;
  const activeClient = clients.find((item) => item && item.id === activeId) || clients[0] || null;
  const runtimeScriptHash = activeClient && typeof activeClient.scriptHash === "string"
    ? activeClient.scriptHash
    : null;
  const bundleSnapshot = typeof getQqBundleSnapshot === "function" ? getQqBundleSnapshot() : null;
  const expectedScriptHash = bundleSnapshot && typeof bundleSnapshot.scriptHash === "string"
    ? bundleSnapshot.scriptHash
    : null;
  const targetInspection = bundleSnapshot && bundleSnapshot.targetInspection && typeof bundleSnapshot.targetInspection === "object"
    ? bundleSnapshot.targetInspection
    : null;
  const targetScriptHash = targetInspection && typeof targetInspection.scriptHash === "string"
    ? targetInspection.scriptHash
    : null;
  const runtimeMatchesExpected = !!(runtimeScriptHash && expectedScriptHash && runtimeScriptHash === expectedScriptHash);
  const targetMatchesExpected = !!(targetScriptHash && expectedScriptHash && targetScriptHash === expectedScriptHash);
  const runtimeMatchesTarget = !!(runtimeScriptHash && targetScriptHash && runtimeScriptHash === targetScriptHash);
  let status = "unknown";
  if (runtimeMatchesExpected) status = "runtime_synced";
  else if (targetMatchesExpected && runtimeScriptHash) status = "runtime_restart_required";
  else if (targetInspection && targetInspection.exists && !targetScriptHash) status = "target_unpatched";
  else if (targetInspection && targetInspection.exists && expectedScriptHash && targetScriptHash && targetScriptHash !== expectedScriptHash) status = "target_outdated";
  else if (!runtimeScriptHash && targetMatchesExpected) status = "runtime_not_connected";
  else if (!targetInspection || !targetInspection.exists) status = "target_missing";
  return {
    runtimeScriptHash,
    expectedScriptHash,
    targetScriptHash,
    runtimeMatchesExpected,
    targetMatchesExpected,
    runtimeMatchesTarget,
    status,
    inSync: runtimeMatchesExpected,
  };
}

function getPositiveGid(profile) {
  const gid = Number(profile && profile.gid);
  return Number.isFinite(gid) && gid > 0 ? gid : null;
}

function isTrustedResolvedProfile(profile, excludedGids) {
  const cur = profile && typeof profile === "object" ? profile : null;
  if (!cur || !hasStableProfileIdentity(cur)) return false;
  const source = String(cur._source || "");
  const gid = getPositiveGid(cur);
  const excluded = excludedGids instanceof Set ? excludedGids : new Set();
  if (gid != null && excluded.has(gid)) return false;
  if (source === "system_candidates" || source === "system_candidates+runtime_assets") return true;
  if (gid != null && excluded.size > 0 && !excluded.has(gid)) return true;
  return false;
}

function buildProfileAssetOverlay(baseProfile, overlayProfile) {
  const base = baseProfile && typeof baseProfile === "object" ? { ...baseProfile } : {};
  const overlay = overlayProfile && typeof overlayProfile === "object" ? overlayProfile : {};
  const merged = { ...base };
  if ((Number(overlay.gid) || 0) > 0) merged.gid = Number(overlay.gid);
  if ((Number(overlay.playerId) || 0) > 0) merged.playerId = Number(overlay.playerId);
  if (typeof overlay.name === "string" && overlay.name.trim()) merged.name = overlay.name;
  if ((Number(overlay.level) || 0) > 0) merged.level = Number(overlay.level);
  if ((Number(overlay.plantLevel) || 0) > 0) merged.plantLevel = Number(overlay.plantLevel);
  if ((Number(overlay.farmMaxLandLevel) || 0) > 0) merged.farmMaxLandLevel = Number(overlay.farmMaxLandLevel);
  if (((Number(overlay.exp) || 0) > 0) || merged.exp == null) merged.exp = overlay.exp;
  if (((Number(overlay.totalExp) || 0) > 0) || merged.totalExp == null) merged.totalExp = overlay.totalExp;
  if (((Number(overlay.nextLevelExp) || 0) > 0) || merged.nextLevelExp == null) merged.nextLevelExp = overlay.nextLevelExp;
  if (overlay.levelProgress && Number(overlay.levelProgress.needed) > 0) merged.levelProgress = overlay.levelProgress;
  if (overlay.expMode) merged.expMode = overlay.expMode;
  if (((Number(overlay.gold) || 0) > 0) || merged.gold == null) merged.gold = overlay.gold;
  if (((Number(overlay.coupon) || 0) > 0) || merged.coupon == null) merged.coupon = overlay.coupon;
  if (((Number(overlay.diamond) || 0) > 0) || merged.diamond == null) merged.diamond = overlay.diamond;
  if (((Number(overlay.bean) || 0) > 0) || merged.bean == null) merged.bean = overlay.bean;
  if (overlay._source) merged._source = overlay._source;
  const plantLevel = getProfilePlantLevel(merged);
  if (plantLevel > 0) {
    merged.plantLevel = plantLevel;
    if (!(Number(merged.farmMaxLandLevel) > 0) && plantLevel > (Number(merged.level) || 0)) {
      merged.farmMaxLandLevel = plantLevel;
    }
  }
  return merged;
}

async function loadUsableCachedPlayerProfile(currentProfile) {
  try {
    const cacheState = await readPlayerProfileCache();
    if (!cacheState || !cacheState.usableProfile) return null;
    if (currentProfile && !profilesMatchIdentity(currentProfile, cacheState.usableProfile)) {
      return null;
    }
    return decoratePlayerProfile({ ...cacheState.usableProfile, _source: "disk_cache" });
  } catch (_) {
    return null;
  }
}

function loadUsableMemoryCachedPlayerProfile(profileCache) {
  const cached = profileCache && profileCache.profile && isProfileCacheUsable(profileCache.profile)
    ? profileCache.profile
    : null;
  return cached ? decoratePlayerProfile({ ...cached, _source: "memory_cache" }) : null;
}

async function persistUsablePlayerProfile(profile) {
  if (!isProfileCacheUsable(profile)) return;
  try {
    await writePlayerProfileCache(null, profile);
  } catch (_) {
    /* 忽略缓存写入失败，避免影响主流程 */
  }
}

function farmConfigPath() {
  return path.join(__dirname, "..", "data", "farm-config.json");
}

function autoFertilizerStatePath() {
  return path.join(__dirname, "..", "data", "auto-fertilizer-state.json");
}

async function loadFarmConfig() {
  try {
    const raw = await fs.readFile(farmConfigPath(), "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") {
      const merged = { ...FARM_CONFIG_DEFAULT, ...parsed };
      merged.autoFarmFriendHelpDailyLimit = resolveFriendHelpDailyLimit(merged.autoFarmFriendHelpDailyLimit);
      delete merged.autoFarmFriendHelpStopOnExpLimit;
      delete merged.autoFarmFriendHelpNoExpRetryRounds;
      delete merged.autoFarmFertilizerGift;
      delete merged.autoFarmFertilizerBuy;
      delete merged.autoFarmFertilizerBuyType;
      delete merged.autoFarmFertilizerBuyMax;
      delete merged.autoFarmFertilizerBuyMode;
      delete merged.autoFarmFertilizerBuyThreshold;
      merged.autoFarmFriendStealPlantBlacklistEnabled = merged.autoFarmFriendStealPlantBlacklistEnabled === true;
      merged.autoFarmFriendStealPlantBlacklistStrategy = [1, 2].includes(Number(merged.autoFarmFriendStealPlantBlacklistStrategy))
        ? Number(merged.autoFarmFriendStealPlantBlacklistStrategy)
        : 1;
      merged.autoFarmFriendWhitelistEnabled = merged.autoFarmFriendWhitelistEnabled === true;
      merged.autoFarmFriendWhitelistScopes = normalizeFriendRuleScopeList(merged.autoFarmFriendWhitelistScopes);
      merged.autoFarmFriendWhitelist = normalizeStringList(merged.autoFarmFriendWhitelist);
      merged.autoFarmFriendBlacklistEnabled = merged.autoFarmFriendBlacklistEnabled === true;
      merged.autoFarmFriendBlacklistScopes = normalizeFriendRuleScopeList(merged.autoFarmFriendBlacklistScopes)
        .filter((scope) => !merged.autoFarmFriendWhitelistScopes.includes(scope));
      merged.autoFarmPlantBackpackSeedPriority = normalizePositiveIntList(merged.autoFarmPlantBackpackSeedPriority);
      merged.autoFarmPlantBackpackForcePriority = merged.autoFarmPlantBackpackForcePriority === true;
      merged.autoFarmFriendMaskedBlacklistEnabled = merged.autoFarmFriendMaskedBlacklistEnabled === true;
      merged.autoFarmFriendMaskedBlacklistMaxLevel = Math.max(1, Number(merged.autoFarmFriendMaskedBlacklistMaxLevel) || 1);
      merged.autoFarmOwnCollectConcurrentEnabled = merged.autoFarmOwnCollectConcurrentEnabled === true;
      merged.autoFarmOwnCollectOnlyWhenOwnFarm = merged.autoFarmOwnCollectOnlyWhenOwnFarm !== false;
      merged.autoFarmFriendStealPlantBlacklist = normalizePositiveIntList(merged.autoFarmFriendStealPlantBlacklist);
      merged.autoWarehouseSellIntervalHour = normalizeAutoWarehouseSellIntervalHour(merged.autoWarehouseSellIntervalHour);
      merged.autoWarehouseSellCategories = normalizeWarehouseSellCategoryList(merged.autoWarehouseSellCategories);
      Object.assign(merged, normalizeUiSchedulerConfig(merged));
      merged.messagePush = normalizeMessagePushConfig(parsed.messagePush);
      return merged;
    }
  } catch (_) {
    /* 无文件或解析失败 */
  }
  return {
    ...FARM_CONFIG_DEFAULT,
    messagePush: normalizeMessagePushConfig(FARM_CONFIG_DEFAULT.messagePush),
  };
}

async function saveFarmConfig(partial) {
  const cur = await loadFarmConfig();
  const next = { ...cur, ...(partial && typeof partial === "object" ? partial : {}) };
  next.autoFarmFriendHelpDailyLimit = resolveFriendHelpDailyLimit(next.autoFarmFriendHelpDailyLimit);
  delete next.autoFarmFriendHelpStopOnExpLimit;
  delete next.autoFarmFriendHelpNoExpRetryRounds;
  delete next.autoFarmFertilizerGift;
  delete next.autoFarmFertilizerBuy;
  delete next.autoFarmFertilizerBuyType;
  delete next.autoFarmFertilizerBuyMax;
  delete next.autoFarmFertilizerBuyMode;
  delete next.autoFarmFertilizerBuyThreshold;
  next.autoFarmFriendStealPlantBlacklistEnabled = next.autoFarmFriendStealPlantBlacklistEnabled === true;
  next.autoFarmFriendStealPlantBlacklistStrategy = [1, 2].includes(Number(next.autoFarmFriendStealPlantBlacklistStrategy))
    ? Number(next.autoFarmFriendStealPlantBlacklistStrategy)
    : 1;
  next.autoFarmFriendWhitelistEnabled = next.autoFarmFriendWhitelistEnabled === true;
  next.autoFarmFriendWhitelistScopes = normalizeFriendRuleScopeList(next.autoFarmFriendWhitelistScopes);
  next.autoFarmFriendWhitelist = normalizeStringList(next.autoFarmFriendWhitelist);
  next.autoFarmFriendBlacklistEnabled = next.autoFarmFriendBlacklistEnabled === true;
  next.autoFarmFriendBlacklistScopes = normalizeFriendRuleScopeList(next.autoFarmFriendBlacklistScopes)
    .filter((scope) => !next.autoFarmFriendWhitelistScopes.includes(scope));
  next.autoFarmPlantBackpackSeedPriority = normalizePositiveIntList(next.autoFarmPlantBackpackSeedPriority);
  next.autoFarmPlantBackpackForcePriority = next.autoFarmPlantBackpackForcePriority === true;
  next.autoFarmFriendMaskedBlacklistEnabled = next.autoFarmFriendMaskedBlacklistEnabled === true;
  next.autoFarmFriendMaskedBlacklistMaxLevel = Math.max(1, Number(next.autoFarmFriendMaskedBlacklistMaxLevel) || 1);
  next.autoFarmOwnCollectConcurrentEnabled = next.autoFarmOwnCollectConcurrentEnabled === true;
  next.autoFarmOwnCollectOnlyWhenOwnFarm = next.autoFarmOwnCollectOnlyWhenOwnFarm !== false;
  next.autoFarmFriendStealPlantBlacklist = normalizePositiveIntList(next.autoFarmFriendStealPlantBlacklist);
  next.autoWarehouseSellIntervalHour = normalizeAutoWarehouseSellIntervalHour(next.autoWarehouseSellIntervalHour);
  next.autoWarehouseSellCategories = normalizeWarehouseSellCategoryList(next.autoWarehouseSellCategories);
  Object.assign(next, normalizeUiSchedulerConfig(next));
  next.messagePush = normalizeMessagePushConfig(next.messagePush);
  const dir = path.join(__dirname, "..", "data");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(farmConfigPath(), JSON.stringify(next, null, 2), "utf8");
  return next;
}

async function saveAutoFertilizerState(state) {
  const dir = path.join(__dirname, "..", "data");
  const next = normalizeAutoFertilizerState(state);
  next.updatedAt = next.updatedAt || new Date().toISOString();
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(autoFertilizerStatePath(), JSON.stringify(next, null, 2), "utf8");
  return next;
}

async function loadAutoFertilizerState() {
  const dir = path.join(__dirname, "..", "data");
  await fs.mkdir(dir, { recursive: true });
  try {
    const raw = await fs.readFile(autoFertilizerStatePath(), "utf8");
    const parsed = JSON.parse(raw);
    const normalized = normalizeAutoFertilizerState(parsed);
    normalized.updatedAt = normalized.updatedAt || new Date().toISOString();
    const normalizedText = JSON.stringify(normalized, null, 2);
    if (raw.trim() !== normalizedText.trim()) {
      await fs.writeFile(autoFertilizerStatePath(), normalizedText, "utf8");
    }
    return normalized;
  } catch (_) {
    const empty = normalizeAutoFertilizerState({});
    empty.updatedAt = new Date().toISOString();
    await fs.writeFile(autoFertilizerStatePath(), JSON.stringify(empty, null, 2), "utf8");
    return empty;
  }
}

async function loadFriendHelpState() {
  const cache = await readFriendHelpCache();
  return cache && cache.state ? cache.state : {};
}

async function saveFriendHelpState(state) {
  return await writeFriendHelpCache(null, state);
}

async function loadTodayStatsHistory() {
  const result = await readRecentAutoFarmDailyStats(null, {
    retentionDays: AUTO_FARM_DAILY_STATS_RETENTION_DAYS,
    createToday: true,
  });
  return result && Array.isArray(result.days) ? result.days : [];
}

async function saveTodayStats(state) {
  return await writeAutoFarmDailyStats(null, state, {
    retentionDays: AUTO_FARM_DAILY_STATS_RETENTION_DAYS,
  });
}

function findFarmGridByLandId(status, landId) {
  const targetLandId = Number(landId) || 0;
  if (!targetLandId) return null;
  const grids = Array.isArray(status && status.grids) ? status.grids : [];
  for (let i = 0; i < grids.length; i += 1) {
    const grid = grids[i];
    if (Number(grid && grid.landId) === targetLandId) {
      return grid;
    }
  }
  return null;
}

async function readJsonBody(req) {
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
  }
  const parsed = raw ? JSON.parse(raw) : {};
  if (!parsed || typeof parsed !== "object") {
    throw new Error("invalid body");
  }
  return parsed;
}

function parseRequestUrl(req) {
  return new URL(req.url || "/", "http://127.0.0.1");
}

function normalizeMatchText(value) {
  return String(value == null ? "" : value).trim().toLowerCase();
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

function normalizeStringList(value) {
  const source = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(/[\r\n,，;；]+/)
      : [];
  const next = [];
  for (const item of source) {
    const text = String(item == null ? "" : item).trim();
    if (!text || next.includes(text)) continue;
    next.push(text);
  }
  return next;
}

function normalizeAutoWarehouseSellIntervalHour(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return WAREHOUSE_AUTO_SELL_DEFAULT_HOURS;
  return Math.min(24 * 30, Math.max(0, Math.round(num)));
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

function buildFriendSearchFields(friend) {
  if (!friend || typeof friend !== "object") return [];
  const fields = [];
  if (friend.displayName != null) fields.push(friend.displayName);
  if (friend.name != null) fields.push(friend.name);
  if (friend.remark != null) fields.push(friend.remark);
  if (friend.gid != null) fields.push(String(friend.gid));
  return fields;
}

function isFriendExplicitlyBlacklisted(friend, blacklist) {
  const rules = Array.isArray(blacklist) ? blacklist : [];
  if (rules.length === 0) return false;
  const gidText = friend && friend.gid != null ? String(friend.gid) : "";
  const fields = buildFriendSearchFields(friend).map(normalizeMatchText).filter(Boolean);
  for (let i = 0; i < rules.length; i += 1) {
    const rule = normalizeMatchText(rules[i]);
    if (!rule) continue;
    if (/^\d+$/.test(rule) && gidText === rule) return true;
    for (let j = 0; j < fields.length; j += 1) {
      if (fields[j] === rule || fields[j].includes(rule)) return true;
    }
  }
  return false;
}

function isFriendExplicitlyWhitelisted(friend, whitelist) {
  return isFriendExplicitlyBlacklisted(friend, whitelist);
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

function shouldApplyFriendRuleScope(config, scope, mode) {
  const targetScope = String(scope || "").trim().toLowerCase();
  const targetMode = String(mode || "").trim().toLowerCase();
  if (!targetScope || !targetMode) return false;
  const enabled = targetMode === "whitelist"
    ? !!(config && config.autoFarmFriendWhitelistEnabled === true)
    : !!(config && config.autoFarmFriendBlacklistEnabled === true);
  if (!enabled) return false;
  const scopes = normalizeFriendRuleScopeList(
    targetMode === "whitelist"
      ? config && config.autoFarmFriendWhitelistScopes
      : config && config.autoFarmFriendBlacklistScopes
  );
  return scopes.includes(targetScope);
}

function isFriendBelowLevel(friend, maxLevel) {
  if (!friend || typeof friend !== "object") return false;
  const level = Number(friend.level);
  if (!Number.isFinite(level)) return true;
  return level <= Math.max(1, Number(maxLevel) || 1);
}

function enrichFriendItem(friend, config) {
  const workCounts = friend && friend.workCounts && typeof friend.workCounts === "object"
    ? friend.workCounts
    : {};
  const explicitBlacklisted = isFriendExplicitlyBlacklisted(friend, config && config.autoFarmFriendBlacklist);
  const explicitWhitelisted = isFriendExplicitlyWhitelisted(friend, config && config.autoFarmFriendWhitelist);
  const maskedBlocked = !!(
    config
    && config.autoFarmFriendMaskedBlacklistEnabled === true
    && isFriendBelowLevel(friend, config.autoFarmFriendMaskedBlacklistMaxLevel)
  );
  const blockedForSteal = (
    (shouldApplyFriendRuleScope(config, "steal", "whitelist") && !explicitWhitelisted)
    || (shouldApplyFriendRuleScope(config, "steal", "blacklist") && (explicitBlacklisted || maskedBlocked))
  );
  const blockedForHelp = (
    (shouldApplyFriendRuleScope(config, "help", "whitelist") && !explicitWhitelisted)
    || (shouldApplyFriendRuleScope(config, "help", "blacklist") && (explicitBlacklisted || maskedBlocked))
  );
  return {
    ...friend,
    displayName: friend && (friend.displayName || friend.name || friend.remark)
      ? (friend.displayName || friend.name || friend.remark)
      : (friend && friend.gid != null ? `gid=${friend.gid}` : "未知好友"),
    workCounts: {
      collect: Number(workCounts.collect) || 0,
      water: Number(workCounts.water) || 0,
      eraseGrass: Number(workCounts.eraseGrass) || 0,
      killBug: Number(workCounts.killBug) || 0,
    },
    flags: {
      explicitBlacklisted,
      explicitWhitelisted,
      maskedBlocked,
      blocked: blockedForSteal || blockedForHelp,
      blockedForSteal,
      blockedForHelp,
      whitelistedForSteal: shouldApplyFriendRuleScope(config, "steal", "whitelist") && explicitWhitelisted,
      whitelistedForHelp: shouldApplyFriendRuleScope(config, "help", "whitelist") && explicitWhitelisted,
    },
  };
}

function summarizeFriendCounts(list) {
  const friends = Array.isArray(list) ? list : [];
  const counts = {
    totalFriends: friends.length,
    collectableFriends: 0,
    waterableFriends: 0,
    eraseGrassFriends: 0,
    killBugFriends: 0,
    blockedFriends: 0,
  };
  const workCounts = {
    collect: 0,
    water: 0,
    eraseGrass: 0,
    killBug: 0,
  };
  friends.forEach((friend) => {
    const work = friend && friend.workCounts ? friend.workCounts : {};
    const collect = Number(work.collect) || 0;
    const water = Number(work.water) || 0;
    const eraseGrass = Number(work.eraseGrass) || 0;
    const killBug = Number(work.killBug) || 0;
    if (collect > 0) counts.collectableFriends += 1;
    if (water > 0) counts.waterableFriends += 1;
    if (eraseGrass > 0) counts.eraseGrassFriends += 1;
    if (killBug > 0) counts.killBugFriends += 1;
    if (friend && friend.flags && friend.flags.blocked) counts.blockedFriends += 1;
    workCounts.collect += collect;
    workCounts.water += water;
    workCounts.eraseGrass += eraseGrass;
    workCounts.killBug += killBug;
  });
  return { counts, workCounts };
}

function getLandTypeLabel(type) {
  const key = String(type == null ? "" : type).trim().toLowerCase();
  if (key === "gold") return "金土地";
  if (key === "black") return "黑土地";
  if (key === "red") return "红土地";
  if (key === "normal") return "普通土地";
  return "未知土地";
}

function getDefaultPlantImagePath() {
  return fsSync.existsSync(DEFAULT_PLANT_IMAGE_PATH) ? DEFAULT_PLANT_IMAGE_PATH : null;
}

function buildPlantImageUrl(seedId) {
  const normalized = Number(seedId) || 0;
  if (normalized > 0) return `/api/plant-image?seedId=${normalized}`;
  return getDefaultPlantImagePath() ? DEFAULT_PLANT_IMAGE_URL : null;
}

function buildPlantStageImageUrl(seedId, stageOptions) {
  const normalized = Number(seedId) || 0;
  if (normalized <= 0) return buildPlantImageUrl(seedId);
  const options = stageOptions && typeof stageOptions === "object" ? stageOptions : {};
  const params = new URLSearchParams();
  params.set("seedId", String(normalized));
  const currentStage = Number(options.currentStage);
  if (Number.isFinite(currentStage) && currentStage > 0) {
    params.set("currentStage", String(currentStage));
  }
  const phaseName = String(options.phaseName || "").trim();
  if (phaseName) {
    params.set("phaseName", phaseName);
  }
  return `/api/plant-image?${params.toString()}`;
}

function formatMatureEta(seconds) {
  const total = Math.max(0, Number(seconds) || 0);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
  }
  return `${minutes}:${String(secs).padStart(2, "0")}`;
}

function getLandStatusLabel(status) {
  if (status === "mature") return "可收获";
  if (status === "growing") return "生长中";
  if (status === "empty") return "空闲";
  if (status === "dead") return "枯萎";
  return "未知";
}

function summarizeLandCounts(lands) {
  const list = Array.isArray(lands) ? lands : [];
  const summary = {
    total: list.length,
    mature: 0,
    growing: 0,
    empty: 0,
    dead: 0,
    needWater: 0,
    needWeed: 0,
    needBug: 0,
    matureSoon: 0,
    multiSeason: 0,
  };
  list.forEach((item) => {
    const status = String(item && item.status || "");
    if (status === "mature") summary.mature += 1;
    else if (status === "growing") summary.growing += 1;
    else if (status === "empty") summary.empty += 1;
    else if (status === "dead") summary.dead += 1;
    if (item && item.needWater) summary.needWater += 1;
    if (item && item.needWeed) summary.needWeed += 1;
    if (item && item.needBug) summary.needBug += 1;
    if ((Number(item && item.totalSeason) || 0) > 1) summary.multiSeason += 1;
    const matureInSec = Number(item && item.matureInSec);
    if (Number.isFinite(matureInSec) && matureInSec > 0 && matureInSec <= 3600) {
      summary.matureSoon += 1;
    }
  });
  return summary;
}

function enrichAnalyticsRowForUi(item) {
  const row = item && typeof item === "object" ? { ...item } : null;
  if (!row) return null;
  row.imageUrl = buildPlantImageUrl(row.seedId);
  row.growTimeSec = Number(row.growTimeSec) || getPlantGrowTimeSec(row.plantId || row.id) || null;
  if (!row.growTimeStr && row.growTimeSec) {
    row.growTimeStr = formatGrowTime(row.growTimeSec);
  }
  const plant = getPlantBySeedId(row.seedId) || getPlantById(row.plantId || row.id);
  row.seasons = Math.max(1, Number(row.seasons) || Number(plant && plant.seasons) || 1);
  row.plantSize = Number(row.plantSize) || Number(plant && plant.size) || 1;
  return row;
}

function getWarehouseCategoryLabel(category) {
  const key = String(category || "").trim().toLowerCase();
  if (key === "fruit") return "果实";
  if (key === "seed") return "种子";
  if (key === "currency") return "货币";
  if (key === "fertilizer") return "化肥";
  if (key === "tool") return "道具";
  if (key === "material") return "材料";
  return "其他";
}

function classifyWarehouseItem(itemId, itemInfo, runtimeType) {
  const id = Number(itemId) || 0;
  if (getPlantByFruitId(id)) return "fruit";
  if (getPlantBySeedId(id)) return "seed";
  const name = String(itemInfo && itemInfo.name || "").trim();
  const interaction = String(itemInfo && itemInfo.interaction_type || "").trim().toLowerCase();
  const type = Number(itemInfo && itemInfo.type) || Number(runtimeType) || 0;
  if (id >= 1001 && id <= 1010) return "currency";
  if (type === 19) return "currency";
  if (type === 2 && /金币|点券|钻石|金豆|货币/.test(name)) return "currency";
  if (type === 6 || type === 17) return "fruit";
  if (interaction.includes("fertilizer") || /化肥|肥料/.test(name)) return "fertilizer";
  if (/种子$/.test(name)) return "seed";
  if (type === 9 || /狗粮/.test(name)) return "tool";
  if (type === 1 || type === 15) return "tool";
  return "material";
}

function buildWarehouseItemImageUrl(itemId) {
  const id = Number(itemId) || 0;
  if (id <= 0) return null;
  if (getPlantBySeedId(id)) return buildPlantImageUrl(id);
  const fruitPlant = getPlantByFruitId(id);
  if (fruitPlant) return buildPlantImageUrl(Number(fruitPlant.seed_id) || 0);
  if (getExternalItemImagePathByItemId(id)) return `/api/item-image?itemId=${id}`;
  return null;
}

function mergeWarehouseItemMeta(itemInfo, externalItemMeta) {
  const base = itemInfo && typeof itemInfo === "object" ? itemInfo : null;
  const extra = externalItemMeta && typeof externalItemMeta === "object" ? externalItemMeta : null;
  if (!base && !extra) return null;
  const preferExternal = !!(extra && Number(extra.type) === 17);
  return {
    ...(base || {}),
    name: preferExternal
      ? (extra && extra.name) || (base && base.name) || ""
      : (base && base.name) || (extra && extra.name) || "",
    level: preferExternal
      ? ((Number(extra && extra.level) || 0) > 0
        ? Number(extra.level)
        : (Number(base && base.level) || 0) > 0
          ? Number(base.level)
          : 0)
      : (Number(base && base.level) || 0) > 0
      ? Number(base.level)
      : (Number(extra && extra.level) || 0) > 0
        ? Number(extra.level)
        : 0,
    rarity: preferExternal
      ? ((Number(extra && extra.rarity) || 0) > 0
        ? Number(extra.rarity)
        : (Number(base && base.rarity) || 0) > 0
          ? Number(base.rarity)
          : 0)
      : (Number(base && base.rarity) || 0) > 0
      ? Number(base.rarity)
      : (Number(extra && extra.rarity) || 0) > 0
        ? Number(extra.rarity)
        : 0,
    type: preferExternal
      ? ((Number(extra && extra.type) || 0) > 0
        ? Number(extra.type)
        : (Number(base && base.type) || 0) > 0
          ? Number(base.type)
          : 0)
      : (Number(base && base.type) || 0) > 0
      ? Number(base.type)
      : (Number(extra && extra.type) || 0) > 0
        ? Number(extra.type)
        : 0,
    interaction_type: String(base && base.interaction_type || extra && extra.interactionType || "").trim(),
  };
}

function normalizeWarehouseItemForUi(raw, index) {
  const item = raw && typeof raw === "object" ? raw : {};
  const itemId = Number(item.itemId || item.id || item.cfgId || item.uid) || 0;
  const count = Math.max(0, Number(item.count || item.num || item.value) || 0);
  if (itemId <= 0 || count <= 0) return null;

  const itemInfo = getItemInfoById(itemId);
  const externalItemMeta = getExternalItemMetaByItemId(itemId);
  const fruitPlant = getPlantByFruitId(itemId);
  const seedPlant = getPlantBySeedId(itemId);
  const mergedItemInfo = mergeWarehouseItemMeta(itemInfo, externalItemMeta);
  const category = classifyWarehouseItem(itemId, mergedItemInfo, item.type);
  const configuredName = mergedItemInfo && mergedItemInfo.name ? String(mergedItemInfo.name) : "";
  const runtimeName = item.name ? String(item.name) : "";
  const plantName = fruitPlant && fruitPlant.name ? String(fruitPlant.name) : (seedPlant && seedPlant.name ? String(seedPlant.name) : "");
  const name = runtimeName || configuredName || (plantName ? `${plantName}${category === "seed" ? "种子" : "果实"}` : `物品 ${itemId}`);
  const runtimeSaleUnitPrice = Number(item.saleUnitPrice || item.sellPrice || item.price) || 0;
  const runtimeSellItemId = Number(item.sellItemId || item.saleItemId || item.sellId) || 0;
  const saleUnitPrice = fruitPlant
    ? (Number(itemInfo && itemInfo.price) || runtimeSaleUnitPrice || 0)
    : runtimeSaleUnitPrice;
  const canEstimateSale = saleUnitPrice > 0;
  const canSell = item.canSell === true || runtimeSellItemId > 0 || canEstimateSale;
  const estimatedSellPrice = canEstimateSale ? saleUnitPrice * count : 0;

  return {
    itemId,
    name,
    count,
    category,
    categoryLabel: getWarehouseCategoryLabel(category),
    type: Number(mergedItemInfo && mergedItemInfo.type) || Number(item.type) || null,
    rarity: Number(mergedItemInfo && mergedItemInfo.rarity) || Number(item.rarity) || null,
    level: Number(mergedItemInfo && mergedItemInfo.level) || Number(item.level) || null,
    saleUnitPrice,
    estimatedSellPrice,
    canEstimateSale,
    canSell,
    sellItemId: runtimeSellItemId || null,
    estimateMode: fruitPlant && canEstimateSale ? "fruit_config" : (canEstimateSale ? "runtime_warehouse" : "unavailable"),
    imageUrl: buildWarehouseItemImageUrl(itemId),
    plantId: fruitPlant ? (Number(fruitPlant.id) || null) : (seedPlant ? (Number(seedPlant.id) || null) : null),
    seedId: fruitPlant ? (Number(fruitPlant.seed_id) || null) : (seedPlant ? itemId : null),
    plantName: plantName || null,
    sourceIds: Array.isArray(item.sourceIds) ? item.sourceIds : [],
    sourceTabNames: Array.isArray(item.sourceTabNames) ? item.sourceTabNames : [],
    runtimeIndex: index,
  };
}

function summarizeWarehouseItems(items) {
  const list = Array.isArray(items) ? items : [];
  const summary = {
    totalDistinct: list.length,
    totalCount: 0,
    sellableDistinct: 0,
    sellableCount: 0,
    estimatedAllSellPrice: 0,
    categories: {},
  };
  list.forEach((item) => {
    const count = Number(item && item.count) || 0;
    const category = String(item && item.category || "unknown");
    summary.totalCount += count;
    if (!summary.categories[category]) {
      summary.categories[category] = {
        key: category,
        label: getWarehouseCategoryLabel(category),
        distinct: 0,
        count: 0,
      };
    }
    summary.categories[category].distinct += 1;
    summary.categories[category].count += count;
    if (item && item.canEstimateSale) {
      summary.sellableDistinct += 1;
      summary.sellableCount += count;
      summary.estimatedAllSellPrice += Number(item.estimatedSellPrice) || 0;
    }
  });
  summary.categoryList = Object.keys(summary.categories)
    .map((key) => summary.categories[key])
    .sort((a, b) => b.distinct - a.distinct);
  return summary;
}

function sortWarehouseItemsForUi(items) {
  return (Array.isArray(items) ? items : []).slice().sort((a, b) => {
    if (a.canEstimateSale !== b.canEstimateSale) return a.canEstimateSale ? -1 : 1;
    if (b.estimatedSellPrice !== a.estimatedSellPrice) return b.estimatedSellPrice - a.estimatedSellPrice;
    if (b.count !== a.count) return b.count - a.count;
    return a.itemId - b.itemId;
  });
}

function normalizeWarehouseRuntimeListForUi(runtimeList) {
  return sortWarehouseItemsForUi((Array.isArray(runtimeList) ? runtimeList : [])
    .map((item, index) => normalizeWarehouseItemForUi(item, index))
    .filter(Boolean));
}

function buildWarehouseCapabilities(extra = {}) {
  return {
    mapRuntimeItems: true,
    selectSingle: true,
    selectBatch: true,
    executeSingleUse: true,
    estimateSalePrice: true,
    executeSingleSell: true,
    executeBatchSell: true,
    saleActionReason: "仓库数据会在后台短暂打开仓库后刷新缓存；出售也走同一条运行时链路，并在完成后自动更新缓存。",
    estimateNote: "预计售价优先按作物果实配置计算；其余可出售物品则回退使用运行时仓库单价。",
    refreshMode: "hidden_warehouse_polling",
    refreshIntervalSec: Math.round(WAREHOUSE_REFRESH_INTERVAL_MS / 1000),
    ...extra,
  };
}

function buildWarehouseUiData(items, extra = {}) {
  return {
    items: sortWarehouseItemsForUi(items),
    summary: summarizeWarehouseItems(items),
    updatedAt: extra.updatedAt || Date.now(),
    capabilities: buildWarehouseCapabilities(extra.capabilities),
  };
}

async function fetchWarehouseForUi({ ensureAutomationSession, ensureAutomationGameCtl, callAutomationGameCtl }) {
  const session = await ensureAutomationSession();
  await ensureAutomationGameCtl(session);
  const runtimeList = await callAutomationGameCtl(session, "gameCtl.getWarehouseItems", [{
    silent: true,
  }]);
  return buildWarehouseUiData(normalizeWarehouseRuntimeListForUi(runtimeList));
}

function buildStealCropBlacklistOptions() {
  return STEAL_CROP_BLACKLIST_OPTIONS.map((item) => ({
    plantId: item.plantId,
    seedId: item.seedId,
    name: item.name,
    level: item.level,
    imageUrl: buildPlantImageUrl(item.seedId),
  }));
}

function normalizeLandDetail(raw, index) {
  const item = raw && typeof raw === "object" ? raw : {};
  const runtime = item.raw && typeof item.raw === "object" ? item.raw : null;
  const plantData = runtime && runtime.plantData && typeof runtime.plantData === "object" ? runtime.plantData : null;
  const landId = Number(item.landId) || (index + 1);
  const landLevelRaw = item.landLevel;
  const landLevel = landLevelRaw == null || landLevelRaw === "" ? null : Number(landLevelRaw);
  const plantId = Number(item.plantId) || 0;
  const plantConfig = plantId > 0 ? getPlantById(plantId) : null;
  const seedId = Number(plantConfig && plantConfig.seed_id) || 0;
  const totalSeason = Math.max(1, Number(item.totalSeason) || Number(plantConfig && plantConfig.seasons) || 1);
  const currentSeason = plantId > 0
    ? Math.max(1, Math.min(totalSeason, Number(item.currentSeason) || 1))
    : 0;
  const matureInSecRaw = Number(item.matureInSec);
  const stageKind = String(item.stageKind || "").trim().toLowerCase();
  const hasPlant = plantId > 0 || !!item.plantName || !!(runtime && runtime.config);
  const matureInSec = hasPlant && Number.isFinite(matureInSecRaw) ? Math.max(0, matureInSecRaw) : null;
  const status = !hasPlant || stageKind === "empty"
    ? "empty"
    : stageKind === "growing"
      ? "growing"
      : stageKind === "dead"
        ? "dead"
      : stageKind === "mature"
        ? "mature"
      : !!item.canHarvest
        ? "mature"
      : "unknown";
  const configGrowTimeSec = plantConfig ? getPlantGrowTimeSec(plantConfig) : 0;
  const effectiveGrowTimeSec = Number(runtime && runtime.totalTime) || configGrowTimeSec || 0;
  const fruitNum = Number(item.fruitNum) || Number(plantData && plantData.fruit_num) || 0;
  const leftFruit = Number(item.leftFruit) || Number(plantData && plantData.left_fruit_num) || 0;
  const outputScore = fruitNum > 0 ? fruitNum : Math.max(leftFruit, 0);
  const inspectedLandType = item.inspectedLandType || null;
  const runtimeLandType = typeof item.landType === "string" && item.landType ? item.landType : null;
  const rawLandType = runtimeLandType || inspectedLandType || null;
  const hasTrustedLandLevel = Number.isFinite(landLevel) && landLevel > 0;
  const hasTrustedLandType = typeof rawLandType === "string" && !!rawLandType;
  const landTypeSource = runtimeLandType
    ? "runtime_grid"
    : inspectedLandType
      ? "detail_panel"
      : "unknown";
  return {
    id: landId,
    landId,
    gridPos: item.gridPos || null,
    landLevel: hasTrustedLandLevel ? landLevel : null,
    landType: hasTrustedLandType ? rawLandType : null,
    landTypeLabel: hasTrustedLandType ? getLandTypeLabel(rawLandType) : "待识别土地",
    landBadge: hasTrustedLandType ? rawLandType : "unknown",
    landTypeResolved: hasTrustedLandType,
    landTypeSource,
    couldUpgrade: !!item.couldUpgrade,
    couldUnlock: !!item.couldUnlock,
    landSize: Number(item.landSize) || 1,
    status,
    statusLabel: getLandStatusLabel(status),
    plantId: plantId > 0 ? plantId : null,
    plantName: hasPlant ? (item.plantName || (plantConfig && plantConfig.name) || null) : null,
    seedId: seedId > 0 ? seedId : null,
    imageUrl: buildPlantStageImageUrl(seedId, {
      currentStage: Number(item.currentStage) || null,
      phaseName: item.phaseName || null,
    }),
    phaseName: item.phaseName || null,
    currentStage: Number(item.currentStage) || null,
    totalStages: Number(item.totalStages) || null,
    currentSeason,
    totalSeason,
    isMultiSeason: totalSeason > 1,
    matureAtMs: Number(item.matureAtMs) || null,
    matureInSec,
    matureEtaText: matureInSec == null
      ? (status === "empty" ? "空地" : null)
      : matureInSec <= 0
        ? "已成熟"
        : `预计 ${formatMatureEta(matureInSec)} 后成熟`,
    growTimeSec: effectiveGrowTimeSec > 0 ? effectiveGrowTimeSec : null,
    growTimeText: effectiveGrowTimeSec > 0 ? formatGrowTime(effectiveGrowTimeSec) : null,
    configGrowTimeSec: configGrowTimeSec > 0 ? configGrowTimeSec : null,
    configGrowTimeText: configGrowTimeSec > 0 ? formatGrowTime(configGrowTimeSec) : null,
    effectiveGrowTimeSec: effectiveGrowTimeSec > 0 ? effectiveGrowTimeSec : null,
    landBonusProfile: item.landBonusProfile || null,
    leftFruit,
    fruitNum,
    outputScore,
    canHarvest: !!item.canHarvest,
    canSteal: !!item.canSteal,
    canCollect: !!item.canCollect,
    needWater: !!item.needsWater,
    needWeed: !!item.needsEraseGrass,
    needBug: !!item.needsKillBug,
    needEraseDead: !!item.needsEraseDead,
    fertilizer: {
      supported: false,
      canFertilize: false,
      preferredPolicy: null,
      normalEligible: false,
      organicEligible: false,
      multiSeasonEligible: totalSeason > 1,
      reason: "reserved_for_future_strategy",
    },
    rawLandRuntime: item.rawLandRuntime || null,
    rawLandData: item.rawLandData || null,
    rawLandCellData: item.rawLandCellData || null,
  };
}

function assessLandTypeInspection(inspection, expectedLandId) {
  const cur = inspection && typeof inspection === "object" ? inspection : null;
  const reasons = [];
  if (!cur) {
    reasons.push("inspection_missing");
  } else {
    if (!cur.landTypeResolved || !cur.resolvedLandType) {
      reasons.push("land_type_unresolved");
    }
    if (cur.detailType && cur.detailType !== "land") {
      reasons.push("detail_type_not_land");
    }
    const detailLandId = Number(cur.detailLandId);
    const targetLandId = Number(expectedLandId);
    if (
      Number.isFinite(detailLandId) &&
      detailLandId > 0 &&
      Number.isFinite(targetLandId) &&
      targetLandId > 0 &&
      detailLandId !== targetLandId
    ) {
      reasons.push("detail_land_id_mismatch");
    }
    const allTexts = []
      .concat(Array.isArray(cur.landLabelTexts) ? cur.landLabelTexts : [])
      .concat(Array.isArray(cur.levelTipTexts) ? cur.levelTipTexts : [])
      .concat(Array.isArray(cur.benefitTexts) ? cur.benefitTexts : [])
      .concat(Array.isArray(cur.detailTexts) ? cur.detailTexts : [])
      .concat(Array.isArray(cur.rootTexts) ? cur.rootTexts : []);
    const hasInvalidPlaceholder = allTexts.some((text) => /undefined|null|nan/i.test(String(text || "")));
    if (hasInvalidPlaceholder) {
      reasons.push("detail_text_uninitialized");
    }
  }
  return {
    trusted: reasons.length === 0,
    reasons,
  };
}

async function fetchLandDetailsForUi({ ensureAutomationSession, ensureAutomationGameCtl, callAutomationGameCtl }) {
  const session = await ensureAutomationSession();
  await ensureAutomationGameCtl(session);
  const status = await callAutomationGameCtl(session, "gameCtl.getFarmStatus", [{
    includeGrids: true,
    includeLandIds: false,
    includeRawGrid: true,
    includeRawLandRuntime: true,
    silent: true,
  }]);
  const grids = Array.isArray(status && status.grids) ? status.grids : [];
  const lands = grids
    .filter((item) => item && item.landId != null)
    .map((item, index) => normalizeLandDetail(item, index))
    .sort((a, b) => (Number(a.landId) || 0) - (Number(b.landId) || 0));
  return {
    farmType: status && status.farmType ? status.farmType : null,
    totalGrids: Number(status && status.totalGrids) || lands.length,
    stageCounts: status && status.stageCounts ? status.stageCounts : null,
    workCounts: status && status.workCounts ? status.workCounts : null,
    summary: summarizeLandCounts(lands),
    supports: {
      fertilizerStrategy: false,
      multiSeason: lands.some((item) => item && item.isMultiSeason),
      matureCountdown: lands.some((item) => Number.isFinite(Number(item && item.matureInSec))),
      plantImages: lands.some((item) => !!(item && item.imageUrl)),
    },
    lands,
    updatedAt: Date.now(),
  };
}

async function fetchLandDetailsDebugForUi({ ensureAutomationSession, ensureAutomationGameCtl, callAutomationGameCtl }) {
  const session = await ensureAutomationSession();
  await ensureAutomationGameCtl(session);
  const status = await callAutomationGameCtl(session, "gameCtl.getFarmStatus", [{
    includeGrids: true,
    includeLandIds: false,
    includeRawGrid: true,
    includeRawLandRuntime: true,
    silent: true,
  }]);
  const grids = Array.isArray(status && status.grids) ? status.grids : [];
  const inspections = [];
  for (let i = 0; i < grids.length; i += 1) {
    const item = grids[i];
    if (!item || item.landId == null) continue;
    try {
      const inspection = await callAutomationGameCtl(session, "gameCtl.inspectLandDetail", [{
        landId: item.landId,
        waitAfter: 220,
        silent: true,
      }]);
      const assessment = assessLandTypeInspection(inspection, item.landId);
      inspections.push({
        landId: item.landId,
        stageKind: item.stageKind || null,
        plantName: item.plantName || null,
        rawLandRuntime: item.rawLandRuntime || null,
        inspectionTrusted: assessment.trusted,
        inspectionTrustReasons: assessment.reasons,
        inspection: inspection || null,
      });
    } catch (error) {
      inspections.push({
        landId: item.landId,
        stageKind: item.stageKind || null,
        plantName: item.plantName || null,
        rawLandRuntime: item.rawLandRuntime || null,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return {
    farmType: status && status.farmType ? status.farmType : null,
    updatedAt: Date.now(),
    inspections,
  };
}

async function fetchFarmModelRuntimeDebug({ ensureAutomationSession, ensureAutomationGameCtl, callAutomationGameCtl }) {
  const session = await ensureAutomationSession();
  await ensureAutomationGameCtl(session);
  return await callAutomationGameCtl(session, "gameCtl.inspectFarmModelRuntime", [{
    silent: true,
  }]);
}

async function fetchMainUiRuntimeDebug({ ensureAutomationSession, ensureAutomationGameCtl, callAutomationGameCtl }) {
  const session = await ensureAutomationSession();
  await ensureAutomationGameCtl(session);
  return await callAutomationGameCtl(session, "gameCtl.inspectMainUiRuntime", [{
    silent: true,
  }]);
}

async function fetchFarmComponentCandidatesDebug({ ensureAutomationSession, ensureAutomationGameCtl, callAutomationGameCtl }) {
  const session = await ensureAutomationSession();
  await ensureAutomationGameCtl(session);
  return await callAutomationGameCtl(session, "gameCtl.inspectFarmComponentCandidates", [{
    silent: true,
    limit: 12,
  }]);
}

function buildAnalyticsStrategyCards(maxLevel, availability) {
  const modes = getPlantStrategyModes().filter((item) => (
    item &&
    item.value !== "none" &&
    item.value !== "backpack_first" &&
    item.value !== "specified_seed"
  ));
  const rankings = filterShopEligiblePlants(
    filterAnalyticsByLevel(getPlantAnalyticsList(), maxLevel),
  );
  const sortMap = {
    highest_level: "level",
    max_exp: "exp",
    max_fert_exp: "fert_exp",
    max_profit: "profit",
    max_fert_profit: "fert_profit",
  };
  return modes.map((mode) => {
    const theoreticalRecommended = pickBestPlantByMode(mode.value, { maxLevel, shopEligibleOnly: true }) || null;
    const sorted = sortAnalyticsList(rankings, sortMap[mode.value] || "exp");
    const resolved = availability
      ? pickPlantPreviewFromRankings(mode.value, sorted, availability)
      : (sorted[0] ? { plant: sorted[0], source: "static" } : null);
    const currentRecommended = resolved && resolved.plant ? resolved.plant : null;
    return {
      value: mode.value,
      label: mode.label,
      recommended: currentRecommended || theoreticalRecommended || null,
      currentRecommended,
      currentSource: resolved && resolved.source ? resolved.source : null,
      theoreticalRecommended,
    };
  });
}

function buildAvailableSeedMaps(seedList, shopList) {
  const backpackBySeedId = new Map();
  const shopBySeedId = new Map();
  (Array.isArray(seedList) ? seedList : []).forEach((item) => {
    const seedId = Number(item && (item.seedId || item.itemId)) || 0;
    if (seedId > 0) backpackBySeedId.set(seedId, item);
  });
  (Array.isArray(shopList) ? shopList : []).forEach((item) => {
    const seedId = Number(item && item.itemId) || 0;
    if (seedId > 0) shopBySeedId.set(seedId, item);
  });
  return { backpackBySeedId, shopBySeedId };
}

function buildBackpackSeedPriorityOptions(seedList, opts) {
  const options = opts && typeof opts === "object" ? opts : {};
  const forcePriority = options.forcePriority === true;
  const selectedSeedIds = normalizePositiveIntList(options.selectedSeedIds);
  const runtimeSeedList = (Array.isArray(seedList) ? seedList : []).filter((item) => (Number(item && item.count) || 0) > 0);
  const optionList = runtimeSeedList.map((item) => {
    const seedId = Number(item && (item.seedId || item.itemId || item.id)) || 0;
    const analytics = getPlantAnalyticsList().find((row) => Number(row && row.seedId) === seedId) || null;
    const row = analytics ? enrichAnalyticsRowForUi(analytics) : null;
    const plantability = getBackpackSeedPlantability(seedId);
    return {
      seedId,
      name: row && row.name
        ? row.name
        : (item && item.name ? String(item.name).replace(/种子$/, "") : `seed=${seedId}`),
      level: row && row.level != null ? Number(row.level) : (Number(item && item.level) || null),
      backpackCount: Number(item && item.count) || 0,
      inBackpack: true,
      growTimeStr: row && row.growTimeStr ? row.growTimeStr : null,
      imageUrl: row && row.imageUrl ? row.imageUrl : buildPlantImageUrl(seedId),
      plantable: plantability.plantable === true,
      plantableReason: plantability.reason,
      plantableMessage: plantability.message || "",
      retainedByForcePriority: false,
    };
  }).filter((item) => item.seedId > 0);

  if (forcePriority) {
    const currentSeedIdSet = new Set(optionList.map((item) => item.seedId));
    selectedSeedIds.forEach((seedId) => {
      if (currentSeedIdSet.has(seedId)) return;
      const analytics = getPlantAnalyticsList().find((row) => Number(row && row.seedId) === seedId) || null;
      const row = analytics ? enrichAnalyticsRowForUi(analytics) : null;
      const plant = getPlantBySeedId(seedId);
      const plantability = getBackpackSeedPlantability(seedId);
      optionList.push({
        seedId,
        name: row && row.name
          ? row.name
          : (plant && plant.name ? String(plant.name) : `seed=${seedId}`),
        level: row && row.level != null ? Number(row.level) : (Number(plant && plant.land_level_need) || null),
        backpackCount: 0,
        inBackpack: false,
        growTimeStr: row && row.growTimeStr ? row.growTimeStr : (plant ? formatGrowTime(getPlantGrowTimeSec(plant)) : null),
        imageUrl: row && row.imageUrl ? row.imageUrl : buildPlantImageUrl(seedId),
        plantable: plantability.plantable === true,
        plantableReason: plantability.reason,
        plantableMessage: plantability.message || "",
        retainedByForcePriority: true,
      });
    });
  }

  return optionList.sort((a, b) => {
    if (!!a.retainedByForcePriority !== !!b.retainedByForcePriority) return a.retainedByForcePriority ? -1 : 1;
    if (a.plantable !== b.plantable) return a.plantable ? -1 : 1;
    const levelDiff = (Number(a.level) || 0) - (Number(b.level) || 0);
    if (levelDiff !== 0) return levelDiff;
    return String(a.name || "").localeCompare(String(b.name || ""), "zh-CN");
  });
}

function pickBackpackPreview(seedList, prioritySeedIds) {
  const picked = pickBackpackSeed(seedList, prioritySeedIds);
  if (!picked || !picked.item || !picked.seedId) return null;
  const analytics = getPlantAnalyticsList().find((item) => Number(item && item.seedId) === picked.seedId) || null;
  const enrichedPlant = enrichAnalyticsRowForUi(analytics || {
    seedId: picked.seedId,
    name: picked.item && picked.item.name ? String(picked.item.name).replace(/种子$/, "") : `seed=${picked.seedId}`,
    level: Number(picked.item && picked.item.level) || null,
  });
  return {
    seedId: picked.seedId,
    item: picked.item,
    plant: enrichedPlant,
    usedPriority: picked.usedPriority === true,
  };
}

async function fetchSeedAvailabilityForUi({ ensureAutomationSession, ensureAutomationGameCtl, callAutomationGameCtl }) {
  const session = await ensureAutomationSession();
  await ensureAutomationGameCtl(session);
  const seedList = await callAutomationGameCtl(session, "gameCtl.getSeedList", [{ sortMode: 3, silent: true }]);
  await callAutomationGameCtl(session, "gameCtl.requestShopData", [2]);
  const shopList = await callAutomationGameCtl(session, "gameCtl.getShopSeedList", [{ sortByLevel: true, silent: true }]);
  return {
    seedList: Array.isArray(seedList) ? seedList : [],
    shopList: Array.isArray(shopList) ? shopList : [],
  };
}

function pickPlantPreviewFromRankings(mode, rankings, availability) {
  const list = Array.isArray(rankings) ? rankings : [];
  const maps = availability || {};
  const backpackBySeedId = maps.backpackBySeedId instanceof Map ? maps.backpackBySeedId : new Map();
  const shopBySeedId = maps.shopBySeedId instanceof Map ? maps.shopBySeedId : new Map();

  for (let i = 0; i < list.length; i += 1) {
    const row = list[i];
    const seedId = Number(row && row.seedId) || 0;
    if (seedId <= 0) continue;
    const backpackSeed = backpackBySeedId.get(seedId);
    if (backpackSeed && (Number(backpackSeed.count) || 0) > 0) {
      return { plant: row, source: "backpack" };
    }
    if (shopBySeedId.get(seedId)) {
      return { plant: row, source: "shop" };
    }
  }
  return null;
}

function normalizePreviewMode(mode) {
  const text = String(mode == null ? "" : mode).trim().toLowerCase();
  if (text === "max_level") return "highest_level";
  return text || "none";
}

async function fetchFriendListForUi({ ensureAutomationSession, ensureAutomationGameCtl, callAutomationGameCtl, autoFarmManager, refresh }) {
  const session = await ensureAutomationSession();
  await ensureAutomationGameCtl(session);
  const config = autoFarmManager.getState().config || { ...FARM_CONFIG_DEFAULT };
  const friendData = await callAutomationGameCtl(session, "gameCtl.getFriendList", [{
    refresh: refresh !== false,
    sort: true,
    includeSelf: false,
    waitRefresh: true,
    silent: true,
  }]);
  const rawList = Array.isArray(friendData && friendData.list) ? friendData.list : [];
  const list = rawList.map((item) => enrichFriendItem(item, config));
  const summary = summarizeFriendCounts(list);
  return {
    list,
    counts: summary.counts,
    workCounts: summary.workCounts,
    requestedRefresh: !!(friendData && friendData.requestedRefresh),
    refreshed: !!(friendData && friendData.refreshed),
    refreshError: friendData && friendData.refreshError ? friendData.refreshError : null,
    refreshMode: friendData && friendData.refreshMode ? friendData.refreshMode : "none",
    config: {
      autoFarmFriendWhitelistEnabled: config.autoFarmFriendWhitelistEnabled === true,
      autoFarmFriendWhitelistScopes: Array.isArray(config.autoFarmFriendWhitelistScopes)
        ? [...config.autoFarmFriendWhitelistScopes]
        : [],
      autoFarmFriendWhitelist: Array.isArray(config.autoFarmFriendWhitelist)
        ? [...config.autoFarmFriendWhitelist]
        : [],
      autoFarmFriendBlacklistEnabled: config.autoFarmFriendBlacklistEnabled === true,
      autoFarmFriendBlacklistScopes: Array.isArray(config.autoFarmFriendBlacklistScopes)
        ? [...config.autoFarmFriendBlacklistScopes]
        : [],
      autoFarmFriendBlacklist: Array.isArray(config.autoFarmFriendBlacklist) ? [...config.autoFarmFriendBlacklist] : [],
      autoFarmFriendBlockMaskedStealers: config.autoFarmFriendMaskedBlacklistEnabled === true,
      autoFarmFriendMaskedBlacklistEnabled: config.autoFarmFriendMaskedBlacklistEnabled === true,
      autoFarmFriendMaskedBlacklistMaxLevel: config.autoFarmFriendMaskedBlacklistMaxLevel,
      autoFarmFriendStealPlantBlacklistEnabled: config.autoFarmFriendStealPlantBlacklistEnabled === true,
      autoFarmFriendStealPlantBlacklistStrategy: Number(config.autoFarmFriendStealPlantBlacklistStrategy) === 2 ? 2 : 1,
      autoFarmFriendStealPlantBlacklist: Array.isArray(config.autoFarmFriendStealPlantBlacklist)
        ? [...config.autoFarmFriendStealPlantBlacklist]
        : [],
    },
  };
}

async function fetchPlayerProfileForUi({ ensureAutomationSession, ensureAutomationGameCtl, callAutomationGameCtl, config, getQqWsSnapshot, profileCache }) {
  const memoryCachedProfile = loadUsableMemoryCachedPlayerProfile(profileCache);
  const startupCachedProfile = memoryCachedProfile || await loadUsableCachedPlayerProfile(null);

  let session = null;
  try {
    session = await ensureAutomationSession();
    await ensureAutomationGameCtl(session);
  } catch (error) {
    if (startupCachedProfile) return startupCachedProfile;
    throw error;
  }

  let profile = null;
  let profileError = null;
  try {
    profile = await callAutomationGameCtl(session, "gameCtl.getPlayerProfile", [{ silent: true }]);
  } catch (error) {
    profileError = error instanceof Error ? error : new Error(String(error));
    profile = null;
  }

  let candidates = null;
  let candidatesError = null;
  try {
    candidates = await callAutomationGameCtl(session, "gameCtl.scanSystemAccountCandidates", [{ silent: true, limit: 20 }]);
  } catch (error) {
    candidatesError = error instanceof Error ? error : new Error(String(error));
    candidates = null;
  }

  let excludedGids = [];
  try {
    const friendData = await callAutomationGameCtl(session, "gameCtl.getFriendList", [{
      refresh: false,
      sort: false,
      includeSelf: false,
      waitRefresh: false,
      silent: true,
    }]);
    excludedGids = Array.isArray(friendData && friendData.list)
      ? friendData.list.map((item) => Number(item && item.gid)).filter((value) => Number.isFinite(value) && value > 0)
      : [];
  } catch (_) {
    excludedGids = [];
  }
  const excludedGidSet = new Set(excludedGids);
  const resolved = resolveProfileWithCandidates(profile, candidates, { excludedGids });
  let currentProfile = resolved.profile && typeof resolved.profile === "object"
    ? decoratePlayerProfile({ ...resolved.profile, _source: resolved.source })
    : null;
  const diskCachedProfile = await loadUsableCachedPlayerProfile(currentProfile);
  const fallbackProfile = loadUsableMemoryCachedPlayerProfile(profileCache) || diskCachedProfile;
  if (currentProfile && fallbackProfile && profilesMatchIdentity(currentProfile, fallbackProfile)) {
    currentProfile = decoratePlayerProfile({
      ...buildProfileAssetOverlay(fallbackProfile, currentProfile),
      _source: currentProfile._source || fallbackProfile._source || "runtime",
    });
  }

  if (!profileCache || typeof profileCache !== "object") {
    if (currentProfile && isProfileCacheUsable(currentProfile)) {
      await persistUsablePlayerProfile(currentProfile);
      return currentProfile;
    }
    if (diskCachedProfile) return diskCachedProfile;
    return currentProfile;
  }

  const clientKey = getActiveQqClientKey(getQqWsSnapshot);
  if (profileCache.clientKey !== clientKey) {
    profileCache.clientKey = clientKey;
    profileCache.profile = null;
    profileCache.lockedGid = null;
  }

  if (currentProfile && isTrustedResolvedProfile(currentProfile, excludedGidSet)) {
    const currentGid = getPositiveGid(currentProfile);
    if (profileCache.lockedGid == null && currentGid != null) {
      profileCache.lockedGid = currentGid;
    }

    if (
      !profileCache.profile ||
      (profileCache.lockedGid != null && currentGid === profileCache.lockedGid) ||
      (profileCache.lockedGid == null && Number(profileCache.profile.gid) === Number(currentProfile.gid || 0))
    ) {
      profileCache.profile = { ...currentProfile };
      await persistUsablePlayerProfile(currentProfile);
      return currentProfile;
    }

    if (profileCache.lockedGid != null && currentGid != null && currentGid !== profileCache.lockedGid) {
      const sticky = buildProfileAssetOverlay(profileCache.profile, currentProfile);
      const decorated = decoratePlayerProfile({ ...sticky, _source: "locked_gid_profile+runtime_assets" });
      await persistUsablePlayerProfile(decorated);
      return decorated;
    }

    if (
      currentProfile._source === "system_candidates" ||
      currentProfile._source === "system_candidates+runtime_assets"
    ) {
      const sticky = buildProfileAssetOverlay(profileCache.profile, currentProfile);
      const decorated = decoratePlayerProfile({ ...sticky, _source: "sticky_profile+runtime_assets" });
      await persistUsablePlayerProfile(decorated);
      return decorated;
    }

    profileCache.profile = { ...currentProfile };
    await persistUsablePlayerProfile(currentProfile);
    return currentProfile;
  }

  if (currentProfile && hasStableProfileIdentity(currentProfile) && profileCache.profile) {
    const sticky = buildProfileAssetOverlay(profileCache.profile, currentProfile);
    const decorated = decoratePlayerProfile({ ...sticky, _source: "sticky_profile+runtime_assets" });
    await persistUsablePlayerProfile(decorated);
    return decorated;
  }

  if (profileCache.profile) {
    const sticky = buildProfileAssetOverlay(profileCache.profile, currentProfile);
    const decorated = decoratePlayerProfile({ ...sticky, _source: "sticky_profile+runtime_assets" });
    await persistUsablePlayerProfile(decorated);
    return decorated;
  }

  if (diskCachedProfile && (!currentProfile || !hasUsableProfileLevel(currentProfile))) {
    profileCache.profile = { ...diskCachedProfile };
    if (profileCache.lockedGid == null && Number(diskCachedProfile.gid) > 0) {
      profileCache.lockedGid = Number(diskCachedProfile.gid);
    }
    return diskCachedProfile;
  }

  if (currentProfile && hasStableProfileIdentity(currentProfile)) {
    await persistUsablePlayerProfile(currentProfile);
    return currentProfile;
  }

  if (diskCachedProfile) {
    profileCache.profile = { ...diskCachedProfile };
    if (profileCache.lockedGid == null && Number(diskCachedProfile.gid) > 0) {
      profileCache.lockedGid = Number(diskCachedProfile.gid);
    }
    return diskCachedProfile;
  }

  if (profileError || candidatesError) {
    const messages = [profileError && profileError.message, candidatesError && candidatesError.message].filter(Boolean);
    throw new Error(messages[0] || "player profile unavailable");
  }

  return currentProfile;
}

async function scanSystemAccountCandidatesForUi({ ensureAutomationSession, ensureAutomationGameCtl, callAutomationGameCtl }) {
  const session = await ensureAutomationSession();
  await ensureAutomationGameCtl(session);
  const payload = await callAutomationGameCtl(session, "gameCtl.scanSystemAccountCandidates", [{ silent: true, limit: 15 }]);
  return payload && typeof payload === "object" ? payload : null;
}

async function inspectFertilizerRuntimeForUi({ ensureAutomationSession, ensureAutomationGameCtl, callAutomationGameCtl, landId, path }) {
  const session = await ensureAutomationSession();
  await ensureAutomationGameCtl(session);
  const args = [{
    silent: true,
    waitAfter: 350,
  }];
  if (landId != null) args[0].landId = landId;
  if (path) args[0].path = path;
  const payload = await callAutomationGameCtl(session, "gameCtl.inspectFertilizerRuntime", args);
  return payload && typeof payload === "object" ? payload : null;
}

async function inspectProtocolTransportForUi({ ensureAutomationSession, ensureAutomationGameCtl, callAutomationGameCtl }) {
  const session = await ensureAutomationSession();
  await ensureAutomationGameCtl(session);
  const payload = await callAutomationGameCtl(session, "gameCtl.inspectProtocolTransport", [{ silent: true }]);
  return payload && typeof payload === "object" ? payload : null;
}

async function inspectRecentClickTraceForUi({ ensureAutomationSession, ensureAutomationGameCtl, callAutomationGameCtl, limit }) {
  const session = await ensureAutomationSession();
  await ensureAutomationGameCtl(session);
  const payload = await callAutomationGameCtl(session, "gameCtl.inspectRecentClickTrace", [{
    silent: true,
    limit: Number(limit) || 20,
  }]);
  return payload && typeof payload === "object" ? payload : null;
}

async function fertilizeLandForUi({ ensureAutomationSession, ensureAutomationGameCtl, callAutomationGameCtl, autoFarmManager, body }) {
  const session = await ensureAutomationSession();
  await ensureAutomationGameCtl(session);
  const input = body && typeof body === "object" ? body : {};
  const args = [{
    silent: true,
    dryRun: input.dryRun !== false,
    type: input.type || input.mode || "auto",
    internalFallback: input.internalFallback === true,
    waitAfterOpen: input.waitAfterOpen,
    waitAfterAction: input.waitAfterAction,
  }];
  if (input.landId != null) args[0].landId = Number(input.landId);
  if (input.path) args[0].path = String(input.path);
  const payload = await callAutomationGameCtl(session, "gameCtl.fertilizeLand", args);
  if (
    autoFarmManager
    && payload
    && payload.ok === true
    && String(payload.action || "") === "fertilized"
    && Number(payload.landId) > 0
  ) {
    try {
      const status = await callAutomationGameCtl(session, "gameCtl.getFarmStatus", [{
        silent: true,
        includeGrids: true,
        includeLandIds: false,
      }]);
      const grid = findFarmGridByLandId(status, payload.landId);
      if (grid) {
        await autoFarmManager.recordFertilizerGrid(grid, payload.resolvedMode || input.type || input.mode || "normal", {
          reason: "manual_api",
        });
      }
    } catch (_) {
      // 手动施肥主流程成功即可，不阻塞状态缓存回写。
    }
  }
  return payload && typeof payload === "object" ? payload : null;
}

function normalizeAnalyticsLevelRequest(requestedLevel, profile) {
  const parsedLevel = Number(requestedLevel) || 0;
  if (parsedLevel > 0) {
    return {
      requestedMaxLevel: parsedLevel,
      effectiveMaxLevel: parsedLevel,
      levelSource: "config",
    };
  }
  const profilePlantLevel = getProfilePlantLevel(profile);
  if (profilePlantLevel > 0) {
    return {
      requestedMaxLevel: 0,
      effectiveMaxLevel: profilePlantLevel,
      levelSource: Number(profile && (profile.plantLevel || profile.farmMaxLandLevel)) > 0
        ? "profile_plant_level"
        : "profile",
    };
  }
  return {
    requestedMaxLevel: 0,
    effectiveMaxLevel: 0,
    levelSource: "none",
  };
}

async function performFriendOperation({ session, callAutomationGameCtl, target, action, enterWaitMs, actionWaitMs, returnHome }) {
  async function readFarmStatus() {
    return await callAutomationGameCtl(session, "gameCtl.getFarmStatus", [{
      includeGrids: false,
      includeLandIds: false,
      silent: true,
    }]);
  }

  function buildFriendOperations(nextAction, status) {
    const operations = [];
    const workCounts = status && status.workCounts && typeof status.workCounts === "object" ? status.workCounts : {};
    if (nextAction === "steal") {
      if ((Number(workCounts.collect) || 0) > 0) {
        operations.push({ key: "collect", op: "HARVEST" });
      }
      return { operations, workCounts };
    }
    if (nextAction === "help") {
      if ((Number(workCounts.eraseGrass) || 0) > 0) operations.push({ key: "eraseGrass", op: "ERASE_GRASS" });
      if ((Number(workCounts.killBug) || 0) > 0) operations.push({ key: "killBug", op: "KILL_BUG" });
      if ((Number(workCounts.water) || 0) > 0) operations.push({ key: "water", op: "WATER" });
      return { operations, workCounts };
    }
    throw new Error(`unsupported friend action: ${nextAction}`);
  }

  async function waitForFriendFarmStatus(timeoutMs) {
    const deadline = Date.now() + Math.max(0, Number(timeoutMs) || 0);
    let lastStatus = null;
    do {
      lastStatus = await readFarmStatus();
      if (lastStatus && lastStatus.farmType === "friend") return lastStatus;
      if (Date.now() >= deadline) break;
      await sleep(180);
    } while (true);
    return lastStatus;
  }

  const waitMs = Math.max(0, Number(enterWaitMs) || 0);
  const opWaitMs = Math.max(0, Number(actionWaitMs) || 0);
  const enter = await callAutomationGameCtl(session, "gameCtl.enterFriendFarm", [target, {
    waitMs,
    includeAfterOwnership: true,
    silent: true,
  }]);
  let before = await waitForFriendFarmStatus(Math.max(1200, waitMs, opWaitMs));
  if (!before || before.farmType !== "friend") {
    throw new Error("not in friend farm");
  }

  let { operations, workCounts } = buildFriendOperations(action, before);
  if (action === "help" && operations.length <= 0) {
    const deadline = Date.now() + Math.max(600, opWaitMs);
    while (operations.length <= 0 && Date.now() < deadline) {
      await sleep(180);
      const nextStatus = await readFarmStatus();
      if (!nextStatus || nextStatus.farmType !== "friend") break;
      before = nextStatus;
      const resolved = buildFriendOperations(action, before);
      operations = resolved.operations;
      workCounts = resolved.workCounts;
    }
  }

  const actions = [];
  for (let i = 0; i < operations.length; i += 1) {
    const spec = operations[i];
    const beforeCount = Number(workCounts[spec.key]) || 0;
    const trigger = await callAutomationGameCtl(session, "gameCtl.triggerOneClickOperation", [spec.op, {
      includeBefore: false,
      includeAfter: false,
      silent: true,
    }]);
    if (opWaitMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, opWaitMs));
    }
    actions.push({
      key: spec.key,
      op: spec.op,
      beforeCount,
      trigger,
    });
  }

  const after = await readFarmStatus();

  let returnHomeResult = null;
  if (returnHome !== false) {
    try {
      returnHomeResult = await callAutomationGameCtl(session, "gameCtl.enterOwnFarm", [{
        waitMs,
        includeAfterOwnership: true,
        silent: true,
      }]);
    } catch (error) {
      returnHomeResult = {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  return {
    ok: true,
    action,
    enter,
    before,
    after,
    actions,
    returnHome: returnHomeResult,
  };
}

/**
 * @param {ReturnType<import('./config.js').getConfig>} config
 * @returns {{ emitter: import('node:events').EventEmitter } | null}
 */
function tryLoadWmpfEmitter(config) {
  if (config.runtimeTarget === "qq_ws") {
    return null;
  }
  if (config.useWmpfCdpBridge === false) {
    return null;
  }
  try {
    const wmpf = require(path.join(__dirname, "..", "wmpf", "src", "index.js"));
    if (wmpf && wmpf.debugMessageEmitter) {
      return { emitter: wmpf.debugMessageEmitter };
    }
  } catch (_) {
    /* 单独运行 gateway、未装 wmpf 时忽略 */
  }
  return null;
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".ico": "image/x-icon",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
};

/**
 * @param {ReturnType<import('./config.js').getConfig>} config
 */
function createGateway(config) {
  /** @type {CdpSession | import('./cdp-wmpf-session').WmpfCdpSession | null} */
  let cdp = null;

  const wmpfBridge = tryLoadWmpfEmitter(config);

  const publicRoot = path.join(__dirname, "..", "public");
  const projectRoot = path.join(__dirname, "..");

  /** 并发多次 ensureCdp 时共用同一次 connect，避免重复建会话 */
  let ensureCdpInFlight = null;

  async function ensureCdp() {
    if (cdp) return cdp;
    if (!ensureCdpInFlight) {
      ensureCdpInFlight = (async () => {
        try {
          if (wmpfBridge) {
            cdp = new WmpfCdpSession(config, wmpfBridge.emitter);
          } else {
            cdp = new CdpSession({ url: config.cdpWsUrl, timeoutMs: config.cdpTimeoutMs });
          }
          await cdp.connect();
          return cdp;
        } catch (error) {
          if (cdp) {
            try {
              cdp.close();
            } catch (_) {}
          }
          cdp = null;
          throw error;
        } finally {
          ensureCdpInFlight = null;
        }
      })();
    }
    return ensureCdpInFlight;
  }

  const qqWsSession = new QqWsSession({
    path: config.qqWsPath,
    readyTimeoutMs: config.qqWsReadyTimeoutMs,
    callTimeoutMs: config.qqWsCallTimeoutMs,
  });
  qqWsSession.on("clientConnected", (_snapshot, client) => {
    console.log(`[gateway][qq_ws] client connected: id=${client.id} remote=${client.remoteAddress || "?"}`);
  });
  qqWsSession.on("hello", (_snapshot, client) => {
    const hello = client && client.hello ? client.hello : {};
    const appPlatform = hello.appPlatform || "unknown";
    const ready = hello.gameCtlReady === true ? "ready" : "not_ready";
    const version = hello.version || "?";
    console.log(`[gateway][qq_ws] hello: id=${client.id} appPlatform=${appPlatform} gameCtl=${ready} version=${version}`);
    maybeAutoStartAutoFarm(hello.gameCtlReady === true ? "qq_ws_hello_ready" : "qq_ws_hello");
  });
  qqWsSession.on("event", (entry) => {
    const payload = entry && entry.payload && typeof entry.payload === "object" ? entry.payload : null;
    if (!payload || payload.name !== "gameCtlReadyChanged" || payload.ready !== true) return;
    maybeAutoStartAutoFarm("qq_ws_gamectl_ready");
  });
  qqWsSession.on("clientDisconnected", (_snapshot, client) => {
    console.log(`[gateway][qq_ws] client disconnected: id=${client.id}`);
  });
  qqWsSession.on("clientError", (payload) => {
    if (!payload) return;
    console.log(`[gateway][qq_ws] client error: ${payload.error || "unknown"}`);
  });

  function getCdpSnapshot() {
    return cdp && typeof cdp.getStatusSnapshot === "function"
      ? cdp.getStatusSnapshot()
      : null;
  }

  function getQqWsSnapshot() {
    return qqWsSession.getStatusSnapshot();
  }

  function resolveAutomationRuntimeTarget() {
    if (config.runtimeTarget === "qq_ws") return "qq_ws";
    if (config.runtimeTarget === "auto" && qqWsSession.isReady()) return "qq_ws";
    return "cdp";
  }

  async function ensureAutomationSession() {
    const target = resolveAutomationRuntimeTarget();
    if (target === "qq_ws") {
      return await qqWsSession.connect();
    }
    return await ensureCdp();
  }

  function isQqRuntimeSession(session) {
    return session === qqWsSession;
  }

  async function ensureAutomationGameCtl(session) {
    if (isQqRuntimeSession(session)) {
      return await qqWsSession.ensureGameCtl(REQUIRED_GAME_CTL_METHODS);
    }
    return await ensureGameCtl(session, projectRoot, REQUIRED_GAME_CTL_METHODS);
  }

  async function callAutomationGameCtl(session, pathName, args, callOptions) {
    if (isQqRuntimeSession(session)) {
      return await qqWsSession.call(pathName, args, callOptions);
    }
    return await callGameCtl(session, pathName, args, callOptions);
  }

  async function callSelectedRuntimePath(pathName, args) {
    const session = await ensureAutomationSession();
    return await callAutomationGameCtl(session, pathName, args);
  }

  function getAutomationTransportState() {
    return {
      configuredTarget: config.runtimeTarget,
      resolvedTarget: resolveAutomationRuntimeTarget(),
      cdp: getCdpSnapshot(),
      qqWs: getQqWsSnapshot(),
    };
  }

  function getQqBundleSnapshot(options = {}) {
    let snapshot = null;
    try {
      snapshot = buildQqBundle({ config, projectRoot }).meta;
    } catch (_) {
      snapshot = getQqBundleState(config);
    }
    const target = resolveQqPatchTarget({
      targetPath: options.targetPath,
      appId: options.appId,
      fallbackTargetPath: config.qqGameJsPath,
      fallbackAppId: snapshot && snapshot.appId ? snapshot.appId : config.qqAppId,
      srcRoot: options.srcRoot || config.qqMiniappSrcRoot,
    });
    const targetPaths = Array.isArray(target && target.targetPaths) && target.targetPaths.length > 0
      ? target.targetPaths
      : (Array.isArray(snapshot && snapshot.targetPaths) && snapshot.targetPaths.length > 0
          ? snapshot.targetPaths
          : (target && target.targetPath ? [target.targetPath] : []));
    const targetInspections = targetPaths
      .slice(0, 8)
      .map((targetPath) => inspectPatchedQqGameFile(targetPath, snapshot && snapshot.scriptHash))
      .filter(Boolean);
    const targetInspection = targetInspections[0] || null;
    const enriched = {
      ...(snapshot && typeof snapshot === "object" ? snapshot : {}),
      targetMode: target && target.targetMode ? target.targetMode : (snapshot && snapshot.targetMode ? snapshot.targetMode : null),
      targetPath: target && target.targetPath ? target.targetPath : (snapshot && snapshot.targetPath ? snapshot.targetPath : null),
      targetPaths,
      canPatch: !!(target && target.targetResolvable),
      targetError: target && target.targetError ? target.targetError : (snapshot && snapshot.targetError ? snapshot.targetError : null),
      appId: target && target.appId ? target.appId : (snapshot && snapshot.appId ? snapshot.appId : null),
      discovery: target && target.discovery ? target.discovery : (snapshot && snapshot.discovery ? snapshot.discovery : null),
      patchTargetCount: targetPaths.length,
      targetInspection,
      targetInspections,
    };
    enriched.sync = getQqScriptSyncState(getQqWsSnapshot, () => enriched);
    return enriched;
  }

  function assertQqRuntimeBundleSynced() {
    if (resolveAutomationRuntimeTarget() !== "qq_ws") return;
    const sync = getQqScriptSyncState(getQqWsSnapshot, getQqBundleSnapshot);
    if (!sync.runtimeScriptHash || !sync.expectedScriptHash) return;
    if (sync.inSync) return;
    throw new Error(
      `qq_ws runtime scriptHash mismatch: runtime=${sync.runtimeScriptHash} expected=${sync.expectedScriptHash}`,
    );
  }

  function isRewardPopupInterceptorStateEnabled(state) {
    if (!state || typeof state !== "object") return false;
    if (typeof state.enabled === "boolean") return state.enabled;
    return !!(state.running || state.busy);
  }

  function applyRewardPopupInterceptorUiState(status, state) {
    status.available = true;
    status.enabled = isRewardPopupInterceptorStateEnabled(state);
    status.state = state || null;
    status.reason = null;
    status.note = null;
    status.error = null;
    status.missingMethods = [];
    return status;
  }

  async function inspectRewardPopupInterceptorForUi(options = {}) {
    const timeoutMs = Math.max(1000, Number(options.timeoutMs) || 4000);
    const resolvedTarget = resolveAutomationRuntimeTarget();
    const bundle = resolvedTarget === "qq_ws" ? getQqBundleSnapshot() : null;
    const sync = bundle && bundle.sync ? bundle.sync : null;
    const payload = {
      resolvedTarget,
      available: false,
      enabled: false,
      state: null,
      runtimeReady: false,
      scriptHash: sync && typeof sync.runtimeScriptHash === "string" ? sync.runtimeScriptHash : null,
      sync,
      reason: null,
      note: null,
      error: null,
      missingMethods: [],
    };

    if (resolvedTarget !== "qq_ws") {
      payload.reason = "runtime_not_qq_ws";
      payload.note = "仅 QQ WS 运行时支持奖励弹窗拦截开关";
      return payload;
    }

    if (!qqWsSession.isReady()) {
      payload.reason = "runtime_not_ready";
      payload.note = "QQ 宿主尚未就绪";
      return payload;
    }

    if (sync && sync.runtimeScriptHash && sync.expectedScriptHash && !sync.inSync) {
      payload.reason = "runtime_not_synced";
      payload.note = "当前 QQ runtime 尚未加载最新补丁";
      return payload;
    }

    let describe = null;
    try {
      describe = await qqWsSession.call("host.describe", [], { timeoutMs });
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      payload.reason = "runtime_describe_failed";
      payload.error = err.message;
      payload.note = "读取 QQ 宿主方法列表失败";
      return payload;
    }

    payload.runtimeReady = !!(describe && describe.gameCtlReady);
    if (describe && typeof describe.scriptHash === "string") {
      payload.scriptHash = describe.scriptHash;
    }

    const availableMethods = Array.isArray(describe && describe.availableMethods) ? describe.availableMethods : [];
    const requiredMethods = [
      "gameCtl.getRewardPopupInterceptorState",
      "gameCtl.setRewardPopupInterceptorEnabled",
    ];
    payload.missingMethods = requiredMethods.filter((name) => !availableMethods.includes(name));

    if (!payload.runtimeReady) {
      payload.reason = "runtime_not_ready";
      payload.note = "gameCtl 尚未 ready";
      return payload;
    }

    if (payload.missingMethods.length > 0) {
      payload.reason = "runtime_missing_method";
      payload.note = "当前 runtime 未暴露奖励弹窗拦截方法";
      return payload;
    }

    try {
      const state = await qqWsSession.call(
        "gameCtl.getRewardPopupInterceptorState",
        [{ silent: true }],
        { timeoutMs },
      );
      return applyRewardPopupInterceptorUiState(payload, state);
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      payload.reason = "runtime_state_failed";
      payload.error = err.message;
      payload.note = "读取奖励弹窗拦截状态失败";
      return payload;
    }
  }

  async function setRewardPopupInterceptorForUi(input = {}) {
    const timeoutMs = Math.max(1000, Number(input.timeoutMs) || 6000);
    const status = await inspectRewardPopupInterceptorForUi({ timeoutMs });
    if (status.resolvedTarget !== "qq_ws") {
      throw new Error("奖励弹窗拦截仅支持 qq_ws 运行时");
    }
    if (status.reason === "runtime_not_ready") {
      throw new Error("QQ 宿主尚未就绪");
    }
    if (status.reason === "runtime_not_synced") {
      const sync = status.sync || {};
      throw new Error(
        `qq_ws runtime scriptHash mismatch: runtime=${sync.runtimeScriptHash || "unknown"} expected=${sync.expectedScriptHash || "unknown"}`,
      );
    }
    if (status.reason === "runtime_missing_method") {
      throw new Error("当前 runtime 缺少奖励弹窗拦截方法，请重新加载最新补丁");
    }
    if (!status.available && status.error) {
      throw new Error(status.error);
    }

    const opts = { silent: true };
    if (input.intervalMs != null) {
      opts.intervalMs = Math.max(120, Number(input.intervalMs) || 0);
    }
    if (input.waitAfter != null) {
      opts.waitAfter = Math.max(0, Number(input.waitAfter) || 0);
    }

    const state = await qqWsSession.call(
      "gameCtl.setRewardPopupInterceptorEnabled",
      [input.enabled === true, opts],
      { timeoutMs },
    );

    if (input.enabled === false) {
      const settleDelayMs = Math.max(
        320,
        (Number(state && state.intervalMs) || 180) + (Number(state && state.waitAfter) || 0) + 180,
      );
      let next = applyRewardPopupInterceptorUiState({ ...status }, state);
      for (let attempt = 0; attempt < 3; attempt += 1) {
        await sleep(settleDelayMs);
        next = await inspectRewardPopupInterceptorForUi({ timeoutMs });
        if (!next.available || !next.enabled) {
          return next;
        }
        const stoppedState = await qqWsSession.call(
          "gameCtl.setRewardPopupInterceptorEnabled",
          [false, opts],
          { timeoutMs },
        );
        next = applyRewardPopupInterceptorUiState({ ...next }, stoppedState);
      }
      return next;
    }

    const next = await inspectRewardPopupInterceptorForUi({ timeoutMs });
    return applyRewardPopupInterceptorUiState(next, state);
  }

  const playerProfileCache = {
    clientKey: null,
    lockedGid: null,
    profile: null,
  };
  const taskEventLogStore = new TaskEventLogStore(projectRoot);
  let wss = null;

  async function getRecentTaskLogEntries(limit) {
    const resolvedLimit = Math.min(10000, Math.max(1, Number(limit) || 500));
    const persisted = await taskEventLogStore.readRecent(resolvedLimit);
    const runtimeState = autoFarmManager.getState();
    const recentEvents = Array.isArray(runtimeState && runtimeState.recentEvents)
      ? runtimeState.recentEvents.slice(-resolvedLimit)
      : [];
    if (!recentEvents.length) {
      return persisted;
    }
    const merged = [];
    const seen = new Set();
    persisted
      .concat(recentEvents)
      .forEach((item) => {
        const entry = normalizeTaskEventEntry(item);
        const key = JSON.stringify(entry);
        if (seen.has(key)) return;
        seen.add(key);
        merged.push(entry);
      });
    return merged.slice(-resolvedLimit);
  }

  async function exportTaskLogContent(format, limit) {
    const entries = await getRecentTaskLogEntries(limit);
    if (format === "json") {
      return JSON.stringify(entries, null, 2);
    }
    return entries.map((entry) => formatTaskEventTextLine(entry)).join("\n");
  }

  function broadcastControlEvent(event, payload) {
    if (!wss || !wss.clients || wss.clients.size <= 0) return;
    const message = JSON.stringify({
      event,
      payload: payload && typeof payload === "object" ? payload : null,
    });
    wss.clients.forEach((client) => {
      if (!client || client.readyState !== WebSocket.OPEN) return;
      try {
        client.send(message);
      } catch (_) {}
    });
  }

  void ensurePlayerProfileCacheFile(projectRoot).catch(() => {});
  void ensureFriendHelpCacheFile(projectRoot).catch(() => {});
  void ensureAutoFarmDailyStatsDir(projectRoot).catch(() => {});

  const autoFarmManager = new AutoFarmManager({
    ensureSession: ensureAutomationSession,
    getSession: () => (resolveAutomationRuntimeTarget() === "qq_ws" ? qqWsSession : cdp),
    ensureGameCtl: ensureAutomationGameCtl,
    callGameCtl: callAutomationGameCtl,
    getTransportState: getAutomationTransportState,
    initialAutoFertilizerState: normalizeAutoFertilizerState({}),
    persistAutoFertilizerState: async (state) => {
      await saveAutoFertilizerState(state);
    },
    initialFriendHelpState: {},
    friendHelpDailyLimit: FARM_CONFIG_DEFAULT.autoFarmFriendHelpDailyLimit,
    persistFriendHelpState: async (state) => {
      await saveFriendHelpState(state);
    },
    initialTodayStatsHistory: [],
    persistTodayStats: async (state) => {
      await saveTodayStats(state);
    },
    persistEvent: async (entry) => {
      await taskEventLogStore.append(entry);
      broadcastControlEvent("autoFarmEvent", {
        entry,
      });
    },
    projectRoot,
  });
  const messagePushManager = new MessagePushManager({
    projectRoot,
    initialConfig: FARM_CONFIG_DEFAULT.messagePush,
    getStatusSnapshot: () => autoFarmManager.getState(),
    logFiles: [
      path.join(projectRoot, "logs", "gateway-out.log"),
      path.join(projectRoot, "logs", "gateway-err.log"),
    ],
  });
  let autoFarmBootConfigLoaded = false;
  let autoFarmBootStateLoaded = false;
  let autoFarmBootHelpStateLoaded = false;
  let autoFarmBootTodayStatsLoaded = false;
  let autoFarmAutoStartDone = false;

  function shouldAutoStartAutoFarm(configData) {
    return !!(
      configData
      && configData.autoFarmAutoStartEnabled === true
      && (configData.autoFarmOwnEnabled || configData.autoFarmFriendEnabled || configData.autoFarmFriendHelpEnabled)
    );
  }

  function maybeAutoStartAutoFarm(reason) {
    if (autoFarmAutoStartDone) return;
    const state = autoFarmManager.getState();
    const configData = state && state.config ? state.config : null;
    if (
      !autoFarmBootConfigLoaded
      || !autoFarmBootStateLoaded
      || !autoFarmBootHelpStateLoaded
      || !autoFarmBootTodayStatsLoaded
      || !shouldAutoStartAutoFarm(configData)
    ) return;
    const target = resolveAutomationRuntimeTarget();
    if (target === "qq_ws" && !qqWsSession.isReady()) return;
    if (state && state.running) {
      autoFarmAutoStartDone = true;
      return;
    }
    try {
      autoFarmManager.start();
      autoFarmAutoStartDone = true;
      console.log(`[gateway][auto_farm] auto started: ${reason || "unknown"}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.log(`[gateway][auto_farm] auto start skipped: ${message}`);
    }
  }

  const warehouseRuntimeState = {
    cache: buildWarehouseUiData([], { updatedAt: 0 }),
    bootAt: Date.now(),
    opQueue: Promise.resolve(),
    busy: false,
    timer: null,
    lastRefreshStartedAt: null,
    lastRefreshAt: 0,
    lastRefreshReason: null,
    lastRefreshError: null,
    nextRefreshAt: Date.now() + WAREHOUSE_REFRESH_INTERVAL_MS,
    refreshCount: 0,
    lastSellAt: 0,
    lastSellReason: null,
    lastSellError: null,
    lastSellResult: null,
  };

  function getWarehouseConfig() {
    const state = autoFarmManager.getState();
    const configData = state && state.config && typeof state.config === "object"
      ? state.config
      : FARM_CONFIG_DEFAULT;
    return {
      autoWarehouseSellEnabled: configData.autoWarehouseSellEnabled === true,
      autoWarehouseSellIntervalHour: normalizeAutoWarehouseSellIntervalHour(configData.autoWarehouseSellIntervalHour),
      autoWarehouseSellCategories: normalizeWarehouseSellCategoryList(configData.autoWarehouseSellCategories),
    };
  }

  function getWarehouseNextAutoSellAt(configData) {
    const cfg = configData || getWarehouseConfig();
    const intervalHour = normalizeAutoWarehouseSellIntervalHour(cfg.autoWarehouseSellIntervalHour);
    if (intervalHour <= 0) return null;
    const baseAt = warehouseRuntimeState.lastSellAt > 0 ? warehouseRuntimeState.lastSellAt : warehouseRuntimeState.bootAt;
    return baseAt + intervalHour * 60 * 60 * 1000;
  }

  function buildWarehouseSchedulerState() {
    const cfg = getWarehouseConfig();
    return {
      refreshIntervalSec: Math.round(WAREHOUSE_REFRESH_INTERVAL_MS / 1000),
      nextRefreshAt: warehouseRuntimeState.nextRefreshAt || null,
      lastRefreshAt: warehouseRuntimeState.lastRefreshAt || null,
      lastRefreshStartedAt: warehouseRuntimeState.lastRefreshStartedAt || null,
      lastRefreshReason: warehouseRuntimeState.lastRefreshReason || null,
      lastRefreshError: warehouseRuntimeState.lastRefreshError || null,
      refreshCount: warehouseRuntimeState.refreshCount,
      busy: warehouseRuntimeState.busy,
      autoSellEnabled: cfg.autoWarehouseSellEnabled === true,
      autoSellIntervalHour: cfg.autoWarehouseSellIntervalHour,
      autoSellCategories: cfg.autoWarehouseSellCategories,
      autoSellCategoryLabels: cfg.autoWarehouseSellCategories.map((category) => getWarehouseCategoryLabel(category)),
      nextAutoSellAt: getWarehouseNextAutoSellAt(cfg),
      lastSellAt: warehouseRuntimeState.lastSellAt || null,
      lastSellReason: warehouseRuntimeState.lastSellReason || null,
      lastSellError: warehouseRuntimeState.lastSellError || null,
      lastSellResult: warehouseRuntimeState.lastSellResult || null,
    };
  }

  function getWarehouseCachedPayload() {
    const base = warehouseRuntimeState.cache && typeof warehouseRuntimeState.cache === "object"
      ? warehouseRuntimeState.cache
      : buildWarehouseUiData([], { updatedAt: 0 });
    const scheduler = buildWarehouseSchedulerState();
    return {
      ...base,
      capabilities: buildWarehouseCapabilities({
        ...(base.capabilities || {}),
        autoSellIntervalHour: scheduler.autoSellIntervalHour,
        autoSellCategories: scheduler.autoSellCategories,
        autoSellCategoryLabels: scheduler.autoSellCategoryLabels,
      }),
      scheduler,
      cache: {
        available: !!(base.updatedAt && Array.isArray(base.items)),
        updatedAt: base.updatedAt || null,
        ageMs: base.updatedAt ? Math.max(0, Date.now() - Number(base.updatedAt)) : null,
      },
    };
  }

  function scheduleWarehouseMaintenance(delayMs) {
    if (warehouseRuntimeState.timer) {
      clearTimeout(warehouseRuntimeState.timer);
      warehouseRuntimeState.timer = null;
    }
    const now = Date.now();
    const targetDelay = delayMs != null
      ? Number(delayMs)
      : Math.max(1000, (Number(warehouseRuntimeState.nextRefreshAt) || now + WAREHOUSE_REFRESH_INTERVAL_MS) - now);
    warehouseRuntimeState.timer = setTimeout(() => {
      warehouseRuntimeState.timer = null;
      void runWarehouseMaintenanceTick();
    }, Math.max(1000, Number.isFinite(targetDelay) ? targetDelay : WAREHOUSE_REFRESH_INTERVAL_MS));
  }

  function isWarehouseAutoFarmBusyTimeoutError(error) {
    return !!(error && (error.code === "AUTO_FARM_RUNTIME_BUSY_TIMEOUT" || error.message === "等待自动农场空闲超时"));
  }

  function enqueueWarehouseOperation(label, task) {
    const run = warehouseRuntimeState.opQueue
      .catch(() => {})
      .then(async () => {
        warehouseRuntimeState.busy = true;
        try {
          const waitLabel = label === "warehouse_sell" ? "仓库出售" : "仓库刷新";
          return await autoFarmManager.runWithRuntimeExclusive(label, async () => {
            return await task();
          }, {
            timeoutMs: WAREHOUSE_AUTOFARM_WAIT_TIMEOUT_MS,
            pollMs: 250,
            waitLabel,
          });
        } finally {
          warehouseRuntimeState.busy = false;
          scheduleWarehouseMaintenance();
        }
      });
    warehouseRuntimeState.opQueue = run.catch(() => {});
    return run;
  }

  function updateWarehouseCacheFromItems(items, meta = {}) {
    const now = Date.now();
    warehouseRuntimeState.cache = buildWarehouseUiData(normalizeWarehouseRuntimeListForUi(items), {
      updatedAt: meta.updatedAt || now,
    });
    warehouseRuntimeState.lastRefreshAt = meta.updatedAt || now;
    warehouseRuntimeState.lastRefreshReason = meta.reason || warehouseRuntimeState.lastRefreshReason;
    warehouseRuntimeState.lastRefreshError = null;
    warehouseRuntimeState.nextRefreshAt = now + WAREHOUSE_REFRESH_INTERVAL_MS;
    warehouseRuntimeState.refreshCount += meta.countAsRefresh === false ? 0 : 1;
    return getWarehouseCachedPayload();
  }

  function buildWarehouseItemCountMap(items) {
    const map = new Map();
    (Array.isArray(items) ? items : []).forEach((item) => {
      const itemId = Number(item && item.itemId) || 0;
      if (itemId <= 0) return;
      map.set(String(itemId), item);
    });
    return map;
  }

  function summarizeWarehouseSellForUi({ beforeItems, afterItems, requestedItemIds, runtimeResult, reason, auto }) {
    const requestedSet = new Set((Array.isArray(requestedItemIds) ? requestedItemIds : [])
      .map((itemId) => String(Number(itemId) || 0))
      .filter((itemId) => itemId !== "0"));
    const beforeMap = buildWarehouseItemCountMap(beforeItems);
    const afterMap = buildWarehouseItemCountMap(afterItems);
    const soldItems = [];
    beforeMap.forEach((beforeItem, key) => {
      if (requestedSet.size > 0 && !requestedSet.has(key)) return;
      const beforeCount = Number(beforeItem && beforeItem.count) || 0;
      const afterItem = afterMap.get(key);
      const afterCount = Number(afterItem && afterItem.count) || 0;
      if (afterCount >= beforeCount) return;
      const soldCount = beforeCount - afterCount;
      soldItems.push({
        itemId: Number(key) || 0,
        name: beforeItem && beforeItem.name ? beforeItem.name : `物品 ${key}`,
        soldCount,
        saleUnitPrice: Number(beforeItem && beforeItem.saleUnitPrice) || 0,
        estimatedSellPrice: soldCount * (Number(beforeItem && beforeItem.saleUnitPrice) || 0),
      });
    });
    soldItems.sort((a, b) => {
      if (b.estimatedSellPrice !== a.estimatedSellPrice) return b.estimatedSellPrice - a.estimatedSellPrice;
      if (b.soldCount !== a.soldCount) return b.soldCount - a.soldCount;
      return a.itemId - b.itemId;
    });
    const totalSoldCount = soldItems.reduce((sum, item) => sum + (Number(item.soldCount) || 0), 0);
    const totalEstimatedSellPrice = soldItems.reduce((sum, item) => sum + (Number(item.estimatedSellPrice) || 0), 0);
    const matchedTargets = Array.isArray(runtimeResult && runtimeResult.matchedTargets)
      ? runtimeResult.matchedTargets
      : [];
    return {
      ok: !!(runtimeResult && runtimeResult.ok),
      auto: !!auto,
      reason: reason || null,
      observedChange: !!(runtimeResult && runtimeResult.observedChange),
      requestDispatched: !!(runtimeResult && runtimeResult.requestDispatched),
      requestedItemIds: Array.from(requestedSet).map((itemId) => Number(itemId) || 0),
      matchedItemIds: matchedTargets.map((item) => Number(item && item.itemId) || 0).filter(Boolean),
      missingItemIds: Array.isArray(runtimeResult && runtimeResult.missingItemIds) ? runtimeResult.missingItemIds : [],
      unsellableItemIds: Array.isArray(runtimeResult && runtimeResult.unsellableItemIds) ? runtimeResult.unsellableItemIds : [],
      soldDistinct: soldItems.length,
      totalSoldCount,
      totalEstimatedSellPrice,
      soldItems,
      runtimeReason: runtimeResult && runtimeResult.reason ? String(runtimeResult.reason) : null,
      finishedAt: Date.now(),
    };
  }

  function getWarehouseAutoSellCandidateIds(items, configData) {
    const cfg = configData || getWarehouseConfig();
    const allowedCategories = new Set(normalizeWarehouseSellCategoryList(cfg.autoWarehouseSellCategories));
    return (Array.isArray(items) ? items : [])
      .filter((item) => item
        && item.canSell !== false
        && item.canEstimateSale === true
        && (Number(item.estimatedSellPrice) || 0) > 0
        && allowedCategories.has(String(item.category || "").trim().toLowerCase()))
      .map((item) => Number(item.itemId) || 0)
      .filter((itemId, index, list) => itemId > 0 && list.indexOf(itemId) === index);
  }

  function isWarehouseAutoSellDue(configData) {
    const cfg = configData || getWarehouseConfig();
    const intervalHour = normalizeAutoWarehouseSellIntervalHour(cfg.autoWarehouseSellIntervalHour);
    if (intervalHour <= 0) return true;
    return Date.now() >= getWarehouseNextAutoSellAt(cfg);
  }

  async function executeWarehouseSellOperation({ itemIds, reason, auto, forceCloseAfter }) {
    const targetIds = normalizePositiveIntList(itemIds);
    if (targetIds.length <= 0) {
      return {
        warehouse: getWarehouseCachedPayload(),
        sell: {
          ok: false,
          reason: reason || "warehouse_sell_targets_empty",
          requestedItemIds: [],
          soldItems: [],
          soldDistinct: 0,
          totalSoldCount: 0,
          totalEstimatedSellPrice: 0,
        },
      };
    }
    assertQqRuntimeBundleSynced();
    const session = await ensureAutomationSession();
    await ensureAutomationGameCtl(session);
    const runtimeResult = await callAutomationGameCtl(session, "gameCtl.sellWarehouseItems", [{
      silent: true,
      itemIds: targetIds,
      closeAfter: forceCloseAfter !== true,
      forceCloseAfter: forceCloseAfter === true,
      openTimeoutMs: 2600,
      readTimeoutMs: 2600,
      sellTimeoutMs: 9000,
      pollMs: 140,
    }], { timeoutMs: 15000 });
    const beforeItems = normalizeWarehouseRuntimeListForUi(runtimeResult && runtimeResult.beforeItems);
    const hasAfterItems = Array.isArray(runtimeResult && runtimeResult.afterItems);
    const afterItems = normalizeWarehouseRuntimeListForUi(runtimeResult && runtimeResult.afterItems);
    const sellSummary = summarizeWarehouseSellForUi({
      beforeItems,
      afterItems,
      requestedItemIds: targetIds,
      runtimeResult,
      reason,
      auto,
    });
    if (hasAfterItems || beforeItems.length > 0) {
      updateWarehouseCacheFromItems(hasAfterItems ? afterItems : beforeItems, {
        reason: `${reason || "sell"}_after`,
        updatedAt: Date.now(),
        countAsRefresh: false,
      });
    }
    warehouseRuntimeState.lastSellReason = reason || (auto ? "auto_sell" : "manual_sell");
    warehouseRuntimeState.lastSellResult = sellSummary;
    if (sellSummary.ok || sellSummary.totalSoldCount > 0) {
      warehouseRuntimeState.lastSellAt = Date.now();
      warehouseRuntimeState.lastSellError = null;
    } else {
      warehouseRuntimeState.lastSellError = sellSummary.runtimeReason || "未观察到仓库数量变化";
    }
    if (sellSummary.totalSoldCount > 0) {
      sellSummary.statsRecorded = await autoFarmManager.recordWarehouseSell({
        soldCount: sellSummary.totalSoldCount,
        soldDistinct: sellSummary.soldDistinct,
        totalEstimatedSellPrice: sellSummary.totalEstimatedSellPrice,
        reason: auto ? "warehouse_auto_sell" : "warehouse_manual_sell",
        at: Date.now(),
      });
    } else {
      sellSummary.statsRecorded = {
        ok: false,
        reason: "empty_sell",
      };
    }
    return {
      warehouse: getWarehouseCachedPayload(),
      sell: sellSummary,
    };
  }

  async function executeWarehouseRefreshOperation({ reason, allowAutoSell = true } = {}) {
    assertQqRuntimeBundleSynced();
    warehouseRuntimeState.lastRefreshStartedAt = Date.now();
    warehouseRuntimeState.lastRefreshReason = reason || "refresh";
    const session = await ensureAutomationSession();
    await ensureAutomationGameCtl(session);
    let runtimeResult = null;
    let autoSellResult = null;
    let openedByRefresh = false;
    try {
      runtimeResult = await callAutomationGameCtl(session, "gameCtl.refreshWarehouseSnapshot", [{
        silent: true,
        closeAfter: false,
        openTimeoutMs: 2600,
        readTimeoutMs: 3200,
        closeTimeoutMs: 1800,
        waitAfterOpen: 650,
        pollMs: 140,
        allowEmpty: true,
      }], { timeoutMs: 15000 });
      if (!runtimeResult || runtimeResult.ok !== true) {
        throw new Error(runtimeResult && runtimeResult.reason ? String(runtimeResult.reason) : "warehouse_refresh_failed");
      }
      openedByRefresh = runtimeResult.wasOpen === false;
      const normalizedItems = normalizeWarehouseRuntimeListForUi(runtimeResult.items);
      updateWarehouseCacheFromItems(normalizedItems, {
        reason: reason || "refresh",
        updatedAt: Date.now(),
      });

      const cfg = getWarehouseConfig();
      const candidateIds = getWarehouseAutoSellCandidateIds(normalizedItems, cfg);
      if (allowAutoSell && cfg.autoWarehouseSellEnabled === true && candidateIds.length > 0 && isWarehouseAutoSellDue(cfg)) {
        try {
          autoSellResult = await executeWarehouseSellOperation({
            itemIds: candidateIds,
            reason: cfg.autoWarehouseSellIntervalHour <= 0 ? "refresh_auto_sell" : "scheduled_auto_sell",
            auto: true,
            forceCloseAfter: openedByRefresh,
          });
          openedByRefresh = false;
        } catch (error) {
          const err = error instanceof Error ? error : new Error(String(error));
          warehouseRuntimeState.lastSellError = err.message;
          autoSellResult = {
            warehouse: getWarehouseCachedPayload(),
            sell: {
              ok: false,
              auto: true,
              reason: "auto_sell_failed",
              runtimeReason: err.message,
              requestedItemIds: candidateIds,
              soldItems: [],
              soldDistinct: 0,
              totalSoldCount: 0,
              totalEstimatedSellPrice: 0,
            },
          };
        }
      }
      return {
        warehouse: getWarehouseCachedPayload(),
        refresh: {
          ok: true,
          reason: reason || "refresh",
          itemCount: normalizedItems.length,
          refreshedAt: warehouseRuntimeState.lastRefreshAt,
        },
        autoSell: autoSellResult ? autoSellResult.sell : null,
      };
    } finally {
      if (openedByRefresh) {
        try {
          await callAutomationGameCtl(session, "gameCtl.closeWarehouseUi", [{
            silent: true,
            timeoutMs: 1800,
            pollMs: 100,
          }], { timeoutMs: 5000 });
        } catch (_) {}
      }
    }
  }

  async function refreshWarehouseCache(options = {}) {
    return await enqueueWarehouseOperation("warehouse_refresh", () => executeWarehouseRefreshOperation(options));
  }

  async function sellWarehouseItemsForUi(options = {}) {
    return await enqueueWarehouseOperation("warehouse_sell", () => executeWarehouseSellOperation(options));
  }

  async function ensureWarehouseCache(options = {}) {
    const forceRefresh = options.forceRefresh === true;
    const hasCache = !!(warehouseRuntimeState.cache && warehouseRuntimeState.cache.updatedAt);
    if (!forceRefresh && hasCache) return getWarehouseCachedPayload();
    const result = await refreshWarehouseCache({
      reason: options.reason || (hasCache ? "api_force_refresh" : "api_initial_refresh"),
      allowAutoSell: options.allowAutoSell !== false,
    });
    return result && result.warehouse ? result.warehouse : getWarehouseCachedPayload();
  }

  async function runWarehouseMaintenanceTick() {
    const now = Date.now();
    if (warehouseRuntimeState.busy) {
      scheduleWarehouseMaintenance(30 * 1000);
      return;
    }
    if (warehouseRuntimeState.nextRefreshAt && now < warehouseRuntimeState.nextRefreshAt) {
      scheduleWarehouseMaintenance();
      return;
    }
    try {
      await refreshWarehouseCache({ reason: "scheduled_refresh", allowAutoSell: true });
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      if (isWarehouseAutoFarmBusyTimeoutError(err)) {
        warehouseRuntimeState.lastRefreshError = "自动农场长时间占用，仓库刷新已顺延";
        warehouseRuntimeState.nextRefreshAt = Date.now() + WAREHOUSE_BUSY_RETRY_DELAY_MS;
      } else {
        warehouseRuntimeState.lastRefreshError = err.message;
        warehouseRuntimeState.nextRefreshAt = Date.now() + WAREHOUSE_REFRESH_INTERVAL_MS;
      }
      console.log(`[gateway][warehouse] scheduled refresh skipped: ${err.message}`);
      scheduleWarehouseMaintenance();
    }
  }

  const previewManager = new PreviewManager({
    ensureCdp,
    getCdp: () => cdp,
  });
  /** @type {WeakMap<any, Promise<any>>} */
  const previewInputQueues = new WeakMap();
  /** @type {WeakMap<any, { mode: string; session: any; currentX: number; currentY: number; fallbackFrom?: string | null }>} */
  const previewDragSessions = new WeakMap();
  loadFarmConfig()
    .then((savedConfig) => {
      autoFarmManager.updateConfig(savedConfig);
      messagePushManager.updateConfig(savedConfig.messagePush);
      autoFarmBootConfigLoaded = true;
      scheduleWarehouseMaintenance(3000);
      maybeAutoStartAutoFarm("config_loaded");
    })
    .catch(() => {
      messagePushManager.updateConfig(FARM_CONFIG_DEFAULT.messagePush);
      autoFarmBootConfigLoaded = true;
      scheduleWarehouseMaintenance(3000);
      maybeAutoStartAutoFarm("config_load_failed");
    });
  void messagePushManager.init()
    .then(() => messagePushManager.start())
    .catch((error) => {
      const err = error instanceof Error ? error : new Error(String(error));
      console.warn(`[gateway][message_push] init failed: ${err.message}`);
    });
  loadAutoFertilizerState()
    .then((savedState) => {
      autoFarmManager.replaceAutoFertilizerState(savedState, { persist: false });
      autoFarmBootStateLoaded = true;
      maybeAutoStartAutoFarm("auto_fertilizer_state_loaded");
    })
    .catch(() => {
      autoFarmManager.replaceAutoFertilizerState({}, { persist: false });
      autoFarmBootStateLoaded = true;
      maybeAutoStartAutoFarm("auto_fertilizer_state_load_failed");
    });
  loadFriendHelpState()
    .then((savedState) => {
      autoFarmManager.replaceFriendHelpState(savedState, { persist: false });
      autoFarmBootHelpStateLoaded = true;
      maybeAutoStartAutoFarm("friend_help_state_loaded");
    })
    .catch(() => {
      autoFarmManager.replaceFriendHelpState({}, { persist: false });
      autoFarmBootHelpStateLoaded = true;
      maybeAutoStartAutoFarm("friend_help_state_load_failed");
    });
  loadTodayStatsHistory()
    .then((savedHistory) => {
      autoFarmManager.replaceTodayStatsHistory(savedHistory, { persist: false });
      autoFarmBootTodayStatsLoaded = true;
      maybeAutoStartAutoFarm("today_stats_loaded");
    })
    .catch(() => {
      autoFarmManager.replaceTodayStatsHistory([], { persist: false });
      autoFarmBootTodayStatsLoaded = true;
      maybeAutoStartAutoFarm("today_stats_load_failed");
    });

  /**
   * 在 ensureCdp 尚未执行时，WmpfCdpSession 还未订阅 miniappconnected，会漏掉事件。
   * 在网关层先订阅，小程序或 DevTools 一连上就开始建会话并探测 ctx（与 cdp-wmpf-session 内逻辑叠加无害）。
   */
  function kickEnsureCdpOnTransport() {
    ensureCdp().catch(() => {});
  }
  if (wmpfBridge) {
    wmpfBridge.emitter.on("miniappconnected", kickEnsureCdpOnTransport);
  }

  function wrapEvalExpression(userCode) {
    const body = String(userCode || "").trim();
    return `(async () => {\n${body}\n})()`;
  }

  function wrapCallExpression(dotPath, args) {
    const parts = String(dotPath || "").split(".").filter(Boolean);
    if (parts.length === 0) throw new Error("call.path empty");
    const jsonArgs = JSON.stringify(args ?? []);
    return `(async () => {
      const _path = ${JSON.stringify(parts)};
      let cur = globalThis;
      for (let i = 0; i < _path.length; i++) {
        cur = cur[_path[i]];
        if (cur == null) throw new Error('call path not found at: ' + _path.slice(0, i + 1).join('.'));
      }
      if (typeof cur !== 'function') throw new Error('call path is not a function: ' + _path.join('.'));
      return await cur.apply(null, ${jsonArgs});
    })()`;
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
  }

  function clampInt(value, defaultValue, min, max) {
    const n = Number.parseInt(String(value ?? ""), 10);
    const fallback = Number.isFinite(n) ? n : defaultValue;
    return Math.min(max, Math.max(min, fallback));
  }

  function makeTouchPoint(x, y) {
    return {
      x,
      y,
      radiusX: 1,
      radiusY: 1,
      force: 1,
      id: 1,
    };
  }

  function enqueuePreviewInput(socket, task) {
    const prev = previewInputQueues.get(socket) || Promise.resolve();
    const next = prev.catch(() => {}).then(task);
    previewInputQueues.set(socket, next.finally(() => {
      if (previewInputQueues.get(socket) === next) {
        previewInputQueues.delete(socket);
      }
    }));
    return next;
  }

  async function dispatchCdpTap(session, x, y, hold) {
    const point = makeTouchPoint(x, y);

    try {
      await session.sendCommand("Input.dispatchTouchEvent", {
        type: "touchStart",
        touchPoints: [point],
      });
      if (hold > 0) {
        await sleep(hold);
      }
      await session.sendCommand("Input.dispatchTouchEvent", {
        type: "touchEnd",
        touchPoints: [],
      });
      return { mode: "touch" };
    } catch (touchError) {
      await session.sendCommand("Input.dispatchMouseEvent", {
        type: "mouseMoved",
        x,
        y,
        button: "left",
        buttons: 0,
        clickCount: 0,
      });
      await session.sendCommand("Input.dispatchMouseEvent", {
        type: "mousePressed",
        x,
        y,
        button: "left",
        buttons: 1,
        clickCount: 1,
      });
      if (hold > 0) {
        await sleep(hold);
      }
      await session.sendCommand("Input.dispatchMouseEvent", {
        type: "mouseReleased",
        x,
        y,
        button: "left",
        buttons: 0,
        clickCount: 1,
      });
      return {
        mode: "mouse",
        fallbackFrom: touchError instanceof Error ? touchError.message : String(touchError),
      };
    }
  }

  async function beginCdpDrag(session, x, y) {
    const point = makeTouchPoint(x, y);
    try {
      await session.sendCommand("Input.dispatchTouchEvent", {
        type: "touchStart",
        touchPoints: [point],
      });
      return {
        mode: "touch",
        session,
        currentX: x,
        currentY: y,
        fallbackFrom: null,
      };
    } catch (touchError) {
      await session.sendCommand("Input.dispatchMouseEvent", {
        type: "mouseMoved",
        x,
        y,
        button: "left",
        buttons: 0,
        clickCount: 0,
      });
      await session.sendCommand("Input.dispatchMouseEvent", {
        type: "mousePressed",
        x,
        y,
        button: "left",
        buttons: 1,
        clickCount: 1,
      });
      return {
        mode: "mouse",
        session,
        currentX: x,
        currentY: y,
        fallbackFrom: touchError instanceof Error ? touchError.message : String(touchError),
      };
    }
  }

  async function moveCdpDrag(state, x, y) {
    if (state.mode === "touch") {
      await state.session.sendCommand("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: [makeTouchPoint(x, y)],
      });
    } else {
      await state.session.sendCommand("Input.dispatchMouseEvent", {
        type: "mouseMoved",
        x,
        y,
        button: "left",
        buttons: 1,
        clickCount: 1,
      });
    }
    state.currentX = x;
    state.currentY = y;
  }

  async function endCdpDrag(state, x, y) {
    if (state.currentX !== x || state.currentY !== y) {
      await moveCdpDrag(state, x, y);
    }
    if (state.mode === "touch") {
      await state.session.sendCommand("Input.dispatchTouchEvent", {
        type: "touchEnd",
        touchPoints: [],
      });
    } else {
      await state.session.sendCommand("Input.dispatchMouseEvent", {
        type: "mouseReleased",
        x,
        y,
        button: "left",
        buttons: 0,
        clickCount: 1,
      });
    }
    state.currentX = x;
    state.currentY = y;
  }

  async function dispatchCdpSwipe(session, x1, y1, x2, y2, durationMs, steps) {
    const startPoint = {
      x: x1,
      y: y1,
      radiusX: 1,
      radiusY: 1,
      force: 1,
      id: 1,
    };
    const totalSteps = Math.max(1, steps);
    const moveDelayMs = totalSteps > 0 ? Math.max(0, Math.round(durationMs / totalSteps)) : 0;

    try {
      await session.sendCommand("Input.dispatchTouchEvent", {
        type: "touchStart",
        touchPoints: [startPoint],
      });
      for (let i = 1; i <= totalSteps; i++) {
        const ratio = i / totalSteps;
        await session.sendCommand("Input.dispatchTouchEvent", {
          type: "touchMove",
          touchPoints: [{
            x: Math.round(x1 + (x2 - x1) * ratio),
            y: Math.round(y1 + (y2 - y1) * ratio),
            radiusX: 1,
            radiusY: 1,
            force: 1,
            id: 1,
          }],
        });
        if (moveDelayMs > 0 && i < totalSteps) {
          await sleep(moveDelayMs);
        }
      }
      await session.sendCommand("Input.dispatchTouchEvent", {
        type: "touchEnd",
        touchPoints: [],
      });
      return { mode: "touch" };
    } catch (touchError) {
      await session.sendCommand("Input.dispatchMouseEvent", {
        type: "mouseMoved",
        x: x1,
        y: y1,
        button: "left",
        buttons: 0,
        clickCount: 0,
      });
      await session.sendCommand("Input.dispatchMouseEvent", {
        type: "mousePressed",
        x: x1,
        y: y1,
        button: "left",
        buttons: 1,
        clickCount: 1,
      });
      for (let i = 1; i <= totalSteps; i++) {
        const ratio = i / totalSteps;
        await session.sendCommand("Input.dispatchMouseEvent", {
          type: "mouseMoved",
          x: Math.round(x1 + (x2 - x1) * ratio),
          y: Math.round(y1 + (y2 - y1) * ratio),
          button: "left",
          buttons: 1,
          clickCount: 1,
        });
        if (moveDelayMs > 0 && i < totalSteps) {
          await sleep(moveDelayMs);
        }
      }
      await session.sendCommand("Input.dispatchMouseEvent", {
        type: "mouseReleased",
        x: x2,
        y: y2,
        button: "left",
        buttons: 0,
        clickCount: 1,
      });
      return {
        mode: "mouse",
        fallbackFrom: touchError instanceof Error ? touchError.message : String(touchError),
      };
    }
  }

  /**
   * ping 时若只调 getStatusSnapshot 一次，往往仍是「探测中」：connect() 不等待 _prepareGameContext。
   * 在 wmpf 模式下短轮询快照，便于控制页一次 ping 就看到 ctxId（或 prepareError）。
   */
  async function waitCdpSnapshotForPing(session) {
    const snap0 =
      session && typeof session.getStatusSnapshot === "function"
        ? session.getStatusSnapshot()
        : null;
    const maxMs = config.pingContextWaitMs ?? 0;
    if (!snap0 || maxMs <= 0) return { snap: snap0, timedOut: false };
    if (snap0.mode !== "wmpf_bridge") return { snap: snap0, timedOut: false };
    if (snap0.contextReady) return { snap: snap0, timedOut: false };
    if (snap0.transportConnected === false) return { snap: snap0, timedOut: false };
    if (typeof session.requestPrepare === "function") {
      session.requestPrepare(snap0.prepareError ? "ping_retry" : "ping");
    }

    const deadline = Date.now() + maxMs;
    let snap =
      session && typeof session.getStatusSnapshot === "function"
        ? session.getStatusSnapshot()
        : snap0;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 150));
      if (typeof session.requestPrepare === "function") {
        session.requestPrepare(snap.prepareError ? "ping_poll_retry" : "ping_poll");
      }
      snap = session.getStatusSnapshot();
      if (snap.contextReady || snap.prepareError) {
        return { snap, timedOut: false };
      }
    }
    return { snap, timedOut: true };
  }

  /**
   * @param {Record<string, unknown>} msg
   */
  async function dispatch(msg, socket) {
    const op = String(msg.op || "");

    if (op === "ping") {
      let timedOut = false;
      let snap = getCdpSnapshot();
      const resolvedRuntimeTarget = resolveAutomationRuntimeTarget();
      if (resolvedRuntimeTarget !== "qq_ws") {
        await ensureCdp();
        const result = await waitCdpSnapshotForPing(cdp);
        snap = result.snap;
        timedOut = result.timedOut;
      }
      return {
        pong: true,
        cdpUrl: config.cdpWsUrl,
        runtimeTarget: config.runtimeTarget,
        resolvedRuntimeTarget,
        cdp: snap,
        qqWs: getQqWsSnapshot(),
        preview: previewManager.getState(),
        cdpProbeTimedOut: timedOut,
      };
    }

    if (op === "eval") {
      const session = await ensureCdp();
      const execOpts = {
        executionContextId: config.executionContextId,
        awaitPromise: true,
      };
      const code = String(msg.code ?? "");
      const expr = wrapEvalExpression(code);
      const value = await session.evaluate(expr, execOpts);
      return value;
    }

    if (op === "call") {
      const p = String(msg.path ?? "");
      const args = Array.isArray(msg.args) ? msg.args : [];
      if (resolveAutomationRuntimeTarget() === "qq_ws") {
        return await callSelectedRuntimePath(p, args);
      }
      const session = await ensureCdp();
      const execOpts = {
        executionContextId: config.executionContextId,
        awaitPromise: true,
      };
      const expr = wrapCallExpression(p, args);
      return await session.evaluate(expr, execOpts);
    }

    if (op === "injectFile") {
      if (resolveAutomationRuntimeTarget() === "qq_ws") {
        throw new Error("injectFile not supported on qq_ws runtime");
      }
      const session = await ensureCdp();
      const execOpts = {
        executionContextId: config.executionContextId,
        awaitPromise: true,
      };
      const rel = String(msg.path ?? "");
      if (!rel) throw new Error("injectFile.path required");
      const base = path.join(__dirname, "..");
      const abs = path.resolve(base, rel);
      if (!abs.startsWith(base)) {
        throw new Error("injectFile.path must stay under project root");
      }
      const script = await fs.readFile(abs, "utf8");
      const expr = `(async () => { ${script}\n; return { injected: true, file: ${JSON.stringify(rel)} }; })()`;
      const value = await session.evaluate(expr, execOpts);
      return value;
    }

    if (op === "previewStatus") {
      return previewManager.getState();
    }

    if (op === "previewStart") {
      return await previewManager.start(socket, msg.options);
    }

    if (op === "previewStop") {
      previewManager.removeSocket(socket);
      return await previewManager.stop("ws");
    }

    if (op === "previewCapture") {
      return await previewManager.capture(msg.options);
    }

    const session = await ensureCdp();

    if (op === "previewTap") {
      const x = Number(msg.x);
      const y = Number(msg.y);
      const hold = msg.hold == null ? 32 : Number(msg.hold);
      if (!Number.isFinite(x) || !Number.isFinite(y)) {
        throw new Error("previewTap.x / previewTap.y 必须为数字");
      }
      if (!Number.isFinite(hold) || hold < 0) {
        throw new Error("previewTap.hold 必须为非负数字");
      }
      const dispatchResult = await dispatchCdpTap(session, x, y, hold);
      return {
        x,
        y,
        hold,
        result: dispatchResult,
      };
    }

    if (op === "previewDragStart") {
      const x = Number(msg.x);
      const y = Number(msg.y);
      if (!Number.isFinite(x) || !Number.isFinite(y)) {
        throw new Error("previewDragStart.x / y 必须为数字");
      }
      return await enqueuePreviewInput(socket, async () => {
        const existing = previewDragSessions.get(socket);
        if (existing) {
          try {
            await endCdpDrag(existing, existing.currentX, existing.currentY);
          } catch (_) {}
          previewDragSessions.delete(socket);
        }
        const state = await beginCdpDrag(session, x, y);
        previewDragSessions.set(socket, state);
        return {
          x,
          y,
          result: {
            mode: state.mode,
            fallbackFrom: state.fallbackFrom || null,
          },
        };
      });
    }

    if (op === "previewDragMove") {
      const x = Number(msg.x);
      const y = Number(msg.y);
      if (!Number.isFinite(x) || !Number.isFinite(y)) {
        throw new Error("previewDragMove.x / y 必须为数字");
      }
      return await enqueuePreviewInput(socket, async () => {
        const state = previewDragSessions.get(socket);
        if (!state) {
          throw new Error("当前没有活动中的预览拖动");
        }
        await moveCdpDrag(state, x, y);
        return {
          x,
          y,
          result: {
            mode: state.mode,
            fallbackFrom: state.fallbackFrom || null,
          },
        };
      });
    }

    if (op === "previewDragEnd") {
      const x = Number(msg.x);
      const y = Number(msg.y);
      if (!Number.isFinite(x) || !Number.isFinite(y)) {
        throw new Error("previewDragEnd.x / y 必须为数字");
      }
      return await enqueuePreviewInput(socket, async () => {
        const state = previewDragSessions.get(socket);
        if (!state) {
          throw new Error("当前没有活动中的预览拖动");
        }
        await endCdpDrag(state, x, y);
        previewDragSessions.delete(socket);
        return {
          x,
          y,
          result: {
            mode: state.mode,
            fallbackFrom: state.fallbackFrom || null,
          },
        };
      });
    }

    if (op === "previewSwipe") {
      const x1 = Number(msg.x1);
      const y1 = Number(msg.y1);
      const x2 = Number(msg.x2);
      const y2 = Number(msg.y2);
      const durationMs = clampInt(msg.durationMs, 220, 0, 5_000);
      const steps = clampInt(msg.steps, 8, 1, 60);
      if (![x1, y1, x2, y2].every((n) => Number.isFinite(n))) {
        throw new Error("previewSwipe.x1/y1/x2/y2 必须为数字");
      }
      const dispatchResult = await dispatchCdpSwipe(session, x1, y1, x2, y2, durationMs, steps);
      return {
        x1,
        y1,
        x2,
        y2,
        durationMs,
        steps,
        result: dispatchResult,
      };
    }

    throw new Error(`unknown op: ${op}`);
  }

  const httpServer = http.createServer(async (req, res) => {
    if (!req.url) {
      res.writeHead(400);
      res.end();
      return;
    }

    const parsedUrl = parseRequestUrl(req);
    const urlPath = req.url.split("?")[0];

    if (req.method === "GET" && urlPath === "/api/health") {
      if (!cdp && resolveAutomationRuntimeTarget() !== "qq_ws") {
        setImmediate(() => {
          ensureCdp().catch(() => {});
        });
      }
      const payload = {
        ok: true,
        uptimeSec: Math.floor(process.uptime()),
        gateway: {
          cdpWsUrl: config.cdpWsUrl,
          wmpfBridge: !!wmpfBridge,
          runtimeTarget: config.runtimeTarget,
          resolvedRuntimeTarget: resolveAutomationRuntimeTarget(),
          qqWsPath: config.qqWsPath,
        },
        cdp: getCdpSnapshot(),
        qqWs: getQqWsSnapshot(),
        qqBundle: getQqBundleSnapshot(),
        autoFarm: autoFarmManager.getState(),
        preview: previewManager.getState(),
        cdpSessionInitialized: cdp != null,
        cdpWarmPending: cdp == null,
        wsClients: wss.clients.size,
      };
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(payload));
      return;
    }

    if (req.method === "GET" && urlPath === "/api/qq-bundle") {
      try {
        const built = buildQqBundle({
          config,
          projectRoot,
        });
        const asRaw = req.url.includes("raw=1");
        const asDownload = req.url.includes("download=1");
        if (asRaw || asDownload) {
          const filename = built.meta.defaultFilename || "qq-miniapp-bootstrap.js";
          res.writeHead(200, {
            "Content-Type": "text/javascript; charset=utf-8",
            "Content-Disposition": `${asDownload ? "attachment" : "inline"}; filename="${filename}"`,
          });
          res.end(built.bundleText);
          return;
        }
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: true, data: built.meta }));
      } catch (e) {
        const err = e instanceof Error ? e : new Error(String(e));
        res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
      return;
    }

    if (req.method === "GET" && urlPath === "/api/qq-miniapp/find") {
      try {
        const requestUrl = parseRequestUrl(req);
        const target = resolveQqPatchTarget({
          targetPath: requestUrl.searchParams.get("targetPath"),
          appId: requestUrl.searchParams.get("appid"),
          fallbackTargetPath: config.qqGameJsPath,
          fallbackAppId: config.qqAppId,
          srcRoot: requestUrl.searchParams.get("srcRoot") || config.qqMiniappSrcRoot,
        });
        if (!target.targetPath) {
          throw new Error(target.targetError || "未找到可用的 QQ game.js");
        }
        const bundle = getQqBundleSnapshot({
          targetPath: requestUrl.searchParams.get("targetPath"),
          appId: requestUrl.searchParams.get("appid"),
          srcRoot: requestUrl.searchParams.get("srcRoot") || config.qqMiniappSrcRoot,
        });
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: true, data: { ...target, bundle } }));
      } catch (e) {
        const err = e instanceof Error ? e : new Error(String(e));
        res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
      return;
    }

    if (req.method === "POST" && urlPath === "/api/qq-bundle/patch") {
      try {
        const parsed = await readJsonBody(req);
        const target = resolveQqPatchTarget({
          targetPath: parsed.targetPath,
          appId: parsed.appId,
          fallbackTargetPath: config.qqGameJsPath,
          fallbackAppId: config.qqAppId,
          srcRoot: parsed.srcRoot || config.qqMiniappSrcRoot,
        });
        if (!target.targetPath) {
          throw new Error(target.targetError || "未配置 QQ game.js 路径，也未提供 QQ appid");
        }
        const built = buildQqBundle({
          config,
          projectRoot,
        });
        const bundle = getQqBundleSnapshot({
          targetPath: parsed.targetPath,
          appId: parsed.appId,
          srcRoot: parsed.srcRoot || config.qqMiniappSrcRoot,
        });
        const targetPaths = Array.isArray(target.targetPaths) && target.targetPaths.length > 0
          ? target.targetPaths
          : [target.targetPath];
        const patches = patchQqGameFiles(targetPaths, built.bundleText, {
          noBackup: !!parsed.noBackup,
        });
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({
          ok: true,
          data: {
            meta: built.meta,
            bundle,
            target,
            patches,
            patch: patches[0] || null,
            patchedCount: patches.length,
          },
        }));
      } catch (e) {
        const err = e instanceof Error ? e : new Error(String(e));
        res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
      return;
    }

    if (req.method === "GET" && urlPath === "/api/farm-config") {
      try {
        const data = await loadFarmConfig();
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: true, data }));
      } catch (e) {
        const err = e instanceof Error ? e : new Error(String(e));
        res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
      return;
    }

    if (req.method === "POST" && urlPath === "/api/farm-config") {
      try {
        const parsed = await readJsonBody(req);
        const data = await saveFarmConfig(parsed);
        autoFarmManager.updateConfig(data);
        messagePushManager.updateConfig(data.messagePush);
        scheduleWarehouseMaintenance(1500);
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: true, data }));
      } catch (e) {
        const err = e instanceof Error ? e : new Error(String(e));
        res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
      return;
    }

    if (req.method === "GET" && urlPath === "/api/auto-farm") {
      try {
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({
          ok: true,
          data: {
            ...autoFarmManager.getState(),
            messagePushState: messagePushManager.getState(),
          },
        }));
      } catch (e) {
        const err = e instanceof Error ? e : new Error(String(e));
        res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
      return;
    }

    if (req.method === "GET" && urlPath === "/api/task-logs") {
      try {
        const limit = Math.min(5000, Math.max(1, Number(parsedUrl.searchParams.get("limit")) || 500));
        const data = await getRecentTaskLogEntries(limit);
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({
          ok: true,
          data: {
            limit,
            items: data,
          },
        }));
      } catch (e) {
        const err = e instanceof Error ? e : new Error(String(e));
        res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
      return;
    }

    if (req.method === "GET" && urlPath === "/api/task-logs/export") {
      try {
        const limit = Math.min(10000, Math.max(1, Number(parsedUrl.searchParams.get("limit")) || 2000));
        const format = String(parsedUrl.searchParams.get("format") || "txt").trim().toLowerCase();
        const content = await exportTaskLogContent(format, limit);
        const ext = format === "json" ? "json" : "txt";
        const contentType = format === "json"
          ? "application/json; charset=utf-8"
          : "text/plain; charset=utf-8";
        res.writeHead(200, {
          "Content-Type": contentType,
          "Content-Disposition": `attachment; filename=\"task-logs-${Date.now()}.${ext}\"`,
        });
        res.end(content);
      } catch (e) {
        const err = e instanceof Error ? e : new Error(String(e));
        res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
      return;
    }

    if (req.method === "GET" && urlPath === "/api/message-push/state") {
      try {
        const configData = await loadFarmConfig();
        const state = messagePushManager.getState();
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({
          ok: true,
          data: {
            config: configData && configData.messagePush ? configData.messagePush : normalizeMessagePushConfig({}),
            state,
          },
        }));
      } catch (e) {
        const err = e instanceof Error ? e : new Error(String(e));
        res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
      return;
    }

    if (req.method === "POST" && urlPath === "/api/message-push/test") {
      try {
        const parsed = await readJsonBody(req);
        const config = parsed && parsed.config ? normalizeMessagePushConfig(parsed.config) : null;
        const data = await messagePushManager.sendTest(config);
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: true, data }));
      } catch (e) {
        const err = e instanceof Error ? e : new Error(String(e));
        res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
      return;
    }

    if (req.method === "GET" && urlPath === "/api/reward-popup-interceptor") {
      try {
        const data = await inspectRewardPopupInterceptorForUi({
          timeoutMs: parsedUrl.searchParams.get("timeoutMs"),
        });
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: true, data }));
      } catch (e) {
        const err = e instanceof Error ? e : new Error(String(e));
        res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
      return;
    }

    if (req.method === "POST" && urlPath === "/api/reward-popup-interceptor") {
      try {
        const parsed = await readJsonBody(req);
        if (typeof parsed.enabled !== "boolean") {
          throw new Error("enabled must be boolean");
        }
        const data = await setRewardPopupInterceptorForUi(parsed);
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: true, data }));
      } catch (e) {
        const err = e instanceof Error ? e : new Error(String(e));
        res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
      return;
    }

    if (req.method === "GET" && urlPath === "/api/friends") {
      try {
        const refresh = parsedUrl.searchParams.get("refresh") !== "0";
        const data = await fetchFriendListForUi({
          ensureAutomationSession,
          ensureAutomationGameCtl,
          callAutomationGameCtl,
          autoFarmManager,
          refresh,
        });
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: true, data }));
      } catch (e) {
        const err = e instanceof Error ? e : new Error(String(e));
        res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
      return;
    }

    if (req.method === "GET" && urlPath === "/api/analytics") {
      try {
        const sort = String(parsedUrl.searchParams.get("sort") || "exp").trim().toLowerCase();
        const maxLevel = Number(parsedUrl.searchParams.get("maxLevel") || "0");
        let profile = null;
        try {
          profile = await fetchPlayerProfileForUi({
            ensureAutomationSession,
            ensureAutomationGameCtl,
            callAutomationGameCtl,
            config,
            getQqWsSnapshot,
            profileCache: playerProfileCache,
          });
        } catch (_) {
          profile = null;
        }
        const levelInfo = normalizeAnalyticsLevelRequest(maxLevel, profile);
        const normalizedMaxLevel = Number.isFinite(maxLevel) ? maxLevel : 0;
        const list = sortAnalyticsList(
          filterAnalyticsByLevel(getPlantAnalyticsList(), levelInfo.effectiveMaxLevel),
          sort
        ).map(enrichAnalyticsRowForUi);
        let availability = null;
        try {
          const fetched = await fetchSeedAvailabilityForUi({
            ensureAutomationSession,
            ensureAutomationGameCtl,
            callAutomationGameCtl,
          });
          availability = {
            ...fetched,
            ...buildAvailableSeedMaps(fetched.seedList, fetched.shopList),
          };
        } catch (_) {
          availability = null;
        }
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({
          ok: true,
          data: {
            list,
            sort,
            maxLevel: normalizedMaxLevel,
            requestedMaxLevel: levelInfo.requestedMaxLevel,
            effectiveMaxLevel: levelInfo.effectiveMaxLevel,
            levelSource: levelInfo.levelSource,
            profile,
            strategies: getPlantStrategyModes(),
            recommendations: buildAnalyticsStrategyCards(levelInfo.effectiveMaxLevel, availability).map((item) => ({
              ...item,
              recommended: enrichAnalyticsRowForUi(item && item.recommended),
              currentRecommended: enrichAnalyticsRowForUi(item && item.currentRecommended),
              theoreticalRecommended: enrichAnalyticsRowForUi(item && item.theoreticalRecommended),
            })),
          },
        }));
      } catch (e) {
        const err = e instanceof Error ? e : new Error(String(e));
        res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
      return;
    }

    if (req.method === "GET" && urlPath === "/api/backpack-seed-options") {
      try {
        const selectedSeedIds = normalizePositiveIntList(parsedUrl.searchParams.get("selected"));
        const forcePriority = parsedUrl.searchParams.get("forcePriority") === "1";
        let availability = { seedList: [], shopList: [] };
        try {
          availability = await fetchSeedAvailabilityForUi({
            ensureAutomationSession,
            ensureAutomationGameCtl,
            callAutomationGameCtl,
          });
        } catch (_) {
          availability = { seedList: [], shopList: [] };
        }
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({
          ok: true,
          data: {
            updatedAt: Date.now(),
            list: buildBackpackSeedPriorityOptions(availability.seedList, {
              selectedSeedIds,
              forcePriority,
            }),
          },
        }));
      } catch (e) {
        const err = e instanceof Error ? e : new Error(String(e));
        res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
      return;
    }

    if (req.method === "GET" && urlPath === "/api/steal-crop-options") {
      try {
        const configData = await loadFarmConfig();
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({
          ok: true,
          data: {
            list: buildStealCropBlacklistOptions(),
            enabled: configData.autoFarmFriendStealPlantBlacklistEnabled === true,
            strategy: Number(configData.autoFarmFriendStealPlantBlacklistStrategy) === 2 ? 2 : 1,
            selected: normalizePositiveIntList(configData.autoFarmFriendStealPlantBlacklist),
          },
        }));
      } catch (e) {
        const err = e instanceof Error ? e : new Error(String(e));
        res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
      return;
    }

    if (req.method === "GET" && urlPath === "/api/lands") {
      try {
        assertQqRuntimeBundleSynced();
        const data = await fetchLandDetailsForUi({
          ensureAutomationSession,
          ensureAutomationGameCtl,
          callAutomationGameCtl,
        });
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: true, data }));
      } catch (e) {
        const err = e instanceof Error ? e : new Error(String(e));
        res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
      return;
    }

    if (req.method === "GET" && urlPath === "/api/warehouse") {
      try {
        const forceRefresh = parsedUrl.searchParams.get("refresh") === "1";
        const data = await ensureWarehouseCache({
          forceRefresh,
          reason: forceRefresh ? "api_get_force_refresh" : "api_get",
          allowAutoSell: true,
        });
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: true, data }));
      } catch (e) {
        const err = e instanceof Error ? e : new Error(String(e));
        res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
      return;
    }

    if (req.method === "POST" && urlPath === "/api/warehouse/refresh") {
      try {
        const data = await refreshWarehouseCache({
          reason: "manual_refresh",
          allowAutoSell: true,
        });
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: true, data }));
      } catch (e) {
        const err = e instanceof Error ? e : new Error(String(e));
        res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
      return;
    }

    if (req.method === "POST" && urlPath === "/api/warehouse/sell") {
      try {
        const parsed = await readJsonBody(req);
        const configData = await loadFarmConfig();
        if (configData.autoWarehouseSellEnabled === false) {
          throw new Error("仓库出售总开关已关闭");
        }
        const itemIds = normalizePositiveIntList(
          Array.isArray(parsed.itemIds)
            ? parsed.itemIds
            : (parsed.itemId != null ? [parsed.itemId] : [])
        );
        if (itemIds.length <= 0) {
          throw new Error("请选择至少 1 个仓库物品");
        }
        const data = await sellWarehouseItemsForUi({
          itemIds,
          reason: itemIds.length === 1 ? "manual_single_sell" : "manual_batch_sell",
          auto: false,
        });
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: true, data }));
      } catch (e) {
        const err = e instanceof Error ? e : new Error(String(e));
        res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
      return;
    }

    if (req.method === "GET" && urlPath === "/api/plant-strategy-preview") {
      try {
        const mode = normalizePreviewMode(parsedUrl.searchParams.get("mode"));
        const specifiedSeedId = Number(parsedUrl.searchParams.get("seedId") || "0");
        const backpackPrioritySeedIds = normalizePositiveIntList(parsedUrl.searchParams.get("backpackPriority"));
        const requestedMaxLevel = Number(parsedUrl.searchParams.get("maxLevel") || "0");
        let profile = null;
        try {
          profile = await fetchPlayerProfileForUi({
            ensureAutomationSession,
            ensureAutomationGameCtl,
            callAutomationGameCtl,
            config,
            getQqWsSnapshot,
            profileCache: playerProfileCache,
          });
        } catch (_) {
          profile = null;
        }
        const levelInfo = normalizeAnalyticsLevelRequest(requestedMaxLevel, profile);
        const rankings = filterShopEligiblePlants(
          filterAnalyticsByLevel(getPlantAnalyticsList(), levelInfo.effectiveMaxLevel),
        );

        let availability = null;
        let availabilityError = null;
        try {
          const fetched = await fetchSeedAvailabilityForUi({
            ensureAutomationSession,
            ensureAutomationGameCtl,
            callAutomationGameCtl,
          });
          availability = {
            ...fetched,
            ...buildAvailableSeedMaps(fetched.seedList, fetched.shopList),
          };
        } catch (error) {
          availabilityError = error instanceof Error ? error.message : String(error);
        }

        const response = {
          mode,
          requestedMaxLevel: levelInfo.requestedMaxLevel,
          effectiveMaxLevel: levelInfo.effectiveMaxLevel,
          levelSource: levelInfo.levelSource,
          profile,
          availabilityError,
          preview: null,
        };

        if (mode === "none") {
          response.preview = { mode, label: "当前不会自动种植", reason: "disabled" };
        } else if (mode === "backpack_first") {
          const backpackPreview = availability
            ? pickBackpackPreview(availability.seedList, backpackPrioritySeedIds)
            : null;
          if (backpackPreview && backpackPreview.plant) {
            response.preview = {
              mode,
              seedId: backpackPreview.seedId,
              plant: backpackPreview.plant,
              source: "backpack",
              usedBackpackPriority: backpackPreview.usedPriority,
              label: backpackPreview.usedPriority
                ? `背包优先，按自定义顺序当前会先种 ${backpackPreview.plant.name}`
                : `背包优先，当前会先种 ${backpackPreview.plant.name}`,
              reason: "resolved",
            };
          } else {
            const blockedBackpackSeeds = availability
              ? buildBackpackSeedPriorityOptions(availability.seedList).filter((item) => item && item.plantable === false)
              : [];
            response.preview = {
              mode,
              label: blockedBackpackSeeds.length > 0
                ? ("背包优先，但当前背包只有不可种植种子：" + blockedBackpackSeeds.map((item) => item.name || `seed=${item.seedId}`).join("、"))
                : "背包优先，但当前背包没有可用种子",
              reason: "no_seeds_in_backpack",
            };
          }
        } else if (mode === "specified_seed") {
          const plant = getPlantBySeedId(specifiedSeedId);
          response.preview = {
            mode,
            seedId: specifiedSeedId > 0 ? specifiedSeedId : null,
            plant: plant ? {
              seedId: Number(plant.seed_id) || null,
              name: plant.name || null,
              level: Number(plant.land_level_need) || null,
              plantSize: Number(plant.size) || 1,
            } : null,
            label: specifiedSeedId > 0
              ? (plant ? `指定种子：${plant.name}` : `指定种子：seed=${specifiedSeedId}`)
              : "指定种子优先，但尚未选择种子",
            reason: specifiedSeedId > 0 ? "specified_seed" : "seed_id_required",
          };
        } else {
          const sortMap = {
            highest_level: "level",
            max_exp: "exp",
            max_fert_exp: "fert_exp",
            max_profit: "profit",
            max_fert_profit: "fert_profit",
          };
          const sorted = sortAnalyticsList(rankings, sortMap[mode] || "exp");
          const resolved = availability
            ? pickPlantPreviewFromRankings(mode, sorted, availability)
            : (sorted[0] ? { plant: sorted[0], source: "static" } : null);
          if (resolved && resolved.plant) {
            response.preview = {
              mode,
              label: `${getPlantStrategyModes().find((item) => item.value === mode)?.label || mode}，预计种植 ${resolved.plant.name}`,
              plant: resolved.plant,
              source: resolved.source,
              reason: "resolved",
            };
          } else {
            response.preview = {
              mode,
              label: "当前条件下没有匹配的常规可种作物",
              reason: "no_match",
            };
          }
        }

        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: true, data: response }));
      } catch (e) {
        const err = e instanceof Error ? e : new Error(String(e));
        res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
      return;
    }

    if (req.method === "GET" && urlPath === "/api/lands-debug") {
      try {
        assertQqRuntimeBundleSynced();
        const data = await fetchLandDetailsDebugForUi({
          ensureAutomationSession,
          ensureAutomationGameCtl,
          callAutomationGameCtl,
        });
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: true, data }));
      } catch (e) {
        const err = e instanceof Error ? e : new Error(String(e));
        res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
      return;
    }

    if (req.method === "GET" && urlPath === "/api/farm-model-debug") {
      try {
        assertQqRuntimeBundleSynced();
        const data = await fetchFarmModelRuntimeDebug({
          ensureAutomationSession,
          ensureAutomationGameCtl,
          callAutomationGameCtl,
        });
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: true, data }));
      } catch (e) {
        const err = e instanceof Error ? e : new Error(String(e));
        res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
      return;
    }

    if (req.method === "GET" && urlPath === "/api/main-ui-debug") {
      try {
        assertQqRuntimeBundleSynced();
        const data = await fetchMainUiRuntimeDebug({
          ensureAutomationSession,
          ensureAutomationGameCtl,
          callAutomationGameCtl,
        });
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: true, data }));
      } catch (e) {
        const err = e instanceof Error ? e : new Error(String(e));
        res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
      return;
    }

    if (req.method === "GET" && urlPath === "/api/farm-component-candidates") {
      try {
        assertQqRuntimeBundleSynced();
        const data = await fetchFarmComponentCandidatesDebug({
          ensureAutomationSession,
          ensureAutomationGameCtl,
          callAutomationGameCtl,
        });
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: true, data }));
      } catch (e) {
        const err = e instanceof Error ? e : new Error(String(e));
        res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
      return;
    }

    if (req.method === "GET" && urlPath === "/api/player-profile") {
      try {
        let profile = await fetchPlayerProfileForUi({
          ensureAutomationSession,
          ensureAutomationGameCtl,
          callAutomationGameCtl,
          config,
          getQqWsSnapshot,
          profileCache: playerProfileCache,
        });
        profile = decoratePlayerProfile(profile);
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: true, data: profile }));
      } catch (e) {
        const err = e instanceof Error ? e : new Error(String(e));
        res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
      return;
    }

    if (req.method === "GET" && urlPath === "/api/player-profile-debug") {
      res.writeHead(410, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: false, error: "player profile debug disabled" }));
      return;
    }

    if (req.method === "GET" && urlPath === "/api/account-runtime-debug") {
      res.writeHead(410, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: false, error: "account runtime debug disabled" }));
      return;
    }

    if (req.method === "GET" && urlPath === "/api/account-system-debug") {
      try {
        const data = await scanSystemAccountCandidatesForUi({
          ensureAutomationSession,
          ensureAutomationGameCtl,
          callAutomationGameCtl,
        });
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: true, data }));
      } catch (e) {
        const err = e instanceof Error ? e : new Error(String(e));
        res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
      return;
    }

    if (req.method === "GET" && urlPath === "/api/fertilizer-runtime-debug") {
      try {
        const landIdRaw = parsedUrl.searchParams.get("landId");
        const landId = landIdRaw == null || landIdRaw === "" ? null : Number(landIdRaw);
        const targetPath = String(parsedUrl.searchParams.get("path") || "").trim();
        const data = await inspectFertilizerRuntimeForUi({
          ensureAutomationSession,
          ensureAutomationGameCtl,
          callAutomationGameCtl,
          landId: Number.isFinite(landId) ? landId : null,
          path: targetPath || null,
        });
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: true, data }));
      } catch (e) {
        const err = e instanceof Error ? e : new Error(String(e));
        res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
      return;
    }

    if (req.method === "GET" && urlPath === "/api/protocol-transport-debug") {
      try {
        const data = await inspectProtocolTransportForUi({
          ensureAutomationSession,
          ensureAutomationGameCtl,
          callAutomationGameCtl,
        });
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: true, data }));
      } catch (e) {
        const err = e instanceof Error ? e : new Error(String(e));
        res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
      return;
    }

    if (req.method === "GET" && (urlPath === "/api/click-trace-debug" || urlPath === "/api/clicktrace-debug")) {
      try {
        const limit = parsedUrl.searchParams.get("limit");
        const data = await inspectRecentClickTraceForUi({
          ensureAutomationSession,
          ensureAutomationGameCtl,
          callAutomationGameCtl,
          limit,
        });
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: true, data }));
      } catch (e) {
        const err = e instanceof Error ? e : new Error(String(e));
        res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
      return;
    }

    if (req.method === "POST" && urlPath === "/api/fertilize-land") {
      try {
        const body = await readJsonBody(req);
        const data = await fertilizeLandForUi({
          ensureAutomationSession,
          ensureAutomationGameCtl,
          callAutomationGameCtl,
          autoFarmManager,
          body,
        });
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: true, data }));
      } catch (e) {
        const err = e instanceof Error ? e : new Error(String(e));
        res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
      return;
    }

    if (req.method === "GET" && urlPath === "/api/default-plant-image") {
      try {
        const imagePath = getDefaultPlantImagePath();
        if (!imagePath) {
          res.writeHead(404, { "Content-Type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({ ok: false, error: "default image not found" }));
          return;
        }
        const ext = path.extname(imagePath).toLowerCase();
        res.writeHead(200, {
          "Content-Type": MIME[ext] || "application/octet-stream",
          "Cache-Control": "public, max-age=3600",
        });
        fsSync.createReadStream(imagePath).pipe(res);
      } catch (e) {
        const err = e instanceof Error ? e : new Error(String(e));
        res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
      return;
    }

    if (req.method === "GET" && urlPath === "/api/plant-image") {
      try {
        const seedId = Number(parsedUrl.searchParams.get("seedId") || "0");
        const currentStage = Number(parsedUrl.searchParams.get("currentStage") || "0");
        const phaseName = String(parsedUrl.searchParams.get("phaseName") || "").trim();
        const imagePath = getPlantStageImagePathBySeedId(seedId, {
          currentStage: Number.isFinite(currentStage) && currentStage > 0 ? currentStage : null,
          phaseName: phaseName || null,
        }) || getSeedImagePathBySeedId(seedId) || getDefaultPlantImagePath();
        if (!imagePath) {
          res.writeHead(404, { "Content-Type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({ ok: false, error: "image not found" }));
          return;
        }
        const ext = path.extname(imagePath).toLowerCase();
        res.writeHead(200, {
          "Content-Type": MIME[ext] || "application/octet-stream",
          "Cache-Control": "public, max-age=3600",
        });
        fsSync.createReadStream(imagePath).pipe(res);
      } catch (e) {
        const err = e instanceof Error ? e : new Error(String(e));
        res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
      return;
    }

    if (req.method === "GET" && urlPath === "/api/item-image") {
      try {
        const itemId = Number(parsedUrl.searchParams.get("itemId") || "0");
        const imagePath = getExternalItemImagePathByItemId(itemId) || getDefaultPlantImagePath();
        if (!imagePath) {
          res.writeHead(404, { "Content-Type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({ ok: false, error: "image not found" }));
          return;
        }
        const ext = path.extname(imagePath).toLowerCase();
        res.writeHead(200, {
          "Content-Type": MIME[ext] || "application/octet-stream",
          "Cache-Control": "public, max-age=3600",
        });
        fsSync.createReadStream(imagePath).pipe(res);
      } catch (e) {
        const err = e instanceof Error ? e : new Error(String(e));
        res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
      return;
    }

    if (req.method === "POST" && urlPath === "/api/friends/action") {
      try {
        const parsed = await readJsonBody(req);
        const action = String(parsed.action || "").trim();
        const target = parsed.target;
        if (!action) throw new Error("action required");
        const currentConfig = autoFarmManager.getState().config || { ...FARM_CONFIG_DEFAULT };

        if (
          action === "blacklist_add" || action === "blacklist_remove" || action === "blacklist_toggle"
          || action === "whitelist_add" || action === "whitelist_remove" || action === "whitelist_toggle"
        ) {
          const ruleSource = parsed.rule != null ? parsed.rule : target;
          const rule = String(ruleSource == null ? "" : ruleSource).trim();
          if (!rule) throw new Error("friend rule required");
          const configKey = action.startsWith("white") ? "autoFarmFriendWhitelist" : "autoFarmFriendBlacklist";
          const nextList = Array.isArray(currentConfig[configKey])
            ? [...currentConfig[configKey]]
            : [];
          const exists = nextList.includes(rule);
          let changed = false;
          if (action.endsWith("_add") || (action.endsWith("_toggle") && !exists)) {
            if (!exists) {
              nextList.push(rule);
              changed = true;
            }
          } else if (action.endsWith("_remove") || (action.endsWith("_toggle") && exists)) {
            const filtered = nextList.filter((item) => item !== rule);
            if (filtered.length !== nextList.length) {
              nextList.splice(0, nextList.length, ...filtered);
              changed = true;
            }
          }
          const savedConfig = changed
            ? await saveFarmConfig({ [configKey]: nextList })
            : currentConfig;
          autoFarmManager.updateConfig(savedConfig);
          const data = await fetchFriendListForUi({
            ensureAutomationSession,
            ensureAutomationGameCtl,
            callAutomationGameCtl,
            autoFarmManager,
            refresh: false,
          });
          res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({
            ok: true,
            data,
            savedConfig,
            changed,
          }));
          return;
        }

        const normalizedTarget = /^\d+$/.test(String(target == null ? "" : target).trim())
          ? Number(String(target).trim())
          : String(target == null ? "" : target).trim();
        if (!normalizedTarget && normalizedTarget !== 0) throw new Error("target required");
        const session = await ensureAutomationSession();
        await ensureAutomationGameCtl(session);

        if (action === "enter") {
          const result = await callAutomationGameCtl(session, "gameCtl.enterFriendFarm", [normalizedTarget, {
            waitMs: Math.max(0, Number(parsed.enterWaitMs) || Number(currentConfig.autoFarmEnterWaitMs) || 0),
            includeAfterOwnership: true,
            silent: true,
          }]);
          res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({ ok: true, data: { action, result } }));
          return;
        }

        if (action === "steal" || action === "help") {
          const result = await performFriendOperation({
            session,
            callAutomationGameCtl,
            target: normalizedTarget,
            action,
            enterWaitMs: parsed.enterWaitMs != null ? parsed.enterWaitMs : currentConfig.autoFarmEnterWaitMs,
            actionWaitMs: parsed.actionWaitMs != null ? parsed.actionWaitMs : currentConfig.autoFarmActionWaitMs,
            returnHome: parsed.returnHome !== false,
          });
          if (action === "help" && autoFarmManager && result && result.ok === true) {
            try {
              if (Array.isArray(result.actions) && result.actions.length > 0) {
                result.helpTracked = await autoFarmManager.recordFriendHelpRound({
                  friendGid: typeof normalizedTarget === "number" ? normalizedTarget : null,
                  reason: "manual_friend_help",
                });
              } else {
                result.helpTracked = null;
              }
            } catch (_) {
              result.helpTracked = null;
            }
          }
          res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({ ok: true, data: result }));
          return;
        }

        throw new Error(`unknown friend action: ${action}`);
      } catch (e) {
        const err = e instanceof Error ? e : new Error(String(e));
        res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
      return;
    }

    if (req.method === "POST" && urlPath === "/api/auto-farm") {
      try {
        const parsed = await readJsonBody(req);
        const action = String(parsed.action || "update").trim();
        let savedConfig = null;
        if (parsed.config && typeof parsed.config === "object") {
          savedConfig = await saveFarmConfig(parsed.config);
          autoFarmManager.updateConfig(savedConfig);
          messagePushManager.updateConfig(savedConfig.messagePush);
          scheduleWarehouseMaintenance(1500);
        }

        let data;
        if (action === "start") {
          data = autoFarmManager.start(savedConfig || parsed.config);
        } else if (action === "stop") {
          data = autoFarmManager.stop("api");
        } else if (action === "runOnce") {
          data = await autoFarmManager.runOnce(savedConfig || parsed.config);
        } else if (action === "runTask") {
          data = await autoFarmManager.runTaskNow(parsed.taskId, savedConfig || parsed.config);
        } else if (action === "update") {
          if (!savedConfig && parsed.config && typeof parsed.config === "object") {
            autoFarmManager.updateConfig(parsed.config);
            scheduleWarehouseMaintenance(1500);
          }
          data = autoFarmManager.getState();
        } else {
          throw new Error(`unknown auto-farm action: ${action}`);
        }

        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: true, data, savedConfig }));
      } catch (e) {
        const err = e instanceof Error ? e : new Error(String(e));
        res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
      return;
    }

    if (req.method !== "GET") {
      res.writeHead(405);
      res.end();
      return;
    }

    let rel = urlPath === "/" ? "index.html" : urlPath.replace(/^\//, "");
    rel = path.normalize(rel);
    if (rel.includes("..") || path.isAbsolute(rel)) {
      res.writeHead(403);
      res.end("Forbidden");
      return;
    }

    const filePath = path.join(publicRoot, rel);
    if (!filePath.startsWith(publicRoot)) {
      res.writeHead(403);
      res.end("Forbidden");
      return;
    }

    try {
      if (!fsSync.existsSync(filePath)) {
        res.writeHead(404);
        res.end("Not found");
        return;
      }
      const stat = fsSync.statSync(filePath);
      if (stat.isDirectory()) {
        res.writeHead(403);
        res.end("Forbidden");
        return;
      }
      const ext = path.extname(filePath);
      res.setHeader("Content-Type", MIME[ext] || "application/octet-stream");
      fsSync.createReadStream(filePath).pipe(res);
    } catch {
      res.writeHead(500);
      res.end();
    }
  });

  qqWsSession.attach();

  wss = new WebSocket.Server({ noServer: true });

  httpServer.on("upgrade", (req, socket, head) => {
    const urlPath = req && req.url ? req.url.split("?")[0] : "";
    if (urlPath === WS_PATH) {
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit("connection", ws, req);
      });
      return;
    }
    if (urlPath === config.qqWsPath) {
      qqWsSession.handleUpgrade(req, socket, head);
      return;
    }
    socket.destroy();
  });

  wss.on("connection", (socket) => {
    socket.on("message", async (data) => {
      let raw = data;
      if (Buffer.isBuffer(data)) raw = data.toString("utf8");
      else if (data instanceof ArrayBuffer) raw = Buffer.from(data).toString("utf8");

      let msg;
      try {
        msg = JSON.parse(raw);
      } catch (e) {
        socket.send(
          JSON.stringify({
            id: null,
            ok: false,
            error: "invalid JSON",
            detail: String(e),
          }),
        );
        return;
      }

      const reqId = msg.id != null ? msg.id : null;

      try {
        const result = await dispatch(msg, socket);
        socket.send(JSON.stringify({ id: reqId, ok: true, result }));
      } catch (e) {
        const err = e instanceof Error ? e : new Error(String(e));
        socket.send(
          JSON.stringify({
            id: reqId,
            ok: false,
            error: err.message,
            detail: /** @type any */ (err).exceptionDetails ?? undefined,
          }),
        );
      }
    });
    socket.on("close", () => {
      const dragState = previewDragSessions.get(socket);
      if (dragState) {
        previewDragSessions.delete(socket);
        void endCdpDrag(dragState, dragState.currentX, dragState.currentY).catch(() => {});
      }
      previewManager.removeSocket(socket);
      const state = previewManager.getState();
      if (state.running && state.subscriberCount === 0) {
        void previewManager.stop("all sockets closed");
      }
    });
  });

  return {
    httpServer,
    wss,
    close: () => {
      autoFarmManager.stop("gateway close");
      void messagePushManager.close();
      void previewManager.close();
      if (warehouseRuntimeState.timer) {
        clearTimeout(warehouseRuntimeState.timer);
        warehouseRuntimeState.timer = null;
      }
      if (wmpfBridge) {
        wmpfBridge.emitter.off("miniappconnected", kickEnsureCdpOnTransport);
      }
      qqWsSession.close();
      wss.close();
      httpServer.close();
      if (cdp) cdp.close();
      cdp = null;
    },
    getCdp: () => cdp,
    getQqWsSession: () => qqWsSession,
  };
}

module.exports = { createGateway, WS_PATH };
