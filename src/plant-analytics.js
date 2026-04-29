"use strict";

const fs = require("node:fs");
const path = require("node:path");

const CONFIG_DIRS = [
  path.join(__dirname, "..", "data", "gameConfig"),
  path.join(__dirname, "..", "gameConfig"),
];

let cache = null;

function readJsonFile(name) {
  for (let i = 0; i < CONFIG_DIRS.length; i += 1) {
    const fullPath = path.join(CONFIG_DIRS[i], name);
    if (!fs.existsSync(fullPath)) continue;
    const raw = fs.readFileSync(fullPath, "utf8");
    return JSON.parse(raw);
  }
  throw new Error(`missing game config: ${name}`);
}

function ensureCache() {
  if (cache) return cache;
  const plants = readJsonFile("Plant.json");
  const itemInfo = readJsonFile("ItemInfo.json");
  const roleLevels = readJsonFile("RoleLevel.json");

  const itemMap = new Map();
  for (let i = 0; i < itemInfo.length; i += 1) {
    const item = itemInfo[i];
    const id = Number(item && item.id) || 0;
    if (id > 0) itemMap.set(id, item);
  }

  const levelExpTable = [];
  for (let i = 0; i < roleLevels.length; i += 1) {
    const item = roleLevels[i];
    const level = Number(item && item.level) || 0;
    if (level > 0) levelExpTable[level] = Number(item.exp) || 0;
  }

  cache = {
    plants,
    itemMap,
    levelExpTable,
  };
  return cache;
}

function formatGrowTime(seconds) {
  const total = Number(seconds) || 0;
  if (total <= 0) return "0秒";
  if (total < 60) return total + "秒";
  if (total < 3600) {
    const mins = Math.floor(total / 60);
    const secs = total % 60;
    return secs > 0 ? mins + "分" + secs + "秒" : mins + "分";
  }
  const hours = Math.floor(total / 3600);
  const mins = Math.floor((total % 3600) / 60);
  return mins > 0 ? hours + "时" + mins + "分" : hours + "时";
}

function parseGrowPhaseDurations(growPhases) {
  const text = String(growPhases || "");
  if (!text) return [];
  const phases = text.split(";").filter(Boolean);
  const durations = [];
  for (let i = 0; i < phases.length; i += 1) {
    const match = phases[i].match(/:(\d+)$/);
    if (!match) continue;
    durations.push(Number.parseInt(match[1], 10) || 0);
  }
  return durations;
}

function parseGrowTime(growPhases, seasons) {
  const durations = parseGrowPhaseDurations(growPhases);
  if (durations.length === 0) return 0;
  const totalTime = durations.reduce((sum, duration) => sum + duration, 0);
  if (Number(seasons) !== 2) return totalTime;
  const lastTwo = durations.filter((duration) => duration > 0).slice(-2);
  return totalTime + lastTwo.reduce((sum, duration) => sum + duration, 0);
}

function parseNormalFertilizerReduceSec(growPhases, seasons) {
  const durations = parseGrowPhaseDurations(growPhases).filter((duration) => duration > 0);
  if (durations.length === 0) return 0;
  const maxDuration = Math.max.apply(null, durations);
  const applyCount = Number(seasons) === 2 ? 2 : 1;
  return maxDuration * applyCount;
}

function getItemPrice(itemMap, itemId) {
  const item = itemMap.get(Number(itemId) || 0);
  return Number(item && item.price) || 0;
}

function toPlantAnalyticsItem(plant, itemMap) {
  const seasons = Number(plant && plant.seasons) || 1;
  const growTime = parseGrowTime(plant && plant.grow_phases, seasons);
  if (growTime <= 0) return null;

  const fruitId = Number(plant && plant.fruit && plant.fruit.id) || 0;
  const fruitCount = Number(plant && plant.fruit && plant.fruit.count) || 0;
  const seedId = Number(plant && plant.seed_id) || 0;
  const harvestExpBase = Number(plant && plant.exp) || 0;
  const harvestExp = seasons === 2 ? harvestExpBase * 2 : harvestExpBase;
  const seedPrice = getItemPrice(itemMap, seedId);
  const fruitPrice = getItemPrice(itemMap, fruitId);
  const income = fruitPrice * fruitCount * (seasons === 2 ? 2 : 1);
  const netProfit = income - seedPrice;
  const expPerHour = growTime > 0 ? (harvestExp / growTime) * 3600 : 0;
  const profitPerHour = growTime > 0 ? (netProfit / growTime) * 3600 : 0;
  const reduceSecApplied = parseNormalFertilizerReduceSec(plant && plant.grow_phases, seasons);
  const safeFertilizedTime = Math.max(1, growTime - reduceSecApplied);
  const normalFertilizerExpPerHour = (harvestExp / safeFertilizedTime) * 3600;
  const normalFertilizerProfitPerHour = (netProfit / safeFertilizedTime) * 3600;
  const levelRaw = Number(plant && plant.land_level_need);
  const level = Number.isFinite(levelRaw) && levelRaw > 0 ? levelRaw : null;
  const plantSize = Number(plant && plant.size) || 1;

  return {
    id: Number(plant && plant.id) || 0,
    seedId,
    name: plant && plant.name ? String(plant.name) : "未知作物",
    seasons,
    level,
    growTime,
    growTimeStr: formatGrowTime(growTime),
    reduceSecApplied,
    harvestExp,
    expPerHour: Number(expPerHour.toFixed(2)),
    normalFertilizerExpPerHour: Number(normalFertilizerExpPerHour.toFixed(2)),
    income,
    netProfit,
    profitPerHour: Number(profitPerHour.toFixed(2)),
    normalFertilizerProfitPerHour: Number(normalFertilizerProfitPerHour.toFixed(2)),
    fruitId,
    fruitCount,
    fruitPrice,
    seedPrice,
    plantSize,
    shopEligible: isShopEligiblePlantConfig(plant),
  };
}

