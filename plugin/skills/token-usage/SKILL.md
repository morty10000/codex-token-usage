---
name: "token-usage"
description: "查看 cc-switch 记录的 AI 请求 token 用量、成本、缓存命中与模型/供应商分布，并把用量图直接显示在 Codex 对话里；也负责把完整用量看板挂进 Codex 内置浏览器面板。当用户询问用量、消耗、花了多少、token 数、账单、统计，或要求打开 / 挂起用量看板时使用。"
---

# Token 用量（cc-switch）

## 数据背景

- 数据源：`%USERPROFILE%\.cc-switch\cc-switch.db`（cc-switch 代理日志，SQLite；只读使用，禁止修改）
- 看板目录：`{{DASH_DIR}}`（`export.mjs` 从数据库导出 `data.js`；`index.html` + `serve.mjs` 是完整网站）
- 渲染脚本：`{{DASH_DIR}}\render-usage.mjs`（刷新 + 聚合 + 生成对话内嵌图表一条龙）
## 场景 1：用户在对话里问用量 / 花费 / 统计（默认做法）

1. 选输出位置：
   - 优先：本线程的可视化目录（能看到 `...\.codex\visualizations\<年>\<月>\<日>\<线程ID>\` 这种路径就写进去）
   - 兜底：`{{DASH_DIR}}\usage-view.html`
   - 文件名固定用 `token-usage.html`
2. 运行（脚本会先刷新数据再渲染，约 2–3 秒）：
   ```
   node "{{DASH_DIR}}\render-usage.mjs" --out "<输出目录>\token-usage.html"
   ```
   可选参数：`--range 7|30|all`（图表默认区间）、`--no-refresh`（跳过刷新，用现有 data.js）
3. 读 stdout：
   - `[summary]` 行 = 今日 / 近 7 天 / 近 30 天 / 全部的 token、成本、请求数。回答里报数字只用这些。
   - `VISUALIZE_REF:` 行 = 内容引用。把该行之后全部内容（含首尾私有区字符）原样、单独占一行放进本回合最终回复，Codex 会把它渲染成对话内嵌图表。
4. 回复纪律：
   - 引用行独自占一行，前后不要拼接其他文字
   - 不要再附 Markdown 表格或重复图里的数据；最多一句结论
   - 不要描述实现、HTML、文件路径，不要说截图 / 附件 / 图片

## 场景 2：用户要把看板挂进窗口 / 常驻显示

1. 启动本地服务（若已在运行，新进程会自动退出，属正常现象）：用 node 运行本目录下的 serve.mjs，参数 --interval 300。
2. 用 open_in_codex 工具、以 type=browser 打开 http://127.0.0.1:8788/ ，把看板开进 Codex 窗口的内置浏览器面板。
3. 服务每 5 分钟自动刷新数据，面板常驻即可。

## 场景 3：悬浮条（窗口内常驻小条）

- 开启：运行 `{{DASH_DIR}}\widget-on.bat`（内容 = 今日 / 近 7 天 / 总计；位置 = 菜单栏帮助右侧；数据每 15 秒刷新）
- 关闭：运行 `{{DASH_DIR}}\widget-off.bat`
- 显示范围：仅在对话页显示（检测到输入框时）；切到插件页 / 设置页等非对话界面或弹出大浮层时会自动隐藏
- 实现要点：`widgetd.mjs` 通过 CDP（要求 Codex 以 `--remote-debugging-port=9229` 启动）向主窗口注入 Shadow DOM 悬浮条；页面 CSP 禁止 iframe 与 fetch，数据由守护进程从 `data.js` 读取后经 CDP 推给页面。
- 排查：悬浮条消失时，先用 Get-NetTCPConnection 检查本地 9229 端口是否在监听，再重启 widget-on.bat；若 Codex 未带 9229 启动，守护进程会自动带调试口重启 Codex（见 watchdog.ps1）。
- 自愈与自启：登录时由 Startup 文件夹快捷方式静默拉起 serve 与 widgetd，并由 watchdog.ps1 每 15 秒体检自愈；widgetd 检测到插件注册缺失会自动重新注册。

## 故障处理

- 报「找不到数据文件」：先运行 export.mjs；export 失败说明 cc-switch 数据库不在默认位置。
- 报刷新失败但渲染继续：图上用的是上一次的数据，仍可正常显示；除非用户追问，否则不要主动提错误。
- 数据库缺失：如实告诉用户 cc-switch 未初始化或数据库路径不同，不要伪造数据。

## 禁止

- 不要手写或拼接 VISUALIZE_REF 标记（私有区字符极易写错），只允许使用脚本 stdout 中的原样输出。
- 不要修改 data.js、cc-switch.db 或看板目录中的其他文件。
