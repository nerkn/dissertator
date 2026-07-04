import { useState } from "react";
import { X } from "@phosphor-icons/react";
import type { OcrStrategy, Provider, Settings } from "@dissertator/shared";
import { PROVIDER_DEFAULTS } from "@dissertator/shared";

interface Props {
  settings: Settings;
  apiKey: string;
  onClose: () => void;
  onSave: (s: Settings, apiKey: string) => void;
}

export function SettingsDialog({ settings, apiKey, onClose, onSave }: Props) {
  const [provider, setProvider] = useState<Provider>(settings.provider);
  const [apiUrl, setApiUrl] = useState<string>(settings.apiUrl);
  const [model, setModel] = useState<string>(settings.model);
  const [ocrStrategy, setOcrStrategy] = useState<OcrStrategy>(
    settings.ocrStrategy,
  );
  const [key, setKey] = useState<string>(apiKey);

  const onProviderChange = (p: Provider) => {
    setProvider(p);
    const d = PROVIDER_DEFAULTS[p];
    setApiUrl(d.apiUrl);
    if (!model || model === "") setModel(d.defaultModel);
  };

  const save = () =>
    onSave(
      {
        provider,
        apiUrl,
        model,
        ocrStrategy,
        embedding: settings.embedding,
        // Preserved verbatim — the email input field is a P3 job. Without
        // this passthrough, saving settings would drop the value to its
        // default (no UI to re-enter it yet).
        contactEmail: settings.contactEmail,
      },
      key.trim(),
    );

  const def = PROVIDER_DEFAULTS[provider];

  return (
    <div className="overlay" onClick={onClose}>
      <div className="dialog" onClick={(e) => e.stopPropagation()}>
        <div className="dialog-head">
          <h2>Settings</h2>
          <button className="icon-btn" onClick={onClose} title="Close">
            <X size={18} />
          </button>
        </div>

        <label className="field">
          <span>Provider</span>
          <select
            value={provider}
            onChange={(e) => onProviderChange(e.target.value as Provider)}
          >
            {(Object.keys(PROVIDER_DEFAULTS) as Provider[]).map((p) => (
              <option key={p} value={p}>
                {PROVIDER_DEFAULTS[p].label}
              </option>
            ))}
          </select>
        </label>

        <label className="field">
          <span>API URL</span>
          <input
            value={apiUrl}
            onChange={(e) => setApiUrl(e.target.value)}
            placeholder={def.apiUrl || "https://..."}
          />
        </label>

        <label className="field">
          <span>Model</span>
          <input
            value={model}
            onChange={(e) => setModel(e.target.value)}
            placeholder="model id"
            list="model-list"
          />
          <datalist id="model-list">
            {def.models.map((m) => (
              <option key={m} value={m} />
            ))}
          </datalist>
        </label>

        <label className="field">
          <span>API Key</span>
          <input
            type="password"
            value={key}
            onChange={(e) => setKey(e.target.value)}
            placeholder="stored in OS keychain — never in your project folder"
          />
        </label>

        <label className="field">
          <span>OCR strategy</span>
          <select
            value={ocrStrategy}
            onChange={(e) => setOcrStrategy(e.target.value as OcrStrategy)}
          >
            <option value="tesseract">Tesseract (local, free)</option>
            <option value="vision">Vision API (uses your key)</option>
            <option value="skip">Skip</option>
          </select>
          <span className="muted small helper">
            How image-only files are read. Override per-file from the Attention
            panel.
          </span>
        </label>

        <div className="actions">
          <button className="btn ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" onClick={save}>
            Save
          </button>
        </div>
      </div>
    </div>
  );
}
