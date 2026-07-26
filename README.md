# omp plugin for Claude Code

Use [omp](https://github.com/oh-my-pi/pi-coding-agent) (the Oh My Pi coding agent CLI) from inside Claude Code for code reviews or to delegate tasks to omp.

This plugin is for Claude Code users who want an easy way to start using omp from the workflow they already have.

## What You Get

- `/omp:review` for a normal read-only omp review
- `/omp:adversarial-review` for a steerable challenge review
- `/omp:rescue`, `/omp:transfer`, `/omp:status`, `/omp:result`, and `/omp:cancel` to delegate work, hand off sessions, and manage background jobs

## Requirements

- **omp installed and at least one model provider authenticated.** omp supports many providers — Anthropic, OpenAI, Google, Groq, OpenRouter, Mistral, xAI, local engines like Ollama, and custom gateways — not a single fixed login flow. Usage contributes to whichever provider's usage limits you authenticate against.
- **Node.js 18.18 or later**

## Install

Add the marketplace in Claude Code:

```bash
/plugin marketplace add omp
```

Install the plugin:

```bash
/plugin install omp@omp
```

Reload plugins:

```bash
/reload-plugins
```

Then run:

```bash
/omp:setup
```

`/omp:setup` will tell you whether omp is ready. If omp is missing and npm is available, it can offer to install omp for you.

If you prefer to install omp yourself, use:

```bash
npm install -g @oh-my-pi/pi-coding-agent
```

(or `bun install -g @oh-my-pi/pi-coding-agent` if you use Bun.)

If omp is installed but no model provider is authenticated yet, run `omp` interactively once and sign in through `/login`.

After install, you should see:

- the slash commands listed below
- the `omp:omp-rescue` subagent in `/agents`

One simple first run is:

```bash
/omp:review --background
/omp:status
/omp:result
```

## Usage

### `/omp:review`

Runs an omp code review on your current work.

> [!NOTE]
> Code review especially for multi-file changes might take a while. It's generally recommended to run it in the background.

Use it when you want:

- a review of your current uncommitted changes
- a review of your branch compared to a base branch like `main`

Use `--base <ref>` for branch review. It also supports `--wait`, `--background`, and trailing focus text to steer what the reviewer looks for. Use [`/omp:adversarial-review`](#ompadversarial-review) when you want a more skeptical, design-challenging pass instead.

Examples:

```bash
/omp:review
/omp:review --base main
/omp:review --background
/omp:review focus on the retry and rollback logic
```

This command is read-only and will not perform any changes. When run in the background you can use [`/omp:status`](#ompstatus) to check on the progress and [`/omp:cancel`](#ompcancel) to cancel the ongoing task.

### `/omp:adversarial-review`

Runs a **steerable** review that questions the chosen implementation and design.

It can be used to pressure-test assumptions, tradeoffs, failure modes, and whether a different approach would have been safer or simpler.

It uses the same review target selection as `/omp:review`, including `--base <ref>` for branch review.
It also supports `--wait` and `--background`, plus extra focus text after the flags.

Use it when you want:

- a review before shipping that challenges the direction, not just the code details
- review focused on design choices, tradeoffs, hidden assumptions, and alternative approaches
- pressure-testing around specific risk areas like auth, data loss, rollback, race conditions, or reliability

Examples:

```bash
/omp:adversarial-review
/omp:adversarial-review --base main challenge whether this was the right caching and retry design
/omp:adversarial-review --background look for race conditions and question the chosen approach
```

This command is read-only. It does not fix code.

### `/omp:rescue`

Hands a task to omp through the `omp:omp-rescue` subagent.

Use it when you want omp to:

- investigate a bug
- try a fix
- continue a previous omp task
- take a faster or cheaper pass with a smaller model

> [!NOTE]
> Depending on the task and the model you choose these tasks might take a long time and it's generally recommended to force the task to be in the background or move the agent to the background.

It supports `--background`, `--wait`, `--resume`, and `--fresh`. If you omit `--resume` and `--fresh`, the plugin can offer to continue the latest rescue session for this repo.

Examples:

```bash
/omp:rescue investigate why the tests started failing
/omp:rescue fix the failing test with the smallest safe patch
/omp:rescue --resume apply the top fix from the last run
/omp:rescue --model gpt-5.4-mini --thinking medium investigate the flaky integration test
/omp:rescue --background investigate the regression
```

You can also just ask for a task to be delegated to omp:

```text
Ask omp to redesign the database connection to be more resilient.
```

**Notes:**

- if you do not pass `--model` or `--thinking`, omp chooses its own defaults.
- follow-up rescue requests can continue the latest omp task in the repo

### `/omp:transfer`

Writes a condensed markdown handoff file from the current Claude Code session and prints an `omp "@<path>"` command to continue the conversation in omp.

Use it when you started a debugging or implementation conversation in Claude Code and want to continue that same context directly in omp.

Examples:

```bash
/omp:transfer
/omp:transfer --source ~/.claude/projects/-Users-me-repo/<session-id>.jsonl
```

The plugin's existing `SessionStart` hook supplies the current transcript path automatically; `--source` is available as a manual override. The source must be under `~/.claude/projects`. omp has no native external-agent session import, so this produces a plain markdown file rather than a resumable native session — omp loads it directly via its `@file` message-argument convention.

### `/omp:status`

Shows running and recent omp jobs for the current repository.

Examples:

```bash
/omp:status
/omp:status task-abc123
```

Use it to:

- check progress on background work
- see the latest completed job
- confirm whether a task is still running

### `/omp:result`

Shows the final stored omp output for a finished job.
When available, it also includes the omp session ID so you can reopen that run directly with `omp -r <session-id>`.

Examples:

```bash
/omp:result
/omp:result task-abc123
```

### `/omp:cancel`

Cancels an active background omp job.

Examples:

```bash
/omp:cancel
/omp:cancel task-abc123
```

### `/omp:setup`

Checks whether omp is installed and authenticated.
If omp is missing and npm is available, it can offer to install omp for you.

You can also use `/omp:setup` to manage the optional review gate.

#### Enabling review gate

```bash
/omp:setup --enable-review-gate
/omp:setup --disable-review-gate
```

When the review gate is enabled, the plugin uses a `Stop` hook to run a targeted omp review based on Claude's response. If that review finds issues, the stop is blocked so Claude can address them first.

> [!WARNING]
> The review gate can create a long-running Claude/omp loop and may drain usage limits quickly. Only enable it when you plan to actively monitor the session.

## Typical Flows

### Review Before Shipping

```bash
/omp:review
```

### Hand A Problem To omp

```bash
/omp:rescue investigate why the build is failing in CI
```

### Start Something Long-Running

```bash
/omp:adversarial-review --background
/omp:rescue --background investigate the flaky test
```

Then check in with:

```bash
/omp:status
/omp:result
```

## omp Integration

The omp plugin wraps the [omp CLI's RPC mode](https://github.com/oh-my-pi/pi-coding-agent) (`omp --mode rpc`). It uses the global `omp` binary installed in your environment.

Each job spawns its own `omp` process — there is no shared background server. Read-only commands (`/omp:review`, `/omp:adversarial-review`) run with a restricted tool set (no `bash`, `edit`, or `write`); omp has no OS-level sandbox, so this tool restriction is what enforces read-only behavior, not filesystem isolation. Write-capable runs (`/omp:rescue --write`, the default for rescue) run with the full tool set and auto-approval, since a headless run cannot answer interactive approval prompts.

### Common Configurations

Pass `--model <model>` to pin a specific model (fuzzy-matched, e.g. `gpt-5.4-mini`, `opus`, `openai/gpt-5.2`) and `--thinking <level>` to control reasoning effort (`off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`). If you omit them, omp uses its own configured defaults — see omp's own configuration docs for setting a default model or provider.

### Prompt size limits

omp's RPC protocol caps each frame at 1 MiB. Review prompts embed git diffs, so very large branch reviews may have their inline diff content trimmed to fit; when that happens, the rendered review output says so explicitly rather than silently reviewing partial context.

## FAQ

### Do I need a separate omp account for this plugin?

If you already use omp on this machine, that account should work immediately here too. This plugin uses your local omp CLI authentication and picks up whichever model provider you've signed in to.

If you only use Claude Code today and have not used omp yet, run `omp` interactively once and sign in to a model provider through `/login`. Run `/omp:setup` to check whether omp is ready.

### Does the plugin use a separate omp runtime?

No. This plugin delegates through your local omp CLI on the same machine, spawning `omp --mode rpc` per job.

That means:

- it uses the same omp install you would use directly
- it uses the same local authentication state
- it uses the same repository checkout and machine-local environment

### Will it use the same omp config I already have?

Yes. If you already use omp, the plugin picks up the same configuration and authenticated providers.

### Can I keep using my current API key setup?

Yes. Because the plugin uses your local omp CLI, your existing sign-in method and provider configuration still apply.
