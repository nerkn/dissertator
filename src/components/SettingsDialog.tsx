// Settings dialog (P6): three tabs — Providers, Functions, Prompts.
//
// PROVIDERS: a list of named, user-editable provider rows (chat-kind and
// embedding-kind). The user can have several (two OpenAI accounts, a work
// Claude, an embedding backend, …). Each row carries its own API key (eye/
// uneye) stored in the OS keychain under the row's `keyUser` slot. Rows are
// persisted as the user edits them (POST on add, PUT on save, DELETE on
// remove) — there is no global stage/commit for provider rows, so Cancel
// only closes the dialog.
//
// FUNCTIONS: assigns provider rows to the three functions.
//   - chat          → one chat-kind provider (the default; vision uses it too)
//   - visual understand → tesseract | vision | skip (vision = the chat
//     provider's model; disabled when that provider has no key)
//   - vectorizer    → one embedding-kind provider
//
// PROMPTS: edits the raw `Dissertator/prompts.md`. Save writes it back and
// re-parses (the quick-pick menu consumes the result).
//
// The dialog mutates state via api + the App callbacks (onProvidersChange /
// onSettingsChange / onKeyChange) so the derived apiKey / embeddingApiKey in
// App recompute and the Library / Chat panels see new selections live.

import { useEffect, useRef, useState } from "react";
import {
  X,
  Eye,
  EyeSlash,
  Plus,
  Trash,
  FloppyDisk,
  Star,
} from "@phosphor-icons/react";
import {
  EMBEDDING_DEFAULTS,
  PROVIDER_DEFAULTS,
  serializePrompts,
  type EmbeddingProvider,
  type OcrStrategy,
  type Provider,
  type ProviderConfig,
  type ProviderKind,
  type Settings,
} from "@dissertator/shared";
import { api } from "../lib/api";

type TabId = "providers" | "functions" | "prompts";

interface Props {
  settings: Settings;
  providers: ProviderConfig[];
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
      <div
        className="dialog dialog-wide"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="dialog-head">
          <h2>Settings</h2>
          <button className="icon-btn" onClick={onClose} title="Close">
            <X size={18} />
          </button>
        </div>

