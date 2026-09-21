# Privacy and public-repository hygiene

This repository must not contain personal access tokens, API keys, private URLs, account-specific paths, local usernames, or machine-specific credentials.

- Keep secrets in environment variables or local configuration files excluded by `.gitignore`.
- Use `config.example.env` only for placeholders.
- Replace example deployment domains with your own public values when publishing.
- Do not commit `.env`, `.ai-bridge`, logs, local profiles, `node_modules`, or generated build artifacts.
- Before publishing, run a secret scanner such as `gitleaks` or GitHub secret scanning.
