/**
 * HTTP 静态页（public/）+ WebSocket（路径 /ws）→ CDP → 小游戏。
 *
 * WS 消息（JSON 文本）：
 * - { "id": "任意", "op": "ping" }
 * - { "id": "任意", "op": "eval", "code": "return typeof gameCtl" }
 * - { "id": "任意", "op": "call", "path": "gameCtl.getFarmStatus", "args": [{ "includeGrids": true }] }
 * - { "id": "任意", "op": "injectFile", "path": "button.js" }
 */

const http = require("node:http");
const fsSync = require("node:fs");
const WebSocket = require("ws");
const path = require("node:path");
const fs = require("node:fs/promises");
const { CdpSession } = require("./cdp-session");
const { WmpfCdpSession } = require("./cdp-wmpf-session");
const { AutoFarmManager } = require("./auto-farm-manager");

const WS_PATH = "/ws";

/** 农场功能开关默认值（与页面一致；可 POST /api/farm-config 持久化） */
const FARM_CONFIG_DEFAULT = {
  autoInjectButton: false,
  showLandOverlay: true,
  enableOneClickHarvest: true,
  enableFriendSteal: false,
  verboseLog: false,
  autoFarmOwnEnabled: true,
  autoFarmFriendEnabled: false,
  autoFarmOwnIntervalSec: 30,
  autoFarmFriendIntervalSec: 90,
  autoFarmMaxFriends: 5,
  autoFarmEnterWaitMs: 1800,
  autoFarmActionWaitMs: 1200,
  autoFarmRefreshFriendList: true,
  autoFarmReturnHome: true,
  autoFarmStopOnError: false,
};

function farmConfigPath() {
  return path.join(__dirname, "..", "..", "data", "farm-config.json");
}

async function loadFarmConfig() {
  try {
    const raw = await fs.readFile(farmConfigPath(), "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") {
      return { ...FARM_CONFIG_DEFAULT, ...parsed };
    }
  } catch (_) {
    /* 无文件或解析失败 */
  }
  return { ...FARM_CONFIG_DEFAULT };
}

async function saveFarmConfig(partial) {
  const cur = await loadFarmConfig();
  const next = { ...cur, ...(partial && typeof partial === "object" ? partial : {}) };
  const dir = path.join(__dirname, "..", "..", "data");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(farmConfigPath(), JSON.stringify(next, null, 2), "utf8");
  return next;
}

async function readJsonBody(req) {
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
  }
  const parsed = raw ? JSON.parse(raw) : {};
  if (!parsed || typeof parsed !== "object") {
    throw new Error("invalid body");
  }
  return parsed;
}

/**
 * @returns {{ emitter: import('node:events').EventEmitter } | null}
 */
function tryLoadWmpfEmitter() {
  try {
    const wmpf = require(path.join(__dirname, "..", "..", "wmpf", "src", "index.js"));
    if (wmpf && wmpf.debugMessageEmitter) {
      return { emitter: wmpf.debugMessageEmitter };
    }
  } catch (_) {
    /* 单独运行 gateway、未装 wmpf 时忽略 */
  }
  return null;
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".ico": "image/x-icon",
  ".png": "image/png",
  ".svg": "image/svg+xml",
};

/**
 * @param {ReturnType<import('./config.js').getConfig>} config
 */
