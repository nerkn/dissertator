import { useEffect, useRef, useState } from "react";
import { CheckCircle, FloppyDisk, Sparkle, Warning } from "@phosphor-icons/react";
import { api } from "../../lib/api";
import type {
  AgentPersona,
  ConsolidationResult,
  PrefIssue,
} from "../../lib/api/agent";

interface Props {
  apiKey: string;
}

function AgentTab({ apiKey }: Props) {
  const [persona, setPersona] = useState<AgentPersona>({
    personality: "",
    rules: "",
  });
  const [prefs, setPrefs] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const lastSavedRef = useRef<string>("");

  const [review, setReview] = useState<ConsolidationResult | null>(null);
  const [proposal, setProposal] = useState("");
  const [consolidating, setConsolidating] = useState(false);
  const [consolidateMsg, setConsolidateMsg] = useState<string | null>(null);
  const [savingPrefs, setSavingPrefs] = useState(false);
  const [prefsSavedAt, setPrefsSavedAt] = useState<number | null>(null);
  const prefsLastSavedRef = useRef<string>("");

  useEffect(() => {
    let stopped = false;
    (async () => {
      try {
        const [p, pr] = await Promise.all([
          api.getAgentPersona(),
          api.getPreferences(),
        ]);
        if (stopped) return;
        setPersona(p);
        lastSavedRef.current = JSON.stringify(p);
        setPrefs(pr.contents);
        prefsLastSavedRef.current = pr.contents;
      } catch {
        /* ignore */
      } finally {
        if (!stopped) setLoading(false);
      }
    })();
    return () => {
      stopped = true;
    };
  }, []);

  const runConsolidate = async () => {
    if (!apiKey) {
      setConsolidateMsg("Bind a chat provider in Functions first.");
      return;
    }
    setConsolidating(true);
    setConsolidateMsg(null);
    try {
      const res = await api.consolidatePreferences(apiKey);
      if (res.changed && res.proposal != null) {
        setReview(res);
        setProposal(res.proposal);
        setConsolidateMsg(null);
      } else {
        setReview(null);
        setConsolidateMsg(
          res.error
            ? `Consolidation skipped: ${res.error}`
            : "Preferences already consolidated — nothing new to review.",
        );
      }
    } catch (e) {
      setConsolidateMsg((e as Error)?.message ?? String(e));
    } finally {
      setConsolidating(false);
    }
  };

  useEffect(() => {
    if (!apiKey) return;
    let stopped = false;
    (async () => {
      await runConsolidate();
      if (stopped) return;
    })();
    return () => {
      stopped = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiKey]);

  const personaDirty = JSON.stringify(persona) !== lastSavedRef.current;
  const prefsDirty = prefs !== prefsLastSavedRef.current;

  const savePersona = async () => {
    setSaving(true);
    try {
      const next = await api.saveAgentPersona(persona);
      setPersona(next);
      lastSavedRef.current = JSON.stringify(next);
      setSavedAt(Date.now());
    } finally {
      setSaving(false);
    }
  };

  const savePrefs = async () => {
    setSavingPrefs(true);
    try {
      await api.savePreferences(prefs);
      prefsLastSavedRef.current = prefs;
      setPrefsSavedAt(Date.now());
    } finally {
      setSavingPrefs(false);
    }
  };

  const acceptReview = async () => {
    setSavingPrefs(true);
    try {
      await api.savePreferences(proposal);
      setPrefs(proposal);
      prefsLastSavedRef.current = proposal;
      setReview(null);
      setProposal("");
      setConsolidateMsg("Preferences updated.");
      setPrefsSavedAt(Date.now());
    } finally {
      setSavingPrefs(false);
    }
  };

  const dismissReview = async () => {
    if (!review?.rawHash) {
      setReview(null);
      return;
    }
    try {
      await api.dismissPreferences(review.rawHash);
      setReview(null);
      setProposal("");
      setConsolidateMsg("Dismissed — won't re-prompt until preferences change.");
    } catch {
      setReview(null);
    }
  };

  if (loading) return <div className="muted">Loading agent settings…</div>;

  return (
    <div className="agent-tab">
      <div className="muted small helper">
        Personality + rules shape every chat. Preferences are durable notes the
        assistant records with <code>pref_add</code> and the chat reads each
        turn. Stored in <code>Dissertator/agent/</code>.
      </div>

      <div className="agent-field">
        <label className="agent-label" htmlFor="agent-personality">
          Personality
        </label>
        <textarea
          id="agent-personality"
          className="agent-textarea"
          value={persona.personality}
          onChange={(e) =>
            setPersona((p) => ({ ...p, personality: e.target.value }))
          }
          placeholder="Tone, voice, how the assistant addresses you…"
          rows={4}
          spellCheck={false}
        />
      </div>

      <div className="agent-field">
        <label className="agent-label" htmlFor="agent-rules">
          Rules
        </label>
        <textarea
          id="agent-rules"
          className="agent-textarea agent-textarea-tall"
          value={persona.rules}
          onChange={(e) => setPersona((p) => ({ ...p, rules: e.target.value }))}
          placeholder="Hard constraints: accuracy, citation style, what to avoid…"
          rows={16}
          spellCheck={false}
        />
      </div>

      <div className="prompts-foot">
        {savedAt && !personaDirty && <span className="muted small">Saved.</span>}
        <button
          className="btn small primary"
          onClick={savePersona}
          disabled={saving || !personaDirty}
          title="Save personality + rules"
        >
          <FloppyDisk size={14} weight="bold" />
          {saving ? "saving…" : "Save"}
        </button>
      </div>

      <div className="agent-divider" />

      <div className="agent-field">
        <div className="pref-head">
          <label className="agent-label" htmlFor="agent-prefs">
            Preferences
          </label>
          <button
            className="btn small ghost"
            onClick={runConsolidate}
            disabled={consolidating || !apiKey}
            title={
              apiKey
                ? "Ask the model to merge duplicates and flag contradictions"
                : "Bind a chat provider first"
            }
          >
            <Sparkle size={14} weight="bold" />
            {consolidating ? "consolidating…" : "Consolidate"}
          </button>
        </div>
        <textarea
          id="agent-prefs"
          className="agent-textarea"
          value={prefs}
          onChange={(e) => setPrefs(e.target.value)}
          placeholder={
            "- One bullet per durable preference the assistant should remember…\n- The model appends here via pref_add; edit freely."
          }
          rows={6}
          spellCheck={false}
        />
        <div className="prompts-foot">
          {prefsSavedAt && !prefsDirty && (
            <span className="muted small">Saved.</span>
          )}
          <button
            className="btn small primary"
            onClick={savePrefs}
            disabled={savingPrefs || !prefsDirty}
            title="Save preferences"
          >
            <FloppyDisk size={14} weight="bold" />
            {savingPrefs ? "saving…" : "Save"}
          </button>
        </div>
        {consolidateMsg && !review && (
          <div className="muted small">{consolidateMsg}</div>
        )}
      </div>

      {review && review.proposal != null && (
        <div className="pref-review">
          <div className="pref-review-head">
            <Sparkle size={15} weight="bold" />
            <span>Proposed consolidated preferences</span>
          </div>
          <textarea
            className="agent-textarea"
            value={proposal}
            onChange={(e) => setProposal(e.target.value)}
            rows={Math.min(16, Math.max(6, proposal.split("\n").length + 1))}
            spellCheck={false}
          />
          {review.issues && review.issues.length > 0 && (
            <div className="pref-issues">
              <div className="pref-issues-head">
                <Warning size={14} weight="bold" />
                <span>
                  {review.issues.length} flagged issue
                  {review.issues.length === 1 ? "" : "s"} — review before
                  accepting
                </span>
              </div>
              {review.issues.map((iss: PrefIssue, i: number) => (
                <div className="pref-issue" key={i}>
                  <div className="pref-issue-text">{iss.text}</div>
                  {iss.reason && (
                    <div className="pref-issue-reason">{iss.reason}</div>
                  )}
                </div>
              ))}
            </div>
          )}
          <div className="pref-actions">
            <button
              className="btn small primary"
              onClick={acceptReview}
              disabled={savingPrefs}
            >
              <CheckCircle size={14} weight="bold" />
              {savingPrefs ? "saving…" : "Accept"}
            </button>
            <button
              className="btn small ghost"
              onClick={dismissReview}
              disabled={savingPrefs}
            >
              Dismiss
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export { AgentTab };
