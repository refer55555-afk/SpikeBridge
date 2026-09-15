# Spike Bridge

**Local-first MCP multi-agent workbench with a desktop GUI, dual Codex accounts, remote Mac Worker control, token usage analytics, Memory and Safe-Boot.**

Spike Bridge 是一个面向本机开发工作流的多 Agent 桥和可视化工作台。它把 Codex、本地工具、两个可独立登录的 Codex 账号、ZCode、第二台 Mac Worker、Memory、Safe-Boot 与 Operator 工作台统一到一个本机控制面中。

它的重点不是“再做一个命令行包装器”，而是让多 Agent 真正变成一个可以长期打开使用的**桌面式控制台**：你可以在窗口里看任务、切换/观察两个 Codex 账户、查看 Provider 状态、管理审批与恢复，并持续统计每次执行产生的 Token 用量。

> Keywords: MCP, Model Context Protocol, Codex, multi-agent, AI agent orchestration, dual account, local-first, token tracking, token usage analytics, remote worker, Mac worker, developer workbench.

这个仓库是**可公开发布版**：不包含任何作者本机账号、登录态、密钥、Tunnel ID、组织/Workspace ID、日志、任务历史、Memory 数据、机器路径或私人回执。首次运行时，这些内容只会在你的电脑上生成，并被 `.gitignore` 排除。

## 为什么用 Spike Bridge

- **带窗口的可视化工作台**：不是只靠 CLI。Operator 以独立桌面式窗口运行，集中展示任务、审批、Provider、Token、Memory、日志、恢复和系统设置。
- **双 Codex 账户同时接入**：Codex A / Codex B 各自使用独立 `CODEX_HOME` 和登录态，可以在同一个 Bridge 与工作台中并行使用，同时保持账号隔离。
- **连接并控制第二台电脑**：可把第二台 Mac 配置为 Mac Worker，通过局域网配对后接收任务、执行并返回结果；远端 Worker 不暴露通用 Shell。
- **Token 消耗统计**：工作台记录可获得的 Token 回执，展示总 Token、输入、缓存输入、输出、推理输出、每日趋势，并可按执行器、模型和项目筛选/拆分以及导出 JSON。
- **统一多 Agent 控制面**：Codex A、Codex B、ZCode、Mac Worker 都进入统一 Provider/任务视图，而不是各开一套零散工具。
- **本地优先与隐私隔离**：Bridge 默认只监听 loopback；账号、Memory、任务历史、Token 记录和本机配置默认保留在本地。
- **Safe-Boot / LKG**：候选版本先验证再切换，并保留 Last Known Good，用于降低本地自动化系统升级后直接不可用的风险。
- **Experience Memory**：本机 SQLite 经验记忆，让重复出现的运行问题、Provider 特征和恢复经验能够被复用。

## 你会得到什么

- 本机 MCP 服务：默认 `http://127.0.0.1:7690/mcp`
- Safe-Boot：候选冻结、验证、发布、恢复和 LKG
- Codex A：主 Codex 执行器
- Codex B：可选第二 Codex 账号，独立 `CODEX_HOME`
- ZCode / Mac Worker：可选 Provider
- Experience Memory：本机 SQLite 经验记忆
- Operator 工作台：任务、审批、Token、Provider、规则、Memory、日志、恢复与设置
- `model_free_git_commit` 与本地 `spike_context`

## 最快开始（Windows）

前置条件：

1. Windows 10/11
2. Node.js 22+
3. 一个可用的 `codex.exe`（Codex Desktop 或 Codex CLI）
4. Microsoft Edge（工作台独立窗口使用）

克隆仓库后在 PowerShell 运行：

```powershell
npm run setup
```

首次配置会：

1. 检查 Node 和 Codex；如果找不到 `codex.exe`，会让你输入完整路径；
2. 执行 `npm ci`；
3. 在本机生成 `config/local.json`、`config/operator.json`、`config/context.json` 和调用规则；
4. 创建 `accounts/codex-a` 并引导你完成 Codex 登录；
5. 冻结并启动首个 Safe-Boot LKG；
6. 安装工作台快捷方式。

完成后：

```powershell
npm run panel
```

或：

```cmd
START-SPIKE-BRIDGE.cmd panel
```

健康检查：

```powershell
Invoke-RestMethod http://127.0.0.1:7690/healthz
```

## 第二个 Codex 账号

