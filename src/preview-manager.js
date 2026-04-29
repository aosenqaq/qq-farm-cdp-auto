"use strict";

function toInt(value, defaultValue, min, max) {
  const n = Number.parseInt(String(value ?? ""), 10);
  const fallback = Number.isFinite(n) ? n : defaultValue;
  return Math.min(max, Math.max(min, fallback));
}

function normalizePreviewOptions(raw) {
  const src = raw && typeof raw === "object" ? raw : {};
  const format = String(src.format || "jpeg").trim().toLowerCase() === "png" ? "png" : "jpeg";
  return {
    format,
    quality: format === "jpeg" ? toInt(src.quality, 60, 1, 100) : undefined,
    maxWidth: toInt(src.maxWidth, 720, 64, 4096),
    maxHeight: toInt(src.maxHeight, 1280, 64, 4096),
    everyNthFrame: toInt(src.everyNthFrame, 2, 1, 10),
  };
}

class PreviewManager {
  /**
   * @param {{
   *   ensureCdp: () => Promise<any>,
   *   getCdp: () => any,
   * }} opts
   */
  constructor(opts) {
    this.ensureCdp = opts.ensureCdp;
    this.getCdp = opts.getCdp;
    this.running = false;
    this.lastError = null;
    this.lastFrameAt = null;
    this.lastFrameMeta = null;
    this.lastFramePayload = null;
    this.options = normalizePreviewOptions({});
    /** @type {Set<any>} */
    this.sockets = new Set();
    /** @type {any} */
    this.session = null;
    /** @type {((params: any) => void) | null} */
    this._onScreencastFrame = null;
  }

  getState() {
    return {
      running: this.running,
      lastError: this.lastError,
      lastFrameAt: this.lastFrameAt,
      lastFrameMeta: this.lastFrameMeta,
      options: { ...this.options },
      subscriberCount: this.sockets.size,
      cdp: this.getCdp() && typeof this.getCdp().getStatusSnapshot === "function"
        ? this.getCdp().getStatusSnapshot()
        : null,
    };
  }

  addSocket(socket) {
    if (!socket) return;
    this.sockets.add(socket);
    if (this.lastFramePayload) {
      this._safeSend(socket, this.lastFramePayload);
    }
  }

  removeSocket(socket) {
    if (socket) this.sockets.delete(socket);
  }

  _safeSend(socket, payload) {
    if (!socket || socket.readyState !== 1) return;
    if (typeof socket.bufferedAmount === "number" && socket.bufferedAmount > 2_000_000) {
      return;
    }
    try {
      socket.send(JSON.stringify(payload));
    } catch (_) {}
  }

  _broadcast(payload) {
    for (const socket of this.sockets) {
      this._safeSend(socket, payload);
    }
  }

  _emitState(extra) {
    this._broadcast({
      event: "previewState",
      state: this.getState(),
      extra: extra !== undefined ? extra : null,
    });
  }

  _bindSession(session) {
    if (!session || this._onScreencastFrame) return;
    this._onScreencastFrame = (params) => {
      const sessionId = params && typeof params.sessionId === "number" ? params.sessionId : null;
      if (sessionId != null && this.session && typeof this.session.sendCommand === "function") {
        void this.session.sendCommand("Page.screencastFrameAck", { sessionId }, 2000).catch(() => {});
      }

      const data = params && typeof params.data === "string" ? params.data : "";
      if (!data) return;

      const mediaType = this.options.format === "png" ? "image/png" : "image/jpeg";
      const ts = new Date().toISOString();
      this.lastFrameAt = ts;
      this.lastFrameMeta = {
        sessionId,
        width: params?.metadata?.deviceWidth ?? null,
        height: params?.metadata?.deviceHeight ?? null,
        scale: params?.metadata?.pageScaleFactor ?? null,
        bytesBase64: data.length,
      };
      this.lastFramePayload = {
        event: "previewFrame",
        ts,
        mediaType,
        data,
        meta: this.lastFrameMeta,
      };
      this._broadcast(this.lastFramePayload);
    };
    session.on("Page.screencastFrame", this._onScreencastFrame);
  }

  _unbindSession() {
    if (this.session && this._onScreencastFrame) {
      this.session.off("Page.screencastFrame", this._onScreencastFrame);
    }
    this._onScreencastFrame = null;
  }

  async start(socket, rawOptions) {
    if (socket) this.addSocket(socket);
    const nextOptions = normalizePreviewOptions(rawOptions);
    const shouldRestart =
      this.running &&
      JSON.stringify(this.options) !== JSON.stringify(nextOptions);
    if (shouldRestart) {
      await this.stop("restart");
    }
    if (this.running) {
      this._emitState({ reason: "already_running" });
      return this.getState();
    }

    const session = await this.ensureCdp();
    if (!session || typeof session.sendCommand !== "function" || typeof session.on !== "function") {
      throw new Error("当前 CDP 会话不支持画面预览");
    }

    this.session = session;
    this.options = nextOptions;
    this.lastError = null;
    this._bindSession(session);

    try {
      await session.sendCommand("Page.enable", {});
      await session.sendCommand("Page.startScreencast", {
        format: nextOptions.format,
        quality: nextOptions.quality,
        maxWidth: nextOptions.maxWidth,
        maxHeight: nextOptions.maxHeight,
        everyNthFrame: nextOptions.everyNthFrame,
      });
      this.running = true;
      this._emitState({ reason: "started" });
      return this.getState();
    } catch (error) {
      this.lastError = String(error instanceof Error ? error.message : error);
      this._unbindSession();
      this.session = null;
      this.running = false;
      this._emitState({ reason: "start_failed" });
      throw error;
    }
  }

  async stop(reason = "manual") {
    const session = this.session;
    this.running = false;
    if (session && typeof session.sendCommand === "function") {
      try {
        await session.sendCommand("Page.stopScreencast", {});
      } catch (_) {}
    }
    this._unbindSession();
    this.session = null;
    this._emitState({ reason });
    return this.getState();
  }

  async capture(rawOptions) {
    const options = normalizePreviewOptions({ ...this.options, ...(rawOptions && typeof rawOptions === "object" ? rawOptions : {}) });
    const session = await this.ensureCdp();
    if (!session || typeof session.sendCommand !== "function") {
      throw new Error("当前 CDP 会话不支持截图");
    }

    await session.sendCommand("Page.enable", {});
    const result = await session.sendCommand("Page.captureScreenshot", {
      format: options.format,
      quality: options.quality,
    });
    const data = result && typeof result.data === "string" ? result.data : "";
    if (!data) {
      throw new Error("CDP 未返回截图数据");
    }
    const mediaType = options.format === "png" ? "image/png" : "image/jpeg";
    const ts = new Date().toISOString();
    this.lastFrameAt = ts;
    this.lastFrameMeta = {
      width: null,
      height: null,
      scale: null,
      bytesBase64: data.length,
    };
    this.lastFramePayload = {
      event: "previewFrame",
      ts,
      mediaType,
      data,
      meta: this.lastFrameMeta,
    };
    return {
      ts,
      mediaType,
      data,
      meta: this.lastFrameMeta,
      options,
    };
  }

  async close() {
    await this.stop("close");
    this.sockets.clear();
  }
}

module.exports = {
  PreviewManager,
  normalizePreviewOptions,
};
