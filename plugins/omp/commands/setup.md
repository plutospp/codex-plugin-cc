---
description: Check whether the local omp CLI is ready and optionally toggle the stop-time review gate
argument-hint: '[--enable-review-gate|--disable-review-gate]'
allowed-tools: Bash(node:*), Bash(npm:*), AskUserQuestion
---

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/omp-companion.mjs" setup --json $ARGUMENTS
```

If the result says omp is unavailable and npm is available:
- Use `AskUserQuestion` exactly once to ask whether Claude should install omp now.
- Put the install option first and suffix it with `(Recommended)`.
- Use these two options:
  - `Install omp (Recommended)`
  - `Skip for now`
- If the user chooses install, run:

```bash
npm install -g @oh-my-pi/pi-coding-agent
```

- Then rerun:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/omp-companion.mjs" setup --json $ARGUMENTS
```

If omp is already installed or npm is unavailable:
- Do not ask about installation.

Output rules:
- Present the final setup output to the user.
- If installation was skipped, present the original setup output.
- If omp is installed but not authenticated, tell the user to run `omp` interactively once and sign in to a model provider (omp supports many providers — Anthropic, OpenAI, Google, and others — not a single fixed login flow), then rerun `/omp:setup`.
