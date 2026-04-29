/**
 * 与 wmpf 共用 InternalCdpClient（chromeDevtools + jscontext_id），
 * 在 CDP 代理有客户端连接 / 小程序连接时异步探测小游戏 execution context，不阻塞 connect()。
 */

const { EventEmitter } = require("node:events");
const nodePath = require("node:path");
const {
  acquireSharedInternalCdpClient,
  releaseSharedInternalCdpClient,
  selectExecutionContext,
  evaluateExpression,
  waitForRuntimeReady,
} = require(nodePath.join(__dirname, "..", "wmpf", "src", "cdp_automation.js"));

const PREPARE_DEBOUNCE_MS = 200;
const EXPLICIT_CONTEXT_RUNTIME_ENABLE_MS = 5_000;
const MIN_PREPARE_TIMEOUT_MS = 8_000;
const CONTEXT_INVALID_ERROR_FRAGMENTS = [
  "cannot find context with specified id",
  "execution context was destroyed",
  "cannot find default execution context",
  "inspected target navigated or closed",
  "target closed",
];

const gatewayLogger = {
  main_debug: (...args) => console.log("[gateway]", ...args),
};

class WmpfCdpSession extends EventEmitter {
  /**
   * @param {ReturnType<import('./config.js').getConfig>} config
   * @param {import('node:events').EventEmitter} transport
   */
  constructor(config, transport) {
    super();
    this.config = config;
    this.transport = transport;
    this.timeoutMs = config.cdpTimeoutMs ?? 30_000;
    /** @type {any} */
    this.client = null;
    /** @type {number | null} */
    this.executionContextId = null;
    /** @type {Error | null} */
    this.prepareError = null;
    this.prepareGen = 0;
    /** @type {NodeJS.Timeout | null} */
    this._prepareDebounce = null;
    this._boundPrepare = false;
    this._connected = false;
    this._runtimeEnabled = false;
    this._prepareInFlight = false;
    this._lastPrepareReason = "idle";
    this._lastTransportEvent = "startup";
    this._lastPrepareStartedAt = 0;
    this._lastPrepareFinishedAt = 0;
    /** @type {(() => void) | undefined} */
    this._onMiniappDisconnected;
    /** @type {(() => void) | undefined} */
    this._onMiniapp;
    /** @type {((message: any) => void) | null} */
    this._onClientCdpEvent = null;
  }

  _bindClientEvents() {
    if (!this.client || this._onClientCdpEvent) return;
    this._onClientCdpEvent = (message) => {
      this.emit("cdpEvent", message);
      if (message && typeof message.method === "string") {
        this.emit(message.method, message.params ?? {}, message);
      }
    };
    this.client.on("cdpEvent", this._onClientCdpEvent);
  }

  _unbindClientEvents() {
    if (!this.client || !this._onClientCdpEvent) return;
    this.client.off("cdpEvent", this._onClientCdpEvent);
    this._onClientCdpEvent = null;
  }

  _getPrepareTimeoutMs() {
    return Math.max(this.timeoutMs, MIN_PREPARE_TIMEOUT_MS);
  }

  _hasMiniappTransport() {
    const state = this._getTransportState();
    if (!state) return false;
    return !!(state.miniappConnected || (state.miniappClientCount | 0) > 0);
  }

  _schedulePrepare(reason = "unspecified") {
    this._lastPrepareReason = reason;
    if (!this.client || !this._hasMiniappTransport()) {
      return false;
    }
    if (this._prepareDebounce) {
      clearTimeout(this._prepareDebounce);
    }
    this._prepareDebounce = setTimeout(() => {
      this._prepareDebounce = null;
      void this._prepareGameContext(reason);
    }, PREPARE_DEBOUNCE_MS);
    return true;
  }

  _markContextStale(reason = "stale_context") {
    this.executionContextId = null;
    this.prepareError = null;
    this._runtimeEnabled = false;
    this._lastPrepareReason = reason;
    if (this.client && typeof this.client.setJsContextId === "function") {
      this.client.setJsContextId("");
    }
  }

  _isRecoverableContextError(error) {
    const message = String(error instanceof Error ? error.message : error).toLowerCase();
    return CONTEXT_INVALID_ERROR_FRAGMENTS.some((fragment) => message.includes(fragment));
  }

  requestPrepare(reason = "manual") {
    const explicit = this.config.executionContextId;
    if (explicit != null && Number.isFinite(explicit)) {
      return true;
    }
    if (this.executionContextId != null) {
      return true;
    }
    if (!this.client || !this._hasMiniappTransport()) {
      return false;
    }
    this.prepareError = null;
    return this._schedulePrepare(reason);
  }

  _bindPrepareTriggers() {
    if (this._boundPrepare) return;
    this._boundPrepare = true;
    this._onMiniapp = () => {
      this._lastTransportEvent = "miniappconnected";
      if (this.executionContextId != null && !this.prepareError) {
        return;
      }
      console.log("[gateway] 检测到小游戏调试桥已连接，开始探测 execution context");
      this.prepareError = null;
      this._schedulePrepare("miniapp connected");
    };
    this._onMiniappDisconnected = () => {
      this._lastTransportEvent = "miniappdisconnected";
    };
    this.transport.on("miniappconnected", this._onMiniapp);
    this.transport.on("miniappdisconnected", this._onMiniappDisconnected);
  }

