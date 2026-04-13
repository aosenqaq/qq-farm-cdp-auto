/**
 * 通过 WebSocket 与 Chrome DevTools Protocol（或 wmpf CDP 代理）通信，
 * 封装本项目需要的 evaluate / 通用命令 / 事件透传。
 */

const { EventEmitter } = require("node:events");
const WebSocket = require("ws");

class CdpSession extends EventEmitter {
  /**
   * @param {{ url: string; timeoutMs?: number }} opts
   */
  constructor(opts) {
    super();
    this.url = opts.url;
    this.timeoutMs = opts.timeoutMs ?? 8000;
    /** @type {WebSocket | null} */
    this.ws = null;
    this.nextId = 1;
    /** @type {Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>} */
    this.pending = new Map();
  }

  async connect() {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) return;

    await new Promise((resolve, reject) => {
      const ws = new WebSocket(this.url);
      this.ws = ws;
      ws.once("open", () => resolve(undefined));
      ws.once("error", reject);
    });

    const ws = this.ws;
    if (!ws) throw new Error("CDP WebSocket missing");

    ws.on("message", (data) => {
      let text = data;
      if (Buffer.isBuffer(data)) text = data.toString("utf8");
      else if (data instanceof ArrayBuffer) text = Buffer.from(data).toString("utf8");

      let msg;
      try {
        msg = JSON.parse(text);
      } catch {
        return;
      }

      if (msg.id != null && this.pending.has(msg.id)) {
        const p = this.pending.get(msg.id);
        if (!p) return;
        clearTimeout(p.timer);
        this.pending.delete(msg.id);
        if (msg.error) {
          const err = new Error(msg.error.message || JSON.stringify(msg.error));
          /** @type any */ (err).code = msg.error.code;
          p.reject(err);
        } else {
          p.resolve(msg.result);
        }
        return;
      }

      if (typeof msg.method === "string") {
        this.emit("cdpEvent", msg);
        this.emit(msg.method, msg.params ?? {}, msg);
      }
    });

    ws.on("close", () => {
      for (const [, p] of this.pending) {
        clearTimeout(p.timer);
        p.reject(new Error("CDP WebSocket closed"));
      }
      this.pending.clear();
    });

    await this.send("Runtime.enable", {});
  }

  /**
   * @param {string} method
   * @param {Record<string, unknown>} params
   */
  send(method, params, timeoutMs = this.timeoutMs) {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("CDP not connected"));
    }

    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP timeout: ${method} (${timeoutMs}ms)`));
      }, timeoutMs);

      this.pending.set(id, { resolve, reject, timer });
      ws.send(JSON.stringify({ id, method, params }));
    });
  }

  sendCommand(method, params = {}, timeoutMs = this.timeoutMs) {
    return this.send(method, params, timeoutMs);
  }

  /**
   * @param {string} expression 要执行的 JS 表达式（建议自行包 IIFE）
   * @param {{ executionContextId?: number; awaitPromise?: boolean }} extra
   */
  async evaluate(expression, extra = {}) {
    const params = {
      expression,
      returnByValue: true,
      userGesture: true,
      awaitPromise: extra.awaitPromise !== false,
    };
    if (extra.executionContextId != null) {
      params.contextId = extra.executionContextId;
    }

    const result = await this.send("Runtime.evaluate", params);
    const ev = /** @type {any} */ (result);
    if (ev.exceptionDetails) {
      const t = ev.exceptionDetails.exception?.description || ev.exceptionDetails.text || "evaluate failed";
      const err = new Error(String(t));
      /** @type any */ (err).exceptionDetails = ev.exceptionDetails;
      throw err;
    }
    return ev.result?.value;
  }

  /**
   * 供 /api/health 展示，不触发连接。
   */
  getStatusSnapshot() {
    const ws = this.ws;
    const open = !!(ws && ws.readyState === WebSocket.OPEN);
    return {
      mode: "raw_ws",
      wsConnected: open,
      executionContextId: null,
      contextReady: open,
      prepareError: null,
    };
  }

  close() {
    if (this.ws) {
      try {
        this.ws.close();
      } catch (_) {}
      this.ws = null;
    }
  }
}

module.exports = { CdpSession };
