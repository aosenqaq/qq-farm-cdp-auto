"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const { readAutoFarmDailyStats } = require("./auto-farm-daily-stats");
const { readPlayerProfileCache } = require("./player-profile-cache");

const MESSAGE_PUSH_STATE_VERSION = 2;
const MESSAGE_PUSH_HISTORY_LIMIT = 20;
const ABNORMAL_DEDUP_WINDOW_MS = 60 * 60 * 1000;
const ABNORMAL_FINGERPRINT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const SUPPORTED_CHANNEL_TYPES = [
  "serverchan",
  "pushplus",
  "wecom",
  "dingtalk",
  "feishu",
  "telegram",
  "bark",
  "ntfy",
  "webhook",
];

const CHANNEL_LABELS = {
  serverchan: "Server酱",
  pushplus: "PushPlus",
  wecom: "企业微信机器人",
  dingtalk: "钉钉机器人",
  feishu: "飞书机器人",
  telegram: "Telegram Bot",
  bark: "Bark",
  ntfy: "ntfy",
  webhook: "通用 Webhook",
};

const CHANNEL_FORMAT_OPTIONS = {
  pushplus: ["markdown", "text"],
  wecom: ["text", "markdown"],
  dingtalk: ["markdown", "text"],
  bark: ["text", "markdown"],
  ntfy: ["text", "markdown"],
};

const ABNORMAL_EVENT_LEVELS = new Set(["warn", "error"]);

function stripAnsiText(value) {
  return String(value == null ? "" : value).replace(/\u001b\[[0-9;]*m/g, "");
}

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
  const resolved = Number.isFinite(n) ? n : defaultValue;
  return Math.min(max, Math.max(min, resolved));
}

function toStringValue(value, fallback = "") {
  return value == null ? fallback : String(value);
}

