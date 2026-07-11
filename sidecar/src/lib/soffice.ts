// LibreOffice (soffice) helpers for the /export route: format table, HTML
// attribute escaping, and a cached binary lookup.

export const SOFFICE_FILTERS: Record<
  string,
  { filter: string; ext: string; mime: string }
> = {
  pdf: { filter: "pdf:writer_pdf_Export", ext: "pdf", mime: "application/pdf" },
  docx: {
    filter: "docx:MS Word 2007 XML",
    ext: "docx",
    mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  },
  doc: { filter: "doc:MS Word 97", ext: "doc", mime: "application/msword" },
};

export function escapeHtmlAttr(s: string): string {
  return s.replace(/[&<>"']/g, (ch) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]!),
  );
}

// Detect LibreOffice once. Tries `soffice` then `libreoffice`; cached so we
// don't pay the --version startup cost on every export.
let _sofficeBin: string | null | undefined;
export function findSoffice(): string | null {
  if (_sofficeBin !== undefined) return _sofficeBin;
  for (const bin of ["soffice", "libreoffice"]) {
    try {
      const r = Bun.spawnSync({
        cmd: [bin, "--version"],
        stdout: "pipe",
        stderr: "pipe",
      });
      if (r.exitCode === 0) {
        _sofficeBin = bin;
        return bin;
      }
    } catch {
      /* binary not present — try the next alias */
    }
  }
  _sofficeBin = null;
  return null;
}
