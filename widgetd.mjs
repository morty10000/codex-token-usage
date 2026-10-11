#!/usr/bin/env node
/**
 * widgetd.mjs — Codex 窗口悬浮用量条守护进程 (v2: Shadow DOM 注入)
 *
 * 为什么不用 iframe:
 *   app:// 主页面的 CSP（frame-src 不含 http://127.0.0.1, connect-src 为 none）
 *   会拒绝内嵌本地页面、也会拒绝页面自己 fetch。
 *   所以: 样式走 CSSOM/adoptedStyleSheets, 数据由本进程读 data.js 后经 CDP
 *   推给页面 (window.__ccgW.update(...)), 全程不依赖页面网络权限。
 *
 * 行为:
 *   - 每 3 秒自检一次, 注入缺失自动补; 应用重启自动重连
 *   - 每 15 秒重新读取 data.js 并推送最新数字
 *   - 控制口 127.0.0.1:8791 (防重复实例; /stop 停止并卸载)
 *
 * 用法:
 *   node widgetd.mjs               启动守护(常驻)
 *   node widgetd.mjs --once        注入一次+推一次数据后退出(调试用)
 *   node widgetd.mjs --remove      卸载悬浮条并停止已有守护
 *   node widgetd.mjs --port 9229 --data "<dir>/data.js" --interval 3000
 */

import { createServer } from 'node:http';
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const args = process.argv.slice(2);
const has = f => args.includes(f);
const val = (k, d) => {
  const i = args.indexOf(k);
  if (i >= 0 && i + 1 < args.length) return args[i + 1];
  const kv = args.find(a => a.startsWith(k + '='));
  return kv ? kv.slice(k.length + 1) : d;
};

const PORT = val('--port', '9229');
const HERE = dirname(fileURLToPath(import.meta.url));
const DATA_PATH = val('--data', join(HERE, 'data.js'));
const DASH_URL = val('--dash', 'http://127.0.0.1:8788/');
const CODEX_DIR = val('--codex-dir', join(homedir(), '.codex'));
const CLI_BIN_DIR = val('--cli-bin', join(process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'OpenAI', 'Codex', 'bin'));
const INTERVAL = Number(val('--interval', '3000')) || 3000;
const PUSH_EVERY = Number(val('--push-every', '15000')) || 15000;
const CTL_PORT = Number(val('--ctl', '8791')) || 8791;
const REMOVE = has('--remove');
const ONCE = has('--once');

/* ── 悬浮条样式 (注入到 Shadow DOM, 走 CSSOM 不受页面 CSP 限制) ── */
const PAGE_CSS = `
  .card { display: flex; align-items: center; width: 100%; box-sizing: border-box; height: 30px; margin: 5px; padding: 0 12px;
    border-radius: 999px; text-decoration: none; cursor: pointer; pointer-events: auto;
    font: 13px/1.4 system-ui, "Segoe UI", "Microsoft YaHei", sans-serif;
    background: rgba(255, 255, 255, 0.92);
    border: 1px solid rgba(17, 24, 28, 0.10);
    box-shadow: 0 4px 16px rgba(17, 24, 28, 0.14);
    backdrop-filter: blur(10px);
  }
  .cell { flex: 1; display: flex; flex-direction: row; align-items: center; justify-content: center; gap: 6px; white-space: nowrap; }
  .label { font-size: 11px; letter-spacing: 0.04em; color: #6b7280; }
  .val { font-size: 13px; font-weight: 600; color: #111418; font-variant-numeric: tabular-nums; }
  .sep { width: 1px; height: 14px; background: rgba(17, 24, 28, 0.10); flex: none; }
  .dot { width: 6px; height: 6px; border-radius: 50%; background: #cbd5e1; margin: 0 6px 0 0; flex: none; }
  .dot.ok { background: #22c55e; }
  .dot.stale { background: #f59e0b; }
  .dot.err { background: #ef4444; }
  .val.bump { animation: bump 0.7s ease; }
  @keyframes bump {
    0% { transform: scale(1); color: #0ea5e9; }
    40% { transform: scale(1.12); }
    100% { transform: scale(1); }
  }
  .card.docked { height: 22px; margin: 0; padding: 0 13px; border-radius: 7px; background: transparent; border-color: transparent; box-shadow: none; }
  .card.docked:hover { background: rgba(17, 24, 28, 0.06); }
  .card.docked .cell { flex: 0 0 auto; gap: 8px; }
  .card.docked .label { font-size: 11px; }
  .card.docked .val { font-size: 12px; }
  .card.docked .sep { height: 11px; margin: 0 14px; }
  .card.docked .dot { width: 6px; height: 6px; margin: 0 7px 0 0; }
  @media (prefers-color-scheme: dark) {
    .card { background: rgba(32, 33, 36, 0.92); border-color: rgba(255, 255, 255, 0.10); box-shadow: 0 4px 16px rgba(0, 0, 0, 0.45); }
    .card.docked { background: transparent; border-color: transparent; box-shadow: none; }
    .card.docked:hover { background: rgba(255, 255, 255, 0.08); }
    .label { color: #9aa0a6; }
    .val { color: #e8eaed; }
    .sep { background: rgba(255, 255, 255, 0.12); }
  }
`;

