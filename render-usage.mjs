#!/usr/bin/env node
/**
 * render-usage.mjs — cc-switch token 用量 → Codex 内联可视化
 *
 * 流程:
 *   1. 刷新数据: 运行同目录 export.mjs (--no-refresh 可跳过)
 *   2. 读取 data.js, 聚合今日 / 近7天 / 近30天 / 全部
 *   3. 生成自包含 HTML 片段写入 --out
 *   4. stdout 输出统计摘要 + VISUALIZE_REF 引用行
 *
 * 用法:
 *   node render-usage.mjs [--out <file.html>] [--dir <看板目录>] [--range 7|30|all] [--no-refresh]
 *
 * 默认看板目录: 本脚本所在目录 (可用 --dir 或环境变量 CC_TOKEN_DIR 覆盖)
 * 默认输出:      <看板目录>\usage-view.html
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/* ───────── 参数 ───────── */
const argv = process.argv.slice(2);
const has = f => argv.includes(f);
const val = (k, d = null) => {
  const i = argv.indexOf(k);
  if (i >= 0 && i + 1 < argv.length) return argv[i + 1];
  const kv = argv.find(a => a.startsWith(k + '='));
  return kv ? kv.slice(k.length + 1) : d;
};

const DASH_DIR = resolve(val('--dir', process.env.CC_TOKEN_DIR || dirname(fileURLToPath(import.meta.url))));
const OUT = resolve(val('--out', join(DASH_DIR, 'usage-view.html')));
const REFRESH = !has('--no-refresh');
const rawRange = String(val('--range', '30')).toLowerCase();
const RANGE = rawRange === '7' || rawRange === '30' || rawRange === 'all' ? rawRange : '30';

const DATA_JS = join(DASH_DIR, 'data.js');
const EXPORT_MJS = join(DASH_DIR, 'export.mjs');

/* ───────── 1. 刷新 ───────── */
let refreshNote = '未刷新';
if (REFRESH && existsSync(EXPORT_MJS)) {
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [EXPORT_MJS], { cwd: DASH_DIR, encoding: 'utf8', timeout: 90000, windowsHide: true });
  const ms = Date.now() - t0;
  if (r.status === 0) {
    refreshNote = '已刷新 · ' + ms + ' ms';
  } else {
    refreshNote = '刷新失败 · 使用现有数据';
    const tail = String(r.stderr || '').trim().split(/\r?\n/).filter(Boolean).slice(-1)[0] || '';
    console.error('[render] export.mjs 失败: ' + (r.error ? r.error.message : 'exit ' + r.status) + (tail ? (' / ' + tail) : ''));
  }
}

if (!existsSync(DATA_JS)) {
  console.error('[render] 找不到数据文件: ' + DATA_JS);
  process.exit(1);
}

/* ───────── 2. 读取 + 打包 ───────── */
const raw = readFileSync(DATA_JS, 'utf8');
let payload;
try {
  payload = JSON.parse(raw.slice(raw.indexOf('=') + 1).trim().replace(/;\s*$/, ''));
} catch (e) {
  console.error('[render] data.js 解析失败, 先运行 export.mjs: ' + e.message);
  process.exit(1);
}

const provs = (payload.providers || []).map(p => ({ key: p.app + '\u0000' + p.id, name: p.name, cur: !!p.current }));
const pIdx = new Map(provs.map((p, i) => [p.key, i]));
const models = payload.models || [];
const mIdx = new Map(models.map((m, i) => [m, i]));

const recs = (payload.records || []).map(r => [
  r.t, pIdx.get(r.a + '\u0000' + r.p) ?? -1, mIdx.get(r.m) ?? -1,
  r.i | 0, r.o | 0, r.r | 0, r.w | 0, r.s | 0, r.l | 0,
  Number(r.c) || 0,
]);

const packed = {
  gen: payload.generatedAtLocal || '',
  dbPath: payload.dbPath || '',
  refreshNote,
  defRange: RANGE,
  provs,
  models,
  recs,
};

