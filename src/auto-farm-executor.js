"use strict";

const { filterAnalyticsByLevel, getPlantAnalyticsList, pickBestPlantByMode, sortAnalyticsList } = require("./plant-analytics");
const { getProfilePlantLevel, resolveProfileWithCandidates } = require("./player-profile-resolver");
const {
  isFriendHelpLimitReached,
  normalizeFriendHelpState,
  recordFriendHelpRound,
  resolveFriendHelpDailyLimit,
} = require("./friend-help-exp-cache");
const {
  isProfileCacheUsable,
  mergeProfileWithFallback,
  profilesMatchIdentity,
  readPlayerProfileCache,
  writePlayerProfileCache,
} = require("./player-profile-cache");
const { getPlantById, getPlantByFruitId, getPlantBySeedId } = require("./game-config");
const {
  buildBackpackSeedPlan,
  normalizePositiveIntList: normalizeBackpackPrioritySeedIds,
  pickBackpackSeed,
} = require("./backpack-seed-priority");

function wait(ms) {
  const delayMs = Math.max(0, Number(ms) || 0);
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

function createAutomationStoppedError(reason) {
  const err = new Error(reason || "automation_stopped");
  err.code = "AUTOMATION_STOPPED";
  return err;
}

function isAutomationStoppedError(error) {
  return !!(error && (error.code === "AUTOMATION_STOPPED" || error.message === "automation_stopped"));
}

function isAutomationStopRequested(opts) {
  return !!(opts && opts.runContext && opts.runContext.cancelled === true);
}

function throwIfAutomationStopped(opts) {
  if (!isAutomationStopRequested(opts)) return;
  const reason = opts && opts.runContext && opts.runContext.reason
    ? String(opts.runContext.reason)
    : "automation_stopped";
  throw createAutomationStoppedError(reason);
}

async function waitWithAutomationControl(ms, opts) {
  let remainingMs = Math.max(0, Number(ms) || 0);
  while (remainingMs > 0) {
    throwIfAutomationStopped(opts);
    const step = Math.min(remainingMs, 120);
    await wait(step);
    remainingMs -= step;
  }
  throwIfAutomationStopped(opts);
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

function normalizeBlacklistStrategy(value) {
  const strategy = Number.parseInt(String(value == null ? "" : value).trim(), 10);
  return strategy === 2 ? 2 : 1;
}

function normalizeFriendCooldownEntries(value) {
  const source = Array.isArray(value) ? value : [];
  const now = Date.now();
  const map = new Map();
  for (let i = 0; i < source.length; i += 1) {
    const item = source[i];
    if (!item || typeof item !== "object") continue;
    const gid = Number(item.gid);
    const untilMs = Number(item.untilMs);
    if (!Number.isFinite(gid) || gid <= 0) continue;
    if (!Number.isFinite(untilMs) || untilMs <= now) continue;
    map.set(gid, untilMs);
  }
  return map;
}

function parseClockMinutes(value) {
  const match = /^(\d{1,2}):(\d{1,2})$/.exec(String(value == null ? "" : value).trim());
  if (!match) return null;
  const hours = Number.parseInt(match[1], 10);
  const minutes = Number.parseInt(match[2], 10);
  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return null;
  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return null;
  return hours * 60 + minutes;
}

function isInQuietHours(opts, nowDate) {
  if (!opts || opts.friendQuietHoursEnabled !== true) return false;
  const startMinutes = parseClockMinutes(opts.friendQuietHoursStart);
  const endMinutes = parseClockMinutes(opts.friendQuietHoursEnd);
  if (startMinutes == null || endMinutes == null) return false;
  const now = nowDate instanceof Date ? nowDate : new Date();
  const currentMinutes = now.getHours() * 60 + now.getMinutes();
  if (startMinutes === endMinutes) return true;
  if (startMinutes < endMinutes) {
    return currentMinutes >= startMinutes && currentMinutes < endMinutes;
  }
  return currentMinutes >= startMinutes || currentMinutes < endMinutes;
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
  if (fields.length === 0) return false;
  const looksMasked = fields.some((field) => field.indexOf("蒙面偷菜") >= 0);
  if (!looksMasked) return false;
  const level = Number(friend.level);
  if (!Number.isFinite(level)) return true;
  return level <= 1;
}

function isFriendBlacklisted(friend, blacklist) {
  const rules = Array.isArray(blacklist) ? blacklist : [];
  if (rules.length === 0) return false;
  const fields = buildFriendSearchFields(friend).map(normalizeMatchText).filter(Boolean);
  const gidText = friend && friend.gid != null ? String(friend.gid) : "";
  for (let i = 0; i < rules.length; i += 1) {
    const rule = normalizeMatchText(rules[i]);
    if (!rule) continue;
    if (/^\d+$/.test(rule) && gidText === rule) return true;
    for (let j = 0; j < fields.length; j += 1) {
      if (fields[j] === rule || fields[j].indexOf(rule) >= 0) return true;
    }
  }
  return false;
}

function summarizeFarmStatus(status) {
  if (!status || typeof status !== "object") return null;
  return {
    farmType: status.farmType ?? null,
    totalGrids: status.totalGrids ?? null,
    stageCounts: status.stageCounts ?? null,
    workCounts: status.workCounts ?? null,
  };
}

function isPlantableEmptyGrid(grid) {
  return !!(
    grid
    && grid.stageKind === "empty"
    && grid.interactable === true
  );
}

function collectEmptyLandIds(status) {
  const grids = Array.isArray(status && status.grids) ? status.grids : [];
  const emptyLandIds = [];
  for (let i = 0; i < grids.length; i += 1) {
    const grid = grids[i];
    const landId = Number(grid && grid.landId);
    if (!Number.isFinite(landId) || landId <= 0) continue;
    if (isPlantableEmptyGrid(grid)) {
      emptyLandIds.push(landId);
    }
  }
  return emptyLandIds;
}

function collectAllowedStealTargets(status, stealPlantBlacklist) {
  const blacklistIds = normalizePositiveIntList(stealPlantBlacklist);
  const blacklistSet = new Set(blacklistIds);
  const blacklistSeedIdSet = new Set();
  const blacklistFruitIdSet = new Set();
  const blacklistNameSet = new Set();
  blacklistIds.forEach((plantId) => {
    const plant = getPlantById(plantId);
    const name = plant && plant.name ? String(plant.name).trim() : "";
    const seedId = Number(plant && plant.seed_id) || 0;
    const fruitId = Number(plant && plant.fruit && plant.fruit.id) || 0;
    if (name) blacklistNameSet.add(name);
    if (seedId > 0) blacklistSeedIdSet.add(seedId);
    if (fruitId > 0) blacklistFruitIdSet.add(fruitId);
  });
  const grids = Array.isArray(status && status.grids) ? status.grids : [];
  const allowedLandIds = [];
  const skipped = [];
  const fallbackAllowedLandIds = [];
  const inspected = [];
  const seenAllowed = new Set();
  const blacklistedActionableLandIds = [];

  for (let i = 0; i < grids.length; i += 1) {
    const grid = grids[i];
    if (!grid) continue;
    const landId = Number(grid.landId);
    if (!Number.isFinite(landId) || landId <= 0) continue;

    const plantId = Number(grid.plantId) || 0;
    const plantName = grid.plantName ? String(grid.plantName).trim() : null;
    const mappedBySeed = plantId > 0 ? getPlantBySeedId(plantId) : null;
    const mappedByFruit = plantId > 0 ? getPlantByFruitId(plantId) : null;
    const mappedById = plantId > 0 ? getPlantById(plantId) : null;
    const resolvedPlant = mappedById || mappedBySeed || mappedByFruit || null;
    const resolvedPlantId = Number(resolvedPlant && resolvedPlant.id) || 0;
    const resolvedPlantName = resolvedPlant && resolvedPlant.name ? String(resolvedPlant.name).trim() : "";
    const matchedByPlantId = plantId > 0 && blacklistSet.has(plantId);
    const matchedByResolvedPlantId = resolvedPlantId > 0 && blacklistSet.has(resolvedPlantId);
    const matchedBySeedId = plantId > 0 && blacklistSeedIdSet.has(plantId);
    const matchedByFruitId = plantId > 0 && blacklistFruitIdSet.has(plantId);
    const matchedByName = !!(
      (plantName && blacklistNameSet.has(plantName))
      || (resolvedPlantName && blacklistNameSet.has(resolvedPlantName))
    );
    // In friend farms we only want plots the runtime marks as stealable/collectable.
    // Mature-but-not-stealable plots must not become targeted harvest candidates.
    const canSteal = grid.canSteal === true || grid.canCollect === true;
    const looksMature = grid.isMature === true
      || grid.stageKind === "mature"
      || Number(grid.matureInSec) === 0;
    const hasFruit = (Number(grid.leftFruit) || 0) > 0 || (Number(grid.fruitNum) || 0) > 0;
    const looksHarvestableFallback = !!(grid.hasPlant && !grid.isDead && (looksMature || hasFruit));
    const actionable = canSteal;
    const blacklisted = matchedByPlantId || matchedByResolvedPlantId || matchedBySeedId || matchedByFruitId || matchedByName;
    inspected.push({
      landId,
      plantId: plantId || null,
      plantName,
      resolvedPlantId: resolvedPlantId || null,
      resolvedPlantName: resolvedPlantName || null,
      canSteal,
      canCollect: !!grid.canCollect,
      canHarvest: !!grid.canHarvest,
      isMature: grid.isMature === true,
      stageKind: grid.stageKind || null,
      matureInSec: Number.isFinite(Number(grid.matureInSec)) ? Number(grid.matureInSec) : null,
      leftFruit: Number.isFinite(Number(grid.leftFruit)) ? Number(grid.leftFruit) : null,
      fruitNum: Number.isFinite(Number(grid.fruitNum)) ? Number(grid.fruitNum) : null,
      matchedByPlantId,
      matchedByResolvedPlantId,
      matchedBySeedId,
      matchedByFruitId,
      matchedByName,
      blacklisted,
      actionable,
      fallbackHarvestable: looksHarvestableFallback,
    });
    if (blacklisted) {
      skipped.push({
        landId,
        plantId,
        plantName,
        resolvedPlantId: resolvedPlantId || null,
        resolvedPlantName: resolvedPlantName || null,
        actionable,
      });
      if (actionable) {
        blacklistedActionableLandIds.push(landId);
      }
      continue;
    }

    if (canSteal) {
      if (!seenAllowed.has(landId)) {
        seenAllowed.add(landId);
        allowedLandIds.push(landId);
      }
      continue;
    }

    if (looksHarvestableFallback && !seenAllowed.has(landId)) {
      seenAllowed.add(landId);
      fallbackAllowedLandIds.push(landId);
    }
  }

  return {
    allowedLandIds,
    fallbackAllowedLandIds,
    skipped,
    inspected,
    blacklistedActionableLandIds,
  };
}

function getWorkCount(status, key) {
  if (!status || !status.workCounts || typeof status.workCounts !== "object") return 0;
  return Number(status.workCounts[key]) || 0;
}

function getWorkLandIds(status, key) {
  const landIds = status && status.landIds && typeof status.landIds === "object"
    ? status.landIds
    : null;
  const source = landIds && Array.isArray(landIds[key]) ? landIds[key] : [];
  return source
    .map((item) => Number(item))
    .filter((item) => Number.isFinite(item) && item > 0);
}

function getHelpWorkCounts(status) {
  return {
    water: getWorkCount(status, "water"),
    eraseGrass: getWorkCount(status, "eraseGrass"),
    killBug: getWorkCount(status, "killBug"),
  };
}

function getHelpWorkTotal(counts) {
  const src = counts && typeof counts === "object" ? counts : {};
  return (
    (Number(src.water) || 0)
    + (Number(src.eraseGrass) || 0)
    + (Number(src.killBug) || 0)
  );
}

function buildFriendHelpOperations(counts) {
  const work = counts && typeof counts === "object" ? counts : {};
  const operations = [];
  if ((Number(work.eraseGrass) || 0) > 0) operations.push({ key: "eraseGrass", op: "ERASE_GRASS" });
  if ((Number(work.killBug) || 0) > 0) operations.push({ key: "killBug", op: "KILL_BUG" });
  if ((Number(work.water) || 0) > 0) operations.push({ key: "water", op: "WATER" });
  return operations;
}

function toErrorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function withSilent(opts, extra) {
  const base = opts && typeof opts === "object" ? { ...opts } : {};
  return { ...base, ...(extra && typeof extra === "object" ? extra : {}), silent: true };
}

async function autoReconnectIfNeeded(session, callGameCtl, opts) {
  try {
    return await callGameCtl(session, "gameCtl.autoReconnectIfNeeded", [withSilent(opts)]);
  } catch (error) {
    return {
      ok: false,
      handled: false,
      error: toErrorMessage(error),
    };
  }
}

async function callGameCtlWithRecovery(session, callGameCtl, pathName, args, opts, rpcOptions) {
  const callOpts = opts && typeof opts === "object" ? opts : {};
  const transportCallOpts = rpcOptions && typeof rpcOptions === "object" ? rpcOptions : undefined;
  const reconnectOpts = {
    waitAfter: callOpts.reconnectWaitAfter,
    waitForRecovered: callOpts.reconnectWaitForRecovered,
    recoverTimeoutMs: callOpts.reconnectRecoverTimeoutMs,
    recoverPollMs: callOpts.reconnectRecoverPollMs,
  };

  await autoReconnectIfNeeded(session, callGameCtl, reconnectOpts);

  try {
    return await callGameCtl(session, pathName, args, transportCallOpts);
  } catch (error) {
    const recover = await autoReconnectIfNeeded(session, callGameCtl, reconnectOpts);
    if (recover && recover.handled && callOpts.retryOnReconnect !== false) {
      return await callGameCtl(session, pathName, args, transportCallOpts);
    }
    throw error;
  }
}

async function getFarmOwnership(session, callGameCtl, opts) {
  return await callGameCtlWithRecovery(session, callGameCtl, "gameCtl.getFarmOwnership", [withSilent(opts)], opts);
}

async function getFarmStatus(session, callGameCtl, opts) {
  return await callGameCtlWithRecovery(session, callGameCtl, "gameCtl.getFarmStatus", [withSilent(opts)], opts);
}

async function getFriendList(session, callGameCtl, opts) {
  return await callGameCtlWithRecovery(session, callGameCtl, "gameCtl.getFriendList", [withSilent(opts, { waitRefresh: true })], opts);
}

async function describeAutomationRuntime(session, callGameCtl, opts) {
  try {
    return await callGameCtlWithRecovery(session, callGameCtl, "host.describe", [], opts);
  } catch (_) {
    return null;
  }
}

async function enterOwnFarm(session, callGameCtl, opts) {
  return await callGameCtlWithRecovery(session, callGameCtl, "gameCtl.enterOwnFarm", [withSilent(opts)], opts);
}

async function enterFriendFarm(session, callGameCtl, target, opts) {
  return await callGameCtlWithRecovery(session, callGameCtl, "gameCtl.enterFriendFarm", [target, withSilent(opts)], opts);
}

async function triggerOneClickOperation(session, callGameCtl, typeOrIndex, opts) {
  return await callGameCtlWithRecovery(session, callGameCtl, "gameCtl.triggerOneClickOperation", [typeOrIndex, withSilent(opts)], opts);
}

async function fertilizeLand(session, callGameCtl, opts) {
  return await callGameCtlWithRecovery(session, callGameCtl, "gameCtl.fertilizeLand", [withSilent(opts)], opts);
}

async function fertilizeLandsBatch(session, callGameCtl, opts) {
  const batchTimeoutMs = Math.max(30_000, Number(opts && opts.batchCallTimeoutMs) || 120_000);
  return await callGameCtlWithRecovery(
    session,
    callGameCtl,
    "gameCtl.fertilizeLandsBatch",
    [withSilent(opts)],
    opts,
    { timeoutMs: batchTimeoutMs },
  );
}

async function inspectFertilizerRuntime(session, callGameCtl, opts) {
  const input = opts && typeof opts === "object" ? opts : {};
  return await callGameCtlWithRecovery(
    session,
    callGameCtl,
    "gameCtl.inspectFertilizerRuntime",
    [withSilent({ waitAfter: 350, ...input })],
    opts,
  );
}

async function clickMatureEffect(session, callGameCtl, landId, opts) {
  return await callGameCtlWithRecovery(session, callGameCtl, "gameCtl.clickMatureEffect", [
    landId,
    withSilent(opts),
  ], opts);
}

function normalizeFertilizerLandType(value) {
  const text = String(value == null ? "" : value).trim().toLowerCase();
  if (["gold", "black", "red", "normal"].includes(text)) return text;
  return "normal";
}

function normalizeAutoFertilizerMode(value) {
  const mode = String(value == null ? "" : value).trim().toLowerCase();
  if (mode === "inorganic") return "normal";
  if (["none", "normal", "organic", "both"].includes(mode)) return mode;
  return "none";
}

function runtimeSupportsGameCtlPath(runtime, pathName) {
  const target = String(pathName || "").trim();
  if (!target) return false;
  const availableMethods = Array.isArray(runtime && runtime.availableMethods) ? runtime.availableMethods : [];
  return availableMethods.includes(target);
}

function shouldRunAutoFertilizer(opts) {
  return !!(opts && opts.autoFertilizerEnabled === true && normalizeAutoFertilizerMode(opts.autoFertilizerMode) !== "none");
}

function getAutoFertilizerRushThresholdSec(opts) {
  const threshold = Number(opts && opts.autoFertilizerRushThresholdSec);
  if (!Number.isFinite(threshold) || threshold < 0) return 300;
  return Math.floor(threshold);
}

function shouldRunAutoFertilizerHarvestLink(opts) {
  return !!(shouldRunAutoFertilizer(opts) && opts && opts.autoFertilizerHarvestLinkEnabled === true);
}

function getAutoFertilizerStateStore(opts) {
  const target = opts && typeof opts === "object" ? opts : {};
  if (!target.autoFertilizerState || typeof target.autoFertilizerState !== "object") {
    target.autoFertilizerState = { landMarks: Object.create(null) };
  }
  if (!target.autoFertilizerState.landMarks || typeof target.autoFertilizerState.landMarks !== "object") {
    target.autoFertilizerState.landMarks = Object.create(null);
  }
  return target.autoFertilizerState;
}

function getGridTotalSeason(grid) {
  return Math.max(1, Number(grid && grid.totalSeason) || 1);
}

function getGridCurrentSeason(grid) {
  const plantId = Number(grid && grid.plantId) || 0;
  if (plantId <= 0) return 0;
  return Math.max(1, Math.min(getGridTotalSeason(grid), Number(grid && grid.currentSeason) || 1));
}

function buildAutoFertilizerSeasonKey(grid) {
  const landId = Number(grid && grid.landId);
  const plantId = Number(grid && grid.plantId) || 0;
  const currentSeason = getGridCurrentSeason(grid);
  if (!Number.isFinite(landId) || landId <= 0 || plantId <= 0 || currentSeason <= 0) return null;
  return `${landId}:${plantId}:${currentSeason}`;
}

function toFiniteNumberOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function buildAutoFertilizerMark(grid, landId, seasonKey) {
  return {
    landId,
    seasonKey,
    plantId: Number(grid && grid.plantId) || 0,
    currentSeason: getGridCurrentSeason(grid),
    totalSeason: getGridTotalSeason(grid),
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
    updatedAt: new Date().toISOString(),
  };
}

function getAutoFertilizerEvidenceKey(type) {
  return String(type || "").trim().toLowerCase() === "organic" ? "organicEvidence" : "normalEvidence";
}

function getAutoFertilizerBlockedKey(type) {
  return String(type || "").trim().toLowerCase() === "organic" ? "organicBlocked" : "normalBlocked";
}

function getAutoFertilizerBlockedReasonKey(type) {
  return String(type || "").trim().toLowerCase() === "organic" ? "organicBlockedReason" : "normalBlockedReason";
}

function getAutoFertilizerNoEffectCountKey(type) {
  return String(type || "").trim().toLowerCase() === "organic" ? "organicNoEffectCount" : "normalNoEffectCount";
}

function hasAutoFertilizerEvidence(mark, type) {
  const key = getAutoFertilizerEvidenceKey(type);
  return !!(mark && mark[key] && typeof mark[key] === "object");
}

function buildAutoFertilizerEvidence(grid, resultLike, source) {
  const after = resultLike && resultLike.after && typeof resultLike.after === "object" ? resultLike.after : null;
  return {
    source: source ? String(source) : null,
    at: new Date().toISOString(),
    beforeMatureInSec: toFiniteNumberOrNull(grid && grid.matureInSec),
    afterMatureInSec: toFiniteNumberOrNull(after && after.matureInSec),
    deltaMatureInSec: toFiniteNumberOrNull(resultLike && resultLike.deltaMatureInSec),
  };
}

function setAutoFertilizerMarkApplied(mark, type, evidence) {
  if (!mark || typeof mark !== "object") return mark;
  const blockedKey = getAutoFertilizerBlockedKey(type);
  const blockedReasonKey = getAutoFertilizerBlockedReasonKey(type);
  const noEffectCountKey = getAutoFertilizerNoEffectCountKey(type);
  mark[blockedKey] = false;
  mark[blockedReasonKey] = null;
  mark[noEffectCountKey] = 0;
  if (String(type || "").trim().toLowerCase() === "organic") {
    mark.organicApplied = true;
    if (evidence) mark.organicEvidence = evidence;
  } else {
    mark.normalApplied = true;
    if (evidence) mark.normalEvidence = evidence;
  }
  mark.updatedAt = new Date().toISOString();
  return mark;
}

function resetAutoFertilizerNoEffectState(mark, type) {
  if (!mark || typeof mark !== "object") return mark;
  const blockedKey = getAutoFertilizerBlockedKey(type);
  const blockedReasonKey = getAutoFertilizerBlockedReasonKey(type);
  const noEffectCountKey = getAutoFertilizerNoEffectCountKey(type);
  mark[blockedKey] = false;
  mark[blockedReasonKey] = null;
  mark[noEffectCountKey] = 0;
  return mark;
}

function getAutoFertilizerNoEffectRepeatThreshold(opts) {
  const value = Number(opts && opts.autoFertilizerNoEffectRepeatThreshold);
  if (!Number.isFinite(value) || value <= 0) return 2;
  return Math.max(1, Math.floor(value));
}

function markAutoFertilizerNoObservedEffect(state, grid, type, opts) {
  const mark = getAutoFertilizerMarkForGrid(state, grid);
  if (!mark) return { mark: null, blocked: false, count: 0, threshold: getAutoFertilizerNoEffectRepeatThreshold(opts) };
  const noEffectCountKey = getAutoFertilizerNoEffectCountKey(type);
  const blockedKey = getAutoFertilizerBlockedKey(type);
  const blockedReasonKey = getAutoFertilizerBlockedReasonKey(type);
  const threshold = getAutoFertilizerNoEffectRepeatThreshold(opts);
  const nextCount = Math.max(0, Number(mark[noEffectCountKey]) || 0) + 1;
  mark[noEffectCountKey] = nextCount;
  mark.updatedAt = new Date().toISOString();
  if (nextCount >= threshold) {
    mark[blockedKey] = true;
    mark[blockedReasonKey] = "no_observed_effect_repeat";
  }
  return {
    mark,
    blocked: mark[blockedKey] === true,
    count: nextCount,
    threshold,
  };
}

function shouldAutoHealLegacyNormalAppliedMark(mark, grid) {
  if (!mark || mark.normalApplied !== true) return false;
  const normalEvidence = mark && mark.normalEvidence && typeof mark.normalEvidence === "object"
    ? mark.normalEvidence
    : null;
  if (normalEvidence) {
    const source = String(normalEvidence.source || "").trim().toLowerCase();
    if (source === "repeat_detected") return true;
    return false;
  }
  if (!grid || String(grid.stageKind || "").trim().toLowerCase() !== "growing") return false;
  return true;
}

function healLegacyAutoFertilizerMark(mark, grid) {
  if (!shouldAutoHealLegacyNormalAppliedMark(mark, grid)) return mark;
  mark.normalApplied = false;
  mark.normalEvidence = null;
  mark.updatedAt = new Date().toISOString();
  return mark;
}

function syncAutoFertilizerStateWithStatus(state, status) {
  const target = state && typeof state === "object" ? state : { landMarks: Object.create(null) };
  const marks = target.landMarks && typeof target.landMarks === "object"
    ? target.landMarks
    : (target.landMarks = Object.create(null));
  const grids = Array.isArray(status && status.grids) ? status.grids : [];
  const seenLandIds = new Set();

  for (let i = 0; i < grids.length; i += 1) {
    const grid = grids[i];
    const landId = Number(grid && grid.landId);
    if (!Number.isFinite(landId) || landId <= 0) continue;
    const landKey = String(landId);
    seenLandIds.add(landKey);
    const stageKind = String(grid && grid.stageKind || "").trim().toLowerCase();
    const seasonKey = buildAutoFertilizerSeasonKey(grid);
    if (!seasonKey || (stageKind !== "growing" && stageKind !== "mature")) {
      delete marks[landKey];
      continue;
    }
    const existing = marks[landKey];
    if (!existing || existing.seasonKey !== seasonKey) {
      marks[landKey] = buildAutoFertilizerMark(grid, landId, seasonKey);
      continue;
    }
    existing.plantId = Number(grid.plantId) || 0;
    existing.currentSeason = getGridCurrentSeason(grid);
    existing.totalSeason = getGridTotalSeason(grid);
    healLegacyAutoFertilizerMark(existing, grid);
    existing.updatedAt = new Date().toISOString();
  }

  Object.keys(marks).forEach((landKey) => {
    if (!seenLandIds.has(String(landKey))) {
      delete marks[landKey];
    }
  });

  return target;
}

function getAutoFertilizerMarkForGrid(state, grid) {
  const marks = state && state.landMarks && typeof state.landMarks === "object"
    ? state.landMarks
    : null;
  if (!marks) return null;
  const landId = Number(grid && grid.landId);
  const seasonKey = buildAutoFertilizerSeasonKey(grid);
  if (!Number.isFinite(landId) || landId <= 0 || !seasonKey) return null;
  const landKey = String(landId);
  const existing = marks[landKey];
  if (existing && existing.seasonKey === seasonKey) {
    healLegacyAutoFertilizerMark(existing, grid);
    return existing;
  }
  const created = buildAutoFertilizerMark(grid, landId, seasonKey);
  marks[landKey] = created;
  return created;
}

function markAutoFertilizerApplied(state, grid, type, opts) {
  const mark = getAutoFertilizerMarkForGrid(state, grid);
  if (!mark) return null;
  resetAutoFertilizerNoEffectState(mark, type);
  const evidence = buildAutoFertilizerEvidence(
    grid,
    opts && typeof opts === "object" ? opts.result : null,
    opts && opts.source ? opts.source : null,
  );
  return setAutoFertilizerMarkApplied(mark, type, evidence);
}

function canUseAutoFertilizerOnGrid(grid, opts) {
  if (!grid || typeof grid !== "object") return false;
  if (grid.stageKind !== "growing") return false;
  const landId = Number(grid.landId);
  if (!Number.isFinite(landId) || landId <= 0) return false;
  const plantId = Number(grid.plantId) || 0;
  if (plantId <= 0) return false;
  const matureInSec = Number(grid.matureInSec);
  if (!Number.isFinite(matureInSec) || matureInSec <= 5) return false;
  const allowedLandTypes = Array.isArray(opts && opts.autoFertilizerLandTypes)
    ? opts.autoFertilizerLandTypes.map(normalizeFertilizerLandType)
    : ["gold", "black", "red", "normal"];
  const landType = normalizeFertilizerLandType(grid.landType);
  if (allowedLandTypes.length > 0 && !allowedLandTypes.includes(landType)) return false;
  const totalSeason = getGridTotalSeason(grid);
  const currentSeason = getGridCurrentSeason(grid);
  if (totalSeason > 1 && currentSeason > 1 && !(opts && opts.autoFertilizerMultiSeason === true)) return false;
  return true;
}

function isAutoFertilizerRushReady(grid, rushThresholdSec) {
  const matureInSec = Number(grid && grid.matureInSec);
  return Number.isFinite(matureInSec) && matureInSec > 5 && matureInSec <= rushThresholdSec;
}

function collectAutoFertilizerRushWatchEntries(status, opts) {
  const rushThresholdSec = getAutoFertilizerRushThresholdSec(opts);
  const grids = Array.isArray(status && status.grids) ? status.grids : [];
  const seen = new Set();
  const entries = [];

  for (let i = 0; i < grids.length; i += 1) {
    const grid = grids[i];
    const landId = Number(grid && grid.landId);
    if (!Number.isFinite(landId) || landId <= 0 || seen.has(landId)) continue;
    if (!canUseAutoFertilizerOnGrid(grid, opts)) continue;
    if (!isAutoFertilizerRushReady(grid, rushThresholdSec)) continue;
    seen.add(landId);
    entries.push({
      landId,
      matureInSec: Number.isFinite(Number(grid && grid.matureInSec))
        ? Math.max(0, Math.floor(Number(grid.matureInSec)))
        : null,
    });
  }

  entries.sort((a, b) => a.landId - b.landId);
  return entries;
}

function buildAutoFertilizerHarvestLinkWatch(status, opts) {
  const rushReadyEntries = collectAutoFertilizerRushWatchEntries(status, opts);
  const matureLandIds = collectMatureLandIds(status).sort((a, b) => a - b);
  const activeLandIdSet = new Set();
  rushReadyEntries.forEach((entry) => activeLandIdSet.add(entry.landId));
  matureLandIds.forEach((landId) => activeLandIdSet.add(landId));
  const activeLandIds = Array.from(activeLandIdSet).sort((a, b) => a - b);

  return {
    rushReadyEntries,
    rushReadyLandIds: rushReadyEntries.map((entry) => entry.landId),
    rushReadyCount: rushReadyEntries.length,
    matureLandIds,
    matureCount: matureLandIds.length,
    activeLandIds,
    activeCount: activeLandIds.length,
    signature: JSON.stringify({
      rushReady: rushReadyEntries.map((entry) => [entry.landId, entry.matureInSec]),
      mature: matureLandIds,
    }),
  };
}

function countCollectProgressFromTasks(tasks) {
  const src = tasks && typeof tasks === "object" ? tasks : {};
  const actions = Array.isArray(src.actions) ? src.actions : [];
  let total = 0;
  actions.forEach((action) => {
    if (!action || action.ok !== true || action.key !== "collect") return;
    total += normalizeDelta(action.beforeCount, action.afterCount);
  });
  const specialCollect = src.specialCollect && typeof src.specialCollect === "object"
    ? src.specialCollect
    : null;
  if (specialCollect && specialCollect.ok === true) {
    const successCount = Array.isArray(specialCollect.actions)
      ? specialCollect.actions.filter((item) => item && item.ok === true).length
      : Math.max(0, (Number(specialCollect.candidateCount) || 0) - (Number(specialCollect.remainingCount) || 0));
    total += successCount;
  }
  return total;
}

function isAutoFertilizerFollowUpSeason(grid) {
  return getGridTotalSeason(grid) > 1 && getGridCurrentSeason(grid) > 1;
}

function hasObservedFertilizerEffect(result) {
  if (result && result.ok === true) return true;
  const delta = Number(result && result.deltaMatureInSec);
  if (Number.isFinite(delta) && delta < -5) return true;
  const selectedBucketDeltaCount = Number(result && result.selectedBucketDeltaCount);
  return Number.isFinite(selectedBucketDeltaCount) && selectedBucketDeltaCount < 0;
}

function shouldRetryAutoFertilizerResult(result) {
  const reason = String(
    result && (
      result.reason
      || result.error
      || (result.ok === false ? "fertilize_failed" : "")
    ) || ""
  ).trim().toLowerCase();
  return reason === "action_panel_not_ready" || reason === "action_node_missing";
}

function shouldAbortAutoFertilizerPhase(reason) {
  const text = String(reason || "").trim().toLowerCase();
  return text.includes("no fertilizer available")
    || text.includes("normal fertilizer not available")
    || text.includes("organic fertilizer not available");
}

function getFertilizerTypeLabel(type) {
  return String(type || "").trim().toLowerCase() === "organic" ? "有机" : "无机";
}

function buildAutoFertilizerSkippedAction(grid, fertilizerType, reason, extra) {
  const textReason = String(reason || "").trim().toLowerCase();
  const displayReason = textReason === "same_fertilizer_type_already_used"
    ? "该化肥对同一作物仅能使用1次"
    : textReason === "no_observed_effect_repeat"
      ? "连续未观察到施肥效果，当前季后续自动跳过"
    : (extra && extra.displayReason ? String(extra.displayReason) : (reason || "unknown"));
  return {
    ok: null,
    skipped: true,
    phase: extra && extra.phase ? extra.phase : null,
    landId: Number(grid && grid.landId) || null,
    fertilizerType,
    fertilizerReason: extra && extra.fertilizerReason ? extra.fertilizerReason : null,
    stageKind: grid && grid.stageKind ? grid.stageKind : null,
    landType: normalizeFertilizerLandType(grid && grid.landType),
    currentSeason: getGridCurrentSeason(grid),
    totalSeason: getGridTotalSeason(grid),
    beforeMatureInSec: Number.isFinite(Number(grid && grid.matureInSec)) ? Number(grid.matureInSec) : null,
    reason: reason || "skipped",
    displayReason,
  };
}

function inferRepeatedFertilizerReason(reason, grid) {
  if (!grid || grid.stageKind !== "growing") return null;
  const text = String(reason || "").trim().toLowerCase();
  if (!text) return null;
  if (
    text === "same_fertilizer_type_already_used"
    || text.includes("same fertilizer type already used")
    || text.includes("same_fertilizer_type_already_used")
    || (text.includes("同一作物") && text.includes("1次"))
    || (text.includes("同一作物") && text.includes("一次"))
  ) {
    return "same_fertilizer_type_already_used";
  }
  return null;
}

function buildAutoFertilizerErrorAction(grid, fertilizerType, phase, errorMessage) {
  return {
    ok: false,
    phase,
    landId: Number(grid && grid.landId) || null,
    fertilizerType,
    fertilizerReason: grid && grid.fertilizerReason ? grid.fertilizerReason : null,
    stageKind: grid && grid.stageKind ? grid.stageKind : null,
    landType: normalizeFertilizerLandType(grid && grid.landType),
    currentSeason: getGridCurrentSeason(grid),
    totalSeason: getGridTotalSeason(grid),
    beforeMatureInSec: Number.isFinite(Number(grid && grid.matureInSec)) ? Number(grid.matureInSec) : null,
    afterMatureInSec: null,
    deltaMatureInSec: null,
    selectedBucketDeltaCount: null,
    error: errorMessage,
  };
}

function applyAutoFertilizerActionResult(state, grid, fertilizerType, phase, resultLike) {
  const success = hasObservedFertilizerEffect(resultLike);
  const repeatedReason = success ? null : inferRepeatedFertilizerReason(resultLike && (resultLike.reason || resultLike.error), grid);
  if (repeatedReason) {
    markAutoFertilizerApplied(state, grid, fertilizerType, {
      source: "explicit_repeat",
      result: resultLike,
    });
    return {
      action: buildAutoFertilizerSkippedAction(grid, fertilizerType, repeatedReason, {
        phase,
        fertilizerReason: grid && grid.fertilizerReason ? grid.fertilizerReason : null,
      }),
      abortedReason: null,
    };
  }
  if (!success && String(resultLike && resultLike.reason || resultLike && resultLike.error || "").trim().toLowerCase() === "fertilizer_no_observed_effect") {
    const noEffectState = markAutoFertilizerNoObservedEffect(state, grid, fertilizerType);
    if (noEffectState.blocked) {
      return {
        action: buildAutoFertilizerSkippedAction(grid, fertilizerType, "no_observed_effect_repeat", {
          phase,
          fertilizerReason: grid && grid.fertilizerReason ? grid.fertilizerReason : null,
          displayReason: `连续 ${noEffectState.threshold} 次未观察到施肥效果，当前季后续自动跳过`,
        }),
        abortedReason: null,
      };
    }
  }
  if (success) {
    markAutoFertilizerApplied(state, grid, fertilizerType, {
      source: "observed_effect",
      result: resultLike,
    });
  }
  const action = {
    ok: success,
    phase,
    landId: Number(grid && grid.landId) || null,
    fertilizerType,
    fertilizerReason: grid && grid.fertilizerReason ? grid.fertilizerReason : null,
    stageKind: grid && grid.stageKind ? grid.stageKind : null,
    landType: normalizeFertilizerLandType(grid && grid.landType),
    currentSeason: getGridCurrentSeason(grid),
    totalSeason: getGridTotalSeason(grid),
    beforeMatureInSec: Number.isFinite(Number(grid && grid.matureInSec)) ? Number(grid.matureInSec) : null,
    afterMatureInSec: resultLike && resultLike.after && Number.isFinite(Number(resultLike.after.matureInSec))
      ? Number(resultLike.after.matureInSec)
      : null,
    deltaMatureInSec: Number.isFinite(Number(resultLike && resultLike.deltaMatureInSec))
      ? Number(resultLike.deltaMatureInSec)
      : null,
    selectedBucketDeltaCount: Number.isFinite(Number(resultLike && resultLike.selectedBucketDeltaCount))
      ? Number(resultLike.selectedBucketDeltaCount)
      : null,
    reason: success ? null : (resultLike && (resultLike.reason || resultLike.error) ? (resultLike.reason || resultLike.error) : "fertilize_failed"),
    result: resultLike,
  };
  return {
    action,
    abortedReason: !success && shouldAbortAutoFertilizerPhase(action.reason) ? action.reason : null,
  };
}

function applyAutoFertilizerErrorResult(state, grid, fertilizerType, phase, errorLike) {
  const errorMessage = toErrorMessage(errorLike);
  const repeatedReason = inferRepeatedFertilizerReason(errorMessage, grid);
  if (repeatedReason) {
    markAutoFertilizerApplied(state, grid, fertilizerType, {
      source: "explicit_repeat",
    });
    return {
      action: buildAutoFertilizerSkippedAction(grid, fertilizerType, repeatedReason, {
        phase,
        fertilizerReason: grid && grid.fertilizerReason ? grid.fertilizerReason : null,
      }),
      abortedReason: null,
    };
  }
  if (String(errorMessage || "").trim().toLowerCase() === "fertilizer_no_observed_effect") {
    const noEffectState = markAutoFertilizerNoObservedEffect(state, grid, fertilizerType);
    if (noEffectState.blocked) {
      return {
        action: buildAutoFertilizerSkippedAction(grid, fertilizerType, "no_observed_effect_repeat", {
          phase,
          fertilizerReason: grid && grid.fertilizerReason ? grid.fertilizerReason : null,
          displayReason: `连续 ${noEffectState.threshold} 次未观察到施肥效果，当前季后续自动跳过`,
        }),
        abortedReason: null,
      };
    }
  }
  return {
    action: buildAutoFertilizerErrorAction(grid, fertilizerType, phase, errorMessage),
    abortedReason: shouldAbortAutoFertilizerPhase(errorMessage) ? errorMessage : null,
  };
}

function isBatchFertilizerMethodUnavailable(errorLike) {
  const text = String(errorLike || "").trim().toLowerCase();
  if (!text) return false;
  return text.includes("call_path_not_allowed")
    || text.includes("call_path_not_ready")
    || text.includes("call path not found")
    || text.includes("not a function")
    || text.includes("missing methods")
    || text.includes("qq ws runtime missing methods");
}

function collectAutoFertilizerPlan(status, opts, phaseName) {
  const mode = normalizeAutoFertilizerMode(opts && opts.autoFertilizerMode);
  const rushThresholdSec = getAutoFertilizerRushThresholdSec(opts);
  const state = getAutoFertilizerStateStore(opts);
  syncAutoFertilizerStateWithStatus(state, status);
  const grids = Array.isArray(status && status.grids) ? status.grids : [];
  const candidates = [];
  const skippedActions = [];

  for (let i = 0; i < grids.length; i += 1) {
    const grid = grids[i];
    if (!canUseAutoFertilizerOnGrid(grid, opts)) continue;
    const mark = getAutoFertilizerMarkForGrid(state, grid);
    if (!mark) continue;
    const rushReady = isAutoFertilizerRushReady(grid, rushThresholdSec);
    const followUpSeason = isAutoFertilizerFollowUpSeason(grid);
    let fertilizerType = null;
    let reason = null;

    if (phaseName === "season_start") {
      if (mode === "both" && !followUpSeason && mark.normalApplied === true) {
        skippedActions.push(buildAutoFertilizerSkippedAction(grid, "normal", "same_fertilizer_type_already_used", {
          phase: phaseName,
          fertilizerReason: "season_start_normal",
        }));
      } else if (mode === "both" && !followUpSeason && mark.normalBlocked === true) {
        skippedActions.push(buildAutoFertilizerSkippedAction(grid, "normal", "no_observed_effect_repeat", {
          phase: phaseName,
          fertilizerReason: "season_start_normal",
        }));
      } else if (mode === "both" && !followUpSeason && mark.normalApplied !== true) {
        fertilizerType = "normal";
        reason = "season_start_normal";
      }
    } else if (
      phaseName === "rush_normal"
      && mode === "normal"
      && rushReady
    ) {
      if (mark.normalApplied === true) {
        skippedActions.push(buildAutoFertilizerSkippedAction(grid, "normal", "same_fertilizer_type_already_used", {
          phase: phaseName,
          fertilizerReason: "rush_normal",
        }));
      } else if (mark.normalBlocked === true) {
        skippedActions.push(buildAutoFertilizerSkippedAction(grid, "normal", "no_observed_effect_repeat", {
          phase: phaseName,
          fertilizerReason: "rush_normal",
        }));
      } else {
        fertilizerType = "normal";
        reason = "rush_normal";
      }
    } else if (
      phaseName === "rush_organic"
      && mode === "organic"
      && rushReady
    ) {
      if (mark.organicApplied === true) {
        skippedActions.push(buildAutoFertilizerSkippedAction(grid, "organic", "same_fertilizer_type_already_used", {
          phase: phaseName,
          fertilizerReason: "rush_organic",
        }));
      } else if (mark.organicBlocked === true) {
        skippedActions.push(buildAutoFertilizerSkippedAction(grid, "organic", "no_observed_effect_repeat", {
          phase: phaseName,
          fertilizerReason: "rush_organic",
        }));
      } else {
        fertilizerType = "organic";
        reason = "rush_organic";
      }
    } else if (
      phaseName === "rush_organic"
      && mode === "both"
      && (mark.normalApplied === true || followUpSeason)
      && mark.organicApplied !== true
      && rushReady
    ) {
      if (mark.organicApplied === true) {
        skippedActions.push(buildAutoFertilizerSkippedAction(grid, "organic", "same_fertilizer_type_already_used", {
          phase: phaseName,
          fertilizerReason: "rush_organic",
        }));
      } else if (mark.organicBlocked === true) {
        skippedActions.push(buildAutoFertilizerSkippedAction(grid, "organic", "no_observed_effect_repeat", {
          phase: phaseName,
          fertilizerReason: "rush_organic",
        }));
      } else {
        fertilizerType = "organic";
        reason = "rush_organic";
      }
    }

    if (!fertilizerType) continue;
    candidates.push({
      ...grid,
      fertilizerType,
      fertilizerReason: reason,
      seasonKey: mark.seasonKey,
      alreadyApplied: {
        normal: mark.normalApplied === true,
        organic: mark.organicApplied === true,
      },
    });
  }

  return {
    candidates,
    skippedActions,
  };
}

async function runOwnFarmFertilizerPhase(session, callGameCtl, opts, phaseName) {
  const phase = String(phaseName || "").trim().toLowerCase() || "season_start";
  const actionWaitMs = Math.max(0, Number(opts && opts.actionWaitMs) || 0);
  const fertilizeWaitAfterOpen = Math.max(200, Number(opts && opts.fertilizeWaitAfterOpen) || 700);
  const fertilizeWaitAfterAction = Math.max(200, Number(opts && opts.fertilizeWaitAfterAction) || 800);
  const batchChunkSize = Math.max(2, Number(opts && opts.autoFertilizerBatchChunkSize) || 2);
  const state = getAutoFertilizerStateStore(opts);
  throwIfAutomationStopped(opts);
  const statusBefore = await getFarmStatus(session, callGameCtl, {
    includeGrids: true,
    includeLandIds: false,
  });
  const plan = collectAutoFertilizerPlan(statusBefore, opts, phase);
  const candidates = Array.isArray(plan && plan.candidates) ? plan.candidates : [];
  const actions = Array.isArray(plan && plan.skippedActions) ? [...plan.skippedActions] : [];
  let abortedReason = null;

  async function runFertilizeAttempt(landId, fertilizerType) {
    return await fertilizeLand(session, callGameCtl, {
      landId,
      type: fertilizerType,
      dryRun: false,
      internalFallback: true,
      waitAfterOpen: fertilizeWaitAfterOpen,
      waitAfterAction: fertilizeWaitAfterAction,
    });
  }

  async function runSequentialCandidates(groupCandidates) {
    for (let i = 0; i < groupCandidates.length; i += 1) {
      throwIfAutomationStopped(opts);
      const grid = groupCandidates[i];
      const landId = Number(grid.landId);
      const fertilizerType = String(grid.fertilizerType || "normal").trim().toLowerCase();
      try {
        let result = await runFertilizeAttempt(landId, fertilizerType);
        if ((!result || result.ok !== true) && shouldRetryAutoFertilizerResult(result)) {
          await waitWithAutomationControl(300, opts);
          result = await runFertilizeAttempt(landId, fertilizerType);
        }
        const handled = applyAutoFertilizerActionResult(state, grid, fertilizerType, phase, result);
        actions.push(handled.action);
        if (handled.abortedReason) {
          abortedReason = handled.abortedReason;
        }
        if ((opts && opts.stopOnError) && handled.action && handled.action.ok === false) {
          abortedReason = abortedReason || handled.action.reason || handled.action.error || "fertilize_failed";
        }
      } catch (error) {
        if (isAutomationStoppedError(error)) throw error;
        const handled = applyAutoFertilizerErrorResult(state, grid, fertilizerType, phase, error);
        actions.push(handled.action);
        if (handled.abortedReason) {
          abortedReason = handled.abortedReason;
        }
        if ((opts && opts.stopOnError) && handled.action && handled.action.ok === false) {
          abortedReason = abortedReason || handled.action.error || handled.action.reason || "fertilize_failed";
        }
      }

      if (abortedReason) break;
      if (actionWaitMs > 0 && i < groupCandidates.length - 1) {
        await waitWithAutomationControl(actionWaitMs, opts);
      }
    }
  }

  const candidateGroups = [];
  const candidateGroupMap = new Map();
  for (let i = 0; i < candidates.length; i += 1) {
    const grid = candidates[i];
    const fertilizerType = String(grid && grid.fertilizerType || "normal").trim().toLowerCase() || "normal";
    let group = candidateGroupMap.get(fertilizerType);
    if (!group) {
      group = [];
      candidateGroupMap.set(fertilizerType, group);
      candidateGroups.push(group);
    }
    group.push(grid);
  }

  const needsBatchAttempt = candidateGroups.some((group) => Array.isArray(group) && group.length > 1);
  const runtimeState = needsBatchAttempt
    ? await describeAutomationRuntime(session, callGameCtl, opts)
    : null;
  const batchSupported = needsBatchAttempt
    ? (runtimeState ? runtimeSupportsGameCtlPath(runtimeState, "gameCtl.fertilizeLandsBatch") : null)
    : null;
  const batchUnavailableReason = needsBatchAttempt && batchSupported === false
    ? "runtime_missing_gameCtl.fertilizeLandsBatch"
    : null;

  for (let groupIndex = 0; groupIndex < candidateGroups.length; groupIndex += 1) {
    throwIfAutomationStopped(opts);
    const groupCandidates = candidateGroups[groupIndex];
    if (!Array.isArray(groupCandidates) || groupCandidates.length === 0) continue;
    const fertilizerType = String(groupCandidates[0] && groupCandidates[0].fertilizerType || "normal").trim().toLowerCase() || "normal";
    const handledLandIds = new Set();
    let batchError = null;
    if (groupCandidates.length > 1 && batchSupported !== false) {
      for (let chunkStart = 0; chunkStart < groupCandidates.length; chunkStart += batchChunkSize) {
        if (abortedReason) break;
        const chunkCandidates = groupCandidates.slice(chunkStart, chunkStart + batchChunkSize);
        const chunkLandIds = chunkCandidates
          .map((item) => Number(item && item.landId) || 0)
          .filter((landId) => Number.isFinite(landId) && landId > 0);
        if (chunkLandIds.length <= 1) continue;
        batchError = null;
        let batchResult = null;

        try {
          batchResult = await fertilizeLandsBatch(session, callGameCtl, {
            landIds: chunkLandIds,
            type: fertilizerType,
            dryRun: false,
            internalFallback: true,
            waitAfterOpen: fertilizeWaitAfterOpen,
            waitAfterAction: fertilizeWaitAfterAction,
          });
        } catch (error) {
          batchError = toErrorMessage(error);
        }

        if (batchResult && Array.isArray(batchResult.results) && batchResult.results.length > 0) {
          const resultByLandId = new Map();
          batchResult.results.forEach((item) => {
            const landId = Number(item && item.landId) || 0;
            if (landId > 0 && !resultByLandId.has(landId)) {
              resultByLandId.set(landId, item);
            }
          });

          for (let i = 0; i < chunkCandidates.length; i += 1) {
            const grid = chunkCandidates[i];
            const landId = Number(grid && grid.landId) || 0;
            const entry = resultByLandId.get(landId);
            if (!entry) continue;
            handledLandIds.add(landId);
            const handled = entry && entry.error
              ? applyAutoFertilizerErrorResult(state, grid, fertilizerType, phase, entry.error)
              : applyAutoFertilizerActionResult(state, grid, fertilizerType, phase, {
                  ok: entry && entry.ok === true,
                  reason: entry && entry.reason ? entry.reason : null,
                  error: entry && entry.error ? entry.error : null,
                  after: entry && entry.after ? entry.after : null,
                  deltaMatureInSec: entry && entry.deltaMatureInSec != null ? entry.deltaMatureInSec : null,
                  selectedBucketDeltaCount: entry && entry.selectedBucketDeltaCount != null ? entry.selectedBucketDeltaCount : null,
                  executionSource: entry && entry.executionSource ? entry.executionSource : null,
                });
            actions.push(handled.action);
            if (handled.abortedReason) {
              abortedReason = handled.abortedReason;
            }
            if ((opts && opts.stopOnError) && handled.action && handled.action.ok === false) {
              abortedReason = abortedReason || handled.action.reason || handled.action.error || "fertilize_failed";
            }
            if (abortedReason) break;
          }
          if (!abortedReason && batchResult.aborted && batchResult.reason && shouldAbortAutoFertilizerPhase(batchResult.reason)) {
            abortedReason = batchResult.reason;
          }
        } else if (batchError && shouldAbortAutoFertilizerPhase(batchError)) {
          abortedReason = batchError;
        }

        if (!abortedReason) {
          const remainingChunkCandidates = chunkCandidates.filter((item) => !handledLandIds.has(Number(item && item.landId) || 0));
          if (remainingChunkCandidates.length > 0) {
            await runSequentialCandidates(remainingChunkCandidates);
          }
        }

        if (!abortedReason && actionWaitMs > 0 && chunkStart + batchChunkSize < groupCandidates.length) {
          await waitWithAutomationControl(actionWaitMs, opts);
        }
      }
    }

    if (!abortedReason) {
      const remainingCandidates = groupCandidates.filter((item) => !handledLandIds.has(Number(item && item.landId) || 0));
      if (remainingCandidates.length > 0) {
        await runSequentialCandidates(remainingCandidates);
      }
    }

    if (abortedReason) break;
    if (groupIndex < candidateGroups.length - 1 && actionWaitMs > 0) {
      await waitWithAutomationControl(actionWaitMs, opts);
    }

    if (batchError && isBatchFertilizerMethodUnavailable(batchError)) {
      // no-op: explicit branch keeps the fallback reason easy to inspect while preserving old behavior
    }
  }

  const statusAfter = await getFarmStatus(session, callGameCtl, {
    includeGrids: true,
    includeLandIds: false,
  });
  syncAutoFertilizerStateWithStatus(state, statusAfter);
  const successCount = actions.filter((item) => item && item.ok === true && item.skipped !== true).length;
  const failureCount = actions.filter((item) => item && item.ok === false).length;
  const skippedCount = actions.filter((item) => item && item.skipped === true).length;

  return {
    phase,
    ok: failureCount === 0,
    candidateCount: candidates.length,
    successCount,
    failureCount,
    skippedCount,
    batchSupported,
    batchUnavailableReason,
    runtimeScriptHash: runtimeState && runtimeState.scriptHash ? String(runtimeState.scriptHash) : null,
    before: summarizeFarmStatus(statusBefore),
    after: summarizeFarmStatus(statusAfter),
    aborted: !!abortedReason,
    abortedReason,
    actions,
  };
}

async function runOwnFarmFertilizerTasks(session, callGameCtl, opts) {
  const mode = normalizeAutoFertilizerMode(opts && opts.autoFertilizerMode);
  if (!opts || opts.autoFertilizerEnabled !== true) {
    return {
      ok: true,
      skipped: true,
      reason: "disabled",
      requestedMode: mode || "none",
      executedMode: "none",
      candidateCount: 0,
      actions: [],
    };
  }
  if (mode === "none") {
    return {
      ok: true,
      skipped: true,
      reason: "mode_none",
      requestedMode: mode,
      executedMode: "none",
      candidateCount: 0,
      actions: [],
    };
  }
  const rushThresholdSec = getAutoFertilizerRushThresholdSec(opts);
  const seasonStartPhases = mode === "both" ? ["season_start"] : [];
  const rushPhases = mode === "normal"
    ? ["rush_normal"]
    : mode === "both" || mode === "organic"
      ? ["rush_organic"]
      : [];
  const phaseResults = [];
  const actions = [];
  const actionWaitMs = Math.max(0, Number(opts && opts.actionWaitMs) || 0);
  let before = null;
  let after = null;
  let abortedReason = null;
  let linkedHarvest = null;

  getAutoFertilizerStateStore(opts);

  async function runPhaseSequence(phases) {
    const source = Array.isArray(phases) ? phases : [];
    const executed = [];
    for (let i = 0; i < source.length; i += 1) {
      throwIfAutomationStopped(opts);
      const phase = source[i];
      if (i > 0 && actionWaitMs > 0) {
        await waitWithAutomationControl(actionWaitMs, opts);
      }
      const phaseResult = await runOwnFarmFertilizerPhase(session, callGameCtl, opts, phase);
      executed.push(phaseResult);
      phaseResults.push(phaseResult);
      if (!before) before = phaseResult.before || null;
      after = phaseResult.after || after;
      if (Array.isArray(phaseResult.actions)) {
        actions.push(...phaseResult.actions);
      }
      if (phaseResult.aborted) {
        abortedReason = phaseResult.abortedReason || phase;
        break;
      }
      if (opts && opts.stopOnError && phaseResult.failureCount > 0) {
        break;
      }
    }
    return executed;
  }

  async function runAutoFertilizerHarvestLinkLoop(phases) {
    const phaseList = Array.isArray(phases) ? phases.filter(Boolean) : [];
    if (!shouldRunAutoFertilizerHarvestLink(opts) || phaseList.length === 0) {
      return {
        enabled: shouldRunAutoFertilizerHarvestLink(opts),
        ok: true,
        skipped: true,
        reason: "disabled",
        roundCount: 0,
        collectCount: 0,
        rounds: [],
      };
    }

    const rounds = [];
    const linkWaitMs = Math.max(500, actionWaitMs || 0);
    const maxRounds = Math.max(6, Math.ceil(((rushThresholdSec + 15) * 1000) / linkWaitMs));
    let lastWatchSignature = null;
    let stagnantRounds = 0;
    let collectCount = 0;
    let stopReason = "no_rush_targets";
    let ok = true;

    for (let roundIndex = 0; roundIndex < maxRounds; roundIndex += 1) {
      throwIfAutomationStopped(opts);
      const statusBefore = await getFarmStatus(session, callGameCtl, {
        includeGrids: true,
        includeLandIds: true,
      });
      const watchBefore = buildAutoFertilizerHarvestLinkWatch(statusBefore, opts);
      if (watchBefore.activeCount <= 0) {
        stopReason = rounds.length > 0 ? "watch_cleared" : "no_rush_targets";
        break;
      }

      const beforePhaseCount = phaseResults.length;
      await runPhaseSequence(phaseList);
      const roundPhaseResults = phaseResults.slice(beforePhaseCount);
      const roundPhaseSuccessCount = roundPhaseResults.reduce((sum, item) => sum + (Number(item && item.successCount) || 0), 0);
      const roundPhaseFailureCount = roundPhaseResults.reduce((sum, item) => sum + (Number(item && item.failureCount) || 0), 0);

      if (abortedReason) {
        ok = false;
        stopReason = abortedReason;
        break;
      }

      const harvestResult = await runCurrentFarmOneClickTasks(session, callGameCtl, {
        includeCollect: true,
        includeWater: false,
        includeEraseGrass: false,
        includeKillBug: false,
        includeSpecialCollect: true,
        actionWaitMs,
        stopOnError: !!(opts && opts.stopOnError),
        runContext: opts && opts.runContext,
      });
      const roundCollectCount = countCollectProgressFromTasks(harvestResult);
      collectCount += roundCollectCount;

      const statusAfter = await getFarmStatus(session, callGameCtl, {
        includeGrids: true,
        includeLandIds: true,
      });
      const watchAfter = buildAutoFertilizerHarvestLinkWatch(statusAfter, opts);
      const progressMade = roundPhaseSuccessCount > 0
        || roundCollectCount > 0
        || watchAfter.signature !== watchBefore.signature;

      rounds.push({
        index: roundIndex + 1,
        watchBefore,
        watchAfter,
        phaseSuccessCount: roundPhaseSuccessCount,
        phaseFailureCount: roundPhaseFailureCount,
        collectCount: roundCollectCount,
        progressMade,
        harvestResult,
      });

      after = summarizeFarmStatus(statusAfter) || after;

      if (opts && opts.stopOnError) {
        const harvestFailed = Array.isArray(harvestResult && harvestResult.actions)
          && harvestResult.actions.some((item) => item && item.ok === false);
        const specialCollectFailed = !!(harvestResult && harvestResult.specialCollect && harvestResult.specialCollect.ok === false);
        if (harvestFailed || specialCollectFailed || roundPhaseFailureCount > 0) {
          ok = false;
          stopReason = "stop_on_error";
          break;
        }
      }

      if (watchAfter.activeCount <= 0) {
        stopReason = "watch_cleared";
        break;
      }

      if (watchAfter.signature === lastWatchSignature && !progressMade) {
        stagnantRounds += 1;
      } else if (!progressMade) {
        stagnantRounds = 1;
      } else {
        stagnantRounds = 0;
      }
      lastWatchSignature = watchAfter.signature;

      if (stagnantRounds >= 3) {
        ok = false;
        stopReason = "no_progress";
        break;
      }

      await waitWithAutomationControl(linkWaitMs, opts);
    }

    if (rounds.length >= maxRounds && stopReason === "no_rush_targets") {
      ok = false;
      stopReason = "round_limit_reached";
    }

    return {
      enabled: true,
      ok,
      skipped: false,
      reason: stopReason,
      roundCount: rounds.length,
      collectCount,
      rounds,
    };
  }

  await runPhaseSequence(seasonStartPhases);
  if (!abortedReason) {
    if (shouldRunAutoFertilizerHarvestLink(opts) && rushPhases.length > 0) {
      linkedHarvest = await runAutoFertilizerHarvestLinkLoop(rushPhases);
      if (linkedHarvest && linkedHarvest.ok === false && !abortedReason) {
        abortedReason = linkedHarvest.reason || abortedReason;
      }
    } else {
      await runPhaseSequence(rushPhases);
    }
  }

  const candidateCount = phaseResults.reduce((sum, item) => sum + (Number(item && item.candidateCount) || 0), 0);
  const successCount = actions.filter((item) => item && item.ok === true && item.skipped !== true).length;
  const failureCount = actions.filter((item) => item && item.ok === false).length;
  const skippedCount = actions.filter((item) => item && item.skipped === true).length;
  const batchUnavailableReason = phaseResults.find((item) => item && item.batchUnavailableReason)?.batchUnavailableReason || null;
  const runtimeScriptHash = phaseResults.find((item) => item && item.runtimeScriptHash)?.runtimeScriptHash || null;

  return {
    ok: failureCount === 0 && !(linkedHarvest && linkedHarvest.ok === false),
    skipped: false,
    requestedMode: mode,
    executedMode: mode,
    rushThresholdSec,
    candidateCount,
    successCount,
    failureCount,
    skippedCount,
    before,
    after,
    aborted: !!abortedReason,
    reason: abortedReason,
    batchUnavailableReason,
    runtimeScriptHash,
    linkedHarvest,
    phases: phaseResults,
    actions,
  };
}

function collectMatureLandIds(status) {
  const grids = Array.isArray(status && status.grids) ? status.grids : [];
  const seen = new Set();
  const out = [];

  for (let i = 0; i < grids.length; i += 1) {
    const grid = grids[i];
    const landId = Number(grid && grid.landId);
    if (!Number.isFinite(landId) || landId <= 0 || seen.has(landId)) continue;
    if (!grid || grid.stageKind !== "mature") continue;
    if (!(grid.canCollect || grid.canHarvest || grid.canSteal)) continue;
    seen.add(landId);
    out.push(landId);
  }

  return out;
}

async function runSupplementalMatureEffectHarvest(session, callGameCtl, opts) {
  const rawOpts = opts && typeof opts === "object" ? opts : {};
  const actionWaitMs = Math.max(0, Number(rawOpts.actionWaitMs) || 0);
  throwIfAutomationStopped(rawOpts);
  const statusBefore = await getFarmStatus(session, callGameCtl, {
    includeGrids: true,
    includeLandIds: false,
  });
  const farmType = statusBefore && statusBefore.farmType ? statusBefore.farmType : "unknown";
  const candidateLandIds = collectMatureLandIds(statusBefore);

  if (candidateLandIds.length === 0) {
    return {
      ok: true,
      completed: true,
      farmType,
      action: "skip",
      candidateCount: 0,
      candidateLandIds: [],
      remainingCount: 0,
      remainingLandIds: [],
      before: summarizeFarmStatus(statusBefore),
      after: summarizeFarmStatus(statusBefore),
      actions: [],
    };
  }

  const actions = [];
  for (let i = 0; i < candidateLandIds.length; i += 1) {
    throwIfAutomationStopped(rawOpts);
    const landId = candidateLandIds[i];
    try {
      const result = await clickMatureEffect(session, callGameCtl, landId, {
        waitForResult: rawOpts.waitForResult !== false,
        timeoutMs: rawOpts.timeoutMs,
        pollMs: rawOpts.pollMs,
        fallbackDispatch: false,
      });
      actions.push({ ok: !!(result && result.ok), landId, result });
    } catch (error) {
      actions.push({ ok: false, landId, error: toErrorMessage(error) });
      if (rawOpts.stopOnError) break;
    }

    if (actionWaitMs > 0 && i < candidateLandIds.length - 1) {
      await waitWithAutomationControl(actionWaitMs, rawOpts);
    }
  }

  const statusAfter = await getFarmStatus(session, callGameCtl, {
    includeGrids: true,
    includeLandIds: false,
  });
  const remainingLandIds = collectMatureLandIds(statusAfter);

  return {
    ok: remainingLandIds.length === 0,
    completed: remainingLandIds.length === 0,
    farmType,
    action: "supplemental_mature_effect_harvest",
    candidateCount: candidateLandIds.length,
    candidateLandIds,
    remainingCount: remainingLandIds.length,
    remainingLandIds,
    before: summarizeFarmStatus(statusBefore),
    after: summarizeFarmStatus(statusAfter),
    actions,
  };
}

async function runCurrentFarmOneClickTasks(session, callGameCtl, opts) {
  const actionWaitMs = Math.max(0, Number(opts && opts.actionWaitMs) || 0);
  throwIfAutomationStopped(opts);
  const statusBefore = await getFarmStatus(session, callGameCtl, {
    includeGrids: false,
    includeLandIds: true,
  });
  const farmType = statusBefore && statusBefore.farmType ? statusBefore.farmType : "unknown";
  const includeCollect = !opts || opts.includeCollect !== false;
  const includeWater = !opts || opts.includeWater !== false;
  const includeEraseGrass = !opts || opts.includeEraseGrass !== false;
  const includeKillBug = !opts || opts.includeKillBug !== false;
  const specs = [];

  if (includeCollect) specs.push({ key: "collect", op: "HARVEST" });
  if (farmType === "own") {
    if (includeEraseGrass) specs.push({ key: "eraseGrass", op: "ERASE_GRASS" });
    if (includeKillBug) specs.push({ key: "killBug", op: "KILL_BUG" });
    if (includeWater) specs.push({ key: "water", op: "WATER" });
  }

  const actions = [];
  let currentStatus = statusBefore;
  let specialCollect = null;

  for (let i = 0; i < specs.length; i += 1) {
    throwIfAutomationStopped(opts);
    const spec = specs[i];
    const beforeCount = getWorkCount(currentStatus, spec.key);
    const beforeLandIds = getWorkLandIds(currentStatus, spec.key);
    if (beforeCount <= 0) {
      if (spec.key === "collect" && (!opts || opts.includeSpecialCollect !== false)) {
        try {
          specialCollect = await runSupplementalMatureEffectHarvest(session, callGameCtl, {
            actionWaitMs,
            timeoutMs: opts && opts.timeoutMs,
            pollMs: opts && opts.pollMs,
            stopOnError: !!(opts && opts.stopOnError),
            runContext: opts && opts.runContext,
          });
          if (specialCollect.candidateCount > 0) {
            currentStatus = await getFarmStatus(session, callGameCtl, {
              includeGrids: false,
              includeLandIds: true,
            });
          }
        } catch (error) {
          if (isAutomationStoppedError(error)) throw error;
          specialCollect = {
            ok: false,
            error: toErrorMessage(error),
          };
          if (opts && opts.stopOnError) break;
        }
      }
      continue;
    }

    try {
      const trigger = await triggerOneClickOperation(session, callGameCtl, spec.op, {
        includeBefore: false,
        includeAfter: false,
      });
      if (actionWaitMs > 0) {
        await waitWithAutomationControl(actionWaitMs, opts);
      }
      currentStatus = await getFarmStatus(session, callGameCtl, {
        includeGrids: false,
        includeLandIds: true,
      });
      const afterCount = getWorkCount(currentStatus, spec.key);
      const afterLandIds = getWorkLandIds(currentStatus, spec.key);
      actions.push({
        ok: true,
        key: spec.key,
        op: spec.op,
        beforeCount,
        afterCount,
        beforeLandIds,
        afterLandIds,
        trigger,
      });
      if (spec.key === "collect" && (!opts || opts.includeSpecialCollect !== false)) {
        try {
          specialCollect = await runSupplementalMatureEffectHarvest(session, callGameCtl, {
            actionWaitMs,
            timeoutMs: opts && opts.timeoutMs,
            pollMs: opts && opts.pollMs,
            stopOnError: !!(opts && opts.stopOnError),
            runContext: opts && opts.runContext,
          });
          if (specialCollect.candidateCount > 0) {
            currentStatus = await getFarmStatus(session, callGameCtl, {
              includeGrids: false,
              includeLandIds: true,
            });
          }
        } catch (error) {
          if (isAutomationStoppedError(error)) throw error;
          specialCollect = {
            ok: false,
            error: toErrorMessage(error),
          };
          if (opts && opts.stopOnError) break;
        }
      }
    } catch (error) {
      if (isAutomationStoppedError(error)) throw error;
      actions.push({
        ok: false,
        key: spec.key,
        op: spec.op,
        beforeCount,
        beforeLandIds,
        error: toErrorMessage(error),
      });
      if (spec.key === "collect" && (!opts || opts.includeSpecialCollect !== false) && (!opts || !opts.stopOnError)) {
        try {
          specialCollect = await runSupplementalMatureEffectHarvest(session, callGameCtl, {
            actionWaitMs,
            timeoutMs: opts && opts.timeoutMs,
            pollMs: opts && opts.pollMs,
            stopOnError: false,
            runContext: opts && opts.runContext,
          });
          if (specialCollect.candidateCount > 0) {
            currentStatus = await getFarmStatus(session, callGameCtl, {
              includeGrids: false,
              includeLandIds: true,
            });
          }
        } catch (supplementError) {
          if (isAutomationStoppedError(supplementError)) throw supplementError;
          specialCollect = {
            ok: false,
            error: toErrorMessage(supplementError),
          };
        }
      }
      if (opts && opts.stopOnError) break;
    }
  }

  return {
    farmType,
    before: summarizeFarmStatus(statusBefore),
    after: summarizeFarmStatus(currentStatus),
    actions,
    specialCollect,
  };
}

async function autoPlant(session, callGameCtl, mode, opts) {
  if (!mode || mode === "none") return null;
  return await callGameCtl(session, "gameCtl.autoPlant", [withSilent({
    mode: mode,
    plantId: opts && opts.plantId != null ? opts.plantId : undefined,
    seedId: opts && opts.seedId != null ? opts.seedId : undefined,
    seedName: opts && opts.seedName != null ? opts.seedName : undefined,
    emptyLandIds: Array.isArray(opts && opts.emptyLandIds) ? [...opts.emptyLandIds] : undefined,
    shopGoodsId: opts && opts.shopGoodsId != null ? opts.shopGoodsId : undefined,
    shopPrice: opts && opts.shopPrice != null ? opts.shopPrice : undefined,
    shopPriceId: opts && opts.shopPriceId != null ? opts.shopPriceId : undefined,
  })]);
}

async function getSeedList(session, callGameCtl) {
  return await callGameCtl(session, "gameCtl.getSeedList", [withSilent({ sortMode: 3 })]);
}

async function getShopSeedList(session, callGameCtl) {
  await callGameCtl(session, "gameCtl.requestShopData", [2]);
  return await callGameCtl(session, "gameCtl.getShopSeedList", [withSilent({ sortByLevel: true })]);
}

async function getPlayerProfile(session, callGameCtl) {
  let profile = null;
  let candidates = null;
  let lastError = null;
  try {
    profile = await callGameCtl(session, "gameCtl.getPlayerProfile", [withSilent({})]);
    candidates = await callGameCtl(session, "gameCtl.scanSystemAccountCandidates", [withSilent({ limit: 20 })]);
  } catch (error) {
    lastError = error instanceof Error ? error : new Error(String(error));
  }

  const resolvedProfile = resolveProfileWithCandidates(profile, candidates).profile;
  let cachedProfile = null;
  try {
    const cacheState = await readPlayerProfileCache();
    if (
      cacheState &&
      cacheState.usableProfile &&
      (!resolvedProfile || profilesMatchIdentity(resolvedProfile, cacheState.usableProfile))
    ) {
      cachedProfile = cacheState.usableProfile;
    }
  } catch (_) {
    cachedProfile = null;
  }

  const hydratedProfile = cachedProfile
    ? mergeProfileWithFallback(cachedProfile, resolvedProfile)
    : resolvedProfile;

  if (isProfileCacheUsable(hydratedProfile)) {
    try {
      await writePlayerProfileCache(null, hydratedProfile);
    } catch (_) {
      /* 忽略缓存写入失败，避免影响自动化主流程 */
    }
    return hydratedProfile;
  }

  if (cachedProfile) return cachedProfile;

  if (resolvedProfile && typeof resolvedProfile === "object") {
    return resolvedProfile;
  }

  throw lastError || new Error("player profile unavailable");
}

async function resolveEffectivePlantLevel(session, callGameCtl, opts) {
  const configuredLevel = Number(opts && opts.autoPlantMaxLevel) || 0;
  if (configuredLevel > 0) {
    return {
      maxLevel: configuredLevel,
      source: "config",
      profile: null,
    };
  }

  try {
    const profile = await getPlayerProfile(session, callGameCtl);
    const profilePlantLevel = getProfilePlantLevel(profile);
    if (profilePlantLevel > 0) {
      return {
        maxLevel: profilePlantLevel,
        source: Number(profile && (profile.plantLevel || profile.farmMaxLandLevel)) > 0
          ? "profile_plant_level"
          : "profile",
        profile,
      };
    }
    return {
      maxLevel: 0,
      source: "none",
      profile: profile || null,
    };
  } catch (_) {
    return {
      maxLevel: 0,
      source: "none",
      profile: null,
    };
  }
}

function normalizeSeedCandidates(seedList, shopList) {
  const backpackBySeedId = new Map();
  const shopBySeedId = new Map();
  const backpack = Array.isArray(seedList) ? seedList : [];
  const shop = Array.isArray(shopList) ? shopList : [];

  backpack.forEach((item) => {
    const seedId = Number(item && (item.seedId || item.itemId)) || 0;
    if (seedId > 0) backpackBySeedId.set(seedId, item);
  });
  shop.forEach((item) => {
    const seedId = Number(item && item.itemId) || 0;
    if (seedId > 0) shopBySeedId.set(seedId, item);
  });

  return { backpackBySeedId, shopBySeedId };
}

async function resolvePlantStrategy(session, callGameCtl, opts) {
  const primaryMode = String(opts && (opts.autoPlantPrimaryMode || opts.autoPlantMode) || "none");
  const secondaryMode = String(opts && opts.autoPlantSecondaryMode || "none");
  const candidates = [primaryMode, secondaryMode].filter((mode, index, list) => mode && mode !== "none" && list.indexOf(mode) === index);
  if (candidates.length === 0) return null;

  const seedList = await getSeedList(session, callGameCtl);
  let shopList = [];
  let shopListError = null;
  try {
    shopList = await getShopSeedList(session, callGameCtl);
  } catch (error) {
    shopList = [];
    shopListError = toErrorMessage(error);
  }
  const { backpackBySeedId, shopBySeedId } = normalizeSeedCandidates(seedList, shopList);
  const effectiveLevel = await resolveEffectivePlantLevel(session, callGameCtl, opts);
  const analyticsList = filterAnalyticsByLevel(getPlantAnalyticsList(), effectiveLevel.maxLevel);
  const backpackPrioritySeedIds = normalizeBackpackPrioritySeedIds(opts && opts.autoPlantBackpackSeedPriority);
  const decisionLog = [];

  function buildDecisionEntry(mode, phase, extra) {
    return {
      mode,
      phase,
      effectiveMaxLevel: effectiveLevel.maxLevel,
      levelSource: effectiveLevel.source,
      ...extra,
    };
  }

  async function resolvePlantStrategyForMode(mode) {
    if (!mode || mode === "none") return null;
    if (mode === "backpack_first") {
      const backpackPlan = buildBackpackSeedPlan(seedList, backpackPrioritySeedIds);
      const selectedBackpackSeed = pickBackpackSeed(seedList, backpackPrioritySeedIds);
      if (selectedBackpackSeed && selectedBackpackSeed.item) {
        const availableBackpackSeed = selectedBackpackSeed.item;
        const selectedSeedId = Number(availableBackpackSeed.seedId || availableBackpackSeed.itemId || availableBackpackSeed.id) || 0;
        const selectedPlant = selectedSeedId > 0 ? getPlantBySeedId(selectedSeedId) : null;
        const selectedStrategy = selectedSeedId > 0
          ? (analyticsList.find((item) => Number(item && item.seedId) === selectedSeedId) || null)
          : null;
        return {
          ok: true,
          mode,
          resolvedMode: "backpack_first",
          seedId: selectedSeedId || null,
          seedName: availableBackpackSeed.name || (selectedPlant && selectedPlant.name) || null,
          plantId: selectedPlant ? (Number(selectedPlant.id) || null) : null,
          strategy: selectedStrategy,
          backpackPlan: backpackPlan.map((entry) => {
            const planPlant = getPlantBySeedId(entry.seedId);
            return {
              seedId: entry.seedId,
              seedName: entry.item && entry.item.name ? entry.item.name : (planPlant && planPlant.name) || null,
              plantId: planPlant ? (Number(planPlant.id) || null) : null,
              backpackCount: Number(entry.count) || 0,
              usedPriority: entry.usedPriority === true,
            };
          }),
          decision: buildDecisionEntry(mode, "resolved", {
            reason: "backpack_seed_available",
            selectedSeedId: selectedSeedId || null,
            selectedSeedName: availableBackpackSeed.name || (selectedPlant && selectedPlant.name) || null,
            selectedPlantId: selectedPlant ? (Number(selectedPlant.id) || null) : null,
            source: "backpack",
            backpackCount: Number(availableBackpackSeed.count) || 0,
            usedBackpackPriority: selectedBackpackSeed.usedPriority === true,
            backpackPrioritySeedIds,
          }),
        };
      }
      return {
        ok: false,
        mode,
        reason: "no_seeds_in_backpack",
        decision: buildDecisionEntry(mode, "failed", {
          reason: "no_seeds_in_backpack",
          source: "backpack",
          backpackPrioritySeedIds,
        }),
      };
    }

    if (mode === "specified_seed") {
      const specifiedSeedId = Number(opts && opts.autoPlantSeedId) || 0;
      if (specifiedSeedId <= 0) {
        return {
          ok: false,
          mode,
          reason: "seed_id_required",
          decision: buildDecisionEntry(mode, "failed", {
            reason: "seed_id_required",
          }),
        };
      }
      const specifiedPlant = getPlantBySeedId(specifiedSeedId);
      const specifiedSeedName = (
        (specifiedPlant && specifiedPlant.name)
        || (specifiedPlant && specifiedPlant.seed_name)
        || null
      );
      const backpackSeed = backpackBySeedId.get(specifiedSeedId);
      if (backpackSeed && (Number(backpackSeed.count) || 0) > 0) {
        return {
          ok: true,
          mode,
          resolvedMode: "specified_seed",
          seedId: specifiedSeedId,
          seedName: backpackSeed.name || specifiedSeedName,
          plantId: specifiedPlant ? (Number(specifiedPlant.id) || null) : null,
          decision: buildDecisionEntry(mode, "resolved", {
            reason: "specified_seed_in_backpack",
            selectedSeedId: specifiedSeedId,
            selectedSeedName: backpackSeed.name || specifiedSeedName || null,
            selectedPlantId: specifiedPlant ? (Number(specifiedPlant.id) || null) : null,
            source: "backpack",
            backpackCount: Number(backpackSeed.count) || 0,
          }),
        };
      }
      const shopSeed = shopBySeedId.get(specifiedSeedId);
      if (shopSeed) {
        return {
          ok: true,
          mode,
          resolvedMode: "specified_seed",
          seedId: specifiedSeedId,
          seedName: shopSeed.name || specifiedSeedName,
          plantId: specifiedPlant ? (Number(specifiedPlant.id) || null) : null,
          shopGoodsId: shopSeed.goodsId,
          shopPrice: shopSeed.price,
          shopPriceId: shopSeed.priceId,
          decision: buildDecisionEntry(mode, "resolved", {
            reason: "specified_seed_in_shop",
            selectedSeedId: specifiedSeedId,
            selectedSeedName: shopSeed.name || specifiedSeedName || null,
            selectedPlantId: specifiedPlant ? (Number(specifiedPlant.id) || null) : null,
            source: "shop",
            shopGoodsId: shopSeed.goodsId || null,
            shopPrice: shopSeed.price || null,
          }),
        };
      }
      if (shopListError) {
        return {
          ok: true,
          mode,
          resolvedMode: "specified_seed",
          seedId: specifiedSeedId,
          seedName: specifiedSeedName,
          plantId: specifiedPlant ? (Number(specifiedPlant.id) || null) : null,
          shopLookupDeferred: true,
          shopListError,
          decision: buildDecisionEntry(mode, "resolved", {
            reason: "specified_seed_shop_lookup_deferred",
            selectedSeedId: specifiedSeedId,
            selectedSeedName: specifiedSeedName || null,
            selectedPlantId: specifiedPlant ? (Number(specifiedPlant.id) || null) : null,
            source: "shop_lookup_deferred",
            shopListError,
          }),
        };
      }
      return {
        ok: false,
        mode,
        reason: "seed_not_available",
        decision: buildDecisionEntry(mode, "failed", {
          reason: "seed_not_available",
          selectedSeedId: specifiedSeedId,
          selectedSeedName: specifiedSeedName || null,
        }),
      };
    }

    const rankedPlants = (() => {
      if (!Array.isArray(analyticsList) || analyticsList.length === 0) return [];
      const sortKeyMap = {
        highest_level: "level",
        max_exp: "exp",
        max_fert_exp: "fert_exp",
        max_profit: "profit",
        max_fert_profit: "fert_profit",
      };
      const sortKey = sortKeyMap[mode];
      return sortKey ? sortAnalyticsList(analyticsList, sortKey) : [];
    })();
    const fallbackBest = rankedPlants[0] || pickBestPlantByMode(mode, { maxLevel: effectiveLevel.maxLevel });
    if (!fallbackBest) {
      return {
        ok: false,
        mode,
        reason: analyticsList.length ? "seed_not_available" : "no_plant_candidates",
        effectiveMaxLevel: effectiveLevel.maxLevel,
        levelSource: effectiveLevel.source,
        playerProfile: effectiveLevel.profile,
        decision: buildDecisionEntry(mode, "failed", {
          reason: analyticsList.length ? "seed_not_available" : "no_plant_candidates",
          rankedCount: Array.isArray(rankedPlants) ? rankedPlants.length : 0,
        }),
      };
    }

    for (let i = 0; i < rankedPlants.length; i += 1) {
      const candidate = rankedPlants[i];
      if (!candidate || !(Number(candidate.seedId) > 0)) continue;

      const backpackSeed = backpackBySeedId.get(candidate.seedId);
      if (backpackSeed && (Number(backpackSeed.count) || 0) > 0) {
        return {
          ok: true,
          mode,
          resolvedMode: mode,
          plantId: candidate.id,
          seedId: candidate.seedId,
          seedName: candidate.name,
          strategy: candidate,
          effectiveMaxLevel: effectiveLevel.maxLevel,
          levelSource: effectiveLevel.source,
          playerProfile: effectiveLevel.profile,
          decision: buildDecisionEntry(mode, "resolved", {
            reason: "strategy_seed_in_backpack",
            rankedIndex: i,
            selectedPlantId: candidate.id || null,
            selectedSeedId: candidate.seedId || null,
            selectedSeedName: candidate.name || null,
            source: "backpack",
            backpackCount: Number(backpackSeed.count) || 0,
          }),
        };
      }

      const shopSeed = shopBySeedId.get(candidate.seedId);
      if (shopSeed) {
        return {
          ok: true,
          mode,
          resolvedMode: mode,
          plantId: candidate.id,
          seedId: candidate.seedId,
          seedName: candidate.name,
          shopGoodsId: shopSeed.goodsId,
          shopPrice: shopSeed.price,
          shopPriceId: shopSeed.priceId,
          strategy: candidate,
          effectiveMaxLevel: effectiveLevel.maxLevel,
          levelSource: effectiveLevel.source,
          playerProfile: effectiveLevel.profile,
          decision: buildDecisionEntry(mode, "resolved", {
            reason: "strategy_seed_in_shop",
            rankedIndex: i,
            selectedPlantId: candidate.id || null,
            selectedSeedId: candidate.seedId || null,
            selectedSeedName: candidate.name || null,
            source: "shop",
            shopGoodsId: shopSeed.goodsId || null,
            shopPrice: shopSeed.price || null,
          }),
        };
      }
    }

    if (shopListError) {
      return {
        ok: true,
        mode,
        resolvedMode: mode,
        plantId: fallbackBest.id,
        seedId: fallbackBest.seedId,
        seedName: fallbackBest.name,
        strategy: fallbackBest,
        effectiveMaxLevel: effectiveLevel.maxLevel,
        levelSource: effectiveLevel.source,
        playerProfile: effectiveLevel.profile,
        shopLookupDeferred: true,
        shopListError,
        decision: buildDecisionEntry(mode, "resolved", {
          reason: "strategy_shop_lookup_deferred",
          selectedPlantId: fallbackBest.id || null,
          selectedSeedId: fallbackBest.seedId || null,
          selectedSeedName: fallbackBest.name || null,
          source: "shop_lookup_deferred",
          shopListError,
        }),
      };
    }

    return {
      ok: false,
      mode,
      reason: "seed_not_available",
      strategy: fallbackBest,
      effectiveMaxLevel: effectiveLevel.maxLevel,
      levelSource: effectiveLevel.source,
      playerProfile: effectiveLevel.profile,
      decision: buildDecisionEntry(mode, "failed", {
        reason: "seed_not_available",
        selectedPlantId: fallbackBest.id || null,
        selectedSeedId: fallbackBest.seedId || null,
        selectedSeedName: fallbackBest.name || null,
        source: "unavailable",
      }),
    };
  }

  const attempts = [];
  for (let i = 0; i < candidates.length; i += 1) {
    const mode = candidates[i];
    const result = await resolvePlantStrategyForMode(mode);
    if (result && result.decision) {
      decisionLog.push({
        step: i + 1,
        fallbackUsed: i > 0,
        ...result.decision,
      });
    }
    if (result && result.ok) {
      return {
        ...result,
        primaryMode,
        secondaryMode,
        attempts,
        decisionLog,
        fallbackUsed: i > 0,
      };
    }
    if (result) {
      attempts.push({
        mode,
        ok: false,
        reason: result.reason || "resolve_failed",
      });
      if (i + 1 < candidates.length) {
        decisionLog.push({
          step: i + 1,
          mode,
          phase: "fallback",
          fallbackUsed: true,
          fallbackToMode: candidates[i + 1],
          reason: result.reason || "resolve_failed",
          message: `主策略 ${mode} 失败，回退到 ${candidates[i + 1]}`,
        });
      }
    }
  }

  const last = attempts[attempts.length - 1] || null;
  return {
    ok: false,
    mode: primaryMode,
    primaryMode,
    secondaryMode,
    attempts,
    decisionLog,
    reason: last && last.reason ? last.reason : "no_strategy_resolved",
  };
}

async function executeBackpackPriorityPlantPlan(session, callGameCtl, resolved, opts) {
  const requestedLandIds = Array.isArray(opts && opts.emptyLandIds) ? [...opts.emptyLandIds] : [];
  let remainingLandIds = requestedLandIds;
  if (remainingLandIds.length === 0) {
    const status = await getFarmStatus(session, callGameCtl, {
      includeGrids: true,
      includeLandIds: false,
    });
    remainingLandIds = status && status.farmType === "own" ? collectEmptyLandIds(status) : [];
  }
  const targetLandIdSet = new Set(remainingLandIds);
  const plan = Array.isArray(resolved && resolved.backpackPlan) ? resolved.backpackPlan : [];
  const attempts = [];
  let lastResult = null;
  let plantedAny = false;

  for (let i = 0; i < plan.length; i += 1) {
    const candidate = plan[i];
    if (!candidate || !candidate.seedId || remainingLandIds.length <= 0) continue;
    const result = await autoPlant(session, callGameCtl, resolved.mode || "backpack_first", {
      ...resolved,
      seedId: candidate.seedId,
      seedName: candidate.seedName,
      plantId: candidate.plantId,
      emptyLandIds: [...remainingLandIds],
    });
    lastResult = result;
    plantedAny = plantedAny || !!(result && result.ok);
    attempts.push({
      seedId: candidate.seedId,
      seedName: candidate.seedName || null,
      backpackCount: candidate.backpackCount || 0,
      usedPriority: candidate.usedPriority === true,
      result,
    });
    const status = await getFarmStatus(session, callGameCtl, {
      includeGrids: true,
      includeLandIds: false,
    });
    const emptyLandIds = status && status.farmType === "own" ? collectEmptyLandIds(status) : [];
    remainingLandIds = emptyLandIds.filter((landId) => targetLandIdSet.has(landId));
  }

  const primaryAttempt = attempts.find((item) => item && item.result && item.result.ok) || attempts[0] || null;
  const primaryResult = primaryAttempt && primaryAttempt.result ? primaryAttempt.result : lastResult;
  return {
    ...(primaryResult && typeof primaryResult === "object" ? primaryResult : {}),
    ok: plantedAny,
    mode: resolved && resolved.mode ? resolved.mode : "backpack_first",
    action: plantedAny ? "planted" : "plant_failed",
    seedId: primaryAttempt ? primaryAttempt.seedId : (primaryResult && primaryResult.seedId) || null,
    seedName: primaryAttempt ? (primaryAttempt.seedName || null) : (primaryResult && primaryResult.seedName) || null,
    seedSource: plantedAny ? "backpack_priority_plan" : ((primaryResult && primaryResult.seedSource) || "unavailable"),
    backpackPlanAttempts: attempts,
    remainingEmptyLandIds: remainingLandIds,
    plannedSeedCount: plan.length,
  };
}

async function runOwnFarmAutomation(session, callGameCtl, opts) {
  const enterWaitMs = Math.max(0, Number(opts && opts.enterWaitMs) || 0);
  const actionWaitMs = Math.max(0, Number(opts && opts.actionWaitMs) || 0);
  const includeCollect = !opts || opts.includeCollect !== false;
  const includeWater = !opts || opts.includeWater !== false;
  const includeEraseGrass = !opts || opts.includeEraseGrass !== false;
  const includeKillBug = !opts || opts.includeKillBug !== false;
  const plantPrimaryMode = opts && (opts.autoPlantPrimaryMode || opts.autoPlantMode) ? (opts.autoPlantPrimaryMode || opts.autoPlantMode) : "none";
  const plantSecondaryMode = opts && opts.autoPlantSecondaryMode ? opts.autoPlantSecondaryMode : "none";
  const fertilizerEnabled = !!(opts && opts.autoFertilizerEnabled === true);
  const fertilizerActive = shouldRunAutoFertilizer(opts || {});
  const baseTaskEnabled = includeCollect || includeWater || includeEraseGrass || includeKillBug;
  const plantConfigured = plantPrimaryMode !== "none" || plantSecondaryMode !== "none";
  throwIfAutomationStopped(opts);
  if (!baseTaskEnabled && !plantConfigured && !fertilizerActive) {
    return {
      ok: true,
      skipped: true,
      skipReason: "no_own_tasks_enabled",
      enterOwn: null,
      tasks: null,
      plantResult: null,
      fertilizerResult: fertilizerEnabled
        ? {
            ok: true,
            skipped: true,
            reason: "disabled",
            executedMode: "none",
          }
        : null,
    };
  }
  let ownership = null;
  try {
    ownership = await getFarmOwnership(session, callGameCtl, { allowWeakUi: true });
  } catch (_) {
    ownership = null;
  }

  let enterOwn = null;
  if (!ownership || ownership.farmType !== "own") {
    enterOwn = await enterOwnFarm(session, callGameCtl, {
      waitMs: enterWaitMs,
      includeAfterOwnership: true,
    });
  }

  const tasks = await runCurrentFarmOneClickTasks(session, callGameCtl, {
    includeCollect,
    includeWater,
    includeEraseGrass,
    includeKillBug,
    actionWaitMs: opts && opts.actionWaitMs,
    stopOnError: !!(opts && opts.stopOnError),
    runContext: opts && opts.runContext,
  });

  // 自动种植
  let plantResult = null;
  if (plantPrimaryMode !== "none" || plantSecondaryMode !== "none") {
    try {
      if (actionWaitMs > 0) {
        await waitWithAutomationControl(actionWaitMs, opts);
      }
      throwIfAutomationStopped(opts);
      let emptyLandIds = null;
      try {
        const plantStatus = await getFarmStatus(session, callGameCtl, {
          includeGrids: true,
          includeLandIds: false,
        });
        if (plantStatus && plantStatus.farmType === "own") {
          emptyLandIds = collectEmptyLandIds(plantStatus);
          if (emptyLandIds.length === 0) {
            const preferredMode = plantPrimaryMode !== "none" ? plantPrimaryMode : plantSecondaryMode;
            plantResult = {
              ok: true,
              mode: preferredMode || "none",
              action: "no_empty_lands",
              emptyCount: 0,
              primaryMode: plantPrimaryMode,
              secondaryMode: plantSecondaryMode,
              resolvedMode: preferredMode || "none",
              fallbackUsed: false,
              strategyAttempts: [],
              decisionLog: [],
            };
          }
        }
      } catch (_) {
        emptyLandIds = null;
      }

      if (!plantResult) {
        const resolveOpts = {
          ...(opts || {}),
          emptyLandIds: Array.isArray(emptyLandIds) ? [...emptyLandIds] : undefined,
        };
        const resolved = await resolvePlantStrategy(session, callGameCtl, resolveOpts);
        if (resolved && resolved.ok === false) {
          plantResult = resolved;
        } else if (resolved && Array.isArray(resolved.backpackPlan) && resolved.backpackPlan.length > 0) {
          plantResult = await executeBackpackPriorityPlantPlan(session, callGameCtl, resolved, {
            ...(opts || {}),
            emptyLandIds: Array.isArray(emptyLandIds) ? [...emptyLandIds] : undefined,
          });
          if (plantResult && typeof plantResult === "object") {
            plantResult.strategy = resolved.strategy || null;
            plantResult.primaryMode = resolved.primaryMode || plantPrimaryMode;
            plantResult.secondaryMode = resolved.secondaryMode || plantSecondaryMode;
            plantResult.resolvedMode = resolved.resolvedMode || resolved.mode || plantPrimaryMode;
            plantResult.fallbackUsed = !!resolved.fallbackUsed;
            plantResult.strategyAttempts = Array.isArray(resolved.attempts) ? resolved.attempts : [];
            plantResult.decisionLog = Array.isArray(resolved.decisionLog) ? resolved.decisionLog : [];
            plantResult.executionSummary = plantResult.ok
              ? `背包优先已按优先级顺序完成种植，尝试了 ${plantResult.plannedSeedCount || 0} 个种子`
              : "背包优先执行失败";
          }
        } else if (resolved && resolved.seedId) {
          plantResult = await autoPlant(session, callGameCtl, resolved.mode || plantPrimaryMode, {
            ...resolved,
            emptyLandIds: Array.isArray(emptyLandIds) ? [...emptyLandIds] : undefined,
          });
          if (plantResult && typeof plantResult === "object") {
            plantResult.strategy = resolved.strategy || null;
            plantResult.primaryMode = resolved.primaryMode || plantPrimaryMode;
            plantResult.secondaryMode = resolved.secondaryMode || plantSecondaryMode;
            plantResult.resolvedMode = resolved.resolvedMode || resolved.mode || plantPrimaryMode;
            plantResult.fallbackUsed = !!resolved.fallbackUsed;
            plantResult.strategyAttempts = Array.isArray(resolved.attempts) ? resolved.attempts : [];
            plantResult.decisionLog = Array.isArray(resolved.decisionLog) ? resolved.decisionLog : [];
            plantResult.executionSummary = plantResult.ok
              ? `策略 ${plantResult.resolvedMode} 成功种植 ${plantResult.seedName || plantResult.seedId || "unknown"}`
              : `策略 ${plantResult.resolvedMode} 执行失败`;
          }
        } else {
          plantResult = await autoPlant(session, callGameCtl, resolved && resolved.mode ? resolved.mode : plantPrimaryMode, {
            emptyLandIds: Array.isArray(emptyLandIds) ? [...emptyLandIds] : undefined,
          });
        }
      }
    } catch (error) {
      if (isAutomationStoppedError(error)) throw error;
      plantResult = { ok: false, error: toErrorMessage(error) };
    }
  }

  let fertilizerResult = null;
  if (fertilizerEnabled) {
    try {
      if (fertilizerActive && actionWaitMs > 0) {
        await waitWithAutomationControl(actionWaitMs, opts);
      }
      throwIfAutomationStopped(opts);
      fertilizerResult = await runOwnFarmFertilizerTasks(session, callGameCtl, opts || {});
    } catch (error) {
      if (isAutomationStoppedError(error)) throw error;
      fertilizerResult = { ok: false, error: toErrorMessage(error) };
    }
  }

  return {
    ok: true,
    enterOwn,
    tasks,
    plantResult,
    fertilizerResult,
  };
}

async function runFriendStealAutomation(session, callGameCtl, opts) {
  const enterWaitMs = Math.max(0, Number(opts && opts.enterWaitMs) || 0);
  const actionWaitMs = Math.max(0, Number(opts && opts.actionWaitMs) || 0);
  const maxFriends = Math.max(0, Number(opts && opts.maxFriends) || 0) || 5;
  const stealEnabled = !!(opts && opts.friendStealEnabled === true);
  const helpEnabled = !!(opts && opts.friendHelpEnabled === true);
  const helpDailyLimit = resolveFriendHelpDailyLimit(opts && opts.friendHelpDailyLimit);
  const helpState = helpEnabled
    ? normalizeFriendHelpState(opts && opts.friendHelpState, null, helpDailyLimit)
    : normalizeFriendHelpState({}, null, helpDailyLimit);
  let helpLimitReached = helpEnabled && isFriendHelpLimitReached(helpState, helpDailyLimit);
  const friendCooldowns = normalizeFriendCooldownEntries(opts && opts.friendVisitCooldowns);
  const stealPlantBlacklistEnabled = !!(opts && opts.friendStealPlantBlacklistEnabled === true);
  const stealPlantBlacklistStrategy = normalizeBlacklistStrategy(opts && opts.friendStealPlantBlacklistStrategy);
  const stealPlantBlacklist = stealPlantBlacklistEnabled
    ? normalizePositiveIntList(opts && opts.friendStealPlantBlacklist)
    : [];
  const blacklistPolicy = {
    enabled: stealPlantBlacklistEnabled,
    strategy: stealPlantBlacklistStrategy,
    strategyLabel: stealPlantBlacklistStrategy === 2
      ? "skip_blacklisted_grids_only"
      : "skip_whole_farm_on_hit",
    blacklistedPlantIds: [...stealPlantBlacklist],
  };
  throwIfAutomationStopped(opts);
  if (isInQuietHours(opts)) {
    return {
      ok: true,
      skipped: true,
      skipReason: "quiet_hours",
      module: "friend_patrol",
      action: "skip",
      quietHours: {
        enabled: true,
        start: opts.friendQuietHoursStart || null,
        end: opts.friendQuietHoursEnd || null,
      },
      blacklistPolicy: {
        ...blacklistPolicy,
        decision: {
          ok: true,
          skipped: true,
          reason: "quiet_hours",
          mode: "quiet_hours",
        },
      },
      totalCandidates: 0,
      stealableCandidates: 0,
      blacklistedCount: 0,
      explicitBlacklistedCount: 0,
      maskedBlockedCount: 0,
      cooldownBlockedCount: 0,
      helpEnabled,
      helpableCandidates: 0,
      helpDailyLimit,
      helpLimitReached,
      helpState: normalizeFriendHelpState(helpState, null, helpDailyLimit),
      maskedBlockedEnabled: !!(opts && opts.friendBlockMaskedStealers === true),
      stealPlantBlacklistEnabled,
      stealPlantBlacklist,
      cooldownFriends: [],
      visits: [],
      returnHome: null,
    };
  }

  throwIfAutomationStopped(opts);
  const friendData = await getFriendList(session, callGameCtl, {
    refresh: !opts || opts.refresh !== false,
    sort: true,
    includeSelf: false,
  });
  const friendList = Array.isArray(friendData && friendData.list) ? friendData.list : [];
  const maskedBlockedFriends = friendList.filter((item) => (
    opts && opts.friendBlockMaskedStealers === true && isMaskedStealFriend(item)
  ));
  const blacklistedFriends = friendList.filter((item) => isFriendBlacklisted(item, opts && opts.friendBlacklist));
  const cooldownBlockedFriends = friendList.filter((item) => {
    const gid = Number(item && item.gid);
    return Number.isFinite(gid) && gid > 0 && friendCooldowns.has(gid);
  });
  const blockedFriends = friendList.filter((item) => (
    isFriendBlacklisted(item, opts && opts.friendBlacklist)
    || (opts && opts.friendBlockMaskedStealers === true && isMaskedStealFriend(item))
  ));
  const selectableFriends = friendList.filter((item) => (
    !blockedFriends.includes(item)
    && !cooldownBlockedFriends.includes(item)
  ));
  const helpableCandidates = selectableFriends.filter((item) => (
    getHelpWorkTotal(getHelpWorkCounts(item)) > 0
  )).length;
  const candidates = selectableFriends
    .filter((item) => {
      const workCounts = item && item.workCounts && typeof item.workCounts === "object"
        ? item.workCounts
        : {};
      const canSteal = stealEnabled && (Number(workCounts.collect) || 0) > 0;
      const canHelp = helpEnabled
        && getHelpWorkTotal(getHelpWorkCounts(item)) > 0
        && !helpLimitReached;
      return canSteal || canHelp;
    })
    .sort((a, b) => {
      const stealDiff = (Number(b && b.workCounts && b.workCounts.collect) || 0)
        - (Number(a && a.workCounts && a.workCounts.collect) || 0);
      if (stealDiff !== 0) return stealDiff;
      const helpDiff = getHelpWorkTotal(getHelpWorkCounts(b))
        - getHelpWorkTotal(getHelpWorkCounts(a));
      if (helpDiff !== 0) return helpDiff;
      return (Number(a && a.rank) || 0) - (Number(b && b.rank) || 0);
    })
    .slice(0, maxFriends);
  const visits = [];

  for (let i = 0; i < candidates.length; i += 1) {
    throwIfAutomationStopped(opts);
    const friend = candidates[i];
    try {
      const enter = await enterFriendFarm(session, callGameCtl, friend.gid, {
        waitMs: enterWaitMs,
        includeAfterOwnership: true,
      });
      const beforeStatus = await getFarmStatus(session, callGameCtl, {
        includeGrids: stealPlantBlacklist.length > 0,
        includeLandIds: false,
      });
      if (beforeStatus.farmType !== "friend") {
        visits.push({
          ok: false,
          module: "friend_visit",
          action: "enter",
          friend,
          enter,
          reason: "not_in_friend_farm",
          status: summarizeFarmStatus(beforeStatus),
        });
        continue;
      }

      const collectBefore = getWorkCount(beforeStatus, "collect");
      const helpBeforeCounts = getHelpWorkCounts(beforeStatus);
      const helpBeforeTotal = getHelpWorkTotal(helpBeforeCounts);
      const canSteal = stealEnabled && collectBefore > 0;
      const canHelp = helpEnabled && helpBeforeTotal > 0 && !helpLimitReached;
      if (!canSteal && !canHelp) {
        const reason = helpEnabled && helpBeforeTotal > 0 && helpLimitReached
          ? "help_daily_limit_reached"
          : (collectBefore <= 0 ? "no_collectable_after_enter" : "no_actionable_after_enter");
        visits.push({
          ok: true,
          module: "friend_visit",
          action: "inspect",
          friend,
          enter,
          reason,
          before: summarizeFarmStatus(beforeStatus),
          after: summarizeFarmStatus(beforeStatus),
          collectBefore,
          collectAfter: collectBefore,
          helpBeforeCounts,
          helpAfterCounts: helpBeforeCounts,
          helpPerformed: false,
          helpSkipReason: reason === "help_daily_limit_reached" ? "daily_limit_reached" : null,
        });
        continue;
      }

      let trigger = null;
      let selective = null;
      let visitAction = "inspect";
      let blacklistDecision = {
        ...blacklistPolicy,
        inspectedCount: 0,
        matchedCount: 0,
        matchedLandIds: [],
        allowedLandIds: [],
        skippedLandIds: [],
        hit: false,
        action: "one_click",
        reason: "blacklist_disabled_or_empty",
      };
      let stealSkippedReason = null;
      if (canSteal && stealPlantBlacklistEnabled && stealPlantBlacklist.length > 0) {
        const targets = collectAllowedStealTargets(beforeStatus, stealPlantBlacklist);
        const matchedLandIds = Array.isArray(targets.blacklistedActionableLandIds)
          ? [...targets.blacklistedActionableLandIds]
          : [];
        const hasBlacklistedTargets = matchedLandIds.length > 0;
        const allowedLandIds = Array.isArray(targets.allowedLandIds) ? [...targets.allowedLandIds] : [];
        const skippedLandIds = Array.isArray(targets.skipped)
          ? targets.skipped
            .filter((item) => item && item.actionable === true)
            .map((item) => Number(item.landId) || null)
            .filter((value) => Number.isFinite(value) && value > 0)
          : [];
        blacklistDecision = {
          ...blacklistPolicy,
          inspectedCount: Array.isArray(targets.inspected) ? targets.inspected.length : 0,
          matchedCount: matchedLandIds.length,
          matchedLandIds,
          allowedLandIds,
          skippedLandIds,
          hit: hasBlacklistedTargets,
          action: hasBlacklistedTargets
            ? (stealPlantBlacklistStrategy === 1 ? "skip_whole_farm" : "skip_blacklisted_lands")
            : "one_click",
          reason: hasBlacklistedTargets
            ? (stealPlantBlacklistStrategy === 1 ? "blacklist_hit_skip_whole_farm" : "blacklist_hit_skip_land")
            : "blacklist_miss",
        };
        selective = {
          module: "friend_blacklist",
          action: "inspect",
          mode: hasBlacklistedTargets
            ? (stealPlantBlacklistStrategy === 1 ? "skip_whole_farm" : "targeted")
            : "one_click",
          enabled: true,
          blacklistedPlantIds: stealPlantBlacklist,
          strategy: stealPlantBlacklistStrategy,
          strategyLabel: blacklistPolicy.strategyLabel,
          allowedLandIds,
          skipped: targets.skipped,
          inspected: targets.inspected,
          decision: blacklistDecision,
        };
        if (hasBlacklistedTargets && stealPlantBlacklistStrategy === 1) {
          stealSkippedReason = "blacklist_strategy_skip_whole_farm";
          if (!canHelp) {
            visits.push({
              ok: true,
              module: "friend_visit",
              action: "skip",
              friend,
              enter,
              reason: stealSkippedReason,
              before: summarizeFarmStatus(beforeStatus),
              after: summarizeFarmStatus(beforeStatus),
              collectBefore,
              collectAfter: collectBefore,
              helpBeforeCounts,
              helpAfterCounts: helpBeforeCounts,
              helpPerformed: false,
              selective,
              blacklistDecision,
            });
            continue;
          }
        }
        if (hasBlacklistedTargets && allowedLandIds.length <= 0) {
          stealSkippedReason = "all_collectable_blacklisted";
          if (!canHelp) {
            visits.push({
              ok: true,
              module: "friend_visit",
              action: "skip",
              friend,
              enter,
              reason: stealSkippedReason,
              before: summarizeFarmStatus(beforeStatus),
              after: summarizeFarmStatus(beforeStatus),
              collectBefore,
              collectAfter: collectBefore,
              helpBeforeCounts,
              helpAfterCounts: helpBeforeCounts,
              helpPerformed: false,
              selective,
              blacklistDecision,
            });
            continue;
          }
        }
        if (!stealSkippedReason && hasBlacklistedTargets) {
          visitAction = "targeted_harvest";
          const actions = [];
          for (let j = 0; j < allowedLandIds.length; j += 1) {
            throwIfAutomationStopped(opts);
            const landId = allowedLandIds[j];
            try {
              const result = await clickMatureEffect(session, callGameCtl, landId, {
                waitForResult: true,
              });
              actions.push({ ok: !!(result && result.ok), landId, result });
            } catch (error) {
              actions.push({ ok: false, landId, error: toErrorMessage(error) });
              if (opts && opts.stopOnError) break;
            }
            if (actionWaitMs > 0 && j < allowedLandIds.length - 1) {
              await waitWithAutomationControl(actionWaitMs, opts);
            }
          }
          trigger = { op: "TARGETED_HARVEST", actions };
        } else if (!stealSkippedReason) {
          trigger = await triggerOneClickOperation(session, callGameCtl, "HARVEST", {
            includeBefore: false,
            includeAfter: false,
          });
          visitAction = "one_click_harvest";
          if (actionWaitMs > 0) {
            await waitWithAutomationControl(actionWaitMs, opts);
          }
        }
      } else if (canSteal) {
        trigger = await triggerOneClickOperation(session, callGameCtl, "HARVEST", {
          includeBefore: false,
          includeAfter: false,
        });
        visitAction = "one_click_harvest";
        if (actionWaitMs > 0) {
          await waitWithAutomationControl(actionWaitMs, opts);
        }
      }

      let helpPerformed = false;
      let helpSkipReason = null;
      let helpTracked = null;
      if (helpEnabled) {
        if (helpLimitReached) {
          helpSkipReason = "daily_limit_reached";
        } else if (helpBeforeTotal <= 0) {
          helpSkipReason = "no_help_actionable";
        } else {
          const helpOperations = buildFriendHelpOperations(helpBeforeCounts);
          for (let j = 0; j < helpOperations.length; j += 1) {
            throwIfAutomationStopped(opts);
            const spec = helpOperations[j];
            await triggerOneClickOperation(session, callGameCtl, spec.op, {
              includeBefore: false,
              includeAfter: false,
            });
            helpPerformed = true;
            if (actionWaitMs > 0 && j < helpOperations.length - 1) {
              await waitWithAutomationControl(actionWaitMs, opts);
            }
          }
          if (helpPerformed) {
            visitAction = trigger ? "harvest+help" : "help";
            helpTracked = recordFriendHelpRound(helpState, {
              friendGid: Number(friend && friend.gid) || null,
              dailyLimit: helpDailyLimit,
            });
            helpLimitReached = helpTracked.limitReached;
          }
        }
      }

      const afterStatus = await getFarmStatus(session, callGameCtl, {
        includeGrids: false,
        includeLandIds: false,
      });
      const collectAfter = getWorkCount(afterStatus, "collect");
      const helpAfterCounts = getHelpWorkCounts(afterStatus);
      visits.push({
        ok: true,
        module: "friend_visit",
        action: visitAction,
        friend,
        enter,
        before: summarizeFarmStatus(beforeStatus),
        after: summarizeFarmStatus(afterStatus),
        trigger,
        collectBefore,
        collectAfter,
        helpBeforeCounts,
        helpAfterCounts,
        helpPerformed,
        helpSkipReason,
        helpTracked,
        helpLimitReached,
        stealSkippedReason,
        selective,
        blacklistDecision,
      });
      if (helpEnabled && helpLimitReached && !stealEnabled) {
        break;
      }
    } catch (error) {
      if (isAutomationStoppedError(error)) throw error;
      visits.push({
        ok: false,
        module: "friend_visit",
        action: "error",
        friend,
        error: toErrorMessage(error),
      });
      if (opts && opts.stopOnError) break;
    }
  }

  let returnHome = null;
  if (!opts || opts.returnHome !== false) {
    throwIfAutomationStopped(opts);
    try {
      returnHome = await enterOwnFarm(session, callGameCtl, {
        waitMs: enterWaitMs,
        includeAfterOwnership: true,
      });
    } catch (error) {
      if (isAutomationStoppedError(error)) throw error;
      returnHome = {
        ok: false,
        error: toErrorMessage(error),
      };
    }
  }

  return {
    ok: true,
    module: "friend_patrol",
    action: "run",
    requestedRefresh: !!(friendData && friendData.requestedRefresh),
    refreshed: !!(friendData && friendData.refreshed),
    refreshError: friendData && friendData.refreshError ? friendData.refreshError : null,
    refreshMode: friendData && friendData.refreshMode ? friendData.refreshMode : "none",
    totalCandidates: selectableFriends.length,
    stealableCandidates: selectableFriends.filter((item) => (Number(item && item.workCounts && item.workCounts.collect) || 0) > 0).length,
    helpableCandidates,
    helpEnabled,
    helpDailyLimit,
    helpLimitReached,
    helpState: normalizeFriendHelpState(helpState, null, helpDailyLimit),
    blacklistedCount: blockedFriends.length,
    explicitBlacklistedCount: blacklistedFriends.length,
    maskedBlockedCount: maskedBlockedFriends.length,
    cooldownBlockedCount: cooldownBlockedFriends.length,
    maskedBlockedEnabled: !!(opts && opts.friendBlockMaskedStealers === true),
    stealPlantBlacklistEnabled,
    stealPlantBlacklistStrategy,
    stealPlantBlacklist,
    blacklistPolicy,
    blacklistedFriends: blacklistedFriends.map((friend) => ({
      gid: friend && friend.gid != null ? friend.gid : null,
      displayName: friend && (friend.displayName || friend.name || friend.remark) ? (friend.displayName || friend.name || friend.remark) : null,
    })),
    maskedBlockedFriends: maskedBlockedFriends.map((friend) => ({
      gid: friend && friend.gid != null ? friend.gid : null,
      displayName: friend && (friend.displayName || friend.name || friend.remark) ? (friend.displayName || friend.name || friend.remark) : null,
      level: friend && friend.level != null ? Number(friend.level) : null,
    })),
    cooldownFriends: cooldownBlockedFriends.map((friend) => ({
      gid: friend && friend.gid != null ? Number(friend.gid) : null,
      displayName: friend && (friend.displayName || friend.name || friend.remark) ? (friend.displayName || friend.name || friend.remark) : null,
      untilMs: friend && friend.gid != null ? (friendCooldowns.get(Number(friend.gid)) || null) : null,
    })),
    visits,
    returnHome,
  };
}

async function runAutoFarmCycle({ session, callGameCtl, options }) {
  const opts = options && typeof options === "object" ? options : {};
  throwIfAutomationStopped(opts);
  const startedAt = new Date().toISOString();
  const ownFarmEnabled = opts.ownFarmEnabled !== false;
  const friendStealEnabled = !!opts.friendStealEnabled;
  const friendHelpEnabled = !!opts.friendHelpEnabled;
  const friendPatrolEnabled = !!(friendStealEnabled || friendHelpEnabled);
  const payload = {
    ok: true,
    startedAt,
    ownFarmEnabled,
    friendStealEnabled: friendPatrolEnabled,
    friendHelpEnabled,
    modules: [],
    initialOwnership: null,
    ownFarm: null,
    friendSteal: null,
    finalOwnership: null,
  };

  function summarizeOwnFarmModule(ownFarm) {
    const tasks = ownFarm && ownFarm.tasks && typeof ownFarm.tasks === "object" ? ownFarm.tasks : null;
    const actions = Array.isArray(tasks && tasks.actions) ? tasks.actions : [];
    return {
      module: "own_farm",
      action: ownFarm && ownFarm.skipped === true ? "skip" : "run",
      ok: ownFarm && ownFarm.ok === true,
      skipped: ownFarm && ownFarm.skipped === true,
      reason: ownFarm && (ownFarm.skipReason || ownFarm.reason) ? (ownFarm.skipReason || ownFarm.reason) : null,
      taskCount: actions.length,
      actionResults: actions.map((item) => ({
        key: item && item.key != null ? item.key : null,
        ok: item && item.ok === true,
        landId: item && item.landId != null ? Number(item.landId) || null : null,
        reason: item && item.reason ? item.reason : null,
      })),
      plantResult: ownFarm && ownFarm.plantResult ? {
        ok: ownFarm.plantResult.ok === true,
        action: ownFarm.plantResult.action || null,
        resolvedMode: ownFarm.plantResult.resolvedMode || ownFarm.plantResult.mode || null,
        reason: ownFarm.plantResult.reason || null,
      } : null,
      fertilizerResult: ownFarm && ownFarm.fertilizerResult ? {
        ok: ownFarm.fertilizerResult.ok === true,
        skipped: ownFarm.fertilizerResult.skipped === true,
        executedMode: ownFarm.fertilizerResult.executedMode || null,
        reason: ownFarm.fertilizerResult.reason || null,
      } : null,
    };
  }

  function summarizeFriendStealModule(friendSteal) {
    const visits = Array.isArray(friendSteal && friendSteal.visits) ? friendSteal.visits : [];
    return {
      module: "friend_patrol",
      action: friendSteal && friendSteal.action ? friendSteal.action : "run",
      ok: friendSteal && friendSteal.ok === true,
      helpEnabled: friendSteal && friendSteal.helpEnabled === true,
      helpLimitReached: friendSteal && friendSteal.helpLimitReached === true,
      visitCount: visits.length,
      visitResults: visits.map((visit) => ({
        module: visit && visit.module ? visit.module : "friend_visit",
        action: visit && visit.action ? visit.action : null,
        ok: visit && visit.ok === true,
        friendGid: visit && visit.friend && visit.friend.gid != null ? Number(visit.friend.gid) || null : null,
        reason: visit && visit.reason ? visit.reason : null,
        helpSkipReason: visit && visit.helpSkipReason ? visit.helpSkipReason : null,
        helpTracked: visit && visit.helpTracked ? {
          helpCount: Number(visit.helpTracked.helpCount) || 0,
          dailyLimit: Number(visit.helpTracked.dailyLimit) || 0,
          limitReached: visit.helpTracked.limitReached === true,
        } : null,
        blacklistDecision: visit && visit.blacklistDecision ? {
          enabled: visit.blacklistDecision.enabled === true,
          strategy: Number(visit.blacklistDecision.strategy) === 2 ? 2 : 1,
          hit: visit.blacklistDecision.hit === true,
          reason: visit.blacklistDecision.reason || null,
          action: visit.blacklistDecision.action || null,
        } : null,
      })),
      blacklistPolicy: friendSteal && friendSteal.blacklistPolicy ? {
        enabled: friendSteal.blacklistPolicy.enabled === true,
        strategy: Number(friendSteal.blacklistPolicy.strategy) === 2 ? 2 : 1,
        strategyLabel: friendSteal.blacklistPolicy.strategyLabel || null,
        blacklistedPlantIds: Array.isArray(friendSteal.blacklistPolicy.blacklistedPlantIds)
          ? [...friendSteal.blacklistPolicy.blacklistedPlantIds]
          : [],
        decision: friendSteal.blacklistPolicy.decision || null,
      } : null,
    };
  }

  try {
    payload.initialOwnership = await getFarmOwnership(session, callGameCtl, { allowWeakUi: true });
  } catch (_) {
    payload.initialOwnership = null;
  }

  throwIfAutomationStopped(opts);
  if (ownFarmEnabled) {
    payload.ownFarm = await runOwnFarmAutomation(session, callGameCtl, {
      includeCollect: opts.includeCollect !== false,
      includeWater: opts.includeWater !== false,
      includeEraseGrass: opts.includeEraseGrass !== false,
      includeKillBug: opts.includeKillBug !== false,
      autoPlantMode: opts.autoPlantMode || "none",
      autoPlantPrimaryMode: opts.autoPlantPrimaryMode || opts.autoPlantMode || "none",
      autoPlantSecondaryMode: opts.autoPlantSecondaryMode || "none",
      autoPlantSeedId: opts.autoPlantSeedId,
      autoPlantBackpackSeedPriority: Array.isArray(opts.autoPlantBackpackSeedPriority)
        ? [...opts.autoPlantBackpackSeedPriority]
        : [],
      autoPlantBackpackForcePriority: opts.autoPlantBackpackForcePriority === true,
      autoPlantMaxLevel: opts.autoPlantMaxLevel,
      autoFertilizerEnabled: opts.autoFertilizerEnabled === true,
      autoFertilizerMode: opts.autoFertilizerMode || "none",
      autoFertilizerMultiSeason: opts.autoFertilizerMultiSeason === true,
      autoFertilizerLandTypes: Array.isArray(opts.autoFertilizerLandTypes)
        ? [...opts.autoFertilizerLandTypes]
        : ["gold", "black", "red", "normal"],
      autoFertilizerRushThresholdSec: opts.autoFertilizerRushThresholdSec,
      autoFertilizerState: opts.autoFertilizerState,
      enterWaitMs: opts.enterWaitMs,
      actionWaitMs: opts.actionWaitMs,
      stopOnError: !!opts.stopOnError,
      runContext: opts.runContext,
    });
  }

  throwIfAutomationStopped(opts);
  if (friendPatrolEnabled) {
    payload.friendSteal = await runFriendStealAutomation(session, callGameCtl, {
      friendStealEnabled,
      friendHelpEnabled,
      friendHelpDailyLimit: opts.friendHelpDailyLimit,
      friendHelpState: opts.friendHelpState,
      refresh: opts.refreshFriendList !== false,
      maxFriends: opts.maxFriends,
      enterWaitMs: opts.enterWaitMs,
      actionWaitMs: opts.actionWaitMs,
      returnHome: opts.returnHome !== false,
      friendQuietHoursEnabled: opts.friendQuietHoursEnabled === true,
      friendQuietHoursStart: opts.friendQuietHoursStart || "23:00",
      friendQuietHoursEnd: opts.friendQuietHoursEnd || "07:00",
      friendBlockMaskedStealers: opts.friendBlockMaskedStealers !== false,
      friendBlacklist: Array.isArray(opts.friendBlacklist) ? opts.friendBlacklist : [],
      friendVisitCooldowns: Array.isArray(opts.friendVisitCooldowns) ? opts.friendVisitCooldowns : [],
      friendStealPlantBlacklistEnabled: opts.friendStealPlantBlacklistEnabled === true,
      friendStealPlantBlacklistStrategy: opts.friendStealPlantBlacklistStrategy,
      friendStealPlantBlacklist: Array.isArray(opts.friendStealPlantBlacklist) ? opts.friendStealPlantBlacklist : [],
      stopOnError: !!opts.stopOnError,
      runContext: opts.runContext,
    });
  }

  throwIfAutomationStopped(opts);
  try {
    payload.finalOwnership = await getFarmOwnership(session, callGameCtl, { allowWeakUi: true });
  } catch (_) {
    payload.finalOwnership = null;
  }

  payload.finishedAt = new Date().toISOString();
  payload.modules.push({
    module: "schedule",
    action: "run_cycle",
    ok: true,
    startedAt,
    finishedAt: payload.finishedAt,
    ownFarmEnabled,
    friendStealEnabled: friendPatrolEnabled,
    friendHelpEnabled,
  });
  payload.modules.push(ownFarmEnabled
    ? summarizeOwnFarmModule(payload.ownFarm)
    : { module: "own_farm", action: "skip", ok: true, skipped: true, reason: "disabled" });
  payload.modules.push(friendPatrolEnabled
    ? summarizeFriendStealModule(payload.friendSteal)
    : { module: "friend_patrol", action: "skip", ok: true, skipped: true, reason: "disabled" });
  payload.trace = {
    schedule: {
      startedAt,
      finishedAt: payload.finishedAt,
      ownFarmEnabled,
      friendStealEnabled: friendPatrolEnabled,
      friendHelpEnabled,
      due: {
        own: ownFarmEnabled,
        friend: friendPatrolEnabled,
      },
    },
    modules: payload.modules,
  };
  return payload;
}

module.exports = {
  runAutoFarmCycle,
};
