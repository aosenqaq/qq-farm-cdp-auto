"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.start_cdp_automation = void 0;
const node_events_1 = require("node:events");
const node_fs_1 = require("node:fs");
const node_path_1 = __importDefault(require("node:path"));
const COMMAND_TIMEOUT_MS = 15000;
const CONTEXT_WAIT_TIMEOUT_MS = 8000;
const RUNTIME_READY_TIMEOUT_MS = 8000;
const RUNTIME_READY_POLL_MS = 500;
const INJECTED_API_READY_TIMEOUT_MS = 8000;
const POST_CONNECT_DELAY_MS = 2000;
const TOTAL_AUTOMATION_TIMEOUT_MS = 8000;
const JSCONTEXT_WAIT_BUDGET_MS = 1500;
const AUTO_HARVEST_IF_MATURE_EXPRESSION = `(() => {
    const status = gameCtl.getFarmStatus({ includeGrids: true, includeLandIds: false });
    const ownership = status && status.farmOwnership ? status.farmOwnership : null;
    const statusSummary = status ? {
        totalGrids: status.totalGrids,
        stageCounts: status.stageCounts,
        workCounts: status.workCounts,
    } : null;
    if (!ownership || ownership.farmType !== "own") {
        return {
            ok: false,
            reason: ownership && ownership.farmType === "friend"
                ? "not_own_farm"
                : "farm_ownership_unknown",
            farmType: ownership ? ownership.farmType : null,
            ownership,
            count: 0,
            list: [],
            status: statusSummary,
        };
    }
    const grids = Array.isArray(status && status.grids) ? status.grids : [];
    const list = grids.filter((grid) => grid && grid.isMature && grid.canCollect);
    if (list.length === 0) {
        return {
            ok: false,
            reason: "no_mature_grids",
            farmType: status.farmType,
            ownership,
            count: 0,
            list,
            status: statusSummary,
        };
    }

    return {
        ok: true,
        count: list.length,
        list,
        farmType: status.farmType,
        ownership,
        trigger: gameCtl.triggerOneClickHarvest({
            includeBefore: true,
            includeAfter: true,
        }),
    };
})()`;
const parseCdpJsonPayload = (rawMessage) => {
    if (rawMessage == null) {
        return null;
    }
    if (typeof rawMessage === "object") {
        if (Buffer.isBuffer(rawMessage)) {
            try {
                return JSON.parse(rawMessage.toString("utf8"));
            }
            catch (_) {
                return null;
            }
        }
        if (rawMessage instanceof ArrayBuffer) {
            try {
                return JSON.parse(Buffer.from(rawMessage).toString("utf8"));
            }
            catch (_) {
                return null;
            }
        }
        if (ArrayBuffer.isView(rawMessage)) {
            try {
                const v = rawMessage;
                return JSON.parse(Buffer.from(v.buffer, v.byteOffset, v.byteLength).toString("utf8"));
            }
            catch (_) {
                return null;
            }
        }
        return rawMessage;
    }
    if (typeof rawMessage === "string") {
        try {
            return JSON.parse(rawMessage);
        }
        catch (_) {
            return null;
        }
    }
    return null;
};
class InternalCdpClient extends node_events_1.EventEmitter {
    constructor(transport) {
        super();
        this.pending = new Map();
        this.contexts = new Map();
        this.jsContexts = new Map();
        this.recentMiniappMessages = [];
        this.currentJsContextId = "";
        this.nextId = 1000000000 + Math.floor(Math.random() * 100000);
        this.onMessage = (rawMessage) => {
            const message = parseCdpJsonPayload(rawMessage);
            if (!message) {
                return;
            }
            const messageId = message.id;
            if (typeof messageId === "number" && this.pending.has(messageId)) {
                const pending = this.pending.get(messageId);
                if (!pending) {
                    return;
                }
                clearTimeout(pending.timer);
                this.pending.delete(messageId);
                if (message.error && typeof message.error === "object") {
                    const error = message.error;
                    pending.reject(new Error(`[auto] CDP error for ${pending.method}: ${error.message ?? "unknown error"}`));
                    return;
                }
                pending.resolve(message.result);
                return;
            }
            const method = message.method;
            if (typeof method !== "string") {
                return;
            }
            if (method === "Runtime.executionContextCreated") {
                const params = message.params;
                const context = params?.context;
                if (context && typeof context.id === "number") {
                    this.contexts.set(context.id, context);
                    this.emit("contextCreated", context);
                }
                return;
            }
            if (method === "Runtime.executionContextDestroyed") {
                const params = message.params;
                if (typeof params?.executionContextId === "number") {
                    this.contexts.delete(params.executionContextId);
                }
                return;
            }
            if (method === "Runtime.executionContextsCleared") {
                this.contexts.clear();
                this.emit("contextsCleared");
            }
        };
        this.onMiniappMessage = (message) => {
            const category = message.category;
            const data = message.data ?? {};
            if (typeof category === "string" && category.length > 0) {
                const summaryKeys = Object.keys(data).sort().slice(0, 12);
                const summary = {};
                for (const key of summaryKeys) {
                    const value = data[key];
                    if (value == null ||
                        typeof value === "string" ||
                        typeof value === "number" ||
                        typeof value === "boolean") {
                        summary[key] = value;
                    }
                    else if (Array.isArray(value)) {
                        summary[key] = `[array:${value.length}]`;
                    }
                    else if (typeof value === "object") {
                        summary[key] = `[object:${Object.keys(value).length}]`;
                    }
                }
                this.recentMiniappMessages.push({ category, summary });
                if (this.recentMiniappMessages.length > 20) {
                    this.recentMiniappMessages.shift();
                }
            }
            if (category === "addJsContext") {
                const jsContextId = data.jscontext_id;
                if (typeof jsContextId !== "string" || jsContextId.length === 0) {
                    return;
                }
                const context = {
                    id: jsContextId,
                    name: typeof data.jscontext_name === "string"
                        ? data.jscontext_name
                        : undefined,
                };
                this.jsContexts.set(context.id, context);
                this.emit("jsContextAdded", context);
                return;
            }
            if (category === "removeJsContext") {
                const jsContextId = data.jscontext_id;
                if (typeof jsContextId === "string" && jsContextId.length > 0) {
                    this.jsContexts.delete(jsContextId);
                    if (this.currentJsContextId === jsContextId) {
                        this.currentJsContextId = "";
                    }
                }
                return;
            }
            if (category === "connectJsContext") {
                const jsContextId = data.jscontext_id;
                if (typeof jsContextId === "string" && jsContextId.length > 0) {
                    this.currentJsContextId = jsContextId;
                    this.emit("jsContextConnected", jsContextId);
                }
            }
        };
        this.transport = transport;
        this.transport.on("cdpmessage", this.onMessage);
        this.transport.on("miniappmessage", this.onMiniappMessage);
    }
    dispose() {
        this.transport.off("cdpmessage", this.onMessage);
        this.transport.off("miniappmessage", this.onMiniappMessage);
        this.reset("internal CDP client disposed");
    }
    reset(reason) {
        this.contexts.clear();
        this.jsContexts.clear();
        this.recentMiniappMessages.length = 0;
        this.currentJsContextId = "";
        for (const [id, pending] of this.pending.entries()) {
            clearTimeout(pending.timer);
            pending.reject(new Error(`[auto] pending CDP command "${pending.method}" (${id}) aborted: ${reason}`));
        }
        this.pending.clear();
        this.emit("reset", reason);
    }
    getContexts() {
        return Array.from(this.contexts.values());
    }
    getJsContexts() {
        return Array.from(this.jsContexts.values());
    }
    getRecentMiniappMessages() {
        return [...this.recentMiniappMessages];
    }
    setJsContextId(jsContextId) {
        this.currentJsContextId = jsContextId;
    }
    connectJsContext(jsContextId) {
        this.currentJsContextId = jsContextId;
        this.transport.emit("proxymessage", {
            category: "connectJsContext",
            data: {
                jscontext_id: jsContextId,
            },
        });
    }
    async sendCommand(method, params, timeoutMs = COMMAND_TIMEOUT_MS) {
        const id = this.nextId++;
        const message = JSON.stringify({ id, method, params });
        return await new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new Error(`[auto] CDP command timed out: ${method} (${timeoutMs}ms)`));
            }, timeoutMs);
            this.pending.set(id, { method, timer, resolve, reject });
        this.transport.emit("proxymessage", {
            category: "chromeDevtools",
            data: {
                payload: message,
                jscontext_id: this.currentJsContextId,
            },
        });
        });
    }
}
let sharedInternalCdpClient = null;
let sharedInternalCdpClientRefCount = 0;
const acquireSharedInternalCdpClient = (transport) => {
    sharedInternalCdpClientRefCount += 1;
    if (!sharedInternalCdpClient) {
        sharedInternalCdpClient = new InternalCdpClient(transport);
    }
    return sharedInternalCdpClient;
};
const releaseSharedInternalCdpClient = () => {
    if (sharedInternalCdpClientRefCount > 0) {
        sharedInternalCdpClientRefCount -= 1;
    }
    if (sharedInternalCdpClientRefCount === 0 && sharedInternalCdpClient) {
        sharedInternalCdpClient.dispose();
        sharedInternalCdpClient = null;
    }
};
const normalizeContextName = (value) => (value ?? "").trim().toLowerCase();
const describeContext = (context) => JSON.stringify({
    id: context.id,
    name: context.name ?? "",
    origin: context.origin ?? "",
    auxData: context.auxData ?? {},
});
const describeJsContext = (context) => JSON.stringify({
    id: context.id,
    name: context.name ?? "",
});
const describeProbeResult = (probe) => JSON.stringify({
    id: probe.id,
    name: probe.name,
    origin: probe.origin,
    hasCc: probe.hasCc,
    hasGameGlobal: probe.hasGameGlobal,
    hasWx: probe.hasWx,
    hasDocument: probe.hasDocument,
    hasCanvas: probe.hasCanvas,
    scene: probe.scene,
    href: probe.href,
    score: probe.score,
    error: probe.error,
});
const getDeadlineRemainingMs = (deadlineAt) => {
    const remainingMs = deadlineAt - Date.now();
    if (remainingMs <= 0) {
        throw new Error("[auto] automation timed out");
    }
    return remainingMs;
};
const getEffectiveExpression = (options) => options.autoRunExpression ?? AUTO_HARVEST_IF_MATURE_EXPRESSION;
const isFarmMode = (options, effectiveExpression) => options.autoFarm ||
    effectiveExpression === AUTO_HARVEST_IF_MATURE_EXPRESSION ||
    (options.autoInjectScript
        ? node_path_1.default.basename(options.autoInjectScript).toLowerCase() === "button.js"
        : false);
