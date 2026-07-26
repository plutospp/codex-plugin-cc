# Changelog

## 1.0.0

- Initial release of the omp plugin for Claude Code, replacing Codex as the delegate runtime.
- Delegates to the `omp` CLI (`@oh-my-pi/pi-coding-agent`) over its `--mode rpc` newline-delimited JSON protocol instead of the Codex app-server's JSON-RPC 2.0 protocol.
- `/omp:review` now runs through the same prompt-driven review pipeline as `/omp:adversarial-review` (there is no native structured-output review command in omp) and accepts trailing focus text.
- `/omp:transfer` now writes a markdown handoff file and prints an `omp "@<path>"` continuation command, instead of importing the session into a native thread (omp has no external-agent session import).
- Dropped the shared app-server broker: omp is one process per job, so there is no multi-thread server to keep warm or reattach to.
- Read-only reviews are now enforced by restricting the active tool set (no `bash`, `edit`, or `write`), since omp has no OS-level sandbox.
- Reasoning-effort control is renamed `--effort` -> `--thinking` (values: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`), matching omp's own CLI flag directly.
- Dropped the `spark` model alias; `--model` now passes the raw value straight through to omp's fuzzy model matching.
