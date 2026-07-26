import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { buildEnv, installFakeOmp } from "./fake-omp-fixture.mjs";
import { initGitRepo, makeTempDir, run } from "./helpers.mjs";
import { resolveStateDir } from "../plugins/omp/scripts/lib/state.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PLUGIN_ROOT = path.join(ROOT, "plugins", "omp");
const SCRIPT = path.join(PLUGIN_ROOT, "scripts", "omp-companion.mjs");
const STOP_HOOK = path.join(PLUGIN_ROOT, "scripts", "stop-review-gate-hook.mjs");
const SESSION_HOOK = path.join(PLUGIN_ROOT, "scripts", "session-lifecycle-hook.mjs");

async function waitFor(predicate, { timeoutMs = 10000, intervalMs = 50 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const value = await predicate();
    if (value) {
      return value;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error("Timed out waiting for condition.");
}

function commitFile(repo, relativePath, content) {
  fs.mkdirSync(path.dirname(path.join(repo, relativePath)), { recursive: true });
  fs.writeFileSync(path.join(repo, relativePath), content);
  run("git", ["add", relativePath], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
}

// ---------------------------------------------------------------------------
// setup / auth
// ---------------------------------------------------------------------------

test("setup reports ready when fake omp is installed and authenticated", () => {
  const binDir = makeTempDir();
  installFakeOmp(binDir);

  const result = run("node", [SCRIPT, "setup", "--json"], {
    cwd: ROOT,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ready, true);
  assert.equal(payload.omp.available, true);
  assert.equal(payload.auth.loggedIn, true);
});

test("setup reports omp missing when the binary is not on PATH", () => {
  const result = run(process.execPath, [SCRIPT, "setup", "--json"], {
    cwd: ROOT,
    env: { ...process.env, PATH: "" }
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ready, false);
  assert.equal(payload.omp.available, false);
  assert.match(payload.nextSteps.join(" "), /npm install -g @oh-my-pi\/pi-coding-agent/);
});

test("setup reports auth needed when no model is available", () => {
  const binDir = makeTempDir();
  installFakeOmp(binDir, "logged-out");

  const result = run("node", [SCRIPT, "setup", "--json"], {
    cwd: ROOT,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ready, false);
  assert.equal(payload.auth.loggedIn, false);
  assert.match(payload.auth.detail, /No authenticated models found/);
  assert.match(payload.nextSteps.join(" "), /sign in to a model provider/);
});

// ---------------------------------------------------------------------------
// review / adversarial-review
// ---------------------------------------------------------------------------

test("review renders a working-tree review through the prompt-driven pipeline", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeOmp(binDir, "adversarial-clean");
  initGitRepo(repo);
  commitFile(repo, "README.md", "hello\n");
  fs.writeFileSync(path.join(repo, "README.md"), "hello again\n");

  const result = run("node", [SCRIPT, "review"], { cwd: repo, env: buildEnv(binDir) });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^# Review/);
  assert.match(result.stdout, /Verdict: approve/);
});

test("review supports base-branch targeting", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeOmp(binDir, "adversarial-clean");
  initGitRepo(repo);
  commitFile(repo, "src/app.js", "export const value = 1;\n");
  fs.writeFileSync(path.join(repo, "src", "app.js"), "export const value = 2;\n");

  const result = run("node", [SCRIPT, "review", "--base", "main"], { cwd: repo, env: buildEnv(binDir) });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Verdict: approve/);
});

test("review now accepts trailing focus text, unlike the old native-review-only restriction", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeOmp(binDir, "adversarial-clean");
  initGitRepo(repo);
  commitFile(repo, "README.md", "hello\n");
  fs.writeFileSync(path.join(repo, "README.md"), "hello again\n");

  const result = run("node", [SCRIPT, "review", "focus", "on", "retries"], { cwd: repo, env: buildEnv(binDir) });

  assert.equal(result.status, 0, result.stderr);
  const state = JSON.parse(fs.readFileSync(path.join(binDir, "fake-omp-state.json"), "utf8"));
  assert.match(state.lastPrompt.message, /focus on retries/);
});

test("review runs with a read-only tool allowlist and no approval mode", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeOmp(binDir, "adversarial-clean");
  initGitRepo(repo);
  commitFile(repo, "README.md", "hello\n");
  fs.writeFileSync(path.join(repo, "README.md"), "hello again\n");

  const result = run("node", [SCRIPT, "review"], { cwd: repo, env: buildEnv(binDir) });

  assert.equal(result.status, 0, result.stderr);
  const state = JSON.parse(fs.readFileSync(path.join(binDir, "fake-omp-state.json"), "utf8"));
  assert.equal(state.lastToolsAllowlist, "read,grep,glob,lsp,web_search");
  assert.equal(state.lastApprovalMode, null);
});

test("review defaults to the @slow model role", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeOmp(binDir, "adversarial-clean");
  initGitRepo(repo);
  commitFile(repo, "README.md", "hello\n");
  fs.writeFileSync(path.join(repo, "README.md"), "hello again\n");

  const result = run("node", [SCRIPT, "review"], { cwd: repo, env: buildEnv(binDir) });

  assert.equal(result.status, 0, result.stderr);
  const state = JSON.parse(fs.readFileSync(path.join(binDir, "fake-omp-state.json"), "utf8"));
  assert.equal(state.lastPrompt.model, "@slow");
});

