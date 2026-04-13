"use strict";

const fs = require("node:fs");
const path = require("node:path");

const CONFIG_ROOT = path.join(__dirname, "..", "gameConfig");
const DEFAULT_EXTERNAL_IMAGE_DIR = path.join(path.parse(CONFIG_ROOT).root, "_ext_qq-farm-bot-ui", "core", "src", "gameConfig", "seed_images_named");

let loaded = false;
let roleLevelConfig = [];
let plantConfig = [];
let itemInfoConfig = [];
const plantMap = new Map();
const seedToPlant = new Map();
const fruitToPlant = new Map();
const itemInfoMap = new Map();
const seedImagePathMap = new Map();
const seedAssetImagePathMap = new Map();

function readJsonFile(filename, fallback) {
  const filePath = path.join(CONFIG_ROOT, filename);
  if (!fs.existsSync(filePath)) return fallback;
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function ensureLoaded() {
  if (loaded) return;
  roleLevelConfig = readJsonFile("RoleLevel.json", []);
  plantConfig = readJsonFile("Plant.json", []);
  itemInfoConfig = readJsonFile("ItemInfo.json", []);

  plantMap.clear();
  seedToPlant.clear();
  fruitToPlant.clear();
  itemInfoMap.clear();
  seedImagePathMap.clear();
  seedAssetImagePathMap.clear();

  plantConfig.forEach((plant) => {
    const plantId = Number(plant && plant.id) || 0;
    if (plantId > 0) plantMap.set(plantId, plant);
    const seedId = Number(plant && plant.seed_id) || 0;
    if (seedId > 0) seedToPlant.set(seedId, plant);
    const fruitId = Number(plant && plant.fruit && plant.fruit.id) || 0;
    if (fruitId > 0) fruitToPlant.set(fruitId, plant);
  });

  itemInfoConfig.forEach((item) => {
    const itemId = Number(item && item.id) || 0;
    if (itemId > 0) itemInfoMap.set(itemId, item);
  });

  const imageDirs = [
    path.join(CONFIG_ROOT, "seed_images_named"),
    path.join(path.join(__dirname, "..", "data", "gameConfig"), "seed_images_named"),
    DEFAULT_EXTERNAL_IMAGE_DIR,
  ];

  imageDirs.forEach((dirPath) => {
    if (!fs.existsSync(dirPath)) return;
    let files = [];
    try {
      files = fs.readdirSync(dirPath);
    } catch (_) {
      files = [];
    }
    files.forEach((filename) => {
      if (!/\.(png|jpg|jpeg|webp|gif)$/i.test(filename)) return;
      const absolutePath = path.join(dirPath, filename);
      const byId = /^(\d+)_.*\.(?:png|jpg|jpeg|webp|gif)$/i.exec(filename);
      if (byId) {
        const seedId = Number(byId[1]) || 0;
        if (seedId > 0 && !seedImagePathMap.has(seedId)) {
          seedImagePathMap.set(seedId, absolutePath);
        }
      }
      const byAsset = /(Crop_\d+)_Seed(?:\s*-\s*)?\.(?:png|jpg|jpeg|webp|gif)$/i.exec(filename);
      if (byAsset) {
        const assetName = String(byAsset[1] || "").trim();
        if (assetName && !seedAssetImagePathMap.has(assetName)) {
          seedAssetImagePathMap.set(assetName, absolutePath);
        }
      }
    });
  });

  loaded = true;
}

function parseGrowPhases(growPhases) {
  return String(growPhases || "")
    .split(";")
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item, index) => {
      const parts = item.split(":");
      return {
        index: index + 1,
        name: parts[0] || "",
        duration: parts[1] == null ? 0 : (Number(parts[1]) || 0),
      };
    });
}

function getPlantGrowTimeSec(plantOrPlantId) {
  ensureLoaded();
  const plant = typeof plantOrPlantId === "object" && plantOrPlantId
    ? plantOrPlantId
    : getPlantById(plantOrPlantId);
  if (!plant) return 0;
  const phases = parseGrowPhases(plant.grow_phases);
  const durations = phases.map((item) => Number(item.duration) || 0);
  const total = durations.reduce((sum, duration) => sum + duration, 0);
  const seasons = Number(plant.seasons) || 1;
  if (seasons !== 2) return total;
  const lastTwo = durations.filter((duration) => duration > 0).slice(-2);
  return total + lastTwo.reduce((sum, duration) => sum + duration, 0);
}