function isShopEligiblePlantConfig(plant) {
  const seedId = Number(plant && plant.seed_id) || 0;
  const level = Number(plant && plant.land_level_need) || 0;
  const size = Number(plant && plant.size) || 1;
  if (seedId <= 0) return false;
  // 参考原项目的处理，活动/特殊作物不参与常规商店策略推荐。
  if (level >= 200) return false;
  if (size > 1) return false;
  return true;
}

function getPlantAnalyticsList() {
  const { plants, itemMap } = ensureCache();
  const list = [];
  for (let i = 0; i < plants.length; i += 1) {
    const plant = plants[i];
    if (!(Number(plant && plant.seed_id) > 0) || !plant.grow_phases) continue;
    const item = toPlantAnalyticsItem(plant, itemMap);
    if (item) list.push(item);
  }
  return list;
}

function filterShopEligiblePlants(list) {
  return (Array.isArray(list) ? list : []).filter((item) => !!(item && item.shopEligible));
}

function sortAnalyticsList(list, sortKey) {
  const arr = Array.isArray(list) ? [...list] : [];
  const metricMap = {
    exp: "expPerHour",
    fert_exp: "normalFertilizerExpPerHour",
    profit: "profitPerHour",
    fert_profit: "normalFertilizerProfitPerHour",
    level: "level",
    grow_time: "growTime",
  };
  const metric = metricMap[sortKey] || "expPerHour";
  arr.sort((a, b) => {
    const av = Number(a && a[metric]);
    const bv = Number(b && b[metric]);
    if (!Number.isFinite(av) && !Number.isFinite(bv)) return 0;
    if (!Number.isFinite(av)) return 1;
    if (!Number.isFinite(bv)) return -1;
    if (metric === "growTime") return av - bv;
    return bv - av;
  });
  return arr;
}

function filterAnalyticsByLevel(list, maxLevel) {
  const level = Number(maxLevel);
  if (!Number.isFinite(level) || level <= 0) return Array.isArray(list) ? [...list] : [];
  return (Array.isArray(list) ? list : []).filter((item) => item.level == null || item.level <= level);
}

function getPlantStrategyModes() {
  return [
    { value: "none", label: "不种植", needsSeedId: false },
    { value: "backpack_first", label: "背包优先", needsSeedId: false },
    { value: "specified_seed", label: "指定种子优先", needsSeedId: true },
    { value: "highest_level", label: "最高等级作物", needsSeedId: false },
    { value: "max_exp", label: "经验/小时最高", needsSeedId: false },
    { value: "max_fert_exp", label: "普肥经验/小时最高", needsSeedId: false },
    { value: "max_profit", label: "净利润/小时最高", needsSeedId: false },
    { value: "max_fert_profit", label: "普肥净利润/小时最高", needsSeedId: false },
  ];
}

function pickBestPlantByMode(mode, opts) {
  let list = filterAnalyticsByLevel(getPlantAnalyticsList(), opts && opts.maxLevel);
  if (opts && opts.shopEligibleOnly) {
    list = filterShopEligiblePlants(list);
  }
  if (!list.length) return null;
  const metricMap = {
    highest_level: "level",
    max_exp: "expPerHour",
    max_fert_exp: "normalFertilizerExpPerHour",
    max_profit: "profitPerHour",
    max_fert_profit: "normalFertilizerProfitPerHour",
  };
  const metric = metricMap[mode];
  if (!metric) return null;
  const sorted = sortAnalyticsList(list, metric === "level" ? "level" : (
    metric === "normalFertilizerExpPerHour" ? "fert_exp" :
      metric === "profitPerHour" ? "profit" :
        metric === "normalFertilizerProfitPerHour" ? "fert_profit" : "exp"
  ));
  return sorted[0] || null;
}

module.exports = {
  filterAnalyticsByLevel,
  filterShopEligiblePlants,
  getPlantAnalyticsList,
  getPlantStrategyModes,
  isShopEligiblePlantConfig,
  pickBestPlantByMode,
  sortAnalyticsList,
};
