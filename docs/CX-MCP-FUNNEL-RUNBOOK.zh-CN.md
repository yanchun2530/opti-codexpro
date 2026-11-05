# GPT Web CX / Tailscale Funnel 排障手册

供后续搭建或修复 GPT 网页端 CodexPro/CX 到本机 MCP 的连接时复用。只写通用拓扑与检查法；真实主机名、IP、URL、令牌必须留在受保护的配置中。

## 安全边界

- 完整 Server URL 的查询参数含 **codexpro_token**，等同凭据；不要提交到仓库、issue、截图或命令日志。
- MCP 服务只绑定 **127.0.0.1**；由 Tailscale Funnel 发布 HTTPS，不要把 MCP 端口直接暴露到 **0.0.0.0**。
- 公共探测不要带令牌。只有受信任的本机或 GPT/CX 会话才用完整 URL 做认证探测。

## 先画清楚实际链路

常见链路：

~~~text
GPT 网页端 CX
    │ HTTPS :443
Tailscale Funnel / 公网中继
    │ 代理到 loopback
本机 MCP：127.0.0.1:<MCP_PORT>
    │ 可选：SSH 本地转发
远端 MCP：127.0.0.1:<REMOTE_PORT>
~~~

SSH 管理连接是另一条链路。不能用“SSH 通了”证明 CX 通，也不能用“Funnel 显示开启”证明公网或 GPT/CX 可达。若存在多个 Funnel/端口（例如本机 MCP 与另一服务），逐一记录“主机名 → 本地端口 → 上游目标”，不要混测。

## 分层检查顺序

按顺序记录时间、执行位置、命令和结果；每一步都从发生故障的同一条链路验证。

| 层 | 检查 | 通过时说明 |
|---|---|---|
| 1. 服务监听 | 本机确认 MCP 进程在 **127.0.0.1:<MCP_PORT>** 监听 | 本机服务已启动 |
| 2. MCP/auth | 对本机 **/mcp** 做协议初始化；或运行 **opti-codexpro connection-test --root <允许的仓库>** | MCP 路径、配置及本次探测使用的凭据有效 |
| 3. Funnel 配置 | **tailscale status**、**tailscale funnel status** | 节点和转发配置状态；**不代表外部可达** |
| 4. 外部 HTTPS | 从独立网络检查 DNS、TCP 443、TLS，再做无令牌 HTTP 探测 | 测试来源到 Funnel 的公网链路可达 |
| 5. GPT/CX | 在实际 GPT 网页端调用 **server_config** 或 **open_current_workspace** | GPT/CX 这条端到端链路当前可用 |
| 6. SSH 上游（若有） | 在本机 SSH 到远端，并检查远端 loopback 服务 | 只证明 SSH/上游这一段可用 |

### 常用本机检查

Windows PowerShell 示例（按实际端口替换）：

~~~powershell
tailscale status
tailscale funnel status
Get-NetTCPConnection -State Listen | Where-Object LocalPort -eq 8787
Test-NetConnection <FUNNEL_HOST> -Port 443
opti-codexpro connection-test --root <ALLOWED_REPO>
~~~

默认端口可能因配置而异。不要只凭 **tailscale funnel status** 报告恢复；最后必须从实际 GPT/CX 发起工具调用。

## 错误快速定位

| 现象 | 优先怀疑 | 下一步 |
|---|---|---|
| 本机 loopback **connection refused** | MCP 进程未启动、监听地址/端口错误 | 查启动日志、监听端口和 Funnel 的代理目标 |
| 无令牌请求返回 HTTP 401 | 通常是预期认证响应 | 说明该探测来源已到达 HTTP 服务；再分别验证 token 与 GPT/CX |
| 带有效 URL 的协议初始化返回 HTTP 200 / **text/event-stream** | MCP 握手通过 | 只证明当前探测来源可达，不代表 GPT/CX 的网络也可达 |
| TCP 443 超时、TLS 握手失败、**HTTP 000** / **SSL_ERROR_SYSCALL** | 请求未到 HTTP/MCP 认证层 | 对比本机、独立外网、GPT/CX 的 DNS/TCP/TLS；检查 Funnel/中继路径及出口策略 |
| GPT/CX 返回 **UNAVAILABLE**、**mcp_network_error**、连接超时 | GPT/CX 到入口的传输链路或连接器配置 | 同一时刻检查外网 HTTPS，再从实际 GPT/CX 调用；不要据此先改 token |
| 公网探测成功但 GPT/CX 失败 | GPT/CX 的出口、已保存的连接配置或该会话工具状态 | 在目标 GPT 会话复测并核对完整 Server URL；避免把别的客户端成功当作 CX 成功 |
| SSH 到 **10.x** 地址报 **Operation not permitted**、banner timeout | Mihomo/Clash 全局 TUN 或路由/源接口选择 | 检查到目标地址的路由与物理网卡；必要时用 **ssh -b <LAN_IP> <SSH_ALIAS>** 验证。若配置固定 **BindAddress**，先保证 DHCP 地址稳定或改用持久路由规则 |

### 诊断原则

1. **401、超时不是同一类错误。** 401 通常说明请求已到 HTTP 服务但缺少/未通过认证；连接超时通常发生在认证之前。
2. **从同一 vantage point 比较。** 本机成功不能代替 GPT/CX 成功；另一台服务器成功也不能代表 GPT Web 的出口成功。
3. **先定位层，再改配置。** 不要因单次 CX 超时就重启 Tailscale、改 URL/token 或重建 Funnel。先留存 Tailscale 状态、Funnel 映射、服务监听、外部 TLS 与 CX 调用结果。
4. **分别验证不同端口和 hostname。** 本机 MCP 端口、SSH 转发端口和其他 Funnel 入口不可互相代替。
5. **只报告已验证范围。** 一次 **HTTP 200** 或一次 CX 成功表示“此刻通”；稳定恢复要从外部和实际 GPT/CX 重复验证。
6. **重连不是永久修复。** 若要承诺自动恢复，必须部署并测试服务管理器/计划任务、健康检查和重启策略；SSH keepalive 只能发现断线，不能自行重建通道。

## 从零搭建时的最小验收

1. 按仓库主 README 的安装步骤启动 Opti-CodexPro，使用最小允许仓库根目录。
2. 确认 MCP 仅监听 loopback，**tailscale funnel status** 的代理目标与该 MCP 端口一致。
3. 在 GPT 网页端保存程序生成的完整 **/mcp** URL；认证方式按 README 选择。不要把 URL 写进代码仓库。
4. 先跑本机 **connection-test**，再测外部 HTTPS，最后在实际 GPT/CX 会话中调用 **open_current_workspace**。
5. 断网/重启后的自动恢复需单独演练，并记录恢复时间、日志和端到端结果。

## 参考

- [Opti-CodexPro 主 README](../README.md)
- [Tailscale Funnel 官方文档](https://tailscale.com/docs/features/tailscale-funnel)
