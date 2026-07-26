// Hand-written type surface for the subset of omp's `--mode rpc` protocol this
// plugin actually uses. See `omp://rpc.md` in the omp harness docs for the full
// canonical protocol; this file only covers the frames omp.mjs/omp-rpc.mjs send
// and receive.

export interface ReadyFrame {
  type: "ready";
  protocolVersion: number;
  supportedProtocolVersions: number[];
  maxFrameBytes: number;
  maxReassembledFrameBytes: number;
}

export interface RpcChunkFrame {
  type: "rpc_chunk";
  chunkId: string;
  index: number;
  count: number;
  byteLength: number;
  data: string;
}

export type RpcCommand =
  | { type: "negotiate_protocol"; protocolVersion: 2 }
  | { type: "prompt"; message: string; streamingBehavior?: "steer" | "followUp" }
  | { type: "get_state" }
  | { type: "get_last_assistant_text" }
  | { type: "get_available_models" }
  | { type: "get_login_providers" }
  | { type: "set_session_name"; name: string };

export interface RpcResponse {
  type: "response";
  id?: string;
  command: string;
  success: boolean;
  data?: unknown;
  error?: string;
}

export interface AgentSessionState {
  model?: { provider: string; id: string };
  thinkingLevel?: string;
  isStreaming?: boolean;
  sessionFile?: string;
  sessionId?: string;
  sessionName?: string;
  messageCount?: number;
}

export interface AssistantMessageEvent {
  type: "text_delta" | "thinking_delta" | "toolcall_delta" | string;
  delta?: string;
}

export interface MessageUpdateEvent {
  type: "message_update";
  assistantMessageEvent: AssistantMessageEvent;
  message?: { role: string; content: unknown[] };
}

export interface ToolExecutionEvent {
  type: "tool_execution_start" | "tool_execution_update" | "tool_execution_end";
  toolName?: string;
  toolCallId?: string;
  arguments?: Record<string, unknown>;
  status?: string;
}

export interface AssistantContentBlock {
  type: "thinking" | "text" | "toolCall";
  // toolCall-specific fields (present when type === "toolCall")
  id?: string;
  name?: string;
  arguments?: Record<string, unknown>;
  intent?: string;
  // text/thinking-specific fields
  text?: string;
  thinking?: string;
}

export interface AssistantMessage {
  role: string;
  content: AssistantContentBlock[];
}

export interface AgentLifecycleEvent {
  type: "agent_start" | "agent_end" | "turn_start" | "turn_end";
  // Confirmed live: `agent_end` carries the full conversation as `messages` (plural); `turn_end`
  // carries only the message that just completed as `message` (singular), and that message's
  // `content` array is where built-in tool calls (e.g. `write`/`edit`) actually surface — there is
  // no separate per-tool-call event for them.
  messages?: unknown[];
  message?: AssistantMessage;
}

export interface ExtensionErrorEvent {
  type: "extension_error";
  extensionPath: string;
  event: string;
  error: string;
}

export type AgentSessionEvent = MessageUpdateEvent | ToolExecutionEvent | AgentLifecycleEvent | ExtensionErrorEvent;

export interface OmpRpcClientOptions {
  env?: NodeJS.ProcessEnv;
  resumeSessionId?: string | null;
  noSession?: boolean;
  model?: string | null;
  thinking?: string | null;
  toolsAllowlist?: string[] | null;
  approvalMode?: string | null;
}

export interface AvailableModel {
  provider: string;
  id: string;
}

export interface LoginProvider {
  id: string;
  label?: string;
}
