#!/usr/bin/env node
/**
 * probe-cdp.mjs — 只读探测: Codex 应用的 CDP 调试通道是否可用
 * 用法: node probe-cdp.mjs [port]   默认 9229
 * 只做两件事: 列出页面 targets; 在主窗口上执行一个只读表达式。不改动任何 DOM。
 */
import { readFileSync } from 'node:fs';

const args = process.argv.slice(2);
const skip = new Set();
for (const k of ['--expr', '--expr-file', '--url']) {
  const i = args.indexOf(k);
  if (i >= 0) { skip.add(i); skip.add(i + 1); }
}
const exprIdx = args.indexOf('--expr');
const exprFileIdx = args.indexOf('--expr-file');
const CUSTOM_EXPR = exprFileIdx >= 0
  ? readFileSync(args[exprFileIdx + 1], 'utf8')
  : (exprIdx >= 0 ? args[exprIdx + 1] : null);
const urlIdx = args.indexOf('--url');
const URL_FILTER = urlIdx >= 0 ? args[urlIdx + 1] : null;
const PORT = args.filter((a, i) => !skip.has(i))[0] || '9229';
const base = 'http://127.0.0.1:' + PORT;

let list;
try {
  const r = await fetch(base + '/json/list', { signal: AbortSignal.timeout(4000) });
  list = await r.json();
} catch (e) {
  console.error('[probe] 连接 ' + base + ' 失败: ' + e.message);
  process.exit(1);
}

const pages = list.filter(t => t.type === 'page');
console.log('[probe] 页面 targets: ' + pages.length + ' 个');
for (const p of pages.slice(0, 20)) {
  console.log('  - ' + (p.title || '(无标题)').slice(0, 30) + '  <-  ' + String(p.url).slice(0, 80));
}

const target = URL_FILTER
  ? pages.find(p => String(p.url).indexOf(URL_FILTER) >= 0)
  : (pages.find(p => p.url === 'app://-/index.html')
    || pages.find(p => p.url && !p.url.startsWith('devtools://') && !p.url.startsWith('chrome-extension://')
      && !/initialRoute=%2Favatar-overlay/i.test(p.url)));
if (!target || !target.webSocketDebuggerUrl) {
  console.error('[probe] 没找到可附加的页面 target');
  process.exit(1);
}

const ws = new WebSocket(target.webSocketDebuggerUrl);
const expression = CUSTOM_EXPR || "JSON.stringify({href: location.href, title: document.title, w: window.innerWidth, h: window.innerHeight, dpr: window.devicePixelRatio})";

const result = await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('evaluate 超时')), 6000);
  ws.addEventListener('open', () => {
    ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise: true } }));
  });
  ws.addEventListener('message', ev => {
    try {
      const msg = JSON.parse(ev.data);
      if (msg.id === 1) {
        clearTimeout(timer);
        resolve(msg.result && msg.result.result ? msg.result.result.value : JSON.stringify(msg));
      }
    } catch {}
  });
  ws.addEventListener('error', () => { clearTimeout(timer); reject(new Error('WebSocket 错误')); });
});

console.log('[probe] 主窗口信息: ' + result);
ws.close();
