-- Dissertator schema — P0.
-- Note: the `embeddings` virtual table (sqlite-vec) is added in P2, when the
-- extension is loaded and the embedding model is locked.

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS source_files (
  id            TEXT PRIMARY KEY,
  rel_path      TEXT NOT NULL,
  filename      TEXT NOT NULL,
  ext           TEXT NOT NULL,
  kind          TEXT NOT NULL,
  mime_type     TEXT,
  content_hash  TEXT,
  file_size     INTEGER,
  page_count    INTEGER,
  mtime         INTEGER,
  text_status   TEXT NOT NULL DEFAULT 'new',
  ocr_method    TEXT,
  extracted_path TEXT,
  error         TEXT,
  needs_ocr_reason TEXT,
  reference_id  TEXT,
  added_at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_source_files_hash ON source_files(content_hash);
CREATE INDEX IF NOT EXISTS idx_source_files_status ON source_files(text_status);

CREATE TABLE IF NOT EXISTS chunks (
  id             TEXT PRIMARY KEY,
  source_file_id TEXT NOT NULL REFERENCES source_files(id) ON DELETE CASCADE,
  ord            INTEGER NOT NULL,
  physical_page  INTEGER,
  printed_page   TEXT,
  text           TEXT NOT NULL,
  token_count    INTEGER
);
CREATE INDEX IF NOT EXISTS idx_chunks_file ON chunks(source_file_id);

-- `references` is a SQL-ish keyword; always quote it in queries.
CREATE TABLE IF NOT EXISTS "references" (
  id             TEXT PRIMARY KEY,
  citekey        TEXT UNIQUE NOT NULL,
  title          TEXT,
  authors        TEXT,          -- JSON array of {family, given}
  year           INTEGER,
  doi            TEXT,
  type           TEXT,
  venue          TEXT,
  csl_json       TEXT,          -- full CSL record
  source_file_id TEXT REFERENCES source_files(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS documents (
  id                 TEXT PRIMARY KEY,
  title              TEXT NOT NULL,
  doc_type           TEXT,
  thesis             TEXT,
  research_questions TEXT,       -- JSON array
  focus_prompt       TEXT,
  created_at         INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sections (
  id          TEXT PRIMARY KEY,
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  parent_id   TEXT,
  ord         INTEGER NOT NULL,
  level       INTEGER NOT NULL DEFAULT 1,
  heading     TEXT,
  body_md     TEXT
);
CREATE INDEX IF NOT EXISTS idx_sections_doc ON sections(document_id);

CREATE TABLE IF NOT EXISTS chat_messages (
  id          TEXT PRIMARY KEY,
  role        TEXT NOT NULL,
  content     TEXT,
  tool_calls  TEXT,   -- JSON
  open_files  TEXT,   -- JSON array of source_file ids
  cost_tokens INTEGER,
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS agent_runs (
  id          TEXT PRIMARY KEY,
  document_id TEXT REFERENCES documents(id) ON DELETE SET NULL,
  section_id  TEXT,
  mode        TEXT NOT NULL DEFAULT 'accept_all',
  status      TEXT NOT NULL DEFAULT 'running',
  budget      INTEGER,
  spent       INTEGER DEFAULT 0
);