        <div className="settings-tabs" role="tablist">
          <TabButton
            active={tab === "providers"}
            onClick={() => setTab("providers")}
          >
            Providers
          </TabButton>
          <TabButton
            active={tab === "functions"}
            onClick={() => setTab("functions")}
          >
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
              chatProviderId={settings.chatProviderId}
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
// Providers tab
// ===========================================================================

interface ProvidersTabProps {
  providers: ProviderConfig[];
  keys: Record<string, string>;
  chatProviderId?: string;
  onChange: () => Promise<void>;
  onKeyChange: (keyUser: string, value: string) => Promise<void>;
}

function ProvidersTab({
  providers,
  keys,
  chatProviderId,
  onChange,
  onKeyChange,
}: ProvidersTabProps) {
  const chat = providers.filter((p) => p.kind === "chat");
  const embedding = providers.filter((p) => p.kind === "embedding");

  const addProvider = async (kind: ProviderKind) => {
    const type: ProviderConfig["type"] = "openai";
    try {
      await api.createProvider({
        name:
          kind === "chat"
            ? "New provider"
            : "New embedding provider",
        kind,
        type,
      });
      await onChange();
    } catch {
      /* ignore — refresh keeps the list honest */
    }
  };

  const removeProvider = async (id: string) => {
    try {
      await api.deleteProvider(id);
      await onChange();
    } catch {
      /* last-of-kind refusal surfaces as a no-op here */
    }
  };

  const setDefaultChat = async (id: string) => {
    try {
      await api.updateProvider(id, { isDefault: true });
      await onChange();
    } catch {
      /* ignore */
    }
  };

  return (
    <div className="providers-tab">
      <ProviderGroup
        title="Chat providers"
        hint="The model that answers chat and powers vision OCR. Star the default."
        items={chat}
        keys={keys}
        defaultId={chatProviderId}
        onAdd={() => addProvider("chat")}
        onRemove={removeProvider}
        onSetDefault={setDefaultChat}
        onChange={onChange}
        onKeyChange={onKeyChange}
      />
      <ProviderGroup
        title="Embedding providers"
        hint="The backend that vectorizes your corpus for semantic search."
        items={embedding}
        keys={keys}
        onAdd={() => addProvider("embedding")}
        onRemove={removeProvider}
        onChange={onChange}
        onKeyChange={onKeyChange}
      />
    </div>
  );
}

interface ProviderGroupProps {
  title: string;
  hint: string;
  items: ProviderConfig[];
  keys: Record<string, string>;
  defaultId?: string;
  onAdd: () => void;
  onRemove: (id: string) => void;
  onSetDefault?: (id: string) => void;
  onChange: () => Promise<void>;
  onKeyChange: (keyUser: string, value: string) => Promise<void>;
}

function ProviderGroup({
  title,
  hint,
  items,
  keys,
  defaultId,
  onAdd,
  onRemove,
  onSetDefault,
  onChange,
  onKeyChange,
}: ProviderGroupProps) {
  return (
    <div className="provider-group">
      <div className="provider-group-head">
        <span className="provider-group-title">{title}</span>
        <button className="btn ghost tiny-btn" onClick={onAdd} title="Add">
          <Plus size={13} weight="bold" /> Add
        </button>
      </div>
      <div className="muted small provider-group-hint">{hint}</div>
      {items.map((p) => (
        <ProviderRow
          key={p.id}
          provider={p}
          keyValue={keys[p.keyUser] ?? ""}
          isDefault={defaultId === p.id}
          canSetDefault={!!onSetDefault}
          onSetDefault={onSetDefault}
          onRemove={onRemove}
          onChange={onChange}
          onKeyChange={onKeyChange}
        />
      ))}
    </div>
  );
}

interface ProviderRowProps {
  provider: ProviderConfig;
  keyValue: string;
  isDefault: boolean;
  canSetDefault: boolean;
  onSetDefault?: (id: string) => void;
  onRemove: (id: string) => void;
  onChange: () => Promise<void>;
  onKeyChange: (keyUser: string, value: string) => Promise<void>;
}

function ProviderRow({
  provider,
  keyValue,
  isDefault,
  canSetDefault,
  onSetDefault,
  onRemove,
  onChange,
  onKeyChange,
}: ProviderRowProps) {
  // Local draft for the editable scalar fields; committed via the row's Save.
  const [name, setName] = useState(provider.name);
  const [type, setType] = useState<ProviderConfig["type"]>(provider.type);
  const [apiUrl, setApiUrl] = useState(provider.apiUrl);
  const [model, setModel] = useState(provider.model);
  const [key, setKey] = useState(keyValue);
  const [showKey, setShowKey] = useState(false);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);

  // Re-sync from upstream when the row identity changes (add/remove/refresh).
  useEffect(() => {
    setName(provider.name);
    setType(provider.type);
    setApiUrl(provider.apiUrl);
    setModel(provider.model);
    setDirty(false);
  }, [provider.id, provider.name, provider.type, provider.apiUrl, provider.model]);
  useEffect(() => {
    setKey(keyValue);
  }, [keyValue]);

  const typeOptions =
    provider.kind === "chat"
      ? (Object.keys(PROVIDER_DEFAULTS) as Provider[])
      : (Object.keys(EMBEDDING_DEFAULTS) as EmbeddingProvider[]);
  const def =
    provider.kind === "chat"
      ? PROVIDER_DEFAULTS[type as Provider]
      : EMBEDDING_DEFAULTS[type as EmbeddingProvider];

  const onTypeChange = (t: ProviderConfig["type"]) => {
    setType(t);
    setDirty(true);
  };

