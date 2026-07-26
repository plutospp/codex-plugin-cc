# Plan: replace Codex with omp as the delegate runtime

Status: **draft for review — nothing implemented.**

## Overview

### What this repo is today

`codex-plugin-cc` is a Claude Code plugin whose entire value is "hand work to an external coding
agent". Every user-facing surface (`/codex:review`, `/codex:adversarial-review`, `/codex:rescue`,
`/codex:transfer`, `/codex:status`, `/codex:result`, `/codex:cancel`, `/codex:setup`, the
`codex:codex-rescue` subagent, the Stop review gate) funnels into one Node entrypoint,
`plugins/codex/scripts/codex-companion.mjs`, which drives the **Codex app-server**: a JSON-RPC 2.0
peer spawned as `codex app-server` over stdio (`plugins/codex/scripts/lib/app-server.mjs:190`).

The coupling to Codex is *not* a binary name. It is the wire protocol and its feature set:

| Codex dependency | Where |
| --- | --- |
| `thread/start`, `thread/resume`, `turn/start`, `turn/interrupt` | `lib/codex.mjs:733,751,1136`, `lib/app-server-protocol.d.ts:62-68` |
| `review/start` (native review with structured output) | `lib/codex.mjs:1026` |
| `externalAgentConfig/import` (Claude → Codex session import) | `lib/codex.mjs:724`, `lib/claude-session-transfer.mjs` |
| per-turn `outputSchema` (JSON contract for review results) | `codex-companion.mjs:415` |
| OS sandbox policy `read-only` / `workspace-write` + `approvalPolicy: never` | `codex-companion.mjs:414,491`, `lib/codex.mjs:67-68` |
| thread multiplexing in one server process (the broker) | `scripts/app-server-broker.mjs:12` |
| generated protocol types (`codex app-server generate-ts`) | `package.json:14`, `tsconfig.app-server.json:21` |
| ChatGPT/API-key auth surfaced in `/codex:setup` | `lib/codex.mjs:817-958` |

### What "replace codex with omp" means here

**Assumption (please confirm):** `omp` = the Oh My Pi coding agent CLI (`@oh-my-pi/pi-coding-agent`),
verified present locally as `omp v17.1.3`. This is my reading of the request, not something stated in
the repo — no occurrence of "omp" exists in it today.

The plan is a **cutover, not an abstraction layer**: omp becomes *the* delegate runtime and the Codex
code paths are deleted. Adding a provider-selection layer would double the test matrix and keep a
protocol we no longer exercise; if you actually want both backends side by side, say so and I will
re-plan around a `runtime` interface with two implementations.

### Feasibility: verified

omp exposes a headless, newline-delimited JSON protocol that is structurally analogous to the Codex
app-server. Confirmed by spawning it:

```console
$ omp --mode rpc --no-session
{"type":"ready","protocolVersion":1,"supportedProtocolVersions":[1,2],"maxFrameBytes":1048576,"maxReassembledFrameBytes":67108864}
```

Protocol reference: `omp://rpc.md`. Every capability the plugin needs has a counterpart **except
three** (sandbox, per-turn output schema, external-session import) — see Risks.

## Approach

Keep the plugin's whole shape — job store, background workers, status/result/cancel, renderers,
hooks, command docs — and swap only the runtime layer underneath it. Concretely:

1. **Replace the transport.** `lib/app-server.mjs` (JSON-RPC 2.0 + broker socket) becomes
   `lib/omp-rpc.mjs`: spawn `omp --mode rpc`, consume the `ready` frame, negotiate protocol v2,
   reassemble `rpc_chunk` sequences, correlate responses by the string `id` echoed back, fan
   `agent_*` / `turn_*` / `tool_execution_*` / `message_update` events out to progress listeners.
2. **Replace the runtime adapter.** `lib/codex.mjs` becomes `lib/omp.mjs`, exposing the same *shape*
   of API the companion already calls, re-expressed in omp terms (session instead of thread,
   `prompt` + `agent_end` instead of `turn/start` + `turn/completed`).
