// Settings dialog (P-multi): three tabs — Providers, Functions, Prompts.
//
// PROVIDERS: a POOL of generic, named credentials (name/type/apiUrl/key). No
// `kind`, no `model` on a row — a provider is reusable across functions, and
// `model` lives on the function binding. Add via a catalog quick-start
// (PROVIDER_DEFS prefills apiUrl + a get-key link). Each row persists on Save
// (PUT) and its key lives in the OS keychain under the row's `keyUser` slot.
//
// FUNCTIONS: the wiring MATRIX — one row per AiFunction (chat/stt/vision_doc/
// vision_image/embed). Each row picks a provider from the pool + a model
// (fetched LIVE from the provider's /models), with a per-row connectivity
// test. Changing the embed binding re-vectorizes everything (confirm modal).
//
// PROMPTS: edits the raw `Dissertator/prompts.md` (unchanged).
//
// The dialog mutates state via api + the App callbacks (onProvidersChange /
// onSettingsChange / onKeyChange) so the derived per-function keys in App
// recompute and the Library / Chat panels see new selections live.

import { useEffect, useRef, useState } from "react";
import {
  X,
  Eye,
  EyeSlash,
  Plus,
  Trash,
  FloppyDisk,
  Warning,
} from "@phosphor-icons/react";
import {
  AI_FUNCTIONS,
  FUNCTION_META,
  PROVIDER_DEFS,
  isKeylessProviderType,
  serializePrompts,
  type AiFunction,
  type FunctionBinding,
  type ProviderRow,
  type ProviderDef,
  type ResolvedFunction,
  type Settings,
} from "@dissertator/shared";
import { api } from "../lib/api";

type TabId = "providers" | "functions" | "prompts";

interface Props {
  settings: Settings;
  providers: ProviderRow[];
  /** keyUser → API key, for display in the eye-toggle key fields. */
  keys: Record<string, string>;
  onProvidersChange: () => Promise<void>;
  onSettingsChange: () => Promise<void>;
  /** A key field changed: persist to keychain + update the in-memory map. */
  onKeyChange: (keyUser: string, value: string) => Promise<void>;
  onClose: () => void;
}

