-- Dissertator schema — P0 (extended in P2: chunks.embedding_status).
-- Note: the `embeddings` virtual table (sqlite-vec `vec0`) is created LAZILY
-- in `db.lockDimensions(N)` on the first successful embed — sqlite-vec
-- requires the vector dimension at CREATE time, which is unknown until the
-- embedding model actually returns a vector. Before that, embeddings are
-- not writable (and that's fine: search_corpus simply returns nothing).

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
  token_count    INTEGER,
  embedding_status TEXT NOT NULL DEFAULT 'pending'  -- pending|embedding|done|failed
);
CREATE INDEX IF NOT EXISTS idx_chunks_file ON chunks(source_file_id);
CREATE INDEX IF NOT EXISTS idx_chunks_embed ON chunks(embedding_status);

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
  body_md            TEXT,       -- the manuscript body (single markdown blob)
  created_at         INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS chats (
  id              TEXT PRIMARY KEY,
  title           TEXT NOT NULL,
  context_sources TEXT,        -- JSON array of source_file ids
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS chat_messages (
  chat_id     TEXT REFERENCES chats(id) ON DELETE CASCADE,
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