  const save = async () => {
    setSaving(true);
    try {
      await api.updateProvider(provider.id, {
        name,
        type,
        apiUrl,
        model,
      });
      // Key lives in the keychain, not the row — persist via the App callback.
      await onKeyChange(provider.keyUser, key.trim());
      setDirty(false);
      await onChange();
    } finally {
      setSaving(false);
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
        {canSetDefault && (
          <button
            className={`icon-btn${isDefault ? " active" : ""}`}
            title={isDefault ? "Default chat provider" : "Set as default"}
            onClick={() => onSetDefault?.(provider.id)}
            disabled={isDefault}
          >
            <Star
              size={16}
              weight={isDefault ? "fill" : "regular"}
            />
          </button>
        )}
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
          <select value={type} onChange={(e) => onTypeChange(e.target.value as ProviderConfig["type"])}>
            {typeOptions.map((t) => (
              <option key={t} value={t}>
                {(provider.kind === "chat"
                  ? PROVIDER_DEFAULTS[t as Provider]
                  : EMBEDDING_DEFAULTS[t as EmbeddingProvider]
                ).label}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Model</span>
          <input
            value={model}
            onChange={(e) => {
              setModel(e.target.value);
              setDirty(true);
            }}
            placeholder={"defaultModel" in def ? def.defaultModel : "model id"}
          />
        </label>
        <label className="field field-wide">
          <span>API URL</span>
          <input
            value={apiUrl}
            onChange={(e) => {
              setApiUrl(e.target.value);
              setDirty(true);
            }}
            placeholder={def.apiUrl || "https://…"}
          />
        </label>
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
      </div>

      <div className="provider-row-foot">
        <span className="muted small">
          keychain slot: <code>{provider.keyUser}</code>
        </span>
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
  );
}

// ===========================================================================
// Functions tab
// ===========================================================================

interface FunctionsTabProps {
  settings: Settings;
  providers: ProviderConfig[];
  keys: Record<string, string>;
  onChange: () => Promise<void>;
}

function FunctionsTab({ settings, providers, keys, onChange }: FunctionsTabProps) {
  const chatProviders = providers.filter((p) => p.kind === "chat");
  const embeddingProviders = providers.filter((p) => p.kind === "embedding");

  // Vision uses the chat-selected provider's model; disable the option when
  // that provider has no key (the user's choice — see discussion).
  const chatProvider = chatProviders.find((p) => p.id === settings.chatProviderId);
  const visionEnabled = !!chatProvider && !!(keys[chatProvider.keyUser] ?? "");

  const setChat = async (id: string) => {
    await api.saveSettings({ chatProviderId: id });
    await onChange();
  };
  const setEmbedding = async (id: string) => {
    // Switching embedding provider resets the dimension lock so the next
    // embed re-locks against the new model (forces a fresh vector build).
    await api.saveSettings({ embeddingProviderId: id, embeddingDimensions: 0 });
    await onChange();
  };
  const setOcr = async (ocrStrategy: OcrStrategy) => {
    await api.saveSettings({ ocrStrategy });
    await onChange();
  };

  return (
    <div className="functions-tab">
      <label className="field">
        <span>Chat</span>
        <select
          value={settings.chatProviderId ?? ""}
          onChange={(e) => setChat(e.target.value)}
        >
          {chatProviders.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name} ({p.type})
            </option>
          ))}
        </select>
        <span className="muted small helper">
          The model that answers the chat.
        </span>
      </label>

      <label className="field">
        <span>Visual understand</span>
        <select
          value={settings.ocrStrategy}
          onChange={(e) => setOcr(e.target.value as OcrStrategy)}
        >
          <option value="tesseract">Tesseract (local, free)</option>
          <option value="vision" disabled={!visionEnabled}>
            Vision API{visionEnabled ? "" : " — needs a chat API key"}
          </option>
          <option value="skip">Skip</option>
        </select>
        <span className="muted small helper">
          How image-only files are read. Vision uses the chat provider's model.
        </span>
      </label>

      <label className="field">
        <span>Vectorizer</span>
        <select
          value={settings.embeddingProviderId ?? ""}
          onChange={(e) => setEmbedding(e.target.value)}
        >
          {embeddingProviders.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name} ({p.type})
            </option>
          ))}
        </select>
        <span className="muted small helper">
          The backend that embeds your corpus for semantic search.
        </span>
      </label>
    </div>
  );
}

// ===========================================================================
// Prompts tab
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