function normalizeClockText(value, fallback) {
  const text = String(value == null ? "" : value).trim();
  const match = /^(\d{1,2}):(\d{1,2})$/.exec(text);
  if (!match) return fallback;
  const hours = Number.parseInt(match[1], 10);
  const minutes = Number.parseInt(match[2], 10);
  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return fallback;
  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return fallback;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

function normalizeChannelList(value) {
  const source = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(/[\r\n,，;；]+/)
      : [];
  const next = [];
  for (const item of source) {
    const type = String(item == null ? "" : item).trim().toLowerCase();
    if (!SUPPORTED_CHANNEL_TYPES.includes(type) || next.includes(type)) continue;
    next.push(type);
  }
  return next;
}

function normalizeWebhookMethod(value) {
  const method = String(value == null ? "" : value).trim().toUpperCase();
  return ["POST", "PUT", "PATCH"].includes(method) ? method : "POST";
}

function getSupportedChannelFormats(type) {
  return Array.isArray(CHANNEL_FORMAT_OPTIONS[type]) ? CHANNEL_FORMAT_OPTIONS[type] : [];
}

function normalizeChannelFormat(type, value) {
  const supported = getSupportedChannelFormats(type);
  if (supported.length <= 0) return null;
  const format = String(value == null ? "" : value).trim().toLowerCase();
  return supported.includes(format) ? format : supported[0];
}

function normalizeChannelFormatConfig(raw) {
  const src = raw && typeof raw === "object" ? raw : {};
  const next = {};
  Object.keys(CHANNEL_FORMAT_OPTIONS).forEach((type) => {
    next[type] = normalizeChannelFormat(type, src[type]);
  });
  return next;
}

function getChannelMessageFormat(config, type) {
  const supported = getSupportedChannelFormats(type);
  if (supported.length <= 0) return "text";
  const channelFormats = config && config.channelFormats && typeof config.channelFormats === "object"
    ? config.channelFormats
    : {};
  return normalizeChannelFormat(type, channelFormats[type]) || supported[0];
}

function getConfiguredChannelTypes(config) {
  const next = [];
  const channels = config && config.channels ? config.channels : {};
  if (channels.serverChanSendKey) next.push("serverchan");
  if (channels.pushPlusToken) next.push("pushplus");
  if (channels.wecomWebhook) next.push("wecom");
  if (channels.dingtalkWebhook) next.push("dingtalk");
  if (channels.feishuWebhook) next.push("feishu");
  if (channels.telegramBotToken && channels.telegramChatId) next.push("telegram");
  if (channels.barkDeviceKey) next.push("bark");
  if (channels.ntfyTopic) next.push("ntfy");
  if (channels.webhookUrl) next.push("webhook");
  return next;
}

function resolveSelectedChannelTypes(configLike) {
  const selected = normalizeChannelList(configLike && configLike.selectedChannels ? configLike.selectedChannels : []);
  if (selected.length > 0) return selected;
  const legacy = normalizeChannelList(
    []
      .concat(Array.isArray(configLike && configLike.abnormalChannels) ? configLike.abnormalChannels : [])
      .concat(Array.isArray(configLike && configLike.dailyChannels) ? configLike.dailyChannels : [])
  );
  if (legacy.length > 0) return legacy;
  return getConfiguredChannelTypes(configLike);
}

function normalizeMessagePushConfig(raw) {
  const src = raw && typeof raw === "object" ? raw : {};
  const channels = src.channels && typeof src.channels === "object" ? src.channels : {};
  const selectedChannels = resolveSelectedChannelTypes({
    selectedChannels: src.selectedChannels,
    abnormalChannels: src.abnormalChannels,
    dailyChannels: src.dailyChannels,
    channels,
  });
  return {
    enabled: toBool(src.enabled, false),
    abnormalEnabled: toBool(src.abnormalEnabled, true),
    abnormalTimeoutThreshold: toInt(src.abnormalTimeoutThreshold, 3, 1, 99),
    selectedChannels,
    channelFormats: normalizeChannelFormatConfig(src.channelFormats),
    dailyEnabled: toBool(src.dailyEnabled, false),
    dailyTime: normalizeClockText(src.dailyTime, "09:00"),
    logMonitorEnabled: toBool(src.logMonitorEnabled, true),
    logScanIntervalSec: toInt(src.logScanIntervalSec, 15, 5, 3600),
    httpTimeoutMs: toInt(src.httpTimeoutMs, 10000, 1000, 120000),
    channels: {
      serverChanSendKey: toStringValue(channels.serverChanSendKey).trim(),
      pushPlusToken: toStringValue(channels.pushPlusToken).trim(),
      wecomWebhook: toStringValue(channels.wecomWebhook).trim(),
      dingtalkWebhook: toStringValue(channels.dingtalkWebhook).trim(),
      dingtalkSecret: toStringValue(channels.dingtalkSecret).trim(),
      feishuWebhook: toStringValue(channels.feishuWebhook).trim(),
      telegramBotToken: toStringValue(channels.telegramBotToken).trim(),
      telegramChatId: toStringValue(channels.telegramChatId).trim(),
      barkServerUrl: toStringValue(channels.barkServerUrl, "https://api.day.app").trim() || "https://api.day.app",
      barkDeviceKey: toStringValue(channels.barkDeviceKey).trim(),
      ntfyServerUrl: toStringValue(channels.ntfyServerUrl, "https://ntfy.sh").trim() || "https://ntfy.sh",
      ntfyTopic: toStringValue(channels.ntfyTopic).trim(),
      webhookUrl: toStringValue(channels.webhookUrl).trim(),
      webhookMethod: normalizeWebhookMethod(channels.webhookMethod),
      webhookHeaders: toStringValue(channels.webhookHeaders).trim(),
    },
  };
}

function buildChannelMetaList(config) {
  const configured = new Set(getConfiguredChannelTypes(config));
  return SUPPORTED_CHANNEL_TYPES.map((type) => ({
    type,
    label: CHANNEL_LABELS[type] || type,
    configured: configured.has(type),
  }));
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

function getDateKeyLocal(date) {
  const cur = date instanceof Date ? date : new Date(date || Date.now());
  const year = cur.getFullYear();
  const month = String(cur.getMonth() + 1).padStart(2, "0");
  const day = String(cur.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function shiftDateKey(dateKey, deltaDays) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(dateKey || ""))) return null;
  const [year, month, day] = String(dateKey).split("-").map((item) => Number.parseInt(item, 10));
  const date = new Date(year, month - 1, day);
  if (Number.isNaN(date.getTime())) return null;
  date.setDate(date.getDate() + (Number(deltaDays) || 0));
  return getDateKeyLocal(date);
}

function getNowMinutes(date) {
  const cur = date instanceof Date ? date : new Date(date || Date.now());
  return cur.getHours() * 60 + cur.getMinutes();
}

function limitText(text, maxLength) {
  const raw = String(text == null ? "" : text);
  if (raw.length <= maxLength) return raw;
  return `${raw.slice(0, Math.max(0, maxLength - 3))}...`;
}

function formatDateTime(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const datePart = getDateKeyLocal(date);
  const timePart = [
    String(date.getHours()).padStart(2, "0"),
    String(date.getMinutes()).padStart(2, "0"),
    String(date.getSeconds()).padStart(2, "0"),
  ].join(":");
  return `${datePart} ${timePart}`;
}

function createEmptyRuntimeState() {
  return {
    version: MESSAGE_PUSH_STATE_VERSION,
    lastScanAt: null,
    lastTimeoutAt: null,
    lastRecoveryAt: null,
    consecutiveTimeouts: 0,
    timeoutAlertActive: false,
    recentTimeoutLines: [],
    lastAbnormalNotificationAt: null,
    lastAbnormalNotificationText: null,
    abnormalFingerprints: {},
    lastDailySummaryDateKey: null,
    lastDailySummaryAt: null,
    recentPushes: [],
    logFiles: {},
  };
}

function normalizeRuntimeState(raw) {
  const src = raw && typeof raw === "object" ? raw : {};
  const logFiles = src.logFiles && typeof src.logFiles === "object" ? src.logFiles : {};
  const nextLogFiles = {};
  Object.keys(logFiles).forEach((key) => {
    const item = logFiles[key];
    const position = Number(item && item.position);
    nextLogFiles[key] = {
      position: Number.isFinite(position) && position >= 0 ? position : 0,
    };
  });
  const recentPushes = Array.isArray(src.recentPushes) ? src.recentPushes : [];
  return {
    version: MESSAGE_PUSH_STATE_VERSION,
    lastScanAt: src.lastScanAt ? String(src.lastScanAt) : null,
    lastTimeoutAt: src.lastTimeoutAt ? String(src.lastTimeoutAt) : null,
    lastRecoveryAt: src.lastRecoveryAt ? String(src.lastRecoveryAt) : null,
    consecutiveTimeouts: Math.max(0, Number(src.consecutiveTimeouts) || 0),
    timeoutAlertActive: src.timeoutAlertActive === true,
    recentTimeoutLines: Array.isArray(src.recentTimeoutLines)
      ? src.recentTimeoutLines.map((item) => limitText(item, 300)).slice(-5)
      : [],
    lastAbnormalNotificationAt: src.lastAbnormalNotificationAt ? String(src.lastAbnormalNotificationAt) : null,
    lastAbnormalNotificationText: src.lastAbnormalNotificationText ? String(src.lastAbnormalNotificationText) : null,
    abnormalFingerprints: normalizeAbnormalFingerprintMap(src.abnormalFingerprints),
    lastDailySummaryDateKey: src.lastDailySummaryDateKey ? String(src.lastDailySummaryDateKey) : null,
    lastDailySummaryAt: src.lastDailySummaryAt ? String(src.lastDailySummaryAt) : null,
    recentPushes: recentPushes
      .map((item) => ({
        time: item && item.time ? String(item.time) : null,
        kind: item && item.kind ? String(item.kind) : null,
        title: item && item.title ? limitText(item.title, 120) : null,
        ok: item && item.ok === true,
        channels: Array.isArray(item && item.channels) ? normalizeChannelList(item.channels) : [],
        error: item && item.error ? limitText(item.error, 240) : null,
      }))
      .slice(-MESSAGE_PUSH_HISTORY_LIMIT),
    logFiles: nextLogFiles,
  };
}

function normalizeAbnormalFingerprintMap(raw) {
  const source = raw && typeof raw === "object" ? raw : {};
  const now = Date.now();
  const next = {};
  Object.keys(source).forEach((key) => {
    const textKey = String(key || "").trim();
    const value = source[key];
    const timeMs = value ? new Date(value).getTime() : Number.NaN;
    if (!textKey || Number.isNaN(timeMs)) return;
    if (now - timeMs > ABNORMAL_FINGERPRINT_RETENTION_MS) return;
    next[textKey] = new Date(timeMs).toISOString();
  });
  return next;
}

function buildTimeoutRegexList() {
  return [
    /网络连接超时/i,
    /连接超时/i,
    /\btimed out\b/i,
    /\btimeout\b/i,
    /CDP timeout/i,
    /qq ws call timed out/i,
    /等待小游戏 .*超时/i,
    /等待自动农场空闲超时/i,
    /AUTO_FARM_RUNTIME_BUSY_TIMEOUT/i,
    /request timeout/i,
    /\bETIMEDOUT\b/i,
  ];
}

function buildRecoveryRegexList() {
  return [
    /miniapp client connected/i,
    /小游戏 context 已就绪/i,
    /execution context.*就绪/i,
    /已连接/i,
    /recovered/i,
    /autoReconnectIfNeeded/i,
  ];
}

function buildIgnoredAbnormalRegexList() {
  return [
    /自动化已停止[:：]\s*manual/i,
    /automation_stopped/i,
    /自动农场 \/ 当前轮已停止/i,
  ];
}

function buildGenericErrorNameRegexList() {
  return [
    /\b(?:Error|TypeError|RangeError|ReferenceError|SyntaxError|URIError|EvalError|AggregateError|AbortError|ProtocolError)\b/,
    /\bERR_[A-Z_]+\b/,
    /\b(?:ECONNRESET|ECONNREFUSED|ENOTFOUND|EPIPE|ETIMEDOUT)\b/i,
  ];
}

function buildAbnormalRegexRules() {
  return [
    {
      type: "network",
      label: "网络 / 连接异常",
      patterns: [
        /网络异常/i,
        /网络连接/i,
        /WebSocket/i,
        /\bqq ws\b/i,
        /\bclient error\b/i,
        /\bnot connected\b/i,
        /\bdisconnected\b/i,
        /\bconnect(?:ion)? (?:failed|error|closed|lost)\b/i,
        /连接(?:失败|异常|断开|已断开)/,
        /重连(?:失败|异常)?/,
        /\bsocket\b/i,
      ],
    },
    {
      type: "runtime",
      label: "运行时 / 上下文异常",
      patterns: [
        /\bexecutionContextId\b/i,
        /\bgameCtl\b/i,
        /\bCDP\b/i,
        /\bminiapp\b/i,
        /\bqq host\b/i,
        /\bqq bundle\b/i,
        /小游戏调试桥/,
        /上下文探测失败/,
        /context .*未就绪/,
        /运行时.*(?:未就绪|不可用|缺少|缺失)/,
        /\bnot ready\b/i,
      ],
    },
    {
      type: "request",
      label: "请求 / 协议异常",
      patterns: [
        /\bHTTP\s*[45]\d{2}\b/i,
        /invalid body/i,
        /invalid_json/i,
        /\bProtocolError\b/i,
        /\bunsupported\b/i,
        /\bdenied\b/i,
        /\brejected\b/i,
        /格式不正确/,
        /参数.*(?:错误|无效)/,
        /路径.*不允许/,
      ],
    },
    {
      type: "storage",
      label: "持久化 / 状态异常",
      patterns: [
        /持久化失败/,
        /state_load_failed/i,
        /state.*failed/i,
        /config_load_failed/i,
        /today_stats_load_failed/i,
      ],
    },
    {
      type: "automation",
      label: "调度 / 执行异常",
      patterns: [
        /调度异常/,
        /调度失败/,
        /init failed/i,
        /refresh_failed/i,
        /warehouse_refresh_failed/i,
        /auto start skipped/i,
        /失败/,
        /异常/,
      ],
    },
    {
      type: "resource",
      label: "资源 / 数据异常",
      patterns: [
        /\bmissing\b/i,
        /\bnot found\b/i,
        /\brequired\b/i,
        /\binvalid\b/i,
        /\bunavailable\b/i,
        /未找到/,
        /不存在/,
        /缺少/,
        /缺失/,
        /为空/,
        /无效/,
        /不可用/,
        /不支持/,
      ],
    },
  ];
}

function isTimeoutLogLine(line) {
  const text = stripAnsiText(line).trim();
  if (!text) return false;
  return buildTimeoutRegexList().some((pattern) => pattern.test(text));
}

function isRecoveryLogLine(line) {
  const text = stripAnsiText(line).trim();
  if (!text) return false;
  return buildRecoveryRegexList().some((pattern) => pattern.test(text));
}

function matchAbnormalLogLine(line) {
  const text = stripAnsiText(line).trim();
  if (!text) return null;
  if (buildIgnoredAbnormalRegexList().some((pattern) => pattern.test(text))) return null;
  if (/["']error["']\s*:\s*null/i.test(text)) return null;
  for (const rule of buildAbnormalRegexRules()) {
    if (rule.patterns.some((pattern) => pattern.test(text))) {
      return {
        type: rule.type,
        label: rule.label,
      };
    }
  }
  if (buildGenericErrorNameRegexList().some((pattern) => pattern.test(text))) {
    return {
      type: "exception",
      label: "通用异常",
    };
  }
  return null;
}

function stateFilePath(projectRoot) {
  return path.join(projectRoot, "data", "message-push-state.json");
}

async function loadRuntimeState(projectRoot) {
  try {
    const raw = await fs.readFile(stateFilePath(projectRoot), "utf8");
    return normalizeRuntimeState(JSON.parse(raw));
  } catch (_) {
    return createEmptyRuntimeState();
  }
}

async function saveRuntimeState(projectRoot, state) {
  const filePath = stateFilePath(projectRoot);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const normalized = normalizeRuntimeState(state);
  await fs.writeFile(filePath, JSON.stringify(normalized, null, 2), "utf8");
}

function parseWebhookHeaders(raw) {
  const text = String(raw == null ? "" : raw).trim();
  if (!text) return {};
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch (_) {}
  const headers = {};
  text.split(/\r?\n/).forEach((line) => {
    const index = line.indexOf(":");
    if (index <= 0) return;
    const key = line.slice(0, index).trim();
    const value = line.slice(index + 1).trim();
    if (!key) return;
    headers[key] = value;
  });
  return headers;
}

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("request timeout")), Math.max(1000, Number(timeoutMs) || 10000));
  try {
    return await fetch(url, {
      ...(options && typeof options === "object" ? options : {}),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

async function readAppendedText(filePath, fromPosition) {
  let handle = null;
  try {
    const stat = await fs.stat(filePath);
    const start = Number.isFinite(fromPosition) && fromPosition >= 0 ? fromPosition : stat.size;
    if (stat.size < start) {
      return {
        text: "",
        nextPosition: 0,
        size: stat.size,
      };
    }
    if (stat.size === start) {
      return {
        text: "",
        nextPosition: start,
        size: stat.size,
      };
    }
    const length = stat.size - start;
    handle = await fs.open(filePath, "r");
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, start);
    return {
      text: buffer.toString("utf8"),
      nextPosition: stat.size,
      size: stat.size,
    };
  } finally {
    if (handle) {
      try {
        await handle.close();
      } catch (_) {}
    }
  }
}

function joinUrl(base, suffix) {
  const normalizedBase = String(base || "").replace(/\/+$/, "");
  const normalizedSuffix = String(suffix || "").replace(/^\/+/, "");
  return `${normalizedBase}/${normalizedSuffix}`;
}

function createMessagePayload(kind, title, lines, meta) {
  const lineList = Array.isArray(lines) ? lines.filter(Boolean).map((item) => String(item)) : [];
  return {
    kind,
    title: String(title || "农场消息通知"),
    plainText: [title, ...lineList].filter(Boolean).join("\n"),
    markdownText: [`# ${title}`, ...lineList.map((item) => `- ${item}`)].join("\n"),
    lines: lineList,
    meta: meta && typeof meta === "object" ? { ...meta } : {},
  };
}

function normalizeAbnormalFingerprintText(value) {
  return String(value == null ? "" : value)
    .trim()
    .toLowerCase()
    .replace(/\d{4}-\d{2}-\d{2}[ t]\d{2}:\d{2}:\d{2}(?:\.\d+)?z?/g, "{time}")
    .replace(/\d{1,2}:\d{2}:\d{2}/g, "{time}")
    .replace(/\b\d{4,}\b/g, "{n}")
    .replace(/\s+/g, " ");
}

function buildAbnormalFingerprint(payload) {
  const meta = payload && payload.meta && typeof payload.meta === "object" ? payload.meta : {};
  const type = meta.abnormalType || payload.kind || "abnormal";
  const source = meta.abnormalSource || "";
  const fingerprintBase = meta.abnormalFingerprintBase || type;
  const fingerprintText = normalizeAbnormalFingerprintText(
    meta.abnormalFingerprintText || meta.abnormalText || payload.title || ""
  );
  return crypto
    .createHash("sha1")
    .update([fingerprintBase, type, source, fingerprintText].join("|"))
    .digest("hex")
    .slice(0, 24);
}

function interpretImmediateAbnormal(match, text) {
  const rawText = String(text == null ? "" : text).trim();
  const lowered = rawText.toLowerCase();

  if (
    lowered.includes("no fertilizer available")
    || lowered.includes("normal fertilizer not available")
    || lowered.includes("organic fertilizer not available")
    || lowered.includes("肥料不足")
    || lowered.includes("化肥不足")
  ) {
    return {
      headline: "自动施肥失败",
      summary: "肥料库存不足，本轮自动施肥已跳过。",
      fingerprintBase: "auto_fertilizer_out_of_stock",
      fingerprintText: "auto_fertilizer_out_of_stock",
    };
  }

  if (
    lowered.includes("same_fertilizer_type_already_used")
    || lowered.includes("same fertilizer type already used")
    || rawText.includes("该化肥对同一作物仅能使用1次")
    || rawText.includes("该化肥对同一作物仅能使用一次")
  ) {
    return {
      headline: "自动施肥跳过",
      summary: "同一作物已使用过该类型化肥，本轮不再重复施肥。",
      fingerprintBase: "auto_fertilizer_duplicate_type",
      fingerprintText: "auto_fertilizer_duplicate_type",
    };
  }

  if (
    lowered.includes("target land is not fertilizable right now")
    || rawText.includes("不可施肥")
  ) {
    return {
      headline: "自动施肥失败",
      summary: "目标地块当前不可施肥，已跳过本次施肥动作。",
      fingerprintBase: "auto_fertilizer_land_not_ready",
      fingerprintText: "auto_fertilizer_land_not_ready",
    };
  }

  if (
    lowered.includes("warehouse_refresh_failed")
    || lowered.includes("warehouse_open_failed")
  ) {
    return {
      headline: "仓库刷新失败",
      summary: "仓库快照读取失败，当前仓库缓存可能不是最新数据。",
      fingerprintBase: "warehouse_refresh_failed",
      fingerprintText: "warehouse_refresh_failed",
    };
  }

  if (
    lowered.includes("等待自动农场空闲超时")
    || lowered.includes("auto_farm_runtime_busy_timeout")
  ) {
    return {
      headline: "运行时繁忙",
      summary: "当前有其他自动化任务占用运行时，本次动作已顺延。",
      fingerprintBase: "runtime_busy_timeout",
      fingerprintText: "runtime_busy_timeout",
    };
  }

  if (
    lowered.includes("websocket")
    || lowered.includes("not connected")
    || lowered.includes("disconnected")
    || rawText.includes("连接失败")
    || rawText.includes("连接异常")
    || rawText.includes("连接断开")
  ) {
    return {
      headline: "连接异常",
      summary: "控制通道或小游戏宿主连接异常，自动化可能暂时不可执行。",
      fingerprintBase: "runtime_connection_issue",
      fingerprintText: normalizeAbnormalFingerprintText(rawText),
    };
  }

  if (
    lowered.includes("protocolerror")
    || lowered.includes("invalid body")
    || rawText.includes("参数错误")
    || rawText.includes("格式不正确")
  ) {
    return {
      headline: "请求异常",
      summary: "请求或协议数据异常，当前动作未成功执行。",
      fingerprintBase: "request_protocol_issue",
      fingerprintText: normalizeAbnormalFingerprintText(rawText),
    };
  }

  return {
    headline: match && match.label ? match.label : "通用异常",
    summary: "检测到异常日志，请结合详情排查。",
    fingerprintBase: match && match.type ? match.type : "exception",
    fingerprintText: normalizeAbnormalFingerprintText(rawText),
  };
}

function buildImmediateAbnormalPayload(match, text, options) {
  const opts = options && typeof options === "object" ? options : {};
  const statusSnapshot = opts.statusSnapshot && typeof opts.statusSnapshot === "object"
    ? opts.statusSnapshot
    : null;
  const interpreted = interpretImmediateAbnormal(match, text);
  const lines = [
    `异常类型：${interpreted.headline}`,
    opts.occurredAt ? `发生时间：${formatDateTime(opts.occurredAt)}` : "",
    opts.sourceLabel ? `异常来源：${opts.sourceLabel}` : "",
    interpreted.summary ? `业务判断：${interpreted.summary}` : "",
    `异常详情：${limitText(text, 500)}`,
    ...buildStatusSummaryLines(statusSnapshot),
  ].filter(Boolean);
  return createMessagePayload("abnormal", "农场异常通知", lines, {
    abnormalType: match && match.type ? match.type : "exception",
    abnormalLabel: interpreted.headline,
    abnormalSource: opts.sourceLabel || null,
    abnormalText: limitText(text, 300),
    abnormalFingerprintBase: interpreted.fingerprintBase,
    abnormalFingerprintText: interpreted.fingerprintText,
    abnormalSummary: interpreted.summary,
    occurredAt: opts.occurredAt || null,
  });
}

async function sendToServerChan(config, payload) {
  const sendKey = config.channels.serverChanSendKey;
  const body = new URLSearchParams({
    title: payload.title,
    desp: payload.markdownText,
  });
  const response = await fetchWithTimeout(`https://sctapi.ftqq.com/${encodeURIComponent(sendKey)}.send`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" },
    body,
  }, config.httpTimeoutMs);
  if (!response.ok) {
    throw new Error(`Server酱 HTTP ${response.status}`);
  }
}

async function sendToPushPlus(config, payload) {
  const format = getChannelMessageFormat(config, "pushplus");
  const response = await fetchWithTimeout("https://www.pushplus.plus/send", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      token: config.channels.pushPlusToken,
      title: payload.title,
      content: format === "text" ? payload.plainText : payload.markdownText,
      template: format === "text" ? "txt" : "markdown",
    }),
  }, config.httpTimeoutMs);
  if (!response.ok) {
    throw new Error(`PushPlus HTTP ${response.status}`);
  }
}

