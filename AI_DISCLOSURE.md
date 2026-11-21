---
disclosure-default: ai-generated
models-used:
  - deepseek-flash
providers:
  - DeepSeek
scope: |
  Application code, tests and documentation were written by the DeepSeek
  Harness agent running DeepSeek Flash, with the developer prompting, directing,
  reviewing and approving every change. Nothing enters the repository without
  human inspection.
last-updated: 2026-11-21
---

# AI Disclosure

This repository follows the [ai-disclosure convention](https://github.com/ggfevans/ai-disclosure).
The default level for all files is `ai-generated`: AI-generated with human prompting and review.
Per-file overrides would use `SPDX-AI-Disclosure:` headers.

No files are `autonomous` — every change was inspected and accepted by the
developer before it was committed.

## How AI was used

- **Agent:** [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness), running **DeepSeek
  Flash**.
- **What it wrote:** the application (`src/`, `index.html`), the tests, and the docs,
  including runtime audio loading, the setup JSON export/import, and the repo scaffolding.
- **What the human did:** chose the design and scope, directed each change, reviewed the diffs,
  verified the UI and the loop envelopes by ear, and approved the commits.

The repository contains no audio. The track loaded at runtime is supplied by the
user and is not part of this project or covered by its MIT license.