const INIT_JS = `(function () {
  if (window.__ccgW && window.__ccgW.v === 13) { window.__ccgW.place(); return 'exists'; }
  var old = document.getElementById('ccg-widget');
  if (old) old.remove();
  var host = document.createElement('div');
  host.id = 'ccg-widget';
  host.style.cssText = 'position:fixed;left:0;top:0;width:460px;z-index:9999;-webkit-app-region:no-drag;pointer-events:none;';
  document.body.appendChild(host);
  var sr = host.attachShadow({ mode: 'open' });
  var css = ${JSON.stringify(PAGE_CSS)};
  try {
    var sheet = new CSSStyleSheet();
    sheet.replaceSync(css);
    sr.adoptedStyleSheets = [sheet];
  } catch (e) {
    var st = document.createElement('style');
    st.textContent = css;
    sr.appendChild(st);
  }
  var a = document.createElement('a');
  a.className = 'card';
  a.href = ${JSON.stringify(DASH_URL)};
  a.target = '_blank';
  a.rel = 'noopener';
  a.title = '打开完整看板';
  sr.appendChild(a);
  function cell(id, label) {
    var c = document.createElement('span'); c.className = 'cell';
    var l = document.createElement('span'); l.className = 'label'; l.textContent = label;
    var v = document.createElement('span'); v.className = 'val'; v.id = id; v.textContent = '…';
    c.appendChild(l); c.appendChild(v);
    return c;
  }
  var dot = document.createElement('span'); dot.id = 'dot'; dot.className = 'dot';
  a.appendChild(dot);
  a.appendChild(cell('v-today', '今日'));
  var s1 = document.createElement('span'); s1.className = 'sep'; a.appendChild(s1);
  a.appendChild(cell('v-7d', '近 7 天'));
  var s2 = document.createElement('span'); s2.className = 'sep'; a.appendChild(s2);
  a.appendChild(cell('v-all', '总计'));
  var FW = 460, FH = 40, GAP = 8;
  function findComposerEl() {
    var eds = document.querySelectorAll('[contenteditable="true"]');
    var best = null, bestArea = 0;
    for (var i = 0; i < eds.length; i++) {
      var r = eds[i].getBoundingClientRect();
      if (r.width > 240 && r.height > 24 &&
          r.bottom > window.innerHeight * 0.5 && r.top < window.innerHeight - 8) {
        var area = r.width * r.height;
        if (area > bestArea) { best = eds[i]; bestArea = area; }
      }
    }
    return best;
  }
  function overlayOpen() {
    var m = document.querySelector('[aria-modal="true"], [role="dialog"]');
    if (!m) return false;
    var r = m.getBoundingClientRect();
    return r.width > 200 && r.height > 200;
  }
  function clusterTopOf(ed) {
    var top = ed.getBoundingClientRect().top;
    var n = ed, d = 0;
    while (n && n !== document.body && d < 16) {
      var p = n.parentElement;
      if (!p || p === document.body) break;
      var pr = p.getBoundingClientRect();
      if (pr.width < 4 && pr.height < 4) { n = p; d++; continue; }
      if (pr.width < 200) break;
      if (pr.top < top - 260) break;
      if (pr.height > 620) break;
      if (pr.top < top) top = pr.top;
      n = p; d++;
    }
    return top;
  }
  function gluedBarTop(cx, clusterTop) {
    var top = clusterTop;
    var minY = Math.round(clusterTop) - 150;
    var y = Math.round(clusterTop) - 4;
    while (y > 24 && y >= minY) {
      var stack = document.elementsFromPoint(cx, y);
      var bar = null;
      for (var j = 0; j < stack.length; j++) {
        var el = stack[j];
        if (el === host || el.id === 'ccg-widget') continue;
        var n = el, d = 0;
        while (n && n !== document.body && d < 12) {
          var nr = n.getBoundingClientRect();
          if (nr.width >= 300 && nr.height >= 10 && nr.height <= 170 &&
              y >= nr.top - 0.5 && y <= nr.bottom + 0.5 &&
              nr.top <= clusterTop - 4 && nr.bottom >= clusterTop - 24 && nr.bottom <= clusterTop + 60) { bar = nr; break; }
          n = n.parentElement; d++;
        }
        break;
      }
      if (bar) {
        if (bar.top < top) top = bar.top;
        var ny = Math.round(bar.top) - 4;
        y = ny < y ? ny : y - 4;
      } else {
        y -= 4;
      }
    }
    return top;
  }
  function findHelpAnchor() {
    var el = document.getElementById('application-menu-trigger-help-menu');
    if (!el || !el.isConnected) {
      el = null;
      var leaves = document.querySelectorAll('button,div,span,a');
      for (var i = 0; i < leaves.length; i++) {
        var l = leaves[i];
        if (l.childElementCount > 1) continue;
        var t = (l.textContent || '').trim();
        if (t !== '\u5e2e\u52a9' && t !== 'Help') continue;
        var rr = l.getBoundingClientRect();
        if (rr.width > 0 && rr.height > 0 && rr.top < 90 && rr.height < 60 && rr.width < 160) { el = l; break; }
      }
    }
    if (!el) return null;
    var r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0 || r.top > 90) return null;
    return { rect: r };
  }
  var DOCK_GAP = 40;
  var docked = false;
  function place() {
    var anchor = findHelpAnchor();
    if (anchor) {
      if (!docked) { docked = true; a.classList.add('docked'); host.style.width = 'auto'; }
      host.style.display = 'block';
      host.style.left = Math.round(anchor.rect.right + DOCK_GAP) + 'px';
      host.style.top = Math.round(anchor.rect.top + (anchor.rect.height - 22) / 2) + 'px';
      return;
    }
    if (docked) { docked = false; a.classList.remove('docked'); host.style.width = '460px'; }
    var ed = findComposerEl();
    if (!ed || overlayOpen()) { host.style.display = 'none'; return; }
    var r = ed.getBoundingClientRect();
    var cx = r.left + r.width / 2;
    var ct = Math.round(clusterTopOf(ed));
    var bt = Math.round(gluedBarTop(cx, ct));
    var top = Math.max(8, Math.min(ct, bt) - FH - GAP);
    host.style.display = 'block';
    host.style.left = Math.round(cx - FW / 2) + 'px';
    host.style.top = top + 'px';
  }
  window.__ccgW = {
    v: 13,
    place: place,
    update: function (d) {
      var e0 = sr.querySelector('#v-today');
      var e7 = sr.querySelector('#v-7d');
      var ea = sr.querySelector('#v-all');
      var dt = sr.querySelector('#dot');
      if (!e0) return 'no-node';
      var changed = window.__ccgLast0 !== undefined && window.__ccgLast0 !== d.s0;
      window.__ccgLast0 = d.s0;
      if (changed) {
        e0.classList.remove('bump');
        void e0.offsetWidth;
        e0.classList.add('bump');
      }
      e0.textContent = d.s0; e0.title = d.f0 + ' tokens';
      e7.textContent = d.s7; e7.title = d.f7 + ' tokens';
      ea.textContent = d.sAll; ea.title = d.fAll + ' tokens';
      dt.className = 'dot' + (d.dot ? ' ' + d.dot : '');
      dt.title = d.dotTip || '';
      return 'ok';
    }
  };
  window.__ccgTimer = setInterval(place, 1000);
  window.addEventListener('resize', place);
  place();
  return 'injected';
})()`;

