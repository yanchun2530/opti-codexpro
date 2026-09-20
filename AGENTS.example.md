# AGENTS.md example

This repo is connected through CodexPro.

Rules for ChatGPT or another planning model:

- Prefer planning and review over direct implementation.
- Use handoff_to_codex to write .ai-bridge/current-plan.md.
- Do not edit source files unless the user explicitly asks.
- Always inspect git_status and git_diff before reviewing.
- Respect .ai-bridge/decisions.md.

Rules for Codex:

- Read .ai-bridge/current-plan.md before changing code.
- Execute in small steps.
- Update .ai-bridge/codex-status.md after meaningful changes.
- Include tests run and results.
