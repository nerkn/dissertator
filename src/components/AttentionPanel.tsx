import { useState } from "react";
import { api } from "../lib/api";
import type { OcrStrategy, Provider, SourceFile } from "@dissertator/shared";
import { StatusBadge } from "./StatusBadge";

interface Props {
  items: SourceFile[];
  apiKey: string | undefined;
  provider: Provider | undefined;
  ocrStrategy: OcrStrategy;
  onResolved: () => void;
}

type Engine = "tesseract" | "vision";

export function AttentionPanel({
  items,
  apiKey,
  provider,
  ocrStrategy,
  onResolved,
}: Props) {
  // Per-item, per-engine working/error state. Keyed `${id}:${engine}`.
  const [working, setWorking] = useState<Record<string, boolean>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});

  if (items.length === 0) {
    return (
      <div className="group red">
        <div className="group-head">🔴 Attention</div>
        <div className="muted small">✅ Nothing needs attention</div>
      </div>
    );
  }

  const runOcr = async (item: SourceFile, engine: Engine) => {
    const key = `${item.id}:${engine}`;
    setWorking((w) => ({ ...w, [key]: true }));
    setErrors((e) => {
      const next = { ...e };
      delete next[key];
      return next;
    });
    try {
      await api.ocrSource(item.id, engine, engine === "vision" ? apiKey : undefined);
      // Refresh upstream state; the file will transition out of the
      // attention set as OCR completes (and SSE will keep us live).
      onResolved();
    } catch (e) {
      setErrors((prev) => ({
        ...prev,
        [key]: (e as Error)?.message ?? String(e),
      }));
    } finally {
      setWorking((w) => ({ ...w, [key]: false }));
    }
  };

  const runTranscribe = async (item: SourceFile) => {
    const key = `${item.id}:whisper`;
    setWorking((w) => ({ ...w, [key]: true }));
    setErrors((e) => {
      const next = { ...e };
      delete next[key];
      return next;
    });
    try {
      await api.transcribeSource(item.id, apiKey);
      onResolved();
    } catch (e) {
      setErrors((prev) => ({
        ...prev,
        [key]: (e as Error)?.message ?? String(e),
      }));
    } finally {
      setWorking((w) => ({ ...w, [key]: false }));
    }
  };

  const visionEnabled = !!apiKey;
  const visionTitle = visionEnabled
    ? `Run vision OCR via ${provider ?? "your provider"}`
    : "Set an API key in Settings to use vision OCR";

  return (
    <div className="group red attention">
      <div className="group-head">
        🔴 Attention
        <span className="count-inline">{items.length}</span>
      </div>
      <div className="muted small">
        Files that failed extraction, need OCR, or need transcription.
        Resolve each below.
      </div>

      <div className="attention-list">
        {items.map((item) => {
          const tKey = `${item.id}:tesseract`;
          const vKey = `${item.id}:vision`;
          const reason = item.error ?? item.needsOcrReason;
          return (
            <div className="attention-item" key={item.id}>
              <div className="attention-row">
                <span className="filename" title={item.relPath}>
                  {item.filename}
                </span>
                <StatusBadge status={item.textStatus} />
              </div>
              {reason && <div className="muted small reason">{reason}</div>}

              <div className="attention-actions">
                {item.kind === "audio" ? (
                  <button
                    className="btn ghost small-btn"
                    onClick={() => runTranscribe(item)}
                    disabled={!visionEnabled || working[`${item.id}:whisper`]}
                    title={
                      visionEnabled
                        ? `Transcribe via ${provider ?? "your provider"} (whisper-1)`
                        : "Set an API key in Settings to transcribe audio"
                    }
                  >
                    {working[`${item.id}:whisper`]
                      ? "transcribing…"
                      : "Transcribe"}
                  </button>
                ) : (
                  <>
                    <button
                      className="btn ghost small-btn"
                      onClick={() => runOcr(item, "tesseract")}
                      disabled={working[tKey]}
                      title="Run local Tesseract OCR (free, no key)"
                    >
                      {working[tKey] ? "working…" : "OCR (tesseract)"}
                    </button>
                    <button
                      className="btn ghost small-btn"
                      onClick={() => runOcr(item, "vision")}
                      disabled={!visionEnabled || working[vKey]}
                      title={visionTitle}
                    >
                      {working[vKey] ? "working…" : "OCR (vision)"}
                    </button>
                  </>
                )}
              </div>

              {(errors[tKey] ||
                errors[vKey] ||
                errors[`${item.id}:whisper`]) && (
                <div className="attention-error small">
                  {errors[tKey] ||
                    errors[vKey] ||
                    errors[`${item.id}:whisper`]}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {ocrStrategy === "skip" && (
        <div className="muted small">
          OCR is currently <strong>skipped</strong> globally — override per
          file here.
        </div>
      )}
    </div>
  );
}