export function SettingsDialog({
  settings,
  providers,
  keys,
  onProvidersChange,
  onSettingsChange,
  onKeyChange,
  onClose,
}: Props) {
  const [tab, setTab] = useState<TabId>("providers");

  return (
    <div className="overlay" onClick={onClose}>
      <div className="dialog dialog-wide" onClick={(e) => e.stopPropagation()}>
        <div className="dialog-head">
          <h2>Settings</h2>
          <button className="icon-btn" onClick={onClose} title="Close">
            <X size={18} />
          </button>
        </div>

        <div className="settings-tabs" role="tablist">
          <TabButton active={tab === "providers"} onClick={() => setTab("providers")}>
            Providers
          </TabButton>
          <TabButton active={tab === "functions"} onClick={() => setTab("functions")}>
            Functions
          </TabButton>
          <TabButton active={tab === "prompts"} onClick={() => setTab("prompts")}>
            Prompts
          </TabButton>
        </div>

        <div className="settings-tab-body">
          {tab === "providers" && (
            <ProvidersTab
              providers={providers}
              keys={keys}
              onChange={onProvidersChange}
              onKeyChange={onKeyChange}
            />
          )}
          {tab === "functions" && (
            <FunctionsTab
              settings={settings}
              providers={providers}
              keys={keys}
              onChange={onSettingsChange}
            />
          )}
          {tab === "prompts" && <PromptsTab />}
        </div>

        <div className="actions">
          <button className="btn primary" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </div>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      role="tab"
      aria-selected={active}
      className={`settings-tab-btn${active ? " active" : ""}`}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

// ===========================================================================
// Providers tab — the credential POOL.
// ===========================================================================

interface ProvidersTabProps {
  providers: ProviderRow[];
  keys: Record<string, string>;
  onChange: () => Promise<void>;
  onKeyChange: (keyUser: string, value: string) => Promise<void>;
}

function ProvidersTab({ providers, keys, onChange, onKeyChange }: ProvidersTabProps) {
  const [adding, setAdding] = useState(false);

  const removeProvider = async (id: string) => {
    try {
      await api.deleteProvider(id);
      await onChange();
    } catch {
      /* a bound provider refuses delete (RESTRICT) — refresh keeps it honest */
    }
  };

  return (
    <div className="providers-tab">
      <div className="provider-group">
        <div className="provider-group-head">
          <span className="provider-group-title">Providers</span>
          <button
            className="btn ghost tiny-btn"
            onClick={() => setAdding(true)}
            title="Add a provider"
          >
            <Plus size={13} weight="bold" /> Add
          </button>
        </div>
        <div className="muted small provider-group-hint">
          Credentials the Functions tab can assign. One key serves many
          functions — model is picked per function, not here.
        </div>
        {providers.map((p) => (
          <ProviderRow
            key={p.id}
            provider={p}
            keyValue={keys[p.keyUser] ?? ""}
            onRemove={removeProvider}
            onChange={onChange}
            onKeyChange={onKeyChange}
          />
        ))}
      </div>
      {adding && (
        <AddProviderModal
          onKeyChange={onKeyChange}
          onDone={async () => {
            setAdding(false);
            await onChange();
          }}
          onCancel={() => setAdding(false)}
        />
      )}
    </div>
  );
}

interface ProviderRowProps {
  provider: ProviderRow;
  keyValue: string;
  onRemove: (id: string) => void;
  onChange: () => Promise<void>;
  onKeyChange: (keyUser: string, value: string) => Promise<void>;
}

function ProviderRow({
  provider,
  keyValue,
  onRemove,
  onChange,
  onKeyChange,
}: ProviderRowProps) {
  const keyless = isKeylessProviderType(provider.type);
  const def: ProviderDef | undefined = PROVIDER_DEFS.find(
    (d) => d.id === provider.type,
  );
  // Local draft for the editable scalar fields; committed via Save.
  const [name, setName] = useState(provider.name);
  const [type, setType] = useState<string>(provider.type);
  const [apiUrl, setApiUrl] = useState(provider.apiUrl);
  const [key, setKey] = useState(keyValue);
  const [showKey, setShowKey] = useState(false);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);

  // Test-connection state (probes the provider's /models with its key).
  const [testing, setTesting] = useState(false);
  const [test, setTest] = useState<
    { ok: boolean; latencyMs?: number; sample?: string; n?: number; error?: string } | null
  >(null);

  useEffect(() => {
    setName(provider.name);
    setType(provider.type);
    setApiUrl(provider.apiUrl);
    setDirty(false);
  }, [provider.id, provider.name, provider.type, provider.apiUrl]);
  useEffect(() => {
    setKey(keyValue);
  }, [keyValue]);

  const save = async () => {
    setSaving(true);
    try {
      await api.updateProvider(provider.id, { name, type, apiUrl });
      await onKeyChange(provider.keyUser, key.trim());
      setDirty(false);
      await onChange();
    } finally {
      setSaving(false);
    }
  };

  const runTest = async () => {
    setTesting(true);
    setTest(null);
    try {
      const r = await api.getProviderModels(provider.id, keyValue);
      setTest({ ok: true, n: r.models.length });
    } catch (e) {
      setTest({ ok: false, error: (e as Error)?.message ?? String(e) });
    } finally {
      setTesting(false);
    }
  };

  return (
    <div className="provider-row">
      <div className="provider-row-head">
        <input
          className="provider-name-input"
          value={name}
          onChange={(e) => {
            setName(e.target.value);
            setDirty(true);
          }}
          placeholder="Provider name"
        />
        <button
          className="icon-btn danger"
          title="Remove provider"
          onClick={() => onRemove(provider.id)}
        >
          <Trash size={16} />
        </button>
      </div>

      <div className="provider-row-grid">
        <label className="field">
          <span>Type</span>
          {keyless ? (
            <input value={def?.label ?? provider.type} disabled />
          ) : (
            <select
              value={type}
              onChange={(e) => {
                setType(e.target.value);
                setDirty(true);
              }}
            >
              {PROVIDER_DEFS.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.label}
                </option>
              ))}
              {!def && <option value={type}>{type}</option>}
            </select>
          )}
        </label>
        <label className="field field-wide">
          <span>API URL</span>
          <input
            value={apiUrl}
            onChange={(e) => {
              setApiUrl(e.target.value);
              setDirty(true);
            }}
            placeholder={def?.apiUrl || "https://…"}
            disabled={keyless}
          />
        </label>
        {!keyless && (
          <label className="field field-wide">
            <span>API Key</span>
            <div className="key-input">
              <input
                type={showKey ? "text" : "password"}
                value={key}
                onChange={(e) => {
                  setKey(e.target.value);
                  setDirty(true);
                }}
                placeholder="stored in OS keychain — never in your project folder"
              />
              <button
                type="button"
                className="icon-btn"
                title={showKey ? "Hide" : "Show"}
                onClick={() => setShowKey((v) => !v)}
              >
                {showKey ? <EyeSlash size={16} /> : <Eye size={16} />}
              </button>
            </div>
          </label>
        )}
      </div>

      <div className="provider-row-foot">
        <span className="muted small">
          {keyless
            ? "local — no key needed"
            : <>keychain slot: <code>{provider.keyUser}</code></>}
        </span>
        <div className="provider-row-actions">
          {!keyless && (
            <>
              {test && (
                <span
                  className={`muted small test-badge ${test.ok ? "ok" : "err"}`}
                >
                  {test.ok ? `✓ ${test.n} models` : `✗ ${test.error}`}
                </span>
              )}
              <button
                className="btn ghost tiny-btn"
                onClick={runTest}
                disabled={testing || !keyValue}
                title="Probe /models with this key"
              >
                {testing ? "testing…" : "Test"}
              </button>
            </>
          )}
          <button
            className="btn small primary"
            onClick={save}
            disabled={saving || !dirty}
            title="Save this provider"
          >
            <FloppyDisk size={14} weight="bold" />
            {saving ? "saving…" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}

