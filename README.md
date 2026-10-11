# Codex Token Usage

把 cc-switch 记录的 AI 请求 token 用量、成本、缓存命中、模型与供应商分布，做成三层体验：

1. **对话内嵌图表** —— 直接问 Codex「看看我这周的 token 用量」，图表渲染在对话里。
2. **本地网页看板** —— 完整交互看板，地址 http://127.0.0.1:8788/
3. **窗口悬浮条** —— 常驻在 Codex 窗口菜单栏右侧，显示今日 / 近 7 天 / 总计，每 15 秒刷新。

数据来源是 cc-switch 的本地代理日志（SQLite），只读，不上传任何数据。

## 特性

- 今日 / 近 7 天 / 近 30 天 / 全部：token、成本、请求数
- 按模型、按供应商的占比与排行
- 缓存读取 / 写入 token、错误率、延迟
- 最近请求明细
- 悬浮条随对话页显示，切到设置页 / 插件页自动隐藏
- 开机自启 + 守护自愈（Windows）
- 同时提供一个 Codex 插件（skill），对话里即可查用量
## 环境要求

| 项 | 要求 |
|---|---|
| 系统 | Windows 10 / 11 |
| Node.js | 22 或更高（export.mjs 依赖内置 node:sqlite） |
| cc-switch | 已在本机运行并产生 %USERPROFILE%\.cc-switch\cc-switch.db |
| Codex 桌面版 | 仅「悬浮条」功能需要 |

## 快速开始

### 方式 A：一键安装（推荐）

在本仓库目录用 PowerShell 运行：

    powershell -ExecutionPolicy Bypass -File .\install.ps1

安装脚本会：

1. 把文件复制到 %USERPROFILE%\.codex\codex-token-usage\
2. 注册插件市场与 codex-token-usage 插件
3. 写入开机自启（启动文件夹 + 注册表 Run）
4. 启动本地服务与守护进程

### 方式 B：只看看看板

    node export.mjs
    node serve.mjs --open

浏览器会自动打开 http://127.0.0.1:8788/

## 目录结构

    codex-token-usage/
    ├─ index.html           看板页面（单文件，含图表）
    ├─ serve.mjs            本地服务：托管页面 + 定时导出（8788）
    ├─ export.mjs           从 cc-switch.db 导出 data.js
    ├─ render-usage.mjs     生成 Codex 对话内嵌图表
    ├─ widgetd.mjs          CDP 注入守护：把悬浮条注入 Codex 窗口（8791）
    ├─ watchdog.ps1         健康看护：保活服务 + 自动带调试口重启 Codex（8792）
    ├─ widget-boot.ps1/.vbs 登录自启：拉起 serve + widgetd
    ├─ widget-on.bat / widget-off.bat  手动开关悬浮条
    ├─ restart-codex.ps1    关闭并以 --remote-debugging-port=9229 重启 Codex
    ├─ plugin/              Codex 插件（skill）
    └─ tools/               CDP 探针与截图（调试用）

## 工作原理

1. cc-switch 把每次 AI 请求写进 cc-switch.db（SQLite）。
2. export.mjs 只读导出成 data.js（window.CC_USAGE = ...）。
3. serve.mjs 托管 index.html，并按固定间隔重跑导出。
4. 悬浮条：widgetd.mjs 通过 Chrome DevTools Protocol（要求 Codex 以 --remote-debugging-port=9229 启动）向 Codex 主窗口注入 Shadow DOM；页面 CSP 禁止 iframe/fetch，数据由 widgetd 从 data.js 读取后经 CDP 推给页面。
5. watchdog.ps1 每 15 秒体检：服务掉了就拉起；Codex 是裸启动（有进程但没 9229）就自动带调试口重启；插件注册丢了就补回。

## 手动注册 Codex 插件

    codex plugin marketplace add "<仓库或安装目录>"
    codex plugin add codex-token-usage@codex-token-usage

或在 Codex 桌面版的插件市场里添加本地市场后安装。

## 常见问题

**悬浮条不显示？**
- 先确认 Codex 带调试口启动：命令行里应有 --remote-debugging-port=9229。
- 手动重启：双击 restart-codex.bat（会关闭并以带调试口方式重开 Codex）。
- 确认守护在跑：widget-on.bat 可重新拉起。

**看板打不开？**
- 确认服务在跑：访问 http://127.0.0.1:8788/api/ping 应返回 JSON。
- 端口被占用：node serve.mjs --port 9000

**数据是空的 / 报找不到数据库？**
- 确认 cc-switch 已运行并生成了 %USERPROFILE%\.cc-switch\cc-switch.db。
- 可用 node export.mjs --db <你的路径> 指定数据库。

**重启电脑后还有效吗？**
- 有。启动文件夹里的快捷方式与注册表 Run 项会在登录时拉起服务与守护。

## 许可

MIT
