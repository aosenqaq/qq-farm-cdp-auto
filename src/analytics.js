"use strict";

const { getAllPlants, getFruitPrice, getSeedPrice } = require("./game-config");

function parseGrowPhaseDurations(growPhases) {
  if (!growPhases) return [];
  return String(growPhases)
    .split(";")
    .filter(Boolean)
    .map((phase) => {
      const match = phase.match(/:(\d+)$/);
      return match ? (Number.parseInt(match[1], 10) || 0) : 0;
    })
    .filter((duration) => duration >= 0);
}

function parseGrowTime(growPhases, seasons) {
  const durations = parseGrowPhaseDurations(growPhases);
  if (durations.length === 0) return 0;
  const total = durations.reduce((sum, duration) => sum + duration, 0);
  if (Number(seasons) !== 2) return total;
  const extra = durations.filter((duration) => duration > 0).slice(-2).reduce((sum, duration) => sum + duration, 0);
  return total + extra;
}

function parseNormalFertilizerReduceSec(growPhases, seasons) {
  const durations = parseGrowPhaseDurations(growPhases).filter((duration) => duration > 0);
  if (durations.length === 0) return 0;
  const maxDuration = Math.max(...durations);
  return maxDuration * (Number(seasons) === 2 ? 2 : 1);
}

function formatGrowTime(seconds) {
  const total = Number(seconds) || 0;
  if (total <= 0) return "0秒";
  if (total < 60) return `${total}秒`;
  if (total < 3600) {
    const mins = Math.floor(total / 60);
    const secs = total % 60;
    return secs > 0 ? `${mins}分${secs}秒` : `${mins}分`;
  }
  const hours = Math.floor(total / 3600);
  const mins = Math.floor((total % 3600) / 60);
  return mins > 0 ? `${hours}小时${mins}分` : `${hours}小时`;
}

function toPlantRow(plant) {
  const seasons = Number(plant && plant.seasons) || 1;
  const growTime = parseGrowTime(plant && plant.grow_phases, seasons);
  if (growTime <= 0) return null;

  const harvestExpBase = Number.parseInt(plant && plant.exp, 10) || 0;
  const harvestExp = seasons === 2 ? harvestExpBase * 2 : harvestExpBase;
  const reduceSecApplied = parseNormalFertilizerReduceSec(plant && plant.grow_phases, seasons);
  const fertilizedGrowTime = Math.max(1, growTime - reduceSecApplied);

  const fruitId = Number(plant && plant.fruit && plant.fruit.id) || 0;
  const fruitCount = Number(plant && plant.fruit && plant.fruit.count) || 0;
  const fruitPrice = getFruitPrice(fruitId);
  const seedPrice = getSeedPrice(Number(plant && plant.seed_id) || 0);
  const income = fruitCount * fruitPrice * (seasons === 2 ? 2 : 1);
  const netProfit = income - seedPrice;

  const landLevelNeed = Number(plant && plant.land_level_need);
  const level = Number.isFinite(landLevelNeed) && landLevelNeed > 0 ? landLevelNeed : null;

  return {
    id: Number(plant && plant.id) || 0,
    seedId: Number(plant && plant.seed_id) || 0,
    name: String((plant && plant.name) || "未知作物"),
    seasons,
    level,
    growTime,
    growTimeStr: formatGrowTime(growTime),
    reduceSec: seasons === 2 ? reduceSecApplied / 2 : reduceSecApplied,
    reduceSecApplied,
    harvestExp,
    expPerHour: Number(((harvestExp / growTime) * 3600).toFixed(2)),
    normalFertilizerExpPerHour: Number(((harvestExp / fertilizedGrowTime) * 3600).toFixed(2)),
    income,
    netProfit,
    goldPerHour: Number(((income / growTime) * 3600).toFixed(2)),
    profitPerHour: Number(((netProfit / growTime) * 3600).toFixed(2)),
    normalFertilizerProfitPerHour: Number(((netProfit / fertilizedGrowTime) * 3600).toFixed(2)),
    fruitId,
    fruitCount,
    fruitPrice,
    seedPrice,
  };
}

function sortRows(rows, sortBy) {
  const list = [...rows];
  if (sortBy === "level") {
    list.sort((a, b) => (Number(b.level) || -1) - (Number(a.level) || -1));
    return list;
  }
  const metricMap = {
    exp: "expPerHour",
    fert: "normalFertilizerExpPerHour",
    gold: "goldPerHour",
    profit: "profitPerHour",
    fert_profit: "normalFertilizerProfitPerHour",
  };
  const metric = metricMap[sortBy] || "expPerHour";
  list.sort((a, b) => (Number(b[metric]) || 0) - (Number(a[metric]) || 0));
  return list;
}

function getPlantRankings(sortBy) {
  const rows = getAllPlants()
    .filter((plant) => Number(plant && plant.seed_id) > 0 && plant && plant.grow_phases)
    .map(toPlantRow)
    .filter(Boolean);
  return sortRows(rows, sortBy || "exp");
}

function getStrategyDefinitions() {
  return [
    { key: "preferred_seed", label: "指定种子优先", analyticsSort: null },
    { key: "max_level", label: "最高等级作物", analyticsSort: "level" },
    { key: "max_exp", label: "经验/小时最高", analyticsSort: "exp" },
    { key: "max_fert_exp", label: "普肥经验/小时最高", analyticsSort: "fert" },
    { key: "max_profit", label: "净利润/小时最高", analyticsSort: "profit" },
    { key: "max_fert_profit", label: "普肥净利润/小时最高", analyticsSort: "fert_profit" },
  ];
}

module.exports = {
  formatGrowTime,
  getPlantRankings,
  getStrategyDefinitions,
};
