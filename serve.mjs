#!/usr/bin/env node
/**
 * serve.mjs —— 本地服务：托管统计页面 + 代跑 export.mjs
 *
 * 为什么需要它：浏览器不能执行 node，file:// 页面也写不了 data.js。
 * 页面上「倒计时到点自动更新」「点刷新立即更新」都靠本服务的 /api/export 触发；
 * 服务端收到请求后跑一次 export.mjs 重写 data.js，页面再重新加载它。
 *
 * 用法:
 *   node serve.mjs                 启动（默认 http://127.0.0.1:8788/）
 *   node serve.mjs --open          启动后自动打开浏览器
 *   node serve.mjs --port 9000     换端口
 *   node serve.mjs --interval 300  服务端每 N 秒自动导出一次（0 = 关闭，默认 300）
 *   node serve.mjs --days 30       透传给 export.mjs：只导出最近 N 天
 *   node serve.mjs --db <path>     透传给 export.mjs：指定数据库
 *   node serve.mjs --no-synthetic  透传给 export.mjs：排除会话导入条目
 *
 * 接口:
 *   GET /api/ping     {ok, name, exports, last}              页面用它探测服务
 *   GET /api/export   {ok, ms, dataMtime, log, err}          跑一次导出
 *   GET /             index.html
 *   GET /<file>       目录内静态文件（data.js 等）
 */

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { join, dirname, resolve, sep, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const has  = f => argv.includes(f);
const val  = (k, d = null) => {
  const i = argv.indexOf(k);
  if (i >= 0 && i + 1 < argv.length) return argv[i + 1];
  const kv = argv.find(a => a.startsWith(k + '='));
  return kv ? kv.slice(k.length + 1) : d;
};

const PORT = Number(val('--port', 8788));
const HOST = val('--host', '127.0.0.1');
const OPEN = has('--open');
const EXPORT_TIMEOUT_MS = 60 * 1000;
// 服务端自身的定时导出（秒）：0 = 关闭。默认 5 分钟，
// 与页面倒计时互相独立 —— 即使页面没开着，data.js 也会保持新鲜。
const rawInterval = Number(val('--interval', 300));
const INTERVAL_SEC = Number.isFinite(rawInterval) && rawInterval >= 0 ? rawInterval : 300;
const EXPORT_ON_START = !has('--no-initial');

// 透传给 export.mjs 的参数
const EXPORT_ARGS = ['export.mjs'];
for (const k of ['--db', '--days']) {
  const v = val(k);
  if (v !== null) EXPORT_ARGS.push(k, v);
}
if (has('--no-synthetic')) EXPORT_ARGS.push('--no-synthetic');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'text/javascript; charset=utf-8',
  '.mjs':  'text/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon',
};

// ════════════════════════════════════════════════════════════
//  导出：同一时刻只跑一次，并发请求共用同一次结果
// ════════════════════════════════════════════════════════════
const stats = { exports: 0, last: null, running: false };
let inflight = null;

function runExport() {
  if (inflight) return inflight;

  inflight = new Promise(resolvePromise => {
    const t0 = Date.now();
    stats.running = true;

    const child = spawn(process.execPath, EXPORT_ARGS, {
      cwd: HERE,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let out = '', err = '';
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { err += d; });

    const timer = setTimeout(() => child.kill(), EXPORT_TIMEOUT_MS);
    const finish = async result => {
      clearTimeout(timer);
      stats.running = false;
      stats.exports++;
      stats.last = { at: new Date().toISOString(), ok: result.ok, ms: result.ms };
      inflight = null;
      resolvePromise(result);
    };

    child.on('error', e => finish({ ok: false, ms: Date.now() - t0, err: String(e && e.message || e) }));

    child.on('close', async code => {
      const ms = Date.now() - t0;
      let dataMtime = null;
      try { dataMtime = (await stat(join(HERE, 'data.js'))).mtime.toISOString(); } catch {}
      finish({
        ok: code === 0,
        ms,
        dataMtime,
        log: out.trim(),
        err: code === 0 ? '' : (err.trim() || `export.mjs 退出码 ${code}`),
      });
    });
  });

  return inflight;
}

// ════════════════════════════════════════════════════════════
//  HTTP
// ════════════════════════════════════════════════════════════
const json = (res, code, body) => {
  const s = JSON.stringify(body);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(s),
    'Cache-Control': 'no-store',
    // 允许从 file:// 打开的页面直接调用本服务
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  });
  res.end(s);
};

