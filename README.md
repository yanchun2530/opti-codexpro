<p align="center">
  <img src="docs/favicon.svg" width="72" height="72" alt="Opti-CodexPro logo">
</p>

<h1 align="center">Opti-CodexPro</h1>

<p align="center">
  Give ChatGPT local coding tools for repos you explicitly allow.
</p>

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node.js >=20](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)](https://nodejs.org/)

## What it is

Opti-CodexPro is a local MCP server. It connects **your ChatGPT session** to **your machine** and **repos you allow**.

ChatGPT can read, search, edit, review, verify, import attachments, and write handoff plans. It stays inside those roots.

It is not a hosted SaaS product, model proxy, quota bypass, account pool, or remote shell service.

## Install

Needs:

- Node.js 20+
- A ChatGPT account that can create custom MCP plugins
- An HTTPS URL to your machine for ChatGPT web (tunnel or Tailscale Funnel)

```bash
git clone https://github.com/your-org/opti-codexpro.git
cd opti-codexpro
npm install
npm run build
npm link
opti-codexpro setup
```


Legacy compatibility: the `codexpro` CLI alias is still provided for existing scripts and profiles.

## Connect in ChatGPT

1. `Settings -> Security and login` → turn **Developer mode** on (keep CSP enforcement on).
2. `Settings -> Plugins` → Plugins tab → **+** beside Search plugins.
3. Create a plugin named `Opti-CodexPro`.
4. Connection: **Server URL** → paste the URL Opti-CodexPro copied.
5. Authentication: **No Authentication / None** (change this if the form defaults to OAuth).

Opti-CodexPro auth is the token already in that URL. Do not share the URL.


Daily use from the same repo:

```bash
opti-codexpro start
```

If plugin creation fails, run `opti-codexpro connection-test` and check whether ChatGPT requests reach the local server.

### Complete setup with Tailscale Funnel

The following is the recommended ChatGPT Web setup. Replace every placeholder locally;
never commit a real hostname, token, account name, or home-directory path.

1. Install and sign in to [Tailscale](https://tailscale.com/), then verify the node:

   ```bash
   tailscale up
   tailscale status
   ```

2. Build Opti-CodexPro and choose a narrow workspace root. Do not expose your whole home directory:

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

   On Windows PowerShell, the same launch is:

   ```powershell
   opti-codexpro start `
     --root C:\path\to\repo `
     --bash safe `
     --write workspace `
     --tunnel tailscale `
     --hostname <device-funnel-hostname>
   ```

   Opti-CodexPro keeps the MCP server on loopback, asks Tailscale Funnel to publish it as HTTPS,
   and prints/copies the complete ChatGPT Server URL ending in `/mcp`.

3. In ChatGPT Web, enable **Developer mode**. Depending on the rollout, it may be under
   `Settings -> Security and login -> Developer mode` or `Settings -> Apps -> Advanced settings -> Developer mode`.

4. Open the **Apps/Plugins** configuration page and click **Create** or the **+** button for a custom app.

5. Fill the connector form as follows:

   ```text
   Name:           Opti-CodexPro
   Connection:     Server URL
   Server URL:     paste the complete URL copied by Opti-CodexPro
   Authentication: No Authentication / None
   ```

   The URL already contains the private `codexpro_token` query value. Keep it intact, but never share
   or commit the URL. Do not choose OAuth for this setup.

6. Click **Scan Tools**, wait for discovery to finish, then click **Create/Save**. In a new ChatGPT
   Web conversation, enable/select the Opti-CodexPro app and begin with read-only checks such as
   `server_config`, `open_current_workspace`, and `codexpro_self_test` before edits or bash commands.

7. Confirm the transport before debugging the workspace:

   ```bash
   tailscale status
   tailscale funnel status
   opti-codexpro connection-test --root /absolute/path/to/repo
   ```

   `tailscale funnel status` must show the Funnel mapping to the local MCP port. A public request
   without a token returning `401 Unauthorized` is expected; a timeout or connection close means the
   HTTPS/Funnel path is not reachable yet.

### Show visible command execution progress

The full bash transcript shows the command, working directory, exit status, duration, and stdout/stderr.
It is an execution transcript, not the model's private hidden chain-of-thought:

```bash
opti-codexpro start \
  --root /absolute/path/to/repo \
  --bash full \
  --bash-transcript full \
  --tunnel tailscale \
  --hostname <device-funnel-hostname>
```

Use `--bash-transcript compact` when command output may contain sensitive values. Explicit
`--bash-transcript` takes precedence over the compact default.

## Use the OptiLLM reasoning runtime

Opti-CodexPro exposes a web-native test-time reasoning controller through the MCP tool `optillm_runtime`.
It does not call Codex CLI, proxy another backend model, or silently spend provider API credits. The current
webpage model performs the requested model steps, while Opti-CodexPro keeps the runtime state, routes the
strategy, and returns the next directive.

The runtime exposes these actions:

| Action | Purpose |
|---|---|
| `list` | List available reasoning approaches and planned approaches. |
| `health` | Confirm that the runtime is web-native and has made zero backend model calls. |
| `start` | Start a reasoning run and receive a `runtime_id` plus the first model directive. |
| `submit` | Submit the current webpage-model answer or stage-specific judge/verifier fields. |
| `state` | Inspect a run without advancing it. |
| `cancel` | Cancel an unfinished run. |

### Minimal MCP call sequence

Call `list` or `health` first when discovering the capability:

```json
{
  "name": "optillm_runtime",
  "arguments": { "action": "health" }
}
```

Start an adaptive run. `auto` selects a strategy from the task; `adaptive` expands compute only when
the candidates disagree or confidence is low:

```json
{
  "name": "optillm_runtime",
  "arguments": {
    "action": "start",
    "approach": "auto",
    "difficulty": "hard",
    "budget": "adaptive",
    "task": "Compare these two hardware architectures, identify failure modes, and recommend one with justification."
  }
}
```

The response contains `status: "needs_model"`, a `runtime_id`, a `stage`, a `directive`, and a structured
`prompt`. The webpage model follows that prompt and submits the complete output back with the same runtime id:

```json
{
  "name": "optillm_runtime",
  "arguments": {
    "action": "submit",
    "runtime_id": "<runtime_id-from-start>",
    "answer": "<complete answer for the current stage>"
  }
}
```

Continue the `submit` loop while the status is `needs_model`. When the runtime returns `status: "complete"`,
use its `result` as the final answer. Do not create a new run for every stage; preserve the same `runtime_id`.

Stage-specific submissions use these fields:

- `generate`, `explore`, `improve`, or `synthesize`: submit `answer`.
- `judge`: submit `selected_index`, `ratings`, `confidence`, and `need_more`; submit `need_more: true` only when another independent candidate is materially useful.
- `joint_verify`: submit the corrected `answer`, `assessment` (`CORRECT`, `INCORRECT`, or `INCOMPLETE`), `confidence`, `selected_index`, `report`, `issues`, and `need_more`.
- `rate`: submit the numeric `rating` from 0 to 10.
- `verify`: submit `assessment`, `confidence`, `report`, and `issues`.

Inspect or cancel a run with:

```json
{ "name": "optillm_runtime", "arguments": { "action": "state", "runtime_id": "<runtime_id>" } }
{ "name": "optillm_runtime", "arguments": { "action": "cancel", "runtime_id": "<runtime_id>" } }
```

Available approaches are `auto`, `re2`, `bon`, `cot_reflection`, `self_consistency`, `moa`, `plansearch`,
`rto`, `z3`, `leap`, `cepo`, and `mars`. The legacy tools `think` and `reasoning_runtime` remain available
as compatibility aliases and are routed to the same OptiLLM runtime.

This runtime reports stage progress, prompts, candidates, verifier results, and the final result. It does not
expose a model's private hidden chain-of-thought; use the structured stage data when a visible progress trail is needed.

## What ChatGPT can do

With workspace write mode (the normal agent setup):

- read, search, and inspect the repo
- edit with `write`, `edit`, or guarded `apply_patch`
- import ChatGPT attachments with `import_file`
- run allowlisted checks with `bash`
- review diffs with `show_changes`
- write plans under `.ai-bridge`
- export a context bundle for chats that cannot call tools

## Multiple projects

One Opti-CodexPro process can allow more than one repo:

```bash
opti-codexpro settings set --project ~/code/web --project ~/code/api
opti-codexpro settings show
opti-codexpro start
```

Ask ChatGPT to `open_workspace` on an allowed project. `open_current_workspace` returns to the launch repo.

For two ChatGPT accounts or hard isolation, run two Opti-CodexPro processes on different ports and Server URLs.

## Commands

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

Useful modes:

```bash
opti-codexpro start --no-bash
opti-codexpro start --tool-mode minimal
opti-codexpro start --tool-mode full
opti-codexpro start --mode handoff
opti-codexpro start --mode pro
opti-codexpro start --headless
```

Opt-in tool cards:

```bash
CODEXPRO_TOOL_CARDS=1 opti-codexpro start
```

## Public HTTPS options

ChatGPT web needs HTTPS:

```bash
opti-codexpro start --tunnel cloudflare          # quick demo URL (changes)
opti-codexpro ngrok --hostname your.ngrok-free.dev
opti-codexpro stable --hostname codexpro.example.com --tunnel-name codexpro
opti-codexpro tailscale --hostname your-device.your-tailnet.ts.net
opti-codexpro start --tunnel none                # local only
```

Keep a stable token for stable hostnames:

```bash
mkdir -p ~/.codexpro
openssl rand -hex 32 > ~/.codexpro/http-token
chmod 600 ~/.codexpro/http-token
```

Prefer `Authorization: Bearer <token>` when the client supports headers. The `?codexpro_token=` query form is a personal compatibility fallback.

## Safety defaults

- Public tunnels require a Opti-CodexPro HTTP token (min 24 bytes)
- Writes stay hidden unless write mode is `workspace`
- Safe bash is the default
- Blocked paths cover `.env`, keys, `.git`, build caches, and similar
- Attachment import only accepts ChatGPT Apps SDK file objects from approved HTTPS hosts

Read [SECURITY.md](SECURITY.md) before exposing a tunnel.

## Update

```bash
npm install -g opti-codexpro@latest
opti-codexpro --version
```

Restart `opti-codexpro start` after updating. Saved profiles under `~/.codexpro` stay in place.

## Development

```bash
npm install
npm run build
npm run smoke
npm run stress
npm run release:check
```

Publish only from the Opti-CodexPro root:

```bash
cd /path/to/opti-codexpro
npm run release:publish
```

## Docs

- [Website](docs/index.html)
- [FAQ](FAQ.md)
- [Security](SECURITY.md)
- [Stable URL guide](DOMAIN_SETUP.md)
- [Changelog](CHANGELOG.md)
- [Contributors](CONTRIBUTORS.md)