test("review respects an explicit --model override", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeOmp(binDir, "adversarial-clean");
  initGitRepo(repo);
  commitFile(repo, "README.md", "hello\n");
  fs.writeFileSync(path.join(repo, "README.md"), "hello again\n");

  const result = run("node", [SCRIPT, "review", "--model", "gpt-5.4-mini"], { cwd: repo, env: buildEnv(binDir) });

  assert.equal(result.status, 0, result.stderr);
  const state = JSON.parse(fs.readFileSync(path.join(binDir, "fake-omp-state.json"), "utf8"));
  assert.equal(state.lastPrompt.model, "gpt-5.4-mini");
});

test("adversarial review renders structured findings", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeOmp(binDir);
  initGitRepo(repo);
  commitFile(repo, "src/app.js", "export const value = items[0];\n");
  fs.writeFileSync(path.join(repo, "src", "app.js"), "export const value = items[0].id;\n");

  const result = run("node", [SCRIPT, "adversarial-review"], { cwd: repo, env: buildEnv(binDir) });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Missing empty-state guard/);
});

test("adversarial review asks omp to inspect larger diffs itself", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeOmp(binDir);
  initGitRepo(repo);
  fs.mkdirSync(path.join(repo, "src"));
  for (const name of ["a.js", "b.js", "c.js"]) {
    fs.writeFileSync(path.join(repo, "src", name), `export const value = "${name}-v1";\n`);
  }
  run("git", ["add", "src/a.js", "src/b.js", "src/c.js"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "src", "a.js"), 'export const value = "PROMPT_SELF_COLLECT_A";\n');
  fs.writeFileSync(path.join(repo, "src", "b.js"), 'export const value = "PROMPT_SELF_COLLECT_B";\n');
  fs.writeFileSync(path.join(repo, "src", "c.js"), 'export const value = "PROMPT_SELF_COLLECT_C";\n');

  const result = run("node", [SCRIPT, "adversarial-review"], { cwd: repo, env: buildEnv(binDir) });

  assert.equal(result.status, 0, result.stderr);
  const state = JSON.parse(fs.readFileSync(path.join(binDir, "fake-omp-state.json"), "utf8"));
  assert.match(state.lastPrompt.message, /read-only git commands/i);
  assert.doesNotMatch(state.lastPrompt.message, /PROMPT_SELF_COLLECT_[ABC]/);
});