const REMOVE_JS = `(function () {
  if (window.__ccgTimer) { clearInterval(window.__ccgTimer); window.__ccgTimer = null; }
  if (window.__ccgW) { window.removeEventListener('resize', window.__ccgW.place); window.__ccgW = null; }
  var W = document.getElementById('ccg-widget');
  if (W) { W.remove(); return 'removed'; }
  return 'absent';
})()`;

/* ── 数据准备 (Node 侧) ── */
const pad2 = n => (n < 10 ? '0' : '') + n;
const dayKeyOf = ts => {
  const d = new Date(ts * 1000);
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
};
const trimNum = s => s.replace(/\.0+$/, '').replace(/(\.\d)0+$/, '$1');
const fmtShort = n => (n >= 1e8 ? trimNum((n / 1e8).toFixed(2)) + '亿' : n >= 1e4 ? trimNum((n / 1e4).toFixed(1)) + '万' : String(n));
const fmtFull = n => Math.round(n).toLocaleString('zh-CN');

function computePush() {
  const raw = readFileSync(DATA_PATH, 'utf8');
  const data = JSON.parse(raw.slice(raw.indexOf('=') + 1).trim().replace(/;\s*$/, ''));
  const recs = data.records || [];
  const today = dayKeyOf(Date.now() / 1000);
  const midnight = new Date();
  midnight.setHours(0, 0, 0, 0);
  const c7 = Math.floor(midnight.getTime() / 1000) - 6 * 86400;
  let t0 = 0, t7 = 0, all = 0;
  for (const r of recs) {
    const v = (r.i | 0) + (r.o | 0) + (r.r | 0) + (r.w | 0);
    all += v;
    if (r.t >= c7) t7 += v;
    if (dayKeyOf(r.t) === today) t0 += v;
  }
  const age = Date.now() - new Date(data.generatedAt || 0).getTime();
  let dot = '', dotTip = '';
  if (isFinite(age) && age >= 0) {
    if (age < 7 * 60 * 1000) { dot = 'ok'; dotTip = '数据更新于 ' + data.generatedAtLocal; }
    else { dot = 'stale'; dotTip = '数据可能滞后（' + Math.round(age / 60000) + ' 分钟前）'; }
  }
  return {
    s0: fmtShort(t0), s7: fmtShort(t7), sAll: fmtShort(all),
    f0: fmtFull(t0), f7: fmtFull(t7), fAll: fmtFull(all),
    dot: dot, dotTip: dotTip
  };
}