/* ───────── 3. 摘要 (stdout) ───────── */
const pad2 = n => (n < 10 ? '0' : '') + n;
const dayKeyOf = ts => {
  const d = new Date(ts * 1000);
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
};
const TODAY = dayKeyOf(Date.now() / 1000);
const cutoffOf = range => {
  if (range === 'all') return 0;
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime() / 1000 - ((range === '7' ? 7 : 30) - 1) * 86400;
};
const aggOf = rs => {
  let t = 0, cost = 0, n = 0, err = 0;
  for (const r of rs) {
    t += r[3] + r[4] + r[5] + r[6];
    cost += r[9];
    n++;
    if (r[7] >= 400) err++;
  }
  return { t, cost, n, err };
};
const trimNum = s => s.replace(/\.0+$/, '').replace(/(\.\d)0+$/, '$1');
const fmtTok = n => (n >= 1e8 ? trimNum((n / 1e8).toFixed(2)) + '亿' : n >= 1e4 ? trimNum((n / 1e4).toFixed(1)) + '万' : String(n));
const fmtCost = c => (!c ? '$0' : c >= 1 ? '$' + c.toFixed(2) : c >= 0.01 ? '$' + c.toFixed(3) : '$' + c.toFixed(4));
const inRange = range => {
  const c = cutoffOf(range);
  return recs.filter(r => r[0] >= c);
};

const summaryRows = [
  ['今日  ', aggOf(recs.filter(r => dayKeyOf(r[0]) === TODAY))],
  ['近7天 ', aggOf(inRange('7'))],
  ['近30天', aggOf(inRange('30'))],
  ['全部  ', aggOf(recs)],
];
for (const [label, a] of summaryRows) {
  console.log('[summary] ' + label + ' ' + fmtTok(a.t) + ' tokens · ' + fmtCost(a.cost) + ' · ' + a.n.toLocaleString('zh-CN') + ' 次请求' + (a.err ? (' · ' + a.err + ' 错误') : ''));
}

/* ───────── 4. 生成片段 ───────── */
const FRAG_A = `<div id="cc-token-usage" lang="zh-CN">
<style>
#cc-token-usage { display: flex; flex-direction: column; gap: 14px; }
#cc-token-usage .cc-sec { display: flex; flex-direction: column; gap: 6px; }
#cc-token-usage .cc-sec-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
#cc-token-usage .cc-chart-wrap { width: 100%; }
#cc-token-usage svg.cc-chart { display: block; width: 100%; height: auto; }
#cc-token-usage svg.cc-chart text { fill: var(--foreground); font-size: 12px; }
#cc-token-usage svg.cc-chart text.cc-tick { fill: var(--muted-foreground); }
#cc-token-usage svg.cc-chart rect[data-chart-frame] { fill: none; stroke: var(--border); stroke-width: 1; }
#cc-token-usage svg.cc-chart line.cc-grid { stroke: var(--border); stroke-width: 1; opacity: 0.6; }
#cc-token-usage .cc-swatch { display: inline-block; width: 10px; height: 10px; border-radius: 2px; margin-right: 6px; }
#cc-token-usage .cc-series-btn { border: 0; background: transparent; padding: 2px 6px; color: var(--muted-foreground); }
#cc-token-usage .cc-series-btn[aria-pressed="true"] { color: var(--foreground); }
#cc-token-usage .cc-series-btn[aria-pressed="false"] { text-decoration: line-through; }
#cc-token-usage .cc-series-btn[aria-pressed="false"] .cc-swatch { opacity: 0.25; }
#cc-token-usage .viz-grid > .cc-sec { min-width: 0; }
#cc-token-usage .cc-bar-row { display: grid; grid-template-columns: minmax(72px, 190px) 1fr auto; gap: 8px; align-items: center; margin: 6px 0; }
#cc-token-usage .cc-bar-row > * { min-width: 0; }
#cc-token-usage .cc-bar-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
#cc-token-usage .cc-bar-val { white-space: nowrap; }
#cc-token-usage .cc-empty { color: var(--muted-foreground); }
</style>
<div>
  <h2 style="margin: 0 0 2px;">Token 用量</h2>
  <p class="text-small text-muted" id="cc-meta" style="margin: 0;"></p>
</div>
<div class="viz-grid" id="cc-cards"></div>
<div class="cc-sec">
  <div class="cc-sec-head">
    <h3 style="margin: 0;" id="cc-chart-title">每日用量</h3>
    <div class="viz-controls" role="group" aria-label="时间范围">
      <button type="button" class="btn" data-range="7">近 7 天</button>
      <button type="button" class="btn" data-range="30">近 30 天</button>
      <button type="button" class="btn" data-range="all">全部</button>
    </div>
  </div>
  <div class="viz-controls" id="cc-series" role="group" aria-label="系列开关"></div>
  <div class="cc-chart-wrap" id="cc-chart-wrap" aria-live="polite"></div>
</div>
<hr>
<div class="viz-grid">
  <div class="cc-sec"><h3 style="margin: 0;">供应商</h3><div id="cc-prov"></div></div>
  <div class="cc-sec"><h3 style="margin: 0;">模型（Top 8）</h3><div id="cc-model"></div></div>
</div>
<hr>
<div class="cc-sec">
  <h3 style="margin: 0;">最近请求（最新 10 条）</h3>
  <div class="table-responsive">
    <table class="table table-sm">
      <thead>
        <tr>
          <th class="text-nowrap">时间</th><th class="text-nowrap">模型</th>
          <th class="text-end text-nowrap">输入</th><th class="text-end text-nowrap">输出</th><th class="text-end text-nowrap">缓存读</th>
          <th class="text-end text-nowrap">耗时</th><th class="text-end text-nowrap">成本</th>
        </tr>
      </thead>
      <tbody id="cc-recent"></tbody>
    </table>
  </div>
</div>
<p class="text-small text-muted" id="cc-foot" style="margin: 0;"></p>
<script>
(function () {
  'use strict';
  var root = document.getElementById('cc-token-usage');
  if (!root) return;
  var DATA = `;