  async _ensureRuntimeEnabled(timeoutMs = this.timeoutMs) {
    if (!this.client) throw new Error("CDP client missing");
    if (this._runtimeEnabled) return;
    try {
      await this.client.sendCommand("Runtime.enable", {}, timeoutMs);
      this._runtimeEnabled = true;
    } catch (error) {
      this._runtimeEnabled = false;
      throw error;
    }
  }

  _getTransportState() {
    return this.transport && this.transport.transportState && typeof this.transport.transportState === "object"
      ? this.transport.transportState
      : null;
  }

  _describePrepareState() {
    const explicit = this.config.executionContextId;
    if (explicit != null && Number.isFinite(explicit)) {
      return "explicit_context";
    }
    if (this.executionContextId != null) {
      return "context_ready";
    }
    if (this._prepareInFlight || this._prepareDebounce) {
      return "probing_context";
    }
    if (!this._hasMiniappTransport()) {
      return "waiting_miniapp";
    }
    if (this.prepareError) {
      return "probe_failed";
    }
    return "idle_waiting_probe";
  }

  async connect() {
    if (this._connected) return;
    this._connected = true;
    this.client = acquireSharedInternalCdpClient(this.transport);
    this._bindClientEvents();
    this._runtimeEnabled = false;

    const explicit = this.config.executionContextId;
    if (explicit != null && Number.isFinite(explicit)) {
      this.executionContextId = explicit;
      console.log(
        `[gateway] 使用 FARM_EXECUTION_CONTEXT_ID=${explicit}，跳过自动探测 execution context`,
      );
      if (this._hasMiniappTransport()) {
        setImmediate(() => {
          this._ensureRuntimeEnabled(EXPLICIT_CONTEXT_RUNTIME_ENABLE_MS).catch(() => {});
        });
      }
      return;
    }

    this._bindPrepareTriggers();
    if (this._hasMiniappTransport()) {
      setImmediate(() => this._schedulePrepare("connect"));
    } else {
      console.log("[gateway] 等待小游戏调试连接，再自动探测 executionContextId");
    }
  }

  async _prepareGameContext(reason = this._lastPrepareReason) {
    if (!this.client) return;
    const gen = ++this.prepareGen;
    const prepareTimeoutMs = this._getPrepareTimeoutMs();
    this._prepareInFlight = true;
    this._lastPrepareStartedAt = Date.now();
    this.prepareError = null;
    this.executionContextId = null;
    const ctxName = this.config.gatewayContextName || "gameContext";
    try {
      if (typeof this.client.setJsContextId === "function") {
        this.client.setJsContextId("");
      }
      console.log(
        `[gateway] 开始探测小游戏 execution context: preferredName=${ctxName}, reason=${reason}, timeout=${prepareTimeoutMs}ms`,
      );
      await this._ensureRuntimeEnabled(prepareTimeoutMs);
      if (gen !== this.prepareGen) return;
      const context = await selectExecutionContext(
        this.client,
        ctxName,
        gatewayLogger,
        prepareTimeoutMs,
      );
      if (gen !== this.prepareGen) return;
      await waitForRuntimeReady(
        this.client,
        context.id,
        prepareTimeoutMs,
      );
      if (gen !== this.prepareGen) return;
      this.executionContextId = context.id;
      this.prepareError = null;
      this._lastPrepareFinishedAt = Date.now();
      console.log(
        `[gateway] 小游戏 context 已就绪: executionContextId=${context.id} name=${context.name ?? ""} elapsed=${this._lastPrepareFinishedAt - this._lastPrepareStartedAt}ms`,
      );
    } catch (e) {
      if (gen !== this.prepareGen) return;
      const err = e instanceof Error ? e : new Error(String(e));
      this.prepareError = err;
      this._lastPrepareFinishedAt = Date.now();
      console.error(
        `[gateway] 自动探测 execution context 失败: ${err.message} (reason=${reason}, elapsed=${this._lastPrepareFinishedAt - this._lastPrepareStartedAt}ms)`,
      );
    } finally {
      if (gen === this.prepareGen) {
        this._prepareInFlight = false;
      }
    }
  }

