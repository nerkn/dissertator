// P5 agent-loop SSE event payloads (see sidecar agent/loop.ts + index.ts).

/** `tool_call` event: the model invoked a tool. */
export interface ToolCallEvent {
  id: string;
  name: string;
  args: unknown;
}

/** `tool_result` event: the tool's outcome (paired with a `tool_call` by id). */
export interface ToolResultEvent {
  id: string;
  name: string;
  ok: boolean;
  summary: string;
  error?: string;
}

/** `edit` event: the agent mutated a document; live-reload the editor. */
export interface EditEvent {
  documentId: string;
  title: string;
  bodyMd: string;
}

/** `debug` event (dev): the exact payload sent to the LLM for one agent step.
 *  `messages` mirrors the OpenAI shape (role/content; assistant turns may
 *  carry `tool_calls`; `tool`-role results carry `tool_call_id`). */
export interface DebugEvent {
  step: number;
  config: { provider: string; apiUrl: string; model: string };
  toolChoice?: string;
  tools: string[];
  messages: Array<Record<string, unknown>>;
}