3. **Collapse two review paths into one.** omp has no `review/start`, but this repo already has a
   complete prompt-driven review pipeline used by `/codex:adversarial-review`
   (`lib/git.mjs:collectReviewContext` → prompt template → structured JSON → `renderReviewResult`).
   `/omp:review` moves onto that same pipeline with its own prompt template; `renderNativeReviewResult`
   and `validateNativeReviewRequest` are deleted.
4. **Drop the broker.** The broker exists because one `codex app-server` process can host many
   threads; an omp RPC process *is* one session. One process per job is the natural model. Cancel
   becomes `{"type":"abort"}` followed by the existing `terminateProcessTree` (`lib/process.mjs`),
   replacing `turn/interrupt`.
5. **Enforce read-only by tool allowlist, not by sandbox.** omp has no OS sandbox. Read-only runs get
   `--tools read,grep,glob,lsp,web_search` (no `bash`, `edit`, `write`); write-capable runs get the
   full tool set plus `--approval-mode yolo` (headless cannot answer approval prompts). This is a
   real reduction in enforcement strength — called out in Risks.
6. **Rename the surface.** Plugin `codex` → `omp`, commands `/codex:*` → `/omp:*`, subagent
   `codex-rescue` → `omp-rescue`, env prefix `CODEX_COMPANION_*` → `OMP_COMPANION_*`, marketplace
   `openai-codex` → an omp-owned name. Apache-2.0 `LICENSE`/`NOTICE` attribution stays intact.

### Capability mapping

| Plugin need | Codex today | omp replacement | Gap |
| --- | --- | --- | --- |
| start work | `thread/start` + `turn/start` | spawn `omp --mode rpc`, `{"type":"prompt"}` | none |
| completion signal | `turn/completed` | `agent_end` (+ `data.agentInvoked`) | none |
| final text | last agent message | `get_last_assistant_text` | none |
| progress | `item/started`/`item/completed` | `tool_execution_start/end`, `message_update` | event names differ |
| resume prior work | `thread/resume` + `thread/list` | `omp --mode rpc -r <sessionId>`; `get_state` returns `sessionId`/`sessionFile`; sessions live under `~/.omp/agent/sessions/<dir-encoded>/` | listing needs a dir scan, not an RPC call |
| cancel | `turn/interrupt` | `{"type":"abort"}` + process-tree kill | none |
| model select | `model` param | `--model` (fuzzy) or `set_model` | alias `spark` no longer meaningful |
| reasoning effort | `model_reasoning_effort` | `--thinking` / `set_thinking_level` (`off…max`) | `none`→`off`; omp adds `max` |
| auth check | account + config RPC | `get_available_models`, `get_login_providers`, `login` | different report shape |
| structured review JSON | per-turn `outputSchema` | prompt contract + validate + one repair retry | **gap** |
| read-only guarantee | OS sandbox | tool allowlist | **gap** |
| Claude → agent session import | `externalAgentConfig/import` | none | **gap** |

## Key steps

Phase 0 is mine (contracts must exist before anything is fanned out). Phases 1–2 are the parallel
slices; the letters are the intended subagent split.

### Phase 0 — freeze the contracts (no parallelism possible)

- `lib/omp-rpc.mjs` client surface: `class OmpRpcClient { start(), request(cmd), on(event), abort(), close() }`.
- `lib/omp.mjs` adapter surface every other slice codes against:
  - `getOmpAvailability(cwd)` → `{ available, version, error }`
  - `getOmpAuthStatus(cwd)` → `{ authenticated, models[], loginProviders[], detail }`
  - `runOmpTurn(cwd, { prompt, model, thinking, write, resumeSessionId, onProgress })` →
    `{ status, finalMessage, sessionId, sessionFile, reasoningSummary, touchedFiles, stderr, error }`
  - `interruptOmpTurn(cwd, { sessionId })`, `findLatestTaskSession(cwd)`
- Persisted job payload: rename `threadId` → `sessionId` (state files are versioned,
  `lib/state.mjs:8`; bump `STATE_VERSION` and drop stale jobs rather than migrating).
