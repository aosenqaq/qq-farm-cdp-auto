#!/usr/bin/env node
"use strict";

const path = require("node:path");

const projectRoot = path.join(__dirname, "..");
require(path.join(projectRoot, "load-env.cjs")).loadEnvFiles(projectRoot);
require(path.join(projectRoot, "apply-cli-overrides.cjs")).applyCliOverrides(process.argv.slice(2));

const { getConfig } = require(path.join(projectRoot, "src", "config.js"));
const { extractQqMiniappImages } = require(path.join(projectRoot, "src", "qq-miniapp-image-extractor.js"));

function parseArgs(argv) {
  const out = {
    miniappDir: "",
    appId: "",
    srcRoot: "",
    outputDir: "",
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = String(argv[i] || "");
    if (arg === "--miniapp-dir") {
      out.miniappDir = String(argv[i + 1] || "");
      i += 1;
      continue;
    }
    if (arg === "--out" || arg === "-o" || arg === "--output-dir") {
      out.outputDir = String(argv[i + 1] || "");
      i += 1;
      continue;
    }
    if (arg === "--appid" || arg === "--qq-appid") {
      out.appId = String(argv[i + 1] || "");
      i += 1;
      continue;
    }
    if (arg === "--qq-miniapp-src-root") {
      out.srcRoot = String(argv[i + 1] || "");
      i += 1;
      continue;
    }
  }

  return out;
}

function main() {
  const config = getConfig();
  const args = parseArgs(process.argv.slice(2));
  const result = extractQqMiniappImages({
    miniappDir: args.miniappDir,
    appId: args.appId || config.qqAppId,
    srcRoot: args.srcRoot || config.qqMiniappSrcRoot,
    outputDir: args.outputDir || path.join(projectRoot, "_miniapp_extracted_images"),
  });

  console.log(`[qq-images] extracted ${result.count} image(s)`);
  console.log(`[qq-images] source: ${result.miniappDir}`);
  console.log(`[qq-images] output: ${result.outputDir}`);
  console.log(`[qq-images] manifest: ${result.manifestPath}`);
  if (result.appId) {
    console.log(`[qq-images] appid: ${result.appId}`);
  }
}

main();
