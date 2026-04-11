"use strict";

const { ensureGameCtl, callGameCtl } = require("./game-ctl-utils");
const { runAutoFarmCycle } = require("./auto-farm-executor");

const AUTO_FARM_RECENT_EVENT_LIMIT = 400;

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
  if (["none", "normal", "organic", "both"].includes(mode)) {
    return mode;
  }
  return defaultValue;
}

function toFertilizerBuyType(value, defaultValue) {
  const mode = String(value == null ? "" : value).trim().toLowerCase();
  if (!mode) return defaultValue;
  if (mode === "inorganic") return "normal";
  if (["organic", "normal", "both"].includes(mode)) {
    return mode;
  }
  return defaultValue;
}

function toFertilizerBuyMode(value, defaultValue) {
  const mode = String(value == null ? "" : value).trim().toLowerCase();
  if (!mode) return defaultValue;
  if (["threshold", "unlimited"].includes(mode)) {
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

function normalizeAutoFarmConfig(raw) {
  const src = raw && typeof raw === "object" ? raw : {};
  return {
    autoFarmOwnEnabled: toBool(src.autoFarmOwnEnabled, true),
    autoFarmFriendEnabled: toBool(src.autoFarmFriendEnabled, false),
    autoFarmOwnIntervalSec: toInt(src.autoFarmOwnIntervalSec, 30, 5, 3600),
    autoFarmFriendIntervalSec: toInt(src.autoFarmFriendIntervalSec, 90, 10, 3600),
    autoFarmMaxFriends: toInt(src.autoFarmMaxFriends, 5, 1, 50),
    autoFarmEnterWaitMs: toInt(src.autoFarmEnterWaitMs, 1800, 0, 15000),
    autoFarmActionWaitMs: toInt(src.autoFarmActionWaitMs, 1200, 0, 10000),
    autoFarmRefreshFriendList: toBool(src.autoFarmRefreshFriendList, true),
    autoFarmReturnHome: toBool(src.autoFarmReturnHome, true),
    autoFarmStopOnError: toBool(src.autoFarmStopOnError, false),
    autoFarmPlantMode: toPlantMode(src.autoFarmPlantMode, "none"),
    autoFarmPlantPrimaryMode: toPlantMode(src.autoFarmPlantPrimaryMode ?? src.autoFarmPlantMode, "none"),
    autoFarmPlantSecondaryMode: toPlantMode(src.autoFarmPlantSecondaryMode, "none"),
    autoFarmPlantSeedId: toInt(src.autoFarmPlantSeedId, 0, 0, 99999999),
    autoFarmPlantMaxLevel: toInt(src.autoFarmPlantMaxLevel, 0, 0, 999),
    autoFarmFertilizerEnabled: toBool(src.autoFarmFertilizerEnabled, false),
    autoFarmFertilizerMode: toFertilizerMode(src.autoFarmFertilizerMode, "none"),
    autoFarmFertilizerMultiSeason: toBool(src.autoFarmFertilizerMultiSeason, false),
    autoFarmFertilizerLandTypes: normalizeFertilizerLandTypes(src.autoFarmFertilizerLandTypes),
    autoFarmFertilizerGift: toBool(src.autoFarmFertilizerGift, false),
    autoFarmFertilizerBuy: toBool(src.autoFarmFertilizerBuy, false),
    autoFarmFertilizerBuyType: toFertilizerBuyType(src.autoFarmFertilizerBuyType, "organic"),
    autoFarmFertilizerBuyMax: toInt(src.autoFarmFertilizerBuyMax, 10, 1, 10),
    autoFarmFertilizerBuyMode: toFertilizerBuyMode(src.autoFarmFertilizerBuyMode, "threshold"),
    autoFarmFertilizerBuyThreshold: toInt(src.autoFarmFertilizerBuyThreshold, 100, 0, 999999),
    autoFarmFriendQuietHoursEnabled: toBool(src.autoFarmFriendQuietHoursEnabled, false),
    autoFarmFriendQuietHoursStart: normalizeClockText(src.autoFarmFriendQuietHoursStart, "23:00"),
    autoFarmFriendQuietHoursEnd: normalizeClockText(src.autoFarmFriendQuietHoursEnd, "07:00"),
    autoFarmFriendBlockMaskedStealers: toBool(src.autoFarmFriendBlockMaskedStealers, true),
    autoFarmFriendBlacklist: normalizeStringList(src.autoFarmFriendBlacklist),
    autoFarmFriendStealPlantBlacklistEnabled: toBool(src.autoFarmFriendStealPlantBlacklistEnabled, false),
    autoFarmFriendStealPlantBlacklistStrategy: toInt(src.autoFarmFriendStealPlantBlacklistStrategy, 1, 1, 2),
    autoFarmFriendStealPlantBlacklist: normalizePositiveIntList(src.autoFarmFriendStealPlantBlacklist),
  };
}

function getTodayKey(now) {
  const date = now instanceof Date ? now : new Date(now || Date.now());
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function createEmptyTodayStats(dateKey) {
  return {
    dateKey: dateKey || getTodayKey(),
    collect: 0,
    water: 0,
    eraseGrass: 0,
    killBug: 0,
    fertilize: 0,
    plant: 0,
    steal: 0,
    helpWater: 0,
    helpEraseGrass: 0,
    helpKillBug: 0,
    task: 0,
    sell: 0,
    runs: 0,
    ownRuns: 0,
    friendRuns: 0,
  };
}

function normalizeDelta(before, after) {
  const beforeNum = Number(before);
  const afterNum = Number(after);
  if (!Number.isFinite(beforeNum) || !Number.isFinite(afterNum)) return 0;
  return Math.max(0, beforeNum - afterNum);
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
  }

  const friendSteal = result.friendSteal && typeof result.friendSteal === "object" ? result.friendSteal : null;
  const visits = Array.isArray(friendSteal && friendSteal.visits) ? friendSteal.visits : [];
  visits.forEach((visit) => {
    if (!visit || visit.ok !== true) return;
    target.steal += normalizeDelta(visit.collectBefore, visit.collectAfter);
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
  if (visit.reason === "all_collectable_blacklisted") {
    return { ms: FRIEND_BLACKLIST_ONLY_COOLDOWN_MS, reason: "all_collectable_blacklisted" };
  }
  if (visit.reason === "blacklist_strategy_skip_whole_farm") {
    return { ms: FRIEND_BLACKLIST_ONLY_COOLDOWN_MS, reason: "blacklist_strategy_skip_whole_farm" };
  }
  if (visit.ok === true && Number(visit.collectBefore) > 0 && Number(visit.collectAfter) >= Number(visit.collectBefore)) {
    return { ms: FRIEND_VISIT_COOLDOWN_MS, reason: "no_progress_after_visit" };
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

function formatAutoFarmIdList(list, limit) {
  const rows = Array.isArray(list) ? list : [];
  const max = Math.max(1, Number(limit) || 6);
  const ids = rows
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value) && value > 0);
  if (ids.length <= max) return ids.join(",");
  return ids.slice(0, max).join(",") + ` 等${ids.length}块`;
}

function buildAutoFarmCycleLogMessages({ due, injectState, result, cooldownApplied }) {
  const messages = [];
  const ownEnabled = !!(due && due.ownDue);
  const friendEnabled = !!(due && due.friendDue);
  const ownFarm = result && result.ownFarm && typeof result.ownFarm === "object" ? result.ownFarm : null;
  const friendSteal = result && result.friendSteal && typeof result.friendSteal === "object" ? result.friendSteal : null;

  messages.push({
    level: "info",
    message: `自动农场 / 开始调度：自己农场=${ownEnabled ? "执行" : "跳过"}，好友巡检=${friendEnabled ? "执行" : "跳过"}${injectState && injectState.injected ? "，已自动注入脚本" : ""}`,
  });

  if (ownEnabled) {
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
        if (action.ok) {
          messages.push({
            level: "info",
            message: `自动农场 / 自己农场 / ${label}：${Number(action.beforeCount) || 0} → ${Number(action.afterCount) || 0}`,
          });
        } else {
          messages.push({
            level: "warn",
            message: `自动农场 / 自己农场 / ${label}：失败 ${action.error || action.reason || "unknown"}`,
          });
        }
      });

      const specialCollect = ownFarm.tasks.specialCollect;
      if (specialCollect && (specialCollect.candidateCount > 0 || specialCollect.ok === false)) {
        if (specialCollect.ok === false) {
          messages.push({
            level: "warn",
            message: `自动农场 / 自己农场 / 补充逐块收取：失败 ${specialCollect.error || "unknown"}`,
          });
        } else {
          const successCount = Array.isArray(specialCollect.actions)
            ? specialCollect.actions.filter((item) => item && item.ok === true).length
            : 0;
          messages.push({
            level: "info",
            message: `自动农场 / 自己农场 / 补充逐块收取：候选 ${Number(specialCollect.candidateCount) || 0} 块，成功 ${successCount} 块，剩余 ${Number(specialCollect.remainingCount) || 0} 块`,
          });
        }
      }
    }

    const plantResult = ownFarm && ownFarm.plantResult && typeof ownFarm.plantResult === "object" ? ownFarm.plantResult : null;
    if (plantResult) {
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
        const nested = plantResult.plantResult && typeof plantResult.plantResult === "object" ? plantResult.plantResult : null;
        const plantedCount = Number(nested && nested.plantedCount != null ? nested.plantedCount : plantResult.emptyCount) || 0;
        const landIds = nested && Array.isArray(nested.beforeEmptyIds) ? nested.beforeEmptyIds : [];
        const parts = [];
        parts.push(formatAutoFarmPlantModeLabel(plantResult.resolvedMode || plantResult.mode));
        parts.push("成功种植 " + (plantResult.seedName || plantResult.seedId || "unknown"));
        parts.push("x" + plantedCount);
        if (landIds.length > 0) parts.push("地块 " + formatAutoFarmIdList(landIds, 8));
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
        const nested = plantResult.plantResult && typeof plantResult.plantResult === "object" ? plantResult.plantResult : null;
        const attempts = Array.isArray(nested && nested.attempts) ? nested.attempts : [];
        attempts.forEach((attempt, index) => {
          if (!attempt) return;
          messages.push({
            level: attempt.ok ? "info" : "warn",
            message: `自动农场 / 自己农场 / 自动种植尝试：第${index + 1}次 候选 ${attempt.candidateSeedId || "unknown"} · 已种 ${Number(attempt.plantedCount) || 0}${attempt.dispatchError ? (" · 失败 " + attempt.dispatchError) : ""}`,
          });
        });
        messages.push({
          level: "warn",
          message: `自动农场 / 自己农场 / 自动种植：失败 ${plantResult.reason || plantResult.error || "unknown"}`,
        });
      }
    }

    const fertilizerResult = ownFarm && ownFarm.fertilizerResult && typeof ownFarm.fertilizerResult === "object" ? ownFarm.fertilizerResult : null;
    if (fertilizerResult) {
      if (fertilizerResult.skipped) {
        messages.push({
          level: "info",
          message: `自动农场 / 自己农场 / 自动施肥：跳过 ${fertilizerResult.reason || fertilizerResult.executedMode || "unknown"}`,
        });
      } else if (fertilizerResult.ok) {
        messages.push({
          level: "info",
          message: `自动农场 / 自己农场 / 自动施肥：成功 ${Number(fertilizerResult.successCount) || 0} 块，失败 ${Number(fertilizerResult.failureCount) || 0} 块`,
        });
      } else {
        messages.push({
          level: "warn",
          message: `自动农场 / 自己农场 / 自动施肥：失败 ${fertilizerResult.error || fertilizerResult.reason || "unknown"}`,
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

  if (friendEnabled && friendSteal) {
    if (friendSteal.skipped && friendSteal.skipReason === "quiet_hours") {
      messages.push({
        level: "info",
        message: `自动农场 / 好友巡检：静默时段暂停 (${friendSteal.quietHours && friendSteal.quietHours.start ? friendSteal.quietHours.start : "--:--"} - ${friendSteal.quietHours && friendSteal.quietHours.end ? friendSteal.quietHours.end : "--:--"})`,
      });
    } else {
      const parts = [];
      parts.push("候选 " + (Number(friendSteal.totalCandidates) || 0));
      parts.push("可偷 " + (Number(friendSteal.stealableCandidates) || 0));
      if (friendSteal.blacklistPolicy && friendSteal.blacklistPolicy.enabled) {
        parts.push(friendSteal.blacklistPolicy.strategyLabel || "黑名单策略");
      }
      if ((Number(friendSteal.explicitBlacklistedCount) || 0) > 0) {
        parts.push("手动黑名单 " + friendSteal.explicitBlacklistedCount);
      }
      if ((Number(friendSteal.maskedBlockedCount) || 0) > 0) {
        parts.push("蒙面屏蔽 " + friendSteal.maskedBlockedCount);
      }
      if ((Number(friendSteal.cooldownBlockedCount) || 0) > 0) {
        parts.push("冷却中 " + friendSteal.cooldownBlockedCount);
      }
      messages.push({
        level: "info",
        message: `自动农场 / 好友巡检：${parts.join(" · ")}`,
      });
      if ((Number(friendSteal.stealableCandidates) || 0) <= 0) {
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
      if (visit.collectBefore != null) {
        messages.push({
          level: "info",
          message: `自动农场 / 好友偷菜 / ${friendLabel}：${Number(visit.collectBefore) || 0} → ${Number(visit.collectAfter) || 0}${selectiveParts.length ? " · " + selectiveParts.join(" · ") : ""}`,
        });
        return;
      }
      messages.push({
        level: "info",
        message: `自动农场 / 好友偷菜 / ${friendLabel}：已访问${selectiveParts.length ? " · " + selectiveParts.join(" · ") : ""}`,
      });
    });

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
    this.nextRunAt = null;
    this.lastStartedAt = null;
    this.lastFinishedAt = null;
    this.lastOwnRunAt = 0;
    this.lastFriendRunAt = 0;
    this.lastError = null;
    this.lastResult = null;
    this.recentEvents = [];
    this.todayStats = createEmptyTodayStats();
    this.friendVisitCooldowns = new Map();
    this.config = normalizeAutoFarmConfig({});
  }

  updateConfig(raw) {
    this.config = normalizeAutoFarmConfig({ ...this.config, ...(raw && typeof raw === "object" ? raw : {}) });
    return this.config;
  }

  getState() {
    this._ensureTodayStatsFresh();
    this._pruneFriendVisitCooldowns();
    return {
      running: this.running,
      busy: this.busy,
      nextRunAt: this.nextRunAt,
      lastStartedAt: this.lastStartedAt,
      lastFinishedAt: this.lastFinishedAt,
      lastOwnRunAt: this.lastOwnRunAt ? new Date(this.lastOwnRunAt).toISOString() : null,
      lastFriendRunAt: this.lastFriendRunAt ? new Date(this.lastFriendRunAt).toISOString() : null,
      lastError: this.lastError,
      lastResult: this.lastResult,
      todayStats: { ...this.todayStats },
      config: { ...this.config },
      friendVisitCooldowns: Array.from(this.friendVisitCooldowns.entries()).map(([gid, untilMs]) => ({
        gid,
        untilMs,
        untilAt: new Date(untilMs).toISOString(),
      })),
      recentEvents: [...this.recentEvents],
      runtime: this.getTransportState(),
    };
  }

  start(rawConfig) {
    if (rawConfig) this.updateConfig(rawConfig);
    if (!this.config.autoFarmOwnEnabled && !this.config.autoFarmFriendEnabled) {
      throw new Error("自动化已启动的项目为空，请至少启用自己农场或好友偷菜");
    }
    this.running = true;
    this._pushEvent("info", "自动化已启动");
    this._schedule(50);
    return this.getState();
  }

  stop(reason = "manual") {
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
    if (!this.config.autoFarmOwnEnabled && !this.config.autoFarmFriendEnabled) {
      throw new Error("自动化已启动的项目为空，请至少启用自己农场或好友偷菜");
    }
    if (this.busy) {
      throw new Error("自动化正在执行中");
    }
    return await this._runCycle(true);
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
    if (payload && Object.keys(payload).length > 0) entry.extra = payload;
    this.recentEvents.push(entry);
    if (this.recentEvents.length > AUTO_FARM_RECENT_EVENT_LIMIT) {
      this.recentEvents.splice(0, this.recentEvents.length - AUTO_FARM_RECENT_EVENT_LIMIT);
    }
  }

  _ensureTodayStatsFresh(now) {
    const dateKey = getTodayKey(now);
    if (!this.todayStats || this.todayStats.dateKey !== dateKey) {
      this.todayStats = createEmptyTodayStats(dateKey);
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

  _buildFriendVisitCooldownEntries(nowMs) {
    this._pruneFriendVisitCooldowns(nowMs);
    return Array.from(this.friendVisitCooldowns.entries()).map(([gid, untilMs]) => ({
      gid,
      untilMs,
    }));
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
    const delays = [];
    if (this.config.autoFarmOwnEnabled) {
      const ownDueAt = this.lastOwnRunAt > 0
        ? this.lastOwnRunAt + this.config.autoFarmOwnIntervalSec * 1000
        : now;
      delays.push(Math.max(0, ownDueAt - now));
    }
    if (this.config.autoFarmFriendEnabled) {
      const friendDueAt = this.lastFriendRunAt > 0
        ? this.lastFriendRunAt + this.config.autoFarmFriendIntervalSec * 1000
        : now;
      delays.push(Math.max(0, friendDueAt - now));
    }
    if (delays.length === 0) return 1000;
    return Math.max(250, Math.min(...delays));
  }

  _getDueFlags(now, force) {
    const ownDue = !!this.config.autoFarmOwnEnabled && (
      force || this.lastOwnRunAt <= 0 || now - this.lastOwnRunAt >= this.config.autoFarmOwnIntervalSec * 1000
    );
    const friendDue = !!this.config.autoFarmFriendEnabled && (
      force || this.lastFriendRunAt <= 0 || now - this.lastFriendRunAt >= this.config.autoFarmFriendIntervalSec * 1000
    );
    return { ownDue, friendDue };
  }

  async _tick() {
    if (!this.running) return;
    if (this.busy) {
      this._schedule(500);
      return;
    }
    const now = Date.now();
    const due = this._getDueFlags(now, false);
    if (!due.ownDue && !due.friendDue) {
      this._schedule(this._computeNextDelayMs(now));
      return;
    }
    let shouldReschedule = true;
    try {
      await this._runCycle(false, due);
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      if (this.config.autoFarmStopOnError) {
        shouldReschedule = false;
        this.stop(`error: ${err.message}`);
        return;
      }
    } finally {
      if (shouldReschedule && this.running) {
        this._schedule(this._computeNextDelayMs(Date.now()));
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
      "autoPlant",
      "autoReconnectIfNeeded",
    ]);
  }

  async _callGameCtlDirect(session, pathName, args) {
    return await callGameCtl(session, pathName, args);
  }

  async _runCycle(force, dueFlags) {
    const now = Date.now();
    const cycleId = new Date(now).toISOString();
    let cycleSeq = 0;
    const pushCycleEvent = (level, message, extra) => {
      cycleSeq += 1;
      this._pushEvent(level, message, {
        ...(extra && typeof extra === "object" ? extra : {}),
        cycleId,
        cycleSeq,
      });
    };
    this._pruneFriendVisitCooldowns(now);
    this._ensureTodayStatsFresh(now);
    const due = dueFlags || this._getDueFlags(now, force);
    if (!due.ownDue && !due.friendDue) {
      return this.getState();
    }

    this.busy = true;
    this.lastStartedAt = new Date().toISOString();
    this.lastError = null;
    if (due.ownDue) this.lastOwnRunAt = now;
    if (due.friendDue) this.lastFriendRunAt = now;
    pushCycleEvent("info", `自动农场 / 开始调度：自己农场=${due.ownDue ? "执行" : "跳过"}，好友巡检=${due.friendDue ? "执行" : "跳过"}`, {
      category: "cycle_start",
      due: {
        ownDue: due.ownDue,
        friendDue: due.friendDue,
      },
    });

    try {
      const session = await this.ensureSession();
      const injectState = await this.ensureGameCtlImpl(session);
      const cycleOpts = {
        ownFarmEnabled: due.ownDue,
        friendStealEnabled: due.friendDue,
        autoPlantMode: this.config.autoFarmPlantMode || "none",
        autoPlantPrimaryMode: this.config.autoFarmPlantPrimaryMode || this.config.autoFarmPlantMode || "none",
        autoPlantSecondaryMode: this.config.autoFarmPlantSecondaryMode || "none",
        autoPlantSeedId: this.config.autoFarmPlantSeedId || 0,
        autoPlantMaxLevel: this.config.autoFarmPlantMaxLevel || 0,
        autoFertilizerEnabled: !!this.config.autoFarmFertilizerEnabled,
        autoFertilizerMode: this.config.autoFarmFertilizerMode || "none",
        autoFertilizerMultiSeason: !!this.config.autoFarmFertilizerMultiSeason,
        autoFertilizerLandTypes: Array.isArray(this.config.autoFarmFertilizerLandTypes)
          ? [...this.config.autoFarmFertilizerLandTypes]
          : ["gold", "black", "red", "normal"],
        autoFertilizerGift: !!this.config.autoFarmFertilizerGift,
        autoFertilizerBuy: !!this.config.autoFarmFertilizerBuy,
        autoFertilizerBuyType: this.config.autoFarmFertilizerBuyType || "organic",
        autoFertilizerBuyMax: this.config.autoFarmFertilizerBuyMax || 10,
        autoFertilizerBuyMode: this.config.autoFarmFertilizerBuyMode || "threshold",
        autoFertilizerBuyThreshold: this.config.autoFarmFertilizerBuyThreshold || 100,
        enterWaitMs: this.config.autoFarmEnterWaitMs,
        actionWaitMs: this.config.autoFarmActionWaitMs,
        maxFriends: this.config.autoFarmMaxFriends,
        refreshFriendList: this.config.autoFarmRefreshFriendList,
        returnHome: this.config.autoFarmReturnHome,
        friendQuietHoursEnabled: !!this.config.autoFarmFriendQuietHoursEnabled,
        friendQuietHoursStart: this.config.autoFarmFriendQuietHoursStart || "23:00",
        friendQuietHoursEnd: this.config.autoFarmFriendQuietHoursEnd || "07:00",
        friendBlockMaskedStealers: this.config.autoFarmFriendBlockMaskedStealers !== false,
        friendBlacklist: Array.isArray(this.config.autoFarmFriendBlacklist)
          ? [...this.config.autoFarmFriendBlacklist]
          : [],
        friendVisitCooldowns: this._buildFriendVisitCooldownEntries(now),
        friendStealPlantBlacklistEnabled: this.config.autoFarmFriendStealPlantBlacklistEnabled === true,
        friendStealPlantBlacklistStrategy: this.config.autoFarmFriendStealPlantBlacklistStrategy,
        friendStealPlantBlacklist: Array.isArray(this.config.autoFarmFriendStealPlantBlacklist)
          ? [...this.config.autoFarmFriendStealPlantBlacklist]
          : [],
        stopOnError: this.config.autoFarmStopOnError,
      };
      const result = await runAutoFarmCycle({
        session,
        callGameCtl: this.callGameCtlImpl.bind(this),
        options: cycleOpts,
      });
      this.lastFinishedAt = new Date().toISOString();
      this.lastResult = {
        injected: injectState.injected,
        due,
        result,
      };
      const cooldownApplied = this._applyFriendVisitCooldowns(result && result.friendSteal, now);
      mergeCycleResultIntoTodayStats(this.todayStats, result);
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
      return this.getState();
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      this.lastFinishedAt = new Date().toISOString();
      this.lastError = err.message;
      pushCycleEvent("error", `自动农场 / 调度失败：${err.message}`, {
        category: "cycle_failed",
      });
      throw err;
    } finally {
      this.busy = false;
    }
  }
}

module.exports = {
  AutoFarmManager,
  normalizeAutoFarmConfig,
};