const formatFarmBlock = (lines) => lines
    .filter((line) => typeof line === "string" && line.length > 0)
    .map((line) => `[farm] ${line}`)
    .join("\n");
const shortenText = (value, maxLength = 96) => {
    if (value.length <= maxLength) {
        return value;
    }
    const tailLength = Math.max(24, maxLength - 3);
    return `...${value.slice(-tailLength)}`;
};
const formatGridPos = (gridPos, fallbackPath) => {
    if (gridPos &&
        typeof gridPos === "object" &&
        typeof gridPos.x === "number" &&
        typeof gridPos.y === "number") {
        const pos = gridPos;
        return `${pos.x}_${pos.y}`;
    }
    if (typeof fallbackPath === "string") {
        const match = fallbackPath.match(/grid_(\d+)_(\d+)$/);
        if (match) {
            return `${match[1]}_${match[2]}`;
        }
    }
    return "?";
};
const formatFarmGridLine = (grid, index) => {
    const plantName = typeof grid.plantName === "string" && grid.plantName.length > 0
        ? grid.plantName
        : "unknown";
    const gridPos = formatGridPos(grid.gridPos, grid.path ?? null);
    const stage = grid.currentStage != null || grid.totalStages != null
        ? `${grid.currentStage ?? "?"}/${grid.totalStages ?? "?"}`
        : "?/?";
    const fruit = grid.leftFruit != null || grid.fruitNum != null
        ? ` fruit=${grid.leftFruit ?? "?"}/${grid.fruitNum ?? "?"}`
        : "";
    const landId = grid.landId != null ? ` landId=${String(grid.landId)}` : "";
    return `${index + 1}. ${plantName} @ ${gridPos} stage=${stage}${fruit}${landId}`;
};
const summarizeFarmExpressionResult = (result, context, runtimeState, apiState, scriptPath, elapsedMs) => {
    if (!result || typeof result !== "object") {
        return null;
    }
    const record = result;
    const list = Array.isArray(record.list) ? record.list : [];
    const status = record.ok ? "SUCCESS" : "IDLE";
    const harvestTriggered = !!record.ok && !!record.trigger;
    const previewLines = list.length > 0
        ? list.slice(0, 5).map((item, index) => formatFarmGridLine(item && typeof item === "object" ? item : {}, index))
        : [];
    const lines = [
        `result: ${status}${harvestTriggered ? " (one-click harvest sent)" : ""}`,
        `context: id=${context.id} scene=${runtimeState.scene ?? apiState?.scene ?? "unknown"} origin=${context.origin ?? ""}`,
        scriptPath ? `script: ${node_path_1.default.basename(scriptPath)}` : null,
        apiState?.farmRoot ? `farmRoot: ${shortenText(apiState.farmRoot)}` : null,
        `mature grids: ${record.count ?? list.length}`,
        ...previewLines.map((line) => `  ${line}`),
        !record.ok && record.reason
            ? `harvest: skipped (${String(record.reason)})`
            : null,
        harvestTriggered ? "harvest: triggerOneClickHarvest executed" : null,
        `elapsed: ${elapsedMs}ms`,
    ];
    return formatFarmBlock(lines);
};
const summarizeInjectionResult = (scriptPath, injectionResult, apiState) => {
    const scriptName = node_path_1.default.basename(scriptPath);
    const scene = injectionResult &&
        typeof injectionResult === "object" &&
        typeof injectionResult.scene === "string"
        ? (injectionResult.scene ?? null)
        : apiState?.scene ?? null;
    const farmRoot = injectionResult &&
        typeof injectionResult === "object" &&
        typeof injectionResult.farmRoot === "string"
        ? (injectionResult.farmRoot ?? null)
        : apiState?.farmRoot ?? null;
    return formatFarmBlock([
        `script injected: ${scriptName}`,
        scene ? `scene: ${scene}` : null,
        farmRoot ? `farmRoot: ${shortenText(farmRoot)}` : null,
    ]);
};
const findMatchingContext = (contexts, preferredContextName) => {
    const target = normalizeContextName(preferredContextName);
    const exact = contexts.find((context) => normalizeContextName(context.name) === target);
    if (exact) {
        return exact;
    }
    const fuzzy = contexts.find((context) => normalizeContextName(context.name).includes(target));
    if (fuzzy) {
        return fuzzy;
    }
    return null;
};
const findMatchingJsContext = (contexts, preferredContextName) => {
    const target = normalizeContextName(preferredContextName);
    const exact = contexts.find((context) => normalizeContextName(context.name) === target);
    if (exact) {
        return exact;
    }
    const fuzzy = contexts.find((context) => normalizeContextName(context.name).includes(target));
    if (fuzzy) {
        return fuzzy;
    }
    return null;
};
const waitForMiniappJsContext = async (client, preferredContextName, timeoutMs = CONTEXT_WAIT_TIMEOUT_MS) => {
    const existing = findMatchingJsContext(client.getJsContexts(), preferredContextName);
    if (existing) {
        return existing;
    }
    return await new Promise((resolve, reject) => {
        const onJsContextAdded = (context) => {
            if (findMatchingJsContext([context], preferredContextName) !== null) {
                cleanup();
                resolve(context);
            }
        };
        const onReset = (reason) => {
            cleanup();
            reject(new Error(`[auto] jscontext wait aborted while waiting for "${preferredContextName}": ${reason}`));
        };
        const timer = setTimeout(() => {
            cleanup();
            const known = client.getJsContexts().map(describeJsContext);
            const seenMessages = client
                .getRecentMiniappMessages()
                .map((item) => JSON.stringify(item));
            reject(new Error(`[auto] unable to find miniapp jscontext "${preferredContextName}" within ${timeoutMs}ms. Known jscontexts: ${known.length > 0 ? known.join(", ") : "none"}. Recent miniapp messages: ${seenMessages.length > 0
                ? seenMessages.join(", ")
                : "none"}`));
        }, timeoutMs);
        const cleanup = () => {
            clearTimeout(timer);
            client.off("jsContextAdded", onJsContextAdded);
            client.off("reset", onReset);
        };
        client.on("jsContextAdded", onJsContextAdded);
        client.on("reset", onReset);
    });
};
const waitForExecutionContext = async (client, preferredContextName, timeoutMs = CONTEXT_WAIT_TIMEOUT_MS) => {
    const existing = findMatchingContext(client.getContexts(), preferredContextName);
    if (existing) {
        return existing;
    }
    return await new Promise((resolve, reject) => {
        const onContextCreated = (context) => {
            if (findMatchingContext([context], preferredContextName) !== null) {
                cleanup();
                resolve(context);
            }
        };
        const onReset = (reason) => {
            cleanup();
            reject(new Error(`[auto] execution context wait aborted while waiting for "${preferredContextName}": ${reason}`));
        };
        const timer = setTimeout(() => {
            cleanup();
            const known = client.getContexts().map(describeContext);
            reject(new Error(`[auto] unable to find execution context "${preferredContextName}" within ${timeoutMs}ms. Known contexts: ${known.length > 0 ? known.join(", ") : "none"}`));
        }, timeoutMs);
        const cleanup = () => {
            clearTimeout(timer);
            client.off("contextCreated", onContextCreated);
            client.off("reset", onReset);
        };
        client.on("contextCreated", onContextCreated);
        client.on("reset", onReset);
    });
};
const waitForAnyExecutionContext = async (client, timeoutMs = CONTEXT_WAIT_TIMEOUT_MS) => {
    if (client.getContexts().length > 0) {
        return client.getContexts();
    }
    return await new Promise((resolve, reject) => {
        const onContextCreated = () => {
            const contexts = client.getContexts();
            if (contexts.length > 0) {
                cleanup();
                resolve(contexts);
            }
        };
        const onReset = (reason) => {
            cleanup();
            reject(new Error(`[auto] execution context wait aborted before any context appeared: ${reason}`));
        };
        const timer = setTimeout(() => {
            cleanup();
            reject(new Error(`[auto] no execution context appeared within ${timeoutMs}ms`));
        }, timeoutMs);
        const cleanup = () => {
            clearTimeout(timer);
            client.off("contextCreated", onContextCreated);
            client.off("reset", onReset);
        };
        client.on("contextCreated", onContextCreated);
        client.on("reset", onReset);
    });
};
const remoteObjectToValue = (result) => {
    if ("value" in result) {
        return result.value;
    }
    if (typeof result.unserializableValue === "string") {
        return result.unserializableValue;
    }
    if (result.type === "undefined") {
        return undefined;
    }
    return {
        type: result.type ?? "unknown",
        subtype: result.subtype ?? null,
        description: result.description ?? null,
    };
};
const formatException = (details) => {
    const message = details.exception?.description ??
        details.text ??
        "Runtime.evaluate threw an unknown exception";
    const lineNumber = typeof details.lineNumber === "number" ? details.lineNumber + 1 : null;
    const columnNumber = typeof details.columnNumber === "number" ? details.columnNumber + 1 : null;
    if (lineNumber === null || columnNumber === null) {
        return message;
    }
    return `${message} (line ${lineNumber}, column ${columnNumber})`;
};
const evaluateExpression = async (client, expression, executionContextId, timeoutMs = COMMAND_TIMEOUT_MS) => {
    const params = {
        expression,
        includeCommandLineAPI: true,
        awaitPromise: true,
        userGesture: true,
        returnByValue: true,
    };
    if (executionContextId != null) {
        params.contextId = executionContextId;
    }
    const response = await client.sendCommand("Runtime.evaluate", params, timeoutMs);
    if (response.exceptionDetails) {
        throw new Error(formatException(response.exceptionDetails));
    }
    return remoteObjectToValue(response.result);
};
const scoreExecutionContextProbe = (probe) => {
    if (probe.error) {
        return -1000;
    }
    let score = 0;
    if (probe.hasCc) {
        score += 100;
    }
    if (probe.scene) {
        score += 120;
    }
    if (probe.hasGameGlobal) {
        score += 40;
    }
    if (probe.hasCanvas) {
        score += 20;
    }
    if (probe.hasDocument) {
        score += 10;
    }
    if (probe.hasWx) {
        score += 10;
    }
    if (probe.href && probe.href.includes("servicewechat.com")) {
        score += 5;
    }
    return score;
};
const probeExecutionContext = async (client, context, timeoutMs = COMMAND_TIMEOUT_MS) => {
    try {
        const state = (await evaluateExpression(client, `(() => {
                const G = globalThis;
                const cc = G.cc || (G.GameGlobal && G.GameGlobal.cc);
                const scene = cc && cc.director && cc.director.getScene
                    ? cc.director.getScene()
                    : null;
                return {
                    hasCc: !!cc,
                    hasGameGlobal: !!G.GameGlobal,
                    hasWx: !!G.wx,
                    hasDocument: !!(G.document || (G.GameGlobal && G.GameGlobal.document)),
                    hasCanvas: !!(
                        G.canvas ||
                        (G.GameGlobal && G.GameGlobal.canvas) ||
                        (cc && cc.game && cc.game.canvas)
                    ),
                    scene: scene ? scene.name : null,
                    href: G.location && typeof G.location.href === "string"
                        ? G.location.href
                        : null
                };
            })()`, context.id, timeoutMs));
        const resultBase = {
            id: context.id,
            name: context.name ?? "",
            origin: context.origin ?? "",
            hasCc: !!state?.hasCc,
            hasGameGlobal: !!state?.hasGameGlobal,
            hasWx: !!state?.hasWx,
            hasDocument: !!state?.hasDocument,
            hasCanvas: !!state?.hasCanvas,
            scene: state?.scene ?? null,
            href: state?.href ?? null,
        };
        return {
            ...resultBase,
            score: scoreExecutionContextProbe(resultBase),
        };
    }
    catch (error) {
        const resultBase = {
            id: context.id,
            name: context.name ?? "",
            origin: context.origin ?? "",
            hasCc: false,
            hasGameGlobal: false,
            hasWx: false,
            hasDocument: false,
            hasCanvas: false,
            scene: null,
            href: null,
            error: String(error instanceof Error ? error.message : error),
        };
        return {
            ...resultBase,
            score: scoreExecutionContextProbe(resultBase),
        };
    }
};
const selectExecutionContext = async (client, preferredContextName, logger, timeoutMs = CONTEXT_WAIT_TIMEOUT_MS) => {
    const named = findMatchingContext(client.getContexts(), preferredContextName);
    if (named) {
        return named;
    }
    const startedAt = Date.now();
    let lastProbeSummary = "none";
    while (Date.now() - startedAt < timeoutMs) {
        const remainingMs = timeoutMs - (Date.now() - startedAt);
        try {
            await waitForAnyExecutionContext(client, Math.min(remainingMs, 2000));
        }
        catch (_) {
            await new Promise((resolve) => setTimeout(resolve, RUNTIME_READY_POLL_MS));
            continue;
        }
        const contexts = client.getContexts();
        const probes = await Promise.all(contexts.map((context) => probeExecutionContext(client, context, Math.min(COMMAND_TIMEOUT_MS, Math.max(1000, remainingMs)))));
        lastProbeSummary =
            probes.length > 0
                ? probes.map(describeProbeResult).join(", ")
                : "none";
        logger.main_debug(`[auto] execution context probes: ${lastProbeSummary}`);
        const candidate = [...probes]
            .sort((a, b) => b.score - a.score || b.id - a.id)
            .find((probe) => probe.score >= 100);
        if (candidate) {
            const matched = contexts.find((context) => context.id === candidate.id);
            if (matched) {
                return matched;
            }
        }
        await new Promise((resolve) => setTimeout(resolve, RUNTIME_READY_POLL_MS));
    }
    const known = client.getContexts().map(describeContext);
    throw new Error(`[auto] unable to select a usable execution context within ${timeoutMs}ms. Known contexts: ${known.length > 0 ? known.join(", ") : "none"}. Probe results: ${lastProbeSummary}`);
};
const waitForRuntimeReady = async (client, contextId, timeoutMs = RUNTIME_READY_TIMEOUT_MS) => {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
        const state = (await evaluateExpression(client, `(() => {
                const G = globalThis;
                const cc = G.cc || (G.GameGlobal && G.GameGlobal.cc);
                return {
                    hasCc: !!cc,
                    hasGameGlobal: !!G.GameGlobal,
                    hasWx: !!G.wx,
                    scene: cc && cc.director && cc.director.getScene
                        ? (cc.director.getScene() ? cc.director.getScene().name : null)
                        : null
                };
            })()`, contextId, Math.min(COMMAND_TIMEOUT_MS, timeoutMs)));
        if (state?.hasCc) {
            return state;
        }
        await new Promise((resolve) => setTimeout(resolve, RUNTIME_READY_POLL_MS));
    }
    throw new Error(`[auto] runtime never exposed cc/GameGlobal within ${timeoutMs}ms`);
};
const waitForInjectedApiReady = async (client, contextId, timeoutMs = INJECTED_API_READY_TIMEOUT_MS) => {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
        const state = (await evaluateExpression(client, `(() => {
                const ctl = globalThis.gameCtl;
                if (!ctl) {
                    return { ready: false, hasGameCtl: false, farmRoot: null, scene: null };
                }

                let farmRoot = null;
                try {
                    farmRoot = typeof ctl.findFarmRoot === "function" ? ctl.findFarmRoot() : null;
                } catch (error) {
                    return {
                        ready: false,
                        hasGameCtl: true,
                        farmRoot: null,
                        scene: typeof ctl.scene === "function" && ctl.scene()
                            ? ctl.scene().name
                            : null,
                        error: String(error && error.message ? error.message : error)
                    };
                }

                return {
                    ready: !!farmRoot,
                    hasGameCtl: true,
                    farmRoot: farmRoot && typeof ctl.fullPath === "function"
                        ? ctl.fullPath(farmRoot)
                        : null,
                    scene: typeof ctl.scene === "function" && ctl.scene()
                        ? ctl.scene().name
                        : null
                };
            })()`, contextId, Math.min(COMMAND_TIMEOUT_MS, timeoutMs)));
        if (state?.ready) {
            return state;
        }
        await new Promise((resolve) => setTimeout(resolve, RUNTIME_READY_POLL_MS));
    }
    throw new Error(`[auto] injected gameCtl never reported a farm root within ${timeoutMs}ms`);
};
const resolveScriptPath = (scriptPath) => node_path_1.default.isAbsolute(scriptPath)
    ? scriptPath
    : node_path_1.default.resolve(process.cwd(), scriptPath);