async function sendToWecom(config, payload) {
  const format = getChannelMessageFormat(config, "wecom");
  const body = format === "text"
    ? {
        msgtype: "text",
        text: {
          content: payload.plainText,
        },
      }
    : {
        msgtype: "markdown",
        markdown: {
          content: payload.markdownText,
        },
      };
  const response = await fetchWithTimeout(config.channels.wecomWebhook, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }, config.httpTimeoutMs);
  if (!response.ok) {
    throw new Error(`企业微信 HTTP ${response.status}`);
  }
}

function buildDingtalkSignedUrl(webhook, secret) {
  if (!secret) return webhook;
  const timestamp = Date.now();
  const sign = crypto
    .createHmac("sha256", secret)
    .update(`${timestamp}\n${secret}`)
    .digest("base64");
  const signParam = encodeURIComponent(sign);
  const divider = webhook.includes("?") ? "&" : "?";
  return `${webhook}${divider}timestamp=${timestamp}&sign=${signParam}`;
}

async function sendToDingtalk(config, payload) {
  const format = getChannelMessageFormat(config, "dingtalk");
  const body = format === "text"
    ? {
        msgtype: "text",
        text: {
          content: payload.plainText,
        },
      }
    : {
        msgtype: "markdown",
        markdown: {
          title: payload.title,
          text: payload.markdownText,
        },
      };
  const response = await fetchWithTimeout(buildDingtalkSignedUrl(config.channels.dingtalkWebhook, config.channels.dingtalkSecret), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }, config.httpTimeoutMs);
  if (!response.ok) {
    throw new Error(`钉钉 HTTP ${response.status}`);
  }
}