test("review includes reasoning output when omp returns a thinking delta", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeOmp(binDir, "with-reasoning");
  initGitRepo(repo);
  commitFile(repo, "README.md", "hello\n");
  fs.writeFileSync(path.join(repo, "README.md"), "hello again\n");

  const result = run("node", [SCRIPT, "review"], { cwd: repo, env: buildEnv(binDir) });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Reasoning:/);
  assert.match(result.stdout, /Inspected the prompt, gathered evidence/);
});

test("review logs reasoning summaries and review output to the job log", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeOmp(binDir, "with-reasoning");
  initGitRepo(repo);
  commitFile(repo, "README.md", "hello\n");
  fs.writeFileSync(path.join(repo, "README.md"), "hello again\n");

  const result = run("node", [SCRIPT, "review"], { cwd: repo, env: buildEnv(binDir) });

  assert.equal(result.status, 0, result.stderr);
  const stateDir = resolveStateDir(repo);
  const state = JSON.parse(fs.readFileSync(path.join(stateDir, "state.json"), "utf8"));
  const log = fs.readFileSync(state.jobs[0].logFile, "utf8");
  assert.match(log, /Sending prompt to omp/);
  assert.match(log, /Turn completed/);
});

test("review repairs invalid JSON with a one-shot follow-up on the same session", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeOmp(binDir, "invalid-json");
  initGitRepo(repo);
  commitFile(repo, "README.md", "hello\n");
  fs.writeFileSync(path.join(repo, "README.md"), "hello again\n");

  const result = run("node", [SCRIPT, "review", "--json"], { cwd: repo, env: buildEnv(binDir) });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.parseError, null);
  assert.equal(payload.result.verdict, "approve");
});

test("review degrades gracefully when the repair attempt also fails", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeOmp(binDir, "invalid-json-persists");
  initGitRepo(repo);
  commitFile(repo, "README.md", "hello\n");
  fs.writeFileSync(path.join(repo, "README.md"), "hello again\n");

  const result = run("node", [SCRIPT, "review"], { cwd: repo, env: buildEnv(binDir) });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /omp did not return valid structured JSON/);
  assert.match(result.stdout, /still not valid json/);
});

// ---------------------------------------------------------------------------
// task / rescue
// ---------------------------------------------------------------------------

test("task runs a write-capable request with the full tool set and yolo approval", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeOmp(binDir);
  initGitRepo(repo);
  commitFile(repo, "README.md", "hello\n");

  const result = run("node", [SCRIPT, "task", "--write", "fix the bug"], { cwd: repo, env: buildEnv(binDir) });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "Handled the requested task.\nTask prompt accepted.\n");
  const state = JSON.parse(fs.readFileSync(path.join(binDir, "fake-omp-state.json"), "utf8"));
  assert.equal(state.lastToolsAllowlist, null);
  assert.equal(state.lastApprovalMode, "yolo");
});

test("task runs read-only by default without --write", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeOmp(binDir);
  initGitRepo(repo);
  commitFile(repo, "README.md", "hello\n");

  const result = run("node", [SCRIPT, "task", "diagnose the bug"], { cwd: repo, env: buildEnv(binDir) });

  assert.equal(result.status, 0, result.stderr);
  const state = JSON.parse(fs.readFileSync(path.join(binDir, "fake-omp-state.json"), "utf8"));
  assert.equal(state.lastToolsAllowlist, "read,grep,glob,lsp,web_search");
});

test("task --resume-last resumes the latest persisted task session", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeOmp(binDir);
  initGitRepo(repo);
  commitFile(repo, "README.md", "hello\n");

  const firstRun = run("node", [SCRIPT, "task", "initial task"], { cwd: repo, env: buildEnv(binDir) });
  assert.equal(firstRun.status, 0, firstRun.stderr);

  const result = run("node", [SCRIPT, "task", "--resume-last", "follow up"], { cwd: repo, env: buildEnv(binDir) });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "Resumed the prior run.\nFollow-up prompt accepted.\n");
  const state = JSON.parse(fs.readFileSync(path.join(binDir, "fake-omp-state.json"), "utf8"));
  assert.ok(state.lastPrompt.resumedFrom);
});

