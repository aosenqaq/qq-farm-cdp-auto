#!/usr/bin/env node
/**
 * setup.cjs — 一键启动辅助脚本
 *
 * 职责：
 *  1. 检测 node_modules 是否完整，缺失则自动 npm install
 *  2. 微信路线额外检测 frida 原生模块是否可用，不可用则重新 rebuild
 *  3. 启动主程序（node run.cjs <flag>）
 *  4. 主程序就绪后自动打开浏览器控制页
 */

'use strict';

const { execSync, spawn } = require('child_process');
const fs   = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');

// ── 解析运行时参数 ────────────────────────────────────────────────
const args        = process.argv.slice(2);
const isQQ        = args.includes('--qq');
const isWX        = args.includes('--wx');
const runtimeFlag = isQQ ? '--qq' : '--wx';
const runtimeName = isQQ ? 'QQ' : '微信';

const ROOT = __dirname;
const SHOW_REGISTRY_BENCH = /^(1|true|yes|on)$/i.test(String(process.env.FARM_SHOW_REGISTRY_BENCH || ''));

// ── 工具函数 ──────────────────────────────────────────────────────
function log(msg)  { console.log(`  [setup] ${msg}`); }
function ok(msg)   { console.log(`  [OK]    ${msg}`); }
function warn(msg) { console.log(`  [WARN]  ${msg}`); }
function err(msg)  { console.error(`  [ERR]   ${msg}`); }

function run(cmd, opts = {}) {
  log(`执行: ${cmd}`);
  execSync(cmd, { stdio: 'inherit', cwd: ROOT, ...opts });
}

function tryRun(cmd, opts = {}) {
  try {
    run(cmd, opts);
    return true;
  } catch (_) {
    return false;
  }
}

function normalizeRegistry(url) {
  return url.endsWith('/') ? url : `${url}/`;
}

function probeRegistry(registry, timeoutMs = 2500) {
  return new Promise(resolve => {
    const startedAt = Date.now();
    const url = `${normalizeRegistry(registry)}-/ping`;
    const req = https.get(url, res => {
      res.resume();
      const elapsed = Date.now() - startedAt;
      if (res.statusCode && res.statusCode >= 200 && res.statusCode < 500) {
        resolve({ registry, ok: true, elapsed });
      } else {
        resolve({ registry, ok: false, elapsed: Number.MAX_SAFE_INTEGER });
      }
    });
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error('timeout'));
    });
    req.on('error', () => {
      resolve({ registry, ok: false, elapsed: Number.MAX_SAFE_INTEGER });
    });
  });
}

async function pickFastestRegistry() {
  const registries = [
    'https://registry.npmmirror.com/',
    'https://mirrors.cloud.tencent.com/npm/',
    'https://registry.npmjs.org/',
  ];
  log('检测 npm 镜像速度（自动选择最快可用源）...');
  const results = await Promise.all(registries.map(r => probeRegistry(r)));
  if (SHOW_REGISTRY_BENCH) {
    results.forEach(item => {
      const cost = item.elapsed === Number.MAX_SAFE_INTEGER ? 'timeout' : `${item.elapsed}ms`;
      const state = item.ok ? 'ok' : 'fail';
      log(`镜像测速: ${item.registry} -> ${state}, ${cost}`);
    });
  }
  const available = results.filter(r => r.ok).sort((a, b) => a.elapsed - b.elapsed);
  if (available.length === 0) {
    warn('未检测到可用镜像，回退使用官方源');
    return 'https://registry.npmjs.org/';
  }
  const picked = available[0];
  ok(`已选择镜像: ${picked.registry} (${picked.elapsed}ms)`);
  return picked.registry;
}

async function installDepsWithBestRegistry() {
  const registry = await pickFastestRegistry();
  const installCmd = `npm install --registry=${registry}`;
  if (tryRun(installCmd)) {
    ok('依赖安装完成');
    return;
  }
  warn('当前镜像安装失败，尝试使用官方源重试...');
  run('npm install --registry=https://registry.npmjs.org/');
  ok('依赖安装完成');
}

