#!/usr/bin/env node
/**
 * shot.mjs — 抓一张 Codex 主窗口截图 (via CDP), 用于验证悬浮条效果
 * 用法: node shot.mjs [out.png] [port]
 */

import { writeFileSync } from 'node:fs';

const OUT = process.argv[2] || 'codex-shot.png';
const PORT = process.argv[3] || '9229';

let list;
try {
  const r = await fetch('http://127.0.0.1:' + PORT + '/json/list', { signal: AbortSignal.timeout(4000) });
  list = await r.json();
} catch (e) {
  console.error('[shot] 连接调试口失败: ' + e.message);
  process.exit(1);
}

const t = list.find(x => x.type === 'page' && x.webSocketDebuggerUrl && x.url === 'app://-/index.html')
  || list.find(x =>
    x.type === 'page' && x.webSocketDebuggerUrl &&
    !String(x.url).startsWith('devtools://') &&
    !/initialRoute=%2Favatar-overlay/i.test(String(x.url))
  );
if (!t) { console.error('[shot] 未找到主窗口 target'); process.exit(1); }

const ws = new WebSocket(t.webSocketDebuggerUrl);
const data = await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('截图超时')), 8000);
  ws.addEventListener('open', () => {
    ws.send(JSON.stringify({ id: 1, method: 'Page.enable' }));
    ws.send(JSON.stringify({ id: 2, method: 'Page.captureScreenshot', params: { format: 'png' } }));
  });
  ws.addEventListener('message', ev => {
    try {
      const m = JSON.parse(ev.data);
      if (m.id === 2 && m.result && m.result.data) {
        clearTimeout(timer);
        resolve(m.result.data);
      }
    } catch {}
  });
  ws.addEventListener('error', () => { clearTimeout(timer); reject(new Error('WebSocket 错误')); });
});

writeFileSync(OUT, Buffer.from(data, 'base64'));
console.log('[shot] 已保存 ' + OUT);
ws.close();
