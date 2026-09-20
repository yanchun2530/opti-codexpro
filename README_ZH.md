<p align="center">
  <img src="docs/favicon.svg" width="72" height="72" alt="Opti-CodexPro logo">
</p>

<h1 align="center">Opti-CodexPro</h1>

<p align="center">
  让 ChatGPT 在你明确允许的本地仓库上使用编码工具。
</p>

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node.js >=20](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)](https://nodejs.org/)

<p align="center">
  <a href="README.md">English</a>
  ·
  <a href="docs/zh.html">中文网站</a>
  ·
  <a href="FAQ_ZH.md">中文 FAQ</a>
  ·
  <a href="SECURITY.md">安全说明</a>
</p>

## 它是什么

Opti-CodexPro 是本地 MCP server。它连接**你的 ChatGPT 会话**、**你的机器**和**你允许的仓库**。

ChatGPT 可以读取、搜索、编辑、审查、验证、导入附件，并写 handoff 计划。范围始终限制在这些 root 内。

它不是托管 SaaS、模型代理、配额绕过、账号池或远程 shell 服务。

## 安装

需要：

- Node.js 20+
- 能创建自定义 MCP 插件的 ChatGPT 账号
- ChatGPT Web 可用的 HTTPS 地址（tunnel 或 Tailscale Funnel）

```bash
git clone https://github.com/your-org/opti-codexpro.git
cd opti-codexpro
npm install
npm run build
npm link
opti-codexpro setup
```


兼容性：仍保留 `codexpro` CLI 别名，已有脚本和配置无需立即迁移。

## 在 ChatGPT 中连接

1. `Settings -> Security and login` → 打开 **Developer mode**（保持 CSP 开启）。
2. `Settings -> Plugins` → Plugins 标签页 → 搜索框旁的 **+**。
3. 创建名为 `Opti-CodexPro` 的插件。
4. 连接方式：**Server URL** → 粘贴 Opti-CodexPro 复制的 URL。
5. 认证：**No Authentication / None**（表单可能默认 OAuth，创建前改掉）。

Opti-CodexPro 的认证就在这个 URL 里的 token。不要分享该 URL。


同一仓库日常启动：

```bash
opti-codexpro start
```

如果创建插件失败，运行 `opti-codexpro connection-test`，确认 ChatGPT 请求是否到达本地 server。

### 使用 Tailscale Funnel 完整连接

下面是推荐的 ChatGPT Web 配置流程。所有占位符都要在本机替换；不要把真实主机名、token、账号名或用户目录提交到仓库。

1. 安装并登录 [Tailscale](https://tailscale.com/)，确认节点在线：

   ```bash
   tailscale up
   tailscale status
   ```

2. 构建 Opti-CodexPro，并只允许一个明确的工作区，不要暴露整个 home 目录：

   ```bash
   npm install
   npm run build
   npm link
   opti-codexpro setup
   opti-codexpro start \
     --root /absolute/path/to/repo \
     --bash safe \
     --write workspace \
     --tunnel tailscale \
     --hostname <device-funnel-hostname>
   ```

   Windows PowerShell：

   ```powershell
   opti-codexpro start `
     --root C:\path\to\repo `
     --bash safe `
     --write workspace `
     --tunnel tailscale `
     --hostname <device-funnel-hostname>
   ```

   Opti-CodexPro 会把 MCP 服务绑定在本机回环地址，让 Tailscale Funnel 发布 HTTPS，最后打印并复制完整的 ChatGPT Server URL；URL 应以 `/mcp` 结尾。

3. 在 ChatGPT Web 中打开 **Developer mode**。菜单位置可能是
   `Settings -> Security and login -> Developer mode`，也可能是
   `Settings -> Apps -> Advanced settings -> Developer mode`。

4. 打开 **Apps/Plugins** 配置页，点击 **Create** 或自定义应用旁边的 **+**。

5. 按下面填写：

   ```text
   Name:           Opti-CodexPro
   Connection:     Server URL
   Server URL:     粘贴 Opti-CodexPro 复制的完整 URL
   Authentication: No Authentication / None
   ```

   URL 中已经包含私有的 `codexpro_token`，必须保持完整，但不要分享或提交这个 URL。这个配置不要选择 OAuth。

6. 点击 **Scan Tools**，等待工具发现完成，然后点击 **Create/Save**。在新的 ChatGPT Web 对话中启用 Opti-CodexPro，先运行只读检查，例如
   `server_config`、`open_current_workspace` 和 `codexpro_self_test`，确认正常后再编辑文件或运行 bash。

7. 连接器创建后检查传输链路：

   ```bash
   tailscale status
   tailscale funnel status
   opti-codexpro connection-test --root /absolute/path/to/repo
   ```

   `tailscale funnel status` 必须显示 Funnel 到本地 MCP 端口的映射。公网无 token 请求返回 `401 Unauthorized` 是正常的；超时或连接关闭才表示 HTTPS/Funnel 链路仍未打通。

### 显示可见的命令执行过程

完整 bash transcript 会显示命令、工作目录、退出状态、耗时和 stdout/stderr。这是执行记录，不是模型的私有隐藏思维链：

```bash
opti-codexpro start \
  --root /absolute/path/to/repo \
  --bash full \
  --bash-transcript full \
  --tunnel tailscale \
  --hostname <device-funnel-hostname>
```

如果命令输出可能包含敏感值，使用 `--bash-transcript compact`。显式传入的 `--bash-transcript` 会覆盖默认的 compact 模式。

## 调用 OptiLLM 思考运行时

Opti-CodexPro 通过 MCP 工具 `optillm_runtime` 提供 Web-Native 的测试时推理控制器。它不会调用
Codex CLI，也不会偷偷调用其他后端模型；当前网页模型负责每个模型步骤，Opti-CodexPro 负责保存
运行时状态、选择策略并返回下一步指令。

支持的 action：

| action | 作用 |
|---|---|
| `list` | 列出可用和计划中的推理方法。 |
| `health` | 检查运行时是否为 Web-Native，以及后端模型调用数。 |
| `start` | 开始一次运行，返回 `runtime_id` 和第一步模型指令。 |
| `submit` | 提交当前网页模型的答案，或提交当前阶段要求的评审字段。 |
| `state` | 查看运行状态，不推进阶段。 |
| `cancel` | 取消未完成的运行。 |

### 最小调用流程

先检查运行时：

```json
{
  "name": "optillm_runtime",
  "arguments": { "action": "health" }
}
```

开始一次自适应运行：

```json
{
  "name": "optillm_runtime",
  "arguments": {
    "action": "start",
    "approach": "auto",
    "difficulty": "hard",
    "budget": "adaptive",
    "task": "比较两个硬件架构，分析失效模式，并给出带理由的推荐。"
  }
}
```

响应会包含 `status: "needs_model"`、`runtime_id`、`stage`、`directive` 和结构化的 `prompt`。
网页模型完成当前步骤后，必须使用同一个 `runtime_id` 提交：

```json
{
  "name": "optillm_runtime",
  "arguments": {
    "action": "submit",
    "runtime_id": "<start 返回的 runtime_id>",
    "answer": "<当前阶段的完整答案>"
  }
}
```

只要状态仍然是 `needs_model`，就继续按照返回的 `stage` 和 `directive` 调用 `submit`；返回
`status: "complete"` 后，使用 `result` 作为最终答案。不要每个阶段创建新的运行，否则会丢失状态。

阶段字段规则：

- `generate`、`explore`、`improve`、`synthesize`：提交 `answer`。
- `judge`：提交 `selected_index`、`ratings`、`confidence` 和 `need_more`。
- `joint_verify`：提交修正后的 `answer`、`assessment`、`confidence`、`selected_index`、`report`、`issues` 和 `need_more`。
- `rate`：提交 0 到 10 的 `rating`。
- `verify`：提交 `assessment`、`confidence`、`report` 和 `issues`。

查看或取消运行：

```json
{ "name": "optillm_runtime", "arguments": { "action": "state", "runtime_id": "<runtime_id>" } }
{ "name": "optillm_runtime", "arguments": { "action": "cancel", "runtime_id": "<runtime_id>" } }
```

可用方法包括 `auto`、`re2`、`bon`、`cot_reflection`、`self_consistency`、`moa`、`plansearch`、
`rto`、`z3`、`leap`、`cepo` 和 `mars`。旧的 `think` 与 `reasoning_runtime` 仍保留为兼容别名，
最终会路由到同一个 OptiLLM 运行时。

该运行时展示阶段、指令、候选答案、验证结果和最终结果，但不会导出模型的私有隐藏思维链；
需要展示过程时，应使用这些结构化阶段数据。

## ChatGPT 能做什么

在 workspace write 模式（常规 agent 设置）下：

- 读取、搜索、检查仓库
- 用 `write`、`edit` 或受保护的 `apply_patch` 编辑
- 用 `import_file` 导入 ChatGPT 附件
- 用 `bash` 运行白名单检查
- 用 `show_changes` 审查 diff
- 在 `.ai-bridge` 下写计划
- 为不能调工具的会话导出 context bundle

## 多项目

一个 Opti-CodexPro 进程可以允许多个仓库：

```bash
opti-codexpro settings set --project ~/code/web --project ~/code/api
opti-codexpro settings show
opti-codexpro start
```

让 ChatGPT 对已允许项目执行 `open_workspace`。`open_current_workspace` 切回启动仓库。

两个 ChatGPT 账号或需要硬隔离时，用不同端口和 Server URL 跑两个 Opti-CodexPro 进程。

## 命令

```bash
opti-codexpro setup
opti-codexpro start
opti-codexpro start --root /path/to/repo
opti-codexpro doctor
opti-codexpro connection-test
opti-codexpro settings
opti-codexpro inspect
opti-codexpro review
```

常用模式：

```bash
opti-codexpro start --no-bash
opti-codexpro start --tool-mode minimal
opti-codexpro start --tool-mode full
opti-codexpro start --mode handoff
opti-codexpro start --mode pro
opti-codexpro start --headless
```

可选工具卡片：

```bash
CODEXPRO_TOOL_CARDS=1 opti-codexpro start
```

## 公网 HTTPS

ChatGPT Web 需要 HTTPS：

```bash
opti-codexpro start --tunnel cloudflare
opti-codexpro ngrok --hostname your.ngrok-free.dev
opti-codexpro stable --hostname codexpro.example.com --tunnel-name codexpro
opti-codexpro tailscale --hostname your-device.your-tailnet.ts.net
opti-codexpro start --tunnel none
```

稳定主机名请固定 token：

```bash
mkdir -p ~/.codexpro
openssl rand -hex 32 > ~/.codexpro/http-token
chmod 600 ~/.codexpro/http-token
```

客户端支持 header 时优先用 `Authorization: Bearer <token>`。`?codexpro_token=` 只是个人兼容回退。

## 安全默认

- 公网 tunnel 需要 Opti-CodexPro HTTP token（至少 24 bytes）
- 非 workspace write 模式不暴露写入工具
- 默认 safe bash
- 拦截 `.env`、密钥、`.git`、构建缓存等路径
- 附件导入只接受已批准 HTTPS 主机上的 ChatGPT Apps SDK 文件对象

公网暴露前先读 [SECURITY.md](SECURITY.md)。

## 更新

```bash
npm install -g opti-codexpro@latest
opti-codexpro --version
```

更新后重启 `opti-codexpro start`。`~/.codexpro` 下的配置会保留。

## 文档

- [中文网站](docs/zh.html)
- [中文 FAQ](FAQ_ZH.md)
- [Security](SECURITY.md)
- [稳定 URL 指南](DOMAIN_SETUP.md)
- [Changelog](CHANGELOG.md)
- [Contributors](CONTRIBUTORS.md)
