// ===========================================================================
// Providers tab — the credential POOL.
// ===========================================================================

import { useEffect, useState } from "react";
import {
  X,
  Eye,
  EyeSlash,
  Plus,
  Trash,
  FloppyDisk,
} from "@phosphor-icons/react";
import {
  PROVIDER_DEFS,
  isKeylessProviderType,
  type ProviderDef,
  type ProviderRow,
} from "@dissertator/shared";
import { api } from "../../lib/api";

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

  // The credential POOL: real (keyed) providers only. The keyless local
  // providers (Tesseract OCR, Granite embeddings) are internal to the
  // Functions tab and don't belong here. Newest first so a just-added
  // provider lands on top.
  const rows = providers
    .filter((p) => !isKeylessProviderType(p.type))
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));

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
        {rows.map((p) => (
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

/**
 * A pool row. Only the NAME is editable here — a provider's type and endpoint
 * are fixed at creation (the Add dialog). The API key is the one real
 * credential, stored in the OS keychain under the row's slot.
 */
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

  const [name, setName] = useState(provider.name);
  const [key, setKey] = useState(keyValue);
  const [showKey, setShowKey] = useState(false);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);

  // Test-connection state (probes the provider's /models with its key).
  const [testing, setTesting] = useState(false);
  const [test, setTest] = useState<
    { ok: boolean; n?: number; error?: string } | null
  >(null);

  useEffect(() => {
    setName(provider.name);
    setDirty(false);
  }, [provider.id, provider.name]);
  useEffect(() => {
    setKey(keyValue);
  }, [keyValue]);

  const save = async () => {
    setSaving(true);
    try {
      // Only the name is user-editable on a saved row.
      await api.updateProvider(provider.id, { name });
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
          {/* Fixed at creation — read-only identity, not a picker. */}
          <input value={def?.label ?? provider.type} disabled />
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

/** Add-provider modal: a catalog quick-start prefills name/apiUrl + a get-key
 *  link; the key is stored to the keychain on save. A Test button probes the
 *  endpoint with the entered key before saving. */
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

  const [testing, setTesting] = useState(false);
  const [test, setTest] = useState<{ ok: boolean; n?: number; error?: string } | null>(null);

  const pickDef = (id: string) => {
    const d = PROVIDER_DEFS.find((x) => x.id === id) ?? PROVIDER_DEFS[0];
    setDefId(d.id);
    setName(d.label);
    setApiUrl(d.apiUrl);
    setTest(null);
  };

  const runTest = async () => {
    setTesting(true);
    setTest(null);
    try {
      const r = await api.testProviderConnection(apiUrl.trim(), key.trim());
      setTest({ ok: true, n: r.models.length });
    } catch (e) {
      setTest({ ok: false, error: (e as Error)?.message ?? String(e) });
    } finally {
      setTesting(false);
    }
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
              {PROVIDER_DEFS.filter((d) => !d.local).map((d) => (
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
          {/* Only show the URL field for the Custom escape hatch. Defined
              cloud providers (those with a keyUrl) have a fixed endpoint —
              the user only ever enters an API key. */}
          {!def.keyUrl && (
            <label className="field">
              <span>API URL</span>
              <input
                value={apiUrl}
                onChange={(e) => {
                  setApiUrl(e.target.value);
                  setTest(null);
                }}
                placeholder="https://…"
              />
            </label>
          )}
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
          {test && (
            <div className={`muted small test-badge ${test.ok ? "ok" : "err"}`}>
              {test.ok ? `✓ ${test.n} models reachable` : `✗ ${test.error}`}
            </div>
          )}
          {err && <div className="muted small err">{err}</div>}
        </div>
        <div className="actions">
          <button className="btn ghost" onClick={onCancel}>
            Cancel
          </button>
          <button
            className="btn ghost"
            onClick={runTest}
            disabled={testing || !apiUrl.trim()}
            title="Probe /models with this key before saving"
          >
            {testing ? "testing…" : "Test"}
          </button>
          <button className="btn primary" onClick={save} disabled={saving}>
            {saving ? "saving…" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}

export { ProvidersTab };
