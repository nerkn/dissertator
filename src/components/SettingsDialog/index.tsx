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

import { useState } from "react";
import { X } from "@phosphor-icons/react";
import { type ProviderRow, type Settings } from "@dissertator/shared";
import { ProvidersTab } from "./ProvidersTab";
import { FunctionsTab } from "./FunctionsTab";
import { PromptsTab } from "./PromptsTab";

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
