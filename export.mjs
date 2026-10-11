#!/usr/bin/env node
/**
 * export.mjs —— 从 cc-switch 数据库导出 token 用量为 data.js
 *
 * 用法:  node export.mjs
 *        node export.mjs --db <path>        指定数据库
 *        node export.mjs --days 30          只导出最近 N 天
 *        node export.mjs --no-synthetic     排除会话导入(合成)条目
 *
 * 默认导出全部数据（含会话导入），页面内可自行过滤。
 *
 * 输出:  data.js   （window.CC_USAGE = {...}，供 index.html 直接 <script> 加载，
 *                    绕开 file:// 下 fetch/XHR 被 CORS 拦截的问题）
 */

import { DatabaseSync } from 'node:sqlite';
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const HERE = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const val  = (k, d = null) => {
  const i = argv.indexOf(k);
  if (i >= 0 && i + 1 < argv.length) return argv[i + 1];
  const kv = argv.find(a => a.startsWith(k + '='));
  return kv ? kv.slice(k.length + 1) : d;
};

const CFG_DIR = join(homedir(), '.cc-switch');
const DB_PATH = val('--db', join(CFG_DIR, 'cc-switch.db'));
const DAYS    = parseInt(val('--days', '0'), 10);
const WITH_SYNTHETIC = !argv.includes('--no-synthetic');

if (!existsSync(DB_PATH)) {
  console.error(`[错误] 找不到数据库: ${DB_PATH}`);
  process.exit(1);
}

const db = new DatabaseSync(DB_PATH, { readOnly: true });

// ════════════════════════════════════════════════════════════
//  供应商名称映射
// ════════════════════════════════════════════════════════════
const providers = db.prepare(
  `SELECT id, app_type, name, is_current FROM providers`
).all();

let settings = {};
try { settings = JSON.parse(readFileSync(join(CFG_DIR, 'settings.json'), 'utf8')); } catch {}

const SETTING_KEY = {
  'claude':         'currentProviderClaude',
  'claude-desktop': 'currentProviderClaudeDesktop',
  'codex':          'currentProviderCodex',
  'gemini':         'currentProviderGemini',
  'openclaw':       'currentProviderOpenclaw',
};

const nameMap = new Map(providers.map(p => [`${p.app_type}\u0000${p.id}`, p.name]));
const curMap  = new Set(providers.filter(p => p.is_current).map(p => `${p.app_type}\u0000${p.id}`));

// ════════════════════════════════════════════════════════════
//  读取明细
// ════════════════════════════════════════════════════════════
const where = [];
const params = [];
if (!WITH_SYNTHETIC) where.push(`data_source <> 'codex_session'`);
if (DAYS > 0) {
  where.push(`created_at >= strftime('%s','now','localtime','-${DAYS} days')`);
}
const WHERE = where.length ? 'WHERE ' + where.join(' AND ') : '';

const rows = db.prepare(`
  SELECT created_at, app_type, provider_id, model, request_model,
         input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens,
         status_code, latency_ms, data_source, total_cost_usd
  FROM proxy_request_logs
  ${WHERE}
  ORDER BY created_at
`).all(...params);

// ════════════════════════════════════════════════════════════
//  压缩为短键，减小 data.js 体积
// ════════════════════════════════════════════════════════════
const records = rows.map(r => ({
  t:   r.created_at,                       // unix 秒
  a:   r.app_type,
  p:   r.provider_id,
  m:   r.model || '(未知)',
  rm:  r.request_model || '',
  i:   r.input_tokens,
  o:   r.output_tokens,
  r:   r.cache_read_tokens,
  w:   r.cache_creation_tokens,
  s:   r.status_code,
  l:   r.latency_ms,
  ds:  r.data_source,
  c:   r.total_cost_usd,
}));

// ════════════════════════════════════════════════════════════
//  元信息
// ════════════════════════════════════════════════════════════
const provList = [...new Set(records.map(r => `${r.a}\u0000${r.p}`))].map(k => {
  const [app, id] = k.split('\u0000');
  const synthetic = id === '_codex_session'
                 || records.some(r => r.p === id && r.ds === 'codex_session');
  return {
    app, id,
    name: nameMap.get(k) || (synthetic ? '会话导入' : id),
    current: curMap.has(k),
    synthetic,
    settingCurrent: settings[SETTING_KEY[app]] === id,
  };
}).sort((x, y) => x.app.localeCompare(y.app) || x.name.localeCompare(y.name));

const dates = [...new Set(records.map(r => {
  const d = new Date(r.t * 1000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}))].sort();

const payload = {
  generatedAt: new Date().toISOString(),
  generatedAtLocal: new Date().toLocaleString('zh-CN', { hour12: false }),
  dbPath: DB_PATH,
  days: DAYS,
  includeSynthetic: WITH_SYNTHETIC,
  dateRange: { min: dates[0] || null, max: dates[dates.length - 1] || null },
  apps:    [...new Set(records.map(r => r.a))].sort(),
  models:  [...new Set(records.map(r => r.m))].sort(),
  providers: provList,
  records,
};

// ════════════════════════════════════════════════════════════
//  写出 data.js
// ════════════════════════════════════════════════════════════
const out = join(HERE, 'data.js');
const json = JSON.stringify(payload);
writeFileSync(out, `window.CC_USAGE = ${json};\n`, 'utf8');

const kb = (Buffer.byteLength(json, 'utf8') / 1024).toFixed(1);
const sum = records.reduce((s, r) => s + r.i + r.o + r.r + r.w, 0);

console.log('数据已导出');
console.log(`  文件      ${out}`);
console.log(`  记录      ${records.length.toLocaleString()} 条`);
console.log(`  供应商    ${provList.length} 个`);
console.log(`  模型      ${payload.models.length} 个`);
console.log(`  日期范围  ${payload.dateRange.min} ~ ${payload.dateRange.max}`);
console.log(`  合计 token ${sum.toLocaleString()}`);
console.log(`  体积      ${kb} KB`);

db.close();