- Naming decisions frozen: plugin dir `plugins/omp/`, entry `scripts/omp-companion.mjs`, env prefix
  `OMP_COMPANION_*`, state dir `omp-companion`.
- **Prompt-size budget (hard design requirement).** omp RPC rejects any physical frame over 1 MiB in
  either direction, so the review prompt is a *budgeted* artifact, not free-form text: schema
  instructions + review context + diffs must be assembled against a single constant
  (`MAX_PROMPT_BYTES`, set well under 1 MiB) with a deterministic shed order — inline diffs first
  (already capped at 256 KiB in `lib/git.mjs`), then untracked-file bodies, then per-file stat
  summaries — and the shed must be reported in the rendered result so a truncated review never
  silently claims full coverage. Slices C and D both consume this constant; it is frozen here.

### Phase 1 — parallel implementation slices

- **A. Transport** — new `lib/omp-rpc.mjs`; delete `lib/app-server.mjs`, `lib/broker-endpoint.mjs`,
  `lib/broker-lifecycle.mjs`, `scripts/app-server-broker.mjs`. Must cover: ready frame, v2
  `negotiate_protocol`, `rpc_chunk` reassembly with `chunkId`/`index`/`count`/`byteLength`
  validation, 1 MiB outbound frame ceiling, stdin-close shutdown, Windows `.cmd`-shim spawn parity
  with the current `shell: process.platform === "win32"` handling.
- **B. Runtime adapter** — new `lib/omp.mjs` implementing the Phase 0 surface: event→progress
  translation, `agent_end` completion with the existing inferred-completion fallback, session
  discovery by scanning `~/.omp/agent/sessions/<dir-encoded>/` (honour `PI_CODING_AGENT_DIR`),
  thinking-level and tool-allowlist mapping.
- **C. Review pipeline** — new `prompts/review.md`; route `/omp:review` through
  `collectReviewContext` + `schemas/review-output.schema.json`; add schema validation with one
  repair retry when the model returns non-conforming JSON; delete the native-review branch
  (`codex-companion.mjs:368-407`) and `renderNativeReviewResult`.
- **D. Command + agent surface** — rewrite `commands/*.md`, `agents/omp-rescue.md`, skills
  (`codex-cli-runtime` → `omp-cli-runtime`, `codex-result-handling` → `omp-result-handling`,
  `gpt-5-4-prompting` → model-agnostic `omp-prompting` or deleted — it is GPT-5-specific guidance
  that would be actively wrong for an omp session running Claude or GLM), hook wiring and env names
  in `hooks/hooks.json`, `session-lifecycle-hook.mjs`, `stop-review-gate-hook.mjs`.
- **E. Packaging + docs** — `plugins/omp/.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`,
  root `package.json` (drop the `codex app-server generate-ts` prebuild; type the protocol from
  hand-written `omp-rpc-protocol.d.ts` or from `@oh-my-pi/pi-coding-agent` types as a devDependency),
  `tsconfig.app-server.json` include list, `scripts/bump-version.mjs` path assumptions,
  `.github/workflows/pull-request-ci.yml` (install omp instead of `@openai/codex`), README rewrite,
  `CHANGELOG.md` entry, keep `NOTICE`/`LICENSE` attribution.
- **F. Test harness** — replace `tests/fake-codex-fixture.mjs` with a fake `omp` that speaks the RPC
  frame protocol (ready → responses → `agent_*` events), then repoint `tests/runtime.test.mjs`
  (~75 KB, the single largest cost in this plan), `commands.test.mjs`, `render.test.mjs`,
  `state.test.mjs`, `process.test.mjs`.

### Phase 2 — decide and execute `/transfer`

`/codex:transfer` has **no omp equivalent** (`omp://session-operations-export-share-fork-resume.md`
documents resume/fork/continue/export/share — no external-agent import). Options:

- **A. Drop the command.** Cheapest, loses a feature.
- **B. Handoff file (recommended).** Convert the Claude transcript to a markdown handoff and print
  `omp "@<handoff>.md"` — omp accepts `@file` message arguments. Keeps the user-visible promise
  ("continue this conversation in omp") without depending on omp internals.