需要 Codex B 时：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\bootstrap\setup.ps1 `
  -ConfigureSecondAccount -SkipDependencies -SkipStart -SkipPanel
```

完成第二次登录后重启 Bridge：

```cmd
START-SPIKE-BRIDGE.cmd restart
```

两个账户的登录态彼此隔离，但会同时出现在同一个 Provider / 任务控制面中，适合把不同任务分配给不同 Codex 账户，而不需要反复退出和重新登录。

## 第二台电脑：Mac Worker

Spike Bridge 可以把局域网内的第二台 Mac 接入为远程 Worker。Windows 主机负责 Bridge 与任务控制，Mac Worker 接收经过配对的任务并返回状态/结果；Worker 只暴露受限的 `/health`、`/task` 和任务状态接口，不提供通用远程 Shell。

首次配对与生命周期命令见 [bootstrap/mac-worker-b/README.md](bootstrap/mac-worker-b/README.md)。

## Token 用量与趋势

Operator 工作台内置 **Token 用量** 页面。对于能够取得原生 usage 回执的任务，会记录并展示：

- 总 Token、输入 Token、缓存输入、输出 Token、推理输出；
- 完成/失败/活动轮次；
- 最近 1 / 7 / 30 / 90 天趋势；
- 按执行器、模型、项目拆分；
- 任务级明细与 JSON 导出。

没有可靠回执的字段保持“未知”，不会把未知值伪装成 0。

## 远程 ChatGPT / Fast Entry

Bridge 本体只监听 `127.0.0.1`。如果你需要让远程 ChatGPT 连接本机 MCP，需要你自己拥有兼容的 Tunnel/Fast Entry 客户端和控制平面权限。这个仓库**不会分发任何 Tunnel 二进制或账号凭据**。

参见 [docs/TUNNEL_SETUP.md](docs/TUNNEL_SETUP.md)。

## 配置文件

详细说明见 [docs/CONFIGURATION.md](docs/CONFIGURATION.md)。关键文件：

- `config/local.json`：本机 `codex.exe` 路径，忽略提交
- `config/operator.json`：工作台设置，忽略提交
- `config/codex-call-profile.md`：Codex 调用规则，忽略提交
- `config/context.json`：可选本地上下文，忽略提交
- `accounts/`：Codex 登录态，忽略提交
- `data/`、`state/`、`logs/`：运行数据，忽略提交

仓库只提供对应的 `*.example.*` 示例。

## 常用命令

```powershell
npm run setup          # 首次配置
npm run panel          # 打开工作台
npm test               # 非模型回归
npm run audit:public   # 开源前隐私/密钥扫描
node scripts/memory.mjs status
node scripts/retention.mjs --dry-run
```

```cmd
START-SPIKE-BRIDGE.cmd          REM 启动/恢复 LKG
START-SPIKE-BRIDGE.cmd status   REM 查看状态
START-SPIKE-BRIDGE.cmd restart  REM 安全重启当前 LKG
START-SPIKE-BRIDGE.cmd cutover  REM verify + promote 当前候选
```

## 本地上下文

公开版不会接入作者的私人数据源。`spike_context` 默认读取本机 `config/context.json`，初始为空：

```json
{
  "schemaVersion": 1,
  "items": []
}
```

你可以在自己的电脑上填入非敏感、希望本机 Agent 读取的结构化内容。该文件默认不会被 Git 提交。

## 开源前检查

提交到 GitHub 前运行：

```powershell
npm run audit:public
```

脚本会检查常见 API Key、Bearer Token、真实 Windows 用户路径、真实 Tunnel/Organization ID、邮箱、登录态文件和不应进入仓库的运行目录。

## 来源与许可证

Spike Bridge 的运行时包含基于 Codexless 的修改部分。Codexless 以 Apache License 2.0 发布；相关来源与第三方声明见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。本仓库使用 Apache License 2.0。

## 安全边界

- MCP 默认只绑定 loopback；
- 工作台默认只绑定 `127.0.0.1:7692`，使用本机随机会话 Token；
- 登录态、Memory、任务历史、Tunnel 配置和密钥均为本地运行数据；
- 不要把生成的 `accounts/`、`secrets/`、`config/local.json`、`config/context.json`、`data/`、`state/` 或日志提交到公开仓库。

更多说明见 [SECURITY.md](SECURITY.md)。