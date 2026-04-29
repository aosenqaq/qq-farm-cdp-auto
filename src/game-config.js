"use strict";

const fs = require("node:fs");
const path = require("node:path");

const CONFIG_ROOT = path.join(__dirname, "..", "gameConfig");
const PLANT_IMAGE_ROOT = path.join(CONFIG_ROOT, "plant_images");
const PLANT_MISC_IMAGE_ROOT = path.join(PLANT_IMAGE_ROOT, "stages");
const PLANT_STAGE_IMAGE_DIR = path.join(PLANT_IMAGE_ROOT, "stages", "作物");

let loaded = false;
let roleLevelConfig = [];
let plantConfig = [];
let itemInfoConfig = [];
const plantMap = new Map();
const seedToPlant = new Map();
const fruitToPlant = new Map();
const itemInfoMap = new Map();
const cropStageImageMap = new Map();
const externalItemMetaMap = new Map();

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
  cropStageImageMap.clear();
  externalItemMetaMap.clear();

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

  if (fs.existsSync(PLANT_STAGE_IMAGE_DIR)) {
    let cropDirs = [];
    try {
      cropDirs = fs.readdirSync(PLANT_STAGE_IMAGE_DIR, { withFileTypes: true });
    } catch (_) {
      cropDirs = [];
    }
    cropDirs.forEach((entry) => {
      if (!entry || entry.isDirectory() !== true) return;
      const cropName = String(entry.name || "").trim();
      if (!cropName) return;
      const cropDirPath = path.join(PLANT_STAGE_IMAGE_DIR, cropName);
      let files = [];
      try {
        files = fs.readdirSync(cropDirPath);
      } catch (_) {
        files = [];
      }
      const stageEntries = [];
      files.forEach((filename) => {
        if (!/\.(png|jpg|jpeg|webp|gif)$/i.test(filename)) return;
        const match = /_(\d+)_([^.]*)\.(?:png|jpg|jpeg|webp|gif)$/i.exec(filename);
        if (!match) return;
        stageEntries.push({
          index: Number(match[1]) || 0,
          label: String(match[2] || "").trim(),
          path: path.join(cropDirPath, filename),
        });
      });
      stageEntries.sort((a, b) => a.index - b.index);
      if (stageEntries.length > 0) {
        cropStageImageMap.set(cropName, stageEntries);
      }
    });
  }

  if (fs.existsSync(PLANT_MISC_IMAGE_ROOT)) {
    let assetDirs = [];
    try {
      assetDirs = fs.readdirSync(PLANT_MISC_IMAGE_ROOT, { withFileTypes: true });
    } catch (_) {
      assetDirs = [];
    }
    assetDirs.forEach((entry) => {
      if (!entry || entry.isDirectory() !== true) return;
      const dirName = String(entry.name || "").trim();
      if (!dirName || dirName === "作物") return;
      const dirPath = path.join(PLANT_MISC_IMAGE_ROOT, dirName);
      let files = [];
      try {
        files = fs.readdirSync(dirPath);
      } catch (_) {
        files = [];
      }
      const imageByBaseName = new Map();
      files.forEach((filename) => {
        if (!/\.(png|jpg|jpeg|webp|gif)$/i.test(filename)) return;
        const baseName = path.basename(filename, path.extname(filename)).trim();
        if (baseName && !imageByBaseName.has(baseName)) {
          imageByBaseName.set(baseName, path.join(dirPath, filename));
        }
      });
      files
        .filter((filename) => /_mapping\.json$/i.test(filename))
        .forEach((filename) => {
          let parsed = null;
          try {
            parsed = JSON.parse(fs.readFileSync(path.join(dirPath, filename), "utf8").replace(/^\uFEFF/, ""));
          } catch (_) {
            parsed = null;
          }
          const items = Array.isArray(parsed && parsed.items) ? parsed.items : [];
          items.forEach((item) => {
            const itemId = Number(item && (item.item_id || item.id)) || 0;
            if (itemId <= 0) return;
            const name = String(item && item.name || "").trim();
            const imagePath = (name && imageByBaseName.get(name)) || null;
            const current = externalItemMetaMap.get(itemId) || {};
            externalItemMetaMap.set(itemId, {
              itemId,
              name: name || current.name || null,
              level: item && item.level != null ? Number(item.level) || null : (current.level ?? null),
              rarity: item && item.rarity != null ? Number(item.rarity) || null : (current.rarity ?? null),
              type: item && item.type != null ? Number(item.type) || null : (current.type ?? null),
              interactionType: String(item && item.interaction_type || current.interactionType || "").trim() || null,
              assetCategory: dirName || current.assetCategory || null,
              imagePath: imagePath || current.imagePath || null,
            });
          });
        });
    });
  }

  if (fs.existsSync(PLANT_STAGE_IMAGE_DIR)) {
    let rootFiles = [];
    try {
      rootFiles = fs.readdirSync(PLANT_STAGE_IMAGE_DIR);
    } catch (_) {
      rootFiles = [];
    }
    rootFiles
      .filter((filename) => /_mapping\.json$/i.test(filename))
      .forEach((filename) => {
        let parsed = null;
        try {
          parsed = JSON.parse(fs.readFileSync(path.join(PLANT_STAGE_IMAGE_DIR, filename), "utf8").replace(/^\uFEFF/, ""));
        } catch (_) {
          parsed = null;
        }
        const items = Array.isArray(parsed && parsed.items) ? parsed.items : [];
        items.forEach((item) => {
          const itemId = Number(item && (item.item_id || item.id)) || 0;
          if (itemId <= 0) return;
          const name = String(item && item.name || "").trim();
          const stageEntries = name ? cropStageImageMap.get(name) : null;
          const mainEntry = Array.isArray(stageEntries)
            ? (stageEntries.find((entry) => entry.index === 0)
              || stageEntries.find((entry) => /^(作物图|主图)$/i.test(String(entry.label || "").trim()))
              || null)
            : null;
          const current = externalItemMetaMap.get(itemId) || {};
          externalItemMetaMap.set(itemId, {
            itemId,
            name: name || current.name || null,
            level: item && item.level != null ? Number(item.level) || null : (current.level ?? null),
            rarity: item && item.rarity != null ? Number(item.rarity) || null : (current.rarity ?? null),
            type: item && item.type != null ? Number(item.type) || null : (current.type ?? null),
            interactionType: String(item && item.interaction_type || current.interactionType || "").trim() || null,
            assetCategory: (parsed && parsed.category) || current.assetCategory || "作物",
            imagePath: (mainEntry && mainEntry.path) || current.imagePath || null,
          });
        });
      });
  }

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
  const plant = getPlantBySeedId(targetId);
  if (!plant || !plant.name) return null;
  const stageEntries = cropStageImageMap.get(String(plant.name).trim());
  if (!Array.isArray(stageEntries) || stageEntries.length === 0) return null;
  const mainEntry = stageEntries.find((item) => item.index === 0)
    || stageEntries.find((item) => /^(作物图|主图)$/i.test(String(item.label || "").trim()))
    || null;
  return mainEntry && mainEntry.path ? mainEntry.path : null;
}

