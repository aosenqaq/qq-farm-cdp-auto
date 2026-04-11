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
const { AutoFarmManager } = require("./auto-farm-manager");
const { PreviewManager } = require("./preview-manager");
const { QqWsSession } = require("./qq-ws-session");
const { ensureGameCtl, callGameCtl } = require("./game-ctl-utils");
const { buildQqBundle, getQqBundleState, patchQqGameFile, resolveQqPatchTarget } = require("./qq-bundle");
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
  getLevelExpProgress,
  getPlantGrowTimeSec,
  formatGrowTime,
  getSeedImagePathBySeedId,
} = require("./game-config");
const { getProfilePlantLevel, resolveProfileWithCandidates } = require("./player-profile-resolver");
const { STEAL_CROP_BLACKLIST_OPTIONS } = require("./steal-crop-blacklist-options");

const WS_PATH = "/ws";
const REQUIRED_GAME_CTL_METHODS = [...QQ_RPC_GAME_CTL_METHODS];

/** 农场功能开关默认值（与页面一致；可 POST /api/farm-config 持久化） */
const FARM_CONFIG_DEFAULT = {
  autoInjectButton: false,
  showLandOverlay: true,
  enableOneClickHarvest: true,
  enableFriendSteal: false,
  verboseLog: false,
  autoFarmOwnEnabled: true,
  autoFarmFriendEnabled: false,
  autoFarmOwnIntervalSec: 30,
  autoFarmFriendIntervalSec: 90,
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
  autoFarmPlantMaxLevel: 0,
  autoFarmFertilizerEnabled: false,
  autoFarmFertilizerMode: "none",
  autoFarmFertilizerMultiSeason: false,
  autoFarmFertilizerLandTypes: ["gold", "black", "red", "normal"],
  autoFarmFertilizerGift: false,
  autoFarmFertilizerBuy: false,
  autoFarmFertilizerBuyType: "organic",
  autoFarmFertilizerBuyMax: 10,
  autoFarmFertilizerBuyMode: "threshold",
  autoFarmFertilizerBuyThreshold: 100,
  autoFarmFriendQuietHoursEnabled: false,
  autoFarmFriendQuietHoursStart: "23:00",
  autoFarmFriendQuietHoursEnd: "07:00",
  autoFarmFriendBlockMaskedStealers: true,
  autoFarmFriendBlacklist: [],
  autoFarmFriendStealPlantBlacklistEnabled: false,
  autoFarmFriendStealPlantBlacklistStrategy: 1,
  autoFarmFriendStealPlantBlacklist: [],
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
      if (base.nextLevelExp == null && progress.nextLevelTotalExp != null) {
        base.nextLevelExp = progress.nextLevelTotalExp;
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
  return {
    runtimeScriptHash,
    expectedScriptHash,
    inSync: !!(runtimeScriptHash && expectedScriptHash && runtimeScriptHash === expectedScriptHash),
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
  if (overlay.gold != null) base.gold = overlay.gold;
  if (overlay.exp != null) base.exp = overlay.exp;
  if (overlay.nextLevelExp != null) base.nextLevelExp = overlay.nextLevelExp;
  if (overlay.levelProgress != null) base.levelProgress = overlay.levelProgress;
  if (overlay.farmMaxLandLevel != null) base.farmMaxLandLevel = overlay.farmMaxLandLevel;
  const merged = { ...base, ...overlay };
  const plantLevel = getProfilePlantLevel(merged);
  if (plantLevel > 0) {
    merged.plantLevel = plantLevel;
    if (!(Number(merged.farmMaxLandLevel) > 0) && plantLevel > (Number(merged.level) || 0)) {
      merged.farmMaxLandLevel = plantLevel;
    }
  }
  return merged;
}

function farmConfigPath() {
  return path.join(__dirname, "..", "data", "farm-config.json");
}

async function loadFarmConfig() {
  try {
    const raw = await fs.readFile(farmConfigPath(), "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") {
      const merged = { ...FARM_CONFIG_DEFAULT, ...parsed };
      merged.autoFarmFriendStealPlantBlacklistEnabled = merged.autoFarmFriendStealPlantBlacklistEnabled === true;
      merged.autoFarmFriendStealPlantBlacklistStrategy = [1, 2].includes(Number(merged.autoFarmFriendStealPlantBlacklistStrategy))
        ? Number(merged.autoFarmFriendStealPlantBlacklistStrategy)
        : 1;
      merged.autoFarmFriendStealPlantBlacklist = normalizePositiveIntList(merged.autoFarmFriendStealPlantBlacklist);
      return merged;
    }
  } catch (_) {
    /* 无文件或解析失败 */
  }
  return { ...FARM_CONFIG_DEFAULT };
}

async function saveFarmConfig(partial) {
  const cur = await loadFarmConfig();
  const next = { ...cur, ...(partial && typeof partial === "object" ? partial : {}) };
  next.autoFarmFriendStealPlantBlacklistEnabled = next.autoFarmFriendStealPlantBlacklistEnabled === true;
  next.autoFarmFriendStealPlantBlacklistStrategy = [1, 2].includes(Number(next.autoFarmFriendStealPlantBlacklistStrategy))
    ? Number(next.autoFarmFriendStealPlantBlacklistStrategy)
    : 1;
  next.autoFarmFriendStealPlantBlacklist = normalizePositiveIntList(next.autoFarmFriendStealPlantBlacklist);
  const dir = path.join(__dirname, "..", "data");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(farmConfigPath(), JSON.stringify(next, null, 2), "utf8");
  return next;
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

function buildFriendSearchFields(friend) {
  if (!friend || typeof friend !== "object") return [];
  const fields = [];
  if (friend.displayName != null) fields.push(friend.displayName);
  if (friend.name != null) fields.push(friend.name);
  if (friend.remark != null) fields.push(friend.remark);
  if (friend.gid != null) fields.push(String(friend.gid));
  return fields;
}

function isMaskedStealFriend(friend) {
  if (!friend || typeof friend !== "object") return false;
  const fields = buildFriendSearchFields(friend).map(normalizeMatchText).filter(Boolean);
  if (!fields.some((field) => field.includes("蒙面偷菜"))) return false;
  const level = Number(friend.level);
  if (!Number.isFinite(level)) return true;
  return level <= 1;
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

function enrichFriendItem(friend, config) {
  const workCounts = friend && friend.workCounts && typeof friend.workCounts === "object"
    ? friend.workCounts
    : {};
  const explicitBlacklisted = isFriendExplicitlyBlacklisted(friend, config && config.autoFarmFriendBlacklist);
  const maskedBlocked = !!(config && config.autoFarmFriendBlockMaskedStealers !== false && isMaskedStealFriend(friend));
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
      maskedBlocked,
      blocked: explicitBlacklisted || maskedBlocked,
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

function buildPlantImageUrl(seedId) {
  const normalized = Number(seedId) || 0;
  return normalized > 0 ? `/api/plant-image?seedId=${normalized}` : null;
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
    imageUrl: buildPlantImageUrl(seedId),
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
      autoFarmFriendBlacklist: Array.isArray(config.autoFarmFriendBlacklist) ? [...config.autoFarmFriendBlacklist] : [],
      autoFarmFriendBlockMaskedStealers: config.autoFarmFriendBlockMaskedStealers !== false,
      autoFarmFriendStealPlantBlacklistEnabled: config.autoFarmFriendStealPlantBlacklistEnabled === true,
      autoFarmFriendStealPlantBlacklistStrategy: Number(config.autoFarmFriendStealPlantBlacklistStrategy) === 2 ? 2 : 1,
      autoFarmFriendStealPlantBlacklist: Array.isArray(config.autoFarmFriendStealPlantBlacklist)
        ? [...config.autoFarmFriendStealPlantBlacklist]
        : [],
    },
  };
}

async function fetchPlayerProfileForUi({ ensureAutomationSession, ensureAutomationGameCtl, callAutomationGameCtl, config, getQqWsSnapshot, profileCache }) {
  const session = await ensureAutomationSession();
  await ensureAutomationGameCtl(session);
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
  const currentProfile = resolved.profile && typeof resolved.profile === "object"
    ? decoratePlayerProfile({ ...resolved.profile, _source: resolved.source })
    : null;

  if (!profileCache || typeof profileCache !== "object") {
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
      return currentProfile;
    }

    if (profileCache.lockedGid != null && currentGid != null && currentGid !== profileCache.lockedGid) {
      const sticky = buildProfileAssetOverlay(profileCache.profile, currentProfile);
      return { ...sticky, _source: "locked_gid_profile+runtime_assets" };
    }

    if (
      currentProfile._source === "system_candidates" ||
      currentProfile._source === "system_candidates+runtime_assets"
    ) {
      const sticky = buildProfileAssetOverlay(profileCache.profile, currentProfile);
      return { ...sticky, _source: "sticky_profile+runtime_assets" };
    }

    profileCache.profile = { ...currentProfile };
    return currentProfile;
  }

  if (currentProfile && hasStableProfileIdentity(currentProfile) && profileCache.profile) {
    const sticky = buildProfileAssetOverlay(profileCache.profile, currentProfile);
    return { ...sticky, _source: "sticky_profile+runtime_assets" };
  }

  if (profileCache.profile) {
    const sticky = buildProfileAssetOverlay(profileCache.profile, currentProfile);
    return { ...sticky, _source: "sticky_profile+runtime_assets" };
  }

  if (currentProfile && hasStableProfileIdentity(currentProfile)) {
    return currentProfile;
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

async function fertilizeLandForUi({ ensureAutomationSession, ensureAutomationGameCtl, callAutomationGameCtl, body }) {
  const session = await ensureAutomationSession();
  await ensureAutomationGameCtl(session);
  const input = body && typeof body === "object" ? body : {};
  const args = [{
    silent: true,
    dryRun: input.dryRun !== false,
    type: input.type || input.mode || "auto",
    waitAfterOpen: input.waitAfterOpen,
    waitAfterAction: input.waitAfterAction,
  }];
  if (input.landId != null) args[0].landId = Number(input.landId);
  if (input.path) args[0].path = String(input.path);
  const payload = await callAutomationGameCtl(session, "gameCtl.fertilizeLand", args);
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
  const waitMs = Math.max(0, Number(enterWaitMs) || 0);
  const opWaitMs = Math.max(0, Number(actionWaitMs) || 0);
  const enter = await callAutomationGameCtl(session, "gameCtl.enterFriendFarm", [target, {
    waitMs,
    includeAfterOwnership: true,
    silent: true,
  }]);
  const before = await callAutomationGameCtl(session, "gameCtl.getFarmStatus", [{
    includeGrids: false,
    includeLandIds: false,
    silent: true,
  }]);
  if (!before || before.farmType !== "friend") {
    throw new Error("not in friend farm");
  }

  const operations = [];
  const workCounts = before && before.workCounts && typeof before.workCounts === "object" ? before.workCounts : {};
  if (action === "steal") {
    if ((Number(workCounts.collect) || 0) > 0) {
      operations.push({ key: "collect", op: "HARVEST" });
    }
  } else if (action === "help") {
    if ((Number(workCounts.eraseGrass) || 0) > 0) operations.push({ key: "eraseGrass", op: "ERASE_GRASS" });
    if ((Number(workCounts.killBug) || 0) > 0) operations.push({ key: "killBug", op: "KILL_BUG" });
    if ((Number(workCounts.water) || 0) > 0) operations.push({ key: "water", op: "WATER" });
  } else {
    throw new Error(`unsupported friend action: ${action}`);
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

  const after = await callAutomationGameCtl(session, "gameCtl.getFarmStatus", [{
    includeGrids: false,
    includeLandIds: false,
    silent: true,
  }]);

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

  async function callAutomationGameCtl(session, pathName, args) {
    if (isQqRuntimeSession(session)) {
      return await qqWsSession.call(pathName, args);
    }
    return await callGameCtl(session, pathName, args);
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

  function getQqBundleSnapshot() {
    try {
      return buildQqBundle({ config, projectRoot }).meta;
    } catch (_) {
      return getQqBundleState(config);
    }
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

  const playerProfileCache = {
    clientKey: null,
    lockedGid: null,
    profile: null,
  };

  const autoFarmManager = new AutoFarmManager({
    ensureSession: ensureAutomationSession,
    getSession: () => (resolveAutomationRuntimeTarget() === "qq_ws" ? qqWsSession : cdp),
    ensureGameCtl: ensureAutomationGameCtl,
    callGameCtl: callAutomationGameCtl,
    getTransportState: getAutomationTransportState,
    projectRoot,
  });
  let autoFarmBootConfigLoaded = false;
  let autoFarmAutoStartDone = false;

  function shouldAutoStartAutoFarm(configData) {
    return !!(configData && (configData.autoFarmOwnEnabled || configData.autoFarmFriendEnabled));
  }

  function maybeAutoStartAutoFarm(reason) {
    if (autoFarmAutoStartDone) return;
    const state = autoFarmManager.getState();
    const configData = state && state.config ? state.config : null;
    if (!autoFarmBootConfigLoaded || !shouldAutoStartAutoFarm(configData)) return;
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
      autoFarmBootConfigLoaded = true;
      maybeAutoStartAutoFarm("config_loaded");
    })
    .catch(() => {
      autoFarmBootConfigLoaded = true;
      maybeAutoStartAutoFarm("config_load_failed");
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
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: true, data: target }));
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
        const patch = patchQqGameFile(target.targetPath, built.bundleText, {
          noBackup: !!parsed.noBackup,
        });
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({
          ok: true,
          data: {
            meta: built.meta,
            target,
            patch,
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
        res.end(JSON.stringify({ ok: true, data: autoFarmManager.getState() }));
      } catch (e) {
        const err = e instanceof Error ? e : new Error(String(e));
        res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
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

    if (req.method === "GET" && urlPath === "/api/plant-strategy-preview") {
      try {
        const mode = normalizePreviewMode(parsedUrl.searchParams.get("mode"));
        const specifiedSeedId = Number(parsedUrl.searchParams.get("seedId") || "0");
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
          response.preview = {
            mode,
            label: "背包优先，具体作物取决于背包库存",
            reason: "backpack_first",
          };
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

    if (req.method === "GET" && urlPath === "/api/plant-image") {
      try {
        const seedId = Number(parsedUrl.searchParams.get("seedId") || "0");
        const imagePath = getSeedImagePathBySeedId(seedId);
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

        if (action === "blacklist_add" || action === "blacklist_remove" || action === "blacklist_toggle") {
          const ruleSource = parsed.rule != null ? parsed.rule : target;
          const rule = String(ruleSource == null ? "" : ruleSource).trim();
          if (!rule) throw new Error("blacklist rule required");
          const nextList = Array.isArray(currentConfig.autoFarmFriendBlacklist)
            ? [...currentConfig.autoFarmFriendBlacklist]
            : [];
          const exists = nextList.includes(rule);
          let changed = false;
          if (action === "blacklist_add" || (action === "blacklist_toggle" && !exists)) {
            if (!exists) {
              nextList.push(rule);
              changed = true;
            }
          } else if (action === "blacklist_remove" || (action === "blacklist_toggle" && exists)) {
            const filtered = nextList.filter((item) => item !== rule);
            if (filtered.length !== nextList.length) {
              nextList.splice(0, nextList.length, ...filtered);
              changed = true;
            }
          }
          const savedConfig = changed
            ? await saveFarmConfig({ autoFarmFriendBlacklist: nextList })
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
        }

        let data;
        if (action === "start") {
          data = autoFarmManager.start(savedConfig || parsed.config);
        } else if (action === "stop") {
          data = autoFarmManager.stop("api");
        } else if (action === "runOnce") {
          data = await autoFarmManager.runOnce(savedConfig || parsed.config);
        } else if (action === "update") {
          if (!savedConfig && parsed.config && typeof parsed.config === "object") {
            autoFarmManager.updateConfig(parsed.config);
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

  const wss = new WebSocket.Server({ noServer: true });

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
      void previewManager.close();
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
