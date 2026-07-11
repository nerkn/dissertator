// ===========================================================================
// Functions tab — the wiring MATRIX.
// ===========================================================================

import { useEffect, useState } from "react";
import { FloppyDisk } from "@phosphor-icons/react";
import {
  AI_FUNCTIONS,
  FUNCTION_META,
  isKeylessProviderType,
  type AiFunction,
  type FunctionBinding,
  type ProviderRow,
  type ResolvedFunction,
  type Settings,
} from "@dissertator/shared";
import { api } from "../../lib/api";
import { RevectorizeModal } from "./RevectorizeModal";

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

export { FunctionsTab };