async function sendToFeishu(config, payload) {
  const response = await fetchWithTimeout(config.channels.feishuWebhook, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      msg_type: "text",
      content: {
        text: payload.plainText,
      },
    }),
  }, config.httpTimeoutMs);
  if (!response.ok) {
    throw new Error(`飞书 HTTP ${response.status}`);
  }
}

async function sendToTelegram(config, payload) {
  const url = `https://api.telegram.org/bot${encodeURIComponent(config.channels.telegramBotToken)}/sendMessage`;
  const response = await fetchWithTimeout(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: config.channels.telegramChatId,
      text: payload.plainText,
      disable_web_page_preview: true,
    }),
  }, config.httpTimeoutMs);
  if (!response.ok) {
    throw new Error(`Telegram HTTP ${response.status}`);
  }
}

async function sendToBark(config, payload) {
  const format = getChannelMessageFormat(config, "bark");
  const barkUrl = joinUrl(config.channels.barkServerUrl, config.channels.barkDeviceKey);
  const response = await fetchWithTimeout(barkUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify(format === "markdown"
      ? {
          title: payload.title,
          markdown: payload.markdownText,
        }
      : {
          title: payload.title,
          body: payload.plainText,
        }),
  }, config.httpTimeoutMs);
  if (!response.ok) {
    throw new Error(`Bark HTTP ${response.status}`);
  }
}

