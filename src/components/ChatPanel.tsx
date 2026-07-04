interface Props {
  health: "checking" | "up" | "down";
  configured: boolean;
}

export function ChatPanel({ health, configured }: Props) {
  return (
    <aside className="panel chat">
      <div className="panel-title">💬 Chat</div>

      {health !== "up" && (
        <div className="warn">
          Sidecar not running. Start it with <code>pnpm dev:sidecar</code>.
        </div>
      )}
      {health === "up" && !configured && (
        <div className="warn">
          Open ⚙ Settings to configure a provider and API key.
        </div>
      )}

      <div className="placeholder small">
        <p className="muted">
          Ask grounded questions about your corpus; the agent retrieves, cites,
          and edits your documents.
        </p>
        <p className="muted small">Agent chat arrives in P5.</p>
      </div>

      <div className="open-files muted small">
        Chatting about: <em>(no files open)</em>
      </div>
    </aside>
  );
}
