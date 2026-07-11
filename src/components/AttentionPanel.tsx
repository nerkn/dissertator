import { useState } from "react";
import { api } from "../lib/api";
import type { OcrStrategy, SourceFile } from "@dissertator/shared";
import { StatusBadge } from "./StatusBadge";

interface Props {
  items: SourceFile[];
  /** Vision-doc provider key (OCR-vision), passed as a Bearer header. */
  visionDocKey: string | undefined;
  /** Vision-image provider key (describe standalone images), Bearer header. */
  visionImageKey: string | undefined;
  /** STT provider key (transcribe), passed as a Bearer header. */
  sttKey: string | undefined;
  provider: string | undefined;
  ocrStrategy: OcrStrategy;
  onResolved: () => void;
}

type Engine = "tesseract" | "vision";

export function AttentionPanel({
  items,
  visionDocKey,
  visionImageKey,
  sttKey,
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
      await api.ocrSource(item.id, engine, engine === "vision" ? visionDocKey : undefined);
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
      await api.transcribeSource(item.id, sttKey);
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

  // Describe a standalone image (vision_image): understand it and store a
  // textual description as the file's text. Separate from OCR (which extracts
  // any text on the image).
  const runDescribe = async (item: SourceFile) => {
    const key = `${item.id}:describe`;
    setWorking((w) => ({ ...w, [key]: true }));
    setErrors((e) => {
      const next = { ...e };
      delete next[key];
      return next;
    });
    try {
      await api.describeImage(item.id, visionImageKey);
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

  const visionEnabled = !!visionDocKey;
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
                    {item.kind === "image" && (
                      <button
                        className="btn ghost small-btn"
                        onClick={() => runDescribe(item)}
                        disabled={!visionImageKey || working[`${item.id}:describe`]}
                        title={
                          visionImageKey
                            ? "Describe this image via the vision-image provider"
                            : "Set a vision-image provider key in Settings"
                        }
                      >
                        {working[`${item.id}:describe`]
                          ? "describing…"
                          : "Describe"}
                      </button>
                    )}
                  </>
                )}
              </div>

              {(errors[tKey] ||
                errors[vKey] ||
                errors[`${item.id}:whisper`] ||
                errors[`${item.id}:describe`]) && (
                <div className="attention-error small">
                  {errors[tKey] ||
                    errors[vKey] ||
                    errors[`${item.id}:whisper`] ||
                    errors[`${item.id}:describe`]}
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
