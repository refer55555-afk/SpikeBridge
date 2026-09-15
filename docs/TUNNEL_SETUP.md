# Tunnel / Fast Entry 配置

Spike Bridge 的 MCP 默认只监听：

```text
http://127.0.0.1:7690/mcp
```

这对本机客户端是安全且足够的。如果远程 ChatGPT 需要访问这台电脑，你需要额外的兼容 Tunnel/Fast Entry 客户端和相应账号权限。

## 为什么仓库不带 Tunnel 二进制

公开仓库不会重新分发作者本机使用的 `tunnel-client.exe`，也不会包含：

- API Key
- Tunnel ID
- Organization ID
- Workspace ID
- 代理账号
- DPAPI 密文
- 控制平面回执

请从你有权使用的官方/组织渠道获取兼容客户端。

## 配置原则

你的 Tunnel 最终只需要把远端 MCP 通道转发到：

```text
http://127.0.0.1:7690/mcp
```

仓库提供：

```text
tunnel/profile.example.yaml
```

复制为你自己的本地 profile 后填入真实参数。真实 profile 默认被 `.gitignore` 排除。

## 工作台里的 Bridge A / Bridge B

Operator 可以显示 A/B 两条通道，但自动启动/停止功能依赖你的本机已经存在对应 Scheduled Task 和 owner receipt。公开版不会预置作者的任务、Tunnel ID 或组织信息。

如果你只需要一条远程连接，可以只配置一条；另一条保持未连接即可。

## 代理

`config/operator.json` 中：

```json
{
  "tunnels": {
    "a": { "proxyUrl": "" },
    "b": { "proxyUrl": "" }
  }
}
```

空字符串表示直连。代理地址只能是无用户名、无密码、无 path/query 的 `http://` 或 `https://` 地址。