test("task-resume-candidate returns the latest rescue job from the current session", () => {
  const workspace = makeTempDir();
  const stateDir = resolveStateDir(workspace);
  fs.mkdirSync(path.join(stateDir, "jobs"), { recursive: true });

  fs.writeFileSync(
    path.join(stateDir, "state.json"),
    `${JSON.stringify(
      {
        version: 2,
        config: { stopReviewGate: false },
        jobs: [
          {
            id: "task-current",
            status: "completed",
            title: "omp Task",
            jobClass: "task",
            sessionId: "sess-current",
            ompSessionId: "sess_omp_current",
            summary: "Investigate the flaky test",
            updatedAt: "2026-03-24T20:00:00.000Z"
          },
          {
            id: "task-other-session",
            status: "completed",
            title: "omp Task",
            jobClass: "task",
            sessionId: "sess-other",
            summary: "Old rescue run",
            updatedAt: "2026-03-24T20:05:00.000Z"
          },
          {
            id: "review-current",
            status: "completed",
            title: "omp Review",
            jobClass: "review",
            sessionId: "sess-current",
            summary: "Review main...HEAD",
            updatedAt: "2026-03-24T20:10:00.000Z"
          }
        ]
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  const result = run("node", [SCRIPT, "task-resume-candidate", "--json"], {
    cwd: workspace,
    env: { ...process.env, OMP_COMPANION_SESSION_ID: "sess-current" }
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.available, true);
  assert.equal(payload.sessionId, "sess-current");
  assert.equal(payload.candidate.id, "task-current");
  assert.equal(payload.candidate.ompSessionId, "sess_omp_current");
});

test("task --resume-last does not resume a task from another Claude session", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeOmp(binDir);
  initGitRepo(repo);
  commitFile(repo, "README.md", "hello\n");

  const otherEnv = { ...buildEnv(binDir), OMP_COMPANION_SESSION_ID: "sess-other" };
  const currentEnv = { ...buildEnv(binDir), OMP_COMPANION_SESSION_ID: "sess-current" };

  const firstRun = run("node", [SCRIPT, "task", "initial task"], { cwd: repo, env: otherEnv });
  assert.equal(firstRun.status, 0, firstRun.stderr);

  const candidate = run("node", [SCRIPT, "task-resume-candidate", "--json"], { cwd: repo, env: currentEnv });
  assert.equal(candidate.status, 0, candidate.stderr);
  assert.equal(JSON.parse(candidate.stdout).available, false);

  const resume = run("node", [SCRIPT, "task", "--resume-last", "follow up"], { cwd: repo, env: currentEnv });
  assert.equal(resume.status, 1);
  assert.match(resume.stderr, /No previous omp task session was found for this repository\./);
});

test("task reports the actual omp auth error when the run is rejected", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeOmp(binDir, "auth-run-fails");
  initGitRepo(repo);
  commitFile(repo, "README.md", "hello\n");

  const result = run("node", [SCRIPT, "task", "check failed auth"], { cwd: repo, env: buildEnv(binDir) });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /authentication expired; run omp login/);
});

test("task --background queues, completes, and is visible via status and result", async () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeOmp(binDir);
  initGitRepo(repo);
  commitFile(repo, "README.md", "hello\n");

  const launch = run("node", [SCRIPT, "task", "--background", "--json", "investigate the bug"], {
    cwd: repo,
    env: buildEnv(binDir)
  });
  assert.equal(launch.status, 0, launch.stderr);
  const jobId = JSON.parse(launch.stdout).jobId;
  assert.ok(jobId);

  const stateDir = resolveStateDir(repo);
  await waitFor(() => {
    const state = JSON.parse(fs.readFileSync(path.join(stateDir, "state.json"), "utf8"));
    const job = state.jobs.find((candidate) => candidate.id === jobId);
    return job?.status === "completed" ? job : null;
  });

  const result = run("node", [SCRIPT, "result", jobId, "--json"], { cwd: repo, env: buildEnv(binDir) });
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.job.status, "completed");
});

test("cancel kills a running background job via process-tree termination", async () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeOmp(binDir, "long-task");
  initGitRepo(repo);
  commitFile(repo, "README.md", "hello\n");

  const env = buildEnv(binDir);
  const launch = run("node", [SCRIPT, "task", "--background", "--json", "investigate the slow leak"], {
    cwd: repo,
    env
  });
  assert.equal(launch.status, 0, launch.stderr);
  const jobId = JSON.parse(launch.stdout).jobId;

  const stateDir = resolveStateDir(repo);
  await waitFor(() => {
    const state = JSON.parse(fs.readFileSync(path.join(stateDir, "state.json"), "utf8"));
    const job = state.jobs.find((candidate) => candidate.id === jobId);
    return job?.status === "running" ? job : null;
  });

  const cancel = run("node", [SCRIPT, "cancel", jobId, "--json"], { cwd: repo, env });
  assert.equal(cancel.status, 0, cancel.stderr);
  const cancelPayload = JSON.parse(cancel.stdout);
  assert.equal(cancelPayload.status, "cancelled");

  const state = JSON.parse(fs.readFileSync(path.join(stateDir, "state.json"), "utf8"));
  const job = state.jobs.find((candidate) => candidate.id === jobId);
  assert.equal(job.status, "cancelled");
});

test("cancel reports no active jobs when nothing is running for this session", () => {
  const workspace = makeTempDir();
  const stateDir = resolveStateDir(workspace);
  fs.mkdirSync(path.join(stateDir, "jobs"), { recursive: true });
  fs.writeFileSync(
    path.join(stateDir, "state.json"),
    `${JSON.stringify(
      { version: 2, config: { stopReviewGate: false }, jobs: [{ id: "task-other", status: "running", sessionId: "sess-other" }] },
      null,
      2
    )}\n`,
    "utf8"
  );

  const env = { ...process.env, OMP_COMPANION_SESSION_ID: "sess-current" };
  const cancel = run("node", [SCRIPT, "cancel", "--json"], { cwd: workspace, env });
  assert.equal(cancel.status, 1);
  assert.match(cancel.stderr, /No active omp jobs to cancel for this session\./);
});

// ---------------------------------------------------------------------------
// commit
// ---------------------------------------------------------------------------

test("commit defaults to the @commit model role with write enabled", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeOmp(binDir);
  initGitRepo(repo);
  commitFile(repo, "src/app.js", "export const value = 1;\n");
  fs.writeFileSync(path.join(repo, "src", "app.js"), "export const value = 2;\n");

  const result = run("node", [SCRIPT, "commit"], { cwd: repo, env: buildEnv(binDir) });

  assert.equal(result.status, 0, result.stderr);
  const state = JSON.parse(fs.readFileSync(path.join(binDir, "fake-omp-state.json"), "utf8"));
  assert.equal(state.lastPrompt.model, "@commit");
  assert.equal(state.lastApprovalMode, "yolo");
  assert.match(state.lastPrompt.message, /Commit the current changes/);
});

test("commit appends extra instructions to the prompt", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeOmp(binDir);
  initGitRepo(repo);
  commitFile(repo, "src/app.js", "export const value = 1;\n");
  fs.writeFileSync(path.join(repo, "src", "app.js"), "export const value = 2;\n");

  const result = run("node", [SCRIPT, "commit", "use", "conventional", "format"], { cwd: repo, env: buildEnv(binDir) });

  assert.equal(result.status, 0, result.stderr);
  const state = JSON.parse(fs.readFileSync(path.join(binDir, "fake-omp-state.json"), "utf8"));
  assert.match(state.lastPrompt.message, /Commit the current changes\. use conventional format/);
});

// ---------------------------------------------------------------------------
// transfer
// ---------------------------------------------------------------------------

test("transfer writes a handoff markdown file and prints the omp continuation command", () => {
  const home = makeTempDir();
  const repo = path.join(home, "repo");
  fs.mkdirSync(repo, { recursive: true });
  const projectDir = path.join(home, ".claude", "projects", "-repo");
  fs.mkdirSync(projectDir, { recursive: true });
  const sourcePath = path.join(projectDir, "session.jsonl");
  initGitRepo(repo);
  fs.writeFileSync(
    sourcePath,
    [
      { type: "custom-title", customTitle: "Debugging the flaky test" },
      { type: "user", cwd: repo, message: { role: "user", content: "Why is this test flaky?" } },
      { type: "assistant", cwd: repo, message: { role: "assistant", content: "It races on a shared temp file." } }
    ]
      .map((entry) => JSON.stringify(entry))
      .join("\n") + "\n",
    "utf8"
  );

  const result = run("node", [SCRIPT, "transfer", "--json"], {
    cwd: repo,
    env: { ...process.env, HOME: home, USERPROFILE: home, OMP_COMPANION_TRANSCRIPT_PATH: sourcePath }
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.ok(fs.existsSync(payload.handoffPath));
  const handoff = fs.readFileSync(payload.handoffPath, "utf8");
  assert.match(handoff, /# Debugging the flaky test/);
  assert.match(handoff, /### User/);
  assert.match(handoff, /Why is this test flaky\?/);
  assert.match(handoff, /### Assistant/);
  assert.match(handoff, /It races on a shared temp file\./);
  assert.equal(payload.resumeCommand, `omp "@${payload.handoffPath}"`);
});

test("transfer rejects sources outside the Claude projects directory", () => {
  const home = makeTempDir();
  const repo = path.join(home, "repo");
  fs.mkdirSync(repo, { recursive: true });
  fs.mkdirSync(path.join(home, ".claude", "projects"), { recursive: true });
  initGitRepo(repo);
  const sourcePath = path.join(home, "session.jsonl");
  fs.writeFileSync(
    sourcePath,
    `${JSON.stringify({ type: "user", cwd: repo, message: { role: "user", content: "Outside source." } })}\n`,
    "utf8"
  );

  const result = run("node", [SCRIPT, "transfer", "--source", sourcePath], {
    cwd: repo,
    env: { ...process.env, HOME: home, USERPROFILE: home }
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /only from .*\.claude.*projects/);
});

// ---------------------------------------------------------------------------
// session lifecycle + stop review gate hooks
// ---------------------------------------------------------------------------

test("session start hook exports the Claude session id, transcript path, and plugin data dir", () => {
  const repo = makeTempDir();
  const envFile = path.join(makeTempDir(), "claude-env.sh");
  fs.writeFileSync(envFile, "", "utf8");
  const pluginDataDir = makeTempDir();
  const transcriptPath = path.join(repo, "session.jsonl");

  const result = run("node", [SESSION_HOOK, "SessionStart"], {
    cwd: repo,
    env: { ...process.env, CLAUDE_ENV_FILE: envFile, CLAUDE_PLUGIN_DATA: pluginDataDir },
    input: JSON.stringify({
      hook_event_name: "SessionStart",
      session_id: "sess-current",
      transcript_path: transcriptPath,
      cwd: repo
    })
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    fs.readFileSync(envFile, "utf8"),
    `export OMP_COMPANION_SESSION_ID='sess-current'\nexport OMP_COMPANION_TRANSCRIPT_PATH='${transcriptPath}'\nexport CLAUDE_PLUGIN_DATA='${pluginDataDir}'\n`
  );
});

test("session end fully cleans up jobs for the ending session", async (t) => {
  const repo = makeTempDir();
  initGitRepo(repo);
  commitFile(repo, "README.md", "hello\n");

  const stateDir = resolveStateDir(repo);
  const jobsDir = path.join(stateDir, "jobs");
  fs.mkdirSync(jobsDir, { recursive: true });

  const completedLog = path.join(jobsDir, "completed.log");
  const runningLog = path.join(jobsDir, "running.log");
  const otherSessionLog = path.join(jobsDir, "other.log");
  const otherJobFile = path.join(jobsDir, "review-other.json");
  fs.writeFileSync(completedLog, "completed\n", "utf8");
  fs.writeFileSync(runningLog, "running\n", "utf8");
  fs.writeFileSync(otherSessionLog, "other\n", "utf8");
  fs.writeFileSync(path.join(jobsDir, "review-completed.json"), JSON.stringify({ id: "review-completed" }, null, 2), "utf8");
  fs.writeFileSync(otherJobFile, JSON.stringify({ id: "review-other" }, null, 2), "utf8");

  const sleeper = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { cwd: repo, detached: true, stdio: "ignore" });
  sleeper.unref();

  t.after(() => {
    try {
      process.kill(-sleeper.pid, "SIGTERM");
    } catch {
      try {
        process.kill(sleeper.pid, "SIGTERM");
      } catch {
        // Ignore missing process.
      }
    }
  });

  fs.writeFileSync(
    path.join(stateDir, "state.json"),
    `${JSON.stringify(
      {
        version: 2,
        config: { stopReviewGate: false },
        jobs: [
          { id: "review-completed", status: "completed", title: "omp Review", sessionId: "sess-current", logFile: completedLog, updatedAt: "2026-03-18T15:31:00.000Z" },
          { id: "review-running", status: "running", title: "omp Review", sessionId: "sess-current", pid: sleeper.pid, logFile: runningLog, updatedAt: "2026-03-18T15:33:00.000Z" },
          { id: "review-other", status: "completed", title: "omp Review", sessionId: "sess-other", logFile: otherSessionLog, updatedAt: "2026-03-18T15:35:00.000Z" }
        ]
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  const result = run("node", [SESSION_HOOK, "SessionEnd"], {
    cwd: repo,
    env: { ...process.env, OMP_COMPANION_SESSION_ID: "sess-current" },
    input: JSON.stringify({ hook_event_name: "SessionEnd", session_id: "sess-current", cwd: repo })
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.existsSync(otherSessionLog), true);
  assert.equal(fs.existsSync(otherJobFile), true);

  await waitFor(() => {
    try {
      process.kill(sleeper.pid, 0);
      return false;
    } catch (error) {
      return error?.code === "ESRCH";
    }
  });

  const state = JSON.parse(fs.readFileSync(path.join(stateDir, "state.json"), "utf8"));
  assert.deepEqual(state.jobs.map((job) => job.id), ["review-other"]);
});

test("stop hook runs a stop-time review task and blocks on findings when the review gate is enabled", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeOmp(binDir);
  initGitRepo(repo);
  commitFile(repo, "README.md", "hello\n");

  const setup = run("node", [SCRIPT, "setup", "--enable-review-gate", "--json"], { cwd: repo, env: buildEnv(binDir) });
  assert.equal(setup.status, 0, setup.stderr);
  assert.equal(JSON.parse(setup.stdout).reviewGateEnabled, true);

  const taskResult = run("node", [SCRIPT, "task", "--write", "fix the issue"], { cwd: repo, env: buildEnv(binDir) });
  assert.equal(taskResult.status, 0, taskResult.stderr);

  const blocked = run("node", [STOP_HOOK], {
    cwd: repo,
    env: buildEnv(binDir),
    input: JSON.stringify({
      cwd: repo,
      session_id: "sess-stop-review",
      last_assistant_message: "I completed the refactor and updated the retry logic."
    })
  });
  assert.equal(blocked.status, 0, blocked.stderr);
  const blockedPayload = JSON.parse(blocked.stdout);
  assert.equal(blockedPayload.decision, "block");
  assert.match(blockedPayload.reason, /omp stop-time review found issues that still need fixes/i);
  assert.match(blockedPayload.reason, /Missing empty-state guard/i);

  const state = JSON.parse(fs.readFileSync(path.join(binDir, "fake-omp-state.json"), "utf8"));
  assert.match(state.lastPrompt.message, /<task>/i);
  assert.match(state.lastPrompt.message, /<compact_output_contract>/i);
  assert.match(state.lastPrompt.message, /Only review the work from the previous Claude turn/i);
  assert.match(state.lastPrompt.message, /I completed the refactor and updated the retry logic\./);

  const status = run("node", [SCRIPT, "status"], {
    cwd: repo,
    env: { ...buildEnv(binDir), OMP_COMPANION_SESSION_ID: "sess-stop-review" }
  });
  assert.equal(status.status, 0, status.stderr);
  assert.match(status.stdout, /omp Stop Gate Review/);
});

test("stop hook logs running tasks to stderr without blocking when the review gate is disabled", () => {
  const repo = makeTempDir();
  initGitRepo(repo);
  commitFile(repo, "README.md", "hello\n");

  const stateDir = resolveStateDir(repo);
  const jobsDir = path.join(stateDir, "jobs");
  fs.mkdirSync(jobsDir, { recursive: true });
  const runningLog = path.join(jobsDir, "task-running.log");
  fs.writeFileSync(runningLog, "running\n", "utf8");

  fs.writeFileSync(
    path.join(stateDir, "state.json"),
    `${JSON.stringify(
      {
        version: 2,
        config: { stopReviewGate: false },
        jobs: [{ id: "task-live", status: "running", title: "omp Task", jobClass: "task", sessionId: "sess-current", logFile: runningLog, updatedAt: "2026-03-18T15:33:00.000Z" }]
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  const blocked = run("node", [STOP_HOOK], {
    cwd: repo,
    env: { ...process.env, OMP_COMPANION_SESSION_ID: "sess-current" },
    input: JSON.stringify({ cwd: repo })
  });

  assert.equal(blocked.status, 0, blocked.stderr);
  assert.equal(blocked.stdout.trim(), "");
  assert.match(blocked.stderr, /omp task task-live is still running/i);
  assert.match(blocked.stderr, /\/omp:status/i);
  assert.match(blocked.stderr, /\/omp:cancel task-live/i);
});

test("stop hook allows the stop when the review gate is enabled and the stop-time review task is clean", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeOmp(binDir, "adversarial-clean");
  initGitRepo(repo);
  commitFile(repo, "README.md", "hello\n");

  const setup = run("node", [SCRIPT, "setup", "--enable-review-gate", "--json"], { cwd: repo, env: buildEnv(binDir) });
  assert.equal(setup.status, 0, setup.stderr);

  const allowed = run("node", [STOP_HOOK], {
    cwd: repo,
    env: buildEnv(binDir),
    input: JSON.stringify({ cwd: repo, session_id: "sess-stop-clean" })
  });

  assert.equal(allowed.status, 0, allowed.stderr);
  assert.equal(allowed.stdout.trim(), "");
});

test("stop hook does not block when omp is unavailable even if the review gate is enabled", () => {
  const repo = makeTempDir();
  initGitRepo(repo);
  commitFile(repo, "README.md", "hello\n");

  const setup = run(process.execPath, [SCRIPT, "setup", "--enable-review-gate", "--json"], { cwd: repo });
  assert.equal(setup.status, 0, setup.stderr);

  const allowed = run(process.execPath, [STOP_HOOK], {
    cwd: repo,
    env: { ...process.env, PATH: "" },
    input: JSON.stringify({ cwd: repo })
  });

  assert.equal(allowed.status, 0, allowed.stderr);
  assert.equal(allowed.stdout.trim(), "");
  assert.match(allowed.stderr, /omp is not set up for the review gate/i);
  assert.match(allowed.stderr, /Run \/omp:setup/i);
});

test("write task output focuses on the omp result without generic follow-up hints", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeOmp(binDir);
  initGitRepo(repo);
  commitFile(repo, "README.md", "hello\n");

  const result = run("node", [SCRIPT, "task", "--write", "fix the failing test"], { cwd: repo, env: buildEnv(binDir) });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "Handled the requested task.\nTask prompt accepted.\n");
});