// ── 1. 检测 node_modules ──────────────────────────────────────────
async function checkNodeModules() {
  const nmPath = path.join(ROOT, 'node_modules');

  if (!fs.existsSync(nmPath)) {
    log('node_modules 不存在，开始安装依赖...');
    await installDepsWithBestRegistry();
    return;
  }

  // 检查关键依赖是否存在
  const required = ['ws', 'protobufjs'];
  const missing  = required.filter(p => !fs.existsSync(path.join(nmPath, p)));

  if (missing.length > 0) {
    log(`缺少依赖: ${missing.join(', ')}，重新安装...`);
    await installDepsWithBestRegistry();
    return;
  }

  ok('node_modules 已就绪');
}

// ── 2. 微信路线：检测 frida 原生模块 ─────────────────────────────
function checkFrida() {
  if (!isWX) return;

  log('微信路线：检测 frida 原生模块...');
  try {
    // frida 有原生 .node 文件，直接 require 测试
    require(path.join(ROOT, 'node_modules', 'frida'));
    ok('frida 模块可用');
  } catch (e) {
    warn('frida 原生模块不可用，尝试 rebuild...');
    warn('（首次编译可能需要几分钟，请耐心等待）');
    try {
      run('npm rebuild frida');
      ok('frida rebuild 完成');
    } catch (rebuildErr) {
      err('frida rebuild 失败，请检查 Python / node-gyp 环境');
      err('参考：https://github.com/nodejs/node-gyp#installation');
      process.exit(1);
    }
  }
}

// ── 3. 读取网关端口 ───────────────────────────────────────────────
function getGatewayPort() {
  // 尝试从 .env / .env.local 读取端口，默认 8787
  const envFiles = ['.env.local', '.env'];
  for (const f of envFiles) {
    const fp = path.join(ROOT, f);
    if (!fs.existsSync(fp)) continue;
    const content = fs.readFileSync(fp, 'utf8');
    const match   = content.match(/^\s*FARM_GATEWAY_PORT\s*=\s*(\d+)/m);
    if (match) return parseInt(match[1], 10);
  }
  return 8787;
}

// ── 4. 等待 HTTP 服务就绪 ─────────────────────────────────────────
function waitForServer(port, timeout = 30000) {
  return new Promise((resolve, reject) => {
    const start    = Date.now();
    const interval = 800;

    function probe() {
      const req = http.get(`http://127.0.0.1:${port}/`, res => {
        res.resume();
        resolve();
      });
      req.on('error', () => {
        if (Date.now() - start > timeout) {
          reject(new Error(`等待服务超时（${timeout / 1000}s）`));
          return;
        }
        setTimeout(probe, interval);
      });
      req.setTimeout(1000, () => { req.destroy(); });
    }

    probe();
  });
}

// ── 5. 打开浏览器 ─────────────────────────────────────────────────
function openBrowser(url) {
  log(`打开控制页：${url}`);
  // Windows
  try { execSync(`start "" "${url}"`); return; } catch (_) {}
  // macOS fallback
  try { execSync(`open "${url}"`); return; } catch (_) {}
  // Linux fallback
  try { execSync(`xdg-open "${url}"`); } catch (_) {}
}

// ── 主流程 ────────────────────────────────────────────────────────
async function main() {
  console.log();
  console.log(`  ▶ 路线：${runtimeName}`);
  console.log();

  await checkNodeModules();
  checkFrida();

  const port = getGatewayPort();
  const url  = `http://127.0.0.1:${port}/`;

  console.log();
  log(`启动主程序（${runtimeName} 路线）...`);
  console.log();

  // 启动主程序，继承 stdio 让日志直接输出到终端
  const child = spawn('node', ['run.cjs', runtimeFlag], {
    cwd:   ROOT,
    stdio: 'inherit',
    shell: false,
  });

  child.on('error', e => {
    err(`主程序启动失败: ${e.message}`);
    process.exit(1);
  });

  child.on('exit', code => {
    if (code !== 0 && code !== null) {
      err(`主程序退出，code=${code}`);
      process.exit(code);
    }
  });

  // 等待 HTTP 服务就绪后打开浏览器
  log(`等待控制页就绪（端口 ${port}）...`);
  try {
    await waitForServer(port, 30000);
    ok(`控制页已就绪 → ${url}`);
    openBrowser(url);
  } catch (e) {
    warn(`${e.message}，请手动打开 ${url}`);
  }
}

main().catch(e => {
  err(e.message);
  process.exit(1);
});