async function serveStatic(res, pathname) {
  const rel = decodeURIComponent(pathname === '/' ? '/index.html' : pathname).replace(/^\/+/, '');
  const full = resolve(HERE, rel);
  // 目录穿越防护：必须落在本目录内
  if (full !== HERE && !full.startsWith(HERE + sep)) {
    res.writeHead(403).end('forbidden');
    return;
  }

  try {
    const buf = await readFile(full);
    res.writeHead(200, {
      'Access-Control-Allow-Origin': '*',
      'Content-Type': MIME[extname(full).toLowerCase()] || 'application/octet-stream',
      'Content-Length': buf.length,
      'Cache-Control': 'no-store',     // 本地看板：始终读最新
    });
    res.end(buf);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('not found');
  }
}

const server = createServer(async (req, res) => {
  let pathname = '/';
  try { pathname = new URL(req.url, `http://${HOST}:${PORT}`).pathname; } catch {}
  const method = req.method || 'GET';

  if (method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Max-Age': '600',
    });
    return res.end();
  }

  if (pathname === '/api/ping') {
    return json(res, 200, {
      ok: true,
      name: 'cc-token-usage',
      pid: process.pid,
      dir: HERE,                       // 页面据此确认服务管的就是本目录
      exports: stats.exports,
      last: stats.last,
      running: stats.running,
    });
  }

  if (pathname === '/api/export') {
    if (method !== 'GET' && method !== 'POST') {
      return json(res, 405, { ok: false, err: 'method not allowed' });
    }
    const r = await runExport();
    return json(res, r.ok ? 200 : 500, r);
  }

  if (method !== 'GET' && method !== 'HEAD') {
    res.writeHead(405).end('method not allowed');
    return;
  }

  await serveStatic(res, pathname);
});

server.on('error', async e => {
  if (e && e.code === 'EADDRINUSE') {
    // 已在运行：确认是本服务后直接打开浏览器退出，避免重复启动
    let ok = false;
    try {
      const r = await fetch(`http://${HOST}:${PORT}/api/ping`);
      ok = (await r.json()).ok === true;
    } catch {}
    console.log(ok
      ? `[serve] ${HOST}:${PORT} 已有服务在运行，直接打开页面`
      : `[serve] 端口 ${PORT} 被占用（不是本服务），请用 --port 换一个`);
    if (ok && OPEN) openBrowser();
    process.exit(ok ? 0 : 1);
  }
  console.error('[serve] 启动失败:', e);
  process.exit(1);
});

function openBrowser() {
  const url = `http://${HOST}:${PORT}/`;
  if (process.platform === 'win32') {
    spawn('cmd', ['/c', 'start', '', url], { windowsHide: true, detached: true, stdio: 'ignore' }).unref();
  } else if (process.platform === 'darwin') {
    spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
  } else {
    spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
  }
}

server.listen(PORT, HOST, () => {
  const url = `http://${HOST}:${PORT}/`;
  console.log(`[serve] cc-switch Token 用量统计`);
  console.log(`[serve] 页面      ${url}`);
  console.log(`[serve] 立即导出  ${url}api/export`);
  console.log(`[serve] 数据源    ${EXPORT_ARGS.join(' ')}`);
  console.log(`[serve] 服务端定时导出  ${INTERVAL_SEC > 0 ? INTERVAL_SEC + ' 秒' : '已关闭'}`);
  console.log(`[serve] Ctrl+C 停止`);

  // 启动即导出一次，让 data.js 立刻变新
  if (EXPORT_ON_START) {
    runExport().then(r => {
      console.log(`[serve] 启动导出${r.ok ? '完成' : '失败'}（${r.ms} ms）${r.ok ? '' : '：' + r.err}`);
    });
  }

  // 服务端自己的定时导出：不依赖页面是否开着
  if (INTERVAL_SEC > 0) {
    const timer = setInterval(() => {
      runExport().then(r => {
        if (!r.ok) console.error(`[serve] 定时导出失败：${r.err}`);
      });
    }, INTERVAL_SEC * 1000);
    timer.unref?.();   // 不阻止进程退出
  }

  if (OPEN) openBrowser();
});

process.on('SIGINT', () => { console.log('\n[serve] 已停止'); process.exit(0); });
process.on('SIGTERM', () => { console.log('\n[serve] 已停止'); process.exit(0); });
