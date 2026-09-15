# Public release privacy model

公开仓库只包含源码、测试、示例配置与文档，不包含真实运行数据。

以下内容必须保持本地：

- Codex/ChatGPT 登录态与 `auth.json`
- API Key、Bearer Token、Tunnel 密钥、DPAPI 文件
- Tunnel/Organization/Workspace 实例 ID
- 个人 Windows 用户路径
- 任务卡、审批、Token 用量与历史回执
- Memory SQLite
- Operator 访问 Token
- 日志、诊断、截图和崩溃材料
- `config/local.json`、`config/context.json` 和用户自己的调用规则

发布前运行 `npm run audit:public`。该脚本不是密码管理器，也不能证明绝对无泄漏，但会对本项目最常见的泄漏形态做 fail-closed 扫描。