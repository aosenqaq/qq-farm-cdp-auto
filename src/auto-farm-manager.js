"use strict";

const { ensureGameCtl, callGameCtl } = require("./game-ctl-utils");
const { runAutoFarmCycle } = require("./auto-farm-executor");
const {
  normalizeAutoPlantMode,
  normalizeAutoPlantSource,
  readAutoPlantSelectedSeedKey,
} = require("./auto-farm-plant-config");

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

function getLocalDateKey(dateLike = Date.now()) {
  const date = dateLike instanceof Date ? dateLike : new Date(dateLike);
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function formatCareActionLabel(key) {
  if (key === "water") return "浇水";
  if (key === "eraseGrass") return "除草";
  if (key === "killBug") return "杀虫";
  return key ? String(key) : "打理";
}

function normalizeAutoFarmConfig(raw) {
  const src = raw && typeof raw === "object" ? raw : {};
  const autoFarmPlantMode = normalizeAutoPlantMode(src.autoFarmPlantMode);
  const autoFarmPlantSource = normalizeAutoPlantSource(src.autoFarmPlantSource, src.autoFarmPlantMode);
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
    autoFarmStopCareWhenNoExp: toBool(src.autoFarmStopCareWhenNoExp, false),
    autoFarmPlantMode,
    autoFarmPlantSource,
    autoFarmPlantSelectedSeedKey: readAutoPlantSelectedSeedKey(src),
  };
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
    // 仅保存在当前 Node 进程内存里；不做账号隔离，但会按本地日期自动清空。
    this.careExpLimitState = null;
    this.config = normalizeAutoFarmConfig({});
  }

  updateConfig(raw) {
    this.config = normalizeAutoFarmConfig({ ...this.config, ...(raw && typeof raw === "object" ? raw : {}) });
    return this.config;
  }

  getState() {
    this._pruneCareExpLimit(Date.now());
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
      careExpLimitState: this.careExpLimitState ? { ...this.careExpLimitState } : null,
      config: { ...this.config },
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

  _markRunCompletedAt(due, completedAtMs) {
    const ts = Number.isFinite(Number(completedAtMs)) ? Number(completedAtMs) : Date.now();
    if (due && due.ownDue) this.lastOwnRunAt = ts;
    if (due && due.friendDue) this.lastFriendRunAt = ts;
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

  _pruneCareExpLimit(now) {
    if (!this.careExpLimitState) return;
    const today = getLocalDateKey(now);
    if (this.careExpLimitState.dateKey !== today) {
      this.careExpLimitState = null;
    }
  }

  _updateCareExpLimitFromResult(result, now) {
    this._pruneCareExpLimit(now);
    const ownTasks = result && result.ownFarm && result.ownFarm.tasks ? result.ownFarm.tasks : null;
    const friendSteal = result && result.friendSteal && typeof result.friendSteal === "object"
      ? result.friendSteal
      : null;
    const source = ownTasks && ownTasks.careExpLimitReached
      ? "own"
      : friendSteal && friendSteal.careExpLimitReached
        ? "friend"
        : null;
    if (!source) return;
    const info = source === "own"
      ? ownTasks && ownTasks.careExpLimitInfo && typeof ownTasks.careExpLimitInfo === "object"
        ? ownTasks.careExpLimitInfo
        : {}
      : friendSteal && friendSteal.careExpLimitInfo && typeof friendSteal.careExpLimitInfo === "object"
        ? friendSteal.careExpLimitInfo
        : {};
    const sourceLabel = source === "friend" ? "好友" : "自己";
    const nextState = {
      source,
      sourceLabel,
      dateKey: getLocalDateKey(now),
      detectedAt: new Date(now).toISOString(),
      key: info.key || null,
      landId: info.landId != null ? info.landId : null,
      expDelta: info.result && info.result.expDelta != null ? info.result.expDelta : null,
      expBefore: info.result && info.result.expBefore != null ? info.result.expBefore : null,
      expAfter: info.result && info.result.expAfter != null ? info.result.expAfter : null,
      reason: info.result && info.result.noExpGainReason
        ? info.result.noExpGainReason
        : info.result && info.result.reason
          ? info.result.reason
          : "no_exp_gain",
    };
    const prev = this.careExpLimitState;
    const changed = !prev
      || prev.dateKey !== nextState.dateKey
      || prev.key !== nextState.key
      || prev.landId !== nextState.landId
      || prev.source !== nextState.source;
    this.careExpLimitState = nextState;
    if (changed) {
      this._pushEvent(
        "info",
        `共享经验疑似到上限，暂停打理: ${sourceLabel}${formatCareActionLabel(nextState.key)}${nextState.landId != null ? ` 地块${nextState.landId}` : ""}`,
        nextState,
      );
    }
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
      "getSelfExp",
      "waitForSelfExpChange",
      "triggerOneClickOperation",
      "getSeedList",
      "getShopSeedList",
      "buyShopGoods",
      "waterSingleLand",
      "killBugSingleLand",
      "eraseGrassSingleLand",
      "waterLands",
      "killBugLands",
      "eraseGrassLands",
      "clickMatureEffect",
      "getHarvestablePlantLandIds",
      "plantSingleLand",
      "plantSeedsOnLands",
    ]);
  }

  async _callGameCtlDirect(session, pathName, args) {
    return await callGameCtl(session, pathName, args);
  }

  async _runCycle(force, dueFlags) {
    const now = Date.now();
    this._pruneCareExpLimit(now);
    const due = dueFlags || this._getDueFlags(now, force);
    if (!due.ownDue && !due.friendDue) {
      return this.getState();
    }

    this.busy = true;
    this.lastStartedAt = new Date().toISOString();
    this.lastError = null;

    try {
      const session = await this.ensureSession();
      const injectState = await this.ensureGameCtlImpl(session);
      const transportState = this.getTransportState();
      const isQqRuntime = !!(transportState && transportState.resolvedTarget === "qq_ws");
      const careExpLimitState = this.config.autoFarmStopCareWhenNoExp ? this.careExpLimitState : null;
      const skipCareBecauseNoExp = !!careExpLimitState;
      const cycleOpts = {
        ownFarmEnabled: due.ownDue,
        friendStealEnabled: due.friendDue,
        includeWater: !skipCareBecauseNoExp,
        includeEraseGrass: !skipCareBecauseNoExp,
        includeKillBug: !skipCareBecauseNoExp,
        stopCareWhenNoExp: !!this.config.autoFarmStopCareWhenNoExp,
        autoPlantMode: this.config.autoFarmPlantMode || "none",
        autoPlantSource: this.config.autoFarmPlantSource || "auto",
        autoPlantSelectedSeedKey: this.config.autoFarmPlantSelectedSeedKey || "",
        useClientAutoPlant: isQqRuntime,
        enterWaitMs: this.config.autoFarmEnterWaitMs,
        actionWaitMs: this.config.autoFarmActionWaitMs,
        maxFriends: this.config.autoFarmMaxFriends,
        refreshFriendList: this.config.autoFarmRefreshFriendList,
        returnHome: this.config.autoFarmReturnHome,
        stopOnError: this.config.autoFarmStopOnError,
      };
      const result = await runAutoFarmCycle({
        session,
        callGameCtl: this.callGameCtlImpl.bind(this),
        options: cycleOpts,
      });
      this._updateCareExpLimitFromResult(result, now);
      const completedAtMs = Date.now();
      this._markRunCompletedAt(due, completedAtMs);
      this.lastFinishedAt = new Date(completedAtMs).toISOString();
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
          skipCareBecauseNoExp,
        },
      );
      return this.getState();
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      const completedAtMs = Date.now();
      this._markRunCompletedAt(due, completedAtMs);
      this.lastFinishedAt = new Date(completedAtMs).toISOString();
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