function normalizeStageLabel(value) {
  return String(value == null ? "" : value).trim().toLowerCase();
}

function getPlantStageImagePathBySeedId(seedId, options = {}) {
  ensureLoaded();
  const plant = getPlantBySeedId(seedId);
  if (!plant || !plant.name) return null;
  const stageEntries = cropStageImageMap.get(String(plant.name).trim());
  if (!Array.isArray(stageEntries) || stageEntries.length === 0) return null;

  const normalizedPhaseName = normalizeStageLabel(options.phaseName);
  if (normalizedPhaseName) {
    const matchedByLabel = stageEntries.find((item) => normalizeStageLabel(item.label) === normalizedPhaseName);
    if (matchedByLabel && matchedByLabel.path) return matchedByLabel.path;
  }

  const phases = parseGrowPhases(plant.grow_phases);
  const phaseIndex = phases.findIndex((item) => normalizeStageLabel(item.name) === normalizedPhaseName);
  if (phaseIndex >= 0) {
    const matchedByPhaseOrder = stageEntries.find((item) => item.index === (phaseIndex + 1));
    if (matchedByPhaseOrder && matchedByPhaseOrder.path) return matchedByPhaseOrder.path;
  }

  const currentStage = Number(options.currentStage);
  if (Number.isFinite(currentStage) && currentStage > 0) {
    const matchedByIndex = stageEntries.find((item) => item.index === currentStage);
    if (matchedByIndex && matchedByIndex.path) return matchedByIndex.path;
  }

  return null;
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

function getItemInfoById(itemId) {
  ensureLoaded();
  return itemInfoMap.get(Number(itemId) || 0) || null;
}

function getExternalItemMetaByItemId(itemId) {
  ensureLoaded();
  return externalItemMetaMap.get(Number(itemId) || 0) || null;
}

function getExternalItemImagePathByItemId(itemId) {
  const meta = getExternalItemMetaByItemId(itemId);
  return meta && meta.imagePath ? meta.imagePath : null;
}

function getAllItemInfo() {
  ensureLoaded();
  return [...itemInfoConfig];
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
  const needed = nextFloor != null ? Math.max(0, nextFloor - currentFloor) : null;
  const looksLikeCurrentLevelExp = (
    needed != null &&
    currentFloor > 0 &&
    exp < currentFloor &&
    exp <= needed
  );
  const normalizedTotalExp = looksLikeCurrentLevelExp ? (currentFloor + exp) : exp;
  const currentProgressRaw = looksLikeCurrentLevelExp
    ? exp
    : Math.max(0, normalizedTotalExp - currentFloor);
  const currentProgress = needed != null
    ? Math.max(0, Math.min(currentProgressRaw, needed))
    : Math.max(0, currentProgressRaw);
  return {
    level: curLevel,
    totalExp: normalizedTotalExp,
    rawExp: exp,
    expMode: looksLikeCurrentLevelExp ? "current_level" : "total",
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
  getItemInfoById,
  getExternalItemMetaByItemId,
  getExternalItemImagePathByItemId,
  getAllItemInfo,
  getSeedPrice,
  getFruitPrice,
  getPlantGrowTimeSec,
  getPlantStageImagePathBySeedId,
  formatGrowTime,
  getSeedImagePathBySeedId,
  parseGrowPhases,
};
