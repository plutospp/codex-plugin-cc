/**
 * @typedef {import("./omp-rpc-protocol").RpcCommand} RpcCommand
 * @typedef {import("./omp-rpc-protocol").RpcResponse} RpcResponse
 * @typedef {import("./omp-rpc-protocol").AgentSessionEvent} AgentSessionEvent
 * @typedef {import("./omp-rpc-protocol").OmpRpcClientOptions} OmpRpcClientOptions
 */
import process from "node:process";
import { spawn } from "node:child_process";
import { terminateProcessTree } from "./process.mjs";

const CLOSE_TIMEOUT_MS = 3000;

function buildSpawnArgs(options = {}) {
  const args = ["--mode", "rpc"];
  if (options.resumeSessionId) {
    args.push("--resume", options.resumeSessionId);
  }
  if (options.noSession) {
    args.push("--no-session");
  }
  if (options.model) {
    args.push("--model", options.model);
  }
  if (options.thinking) {
    args.push("--thinking", options.thinking);
  }
  if (Array.isArray(options.toolsAllowlist) && options.toolsAllowlist.length > 0) {
    args.push("--tools", options.toolsAllowlist.join(","));
  }
  if (options.approvalMode) {
    args.push("--approval-mode", options.approvalMode);
  }
  return args;
}

/**
 * Client for omp's `--mode rpc` newline-delimited JSON protocol.
 * One process per session — there is no shared broker/server to multiplex against.
 */
export class OmpRpcClient {
  constructor(cwd, options = {}) {
    this.cwd = cwd;
    this.options = options;
    this.pending = new Map();
    this.nextId = 1;
    this.stderr = "";
    this.closed = false;
    this.lineBuffer = "";
    this.protocolVersion = 1;
    /** @type {Map<string, Set<Function>>} */
    this.listeners = new Map();
    /** @type {Map<string, {index:number, count:number, byteLength:number, parts:string[]}>} */
    this.chunkBuffers = new Map();

    this.exitPromise = new Promise((resolve) => {
      this.resolveExit = resolve;
    });
  }

  /** @param {string} cwd @param {OmpRpcClientOptions} [options] @returns {Promise<OmpRpcClient>} */
  static async connect(cwd, options = {}) {
    const client = new OmpRpcClient(cwd, options);
    await client.initialize();
    return client;
  }

  async initialize() {
    const args = buildSpawnArgs(this.options);
    this.proc = spawn("omp", args, {
      cwd: this.cwd,
      env: this.options.env ?? process.env,
      stdio: ["pipe", "pipe", "pipe"],
      shell: process.platform === "win32" ? (process.env.SHELL || true) : false,
      windowsHide: true
    });

    this.proc.stdout.setEncoding("utf8");
    this.proc.stderr.setEncoding("utf8");

    this.proc.stderr.on("data", (chunk) => {
      this.stderr += chunk;
    });

    this.proc.on("error", (error) => {
      this.handleExit(error);
    });

    this.proc.on("exit", (code, signal) => {
      const stderr = this.stderr.trim();
      const detail =
        code === 0 || code === null
          ? null
          : new Error(`omp exited unexpectedly (${signal ? `signal ${signal}` : `exit ${code}`}).${stderr ? `\n${stderr}` : ""}`);
      this.handleExit(detail);
      this.resolveExit(undefined);
    });

    this.proc.stdout.on("data", (chunk) => {
      this.handleChunk(chunk);
    });

    const ready = await this.waitForReady();
    if (Array.isArray(ready?.supportedProtocolVersions) && ready.supportedProtocolVersions.includes(2)) {
      try {
        await this.request({ type: "negotiate_protocol", protocolVersion: 2 });
        this.protocolVersion = 2;
      } catch {
        // Stay on protocol v1 if negotiation is rejected — not fatal.
      }
    }
  }

  waitForReady() {
    return new Promise((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
    });
  }

