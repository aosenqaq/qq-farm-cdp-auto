#!/usr/bin/env node
"use strict";

const WebSocket = require("ws");

const DEFAULT_WS_URL = process.env.REWARD_POPUP_WS_URL || "ws://127.0.0.1:8787/ws";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function toErrorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function parseArgs(argv) {
  const out = {
    command: "status",
    wsUrl: DEFAULT_WS_URL,
    timeoutMs: 10_000,
    waitReadyMs: 0,
    waitScriptHash: "",
    intervalMs: null,
    waitAfter: null,
    json: false,
    silent: true,
  };
  const positional = [];

  for (let i = 0; i < argv.length; i += 1) {
    const arg = String(argv[i] || "");
    if (arg === "--ws" || arg === "--ws-url") {
      out.wsUrl = String(argv[i + 1] || out.wsUrl);
      i += 1;
      continue;
    }
    if (arg === "--timeout-ms") {
      out.timeoutMs = Math.max(1000, Number(argv[i + 1]) || out.timeoutMs);
      i += 1;
      continue;
    }
    if (arg === "--wait-ready-ms") {
      out.waitReadyMs = Math.max(0, Number(argv[i + 1]) || 0);
      i += 1;
      continue;
    }
    if (arg === "--wait-script-hash" || arg === "--script-hash") {
      out.waitScriptHash = String(argv[i + 1] || "").trim();
      i += 1;
      continue;
    }
    if (arg === "--interval-ms") {
      out.intervalMs = Math.max(120, Number(argv[i + 1]) || 0);
      i += 1;
      continue;
    }
    if (arg === "--wait-after") {
      out.waitAfter = Math.max(0, Number(argv[i + 1]) || 0);
      i += 1;
      continue;
    }
    if (arg === "--json") {
      out.json = true;
      continue;
    }
    if (arg === "--loud" || arg === "--silent=false") {
      out.silent = false;
      continue;
    }
    if (arg === "--silent" || arg === "--silent=true") {
      out.silent = true;
      continue;
    }
    positional.push(arg);
  }

  if (positional[0]) out.command = positional[0];
  return out;
}

function printUsage() {
  console.log([
    "Usage:",
    "  node scripts/reward-popup-interceptor.cjs status [--json]",
    "  node scripts/reward-popup-interceptor.cjs hide [--wait-ready-ms 120000] [--json]",
    "  node scripts/reward-popup-interceptor.cjs start [--interval-ms 180] [--wait-after 90] [--wait-ready-ms 120000] [--wait-script-hash <hash>] [--json]",
    "  node scripts/reward-popup-interceptor.cjs stop [--wait-ready-ms 30000] [--json]",
    "",
    "Options:",
    "  --ws-url <url>        gateway websocket url, default ws://127.0.0.1:8787/ws",
    "  --timeout-ms <ms>     single websocket call timeout",
    "  --wait-ready-ms <ms>  wait until runtime exposes the new methods",
    "  --wait-script-hash    wait until runtime scriptHash matches the given hash",
    "  --interval-ms <ms>    interceptor polling interval for start",
    "  --wait-after <ms>     delay after one-shot hide",
    "  --json                print machine-readable output",
    "  --loud                pass silent:false into gameCtl opts",
  ].join("\n"));
}

class GatewayClient {
  constructor(url) {
    this.url = url;
    this.ws = null;
    this.seq = 0;
    this.pending = new Map();
    this.connecting = null;
  }

  async connect() {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) return;
    if (this.connecting) return this.connecting;

    this.connecting = new Promise((resolve, reject) => {
      const ws = new WebSocket(this.url);
      let settled = false;
      this.ws = ws;

      ws.once("open", () => {
        settled = true;
        this.connecting = null;
        resolve();
      });

      ws.once("error", (error) => {
        if (settled) return;
        settled = true;
        this.connecting = null;
        reject(error instanceof Error ? error : new Error(String(error)));
      });

      ws.on("message", (raw) => this._handleMessage(raw));
      ws.on("close", () => this._handleClose(new Error("gateway websocket closed")));
      ws.on("error", (error) => this._handleClose(error instanceof Error ? error : new Error(String(error))));
    });

    return this.connecting;
  }

  _handleMessage(raw) {
    let msg;
    try {
      msg = JSON.parse(Buffer.isBuffer(raw) ? raw.toString("utf8") : String(raw));
    } catch (_) {
      return;
    }

    const id = msg && msg.id ? String(msg.id) : "";
    if (!id) return;
    const pending = this.pending.get(id);
    if (!pending) return;

    clearTimeout(pending.timer);
    this.pending.delete(id);

    if (msg.ok) {
      pending.resolve(msg.result);
      return;
    }

    pending.reject(new Error(msg.error || "gateway request failed"));
  }

  _handleClose(error) {
    const ws = this.ws;
    if (ws) ws.removeAllListeners();
    this.ws = null;
    this.connecting = null;
    for (const [id, pending] of this.pending.entries()) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.pending.delete(id);
    }
  }

  async request(packet, timeoutMs) {
    await this.connect();
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("gateway websocket not connected");
    }

    const id = "reward-popup-" + (++this.seq);
    const payload = { id, ...packet };

    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`gateway websocket timeout (${timeoutMs}ms)`));
      }, timeoutMs);

      this.pending.set(id, { resolve, reject, timer });
      try {
        this.ws.send(JSON.stringify(payload));
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  async call(pathName, args, timeoutMs) {
    return await this.request({
      op: "call",
      path: String(pathName || ""),
      args: Array.isArray(args) ? args : [],
    }, timeoutMs);
  }

  async close() {
    if (!this.ws) return;
    try {
      this.ws.close();
    } catch (_) {}
    this.ws = null;
    this.connecting = null;
  }
}

