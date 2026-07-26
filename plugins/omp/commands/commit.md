---
description: Commit current changes using omp with the commit model role
argument-hint: '[--background] [--model <model>] [extra commit instructions]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/omp-companion.mjs" commit "$ARGUMENTS"`

Return the command output verbatim to the user.
Do not paraphrase, summarize, or add commentary before or after it.
