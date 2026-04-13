"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.parse_cli_options = void 0;
const node_util_1 = require("node:util");
// default debugging port, do not change
const DEBUG_PORT = 9421;
// CDP port, change to whatever you like
// use this port by navigating to devtools://devtools/bundled/inspector.html?ws=127.0.0.1:${CDP_PORT}
const CDP_PORT = 62000;
const PARENT_RUNTIME_FLAGS = new Set([
    "--qq",
    "--wx",
]);
const PARENT_RUNTIME_VALUE_OPTIONS = new Set([
    "--runtime",
    "--gateway-port",
    "--gateway-host",
    "--cdp-ws",
    "--qq-game-js",
    "--qq-appid",
    "--qq-miniapp-src-root",
    "--qq-host-ws-url",
    "--qq-host-version",
]);
const print_help = () => {
    console.log(`Usage: node wmpf/src/index.js [options]

Options:
  --debug-port <port>  Remote debug server port (default: ${DEBUG_PORT})
  --cdp-port <port>    CDP proxy server port (default: ${CDP_PORT})
  --debug-main         Output main process debug messages
  --debug-frida        Output Frida client messages
  --auto-farm          Inject button.js (仓库根目录) and auto-harvest when mature grids exist
  --auto-inject-script <path>
                       Inject a local JS file into the selected CDP context
  --auto-run-expression <expr>
                       Evaluate an expression after auto injection
                       (default: find mature grids, then trigger one-click harvest)
  --auto-context-name <name>
                       Preferred Runtime execution context name (default: gameContext)
  -h, --help           Show this help message`);
};
const strip_parent_runtime_args = (argv) => {
    const filteredArgs = [];
    for (let index = 0; index < argv.length; index += 1) {
        const arg = String(argv[index] ?? "");
        const optionName = arg.startsWith("--") ? arg.split("=")[0] : arg;
        if (PARENT_RUNTIME_FLAGS.has(optionName)) {
            continue;
        }
        if (PARENT_RUNTIME_VALUE_OPTIONS.has(optionName)) {
            if (!arg.includes("=")) {
                index += 1;
            }
            continue;
        }
        filteredArgs.push(arg);
    }
    return filteredArgs;
};
const parse_port = (name, value, defaultValue) => {
    if (value === undefined) {
        return defaultValue;
    }
    const port = Number(value);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error(`[main] invalid ${name}: ${value}`);
    }
    return port;
};
const parse_cli_options = (argv = process.argv.slice(2)) => {
    const args = strip_parent_runtime_args(argv);
    const { values } = (0, node_util_1.parseArgs)({
        args,
        options: {
            "debug-port": { type: "string" },
            "cdp-port": { type: "string" },
            "debug-main": { type: "boolean" },
            "debug-frida": { type: "boolean" },
            "auto-farm": { type: "boolean" },
            "auto-inject-script": { type: "string" },
            "auto-run-expression": { type: "string" },
            "auto-context-name": { type: "string" },
            help: { type: "boolean", short: "h" },
        },
        allowPositionals: false,
    });
    if (values.help) {
        print_help();
        process.exit(0);
    }
    const autoFarm = values["auto-farm"] ?? false;
    return {
        debugPort: parse_port("--debug-port", values["debug-port"], DEBUG_PORT),
        cdpPort: parse_port("--cdp-port", values["cdp-port"], CDP_PORT),
        debugMain: values["debug-main"] ?? false,
        debugFrida: values["debug-frida"] ?? false,
        autoFarm,
        autoInjectScript: values["auto-inject-script"] ?? (autoFarm ? "button.js" : null),
        autoRunExpression: values["auto-run-expression"] ?? null,
        autoContextName: values["auto-context-name"] ?? "gameContext",
    };
};
exports.parse_cli_options = parse_cli_options;
