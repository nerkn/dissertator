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

-- Named, user-editable providers (P6). The user builds a LIST of these;
-- the Functions tab assigns one chat-kind row to `chat` and one
-- embedding-kind row to `vectorizer` (via settings keys chat_provider_id /
-- embedding_provider_id). The API key is NOT stored here — it lives in the
-- OS keychain under `key_user` (legacy slots for seeded defaults, per-id
-- slots for user-added rows).
CREATE TABLE IF NOT EXISTS providers (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  type       TEXT NOT NULL,        -- backend flavor ('openai'|'zai'|...|'tesseract')
  api_url    TEXT NOT NULL DEFAULT '',
  key_user   TEXT NOT NULL,        -- OS keychain slot for this provider's key
  is_default INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

-- Function ↔ provider+model bindings (P-multi). Exactly one row per AiFunction
-- (chat|stt|vision_doc|vision_image|embed). `model` lives HERE, not on the
-- provider, because one key serves different models per function. ON DELETE
-- RESTRICT prevents deleting a provider a function is bound to (rebind first).
CREATE TABLE IF NOT EXISTS function_bindings (
  function    TEXT PRIMARY KEY,        -- chat|stt|vision_doc|vision_image|embed
  provider_id TEXT NOT NULL REFERENCES providers(id) ON DELETE RESTRICT,
  model       TEXT NOT NULL DEFAULT '',
  updated_at  INTEGER NOT NULL
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

-- Lists & notes (collect-while-reading → cite-while-writing).
-- `lists.id` is INTEGER (1-4 seeded via seedLists with system=1; user-added
-- rows auto-increment). `notes.list_id` is ONE list per note. Both excerpt
-- (the selected passage) and body (the user's note) are nullable. `rect`
-- stores the selection bbox as JSON in page-space % (overlay rendered later).
CREATE TABLE IF NOT EXISTS lists (
  id     INTEGER PRIMARY KEY,
  label  TEXT NOT NULL,
  icon   TEXT NOT NULL DEFAULT 'BookmarkSimple',
  color  TEXT NOT NULL DEFAULT '#4a90e2',
  ord    INTEGER NOT NULL DEFAULT 0,
  system INTEGER NOT NULL DEFAULT 0   -- 1 = seeded built-in (non-deletable)
);

CREATE TABLE IF NOT EXISTS notes (
  id             TEXT PRIMARY KEY,
  source_file_id TEXT NOT NULL REFERENCES source_files(id) ON DELETE CASCADE,
  page           INTEGER NOT NULL,
  excerpt        TEXT,               -- the selected passage (optional)
  body           TEXT,               -- the user's own note (optional)
  list_id        INTEGER NOT NULL REFERENCES lists(id) ON DELETE CASCADE,
  rect           TEXT,               -- JSON {x,y,w,h} in page-space %
  created_at     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_notes_file ON notes(source_file_id);
CREATE INDEX IF NOT EXISTS idx_notes_list ON notes(list_id);
