---
description: Write a handoff file from the current Claude Code session for continuing the work in omp
argument-hint: "[--source <claude-jsonl>]"
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/omp-companion.mjs" transfer "$ARGUMENTS"`

Present the command output to the user exactly as returned. Preserve the handoff file path and the `omp "@<path>"` continuation command.
