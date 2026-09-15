# Security

## 默认网络边界

- Bridge MCP：`127.0.0.1:7690`
- Operator：`127.0.0.1:7692`
- 不建议直接将这两个端口暴露到公网。

远程访问应使用你有权使用的受控 Tunnel/Fast Entry，并保持本机 MCP 目标为 loopback。

## 不要提交的内容

参见 `docs/PRIVACY.md` 和 `.gitignore`。尤其不要提交 `accounts/`、`secrets/`、`auth.json`、本机 profile、Memory、运行 state 与日志。

## 报告问题

公开报告漏洞时不要附上真实凭据、登录态、私人日志或包含个人信息的完整状态文件。请先做最小化复现和脱敏。