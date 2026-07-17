import { useEffect, useRef, useState } from "react";
import { CheckCircle, FloppyDisk, Sparkle, Warning } from "@phosphor-icons/react";
import { api } from "../../lib/api";
import { DEFAULT_CHAT_FLOW } from "@dissertator/shared";
import type { ChatFlowSettings } from "@dissertator/shared";
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

  // Chat-flow UX toggles (Settings → Agent). Loaded from project settings;
  // saved via PUT /settings with a partial chatFlow patch (server merges).
  const [chatFlow, setChatFlow] = useState<ChatFlowSettings>(DEFAULT_CHAT_FLOW);
  const flowLastSavedRef = useRef<string>(JSON.stringify(DEFAULT_CHAT_FLOW));
  const [flowSavedAt, setFlowSavedAt] = useState<number | null>(null);

  useEffect(() => {
    let stopped = false;
    (async () => {
      try {
        const [p, pr, st] = await Promise.all([
          api.getAgentPersona(),
          api.getPreferences(),
          api.getSettings(),
        ]);
        if (stopped) return;
        setPersona(p);
        lastSavedRef.current = JSON.stringify(p);
        setPrefs(pr.contents);
        prefsLastSavedRef.current = pr.contents;
        const cf = st.chatFlow
          ? { ...DEFAULT_CHAT_FLOW, ...st.chatFlow }
          : DEFAULT_CHAT_FLOW;
        setChatFlow(cf);
        flowLastSavedRef.current = JSON.stringify(cf);
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
  const flowDirty = JSON.stringify(chatFlow) !== flowLastSavedRef.current;

  const saveChatFlow = async () => {
    try {
      const st = await api.saveSettings({ chatFlow });
      const cf = st.chatFlow
        ? { ...DEFAULT_CHAT_FLOW, ...st.chatFlow }
        : DEFAULT_CHAT_FLOW;
      setChatFlow(cf);
      flowLastSavedRef.current = JSON.stringify(cf);
      setFlowSavedAt(Date.now());
    } catch {
      /* ignore */
    }
  };

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

      <div className="agent-divider" />

      <div className="agent-field">
        <label className="agent-label">Chat flow</label>
        <div className="muted small helper" style={{ marginBottom: 8 }}>
          Default behaviors for new chats. Toggle off to disable.
        </div>
        <FlowToggle
          label="Auto-greet new chats"
          hint="Run an opener turn that greets and proposes next steps."
          checked={chatFlow.autoGreet}
          onChange={(v) => setChatFlow((f) => ({ ...f, autoGreet: v }))}
        />
        <FlowToggle
          label="Inherit pinned sources"
          hint="New chats carry over the previous chat's pinned sources."
          checked={chatFlow.inheritPins}
          onChange={(v) => setChatFlow((f) => ({ ...f, inheritPins: v }))}
        />
        <FlowToggle
          label="Auto-title"
          hint="Summarize a short title after the turn threshold below."
          checked={chatFlow.autoTitle}
          onChange={(v) => setChatFlow((f) => ({ ...f, autoTitle: v }))}
        />
        <div className="flow-row">
          <label className="flow-label" htmlFor="flow-title-turns">
            Auto-title turn threshold
          </label>
          <input
            id="flow-title-turns"
            type="number"
            min={2}
            max={20}
            className="flow-number"
            value={chatFlow.autoTitleTurns}
            onChange={(e) =>
              setChatFlow((f) => ({
                ...f,
                autoTitleTurns: Math.max(2, Number(e.target.value) || 4),
              }))
            }
          />
        </div>
        <FlowToggle
          label="Prompts open by default"
          hint="Expand the Prompts section when a chat opens."
          checked={chatFlow.promptsOpen}
          onChange={(v) => setChatFlow((f) => ({ ...f, promptsOpen: v }))}
        />
        <div className="prompts-foot">
          {flowSavedAt && !flowDirty && (
            <span className="muted small">Saved.</span>
          )}
          <button
            className="btn small primary"
            onClick={saveChatFlow}
            disabled={!flowDirty}
            title="Save chat flow"
          >
            <FloppyDisk size={14} weight="bold" />
            Save
          </button>
        </div>
      </div>
    </div>
  );
}

function FlowToggle({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string;
  hint: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="flow-toggle">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className="flow-toggle-text">
        <span className="flow-toggle-label">{label}</span>
        <span className="muted small">{hint}</span>
      </span>
    </label>
  );
}

export { AgentTab };