function formatGrowTime(seconds) {
  const total = Math.max(0, Number(seconds) || 0);
  if (total < 60) return `${total}秒`;
  if (total < 3600) return `${Math.floor(total / 60)}分钟`;
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  if (hours < 24) {
    return minutes > 0 ? `${hours}小时${minutes}分` : `${hours}小时`;
  }
  const days = Math.floor(hours / 24);
  const remainHours = hours % 24;
  if (remainHours > 0 && minutes > 0) return `${days}天${remainHours}小时${minutes}分`;
  if (remainHours > 0) return `${days}天${remainHours}小时`;
  return `${days}天`;
}

function getSeedImagePathBySeedId(seedId) {
  ensureLoaded();
  const targetId = Number(seedId) || 0;
  if (targetId <= 0) return null;
  const direct = seedImagePathMap.get(targetId);
  if (direct) return direct;
  const item = itemInfoMap.get(targetId);
  const assetName = item && item.asset_name ? String(item.asset_name).trim() : "";
  if (!assetName) return null;
  return seedAssetImagePathMap.get(assetName) || null;
}

function getPlantBySeedId(seedId) {
  ensureLoaded();
  return seedToPlant.get(Number(seedId) || 0) || null;
}

function getPlantById(plantId) {
  ensureLoaded();
  return plantMap.get(Number(plantId) || 0) || null;
}

function getPlantByFruitId(fruitId) {
  ensureLoaded();
  return fruitToPlant.get(Number(fruitId) || 0) || null;
}

function getSeedPrice(seedId) {
  ensureLoaded();
  const item = itemInfoMap.get(Number(seedId) || 0);
  return Number(item && item.price) || 0;
}

function getFruitPrice(fruitId) {
  ensureLoaded();
  const item = itemInfoMap.get(Number(fruitId) || 0);
  return Number(item && item.price) || 0;
}

function getAllPlants() {
  ensureLoaded();
  return [...plantConfig];
}

function getAllRoleLevels() {
  ensureLoaded();
  return [...roleLevelConfig];
}

function getLevelExpProgress(level, totalExp) {
  ensureLoaded();
  const curLevel = Number(level) || 0;
  const exp = Number(totalExp) || 0;
  if (curLevel <= 0 || exp < 0 || !Array.isArray(roleLevelConfig) || roleLevelConfig.length === 0) {
    return null;
  }
  const current = roleLevelConfig.find((item) => Number(item && item.level) === curLevel) || null;
  const next = roleLevelConfig.find((item) => Number(item && item.level) === curLevel + 1) || null;
  if (!current) return null;
  const currentFloor = Number(current && current.exp) || 0;
  const nextFloor = next ? (Number(next && next.exp) || currentFloor) : null;
  const currentProgress = Math.max(0, exp - currentFloor);
  const needed = nextFloor != null ? Math.max(0, nextFloor - currentFloor) : null;
  return {
    level: curLevel,
    totalExp: exp,
    current: currentProgress,
    needed,
    currentFloor,
    nextLevel: next ? (Number(next && next.level) || (curLevel + 1)) : null,
    nextLevelTotalExp: nextFloor,
    remaining: needed != null ? Math.max(0, needed - currentProgress) : null,
    percent: needed && needed > 0 ? Math.max(0, Math.min(100, Number(((currentProgress / needed) * 100).toFixed(2)))) : null,
  };
}

module.exports = {
  ensureLoaded,
  getAllPlants,
  getAllRoleLevels,
  getLevelExpProgress,
  getPlantById,
  getPlantBySeedId,
  getPlantByFruitId,
  getSeedPrice,
  getFruitPrice,
  getPlantGrowTimeSec,
  formatGrowTime,
  getSeedImagePathBySeedId,
  parseGrowPhases,
};
