// Minimal media fixtures for the connectivity self-tests (see /functions/:fn/test).

// A valid 1×1 PNG (data URI) used by the vision connectivity test.
export const PNG_1x1 =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

/** Build a minimal silent WAV (8-bit mono 8kHz) for the STT connectivity test. */
export function silentWav(seconds = 0.1): Uint8Array {
  const sampleRate = 8000;
  const dataLen = Math.floor(sampleRate * seconds);
  const buf = new Uint8Array(44 + dataLen);
  const dv = new DataView(buf.buffer);
  const str = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) dv.setUint8(off + i, s.charCodeAt(i));
  };
  str(0, "RIFF");
  dv.setUint32(4, 36 + dataLen, true);
  str(8, "WAVE");
  str(12, "fmt ");
  dv.setUint32(16, 16, true);
  dv.setUint16(20, 1, true); // PCM
  dv.setUint16(22, 1, true); // mono
  dv.setUint32(24, sampleRate, true);
  dv.setUint32(28, sampleRate, true);
  dv.setUint16(32, 1, true);
  dv.setUint16(34, 8, true); // 8-bit
  str(36, "data");
  dv.setUint32(40, dataLen, true);
  for (let i = 0; i < dataLen; i++) buf[44 + i] = 128; // 8-bit silence
  return buf;
}