const addSourceUrlComment = (code, sourcePath) => {
    const normalized = sourcePath.replace(/\\/g, "/");
    const sourceUrl = /^[a-zA-Z]:\//.test(normalized)
        ? `file:///${normalized}`
        : `file://${normalized}`;
    return `${code}\n//# sourceURL=${sourceUrl}`;
};
const runAutomation = async (client, options, logger, deadlineAt) => {
    const startedAt = Date.now();
    const effectiveExpression = getEffectiveExpression(options);
    const farmMode = isFarmMode(options, effectiveExpression);
    let runtimeEnabled = false;
    let injectedApiState = null;
    let resolvedScriptPath = null;
    try {
        const jsContext = await waitForMiniappJsContext(client, options.autoContextName, Math.min(getDeadlineRemainingMs(deadlineAt), JSCONTEXT_WAIT_BUDGET_MS));
        logger.main_debug(`[auto] selected miniapp jscontext "${jsContext.name ?? ""}" (id=${jsContext.id})`);
        client.connectJsContext(jsContext.id);
        await client.sendCommand("Runtime.enable", undefined, getDeadlineRemainingMs(deadlineAt));
        runtimeEnabled = true;
    }
    catch (error) {
        logger.info(`[auto] miniapp jscontext path unavailable, trying direct CDP Runtime.enable fallback: ${String(error instanceof Error ? error.message : error)}`);
        await client.sendCommand("Runtime.enable", undefined, getDeadlineRemainingMs(deadlineAt));
        runtimeEnabled = true;
    }
    if (!runtimeEnabled) {
        throw new Error("[auto] failed to enable Runtime");
    }
    const context = await selectExecutionContext(client, options.autoContextName, logger, getDeadlineRemainingMs(deadlineAt));
    const runtimeState = await waitForRuntimeReady(client, context.id, getDeadlineRemainingMs(deadlineAt));
    if (farmMode) {
        logger.info(formatFarmBlock([
            `runtime ready: contextId=${context.id}`,
            `scene: ${runtimeState.scene ?? "unknown"}`,
            `origin: ${context.origin ?? ""}`,
        ]));
    }
    else {
        logger.info(`[auto] runtime ready in context "${context.name ?? ""}" (id=${context.id}): ${JSON.stringify(runtimeState)}`);
    }
    if (options.autoInjectScript) {
        resolvedScriptPath = resolveScriptPath(options.autoInjectScript);
        const source = await node_fs_1.promises.readFile(resolvedScriptPath, "utf8");
        const injectionResult = await evaluateExpression(client, addSourceUrlComment(source, resolvedScriptPath), context.id, getDeadlineRemainingMs(deadlineAt));
        if (effectiveExpression.includes("gameCtl")) {
            injectedApiState = await waitForInjectedApiReady(client, context.id, getDeadlineRemainingMs(deadlineAt));
        }
        if (farmMode && resolvedScriptPath) {
            logger.info(summarizeInjectionResult(resolvedScriptPath, injectionResult, injectedApiState));
        }
        else {
            logger.info(`[auto] injected script ${resolvedScriptPath}, result: ${JSON.stringify(injectionResult, null, 2)}`);
            if (injectedApiState) {
                logger.info(`[auto] injected API ready: ${JSON.stringify(injectedApiState)}`);
            }
        }
    }
    if (effectiveExpression) {
        const expressionResult = await evaluateExpression(client, effectiveExpression, context.id, getDeadlineRemainingMs(deadlineAt));
        const elapsedMs = Date.now() - startedAt;
        if (farmMode) {
            const summary = summarizeFarmExpressionResult(expressionResult, context, runtimeState, injectedApiState, resolvedScriptPath, elapsedMs);
            if (summary) {
                logger.info(summary);
            }
            else {
                logger.info(formatFarmBlock([
                    "expression completed",
                    `elapsed: ${elapsedMs}ms`,
                ]));
                logger.main_debug(`[auto] raw expression result: ${JSON.stringify(expressionResult, null, 2)}`);
            }
        }
        else {
            logger.info(`[auto] expression result (${effectiveExpression}): ${JSON.stringify(expressionResult, null, 2)}`);
        }
    }
};
const start_cdp_automation = (transport, options, logger) => {
    const effectiveExpression = getEffectiveExpression(options);
    const farmMode = isFarmMode(options, effectiveExpression);
    if (!options.autoInjectScript && !options.autoRunExpression) {
        return null;
    }
    const client = acquireSharedInternalCdpClient(transport);
    let runToken = 0;
    const handleMiniappConnected = () => {
        const token = ++runToken;
        client.reset("miniapp connected");
        logger.info(farmMode
            ? formatFarmBlock([
                `miniapp connected, stabilizing runtime for ${POST_CONNECT_DELAY_MS}ms`,
            ])
            : `[auto] miniapp connected, waiting ${POST_CONNECT_DELAY_MS}ms before probing context "${options.autoContextName}"`);
        void (async () => {
            await new Promise((resolve) => setTimeout(resolve, POST_CONNECT_DELAY_MS));
            if (token !== runToken) {
                return;
            }
            await runAutomation(client, options, logger, Date.now() + TOTAL_AUTOMATION_TIMEOUT_MS);
        })().catch((error) => {
            if (token !== runToken) {
                return;
            }
            logger.error("[auto] automation failed:", error);
        });
    };
    const handleMiniappDisconnected = () => {
        runToken += 1;
        client.reset("miniapp disconnected");
        logger.info(farmMode
            ? formatFarmBlock(["miniapp disconnected, automation state cleared"])
            : "[auto] miniapp disconnected, automation state cleared");
    };
    transport.on("miniappconnected", handleMiniappConnected);
    transport.on("miniappdisconnected", handleMiniappDisconnected);
    if (farmMode) {
        logger.info(formatFarmBlock([
            "auto-farm armed",
            `script: ${options.autoInjectScript ?? "none"}`,
            `contextName: ${options.autoContextName}`,
            `jscontextWait: ${JSCONTEXT_WAIT_BUDGET_MS}ms`,
            `postConnectDelay: ${POST_CONNECT_DELAY_MS}ms`,
            `totalTimeout: ${TOTAL_AUTOMATION_TIMEOUT_MS}ms`,
            "quick start: npm run farm:auto",
        ]));
    }
    else {
        logger.info(`[auto] armed: context="${options.autoContextName}", injectScript=${options.autoInjectScript ?? "none"}, runExpression=${options.autoRunExpression ?? "<auto-harvest-if-mature>"}, jscontextWaitMs=${JSCONTEXT_WAIT_BUDGET_MS}, postConnectDelayMs=${POST_CONNECT_DELAY_MS}, totalTimeoutMs=${TOTAL_AUTOMATION_TIMEOUT_MS}`);
    }
    return {
        dispose: () => {
            transport.off("miniappconnected", handleMiniappConnected);
            transport.off("miniappdisconnected", handleMiniappDisconnected);
            releaseSharedInternalCdpClient();
        },
    };
};
exports.start_cdp_automation = start_cdp_automation;
exports.InternalCdpClient = InternalCdpClient;
exports.acquireSharedInternalCdpClient = acquireSharedInternalCdpClient;
exports.releaseSharedInternalCdpClient = releaseSharedInternalCdpClient;
exports.selectExecutionContext = selectExecutionContext;
exports.waitForMiniappJsContext = waitForMiniappJsContext;
exports.evaluateExpression = evaluateExpression;
exports.waitForRuntimeReady = waitForRuntimeReady;