- **C. Synthesize an omp session JSONL** in the documented v3 format (`omp://session.md`) so
  `omp -r <id>` resumes real turns. Highest fidelity, but couples the plugin to an internal file
  format across omp releases. Not recommended.

### Phase 3 — verification (run once, by me, not inside the slices)

1. `npm test` + `npm run build`.
2. Live smoke against real omp in a scratch git repo: `/omp:setup` → `/omp:review --background` →
   `/omp:status` → `/omp:result` → `/omp:rescue --background <task>` → `/omp:cancel`.
3. Read-only assertion: run a review against a repo with a dirty tree and confirm `git status` is
   unchanged afterwards.
4. Resume assertion: `/omp:rescue --resume` continues the same `sessionId` reported by `/omp:result`.
5. Stop review gate on/off via `/omp:setup --enable-review-gate`.

## Risks

1. **No sandbox in omp.** Codex enforced read-only at the OS level; omp enforces nothing. A review
   run is read-only only because `bash`/`edit`/`write` are absent from `--tools`. Losing `bash` also
   makes reviews weaker (no `git log`, no test runs). Mitigation: allowlist by default, document the
   change, and treat "review can run commands" as a follow-up requiring a constrained wrapper tool.
   *Verification needed:* confirm `--tools` is honoured in `--mode rpc` (documented for the CLI;
   untested by me).
2. **No per-turn output schema.** Review JSON becomes a prompt contract. Even with validation plus a
   repair retry, expect a higher rate of degraded renders than today. `parseStructuredOutput`
   already tolerates this; renderers must not regress on `parseError`.
3. **Feature loss is user-visible.** `/transfer` (pending Phase 2 choice) and the `spark` model alias
   disappear; `/setup`'s "install it for you" flow changes channel (npm `@openai/codex` → omp's
   install path, which must be confirmed for Linux CI and for Windows users).
4. **Test rewrite dominates the effort.** `tests/runtime.test.mjs` asserts Codex protocol shapes
   end-to-end. If slice F lags, everything else looks done while being unverified. Sequence F to
   start with A, not after it.
5. **Prompt overflow.** The 1 MiB frame ceiling is handled by the Phase 0 budget above; the residual
   risk is a branch review whose *shed* output is so aggressive the review becomes useless. The
   renderer must surface "context truncated" prominently rather than degrade quietly.
6. **Concurrency/perf change.** Dropping the broker means one omp process per job and a cold start
   per run, where Codex reused a warm shared server. Acceptable for background jobs; measure the
   foreground `/omp:review` path before declaring parity.
7. **Session-resume semantics differ.** Codex threads were addressed by ID via RPC; omp sessions are
   files under a cwd-encoded directory, and "latest session for this repo" becomes a filesystem
   scan with the same-cwd caveats (`omp://session.md` on-disk layout, including the legacy
   directory-name migration).
8. **Fork identity.** Renaming makes this a permanent fork of an OpenAI-owned repo; keep `NOTICE`
   attribution and drop OpenAI ownership claims from `marketplace.json`/`plugin.json`.
9. **omp version drift.** The plugin would target omp v17's RPC surface (v1 ready frame, v2 opt-in).
   Pin a documented minimum version in `/omp:setup` and fail loudly below it rather than
   mis-parsing frames.

## Open decisions for you

- **D1.** Hard cutover (this plan) vs. keep Codex and add omp as a selectable backend.
- **D2.** Rename the command namespace to `/omp:*` (assumed yes) or keep `/codex:*` names pointing at
  omp (confusing, but zero migration for existing users).
- **D3.** `/transfer`: drop (A), handoff file (B, recommended), or session synthesis (C).
- **D4.** Repo/marketplace identity for the fork (name + owner in `.claude-plugin/marketplace.json`).
- **D5.** Review runs: strict allowlist without `bash` (recommended) vs. keep `bash` and accept that
  "read-only" is advisory.