  /** @param {RpcCommand} command @returns {Promise<unknown>} */
  request(command) {
    if (this.closed) {
      return Promise.reject(new Error("omp RPC client is closed."));
    }

    const id = `req_${this.nextId}`;
    this.nextId += 1;

    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.sendMessage({ ...command, id });
    });
  }

  /** @param {string} eventType @param {Function} handler */
  on(eventType, handler) {
    if (!this.listeners.has(eventType)) {
      this.listeners.set(eventType, new Set());
    }
    this.listeners.get(eventType).add(handler);
  }

  /** @param {string} eventType @param {Function} handler */
  off(eventType, handler) {
    this.listeners.get(eventType)?.delete(handler);
  }

  emit(eventType, frame) {
    for (const handler of this.listeners.get(eventType) ?? []) {
      handler(frame);
    }
  }

  sendMessage(message) {
    const line = `${JSON.stringify(message)}\n`;
    const stdin = this.proc?.stdin;
    if (!stdin || stdin.destroyed) {
      throw new Error("omp RPC client stdin is not available.");
    }
    stdin.write(line);
  }

  handleChunk(chunk) {
    this.lineBuffer += chunk;
    let newlineIndex = this.lineBuffer.indexOf("\n");
    while (newlineIndex !== -1) {
      const line = this.lineBuffer.slice(0, newlineIndex);
      this.lineBuffer = this.lineBuffer.slice(newlineIndex + 1);
      this.handleLine(line);
      newlineIndex = this.lineBuffer.indexOf("\n");
    }
  }

  handleLine(line) {
    if (!line.trim()) {
      return;
    }

    let frame;
    try {
      frame = JSON.parse(line);
    } catch (error) {
      this.handleExit(new Error(`Failed to parse omp RPC frame: ${error.message}`));
      return;
    }

    this.handleFrame(frame);
  }

  handleFrame(frame) {
    if (frame.type === "rpc_chunk") {
      this.handleRpcChunk(frame);
      return;
    }

    if (frame.type === "ready") {
      this.readyResolve?.(frame);
      this.readyResolve = null;
      return;
    }

    if (frame.type === "response") {
      const pending = frame.id ? this.pending.get(frame.id) : undefined;
      if (!pending) {
        return;
      }
      this.pending.delete(frame.id);
      if (frame.success) {
        pending.resolve(frame.data);
      } else {
        pending.reject(new Error(frame.error ?? `omp RPC command ${frame.command} failed.`));
      }
      return;
    }

    // Every other frame type is an event: agent_start, turn_start, tool_execution_*,
    // message_update, agent_end, extension_error, command_output, prompt_result, etc.
    if (typeof frame.type === "string") {
      this.emit(frame.type, frame);
    }
  }

  handleRpcChunk(frame) {
    const { chunkId, index, count, byteLength, data } = frame;
    if (typeof chunkId !== "string" || !Number.isInteger(index) || !Number.isInteger(count) || !Number.isInteger(byteLength)) {
      throw new Error("Malformed rpc_chunk frame: missing chunkId/index/count/byteLength.");
    }

    let buffer = this.chunkBuffers.get(chunkId);
    if (!buffer) {
      if (index !== 0) {
        // A sequence that doesn't start at index 0 is interrupted/out-of-order — reject it.
        throw new Error(`rpc_chunk sequence ${chunkId} started at index ${index}, expected 0.`);
      }
      buffer = { index: 0, count, byteLength, parts: [] };
      this.chunkBuffers.set(chunkId, buffer);
    }

    if (index !== buffer.index || count !== buffer.count || byteLength !== buffer.byteLength) {
      this.chunkBuffers.delete(chunkId);
      throw new Error(`rpc_chunk sequence ${chunkId} is interleaved or interrupted.`);
    }

    buffer.parts.push(data);
    buffer.index += 1;

    if (buffer.index < buffer.count) {
      return;
    }

    this.chunkBuffers.delete(chunkId);
    const decoded = Buffer.from(buffer.parts.join(""), "base64").toString("utf8");
    if (Buffer.byteLength(decoded, "utf8") !== byteLength) {
      throw new Error(`rpc_chunk sequence ${chunkId} decoded to an unexpected byte length.`);
    }

    let reassembled;
    try {
      reassembled = JSON.parse(decoded);
    } catch (error) {
      throw new Error(`Failed to parse reassembled rpc_chunk sequence ${chunkId}: ${error.message}`);
    }
    this.handleFrame(reassembled);
  }

  handleExit(error) {
    if (this.exitError !== undefined) {
      return;
    }
    this.exitError = error ?? null;

    if (this.readyReject && error) {
      this.readyReject(error);
      this.readyReject = null;
      this.readyResolve = null;
    }

    for (const pending of this.pending.values()) {
      pending.reject(error ?? new Error("omp RPC connection closed."));
    }
    this.pending.clear();
  }

  async close() {
    if (this.closed) {
      await this.exitPromise;
      return;
    }
    this.closed = true;

    const stdin = this.proc?.stdin;
    if (stdin && !stdin.destroyed) {
      try {
        stdin.end();
      } catch {
        // Best-effort — the process may already be gone.
      }
    }

    const timeout = new Promise((resolve) => {
      setTimeout(resolve, CLOSE_TIMEOUT_MS).unref?.();
    });

    await Promise.race([this.exitPromise, timeout]);

    if (this.proc && this.proc.exitCode === null && this.proc.signalCode === null) {
      try {
        if (process.platform === "win32") {
          terminateProcessTree(this.proc.pid);
        } else {
          this.proc.kill("SIGTERM");
        }
      } catch {
        // Best-effort cleanup — never throw from close().
      }
    }
  }
}
