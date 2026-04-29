#!/usr/bin/env node
/**
 * 单进程同时启动 wmpf（Frida + 调试 + CDP）与 WebSocket 网关，无需子进程 spawn。
 */
"use strict";

require("./load-env.cjs").loadEnvFiles(__dirname);
require("./apply-cli-overrides.cjs").applyCliOverrides(process.argv.slice(2));

const APP_ONLY_OPTIONS_WITH_VALUE = new Set([
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
const APP_ONLY_OPTIONS_FLAG = new Set([
  "--qq",
  "--wx",
]);

function stripAppOnlyArgs(argv) {
  const kept = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = String(argv[i] || "");
    if (!arg) continue;

    const eqIndex = arg.indexOf("=");
    const optionName = eqIndex >= 0 ? arg.slice(0, eqIndex) : arg;
    if (APP_ONLY_OPTIONS_FLAG.has(optionName)) {
      continue;
    }
    if (APP_ONLY_OPTIONS_WITH_VALUE.has(optionName)) {
      if (eqIndex < 0) {
        i += 1;
      }
      continue;
    }
    kept.push(arg);
  }
  return kept;
}

process.argv = [process.argv[0], process.argv[1] || "run.cjs", ...stripAppOnlyArgs(process.argv.slice(2))];

const { getConfig } = require("./src/config");
const config = getConfig();

if (config.runtimeTarget !== "qq_ws") {
  require("./wmpf/src/index.js");
}
require("./src/index.js");