function buildCallOpts(options) {
  const out = {
    silent: !!options.silent,
  };
  if (options.intervalMs != null) out.intervalMs = options.intervalMs;
  if (options.waitAfter != null) out.waitAfter = options.waitAfter;
  return out;
}

function summarizeDescribe(describe) {
  const availableMethods = Array.isArray(describe && describe.availableMethods)
    ? describe.availableMethods
    : [];
  return {
    gameCtlReady: !!(describe && describe.gameCtlReady),
    scriptHash: describe && typeof describe.scriptHash === "string" ? describe.scriptHash : null,
    availableMethods,
  };
}

async function waitForMethod(client, methodName, options) {
  const timeoutMs = Math.max(1000, Number(options.timeoutMs) || 10_000);
  const waitReadyMs = Math.max(0, Number(options.waitReadyMs) || 0);
  const waitScriptHash = String(options.waitScriptHash || "").trim();
  const deadline = Date.now() + waitReadyMs;
  const fullPath = "gameCtl." + methodName;
  let lastDescribe = null;
  let lastError = null;

  while (true) {
    try {
      lastDescribe = summarizeDescribe(await client.call("host.describe", [], timeoutMs));
      if (
        lastDescribe.availableMethods.includes(fullPath) &&
        (!waitScriptHash || lastDescribe.scriptHash === waitScriptHash)
      ) {
        return lastDescribe;
      }
      lastError = null;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
    }

    if (Date.now() >= deadline) {
      if (lastDescribe) {
        const readyText = lastDescribe.gameCtlReady ? "ready" : "not_ready";
        const hashText = lastDescribe.scriptHash || "unknown";
        const hashExtra = waitScriptHash ? `, expectedScriptHash=${waitScriptHash}` : "";
        throw new Error(`runtime missing ${fullPath} (gameCtl=${readyText}, scriptHash=${hashText}${hashExtra})`);
      }
      throw new Error(`unable to observe ${fullPath}: ${toErrorMessage(lastError)}`);
    }

    await sleep(1200);
  }
}

async function getRuntimeSnapshot(client, options) {
  const timeoutMs = Math.max(1000, Number(options.timeoutMs) || 10_000);
  try {
    return summarizeDescribe(await client.call("host.describe", [], timeoutMs));
  } catch (error) {
    return {
      gameCtlReady: false,
      scriptHash: null,
      availableMethods: [],
      error: toErrorMessage(error),
    };
  }
}

function printResult(options, payload) {
  if (options.json) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  const runtime = payload.runtime || {};
  const lines = [
    `command: ${payload.command}`,
    `wsUrl: ${payload.wsUrl}`,
    `scriptHash: ${runtime.scriptHash || "unknown"}`,
    `gameCtlReady: ${runtime.gameCtlReady === true ? "true" : "false"}`,
  ];

  if (payload.waitedMs != null) {
    lines.push(`waitedMs: ${payload.waitedMs}`);
  }
  if (payload.result != null) {
    lines.push(`result: ${JSON.stringify(payload.result)}`);
  }
  if (payload.note) {
    lines.push(`note: ${payload.note}`);
  }
  if (payload.error) {
    lines.push(`error: ${payload.error}`);
  }
  console.log(lines.join("\n"));
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const command = String(options.command || "").toLowerCase();
  if (!["status", "hide", "start", "stop", "help", "--help", "-h"].includes(command)) {
    throw new Error(`unsupported command: ${options.command}`);
  }
  if (command === "help" || command === "--help" || command === "-h") {
    printUsage();
    return;
  }

  const client = new GatewayClient(options.wsUrl);
  const startedAt = Date.now();

  try {
    if (command === "status") {
      const runtime = await getRuntimeSnapshot(client, options);
      const canInspect = runtime.availableMethods.includes("gameCtl.getRewardPopupInterceptorState");
      const result = canInspect
        ? await client.call("gameCtl.getRewardPopupInterceptorState", [], options.timeoutMs)
        : null;
      printResult(options, {
        command,
        wsUrl: options.wsUrl,
        waitedMs: Date.now() - startedAt,
        runtime,
        result,
        note: canInspect ? null : "runtime has not loaded the new reward popup methods yet",
      });
      return;
    }

    if (command === "hide") {
      const runtime = await waitForMethod(client, "hideGetRewardsPopup", options);
      const result = await client.call("gameCtl.hideGetRewardsPopup", [buildCallOpts(options)], options.timeoutMs);
      printResult(options, {
        command,
        wsUrl: options.wsUrl,
        waitedMs: Date.now() - startedAt,
        runtime,
        result,
      });
      return;
    }

    if (command === "start") {
      const runtime = await waitForMethod(client, "startRewardPopupInterceptor", options);
      const result = await client.call("gameCtl.startRewardPopupInterceptor", [buildCallOpts(options)], options.timeoutMs);
      printResult(options, {
        command,
        wsUrl: options.wsUrl,
        waitedMs: Date.now() - startedAt,
        runtime,
        result,
      });
      return;
    }

    if (command === "stop") {
      const runtime = await waitForMethod(client, "stopRewardPopupInterceptor", options);
      const result = await client.call("gameCtl.stopRewardPopupInterceptor", [buildCallOpts(options)], options.timeoutMs);
      printResult(options, {
        command,
        wsUrl: options.wsUrl,
        waitedMs: Date.now() - startedAt,
        runtime,
        result,
      });
    }
  } finally {
    await client.close();
  }
}

main().catch((error) => {
  console.error("[reward-popup-interceptor] " + toErrorMessage(error));
  process.exitCode = 1;
});
