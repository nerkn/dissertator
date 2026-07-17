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
// The dialog mutates state via api + the provider store (providers/keys)
// and the onSettingsChange callback (settings/prompts), so the derived
// per-function keys in App recompute and the Library / Chat panels see new
// selections live.

import { useMemo, useState } from "react";
import { X } from "@phosphor-icons/react";
import { type Settings } from "@dissertator/shared";
import { ProvidersTab } from "./ProvidersTab";
import { FunctionsTab } from "./FunctionsTab";
import { PromptsTab } from "./PromptsTab";
import { AgentTab } from "./AgentTab";
import { useProviderStore } from "../../lib/stores/providers";

type TabId = "providers" | "functions" | "prompts" | "agent";

interface Props {
  settings: Settings;
  onSettingsChange: () => Promise<void>;
  onClose: () => void;
}

export function SettingsDialog({
  settings,
  onSettingsChange,
  onClose,
}: Props) {
  const providers = useProviderStore((s) => s.providers);
  const keys = useProviderStore((s) => s.keys);
  const refreshProviders = useProviderStore((s) => s.refreshProviders);
  const onKeyChange = useProviderStore((s) => s.handleKeyChange);

  const [tab, setTab] = useState<TabId>("providers");

  const apiKey = useMemo(() => {
    const pid = settings?.bindings?.chat?.providerId;
    if (!pid) return "";
    const p = providers.find((x) => x.id === pid);
    return p ? keys[p.keyUser] ?? "" : "";
  }, [settings?.bindings?.chat, providers, keys]);

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
          <TabButton active={tab === "agent"} onClick={() => setTab("agent")}>
            Agent
          </TabButton>
        </div>

        <div className="settings-tab-body">
          {tab === "providers" && (
            <ProvidersTab
              providers={providers}
              keys={keys}
              onChange={refreshProviders}
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
          {tab === "agent" && <AgentTab apiKey={apiKey} />}
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