function createGateway(config) {
  /** @type {CdpSession | import('./cdp-wmpf-session').WmpfCdpSession | null} */
  let cdp = null;

  const wmpfBridge =
    config.useWmpfCdpBridge !== false ? tryLoadWmpfEmitter() : null;

  const publicRoot = path.join(__dirname, "..", "..", "public");
  const projectRoot = path.join(__dirname, "..", "..");

  /** 并发多次 ensureCdp 时共用同一次 connect，避免重复建会话 */
  let ensureCdpInFlight = null;

  async function ensureCdp() {
    if (cdp) return cdp;
    if (!ensureCdpInFlight) {
      ensureCdpInFlight = (async () => {
        try {
          if (wmpfBridge) {
            cdp = new WmpfCdpSession(config, wmpfBridge.emitter);
          } else {
            cdp = new CdpSession({ url: config.cdpWsUrl, timeoutMs: config.cdpTimeoutMs });
          }
          await cdp.connect();
          return cdp;
        } catch (error) {
          if (cdp) {
            try {
              cdp.close();
            } catch (_) {}
          }
          cdp = null;
          throw error;
        } finally {
          ensureCdpInFlight = null;
        }
      })();
    }
    return ensureCdpInFlight;
  }

  const autoFarmManager = new AutoFarmManager({
    ensureCdp,
    getCdp: () => cdp,
    projectRoot,
  });
  loadFarmConfig()
    .then((savedConfig) => {
      autoFarmManager.updateConfig(savedConfig);
    })
    .catch(() => {});

  /**
   * 在 ensureCdp 尚未执行时，WmpfCdpSession 还未订阅 miniappconnected，会漏掉事件。
   * 在网关层先订阅，小程序或 DevTools 一连上就开始建会话并探测 ctx（与 cdp-wmpf-session 内逻辑叠加无害）。
   */
  function kickEnsureCdpOnTransport() {
    ensureCdp().catch(() => {});
  }
  if (wmpfBridge) {
    wmpfBridge.emitter.on("miniappconnected", kickEnsureCdpOnTransport);
  }

  function wrapEvalExpression(userCode) {
    const body = String(userCode || "").trim();
    return `(async () => {\n${body}\n})()`;
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

  /**
   * ping 时若只调 getStatusSnapshot 一次，往往仍是「探测中」：connect() 不等待 _prepareGameContext。
   * 在 wmpf 模式下短轮询快照，便于控制页一次 ping 就看到 ctxId（或 prepareError）。
   */
  async function waitCdpSnapshotForPing(session) {
    const snap0 =
      session && typeof session.getStatusSnapshot === "function"
        ? session.getStatusSnapshot()
        : null;
    const maxMs = config.pingContextWaitMs ?? 0;
    if (!snap0 || maxMs <= 0) return { snap: snap0, timedOut: false };
    if (snap0.mode !== "wmpf_bridge") return { snap: snap0, timedOut: false };
    if (snap0.contextReady) return { snap: snap0, timedOut: false };
    if (snap0.transportConnected === false) return { snap: snap0, timedOut: false };
    if (typeof session.requestPrepare === "function") {
      session.requestPrepare(snap0.prepareError ? "ping_retry" : "ping");
    }

    const deadline = Date.now() + maxMs;
    let snap =
      session && typeof session.getStatusSnapshot === "function"
        ? session.getStatusSnapshot()
        : snap0;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 150));
      if (typeof session.requestPrepare === "function") {
        session.requestPrepare(snap.prepareError ? "ping_poll_retry" : "ping_poll");
      }
      snap = session.getStatusSnapshot();
      if (snap.contextReady || snap.prepareError) {
        return { snap, timedOut: false };
      }
    }
    return { snap, timedOut: true };
  }

  /**
   * @param {Record<string, unknown>} msg
   */
  async function dispatch(msg) {
    const op = String(msg.op || "");

    if (op === "ping") {
      await ensureCdp();
      const session = cdp;
      const { snap, timedOut } = await waitCdpSnapshotForPing(session);
      return {
        pong: true,
        cdpUrl: config.cdpWsUrl,
        cdp: snap,
        cdpProbeTimedOut: timedOut,
      };
    }

    const session = await ensureCdp();
    const execOpts = {
      executionContextId: config.executionContextId,
      awaitPromise: true,
    };

    if (op === "eval") {
      const code = String(msg.code ?? "");
      const expr = wrapEvalExpression(code);
      const value = await session.evaluate(expr, execOpts);
      return value;
    }

    if (op === "call") {
      const p = String(msg.path ?? "");
      const args = Array.isArray(msg.args) ? msg.args : [];
      const expr = wrapCallExpression(p, args);
      const value = await session.evaluate(expr, execOpts);
      return value;
    }

    if (op === "injectFile") {
      const rel = String(msg.path ?? "");
      if (!rel) throw new Error("injectFile.path required");
      const base = path.join(__dirname, "..", "..");
      const abs = path.resolve(base, rel);
      if (!abs.startsWith(base)) {
        throw new Error("injectFile.path must stay under project root");
      }
      const script = await fs.readFile(abs, "utf8");
      const expr = `(async () => { ${script}\n; return { injected: true, file: ${JSON.stringify(rel)} }; })()`;
      const value = await session.evaluate(expr, execOpts);
      return value;
    }

    throw new Error(`unknown op: ${op}`);
  }

  const httpServer = http.createServer(async (req, res) => {
    if (!req.url) {
      res.writeHead(400);
      res.end();
      return;
    }

    const urlPath = req.url.split("?")[0];

    if (req.method === "GET" && urlPath === "/api/health") {
      if (!cdp) {
        setImmediate(() => {
          ensureCdp().catch(() => {});
        });
      }
      const cdpSnap =
        cdp && typeof cdp.getStatusSnapshot === "function"
          ? cdp.getStatusSnapshot()
          : null;
      const payload = {
        ok: true,
        uptimeSec: Math.floor(process.uptime()),
        gateway: {
          cdpWsUrl: config.cdpWsUrl,
          wmpfBridge: !!wmpfBridge,
        },
        cdp: cdpSnap,
        autoFarm: autoFarmManager.getState(),
        cdpSessionInitialized: cdp != null,
        cdpWarmPending: cdp == null,
        wsClients: wss.clients.size,
      };
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(payload));
      return;
    }

    if (req.method === "GET" && urlPath === "/api/farm-config") {
      try {
        const data = await loadFarmConfig();
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: true, data }));
      } catch (e) {
        const err = e instanceof Error ? e : new Error(String(e));
        res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
      return;
    }

    if (req.method === "POST" && urlPath === "/api/farm-config") {
      try {
        const parsed = await readJsonBody(req);
        const data = await saveFarmConfig(parsed);
        autoFarmManager.updateConfig(data);
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: true, data }));
      } catch (e) {
        const err = e instanceof Error ? e : new Error(String(e));
        res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
      return;
    }

    if (req.method === "GET" && urlPath === "/api/auto-farm") {
      try {
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: true, data: autoFarmManager.getState() }));
      } catch (e) {
        const err = e instanceof Error ? e : new Error(String(e));
        res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
      return;
    }

    if (req.method === "POST" && urlPath === "/api/auto-farm") {
      try {
        const parsed = await readJsonBody(req);
        const action = String(parsed.action || "update").trim();
        let savedConfig = null;
        if (parsed.config && typeof parsed.config === "object") {
          savedConfig = await saveFarmConfig(parsed.config);
          autoFarmManager.updateConfig(savedConfig);
        }

        let data;
        if (action === "start") {
          data = autoFarmManager.start(savedConfig || parsed.config);
        } else if (action === "stop") {
          data = autoFarmManager.stop("api");
        } else if (action === "runOnce") {
          data = await autoFarmManager.runOnce(savedConfig || parsed.config);
        } else if (action === "update") {
          if (!savedConfig && parsed.config && typeof parsed.config === "object") {
            autoFarmManager.updateConfig(parsed.config);
          }
          data = autoFarmManager.getState();
        } else {
          throw new Error(`unknown auto-farm action: ${action}`);
        }

        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: true, data, savedConfig }));
      } catch (e) {
        const err = e instanceof Error ? e : new Error(String(e));
        res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
      return;
    }

    if (req.method !== "GET") {
      res.writeHead(405);
      res.end();
      return;
    }

    let rel = urlPath === "/" ? "index.html" : urlPath.replace(/^\//, "");
    rel = path.normalize(rel);
    if (rel.includes("..") || path.isAbsolute(rel)) {
      res.writeHead(403);
      res.end("Forbidden");
      return;
    }

    const filePath = path.join(publicRoot, rel);
    if (!filePath.startsWith(publicRoot)) {
      res.writeHead(403);
      res.end("Forbidden");
      return;
    }

    try {
      if (!fsSync.existsSync(filePath)) {
        res.writeHead(404);
        res.end("Not found");
        return;
      }
      const stat = fsSync.statSync(filePath);
      if (stat.isDirectory()) {
        res.writeHead(403);
        res.end("Forbidden");
        return;
      }
      const ext = path.extname(filePath);
      res.setHeader("Content-Type", MIME[ext] || "application/octet-stream");
      fsSync.createReadStream(filePath).pipe(res);
    } catch {
      res.writeHead(500);
      res.end();
    }
  });

  const wss = new WebSocket.Server({
    server: httpServer,
    path: WS_PATH,
  });

  wss.on("connection", (socket) => {
    socket.on("message", async (data) => {
      let raw = data;
      if (Buffer.isBuffer(data)) raw = data.toString("utf8");
      else if (data instanceof ArrayBuffer) raw = Buffer.from(data).toString("utf8");

      let msg;
      try {
        msg = JSON.parse(raw);
      } catch (e) {
        socket.send(
          JSON.stringify({
            id: null,
            ok: false,
            error: "invalid JSON",
            detail: String(e),
          }),
        );
        return;
      }

      const reqId = msg.id != null ? msg.id : null;

      try {
        const result = await dispatch(msg);
        socket.send(JSON.stringify({ id: reqId, ok: true, result }));
      } catch (e) {
        const err = e instanceof Error ? e : new Error(String(e));
        socket.send(
          JSON.stringify({
            id: reqId,
            ok: false,
            error: err.message,
            detail: /** @type any */ (err).exceptionDetails ?? undefined,
          }),
        );
      }
    });
  });

  return {
    httpServer,
    wss,
    close: () => {
      autoFarmManager.stop("gateway close");
      if (wmpfBridge) {
        wmpfBridge.emitter.off("miniappconnected", kickEnsureCdpOnTransport);
      }
      wss.close();
      httpServer.close();
      if (cdp) cdp.close();
      cdp = null;
    },
    getCdp: () => cdp,
  };
}

module.exports = { createGateway, WS_PATH };
