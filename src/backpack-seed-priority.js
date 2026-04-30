"use strict";

const { getPlantBySeedId } = require("./game-config");

function normalizePositiveIntList(value) {
  const source = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(/[\r\n,，;；]+/)
      : [];
  const next = [];
  for (let i = 0; i < source.length; i += 1) {
    const num = Number.parseInt(String(source[i] == null ? "" : source[i]).trim(), 10);
    if (!Number.isFinite(num) || num <= 0 || next.includes(num)) continue;
    next.push(num);
  }
  return next;
}

function buildPriorityIndex(prioritySeedIds) {
  const normalized = normalizePositiveIntList(prioritySeedIds);
  const map = new Map();
  for (let i = 0; i < normalized.length; i += 1) {
    map.set(normalized[i], i);
  }
  return map;
}

function getBackpackSeedPlantability(seedId) {
  const normalizedSeedId = Number(seedId) || 0;
  if (normalizedSeedId <= 0) {
    return {
      plantable: false,
      reason: "invalid_seed_id",
      message: "无效种子",
    };
  }
  const plant = getPlantBySeedId(normalizedSeedId);
  if ((Number(plant && plant.size) || 0) >= 2) {
    return {
      plantable: false,
      reason: "multi_tile_seed_not_supported",
      message: `${plant && plant.name ? plant.name : "该种子"}为四格作物，当前背包种植策略不支持`,
    };
  }
  return {
    plantable: true,
    reason: null,
    message: "",
  };
}

function sortBackpackSeeds(seedList, prioritySeedIds) {
  const list = Array.isArray(seedList)
    ? seedList.map((item, index) => ({ item, index }))
    : [];
  const priorityIndex = buildPriorityIndex(prioritySeedIds);
  return list.sort((a, b) => {
    const aSeedId = Number(a && a.item && (a.item.seedId || a.item.itemId || a.item.id)) || 0;
    const bSeedId = Number(b && b.item && (b.item.seedId || b.item.itemId || b.item.id)) || 0;
    const aPriority = priorityIndex.has(aSeedId) ? priorityIndex.get(aSeedId) : Number.POSITIVE_INFINITY;
    const bPriority = priorityIndex.has(bSeedId) ? priorityIndex.get(bSeedId) : Number.POSITIVE_INFINITY;
    if (aPriority !== bPriority) return aPriority - bPriority;
    return a.index - b.index;
  }).map((entry) => entry.item);
}

function buildBackpackSeedPlan(seedList, prioritySeedIds) {
  const priorityIndex = buildPriorityIndex(prioritySeedIds);
  const sorted = sortBackpackSeeds(seedList, prioritySeedIds);
  const plan = [];
  for (let i = 0; i < sorted.length; i += 1) {
    const item = sorted[i];
    const seedId = Number(item && (item.seedId || item.itemId || item.id)) || 0;
    const count = Number(item && item.count) || 0;
    if (seedId <= 0 || count <= 0) continue;
    const plantability = getBackpackSeedPlantability(seedId);
    if (plantability.plantable !== true) continue;
    plan.push({
      item,
      seedId,
      count,
      usedPriority: priorityIndex.has(seedId),
    });
  }
  return plan;
}

function pickBackpackSeed(seedList, prioritySeedIds) {
  const plan = buildBackpackSeedPlan(seedList, prioritySeedIds);
  const first = plan[0] || null;
  if (!first) return null;
  return {
    item: first.item,
    seedId: first.seedId,
    usedPriority: first.usedPriority,
  };
}

module.exports = {
  buildBackpackSeedPlan,
  buildPriorityIndex,
  getBackpackSeedPlantability,
  normalizePositiveIntList,
  pickBackpackSeed,
  sortBackpackSeeds,
};
