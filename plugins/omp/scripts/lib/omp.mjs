/**
 * @typedef {import("./omp-rpc-protocol").AgentSessionEvent} AgentSessionEvent
 */
import { readJsonFile } from "./fs.mjs";
import { OmpRpcClient } from "./omp-rpc.mjs";
import { binaryAvailable } from "./process.mjs";

const UNAVAILABLE_MESSAGE =
  "omp CLI is not installed or is not on PATH. Install it with `npm install -g @oh-my-pi/pi-coding-agent`, then rerun `/omp:setup`.";
const READ_ONLY_TOOLS = ["read", "grep", "glob", "lsp", "web_search"];
// Bounds how long a single turn waits for `agent_end` after `prompt` acks success. The RPC docs
// note `prompt` can be acked, then later fail asynchronously with a same-id error response — our
// transport's request/response correlation only tracks ONE response per id, so a late async
// failure on the `prompt` id itself would otherwise never surface. This timeout is the safety net:
// if no terminal event arrives in time, we fail the turn with whatever stderr is available instead
// of hanging forever.
const TURN_TIMEOUT_MS = 30 * 60 * 1000;

function emitProgress(onProgress, message, phase = null, extra = {}) {
  if (!onProgress || !message) {
    return;
  }
  if (!phase && Object.keys(extra).length === 0) {
    onProgress(message);
    return;
  }
  onProgress({ message, phase, ...extra });
}

function buildToolsAllowlist(write) {
  return write ? null : READ_ONLY_TOOLS;
}

export function getOmpAvailability(cwd) {
  return binaryAvailable("omp", ["--version"], { cwd });
}

export async function getOmpAuthStatus(cwd, options = {}) {
  const availability = getOmpAvailability(cwd);
  if (!availability.available) {
    return {
      available: false,
      loggedIn: false,
      detail: availability.detail,
      source: "availability",
      provider: null
    };
  }

  let client = null;
  try {
    client = await OmpRpcClient.connect(cwd, { env: options.env, noSession: true });
    const modelsResult = /** @type {{models?: import("./omp-rpc-protocol").AvailableModel[]} | import("./omp-rpc-protocol").AvailableModel[]} */ (
      await client.request({ type: "get_available_models" })
    );
    const models = Array.isArray(modelsResult) ? modelsResult : Array.isArray(modelsResult?.models) ? modelsResult.models : [];

    if (models.length > 0) {
      const first = models[0];
      return {
        available: true,
        loggedIn: true,
        detail: `${models.length} model(s) available (e.g. ${first?.provider ?? "?"}/${first?.id ?? "?"}).`,
        source: "omp-rpc",
        provider: first?.provider ?? null
      };
    }

    let detail = "No authenticated models found. Run `omp` interactively once to sign in to a provider.";
    try {
      const providersResult = /** @type {{providers?: import("./omp-rpc-protocol").LoginProvider[]} | import("./omp-rpc-protocol").LoginProvider[]} */ (
        await client.request({ type: "get_login_providers" })
      );
      const providers = Array.isArray(providersResult)
        ? providersResult
        : Array.isArray(providersResult?.providers)
          ? providersResult.providers
          : [];
      if (providers.length > 0) {
        const labels = providers.map((provider) => provider?.label ?? provider?.id ?? String(provider)).join(", ");
        detail = `No authenticated models found. Available login providers: ${labels}.`;
      }
    } catch {
      // Best-effort — keep the generic detail message.
    }

    return { available: true, loggedIn: false, detail, source: "omp-rpc", provider: null };
  } catch (error) {
    return {
      available: true,
      loggedIn: false,
      detail: error instanceof Error ? error.message : String(error),
      source: "omp-rpc",
      provider: null
    };
  } finally {
    if (client) {
      await client.close().catch(() => {});
    }
  }
}

/**
 * Sends one prompt on an already-connected client and waits for it to finish (either a real
 * agent turn via `agent_end`, or a local-only command signalled by `agentInvoked:false`).
 * Bounded by TURN_TIMEOUT_MS so an async post-ack failure (see the `prompt` docs: an accepted
 * command can still emit a later same-id error) can't hang the caller forever.
 */
async function sendPromptAndWait(client, message) {
  let agentEndListener;
  const agentEnd = new Promise((resolve) => {
    agentEndListener = (frame) => resolve(frame);
    client.on("agent_end", agentEndListener);
  });
  const timeout = new Promise((resolve) => {
    setTimeout(() => resolve(null), TURN_TIMEOUT_MS).unref?.();
  });

  try {
    const response = await client.request({ type: "prompt", message });
    if (response?.agentInvoked !== false) {
      const outcome = await Promise.race([agentEnd, timeout]);
      if (outcome === null) {
        throw new Error(`omp turn timed out after ${Math.round(TURN_TIMEOUT_MS / 60000)} minutes with no agent_end event.`);
      }
    }
  } finally {
    client.off("agent_end", agentEndListener);
  }
}

async function fetchFinalMessage(client) {
  try {
    const textResult = await client.request({ type: "get_last_assistant_text" });
    return typeof textResult === "string" ? textResult : (textResult?.text ?? "");
  } catch {
    return "";
  }
}

/**
 * Runs one prompt turn against omp and captures its result.
 * One omp process = one session; there is no thread multiplexing to track, unlike the old
 * Codex app-server integration this replaces.
 */