/** Add-provider modal: catalog quick-start prefills name/apiUrl + a get-key
 *  link; the key is stored to the keychain on save. */
function AddProviderModal({
  onKeyChange,
  onDone,
  onCancel,
}: {
  onKeyChange: (keyUser: string, value: string) => Promise<void>;
  onDone: () => void;
  onCancel: () => void;
}) {
  const [defId, setDefId] = useState<string>(PROVIDER_DEFS[0].id);
  const def = PROVIDER_DEFS.find((d) => d.id === defId) ?? PROVIDER_DEFS[0];
  const [name, setName] = useState(def.label);
  const [apiUrl, setApiUrl] = useState(def.apiUrl);
  const [key, setKey] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState("");

  const pickDef = (id: string) => {
    const d = PROVIDER_DEFS.find((x) => x.id === id) ?? PROVIDER_DEFS[0];
    setDefId(d.id);
    setName(d.label);
    setApiUrl(d.apiUrl);
  };

  const save = async () => {
    setSaving(true);
    setErr("");
    try {
      const created = await api.createProvider({
        name: name.trim() || def.label,
        type: def.id,
        apiUrl: apiUrl.trim(),
      });
      if (key.trim()) await onKeyChange(created.keyUser, key.trim());
      onDone();
    } catch (e) {
      setErr((e as Error)?.message ?? String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="overlay" onClick={onCancel}>
      <div className="dialog" onClick={(e) => e.stopPropagation()}>
        <div className="dialog-head">
          <h2>Add provider</h2>
          <button className="icon-btn" onClick={onCancel} title="Close">
            <X size={18} />
          </button>
        </div>
        <div className="settings-tab-body">
          <label className="field">
            <span>Quick start</span>
            <select value={defId} onChange={(e) => pickDef(e.target.value)}>
              {PROVIDER_DEFS.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.label}
                </option>
              ))}
            </select>
            <span className="muted small helper">
              Picks a preset; edit the fields below. All are OpenAI-compatible.
            </span>
          </label>
          <label className="field">
            <span>Name</span>
            <input value={name} onChange={(e) => setName(e.target.value)} />
          </label>
          <label className="field">
            <span>API URL</span>
            <input
              value={apiUrl}
              onChange={(e) => setApiUrl(e.target.value)}
              placeholder="https://…"
            />
          </label>
          <label className="field">
            <span>
              API Key{" "}
              {def.keyUrl && (
                <a
                  href={def.keyUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="muted small"
                >
                  get one ↗
                </a>
              )}
            </span>
            <div className="key-input">
              <input
                type={showKey ? "text" : "password"}
                value={key}
                onChange={(e) => setKey(e.target.value)}
                placeholder="stored in OS keychain"
              />
              <button
                type="button"
                className="icon-btn"
                title={showKey ? "Hide" : "Show"}
                onClick={() => setShowKey((v) => !v)}
              >
                {showKey ? <EyeSlash size={16} /> : <Eye size={16} />}
              </button>
            </div>
          </label>
          {err && <div className="muted small err">{err}</div>}
        </div>
        <div className="actions">
          <button className="btn ghost" onClick={onCancel}>
            Cancel
          </button>
          <button className="btn primary" onClick={save} disabled={saving}>
            {saving ? "saving…" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ===========================================================================
// Functions tab — the wiring MATRIX.
// ===========================================================================

interface FunctionsTabProps {
  settings: Settings;
  providers: ProviderRow[];
  keys: Record<string, string>;
  onChange: () => Promise<void>;
}

function FunctionsTab({ settings, providers, keys, onChange }: FunctionsTabProps) {
  const bindings = settings.bindings;
  const resolved = settings.resolved;
  if (!bindings || !resolved) {
    return <div className="muted">Loading bindings…</div>;
  }
  return (
    <div className="functions-tab">
      <div className="muted small helper">
        Wire each function to a provider + model. Model lists are fetched live
        from each provider; type manually if the list is empty.
      </div>
      {AI_FUNCTIONS.map((fn) => (
        <FunctionRow
          key={fn}
          fn={fn}
          binding={bindings[fn]}
          resolved={resolved[fn]}
          providers={providers}
          keys={keys}
          onChanged={onChange}
        />
      ))}
    </div>
  );
}

interface FunctionRowProps {
  fn: AiFunction;
  binding: FunctionBinding;
  resolved: ResolvedFunction;
  providers: ProviderRow[];
  keys: Record<string, string>;
  onChanged: () => Promise<void>;
}

function FunctionRow({
  fn,
  binding,
  resolved,
  providers,
  keys,
  onChanged,
}: FunctionRowProps) {
  const meta = FUNCTION_META[fn];
  const allowsTesseract = meta.allowsTesseract;

  // Draft (unsaved) provider + model; committed via Apply.
  const [draftProvider, setDraftProvider] = useState(binding.providerId);
  const [draftModel, setDraftModel] = useState(binding.model);
  useEffect(() => {
    setDraftProvider(binding.providerId);
    setDraftModel(binding.model);
  }, [binding.providerId, binding.model]);

  // Live model list for the draft provider (fetched with its key).
  const [models, setModels] = useState<string[]>([]);
  const [loadingModels, setLoadingModels] = useState(false);
  const draftProv = providers.find((p) => p.id === draftProvider);
  const draftKey = draftProv ? keys[draftProv.keyUser] ?? "" : "";
  useEffect(() => {
    if (!draftProv || isKeylessProviderType(draftProv.type)) {
      setModels([]);
      return;
    }
    let stopped = false;
    setLoadingModels(true);
    api
      .getProviderModels(draftProv.id, draftKey)
      .then((r) => {
        if (!stopped) setModels(r.models);
      })
      .catch(() => {
        if (!stopped) setModels([]);
      })
      .finally(() => {
        if (!stopped) setLoadingModels(false);
      });
    return () => {
      stopped = true;
    };
  }, [draftProv, draftKey]);

  // Connectivity test (runs against the SAVED binding).
  const [testing, setTesting] = useState(false);
  const [test, setTest] = useState<
    | { ok: boolean; latencyMs?: number; sample?: string; error?: string }
    | null
  >(null);
  const savedProv = providers.find((p) => p.id === binding.providerId);
  const savedKey = savedProv ? keys[savedProv.keyUser] ?? "" : "";

  const dirty =
    draftProvider !== binding.providerId || draftModel !== binding.model;
  const confirmRevector = fn === "embed" && dirty;

  const [confirming, setConfirming] = useState(false);
  const [applying, setApplying] = useState(false);

  const commit = async () => {
    setApplying(true);
    try {
      await api.setBinding(fn, draftProvider, draftModel);
      await onChanged();
    } finally {
      setApplying(false);
      setConfirming(false);
    }
  };

  const apply = async () => {
    if (!dirty) return;
    if (confirmRevector) {
      setConfirming(true);
      return;
    }
    await commit();
  };

  const runTest = async () => {
    setTesting(true);
    setTest(null);
    try {
      const r = await api.testFunction(fn, savedKey);
      setTest(r);
    } catch (e) {
      setTest({ ok: false, error: (e as Error)?.message ?? String(e) });
    } finally {
      setTesting(false);
    }
  };

  const availableProviders = providers.filter(
    (p) => allowsTesseract || !isKeylessProviderType(p.type),
  );

  return (
    <div className="provider-row function-row">
      <div className="function-row-head">
        <div>
          <strong>{meta.label}</strong>
          {fn === "embed" && (
            <span className="muted small"> ⚠ changes re-vectorize everything</span>
          )}
        </div>
        <div className="provider-row-actions">
          {test && (
            <span className={`muted small test-badge ${test.ok ? "ok" : "err"}`}>
              {test.ok
                ? `✓ ${test.latencyMs}ms${test.sample ? ` · ${test.sample}` : ""}`
                : `✗ ${test.error}`}
            </span>
          )}
          <button
            className="btn ghost tiny-btn"
            onClick={runTest}
            disabled={testing || dirty || !savedKey}
            title={
              dirty
                ? "Apply the change first"
                : "Run a minimal real call against this binding"
            }
          >
            {testing ? "testing…" : "Test"}
          </button>
        </div>
      </div>
      <span className="muted small helper">{meta.sublabel}</span>

      <div className="provider-row-grid">
        <label className="field">
          <span>Provider</span>
          <select
            value={draftProvider}
            onChange={(e) => setDraftProvider(e.target.value)}
          >
            {availableProviders.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
                {isKeylessProviderType(p.type) ? " (local)" : ` · ${p.type}`}
              </option>
            ))}
          </select>
        </label>
        <label className="field field-wide">
          <span>Model {loadingModels && <span className="muted">loading…</span>}</span>
          <input
            list={`models-${fn}`}
            value={draftModel}
            onChange={(e) => setDraftModel(e.target.value)}
            placeholder="model id"
          />
          <datalist id={`models-${fn}`}>
            {models.map((m) => (
              <option key={m} value={m} />
            ))}
          </datalist>
        </label>
      </div>

      <div className="provider-row-foot">
        <span className="muted small">
          {isKeylessProviderType(resolved.type)
            ? "local — no key"
            : savedKey
              ? <>key ok · <code>{resolved.apiUrl}</code></>
              : "⚠ no key set for this provider"}
        </span>
        <button
          className="btn small primary"
          onClick={apply}
          disabled={!dirty || applying}
          title="Apply this binding"
        >
          <FloppyDisk size={14} weight="bold" />
          {applying ? "applying…" : "Apply"}
        </button>
      </div>

      {confirming && (
        <RevectorizeModal
          onCancel={() => setConfirming(false)}
          onConfirm={commit}
          busy={applying}
        />
      )}
    </div>
  );
}

/** Confirm modal before an embed binding change re-vectorizes the corpus. */
function RevectorizeModal({
  onCancel,
  onConfirm,
  busy,
}: {
  onCancel: () => void;
  onConfirm: () => void;
  busy: boolean;
}) {
  return (
    <div className="overlay" onClick={onCancel}>
      <div className="dialog" onClick={(e) => e.stopPropagation()}>
        <div className="dialog-head">
          <h2>
            <Warning size={18} /> Re-vectorize everything?
          </h2>
          <button className="icon-btn" onClick={onCancel} title="Close">
            <X size={18} />
          </button>
        </div>
        <div className="settings-tab-body">
          <p>
            You changed the <strong>Embed</strong> provider or model. Vector
            dimensions change, so <strong>all chunks must be re-embedded</strong>:
          </p>
          <ul className="muted small">
            <li>every chunk is reset to "pending"</li>
            <li>the vector index is rebuilt</li>
            <li>this costs API calls and runs in the background</li>
          </ul>
          <p className="muted small">
            Chats, notes, and source text are NOT touched.
          </p>
        </div>
        <div className="actions">
          <button className="btn ghost" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button className="btn danger" onClick={onConfirm} disabled={busy}>
            {busy ? "re-vectorizing…" : "Re-vectorize"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ===========================================================================
// Prompts tab (unchanged).
// ===========================================================================

/** Internal row shape: a Prompt plus a transient client-side id so React can
 *  key rows during add/remove/edit before the file is re-serialized. */
interface PromptRow {
  uid: string;
  category: string;
  label: string;
  prompt: string;
}

let promptUidSeq = 0;
const nextPromptUid = () => `p-${Date.now()}-${promptUidSeq++}`;

function PromptsTab() {
  const [rows, setRows] = useState<PromptRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  // The last-saved serialization, so we can mark the Save button dirty only
  // when the user actually changed something.
  const lastSavedRef = useRef<string>("");

  useEffect(() => {
    let stopped = false;
    (async () => {
      try {
        const parsed = await api.listPrompts();
        if (stopped) return;
        const initial = parsed.map((p) => ({
          uid: nextPromptUid(),
          category: p.category ?? "",
          label: p.label,
          prompt: p.prompt,
        }));
        setRows(initial);
        lastSavedRef.current = serializePrompts(initial);
      } catch {
        /* ignore — empty list is fine */
      } finally {
        if (!stopped) setLoading(false);
      }
    })();
    return () => {
      stopped = true;
    };
  }, []);

  const dirty = serializePrompts(rows) !== lastSavedRef.current;

  const update = (uid: string, patch: Partial<PromptRow>) => {
    setRows((prev) =>
      prev.map((r) => (r.uid === uid ? { ...r, ...patch } : r)),
    );
  };

  const add = () => {
    setRows((prev) => [
      ...prev,
      { uid: nextPromptUid(), category: "", label: "", prompt: "" },
    ]);
  };

  const remove = (uid: string) => {
    setRows((prev) => prev.filter((r) => r.uid !== uid));
  };

  const save = async () => {
    const md = serializePrompts(rows);
    setSaving(true);
    try {
      await api.savePromptsMarkdown(md);
      lastSavedRef.current = md;
      setSavedAt(Date.now());
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <div className="muted">Loading prompts…</div>;

  return (
    <div className="prompts-tab">
      <div className="muted small helper">
        Quick-fire prompts for the chat. Each row becomes a button under the
        composer. Group rows by typing the same <strong>Category</strong>.
      </div>

      <div className="prompts-list">
        {rows.length === 0 && (
          <div className="muted small prompts-empty">
            No prompts yet. Add one below.
          </div>
        )}
        {rows.map((r) => (
          <div className="prompt-item" key={r.uid}>
            <div className="prompt-item-head">
              <input
                className="prompt-category-input"
                value={r.category}
                onChange={(e) => update(r.uid, { category: e.target.value })}
                placeholder="Category (optional)"
              />
              <input
                className="prompt-title-input"
                value={r.label}
                onChange={(e) => update(r.uid, { label: e.target.value })}
                placeholder="Title"
              />
              <button
                className="icon-btn danger"
                title="Remove prompt"
                onClick={() => remove(r.uid)}
              >
                <Trash size={15} />
              </button>
            </div>
            <textarea
              className="prompt-textarea"
              value={r.prompt}
              onChange={(e) => update(r.uid, { prompt: e.target.value })}
              placeholder="The prompt text the agent receives…"
              rows={2}
              spellCheck={false}
            />
          </div>
        ))}
      </div>

      <div className="prompts-foot">
        {savedAt && !dirty && <span className="muted small">Saved.</span>}
        <button className="btn ghost tiny-btn" onClick={add} title="Add a prompt">
          <Plus size={13} weight="bold" /> Add prompt
        </button>
        <button
          className="btn small primary"
          onClick={save}
          disabled={saving || !dirty}
          title="Save prompts to prompts.md"
        >
          <FloppyDisk size={14} weight="bold" />
          {saving ? "saving…" : "Save prompts"}
        </button>
      </div>
    </div>
  );
}