async function sendToNtfy(config, payload) {
  const format = getChannelMessageFormat(config, "ntfy");
  const response = await fetchWithTimeout(joinUrl(config.channels.ntfyServerUrl, config.channels.ntfyTopic), {
    method: "POST",
    headers: {
      "Content-Type": format === "markdown" ? "text/markdown; charset=utf-8" : "text/plain; charset=utf-8",
      "Title": payload.title,
      "Tags": "seedling,warning",
    },
    body: format === "markdown" ? payload.markdownText : payload.plainText,
  }, config.httpTimeoutMs);
  if (!response.ok) {
    throw new Error(`ntfy HTTP ${response.status}`);
  }
}

async function sendToWebhook(config, payload) {
  const headers = {
    "Content-Type": "application/json",
    ...parseWebhookHeaders(config.channels.webhookHeaders),
  };
  const response = await fetchWithTimeout(config.channels.webhookUrl, {
    method: config.channels.webhookMethod,
    headers,
    body: JSON.stringify({
      source: "qq-farm-cdp-auto",
      title: payload.title,
      text: payload.plainText,
      markdown: payload.markdownText,
      kind: payload.kind,
      meta: payload.meta,
      sentAt: new Date().toISOString(),
    }),
  }, config.httpTimeoutMs);
  if (!response.ok) {
    throw new Error(`Webhook HTTP ${response.status}`);
  }
}

async function sendByChannel(type, config, payload) {
  if (type === "serverchan") return await sendToServerChan(config, payload);
  if (type === "pushplus") return await sendToPushPlus(config, payload);
  if (type === "wecom") return await sendToWecom(config, payload);
  if (type === "dingtalk") return await sendToDingtalk(config, payload);
  if (type === "feishu") return await sendToFeishu(config, payload);
  if (type === "telegram") return await sendToTelegram(config, payload);
  if (type === "bark") return await sendToBark(config, payload);
  if (type === "ntfy") return await sendToNtfy(config, payload);
  if (type === "webhook") return await sendToWebhook(config, payload);
  throw new Error(`unsupported channel: ${type}`);
}

function pickAvailableChannels(config, requestedTypes) {
  const configured = new Set(getConfiguredChannelTypes(config));
  const source = requestedTypes != null
    ? requestedTypes
    : resolveSelectedChannelTypes(config);
  return normalizeChannelList(source).filter((type) => configured.has(type));
}

function buildStatusSummaryLines(statusSnapshot) {
  const state = statusSnapshot && typeof statusSnapshot === "object" ? statusSnapshot : null;
  if (!state) return [];
  const summary = [];
  summary.push(`自动农场：${state.running ? "运行中" : "已停止"}`);
  if (state.busy) {
    summary.push("当前轮次执行中");
  }
  if (state.runtime && state.runtime.resolvedTarget) {
    summary.push(`运行时：${state.runtime.resolvedTarget}`);
  }
  if (state.nextRunAt) {
    summary.push(`下次调度：${formatDateTime(state.nextRunAt)}`);
  }
  if (state.lastFinishedAt) {
    summary.push(`上次完成：${formatDateTime(state.lastFinishedAt)}`);
  }
  if (state.lastError) {
    summary.push(`最近错误：${state.lastError}`);
  }
  return summary;
}

function buildAbnormalPayload(runtimeState, threshold, statusSnapshot) {
  const recentLines = Array.isArray(runtimeState.recentTimeoutLines) ? runtimeState.recentTimeoutLines : [];
  const lines = [
    `异常类型：连接超时累计达到 ${runtimeState.consecutiveTimeouts} 次（阈值 ${threshold}）`,
    runtimeState.lastTimeoutAt ? `最近超时：${formatDateTime(runtimeState.lastTimeoutAt)}` : "",
    ...buildStatusSummaryLines(statusSnapshot),
    recentLines.length ? `最近日志：${recentLines.slice(-3).join(" | ")}` : "",
  ].filter(Boolean);
  return createMessagePayload("abnormal", "农场异常通知", lines, {
    abnormalType: "timeout_threshold",
    abnormalLabel: "连接超时告警",
    abnormalSource: "日志监控",
    abnormalFingerprintBase: "timeout_threshold",
    abnormalFingerprintText: "timeout_threshold",
    consecutiveTimeouts: runtimeState.consecutiveTimeouts,
    lastTimeoutAt: runtimeState.lastTimeoutAt,
    recentTimeoutLines: recentLines.slice(-3),
  });
}

