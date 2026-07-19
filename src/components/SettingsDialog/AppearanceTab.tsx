import { PaintBrushBroad, ArrowsCounterClockwise } from "@phosphor-icons/react";
import { THEMES } from "../../lib/themes";
import { useThemeStore } from "../../lib/stores/theme";

export function AppearanceTab() {
  const themeId = useThemeStore((s) => s.themeId);
  const textOverride = useThemeStore((s) => s.textOverride);
  const mutedOverride = useThemeStore((s) => s.mutedOverride);
  const setTheme = useThemeStore((s) => s.setTheme);
  const setTextOverride = useThemeStore((s) => s.setTextOverride);
  const setMutedOverride = useThemeStore((s) => s.setMutedOverride);

  return (
    <div className="appearance-tab">
      <div className="provider-group">
        <div className="provider-group-title">Theme</div>
        <div className="theme-grid">
          {THEMES.map((t) => {
            const active = t.id === themeId;
            return (
              <button
                key={t.id}
                className={`theme-card${active ? " active" : ""}`}
                onClick={() => setTheme(t.id)}
                title={t.name}
              >
                <div
                  className="theme-card-swatch"
                  style={{ background: t.vars.bg }}
                >
                  <span
                    className="theme-chip"
                    style={{ background: t.vars.panel }}
                  />
                  <span
                    className="theme-chip"
                    style={{ background: t.vars["panel-2"] }}
                  />
                  <span
                    className="theme-chip accent"
                    style={{ background: t.vars.purple }}
                  />
                  <span
                    className="theme-chip accent"
                    style={{ background: t.vars.blue }}
                  />
                  <span
                    className="theme-chip accent"
                    style={{ background: t.vars.green }}
                  />
                </div>
                <div className="theme-card-name">{t.name}</div>
              </button>
            );
          })}
        </div>
      </div>

      <div className="provider-group">
        <div className="provider-group-title">Font colors</div>
        <div className="theme-font-row">
          <label className="theme-font-field">
            <span>Primary text</span>
            <div className="theme-color-input">
              <input
                type="color"
                value={textOverride ?? themeVar(themeId, "text")}
                onChange={(e) => setTextOverride(e.target.value)}
              />
              <span className="theme-color-value">
                {textOverride ?? "theme default"}
              </span>
            </div>
          </label>
          <label className="theme-font-field">
            <span>Muted text</span>
            <div className="theme-color-input">
              <input
                type="color"
                value={mutedOverride ?? themeVar(themeId, "muted")}
              />
              <span className="theme-color-value">
                {mutedOverride ?? "theme default"}
              </span>
            </div>
          </label>
          <button
            className="btn ghost tiny-btn"
            onClick={() => {
              setTextOverride(null);
              setMutedOverride(null);
            }}
            disabled={!textOverride && !mutedOverride}
            title="Reset to theme defaults"
          >
            <ArrowsCounterClockwise size={13} weight="bold" />
            Reset
          </button>
        </div>
        <div className="muted small theme-font-hint">
          Overrides stack on top of the selected theme.
        </div>
      </div>

      <div className="muted small appearance-hint">
        <PaintBrushBroad size={13} weight="bold" />
        Pick a base theme — more coming soon.
      </div>
    </div>
  );
}

function themeVar(themeId: string, key: "text" | "muted"): string {
  const t = THEMES.find((x) => x.id === themeId);
  return t ? t.vars[key] : "#000000";
}