/* ── 插件注册自愈: config.toml 里丢了本插件就补回来 ── */
function findCodexCli() {
  try {
    const dirs = readdirSync(CLI_BIN_DIR)
      .map(d => join(CLI_BIN_DIR, d))
      .filter(d => existsSync(join(d, 'codex.exe')));
    dirs.sort((a, b) => statSync(join(b, 'codex.exe')).mtimeMs - statSync(join(a, 'codex.exe')).mtimeMs);
    return dirs.length ? join(dirs[0], 'codex.exe') : null;
  } catch {
    return null;
  }
}

const MARKET_NAME = val('--market', 'codex-token-usage');
const KEEP_PLUGINS = [{ id: 'codex-token-usage@' + MARKET_NAME, market: HERE }];

function keepPlugin() {
  const cfgPath = join(CODEX_DIR, 'config.toml');
  let cfg;
  try {
    cfg = readFileSync(cfgPath, 'utf8');
  } catch (e) {
    console.log('[widgetd] 读取 config.toml 失败: ' + e.message);
    return;
  }
  const missing = KEEP_PLUGINS.filter(p => !cfg.includes(p.id));
  if (!missing.length) return;
  console.log('[widgetd] 插件注册缺失: ' + missing.map(p => p.id).join(', ') + ' — 正在恢复…');
  const cli = findCodexCli();
  if (!cli) { console.log('[widgetd] 未找到 codex.exe, 跳过恢复'); return; }
  for (const p of missing) {
    spawnSync(cli, ['plugin', 'marketplace', 'add', p.market], { encoding: 'utf8', timeout: 90000, windowsHide: true });
    const r = spawnSync(cli, ['plugin', 'add', p.id], { encoding: 'utf8', timeout: 90000, windowsHide: true });
    console.log('[widgetd] ' + p.id + ' 恢复' + (r.status === 0 ? '完成' : '失败: ' + String(r.stderr || '').trim().slice(0, 160)));
  }
}

/* ── CDP ── */
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function findMainTarget() {
  try {
    const r = await fetch('http://127.0.0.1:' + PORT + '/json/list', { signal: AbortSignal.timeout(2500) });
    const list = await r.json();
    return list.find(t =>
      t.type === 'page' && t.webSocketDebuggerUrl &&
      t.url === 'app://-/index.html'
    ) || null;
  } catch {
    return null;
  }
}

function cdpEval(wsUrl, expression) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const timer = setTimeout(() => { try { ws.close(); } catch {} reject(new Error('CDP 超时')); }, 5000);
    ws.addEventListener('open', () => {
      ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, returnByValue: true } }));
    });
    ws.addEventListener('message', ev => {
      try {
        const m = JSON.parse(ev.data);
        if (m.id === 1) {
          clearTimeout(timer);
          const res = m.result && m.result.result;
          ws.close();
          if (m.result && m.result.exceptionDetails) {
            reject(new Error('页面异常: ' + (m.result.exceptionDetails.text || '')));
          } else {
            resolve(res ? res.value : undefined);
          }
        }
      } catch {}
    });
    ws.addEventListener('error', () => { clearTimeout(timer); reject(new Error('WebSocket 错误')); });
  });
}