const FRAG_B = `;
  var REC = DATA.recs, PROV = DATA.provs, MODELS = DATA.models;
  var SERIES = [
    { label: '输入', color: 'var(--viz-series-1)' },
    { label: '输出', color: 'var(--viz-series-2)' },
    { label: '缓存读', color: 'var(--viz-series-3)' },
    { label: '缓存写', color: 'var(--viz-series-4)' }
  ];
  var RANGE_LABEL = { '7': '近 7 天', '30': '近 30 天', 'all': '全部' };
  var state = { range: DATA.defRange, hidden: [false, false, false, false] };

  function $(id) { return document.getElementById(id); }
  function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  function dayKey(ts) { var d = new Date(ts * 1000); return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()); }
  function todayKey() { return dayKey(Math.floor(Date.now() / 1000)); }
  function cutoff(range) {
    if (range === 'all') return 0;
    var d = new Date();
    d.setHours(0, 0, 0, 0);
    return Math.floor(d.getTime() / 1000) - ((range === '7' ? 7 : 30) - 1) * 86400;
  }
  function recsIn(range) {
    var c = cutoff(range), out = [];
    for (var i = 0; i < REC.length; i++) if (REC[i][0] >= c) out.push(REC[i]);
    return out;
  }
  function trimNum(s) { return s.replace(/\\.0+$/, '').replace(/(\\.\\d)0+$/, '$1'); }
  function fmtTok(n) { return n >= 1e8 ? trimNum((n / 1e8).toFixed(2)) + '亿' : n >= 1e4 ? trimNum((n / 1e4).toFixed(1)) + '万' : String(n); }
  function fmtCost(c) { return !c ? '$0' : c >= 1 ? '$' + c.toFixed(2) : c >= 0.01 ? '$' + c.toFixed(3) : '$' + c.toFixed(4); }
  function fmtDur(ms) { if (!ms) return '—'; var s = ms / 1000; return s >= 10 ? Math.round(s) + 's' : s.toFixed(1) + 's'; }
  function fmtTime(ts) {
    var d = new Date(ts * 1000);
    if (dayKey(ts) === todayKey()) return pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds());
    if (d.getFullYear() === new Date().getFullYear()) return (d.getMonth() + 1) + '月' + d.getDate() + '日 ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
    return d.getFullYear() + '/' + (d.getMonth() + 1) + '/' + d.getDate();
  }
  function agg(rs) {
    var t = 0, cost = 0, n = 0, err = 0;
    for (var i = 0; i < rs.length; i++) {
      var r = rs[i];
      t += r[3] + r[4] + r[5] + r[6];
      cost += r[9];
      n++;
      if (r[7] >= 400) err++;
    }
    return { t: t, cost: cost, n: n, err: err };
  }

  /* ── 统计卡 ── */
  function renderCards() {
    var cards = [
      ['今日', agg(REC.filter(function (r) { return dayKey(r[0]) === todayKey(); }))],
      ['近 7 天', agg(recsIn('7'))],
      ['近 30 天', agg(recsIn('30'))],
      ['全部', agg(REC)]
    ];
    var html = '';
    for (var i = 0; i < cards.length; i++) {
      var a = cards[i][1];
      html += '<div class="card viz-stat">'
        + '<div class="text-small text-muted">' + cards[i][0] + '</div>'
        + '<div class="viz-stat-value tabular-nums" data-tooltip="' + a.t.toLocaleString('zh-CN') + ' tokens">' + fmtTok(a.t) + '</div>'
        + '<div class="text-small tabular-nums">' + fmtCost(a.cost) + ' · ' + a.n.toLocaleString('zh-CN') + ' 次' + (a.err ? ' · <span class="text-destructive">' + a.err + ' 错误</span>' : '') + '</div>'
        + '</div>';
    }
    $('cc-cards').innerHTML = html;
  }

  /* ── 逐日数据 ── */
  function daysFor(range, rs) {
    var map = {};
    for (var i = 0; i < rs.length; i++) {
      var r = rs[i], k = dayKey(r[0]);
      var v = map[k] || (map[k] = [0, 0, 0, 0]);
      v[0] += r[3]; v[1] += r[4]; v[2] += r[5]; v[3] += r[6];
    }
    var start = new Date();
    start.setHours(0, 0, 0, 0);
    if (range === 'all') {
      var min = Infinity;
      for (var j = 0; j < rs.length; j++) if (rs[j][0] < min) min = rs[j][0];
      if (min === Infinity) return [];
      start = new Date(min * 1000);
      start.setHours(0, 0, 0, 0);
    } else {
      start = new Date(start.getTime() - ((range === '7' ? 7 : 30) - 1) * 86400000);
    }
    var end = new Date();
    end.setHours(0, 0, 0, 0);
    var days = [];
    for (var t = start.getTime(); t <= end.getTime(); t += 86400000) {
      var d = new Date(t), k2 = dayKey(Math.floor(t / 1000));
      days.push({ label: (d.getMonth() + 1) + '/' + d.getDate(), vals: map[k2] || [0, 0, 0, 0] });
    }
    return days;
  }
  function niceMax(v) {
    if (v <= 0) return 1;
    var p = Math.pow(10, Math.floor(Math.log(v) / Math.LN10)), m = v / p;
    var steps = [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10];
    for (var i = 0; i < steps.length; i++) if (m <= steps[i] + 1e-9) return steps[i] * p;
    return 10 * p;
  }

  /* ── 柱状图 ── */
  function renderChart() {
    var wrap = $('cc-chart-wrap');
    $('cc-chart-title').textContent = '每日用量 · ' + (RANGE_LABEL[state.range] || '');
    var rs = recsIn(state.range);
    var days = daysFor(state.range, rs);
    var max = 0;
    for (var i = 0; i < days.length; i++) {
      var tot = 0;
      for (var s = 0; s < 4; s++) if (!state.hidden[s]) tot += days[i].vals[s];
      if (tot > max) max = tot;
    }
    if (!days.length || max <= 0) {
      wrap.innerHTML = '<p class="cc-empty text-small" style="margin: 8px 0;">该区间暂无数据</p>';
      return;
    }
    var W = Math.max(320, Math.round(wrap.clientWidth || 700));
    var H = 252, L = 64, R = 10, T = 8, B = 42;
    var PW = W - L - R, PH = H - T - B;
    var nice = niceMax(max);
    var unit = nice >= 1e8 ? 1e8 : 1e4, unitLabel = nice >= 1e8 ? '亿' : '万';
    var slot = PW / days.length;
    var barW = Math.max(3, Math.min(40, slot - 6));
    var p = [];
    p.push('<svg class="cc-chart" viewBox="0 0 ' + W + ' ' + H + '" width="' + W + '" height="' + H + '" role="img" aria-label="每日 token 用量堆叠柱状图">');
    p.push('<rect data-chart-frame x="' + L + '" y="' + T + '" width="' + PW + '" height="' + PH + '"></rect>');
    for (var k = 0; k <= 4; k++) {
      var yv = T + PH - (k / 4) * PH;
      p.push('<line class="cc-grid" x1="' + L + '" y1="' + yv.toFixed(1) + '" x2="' + (L + PW) + '" y2="' + yv.toFixed(1) + '"></line>');
      var tv = nice * k / 4 / unit;
      p.push('<text class="cc-tick" x="' + (L - 8) + '" y="' + (yv + 4).toFixed(1) + '" text-anchor="end">' + (tv % 1 === 0 ? tv.toFixed(0) : tv.toFixed(1)) + '</text>');
    }
    var maxLabels = Math.max(3, Math.floor(PW / 64));
    var stepX = Math.ceil(days.length / maxLabels);
    for (var di = 0; di < days.length; di += stepX) {
      var cx = L + di * slot + slot / 2;
      p.push('<text class="cc-tick" x="' + cx.toFixed(1) + '" y="' + (T + PH + 16) + '" text-anchor="middle">' + days[di].label + '</text>');
    }
    for (var bi = 0; bi < days.length; bi++) {
      var bx = L + bi * slot + (slot - barW) / 2;
      var bottom = T + PH;
      for (var si = 0; si < 4; si++) {
        if (state.hidden[si]) continue;
        var val = days[bi].vals[si];
        if (!val) continue;
        var hgt = val / nice * PH;
        var by = bottom - hgt;
        p.push('<rect x="' + bx.toFixed(1) + '" y="' + by.toFixed(1) + '" width="' + barW.toFixed(1) + '" height="' + hgt.toFixed(1) + '" style="fill:' + SERIES[si].color + '"></rect>');
        bottom = by;
      }
    }
    for (var oi = 0; oi < days.length; oi++) {
      var parts2 = [days[oi].label], tot2 = 0;
      for (var s2 = 0; s2 < 4; s2++) {
        if (state.hidden[s2]) continue;
        var v2 = days[oi].vals[s2];
        tot2 += v2;
        if (v2) parts2.push(SERIES[s2].label + ' ' + fmtTok(v2));
      }
      if (tot2 <= 0) continue;
      p.push('<rect x="' + (L + oi * slot).toFixed(1) + '" y="' + T + '" width="' + slot.toFixed(1) + '" height="' + PH + '" fill="transparent" pointer-events="all" data-tooltip="' + esc(parts2.join(' · ')) + '"></rect>');
    }
    p.push('<text class="axis-title" data-axis="y" transform="translate(15,' + (T + PH / 2) + ') rotate(-90)" text-anchor="middle">token（' + unitLabel + '）</text>');
    p.push('<text class="axis-title" data-axis="x" x="' + (L + PW / 2) + '" y="' + (H - 8) + '" text-anchor="middle">日期</text>');
    p.push('</svg>');
    wrap.innerHTML = p.join('');
  }

  /* ── 供应商 / 模型 ── */
  function fillRows(el, entries, total, nameOf, curOf) {
    if (!entries.length || total <= 0) {
      el.innerHTML = '<p class="cc-empty text-small" style="margin: 8px 0;">该区间暂无数据</p>';
      return;
    }
    var html = '';
    for (var i = 0; i < entries.length; i++) {
      var idx = entries[i][0], v = entries[i][1];
      if (!v) continue;
      var pct = v / total * 100;
      var name = esc(nameOf(idx));
      if (curOf && curOf(idx)) name += ' <span class="text-small text-muted">当前</span>';
      html += '<div class="cc-bar-row">'
        + '<div class="cc-bar-name text-small">' + name + '</div>'
        + '<div class="progress" role="progressbar" aria-label="占总量比例" aria-valuemin="0" aria-valuemax="100" aria-valuenow="' + Math.round(pct) + '"><div class="progress-bar" style="width:' + pct.toFixed(1) + '%"></div></div>'
        + '<div class="cc-bar-val text-small tabular-nums" data-tooltip="' + v.toLocaleString('zh-CN') + ' tokens">' + fmtTok(v) + '</div>'
        + '</div>';
    }
    el.innerHTML = html;
  }
  function renderBreakdowns() {
    var rs = recsIn(state.range);
    var byP = {}, byM = {}, total = 0;
    for (var i = 0; i < rs.length; i++) {
      var r = rs[i], v = r[3] + r[4] + r[5] + r[6];
      total += v;
      byP[r[1]] = (byP[r[1]] || 0) + v;
      byM[r[2]] = (byM[r[2]] || 0) + v;
    }
    var keysP = Object.keys(byP).map(Number).sort(function (a, b) { return byP[b] - byP[a]; });
    fillRows($('cc-prov'), keysP.map(function (k) { return [k, byP[k]]; }), total,
      function (idx) { var pv = PROV[idx]; return pv ? pv.name : '未知'; },
      function (idx) { return PROV[idx] && PROV[idx].cur; });
    var keysM = Object.keys(byM).map(Number).sort(function (a, b) { return byM[b] - byM[a]; }).slice(0, 8);
    fillRows($('cc-model'), keysM.map(function (k) { return [k, byM[k]]; }), total,
      function (idx) { return idx >= 0 ? MODELS[idx] : '未知'; }, null);
  }

  /* ── 最近请求 ── */
  function renderRecent() {
    var rows = REC.slice().sort(function (a, b) { return b[0] - a[0]; }).slice(0, 10);
    var html = '';
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      var mName = r[2] >= 0 ? MODELS[r[2]] : '未知';
      var isErr = r[7] >= 400;
      html += '<tr>'
        + '<td class="text-nowrap">' + fmtTime(r[0]) + '</td>'
        + '<td>' + esc(mName || '未知') + '</td>'
        + '<td class="text-end tabular-nums text-nowrap" data-tooltip="' + r[3].toLocaleString('zh-CN') + ' tokens">' + fmtTok(r[3]) + '</td>'
        + '<td class="text-end tabular-nums text-nowrap" data-tooltip="' + r[4].toLocaleString('zh-CN') + ' tokens">' + fmtTok(r[4]) + '</td>'
        + '<td class="text-end tabular-nums text-nowrap" data-tooltip="' + r[5].toLocaleString('zh-CN') + ' tokens">' + fmtTok(r[5]) + '</td>'
        + '<td class="text-end tabular-nums text-nowrap' + (isErr ? ' text-destructive' : '') + '">' + fmtDur(r[8]) + (isErr ? ' · ' + r[7] : '') + '</td>'
        + '<td class="text-end tabular-nums text-nowrap">' + fmtCost(r[9]) + '</td>'
        + '</tr>';
    }
    $('cc-recent').innerHTML = html;
  }

  /* ── 控件 ── */
  function renderSeriesButtons() {
    var el = $('cc-series'), html = '';
    for (var i = 0; i < SERIES.length; i++) {
      html += '<button type="button" class="cc-series-btn text-small cursor-interaction" data-i="' + i + '" aria-pressed="' + (!state.hidden[i]) + '">'
        + '<span class="cc-swatch" style="background:' + SERIES[i].color + '"></span>' + SERIES[i].label + '</button>';
    }
    el.innerHTML = html;
    var btns = el.querySelectorAll('button');
    for (var j = 0; j < btns.length; j++) {
      btns[j].addEventListener('click', function () {
        var i2 = Number(this.getAttribute('data-i'));
        state.hidden[i2] = !state.hidden[i2];
        this.setAttribute('aria-pressed', String(!state.hidden[i2]));
        renderChart();
      });
    }
  }
  function updateRangeButtons() {
    var btns = document.querySelectorAll('#cc-token-usage [data-range]');
    for (var i = 0; i < btns.length; i++) {
      btns[i].setAttribute('aria-pressed', String(btns[i].getAttribute('data-range') === state.range));
    }
  }
  function wireRangeButtons() {
    var btns = document.querySelectorAll('#cc-token-usage [data-range]');
    for (var i = 0; i < btns.length; i++) {
      btns[i].addEventListener('click', function () {
        state.range = this.getAttribute('data-range');
        updateRangeButtons();
        renderChart();
        renderBreakdowns();
      });
    }
  }

  function init() {
    $('cc-meta').textContent = '数据更新于 ' + DATA.gen + ' · 共 ' + REC.length.toLocaleString('zh-CN') + ' 条请求记录';
    $('cc-foot').textContent = DATA.refreshNote + ' · 数据源 ' + DATA.dbPath;
    renderCards();
    renderSeriesButtons();
    wireRangeButtons();
    updateRangeButtons();
    renderBreakdowns();
    renderChart();
    renderRecent();
    if (window.ResizeObserver) new ResizeObserver(function () { renderChart(); }).observe($('cc-chart-wrap'));
    window.addEventListener('resize', renderChart);
  }
  try {
    init();
  } catch (e) {
    var box = document.createElement('p');
    box.className = 'text-destructive text-small';
    box.textContent = '图表渲染失败: ' + ((e && e.message) ? e.message : String(e));
    root.appendChild(box);
  }
})();
</script>
</div>`;

const fragment = FRAG_A + JSON.stringify(packed).replace(/</g, '\\u003c') + FRAG_B;
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, fragment, 'utf8');

const kb = (Buffer.byteLength(fragment, 'utf8') / 1024).toFixed(1);
console.log('[render] ' + refreshNote + ' · 记录 ' + recs.length.toLocaleString('zh-CN') + ' 条');
console.log('[render] 已写入 ' + OUT + ' (' + kb + ' KB)');

const REF = '\uE200visualize\uE202' + JSON.stringify({ path: OUT, title: 'Token 用量' }) + '\uE201';
console.log('VISUALIZE_REF:' + REF);
