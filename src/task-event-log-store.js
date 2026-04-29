"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");

const DEFAULT_READ_LIMIT = 500;

function normalizeTaskEventEntry(raw) {
  const src = raw && typeof raw === "object" ? raw : {};
  const extra = src.extra && typeof src.extra === "object" ? { ...src.extra } : null;
  const entry = {
    time: src.time ? String(src.time) : new Date().toISOString(),
    level: src.level ? String(src.level) : "info",
    message: src.message ? String(src.message) : "",
  };
  if (src.cycleId) entry.cycleId = String(src.cycleId);
  if (src.cycleSeq != null) entry.cycleSeq = Number(src.cycleSeq) || 0;
  if (src.category) entry.category = String(src.category);
  if (src.taskId) entry.taskId = String(src.taskId);
  if (src.taskLabel) entry.taskLabel = String(src.taskLabel);
  if (extra && Object.keys(extra).length > 0) entry.extra = extra;
  return entry;
}

function formatTaskEventTextLine(raw) {
  const entry = normalizeTaskEventEntry(raw);
  const parts = [];
  parts.push(`[${entry.time}]`);
  parts.push(`[${entry.level}]`);
  if (entry.taskLabel) {
    parts.push(`[${entry.taskLabel}]`);
  } else if (entry.taskId) {
    parts.push(`[${entry.taskId}]`);
  }
  parts.push(entry.message);
  return parts.join(" ");
}

class TaskEventLogStore {
  constructor(projectRoot) {
    const root = projectRoot ? path.resolve(projectRoot) : path.resolve(__dirname, "..");
    this.filePath = path.join(root, "data", "task-events.ndjson");
    this.appendChain = Promise.resolve();
  }

  async append(raw) {
    const entry = normalizeTaskEventEntry(raw);
    const line = JSON.stringify(entry) + "\n";
    this.appendChain = this.appendChain
      .catch(() => {})
      .then(async () => {
        await fs.mkdir(path.dirname(this.filePath), { recursive: true });
        await fs.appendFile(this.filePath, line, "utf8");
      });
    await this.appendChain;
    return entry;
  }

  async readRecent(limit = DEFAULT_READ_LIMIT) {
    let raw = "";
    try {
      raw = await fs.readFile(this.filePath, "utf8");
    } catch (_) {
      return [];
    }
    const lines = raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    return lines
      .slice(-Math.max(1, Number(limit) || DEFAULT_READ_LIMIT))
      .map((line) => {
        try {
          return normalizeTaskEventEntry(JSON.parse(line));
        } catch (_) {
          return null;
        }
      })
      .filter(Boolean);
  }

  async exportText(limit = DEFAULT_READ_LIMIT) {
    const entries = await this.readRecent(limit);
    return entries.map((entry) => formatTaskEventTextLine(entry)).join("\n");
  }

  async exportJson(limit = DEFAULT_READ_LIMIT) {
    const entries = await this.readRecent(limit);
    return JSON.stringify(entries, null, 2);
  }
}

module.exports = {
  TaskEventLogStore,
  formatTaskEventTextLine,
  normalizeTaskEventEntry,
};
