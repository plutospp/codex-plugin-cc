import fs from "node:fs";
import path from "node:path";

import { writeExecutable } from "./helpers.mjs";

/**
 * Installs a fake `omp` binary that speaks the omp `--mode rpc` NDJSON protocol well enough to
 * exercise this plugin's runtime adapter (lib/omp-rpc.mjs + lib/omp.mjs). `behavior` selects which
 * canned auth/review/task responses it returns; state is persisted to `fake-omp-state.json` in
 * `binDir` so tests can assert on what was actually requested (prompt text, model, thinking level,
 * tool allowlist, approval mode, resumed session id).
 */
export function installFakeOmp(binDir, behavior = "default") {
  const statePath = path.join(binDir, "fake-omp-state.json");
  const scriptPath = path.join(binDir, "omp");
  const source = `#!/usr/bin/env node
const fs = require("node:fs");
const readline = require("node:readline");

const STATE_PATH = ${JSON.stringify(statePath)};
const BEHAVIOR = ${JSON.stringify(behavior)};

function loadState() {
  if (!fs.existsSync(STATE_PATH)) {
    return { starts: 0, sessions: {}, nextSessionId: 1 };
  }
  return JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
}

function saveState(state) {
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

function send(message) {
  process.stdout.write(JSON.stringify(message) + "\\n");
}

function parseArgs(argv) {
  const options = { tools: null, approvalMode: null, model: null, thinking: null, resume: null, noSession: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--tools") { options.tools = argv[++i]; }
    else if (arg === "--approval-mode") { options.approvalMode = argv[++i]; }
    else if (arg === "--model") { options.model = argv[++i]; }
    else if (arg === "--thinking") { options.thinking = argv[++i]; }
    else if (arg === "--resume") { options.resume = argv[++i]; }
    else if (arg === "--no-session") { options.noSession = true; }
  }
  return options;
}

function authAvailableModels() {
  switch (BEHAVIOR) {
    case "logged-out":
    case "auth-run-fails":
      return [];
    default:
      return [{ provider: "anthropic", id: "claude-sonnet-test" }];
  }
}

function authLoginProviders() {
  return [{ id: "anthropic", label: "Anthropic" }];
}

function reviewPayload(prompt) {
  const isAdversarial = prompt.includes("adversarial software review");
  const isReviewSchema = prompt.includes('"verdict"');
  if (!isReviewSchema) {
    return null;
  }

  if (BEHAVIOR === "invalid-json" || BEHAVIOR === "invalid-json-persists") {
    return "not valid json";
  }

  if (isAdversarial) {
    if (BEHAVIOR === "adversarial-clean") {
      return JSON.stringify({ verdict: "approve", summary: "No material issues found.", findings: [], next_steps: [] });
    }
    return JSON.stringify({
      verdict: "needs-attention",
      summary: "One adversarial concern surfaced.",
      findings: [
        {
          severity: "high",
          title: "Missing empty-state guard",
          body: "The change assumes data is always present.",
          file: "src/app.js",
          line_start: 4,
          line_end: 6,
          confidence: 0.87,
          recommendation: "Handle empty collections before indexing."
        }
      ],
      next_steps: ["Add an empty-state test."]
    });
  }

  return JSON.stringify({ verdict: "approve", summary: "No material issues found.", findings: [], next_steps: [] });
}

function stopReviewGatePayload(prompt) {
  if (!(prompt.includes("<task>") && prompt.includes("Only review the work from the previous Claude turn."))) {
    return null;
  }
  if (BEHAVIOR === "adversarial-clean") {
    return "ALLOW: No blocking issues found in the previous turn.";
  }
  return "BLOCK: Missing empty-state guard in src/app.js:4-6.";
}

function repairPayload() {
  // A one-shot repair prompt always asks for corrected JSON; the fixture "fixes itself" unless
  // the behavior specifically simulates a repair that also fails.
  if (BEHAVIOR === "invalid-json-persists") {
    return "still not valid json";
  }
  return JSON.stringify({ verdict: "approve", summary: "No material issues found.", findings: [], next_steps: [] });
}

function taskPayload(prompt, isResume) {
  const stopReview = stopReviewGatePayload(prompt);
  if (stopReview !== null) {
    return stopReview;
  }
  if (isResume || prompt.includes("Continue from the current session state") || prompt.includes("follow up")) {
    return "Resumed the prior run.\\nFollow-up prompt accepted.";
  }
  return "Handled the requested task.\\nTask prompt accepted.";
}

const argv = process.argv.slice(2);

if (argv[0] === "--version") {
  console.log("omp-cli test");
  process.exit(0);
}

if (argv[0] !== "--mode" || argv[1] !== "rpc") {
  process.exit(1);
}

const options = parseArgs(argv.slice(2));
const bootState = loadState();
bootState.starts = (bootState.starts || 0) + 1;
let sessionId = options.resume || ("sess_" + bootState.nextSessionId++);
bootState.lastToolsAllowlist = options.tools;
bootState.lastApprovalMode = options.approvalMode;
saveState(bootState);

send({ type: "ready", protocolVersion: 1, supportedProtocolVersions: [1, 2], maxFrameBytes: 1048576, maxReassembledFrameBytes: 67108864 });

let promptCount = 0;
let lastFinalText = "";

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  if (!line.trim()) {
    return;
  }
  const message = JSON.parse(line);
  const id = message.id;

  function respond(data) {
    send({ type: "response", id, command: message.type, success: true, data });
  }
  function fail(error) {
    send({ type: "response", id, command: message.type, success: false, error });
  }

  switch (message.type) {
    case "negotiate_protocol":
      respond({});
      break;

    case "get_available_models":
      respond({ models: authAvailableModels() });
      break;

    case "get_login_providers":
      respond({ providers: authLoginProviders() });
      break;

    case "set_session_name": {
      const state = loadState();
      state.sessions = state.sessions || {};
      state.sessions[sessionId] = { ...(state.sessions[sessionId] || {}), name: message.name };
      saveState(state);
      respond({});
      break;
    }

    case "prompt": {
      if (BEHAVIOR === "auth-run-fails") {
        fail("authentication expired; run omp login");
        break;
      }

      const state = loadState();
      state.lastPrompt = {
        sessionId,
        message: message.message,
        model: options.model,
        thinking: options.thinking,
        tools: options.tools,
        approvalMode: options.approvalMode,
        resumedFrom: options.resume || null
      };
      saveState(state);

      respond({ agentInvoked: true });
      promptCount += 1;

      const isRepairAttempt = promptCount > 1 && message.message.includes("did not match the required JSON schema");
      const review = reviewPayload(message.message);
      const payload = isRepairAttempt
        ? repairPayload()
        : review !== null
          ? review
          : taskPayload(message.message, Boolean(options.resume));
      lastFinalText = payload;

      const emitTurn = () => {
        send({ type: "agent_start" });
        send({ type: "turn_start" });
        if (BEHAVIOR === "with-reasoning") {
          send({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "Inspected the prompt, gathered evidence, and checked the highest-risk paths first." } });
        }
        if (BEHAVIOR === "with-write") {
          send({ type: "tool_execution_start", toolName: "write" });
          send({ type: "tool_execution_end", toolName: "write", status: "completed", arguments: { path: "src/app.js" } });
        }
        send({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: payload } });
        send({ type: "turn_end" });
        send({ type: "agent_end", messages: [] });
      };

      if (BEHAVIOR === "slow-task") {
        setTimeout(emitTurn, 400);
      } else if (BEHAVIOR === "long-task") {
        setTimeout(emitTurn, 5000).unref?.();
      } else {
        emitTurn();
      }
      break;
    }

    case "get_last_assistant_text":
      respond(lastFinalText);
      break;

    case "get_state":
      respond({ sessionId, sessionFile: "/fake/sessions/" + sessionId + ".jsonl" });
      break;

    default:
      fail("Unsupported method: " + message.type);
      break;
  }
});
`;
  writeExecutable(scriptPath, source);

  // On Windows, npm global binaries are invoked via .cmd wrappers.
  // Create an omp.cmd so the fake binary is discoverable by spawn with shell: true.
  if (process.platform === "win32") {
    const cmdWrapper = `@echo off\r\nnode "%~dp0omp" %*\r\n`;
    fs.writeFileSync(path.join(binDir, "omp.cmd"), cmdWrapper, { encoding: "utf8" });
  }
}

export function buildEnv(binDir) {
  const sep = process.platform === "win32" ? ";" : ":";
  return {
    ...process.env,
    PATH: `${binDir}${sep}${process.env.PATH}`
  };
}
