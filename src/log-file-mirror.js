"use strict";

const fs = require("node:fs");
const path = require("node:path");

const LOG_MIRROR_GLOBAL_KEY = Symbol.for("qq-farm.log-file-mirror");

function patchStreamWrite(stream, fileStream) {
  if (!stream || typeof stream.write !== "function") return;
  if (stream.__qqFarmLogMirrorPatched) return;
  const originalWrite = stream.write.bind(stream);
  stream.write = function patchedWrite(chunk, encoding, callback) {
    let nextEncoding = encoding;
    if (typeof nextEncoding === "function") {
      nextEncoding = undefined;
    }
    try {
      fileStream.write(chunk, nextEncoding);
    } catch (_) {}
    return originalWrite(chunk, encoding, callback);
  };
  Object.defineProperty(stream, "__qqFarmLogMirrorPatched", {
    value: true,
    configurable: false,
    enumerable: false,
    writable: false,
  });
}

function installLogFileMirror(projectRoot) {
  if (globalThis[LOG_MIRROR_GLOBAL_KEY]) return globalThis[LOG_MIRROR_GLOBAL_KEY];
  const root = projectRoot ? path.resolve(projectRoot) : path.resolve(__dirname, "..");
  const logDir = path.join(root, "logs");
  fs.mkdirSync(logDir, { recursive: true });
  const stdoutStream = fs.createWriteStream(path.join(logDir, "gateway-out.log"), { flags: "a" });
  const stderrStream = fs.createWriteStream(path.join(logDir, "gateway-err.log"), { flags: "a" });
  patchStreamWrite(process.stdout, stdoutStream);
  patchStreamWrite(process.stderr, stderrStream);
  const cleanup = () => {
    try {
      stdoutStream.end();
    } catch (_) {}
    try {
      stderrStream.end();
    } catch (_) {}
  };
  process.once("exit", cleanup);
  globalThis[LOG_MIRROR_GLOBAL_KEY] = {
    root,
    logDir,
  };
  return globalThis[LOG_MIRROR_GLOBAL_KEY];
}

module.exports = {
  installLogFileMirror,
};