let stopping = false;
let ctl = null;

async function stop(reason) {
  if (stopping) return;
  stopping = true;
  const t = await findMainTarget();
  if (t) { try { await cdpEval(t.webSocketDebuggerUrl, REMOVE_JS); } catch {} }
  if (ctl) ctl.close();
  console.log('[widgetd] 已停止 (' + reason + ')');
  process.exit(0);
}

async function main() {
  if (REMOVE) {
    let daemonStopped = false;
    try {
      await fetch('http://127.0.0.1:' + CTL_PORT + '/stop', { signal: AbortSignal.timeout(900) });
      daemonStopped = true;
    } catch {}
    await sleep(250);
    const t = await findMainTarget();
    if (t) { try { await cdpEval(t.webSocketDebuggerUrl, REMOVE_JS); } catch {} }
    console.log('[widgetd] 悬浮条已卸载' + (daemonStopped ? '（守护进程已停止）' : '（未发现守护进程，已直接清理）'));
    process.exit(0);
  }

  ctl = createServer((req, res) => {
    if (req.url === '/stop') { res.end('stopping'); stop('ctl'); }
    else if (req.url === '/status') { res.end(JSON.stringify({ ok: true, data: DATA_PATH, stopped: stopping })); }
    else res.end('widgetd');
  });
  await new Promise((resolve, reject) => {
    ctl.once('error', e => {
      if (e && e.code === 'EADDRINUSE') { console.log('[widgetd] 已有实例在运行，退出'); process.exit(0); }
      reject(e);
    });
    ctl.listen(CTL_PORT, '127.0.0.1', resolve);
  });

  console.log('[widgetd] 守护启动 · 数据源 ' + DATA_PATH);

  let last = '';
  let lastPush = 0;
  let dataErr = '';
  let pendingChecks = [];
  const scheduleCheck = () => { pendingChecks = [Date.now() + 150000, Date.now() + 420000]; };
  scheduleCheck();
  keepPlugin();
  const tick = async () => {
    if (stopping) return;
    if (pendingChecks.length && Date.now() >= pendingChecks[0]) {
      pendingChecks = [];
      keepPlugin();
    }
    const t = await findMainTarget();
    if (!t) {
      if (last !== 'nodbg') { console.log('[widgetd] 未发现 Codex 调试口，等待中…'); last = 'nodbg'; }
      lastPush = 0;
      return;
    }
    try {
      const r = await cdpEval(t.webSocketDebuggerUrl, INIT_JS);
      if (r !== last) {
        if (r === 'injected' && last === 'nodbg') scheduleCheck();
        console.log('[widgetd] ' + (r === 'injected' ? '已注入悬浮条' : '悬浮条在位'));
        last = r;
      }
      if (Date.now() - lastPush > PUSH_EVERY) {
        let push;
        try {
          push = computePush();
          dataErr = '';
        } catch (e) {
          if (dataErr !== e.message) { console.log('[widgetd] 读取 data.js 失败: ' + e.message); dataErr = e.message; }
          return;
        }
        await cdpEval(t.webSocketDebuggerUrl, 'window.__ccgW && window.__ccgW.update(' + JSON.stringify(push) + ')');
        lastPush = Date.now();
        if (r === 'injected') {
          console.log('[widgetd] 数据已推送: 今日 ' + push.s0 + ' · 近7天 ' + push.s7 + ' · 总计 ' + push.sAll);
        }
      }
    } catch (e) {
      const msg = 'err:' + (e && e.message ? e.message : e);
      if (msg !== last) { console.log('[widgetd] 异常: ' + msg); last = msg; }
    }
  };

  if (ONCE) { await tick(); console.log('[widgetd] --once 完成'); process.exit(0); }
  const FAST_POLL = 1200;
  const run = async () => {
    if (stopping) return;
    try { await tick(); } catch (e) {}
    if (stopping) return;
    const fast = (last === 'nodbg' || last === '' || String(last).indexOf('err:') === 0);
    setTimeout(run, fast ? FAST_POLL : INTERVAL);
  };
  run();
  process.on('SIGINT', () => stop('sigint'));
  process.on('SIGTERM', () => stop('sigterm'));
}

main().catch(e => { console.error('[widgetd] 启动失败: ' + e.message); process.exit(1); });
