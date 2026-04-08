#!/usr/bin/env node
/**
 * 单进程同时启动 wmpf（Frida + 调试 + CDP）与 WebSocket 网关，无需子进程 spawn。
 */
"use strict";

require("./wmpf/src/index.js");
require("./src/gateway/index.js");
