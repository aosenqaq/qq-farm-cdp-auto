"use strict";

const AUTO_PLANT_MODE_SET = new Set([
  "none",
  "highest",
  "lowest",
  "selected",
]);

const AUTO_PLANT_SOURCE_SET = new Set([
  "auto",
  "backpack",
  "shop",
]);

function normalizeText(value) {
  return value == null ? "" : String(value).trim();
}

function normalizeAutoPlantMode(mode) {
  const raw = normalizeText(mode);
  if (!raw) return "none";
  if (raw === "backpack_first") return "highest";
  if (raw === "buy_highest") return "highest";
  if (raw === "buy_lowest") return "lowest";
  if (raw === "specific") return "selected";
  return AUTO_PLANT_MODE_SET.has(raw) ? raw : "none";
}

function normalizeAutoPlantSource(source, legacyMode) {
  const rawSource = normalizeText(source).toLowerCase();
  if (AUTO_PLANT_SOURCE_SET.has(rawSource)) return rawSource;

  const rawMode = normalizeText(legacyMode);
  if (rawMode === "backpack_first") return "backpack";
  if (rawMode === "buy_highest" || rawMode === "buy_lowest") return "shop";
  return "auto";
}

function pickFirstNonEmpty(values) {
  const list = Array.isArray(values) ? values : [values];
  for (let i = 0; i < list.length; i += 1) {
    const value = normalizeText(list[i]);
    if (value) return value;
  }
  return "";
}

function readAutoPlantSelectedSeedKey(src) {
  const data = src && typeof src === "object" ? src : {};
  return pickFirstNonEmpty([
    data.autoFarmPlantSelectedSeedKey,
    data.autoFarmPlantSelectedSeed,
    data.autoFarmPlantSelectedSeedId,
    data.autoFarmPlantSelectedItemId,
    data.autoFarmPlantSeedId,
    data.autoFarmPlantItemId,
    data.autoFarmPlantSeedName,
    data.selectedSeedKey,
    data.selectedSeedId,
    data.selectedItemId,
    data.seedId,
    data.itemId,
    data.seedName,
  ]);
}

module.exports = {
  normalizeAutoPlantMode,
  normalizeAutoPlantSource,
  readAutoPlantSelectedSeedKey,
};
