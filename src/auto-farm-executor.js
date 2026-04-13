"use strict";

const { filterAnalyticsByLevel, getPlantAnalyticsList, pickBestPlantByMode, sortAnalyticsList } = require("./plant-analytics");
const { getProfilePlantLevel, resolveProfileWithCandidates } = require("./player-profile-resolver");
const { getPlantById, getPlantByFruitId, getPlantBySeedId } = require("./game-config");

function wait(ms) {
  const delayMs = Math.max(0, Number(ms) || 0);
  return new Promise((resolve) => setTimeout(resolve, delayMs));
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

function collectEmptyLandIds(status) {
  const grids = Array.isArray(status && status.grids) ? status.grids : [];
  const emptyLandIds = [];
  for (let i = 0; i < grids.length; i += 1) {
    const grid = grids[i];
    const landId = Number(grid && grid.landId);
    if (!Number.isFinite(landId) || landId <= 0) continue;
    if (grid && grid.stageKind === "empty") {
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

function toErrorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function withSilent(opts, extra) {
  const base = opts && typeof opts === "object" ? { ...opts } : {};
  return { ...base, ...(extra && typeof extra === "object" ? extra : {}), silent: true };
}

async function getFarmOwnership(session, callGameCtl, opts) {
  return await callGameCtl(session, "gameCtl.getFarmOwnership", [withSilent(opts)]);
}

async function getFarmStatus(session, callGameCtl, opts) {
  return await callGameCtl(session, "gameCtl.getFarmStatus", [withSilent(opts)]);
}

async function getFriendList(session, callGameCtl, opts) {
  return await callGameCtl(session, "gameCtl.getFriendList", [withSilent(opts, { waitRefresh: true })]);
}

async function enterOwnFarm(session, callGameCtl, opts) {
  return await callGameCtl(session, "gameCtl.enterOwnFarm", [withSilent(opts)]);
}

async function enterFriendFarm(session, callGameCtl, target, opts) {
  return await callGameCtl(session, "gameCtl.enterFriendFarm", [target, withSilent(opts)]);
}

async function triggerOneClickOperation(session, callGameCtl, typeOrIndex, opts) {
  return await callGameCtl(session, "gameCtl.triggerOneClickOperation", [typeOrIndex, withSilent(opts)]);
}

async function fertilizeLand(session, callGameCtl, opts) {
  return await callGameCtl(session, "gameCtl.fertilizeLand", [withSilent(opts)]);
}

async function clickMatureEffect(session, callGameCtl, landId, opts) {
  return await callGameCtl(session, "gameCtl.clickMatureEffect", [
    landId,
    withSilent(opts),
  ]);
}

function normalizeFertilizerLandType(value) {
  const text = String(value == null ? "" : value).trim().toLowerCase();
  if (["gold", "black", "red", "normal"].includes(text)) return text;
  return "normal";
}

function shouldRunNormalFertilizer(opts) {
  if (!opts || opts.autoFertilizerEnabled !== true) return false;
  const mode = String(opts.autoFertilizerMode || "none").trim().toLowerCase();
  return mode === "normal" || mode === "both";
}

function canUseNormalFertilizerOnGrid(grid, opts) {
  if (!grid || typeof grid !== "object") return false;
  if (grid.stageKind !== "growing") return false;
  const landId = Number(grid.landId);
  if (!Number.isFinite(landId) || landId <= 0) return false;
  const matureInSec = Number(grid.matureInSec);
  if (!Number.isFinite(matureInSec) || matureInSec <= 5) return false;
  const allowedLandTypes = Array.isArray(opts && opts.autoFertilizerLandTypes)
    ? opts.autoFertilizerLandTypes.map(normalizeFertilizerLandType)
    : ["gold", "black", "red", "normal"];
  const landType = normalizeFertilizerLandType(grid.landType);
  if (allowedLandTypes.length > 0 && !allowedLandTypes.includes(landType)) return false;
  const totalSeason = Math.max(1, Number(grid.totalSeason) || 1);
  if (totalSeason > 1 && !(opts && opts.autoFertilizerMultiSeason === true)) return false;
  return true;
}

async function runOwnFarmNormalFertilizerTasks(session, callGameCtl, opts) {
  const mode = String(opts && opts.autoFertilizerMode || "none").trim().toLowerCase();
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
  if (!shouldRunNormalFertilizer(opts)) {
    return {
      ok: true,
      skipped: true,
      reason: "mode_not_supported_yet",
      requestedMode: mode,
      executedMode: "none",
      candidateCount: 0,
      actions: [],
    };
  }

  const actionWaitMs = Math.max(0, Number(opts && opts.actionWaitMs) || 0);
  const fertilizeWaitAfterOpen = Math.max(200, Number(opts && opts.fertilizeWaitAfterOpen) || 700);
  const fertilizeWaitAfterAction = Math.max(200, Number(opts && opts.fertilizeWaitAfterAction) || 800);
  const statusBefore = await getFarmStatus(session, callGameCtl, {
    includeGrids: true,
    includeLandIds: false,
  });
  const allGrids = Array.isArray(statusBefore && statusBefore.grids) ? statusBefore.grids : [];
  const candidates = allGrids.filter((grid) => canUseNormalFertilizerOnGrid(grid, opts));
  const actions = [];

  async function runFertilizeAttempt(landId, dryRun) {
    return await fertilizeLand(session, callGameCtl, {
      landId,
      type: "normal",
      dryRun: dryRun !== false,
      waitAfterOpen: fertilizeWaitAfterOpen,
      waitAfterAction: fertilizeWaitAfterAction,
    });
  }

  for (let i = 0; i < candidates.length; i += 1) {
    const grid = candidates[i];
    const landId = Number(grid.landId);
    try {
      let dryRun = await runFertilizeAttempt(landId, true);
      if (!dryRun || dryRun.ok !== true) {
        const reason = dryRun && dryRun.reason;
        if (reason === "action_panel_not_ready" || reason === "action_node_missing") {
          await wait(300);
          dryRun = await runFertilizeAttempt(landId, true);
        }
      }
      if (!dryRun || dryRun.ok !== true) {
        actions.push({
          ok: false,
          landId,
          stageKind: grid.stageKind || null,
          landType: normalizeFertilizerLandType(grid.landType),
          reason: "dry_run_failed",
          dryRun,
        });
        if (opts && opts.stopOnError) break;
        continue;
      }

      const result = await runFertilizeAttempt(landId, false);
      const delta = Number(result && result.deltaMatureInSec);
      const success = Number.isFinite(delta) && delta < -5;
      actions.push({
        ok: success,
        landId,
        stageKind: grid.stageKind || null,
        landType: normalizeFertilizerLandType(grid.landType),
        beforeMatureInSec: Number(grid.matureInSec) || null,
        afterMatureInSec: result && result.after ? Number(result.after.matureInSec) || null : null,
        deltaMatureInSec: Number.isFinite(delta) ? delta : null,
        result,
      });
      if (!success && opts && opts.stopOnError) break;
    } catch (error) {
      actions.push({
        ok: false,
        landId,
        stageKind: grid.stageKind || null,
        landType: normalizeFertilizerLandType(grid.landType),
        error: toErrorMessage(error),
      });
      if (opts && opts.stopOnError) break;
    }

    if (actionWaitMs > 0 && i < candidates.length - 1) {
      await wait(actionWaitMs);
    }
  }

  const statusAfter = await getFarmStatus(session, callGameCtl, {
    includeGrids: true,
    includeLandIds: false,
  });
  const successCount = actions.filter((item) => item && item.ok === true).length;
  const failureCount = actions.filter((item) => item && item.ok === false).length;

  return {
    ok: failureCount === 0,
    skipped: false,
    requestedMode: mode,
    executedMode: mode === "both" ? "normal" : mode,
    degraded: mode === "both",
    candidateCount: candidates.length,
    successCount,
    failureCount,
    before: summarizeFarmStatus(statusBefore),
    after: summarizeFarmStatus(statusAfter),
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
      await wait(actionWaitMs);
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
  const statusBefore = await getFarmStatus(session, callGameCtl, {
    includeGrids: false,
    includeLandIds: false,
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
    const spec = specs[i];
    const beforeCount = getWorkCount(currentStatus, spec.key);
    if (beforeCount <= 0) {
      if (spec.key === "collect" && (!opts || opts.includeSpecialCollect !== false)) {
        try {
          specialCollect = await runSupplementalMatureEffectHarvest(session, callGameCtl, {
            actionWaitMs,
            timeoutMs: opts && opts.timeoutMs,
            pollMs: opts && opts.pollMs,
            stopOnError: !!(opts && opts.stopOnError),
          });
          if (specialCollect.candidateCount > 0) {
            currentStatus = await getFarmStatus(session, callGameCtl, {
              includeGrids: false,
              includeLandIds: false,
            });
          }
        } catch (error) {
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
        await wait(actionWaitMs);
      }
      currentStatus = await getFarmStatus(session, callGameCtl, {
        includeGrids: false,
        includeLandIds: false,
      });
      const afterCount = getWorkCount(currentStatus, spec.key);
      actions.push({
        ok: true,
        key: spec.key,
        op: spec.op,
        beforeCount,
        afterCount,
        trigger,
      });
      if (spec.key === "collect" && (!opts || opts.includeSpecialCollect !== false)) {
        try {
          specialCollect = await runSupplementalMatureEffectHarvest(session, callGameCtl, {
            actionWaitMs,
            timeoutMs: opts && opts.timeoutMs,
            pollMs: opts && opts.pollMs,
            stopOnError: !!(opts && opts.stopOnError),
          });
          if (specialCollect.candidateCount > 0) {
            currentStatus = await getFarmStatus(session, callGameCtl, {
              includeGrids: false,
              includeLandIds: false,
            });
          }
        } catch (error) {
          specialCollect = {
            ok: false,
            error: toErrorMessage(error),
          };
          if (opts && opts.stopOnError) break;
        }
      }
    } catch (error) {
      actions.push({
        ok: false,
        key: spec.key,
        op: spec.op,
        beforeCount,
        error: toErrorMessage(error),
      });
      if (spec.key === "collect" && (!opts || opts.includeSpecialCollect !== false) && (!opts || !opts.stopOnError)) {
        try {
          specialCollect = await runSupplementalMatureEffectHarvest(session, callGameCtl, {
            actionWaitMs,
            timeoutMs: opts && opts.timeoutMs,
            pollMs: opts && opts.pollMs,
            stopOnError: false,
          });
          if (specialCollect.candidateCount > 0) {
            currentStatus = await getFarmStatus(session, callGameCtl, {
              includeGrids: false,
              includeLandIds: false,
            });
          }
        } catch (supplementError) {
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
  const profile = await callGameCtl(session, "gameCtl.getPlayerProfile", [withSilent({})]);
  const candidates = await callGameCtl(session, "gameCtl.scanSystemAccountCandidates", [withSilent({ limit: 20 })]);
  return resolveProfileWithCandidates(profile, candidates).profile;
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
      const availableBackpackSeed = (Array.isArray(seedList) ? seedList : [])
        .find((item) => (Number(item && item.count) || 0) > 0);
      if (availableBackpackSeed) {
        const selectedSeedId = Number(availableBackpackSeed.seedId || availableBackpackSeed.itemId) || 0;
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
          decision: buildDecisionEntry(mode, "resolved", {
            reason: "backpack_seed_available",
            selectedSeedId: selectedSeedId || null,
            selectedSeedName: availableBackpackSeed.name || (selectedPlant && selectedPlant.name) || null,
            selectedPlantId: selectedPlant ? (Number(selectedPlant.id) || null) : null,
            source: "backpack",
            backpackCount: Number(availableBackpackSeed.count) || 0,
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

async function runOwnFarmAutomation(session, callGameCtl, opts) {
  const enterWaitMs = Math.max(0, Number(opts && opts.enterWaitMs) || 0);
  const actionWaitMs = Math.max(0, Number(opts && opts.actionWaitMs) || 0);
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
    includeCollect: !opts || opts.includeCollect !== false,
    includeWater: !opts || opts.includeWater !== false,
    includeEraseGrass: !opts || opts.includeEraseGrass !== false,
    includeKillBug: !opts || opts.includeKillBug !== false,
    actionWaitMs: opts && opts.actionWaitMs,
    stopOnError: !!(opts && opts.stopOnError),
  });

  // 自动种植
  const plantPrimaryMode = opts && (opts.autoPlantPrimaryMode || opts.autoPlantMode) ? (opts.autoPlantPrimaryMode || opts.autoPlantMode) : "none";
  const plantSecondaryMode = opts && opts.autoPlantSecondaryMode ? opts.autoPlantSecondaryMode : "none";
  let plantResult = null;
  if (plantPrimaryMode !== "none" || plantSecondaryMode !== "none") {
    try {
      if (actionWaitMs > 0) {
        await wait(actionWaitMs);
      }
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
      plantResult = { ok: false, error: toErrorMessage(error) };
    }
  }

  let fertilizerResult = null;
  if (shouldRunNormalFertilizer(opts || {})) {
    try {
      if (actionWaitMs > 0) {
        await wait(actionWaitMs);
      }
      fertilizerResult = await runOwnFarmNormalFertilizerTasks(session, callGameCtl, opts || {});
    } catch (error) {
      fertilizerResult = { ok: false, error: toErrorMessage(error) };
    }
  } else if (opts && opts.autoFertilizerEnabled === true) {
    const requestedMode = String(opts.autoFertilizerMode || "none").trim().toLowerCase();
    fertilizerResult = {
      ok: true,
      skipped: true,
      requestedMode,
      reason: requestedMode === "organic"
        ? "organic_not_implemented_yet"
        : "mode_not_supported_yet",
    };
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
      maskedBlockedEnabled: !!(opts && opts.friendBlockMaskedStealers === true),
      stealPlantBlacklistEnabled,
      stealPlantBlacklist,
      cooldownFriends: [],
      visits: [],
      returnHome: null,
    };
  }
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
  const candidates = selectableFriends
    .filter((item) => item && item.workCounts && (Number(item.workCounts.collect) || 0) > 0)
    .sort((a, b) => {
      const diff = (Number(b && b.workCounts && b.workCounts.collect) || 0)
        - (Number(a && a.workCounts && a.workCounts.collect) || 0);
      if (diff !== 0) return diff;
      return (Number(a && a.rank) || 0) - (Number(b && b.rank) || 0);
    })
    .slice(0, maxFriends);
  const visits = [];

  for (let i = 0; i < candidates.length; i += 1) {
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
      if (collectBefore <= 0) {
        visits.push({
          ok: true,
          module: "friend_visit",
          action: "inspect",
          friend,
          enter,
          reason: "no_collectable_after_enter",
          before: summarizeFarmStatus(beforeStatus),
          after: summarizeFarmStatus(beforeStatus),
        });
        continue;
      }

      let trigger = null;
      let selective = null;
      let visitAction = "one_click_harvest";
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
      if (stealPlantBlacklistEnabled && stealPlantBlacklist.length > 0) {
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
          visitAction = "skip";
          visits.push({
            ok: true,
            module: "friend_visit",
            action: "skip",
            friend,
            enter,
            reason: "blacklist_strategy_skip_whole_farm",
            before: summarizeFarmStatus(beforeStatus),
            after: summarizeFarmStatus(beforeStatus),
            collectBefore,
            collectAfter: collectBefore,
            selective,
            blacklistDecision,
          });
          continue;
        }
        if (hasBlacklistedTargets && allowedLandIds.length <= 0) {
          visitAction = "skip";
          visits.push({
            ok: true,
            module: "friend_visit",
            action: "skip",
            friend,
            enter,
            reason: "all_collectable_blacklisted",
            before: summarizeFarmStatus(beforeStatus),
            after: summarizeFarmStatus(beforeStatus),
            collectBefore,
            collectAfter: collectBefore,
            selective,
            blacklistDecision,
          });
          continue;
        }
        if (hasBlacklistedTargets) {
          visitAction = "targeted_harvest";
          const actions = [];
          for (let j = 0; j < allowedLandIds.length; j += 1) {
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
              await wait(actionWaitMs);
            }
          }
          trigger = { op: "TARGETED_HARVEST", actions };
        } else {
          trigger = await triggerOneClickOperation(session, callGameCtl, "HARVEST", {
            includeBefore: false,
            includeAfter: false,
          });
          if (actionWaitMs > 0) {
            await wait(actionWaitMs);
          }
        }
      } else {
        visitAction = "one_click_harvest";
        trigger = await triggerOneClickOperation(session, callGameCtl, "HARVEST", {
          includeBefore: false,
          includeAfter: false,
        });
        if (actionWaitMs > 0) {
          await wait(actionWaitMs);
        }
      }
      const afterStatus = await getFarmStatus(session, callGameCtl, {
        includeGrids: false,
        includeLandIds: false,
      });
      const collectAfter = getWorkCount(afterStatus, "collect");
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
        selective,
        blacklistDecision,
      });
    } catch (error) {
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
    try {
      returnHome = await enterOwnFarm(session, callGameCtl, {
        waitMs: enterWaitMs,
        includeAfterOwnership: true,
      });
    } catch (error) {
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
    stealableCandidates: candidates.length,
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
  const startedAt = new Date().toISOString();
  const ownFarmEnabled = opts.ownFarmEnabled !== false;
  const friendStealEnabled = !!opts.friendStealEnabled;
  const payload = {
    ok: true,
    startedAt,
    ownFarmEnabled,
    friendStealEnabled,
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
      action: "run",
      ok: ownFarm && ownFarm.ok === true,
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
      visitCount: visits.length,
      visitResults: visits.map((visit) => ({
        module: visit && visit.module ? visit.module : "friend_visit",
        action: visit && visit.action ? visit.action : null,
        ok: visit && visit.ok === true,
        friendGid: visit && visit.friend && visit.friend.gid != null ? Number(visit.friend.gid) || null : null,
        reason: visit && visit.reason ? visit.reason : null,
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
      autoPlantMaxLevel: opts.autoPlantMaxLevel,
      autoFertilizerEnabled: opts.autoFertilizerEnabled === true,
      autoFertilizerMode: opts.autoFertilizerMode || "none",
      autoFertilizerMultiSeason: opts.autoFertilizerMultiSeason === true,
      autoFertilizerLandTypes: Array.isArray(opts.autoFertilizerLandTypes)
        ? [...opts.autoFertilizerLandTypes]
        : ["gold", "black", "red", "normal"],
      enterWaitMs: opts.enterWaitMs,
      actionWaitMs: opts.actionWaitMs,
      stopOnError: !!opts.stopOnError,
    });
  }

  if (friendStealEnabled) {
    payload.friendSteal = await runFriendStealAutomation(session, callGameCtl, {
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
    });
  }

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
    friendStealEnabled,
  });
  payload.modules.push(ownFarmEnabled
    ? summarizeOwnFarmModule(payload.ownFarm)
    : { module: "own_farm", action: "skip", ok: true, skipped: true, reason: "disabled" });
  payload.modules.push(friendStealEnabled
    ? summarizeFriendStealModule(payload.friendSteal)
    : { module: "friend_patrol", action: "skip", ok: true, skipped: true, reason: "disabled" });
  payload.trace = {
    schedule: {
      startedAt,
      finishedAt: payload.finishedAt,
      ownFarmEnabled,
      friendStealEnabled,
      due: {
        own: ownFarmEnabled,
        friend: friendStealEnabled,
      },
    },
    modules: payload.modules,
  };
  return payload;
}

module.exports = {
  runAutoFarmCycle,
};
