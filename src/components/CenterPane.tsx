import { Sparkle } from "@phosphor-icons/react";

export function CenterPane({ initialized }: { initialized: boolean }) {
  return (
    <section className="panel center">
      {initialized ? (
        <div className="placeholder">
          <h2>No document open</h2>
          <p className="muted">
            Run the wizard to start a new paper or dissertation, grounded in your
            corpus.
          </p>
          <button className="btn primary" disabled title="Arrives in P4">
            <Sparkle size={16} weight="fill" />
            Start Wizard
          </button>
          <div className="muted small">Editor + PDF viewer arrive in P3.</div>
        </div>
      ) : (
        <div className="placeholder">
          <h1 className="hero">📚 Dissertator</h1>
          <p className="muted">
            Open a research folder to turn 100 documents into a grounded
            dissertation.
          </p>
        </div>
      )}
    </section>
  );
}
