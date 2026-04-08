"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");

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
  };
}

function wrapCallExpression(dotPath, args) {
  const parts = String(dotPath || "").split(".").filter(Boolean);
  if (parts.length === 0) throw new Error("call.path empty");
  const jsonArgs = JSON.stringify(args ?? []);
  return `(async () => {
    const _path = ${JSON.stringify(parts)};
    let cur = globalThis;
    for (let i = 0; i < _path.length; i++) {
      cur = cur[_path[i]];
      if (cur == null) throw new Error('call path not found at: ' + _path.slice(0, i + 1).join('.'));
    }
    if (typeof cur !== 'function') throw new Error('call path is not a function: ' + _path.join('.'));
    return await cur.apply(null, ${jsonArgs});
  })()`;
}

class AutoFarmManager {
  /**
   * @param {{
   *   ensureCdp: () => Promise<any>,
   *   getCdp: () => any,
   *   projectRoot: string,
   * }} opts
   */
  constructor(opts) {
    this.ensureCdp = opts.ensureCdp;
    this.getCdp = opts.getCdp;
    this.projectRoot = opts.projectRoot;
    this.buttonScriptPath = path.join(this.projectRoot, "button.js");
    this.buttonScriptCache = null;
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
    this.config = normalizeAutoFarmConfig({});
  }

  updateConfig(raw) {
    this.config = normalizeAutoFarmConfig({ ...this.config, ...(raw && typeof raw === "object" ? raw : {}) });
    return this.config;
  }

  getState() {
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
      config: { ...this.config },
      recentEvents: [...this.recentEvents],
      cdp: this.getCdp() && typeof this.getCdp().getStatusSnapshot === "function"
        ? this.getCdp().getStatusSnapshot()
        : null,
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
    const entry = {
      time: new Date().toISOString(),
      level,
      message,
    };
    if (extra !== undefined) entry.extra = extra;
    this.recentEvents.push(entry);
    if (this.recentEvents.length > 40) {
      this.recentEvents.splice(0, this.recentEvents.length - 40);
    }
  }

  _schedule(delayMs) {
    if (!this.running) return;
    if (this.timer) clearTimeout(this.timer);
    const delay = Math.max(25, Number(delayMs) || 25);
    this.nextRunAt = new Date(Date.now() + delay).toISOString();
    this.timer = setTimeout(() => {
      this.timer = null;
      void this._tick();
    }, delay);
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
    try {
      await this._runCycle(false, due);
    } finally {
      if (this.running) {
        this._schedule(this._computeNextDelayMs(Date.now()));
      }
    }
  }

  async _readButtonScript() {
    if (this.buttonScriptCache != null) return this.buttonScriptCache;
    this.buttonScriptCache = await fs.readFile(this.buttonScriptPath, "utf8");
    return this.buttonScriptCache;
  }

  async _ensureGameCtl(session) {
    const probeExpr = `(() => ({
      hasGameCtl: typeof gameCtl === "object",
      hasRunAutoFarmCycle: typeof gameCtl === "object" && typeof gameCtl.runAutoFarmCycle === "function",
      hasEnterOwnFarm: typeof gameCtl === "object" && typeof gameCtl.enterOwnFarm === "function"
    }))()`;

    let state = null;
    try {
      state = await session.evaluate(probeExpr, { awaitPromise: true });
    } catch (_) {
      state = null;
    }
    if (state && state.hasRunAutoFarmCycle && state.hasEnterOwnFarm) {
      return { injected: false, state };
    }

    const script = await this._readButtonScript();
    await session.evaluate(`(async () => { ${script}\n; return { injected: true }; })()`, {
      awaitPromise: true,
    });
    state = await session.evaluate(probeExpr, { awaitPromise: true });
    if (!state || !state.hasRunAutoFarmCycle) {
      throw new Error("button.js 注入后 gameCtl.runAutoFarmCycle 仍不可用");
    }
    return { injected: true, state };
  }

  async _callGameCtl(session, pathName, args) {
    const expr = wrapCallExpression(pathName, args);
    return await session.evaluate(expr, { awaitPromise: true });
  }

  async _runCycle(force, dueFlags) {
    const now = Date.now();
    const due = dueFlags || this._getDueFlags(now, force);
    if (!due.ownDue && !due.friendDue) {
      return this.getState();
    }

    this.busy = true;
    this.lastStartedAt = new Date().toISOString();
    this.lastError = null;
    if (due.ownDue) this.lastOwnRunAt = now;
    if (due.friendDue) this.lastFriendRunAt = now;

    try {
      const session = await this.ensureCdp();
      const injectState = await this._ensureGameCtl(session);
      const cycleOpts = {
        ownFarmEnabled: due.ownDue,
        friendStealEnabled: due.friendDue,
        enterWaitMs: this.config.autoFarmEnterWaitMs,
        actionWaitMs: this.config.autoFarmActionWaitMs,
        maxFriends: this.config.autoFarmMaxFriends,
        refreshFriendList: this.config.autoFarmRefreshFriendList,
        returnHome: this.config.autoFarmReturnHome,
        stopOnError: this.config.autoFarmStopOnError,
      };
      const result = await this._callGameCtl(session, "gameCtl.runAutoFarmCycle", [cycleOpts]);
      this.lastFinishedAt = new Date().toISOString();
      this.lastResult = {
        injected: injectState.injected,
        due,
        result,
      };
      this._pushEvent(
        "info",
        `执行完成: own=${due.ownDue ? "on" : "off"}, friend=${due.friendDue ? "on" : "off"}`,
        {
          injected: injectState.injected,
          ownActions: Array.isArray(result?.ownFarm?.tasks?.actions) ? result.ownFarm.tasks.actions.length : 0,
          friendVisits: Array.isArray(result?.friendSteal?.visits) ? result.friendSteal.visits.length : 0,
        },
      );
      return this.getState();
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      this.lastFinishedAt = new Date().toISOString();
      this.lastError = err.message;
      this._pushEvent("error", `执行失败: ${err.message}`);
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