export async function runOmpTurn(cwd, options = {}) {
  const availability = getOmpAvailability(cwd);
  if (!availability.available) {
    throw new Error(UNAVAILABLE_MESSAGE);
  }

  const prompt = options.prompt?.trim() || options.defaultPrompt || "";
  if (!prompt) {
    throw new Error("A prompt is required for this omp run.");
  }

  const write = Boolean(options.write);
  const resumeSessionId = options.resumeSessionId ?? null;
  const client = await OmpRpcClient.connect(cwd, {
    env: options.env,
    resumeSessionId,
    noSession: Boolean(options.ephemeral) && !resumeSessionId,
    model: options.model ?? null,
    thinking: options.thinking ?? null,
    toolsAllowlist: buildToolsAllowlist(write),
    approvalMode: write ? "yolo" : null
  });

  const reasoningSummary = [];
  let currentThinking = "";
  const touchedFiles = new Set();
  let observedError = null;

  const onTurnStart = () => emitProgress(options.onProgress, "Turn started.", "starting");
  const onToolExecutionStart = (frame) => {
    emitProgress(options.onProgress, `Running tool: ${frame.toolName ?? "tool"}.`, "running");
  };
  const onToolExecutionEnd = (frame) => {
    emitProgress(options.onProgress, `Tool ${frame.toolName ?? "tool"} ${frame.status ?? "finished"}.`, "running");
    recordToolCall(frame.toolName, frame.arguments);
  };
  const onMessageUpdate = (frame) => {
    const delta = frame?.assistantMessageEvent;
    if (delta?.type === "thinking_delta" && delta.delta) {
      currentThinking += delta.delta;
    }
  };
  // Confirmed against a live omp session: built-in tool calls (e.g. `write`/`edit`) are NOT
  // surfaced via separate tool_execution_* frames — they arrive as `{type:"toolCall", name,
  // arguments}` content blocks inside the finished message on `turn_end`. tool_execution_* frames
  // are kept above as a secondary path (the protocol docs list them, and other tool categories or
  // omp versions may still use them), but `turn_end` is the verified primary source.
  const onTurnEnd = (frame) => {
    const content = frame?.message?.content;
    if (!Array.isArray(content)) {
      return;
    }
    for (const block of content) {
      if (block?.type === "toolCall") {
        recordToolCall(block.name, block.arguments);
      }
    }
  };
  const onExtensionError = (frame) => {
    observedError = frame.error ?? "omp extension error";
  };

  function recordToolCall(name, args) {
    if (name !== "write" && name !== "edit") {
      return;
    }
    const filePath = args?.path ?? args?.file ?? null;
    if (typeof filePath === "string" && filePath) {
      touchedFiles.add(filePath);
    }
  }

  client.on("turn_start", onTurnStart);
  client.on("turn_end", onTurnEnd);
  client.on("tool_execution_start", onToolExecutionStart);
  client.on("tool_execution_end", onToolExecutionEnd);
  client.on("message_update", onMessageUpdate);
  client.on("extension_error", onExtensionError);

  try {
    if (options.sessionName && !resumeSessionId) {
      try {
        await client.request({ type: "set_session_name", name: options.sessionName });
      } catch {
        // Best-effort — an unnamed session is still fully usable.
      }
    }

    emitProgress(options.onProgress, "Sending prompt to omp.", "starting");
    await sendPromptAndWait(client, prompt);

    if (currentThinking.trim()) {
      reasoningSummary.push(currentThinking.trim());
      currentThinking = "";
    }
    emitProgress(options.onProgress, "Turn completed.", "finalizing");

    let finalMessage = await fetchFinalMessage(client);

    // Optional one-shot repair: `buildRepairPrompt(finalMessage)` returns a follow-up prompt to
    // send on this SAME still-open session (or a falsy value to skip). This exists instead of
    // "close, then resume" because ephemeral (`--no-session`) runs have no on-disk session to
    // resume once the process exits.
    if (typeof options.buildRepairPrompt === "function" && !observedError) {
      const repairPrompt = options.buildRepairPrompt(finalMessage);
      if (repairPrompt) {
        emitProgress(options.onProgress, "Requesting corrected output.", "finalizing");
        await sendPromptAndWait(client, repairPrompt);
        if (currentThinking.trim()) {
          reasoningSummary.push(currentThinking.trim());
        }
        finalMessage = await fetchFinalMessage(client);
      }
    }

    let sessionId = null;
    let sessionFile = null;
    try {
      const state = /** @type {import("./omp-rpc-protocol").AgentSessionState} */ (await client.request({ type: "get_state" }));
      sessionId = state?.sessionId ?? null;
      sessionFile = state?.sessionFile ?? null;
    } catch {
      // Best-effort.
    }

    return {
      status: observedError ? 1 : 0,
      finalMessage,
      sessionId,
      sessionFile,
      reasoningSummary,
      touchedFiles: [...touchedFiles],
      stderr: client.stderr.trim(),
      error: observedError ? { message: observedError } : null
    };
  } finally {
    client.off("turn_start", onTurnStart);
    client.off("turn_end", onTurnEnd);
    client.off("tool_execution_start", onToolExecutionStart);
    client.off("tool_execution_end", onToolExecutionEnd);
    client.off("message_update", onMessageUpdate);
    client.off("extension_error", onExtensionError);
    await client.close();
  }
}

export function parseStructuredOutput(rawOutput, fallback = {}) {
  if (!rawOutput) {
    return {
      parsed: null,
      parseError: fallback.failureMessage ?? "omp did not return a final structured message.",
      rawOutput: rawOutput ?? "",
      ...fallback
    };
  }

  try {
    return {
      parsed: JSON.parse(rawOutput),
      parseError: null,
      rawOutput,
      ...fallback
    };
  } catch (error) {
    return {
      parsed: null,
      parseError: error.message,
      rawOutput,
      ...fallback
    };
  }
}

export function readOutputSchema(schemaPath) {
  return readJsonFile(schemaPath);
}