async function buildDailyPayload(projectRoot, stats, dateKey) {
  const src = stats && typeof stats === "object" ? stats : {};
  let profile = null;
  try {
    const cacheState = await readPlayerProfileCache(projectRoot, {
      maxAgeMs: 7 * 24 * 60 * 60 * 1000,
    });
    profile = cacheState && cacheState.profile ? cacheState.profile : null;
  } catch (_) {
    profile = null;
  }
  const lines = [
    `统计日期：${dateKey}`,
    `账户：${profile && profile.name ? profile.name : "--"} · gid=${profile && profile.gid != null ? profile.gid : "--"} · Lv.${profile && profile.level != null ? profile.level : "--"}`,
    `资产：金币 ${Number(profile && profile.gold) || 0} · 金豆 ${Number(profile && profile.bean) || 0}`,
    `总运行 ${Number(src.runs) || 0} 轮，自己 ${Number(src.ownRuns) || 0} 轮，好友 ${Number(src.friendRuns) || 0} 轮`,
    `收获 ${Number(src.collect) || 0}，浇水 ${Number(src.water) || 0}，除草 ${Number(src.eraseGrass) || 0}，杀虫 ${Number(src.killBug) || 0}`,
    `施肥 ${Number(src.fertilize) || 0}，种植 ${Number(src.plant) || 0}，偷菜 ${Number(src.steal) || 0}`,
    `帮浇水 ${Number(src.helpWater) || 0}，帮除草 ${Number(src.helpEraseGrass) || 0}，帮除虫 ${Number(src.helpKillBug) || 0}`,
    `出售次数 ${Number(src.sell) || 0}，出售金币 ${Number(src.sellGold) || 0}`,
  ];
  return createMessagePayload("daily", `农场日报 ${dateKey}`, lines, {
    dateKey,
    stats: src,
    profile: profile || null,
  });
}

class MessagePushManager {
  constructor(opts) {
    const options = opts && typeof opts === "object" ? opts : {};
    this.projectRoot = options.projectRoot;
    this.logFiles = Array.isArray(options.logFiles) ? options.logFiles.filter(Boolean) : [];
    this.getStatusSnapshot = typeof options.getStatusSnapshot === "function"
      ? options.getStatusSnapshot
      : null;
    this.config = normalizeMessagePushConfig(options.initialConfig);
    this.runtimeState = createEmptyRuntimeState();
    this.partialLineMap = new Map();
    this.timer = null;
    this.running = false;
    this.tickPromise = Promise.resolve();
    this.lastPersistPromise = Promise.resolve();
    this.statusEventCursorInitialized = false;
    this.lastStatusEventKey = null;
    this.abnormalPushArmed = false;
    this.abnormalPushArmedAt = null;
  }

  async init() {
    this.runtimeState = await loadRuntimeState(this.projectRoot);
    await this._ensureLogCursorsInitialized();
    await this._persistState();
  }

  updateConfig(raw) {
    this.config = normalizeMessagePushConfig(raw);
    if (this.running) {
      this._scheduleNextTick(500);
    }
    return this.config;
  }

  getState() {
    const config = this.config;
    const availableChannels = buildChannelMetaList(config);
    const configuredTypes = getConfiguredChannelTypes(config);
    const dailyMinutes = parseClockMinutes(config.dailyTime);
    const now = new Date();
    let nextDailyDateTime = null;
    if (dailyMinutes != null) {
      const next = new Date(now.getTime());
      next.setHours(Math.floor(dailyMinutes / 60), dailyMinutes % 60, 0, 0);
      if (next.getTime() <= now.getTime()) {
        next.setDate(next.getDate() + 1);
      }
      nextDailyDateTime = next.toISOString();
    }
    return {
      enabled: config.enabled,
      config,
      configuredChannels: configuredTypes,
      channels: availableChannels,
      abnormal: {
        enabled: config.enabled && config.abnormalEnabled,
        channels: pickAvailableChannels(config),
        threshold: config.abnormalTimeoutThreshold,
        armed: this.abnormalPushArmed,
        armedAt: this.abnormalPushArmedAt,
        consecutiveTimeouts: this.runtimeState.consecutiveTimeouts,
        alertActive: this.runtimeState.timeoutAlertActive,
        lastTimeoutAt: this.runtimeState.lastTimeoutAt,
        lastRecoveryAt: this.runtimeState.lastRecoveryAt,
        recentTimeoutLines: [...this.runtimeState.recentTimeoutLines],
        lastNotificationAt: this.runtimeState.lastAbnormalNotificationAt,
        lastNotificationText: this.runtimeState.lastAbnormalNotificationText,
      },
      daily: {
        enabled: config.enabled && config.dailyEnabled,
        channels: pickAvailableChannels(config),
        time: config.dailyTime,
        nextRunAt: nextDailyDateTime,
        lastSummaryDateKey: this.runtimeState.lastDailySummaryDateKey,
        lastSummaryAt: this.runtimeState.lastDailySummaryAt,
      },
      recentPushes: [...this.runtimeState.recentPushes].reverse(),
      lastScanAt: this.runtimeState.lastScanAt,
      logMonitorEnabled: config.enabled && config.logMonitorEnabled,
    };
  }

  async start() {
    if (this.running) return;
    this.running = true;
    if (!this.runtimeState || !this.runtimeState.version) {
      await this.init();
    }
    this._scheduleNextTick(1000);
  }

  async close() {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    await this.lastPersistPromise.catch(() => {});
  }

  async sendTest(customConfig) {
    const config = normalizeMessagePushConfig(customConfig || this.config);
    const candidates = new Set([...pickAvailableChannels(config), ...getConfiguredChannelTypes(config)]);
    const channelTypes = Array.from(candidates);
    if (!channelTypes.length) {
      throw new Error("未配置任何可用推送渠道");
    }
    const payload = createMessagePayload("test", "农场测试推送", [
      "这是一条测试消息，用于验证渠道配置是否可用。",
      `发送时间：${formatDateTime(new Date())}`,
      "如果你收到了这条消息，说明当前渠道已经可以正常接收通知。",
    ], {});
    return await this._sendPayload(config, channelTypes, payload);
  }

  async _scheduleTick() {
    if (!this.running) return;
    this.tickPromise = this.tickPromise
      .catch(() => {})
      .then(async () => {
        await this._runTick();
      });
    await this.tickPromise;
  }

