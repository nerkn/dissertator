import { useState } from "react";
import { Eye, EyeSlash, Sparkle } from "@phosphor-icons/react";
import { PROVIDER_DEFS, isKeylessProviderType } from "@dissertator/shared";
import { api } from "../lib/api";
import { useProviderStore } from "../lib/stores/providers";
import { useContentStore } from "../lib/stores/content";

interface Props {
  onClose: () => void;
}

export function OnboardingDialog({ onClose }: Props) {
  const providers = useProviderStore((s) => s.providers);
  const refreshProviders = useProviderStore((s) => s.refreshProviders);
  const loadKeys = useProviderStore((s) => s.loadKeys);

  const [defId, setDefId] = useState(PROVIDER_DEFS[0].id);
  const def = PROVIDER_DEFS.find((d) => d.id === defId) ?? PROVIDER_DEFS[0];
  const [apiUrl, setApiUrl] = useState(def.apiUrl);
  const [key, setKey] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [testing, setTesting] = useState(false);
  const [test, setTest] = useState<
    { ok: boolean; n?: number; models?: string[]; error?: string } | null
  >(null);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState("");

  const pickDef = (id: string) => {
    const d = PROVIDER_DEFS.find((x) => x.id === id) ?? PROVIDER_DEFS[0];
    setDefId(d.id);
    setApiUrl(d.apiUrl);
    setTest(null);
    setErr("");
  };

  const runTest = async () => {
    setTesting(true);
    setTest(null);
    try {
      const r = await api.testProviderConnection(apiUrl.trim(), key.trim());
      setTest({ ok: true, n: r.models.length, models: r.models });
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
      let prov = providers.find((p) => p.type === def.id && !isKeylessProviderType(p.type));
      if (!prov) {
        prov = await api.createProvider({
          name: def.label,
          type: def.id,
          apiUrl: apiUrl.trim(),
        });
      } else if (prov.apiUrl !== apiUrl.trim()) {
        prov = await api.updateProvider(prov.id, { apiUrl: apiUrl.trim() });
      }
      await api.setKey(prov.keyUser, key.trim());

      const { bindings } = await api.getBindings();
      if (bindings.chat.providerId !== prov.id) {
        const chatModel =
          test?.models?.[0] ?? def.defaults?.chat ?? bindings.chat.model ?? "";
        await api.setBinding("chat", prov.id, chatModel);
      }

      await refreshProviders();
      await loadKeys();
      await useContentStore.getState().handleSettingsChange();
      onClose();
    } catch (e) {
      setErr((e as Error)?.message ?? String(e));
    } finally {
      setSaving(false);
    }
  };

  const canSave = !!key.trim() && !!apiUrl.trim();

  return (
    <div className="overlay">
      <div className="dialog" onClick={(e) => e.stopPropagation()}>
        <div className="dialog-head">
          <h2>
            <Sparkle size={18} weight="bold" /> Set up a provider
          </h2>
        </div>
        <div className="settings-tab-body">
          <div className="muted small helper">
            Add an API key so the assistant can chat with your corpus. You can
            change or add more later in Settings.
          </div>
          <label className="field">
            <span>Provider</span>
            <select value={defId} onChange={(e) => pickDef(e.target.value)}>
              {PROVIDER_DEFS.filter((d) => !d.local).map((d) => (
                <option key={d.id} value={d.id}>
                  {d.label}
                </option>
              ))}
            </select>
          </label>
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
                onChange={(e) => {
                  setKey(e.target.value);
                  setTest(null);
                }}
                placeholder="API key"
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
              {test.ok
                ? `✓ ${test.n} models reachable`
                : `✗ ${test.error}`}
            </div>
          )}
          {err && <div className="muted small err">{err}</div>}
        </div>
        <div className="actions">
          <button
            className="btn ghost"
            onClick={runTest}
            disabled={testing || !canSave}
            title="Probe /models with this key"
          >
            {testing ? "testing…" : "Test"}
          </button>
          <button
            className="btn primary"
            onClick={save}
            disabled={saving || !canSave}
          >
            {saving ? "saving…" : "Save & start chatting"}
          </button>
        </div>
      </div>
    </div>
  );
}