  async awaitReady() {
    const explicit = this.config.executionContextId;
    if (explicit != null && Number.isFinite(explicit)) {
      return;
    }
    if (this.executionContextId != null) return;
    let retriedAfterError = false;
    this.requestPrepare("awaitReady");

    const deadline = Date.now() + this._getPrepareTimeoutMs();
    while (Date.now() < deadline) {
      if (this.executionContextId != null) return;
      if (this.prepareError) {
        if (!retriedAfterError && this._hasMiniappTransport()) {
          retriedAfterError = true;
          const lastError = this.prepareError;
          this.prepareError = null;
          console.log(`[gateway] 上下文探测失败，立即重试一次: ${lastError.message}`);
          this._schedulePrepare("awaitReady retry");
        } else {
          throw this.prepareError;
        }
      }
      if (this._hasMiniappTransport() && !this._prepareInFlight && !this._prepareDebounce) {
        this._schedulePrepare("awaitReady polling");
      }
      await new Promise((r) => setTimeout(r, 80));
    }
    if (!this._hasMiniappTransport()) {
      throw new Error("小游戏调试桥尚未连接，暂时无法获取 executionContextId");
    }
    throw new Error(`等待小游戏 executionContextId 超时（${this._getPrepareTimeoutMs()}ms）`);
  }

  /**
   * @param {string} expression
   * @param {{ executionContextId?: number; awaitPromise?: boolean; timeoutMs?: number }} extra
   */
  async evaluate(expression, extra = {}) {
    if (!this.client) throw new Error("CDP not connected");
    const evaluateTimeoutMs = extra.timeoutMs != null
      ? Math.max(1, Number(extra.timeoutMs) || this.timeoutMs)
      : this.timeoutMs;
    const fromExtra = extra.executionContextId;
    const fromConfig = this.config.executionContextId;
    const explicitId =
      fromExtra != null && typeof fromExtra === "number" && Number.isFinite(fromExtra)
        ? fromExtra
        : fromConfig != null && Number.isFinite(fromConfig)
          ? fromConfig
          : null;
    if (explicitId != null) {
      await this._ensureRuntimeEnabled(EXPLICIT_CONTEXT_RUNTIME_ENABLE_MS);
      return await evaluateExpression(
        this.client,
        expression,
        explicitId,
        evaluateTimeoutMs,
      );
    }
    this.requestPrepare("evaluate");
    await this.awaitReady();
    const ctx = this.executionContextId;
    if (ctx == null) {
      if (this.prepareError) throw this.prepareError;
      throw new Error("executionContextId 未就绪");
    }
    try {
      return await evaluateExpression(this.client, expression, ctx, evaluateTimeoutMs);
    } catch (error) {
      if (!this._isRecoverableContextError(error)) {
        throw error;
      }
      const err = error instanceof Error ? error : new Error(String(error));
      console.log(`[gateway] execution context ${ctx} 已失效，开始重新探测: ${err.message}`);
      this._markContextStale("evaluate context stale");
      this.requestPrepare("evaluate retry");
      await this.awaitReady();
      const retryCtx = this.executionContextId;
      if (retryCtx == null) {
        if (this.prepareError) throw this.prepareError;
        throw new Error("executionContextId 重探测后仍未就绪");
      }
      return await evaluateExpression(this.client, expression, retryCtx, evaluateTimeoutMs);
    }
  }

  async sendCommand(method, params = {}, timeoutMs = this.timeoutMs) {
    if (!this.client) throw new Error("CDP not connected");
    return await this.client.sendCommand(method, params, timeoutMs);
  }

  /**
   * 供 /api/health 展示，不触发新的 CDP 探测。
   */
  getStatusSnapshot() {
    const explicit = this.config.executionContextId;
    const explicitOk = explicit != null && Number.isFinite(explicit);
    /** @type {Record<string, unknown>} */
    const snap = {
      mode: "wmpf_bridge",
      connected: this._connected,
      executionContextId: this.executionContextId,
      contextReady: explicitOk ? true : this.executionContextId != null,
      prepareError: this.prepareError ? this.prepareError.message : null,
      prepareState: this._describePrepareState(),
      prepareInFlight: this._prepareInFlight,
      lastPrepareReason: this._lastPrepareReason,
      lastTransportEvent: this._lastTransportEvent,
      lastPrepareStartedAt: this._lastPrepareStartedAt || null,
      lastPrepareFinishedAt: this._lastPrepareFinishedAt || null,
      transportConnected: this._hasMiniappTransport(),
      explicitExecutionContextId: explicitOk ? explicit : null,
    };
    const transportState = this._getTransportState();
    if (transportState) {
      snap.transportState = transportState;
    }
    if (this.client) {
      snap.runtimeContextCount = this.client.getContexts().length;
      snap.jsContextCount = this.client.getJsContexts().length;
      snap.currentJsContextId = this.client.currentJsContextId || "";
    }
    return snap;
  }

  close() {
    this._connected = false;
    this._runtimeEnabled = false;
    this._prepareInFlight = false;
    if (this._boundPrepare && this._onMiniapp && this._onMiniappDisconnected) {
      this.transport.off("miniappconnected", this._onMiniapp);
      this.transport.off("miniappdisconnected", this._onMiniappDisconnected);
      this._boundPrepare = false;
    }
    if (this._prepareDebounce) {
      clearTimeout(this._prepareDebounce);
      this._prepareDebounce = null;
    }
    this.prepareGen += 1;
    this._unbindClientEvents();
    releaseSharedInternalCdpClient();
    this.client = null;
    this.executionContextId = null;
    this.prepareError = null;
  }
}

module.exports = { WmpfCdpSession };