  _scheduleNextTick(delayMs) {
    if (!this.running) return;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const delay = Math.max(250, Number(delayMs) || this.config.logScanIntervalSec * 1000);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this._scheduleTick();
    }, delay);
  }

  async _runTick() {
    try {
      const statusSnapshot = this._getStatusSnapshotSafe();
      await this._refreshAbnormalPushGate(statusSnapshot);
      await this._scanLogs();
      await this._scanStatusEvents();
      await this._maybeSendDailySummary();
      this.runtimeState.lastScanAt = new Date().toISOString();
      await this._persistState();
    } finally {
      this._scheduleNextTick(this.config.logScanIntervalSec * 1000);
    }
  }

  _getStatusSnapshotSafe() {
    if (typeof this.getStatusSnapshot !== "function") return null;
    try {
      return this.getStatusSnapshot();
    } catch (_) {
      return null;
    }
  }

  _isStatusSnapshotConnected(statusSnapshot) {
    const runtime = statusSnapshot && statusSnapshot.runtime && typeof statusSnapshot.runtime === "object"
      ? statusSnapshot.runtime
      : null;
    if (!runtime) return false;
    const configuredTarget = String(runtime.configuredTarget || "").trim().toLowerCase();
    const resolvedTarget = String(runtime.resolvedTarget || "").trim().toLowerCase();
    const qqWs = runtime.qqWs && typeof runtime.qqWs === "object" ? runtime.qqWs : null;
    const cdp = runtime.cdp && typeof runtime.cdp === "object" ? runtime.cdp : null;
    const qqConnected = !!(qqWs && (qqWs.ready || qqWs.connected));
    const cdpConnected = !!(cdp && (cdp.contextReady || cdp.transportConnected || cdp.connected));
    const target = resolvedTarget || configuredTarget;
    if (target === "qq_ws") return qqConnected;
    if (target === "cdp") return cdpConnected;
    if (configuredTarget === "auto") return qqConnected || cdpConnected;
    return qqConnected || cdpConnected;
  }

  async _refreshAbnormalPushGate(statusSnapshot) {
    if (this.abnormalPushArmed) return;
    if (!this._isStatusSnapshotConnected(statusSnapshot)) return;
    await this._resetObservationCursors(statusSnapshot);
    this.abnormalPushArmed = true;
    this.abnormalPushArmedAt = new Date().toISOString();
    this.runtimeState.consecutiveTimeouts = 0;
    this.runtimeState.timeoutAlertActive = false;
    this.runtimeState.recentTimeoutLines = [];
  }

  async _resetObservationCursors(statusSnapshot) {
    for (const filePath of this.logFiles) {
      const key = path.relative(this.projectRoot, filePath) || filePath;
      try {
        const stat = await fs.stat(filePath);
        this.runtimeState.logFiles[key] = { position: stat.size };
      } catch (_) {
        this.runtimeState.logFiles[key] = { position: 0 };
      }
      this.partialLineMap.set(key, "");
    }
    const recentEvents = Array.isArray(statusSnapshot && statusSnapshot.recentEvents)
      ? statusSnapshot.recentEvents
      : [];
    this.statusEventCursorInitialized = true;
    this.lastStatusEventKey = recentEvents.length > 0
      ? this._buildStatusEventKey(recentEvents[recentEvents.length - 1])
      : null;
  }

  async _ensureLogCursorsInitialized() {
    for (const filePath of this.logFiles) {
      const key = path.relative(this.projectRoot, filePath) || filePath;
      if (this.runtimeState.logFiles[key]) continue;
      try {
        const stat = await fs.stat(filePath);
        this.runtimeState.logFiles[key] = { position: stat.size };
      } catch (_) {
        this.runtimeState.logFiles[key] = { position: 0 };
      }
    }
  }

  async _scanLogs() {
    if (!(this.config.enabled && this.config.logMonitorEnabled)) return;
    for (const filePath of this.logFiles) {
      const key = path.relative(this.projectRoot, filePath) || filePath;
      const cursor = this.runtimeState.logFiles[key] || { position: 0 };
      let result;
      try {
        result = await readAppendedText(filePath, cursor.position);
      } catch (_) {
        continue;
      }
      this.runtimeState.logFiles[key] = {
        position: result.nextPosition,
      };
      if (!result.text) continue;
      const leftover = this.partialLineMap.get(key) || "";
      const merged = `${leftover}${result.text}`;
      const lines = merged.split(/\r?\n/);
      const lastLine = lines.pop();
      this.partialLineMap.set(key, lastLine || "");
      for (const line of lines) {
        await this._consumeLogLine(line, key);
      }
    }
  }

  async _scanStatusEvents() {
    const snapshot = this._getStatusSnapshotSafe();
    const recentEvents = Array.isArray(snapshot && snapshot.recentEvents) ? snapshot.recentEvents : [];
    if (!this.statusEventCursorInitialized) {
      this.statusEventCursorInitialized = true;
      this.lastStatusEventKey = recentEvents.length > 0
        ? this._buildStatusEventKey(recentEvents[recentEvents.length - 1])
        : null;
      return;
    }
    let startIndex = 0;
    if (this.lastStatusEventKey) {
      const index = recentEvents.findIndex((item) => this._buildStatusEventKey(item) === this.lastStatusEventKey);
      startIndex = index >= 0 ? index + 1 : Math.max(0, recentEvents.length - 10);
    }
    for (let i = startIndex; i < recentEvents.length; i += 1) {
      await this._consumeStatusEvent(recentEvents[i], snapshot);
    }
    this.lastStatusEventKey = recentEvents.length > 0
      ? this._buildStatusEventKey(recentEvents[recentEvents.length - 1])
      : null;
  }

  _buildStatusEventKey(event) {
    const cur = event && typeof event === "object" ? event : {};
    return [
      cur.time || "",
      cur.level || "",
      cur.cycleId || "",
      cur.cycleSeq == null ? "" : cur.cycleSeq,
      cur.category || "",
      cur.message || "",
    ].join("|");
  }

  async _consumeStatusEvent(event, statusSnapshot) {
    const cur = event && typeof event === "object" ? event : {};
    const level = String(cur.level || "").trim().toLowerCase();
    if (!ABNORMAL_EVENT_LEVELS.has(level)) return;
    const sourceLabel = level === "error" ? "自动农场错误事件" : "自动农场告警事件";
    await this._consumeObservedText(cur.message, {
      occurredAt: cur.time || null,
      sourceLabel,
      statusSnapshot,
    });
  }

  async _consumeLogLine(line, sourceKey) {
    await this._consumeObservedText(line, {
      sourceLabel: sourceKey ? `日志监控 ${sourceKey}` : "日志监控",
    });
  }

  async _consumeObservedText(line, options) {
    const text = stripAnsiText(line).trim();
    if (!text) return;
    const opts = options && typeof options === "object" ? options : {};
    if (!this.abnormalPushArmed) return;
    if (isTimeoutLogLine(text)) {
      this.runtimeState.consecutiveTimeouts += 1;
      this.runtimeState.lastTimeoutAt = new Date().toISOString();
      this.runtimeState.recentTimeoutLines.push(limitText(text, 300));
      if (this.runtimeState.recentTimeoutLines.length > 5) {
        this.runtimeState.recentTimeoutLines.splice(0, this.runtimeState.recentTimeoutLines.length - 5);
      }
      if (
        !this.runtimeState.timeoutAlertActive
        && this.runtimeState.consecutiveTimeouts >= this.config.abnormalTimeoutThreshold
        && this.config.enabled
        && this.config.abnormalEnabled
      ) {
        const payload = buildAbnormalPayload(
          this.runtimeState,
          this.config.abnormalTimeoutThreshold,
          opts.statusSnapshot || (this.getStatusSnapshot ? this.getStatusSnapshot() : null),
        );
        const channels = pickAvailableChannels(this.config);
        if (channels.length > 0) {
          await this._sendAbnormalPayload(this.config, channels, payload, opts.occurredAt || new Date().toISOString());
        }
        this.runtimeState.timeoutAlertActive = true;
      }
      return;
    }
    if (isRecoveryLogLine(text)) {
      this.runtimeState.consecutiveTimeouts = 0;
      this.runtimeState.timeoutAlertActive = false;
      this.runtimeState.lastRecoveryAt = new Date().toISOString();
      this.runtimeState.recentTimeoutLines = [];
      return;
    }
    const abnormalMatch = matchAbnormalLogLine(text);
    if (!abnormalMatch) return;
    if (!(this.config.enabled && this.config.abnormalEnabled)) return;
    const channels = pickAvailableChannels(this.config);
    if (!channels.length) return;
    const payload = buildImmediateAbnormalPayload(abnormalMatch, text, {
      occurredAt: opts.occurredAt || new Date().toISOString(),
      sourceLabel: opts.sourceLabel || "日志监控",
      statusSnapshot: opts.statusSnapshot || (this.getStatusSnapshot ? this.getStatusSnapshot() : null),
    });
    await this._sendAbnormalPayload(this.config, channels, payload, opts.occurredAt || new Date().toISOString());
  }

  async _maybeSendDailySummary() {
    const config = this.config;
    if (!(config.enabled && config.dailyEnabled)) return;
    const dailyMinutes = parseClockMinutes(config.dailyTime);
    if (dailyMinutes == null) return;
    if (getNowMinutes(new Date()) < dailyMinutes) return;
    const todayKey = getDateKeyLocal(new Date());
    const targetDateKey = shiftDateKey(todayKey, -1);
    if (!targetDateKey) return;
    if (this.runtimeState.lastDailySummaryDateKey === targetDateKey) return;
    const channels = pickAvailableChannels(config);
    if (!channels.length) return;
    const entry = await readAutoFarmDailyStats(this.projectRoot, targetDateKey, {
      createIfMissing: false,
    });
    const payload = await buildDailyPayload(this.projectRoot, entry && entry.state ? entry.state : null, targetDateKey);
    await this._sendPayload(config, channels, payload);
    this.runtimeState.lastDailySummaryDateKey = targetDateKey;
    this.runtimeState.lastDailySummaryAt = new Date().toISOString();
  }

  async _sendPayload(config, channelTypes, payload) {
    const results = [];
    for (const type of channelTypes) {
      try {
        await sendByChannel(type, config, payload);
        results.push({
          type,
          ok: true,
          error: null,
        });
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        results.push({
          type,
          ok: false,
          error: err.message,
        });
      }
    }
    const okCount = results.filter((item) => item.ok).length;
    const errorCount = results.length - okCount;
    const summary = errorCount <= 0
      ? `已推送到 ${okCount} 个渠道`
      : `成功 ${okCount} 个，失败 ${errorCount} 个`;
    this.runtimeState.recentPushes.push({
      time: new Date().toISOString(),
      kind: payload.kind,
      title: payload.title,
      ok: errorCount <= 0,
      channels: channelTypes,
      error: errorCount > 0
        ? results.filter((item) => !item.ok).map((item) => `${CHANNEL_LABELS[item.type] || item.type}: ${item.error}`).join(" | ")
        : null,
    });
    if (this.runtimeState.recentPushes.length > MESSAGE_PUSH_HISTORY_LIMIT) {
      this.runtimeState.recentPushes.splice(0, this.runtimeState.recentPushes.length - MESSAGE_PUSH_HISTORY_LIMIT);
    }
    await this._persistState();
    return {
      ok: errorCount <= 0,
      summary,
      results,
      payload,
    };
  }

  _shouldSuppressAbnormalFingerprint(fingerprint, occurredAt) {
    const key = String(fingerprint || "").trim();
    if (!key) return false;
    this.runtimeState.abnormalFingerprints = normalizeAbnormalFingerprintMap(this.runtimeState.abnormalFingerprints);
    const previous = this.runtimeState.abnormalFingerprints[key];
    if (!previous) return false;
    const previousMs = new Date(previous).getTime();
    const currentMs = occurredAt ? new Date(occurredAt).getTime() : Date.now();
    if (Number.isNaN(previousMs) || Number.isNaN(currentMs)) return false;
    return currentMs - previousMs < ABNORMAL_DEDUP_WINDOW_MS;
  }

  _recordAbnormalFingerprint(fingerprint, occurredAt) {
    const key = String(fingerprint || "").trim();
    if (!key) return;
    this.runtimeState.abnormalFingerprints = normalizeAbnormalFingerprintMap(this.runtimeState.abnormalFingerprints);
    this.runtimeState.abnormalFingerprints[key] = new Date(occurredAt || Date.now()).toISOString();
  }

  async _sendAbnormalPayload(config, channelTypes, payload, occurredAt) {
    const fingerprint = buildAbnormalFingerprint(payload);
    if (this._shouldSuppressAbnormalFingerprint(fingerprint, occurredAt)) {
      return {
        ok: true,
        suppressed: true,
        fingerprint,
        summary: "同类异常 1 小时内已推送，已抑制重复通知",
      };
    }
    const result = await this._sendPayload(config, channelTypes, payload);
    this._recordAbnormalFingerprint(fingerprint, occurredAt);
    this.runtimeState.lastAbnormalNotificationAt = new Date().toISOString();
    this.runtimeState.lastAbnormalNotificationText = result.summary;
    return {
      ...result,
      fingerprint,
      suppressed: false,
    };
  }

  async _persistState() {
    const snapshot = normalizeRuntimeState(this.runtimeState);
    this.lastPersistPromise = this.lastPersistPromise
      .catch(() => {})
      .then(async () => {
        await saveRuntimeState(this.projectRoot, snapshot);
      });
    await this.lastPersistPromise;
  }
}

module.exports = {
  CHANNEL_LABELS,
  MESSAGE_PUSH_STATE_VERSION,
  SUPPORTED_CHANNEL_TYPES,
  MessagePushManager,
  buildChannelMetaList,
  getConfiguredChannelTypes,
  normalizeMessagePushConfig,
};
