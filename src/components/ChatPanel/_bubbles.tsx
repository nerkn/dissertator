import { memo } from "react";
import { Bug, CaretDown, Warning } from "@phosphor-icons/react";
import type { ChatMessage } from "@dissertator/shared";
import type { DebugEvent } from "../../lib/api";
import { Markdown } from "./Markdown";

/** Wrap streamed text so partial markdown (an unclosed `**` or ``` fence)
 *  renders gracefully instead of flashing raw syntax — the parser treats
 *  unclosed markers as literal text. */
function StreamBody({ text }: { text: string }) {
  if (!text) return <>…</>;
  return <Markdown text={text} />;
}

/** One narration beat: a tool_call awaiting/with its tool_result. */
interface ToolBeat {
  id: string;
  name: string;
  args: unknown;
  ok?: boolean;
  summary?: string;
  error?: string;
}

export function toolVerb(name: string): string {
  switch (name) {
    case "list":
      return "searching corpus";
    case "read":
      return "reading";
    case "create":
      return "creating";
    case "edit":
      return "editing";
    case "show":
      return "opening";
    case "suggest":
      return "suggesting replies";
    case "toast":
      return "notifying";
    case "pref_add":
      return "remembering preference";
    default:
      return name;
  }
}

/** The in-flight assistant bubble: tool narration beats above the streamed text. */
export function LiveAssistantBubble({
  text,
  beats,
}: {
  text: string;
  beats: ToolBeat[];
}) {
  return (
    <div className="msg msg-assistant live">
      <div className="msg-role">Agent</div>
      {beats.length > 0 && (
        <div className="tool-beats">
          {beats.map((b) => (
            <div
              key={b.id}
              className={`tool-beat${
                b.ok === undefined
                  ? ""
                  : b.ok
                    ? " ok"
                    : " err"
              }`}
            >
              <span className="tool-beat-verb">{toolVerb(b.name)}</span>
              {b.ok === false && b.error ? (
                <span className="tool-beat-detail">— {b.error}</span>
              ) : b.summary ? (
                <span className="tool-beat-detail">— {b.summary}</span>
              ) : (
                <span className="tool-beat-detail muted">…</span>
              )}
            </div>
          ))}
        </div>
      )}
      <div className="msg-body">
        <StreamBody text={text} />
      </div>
    </div>
  );
}

export const MessageBubble = memo(function MessageBubble({
  msg,
  live = false,
  errorText,
}: {
  msg: ChatMessage;
  live?: boolean;
  errorText?: string;
}) {
  const isUser = msg.role === "user";
  return (
    <div className={`msg ${isUser ? "msg-user" : "msg-assistant"}${live ? " live" : ""}`}>
      <div className="msg-role">{isUser ? "You" : "Agent"}</div>
      {/* Persisted tool-call narration (assistant turns). Mirrors the live
          beats so a reloaded transcript still shows what the agent did. */}
      {!isUser && msg.toolCalls && msg.toolCalls.length > 0 && (
        <div className="tool-beats">
          {msg.toolCalls.map((b, i) => (
            <div
              key={i}
              className={`tool-beat${
                b.ok === undefined ? "" : b.ok ? " ok" : " err"
              }`}
            >
              <span className="tool-beat-verb">{toolVerb(b.name)}</span>
              {b.ok === false && b.error ? (
                <span className="tool-beat-detail">— {b.error}</span>
              ) : b.summary ? (
                <span className="tool-beat-detail">— {b.summary}</span>
              ) : (
                <span className="tool-beat-detail muted">…</span>
              )}
            </div>
          ))}
        </div>
      )}
      <div className="msg-body">
        {isUser ? (
          msg.content || (live ? "…" : "")
        ) : msg.content ? (
          <Markdown text={msg.content} />
        ) : (
          (live ? "…" : "")
        )}
      </div>
      {!isUser && errorText && (
        <div className="msg-error">
          <Warning size={14} weight="bold" /> {errorText}
        </div>
      )}
    </div>
  );
});

/**
 * Per-step LLM payload panel (model config, advertised tools, full message
 * array). Collapsed by default; the header carries a live step counter.
 * Toggled via Settings → Agent → “Show LLM debug panel”.
 */
export function DevDebugPanel({
  events,
  open,
  onToggle,
  streaming,
}: {
  events: DebugEvent[];
  open: boolean;
  onToggle: () => void;
  streaming: boolean;
}) {
  const last = events[events.length - 1];
  return (
    <div className={`dev-debug${open ? " open" : ""}`}>
      <button
        type="button"
        className="dev-debug-head"
        onClick={onToggle}
        aria-expanded={open}
      >
        <Bug size={12} weight="bold" />
        <span>LLM debug</span>
        <span className="dev-debug-steps">
          {events.length} step{events.length === 1 ? "" : "s"}
          {streaming ? "…" : ""}
        </span>
        {last && (
          <span className="dev-debug-model" title={last.config.apiUrl}>
            {last.config.model}
          </span>
        )}
        <CaretDown size={12} weight="bold" className="dev-debug-caret" />
      </button>
      {open && (
        <div className="dev-debug-body">
          {events.map((e) => (
            <details key={e.step} className="dev-debug-step">
              <summary>
                step {e.step} · {e.config.model} · {e.tools.length} tools ·{" "}
                {e.messages.length} msgs
                <span className="muted">
                  {" "}
                  [{e.messages.map((m) => String(m.role)).join(" →")}]
                </span>
              </summary>
              <pre className="dev-debug-pre">{JSON.stringify(e, null, 2)}</pre>
            </details>
          ))}
        </div>
      )}
    </div>
  );
}

export type { ToolBeat };
