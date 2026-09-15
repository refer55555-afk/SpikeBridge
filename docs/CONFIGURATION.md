# 配置与使用说明

这份说明面向从 GitHub 刚 clone 下来的新用户。默认目标是：完成一次配置后，可以直接启动 Bridge 和 Operator 工作台；第二账号、Tunnel、ZCode、Mac Worker 都是可选能力。

## 1. 前置环境

### 必需

- Windows 10/11
- Node.js 22 或更高版本
- npm
- `codex.exe`
- 可完成 ChatGPT/Codex 登录的账号

### 可选

- Microsoft Edge：用于工作台独立窗口
- 第二个 Codex 账号：用于 `codex-b`
- Tunnel/Fast Entry 客户端：远程 ChatGPT 连接本机 MCP
- ZCode CLI
- 第二台 Mac：用于 Mac Worker Provider

## 2. 首次配置

在仓库根目录执行：

```powershell
npm run setup
```

如果 Codex 不在 PATH，可直接指定：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\bootstrap\setup.ps1 `
  -CodexBin "C:\Path\To\codex.exe"
```

脚本不会把密码或 Token 写入公开配置。Codex 登录态会落在：

```text
accounts/codex-a/
```

该目录已在 `.gitignore` 中。

## 3. setup 生成的文件

### `config/local.json`

示例：

```json
{
  "schemaVersion": 1,
  "codexBin": "C:\\Path\\To\\codex.exe"
}
```

只记录本机路径，不包含密钥，但仍默认不提交。

### `config/operator.json`

工作台的并发、Provider、Memory、恢复、刷新频率和 Tunnel Proxy 设置。首次配置从 `config/operator.example.json` 复制。

推荐第一次不要改并发；先确认 Bridge 能启动，再从工作台修改。

### `config/codex-call-profile.md`

长期 Codex 调用规则。公开版默认 `requireCallApproval: true`。可以在工作台“自动化规则/调用规则”里修改。

### `config/context.json`

公开版的 `spike_context` 本地数据源。默认没有任何个人数据：

```json
{
  "schemaVersion": 1,
  "items": []
}
```

### `accounts/codex-a/`

主 Codex 的独立 `CODEX_HOME`。包含 `auth.json` 等登录态，绝不能提交。

### `accounts/codex-b/`

可选第二 Codex 账号的独立 `CODEX_HOME`。

## 4. 启动与停止

启动/恢复：

```cmd
START-SPIKE-BRIDGE.cmd
```

查看状态：

```cmd
START-SPIKE-BRIDGE.cmd status
```

安全重启：

```cmd
START-SPIKE-BRIDGE.cmd restart
```

健康检查：

```powershell
Invoke-RestMethod http://127.0.0.1:7690/healthz
Invoke-RestMethod http://127.0.0.1:7690/readyz
```

## 5. 工作台

打开：

```powershell
npm run panel
```

工作台后端监听：

```text
http://127.0.0.1:7692
```

主要页面包含：

- 工作总览
- 任务与进度
- 待处理请求/审批
- 连接通道
- Token/用量统计
- 并发与调度
- 执行器设置
- 自动化规则
- Memory
- 启动恢复
- 日志诊断
- 高级信息

工作台生成的访问 Token、SQLite、任务历史与日志都在本机状态目录中，不会进入 Git。

## 6. Codex B

第二账号是可选的。配置命令：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\bootstrap\setup.ps1 `
  -ConfigureSecondAccount -SkipDependencies -SkipStart -SkipPanel
```

登录完成后：

```cmd
START-SPIKE-BRIDGE.cmd restart
```

如果不配置 B，Bridge 仍可以使用 Codex A；工作台会如实显示 B 不可用。

## 7. Memory

默认数据库：

```text
data/memory/experience.db
```

CLI：

```powershell
node scripts/memory.mjs status
node scripts/memory.mjs search "query"
node scripts/memory.mjs export
```

`data/` 默认不提交。

## 8. Safe-Boot

首次 setup 会执行 `init-seed`：

1. 从公开源码冻结一个内容寻址 Release；
2. 在 `7690` 启动；
3. 验证 MCP Surface、Codex A 与 Provider 基本契约；
4. 记录为 Last Known Good。

后续普通启动只恢复已验证 LKG，不会直接把脏工作树当生产。

要发布当前改动：

```cmd
START-SPIKE-BRIDGE.cmd cutover
```

它执行 `verify` 后再 `promote`。

## 9. Tunnel / Fast Entry

Bridge 默认只在本机 loopback 提供 MCP。远程 ChatGPT 访问需要单独的 Tunnel/Fast Entry 能力。参见 `docs/TUNNEL_SETUP.md`。

## 10. 发布自己的 Fork 前

运行：

```powershell
npm run audit:public
```

然后确认：

```powershell
git status --short
git ls-files
```

尤其不要提交：

```text
accounts/
secrets/
config/local.json
config/operator.json
config/codex-call-profile.md
config/context.json
data/
logs/
state/（seed-lkg 源码除外）
runtime/state/
```