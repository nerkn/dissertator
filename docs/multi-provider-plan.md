# Multi-Provider Plan

Transform the 2-kind (chat/embedding) provider system into a generic
**provider pool + function-binding matrix**: the user adds named providers
(pa, pb, pc…), then wires each **function** to a provider + model.

## Locked decisions

- **Providers** are generic credentials: `{name, type, apiUrl, keyUser}`. No
  `kind`, no `model` on the row. A provider is reusable across functions.
- **Functions** (fixed enum, 5): `chat`, `stt`, `vision_doc`, `vision_image`, `embed`.
  - `chat` — assistant chat.
  - `stt` — audio → text (transcribe).
  - `vision_doc` — OCR / understand **PDF pages & scans** (bulk). Tesseract available.
  - `vision_image` — understand a **standalone image file** (jpg/png/webp). Model-only (no tesseract).
  - `embed` — vectorize chunks. **Changing provider OR model re-vectorizes everything.**
- **Binding** = `{providerId, model}` per function. `model` lives on the binding
  because one key serves different models per function.
- **Engine: OpenAI-style only.** One client: `/chat/completions`,
  `/audio/transcriptions`, `/embeddings`, `/models`. Covers OpenAI, Z.ai,
  DeepSeek, OpenRouter, Groq, Together, Mistral, Ollama/LM Studio/vLLM.
  Native Claude dropped (use OpenRouter if needed).
- **`provider_defs`** = a small catalog that prefills the Add-Provider form only.
  Not provider rows; not seeded into the pool.
- **Keys** stay in the OS keychain (one slot per provider, reused across bound
  functions). Never in DB. Sent per-call as `Authorization: Bearer`.
- **No migration.** Greenfield schema (fresh project DBs).
- **GUI**: two tabs — **Providers** (pool + add/edit/delete + test) and
  **Functions** (5-row matrix: provider dropdown + live model dropdown + test).
- **Live model list**: `GET {apiUrl}/models` populates each function's model dropdown.
- **Tests**: per-provider (`/models` probe) + per-function (a minimal real call).

---

## 1. Concepts

| concept | meaning |
|---|---|
| **provider** | a named OpenAI-compatible endpoint + keychain slot. Reusable. |
| **function** | one of `chat \| stt \| vision_doc \| vision_image \| embed`. Fixed 5. |
| **binding** | `function → {providerId, model}`. Exactly 5 rows, ever. |
| **provider_def** | catalog entry (Z.ai/OpenAI/DeepSeek/…) to prefill Add-Provider. |

**Resolution flow** (backend): `function → binding → provider → {apiUrl, key(header), model}`.
**Key flow** (frontend): `binding → provider.keyUser → keychain → per-call Bearer`.

---

## 2. Data model (`sidecar/src/schema.sql`)

### `providers` (replace existing)
```sql
CREATE TABLE IF NOT EXISTS providers (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  type       TEXT NOT NULL DEFAULT 'openai',  -- branding/catalog id; no runtime branching
  api_url    TEXT NOT NULL DEFAULT '',
  key_user   TEXT NOT NULL,                    -- OS keychain slot
  is_default INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
```
Dropped: `kind`, `model` (model moves to binding; kind is gone).

### `function_bindings` (NEW)
```sql
CREATE TABLE IF NOT EXISTS function_bindings (
  function    TEXT PRIMARY KEY,            -- chat|stt|vision_doc|vision_image|embed
  provider_id TEXT NOT NULL REFERENCES providers(id) ON DELETE RESTRICT,
  model       TEXT NOT NULL DEFAULT '',
  updated_at  INTEGER NOT NULL
);
```
`ON DELETE RESTRICT`: cannot delete a provider that a function is bound to (UI must rebind first).

### `settings` — slimmer
Remove: `chat_provider_id`, `embedding_provider_id`, `ocrStrategy`. Those are now
expressed by `function_bindings` (tesseract = a provider the `vision_doc` function
binds to; "skip OCR" stays a per-source decision via `needs_ocr_reason`, not a binding).

### Seed (fresh DB)
- providers: `local-zai` (is_default=1, key_user=`zai`) + `local-tesseract`
  (type=`tesseract`, api_url='', key_user='').
- function_bindings: all 5 → `local-zai`, models from `provider_defs` defaults
  (`glm-4.6`, `whisper-1`, `glm-4v`, `glm-4v`, `embedding-3`). `vision_doc` bound
  to `local-zai/glm-4v` (user can switch to tesseract).

---

## 3. `provider_defs` catalog (`packages/shared/src/index.ts`)

Replace `PROVIDER_DEFAULTS` + `EMBEDDING_DEFAULTS` with one catalog used only by
the Add-Provider form:

```ts
export interface ProviderDef {
  id: string;          // 'zai' | 'openai' | 'deepseek' | 'openrouter' | 'groq'
                       // | 'together' | 'mistral' | 'ollama' | 'custom'
  label: string;
  apiUrl: string;      // prefilled base URL
  keyUrl?: string;     // "get a key" link
  defaultKeyUser?: string;
}
export const PROVIDER_DEFS: ProviderDef[] = [ /* zai, openai, deepseek,
  openrouter, groq, together, mistral, ollama(local), custom */ ];
```
Engine ignores `type` at runtime (all OpenAI-style). `type` retained on the row
for branding + so the catalog can re-resolve defaults. Suggested model defaults
per function (used when seeding / first binding) can live here too as a map
`Record<Function, string>` per def, but keep minimal.

---

## 4. Layer-by-layer work

### P0 — Shared contract (`packages/shared/src/index.ts`)
- `export type Function = "chat"|"stt"|"vision_doc"|"vision_image"|"embed";`
- `export const FUNCTIONS: Function[] = [...];`
- `export interface ProviderRow { id; name; type; apiUrl; keyUser; isDefault; createdAt }`
  (replaces `ProviderConfig`; no `kind`/`model`).
- `export interface FunctionBinding { fn: Function; providerId: string; model: string; updatedAt: number }`
- `export type Bindings = Record<Function, FunctionBinding>`
- `export interface ProviderInput { name; type; apiUrl; keyUser }` (create/update).
- Replace `Settings` chat/embedding resolution fields with `bindings: Bindings`
  plus a **flat resolved view** for back-compat with routes:
  ```ts
  export interface ResolvedFunction { apiUrl: string; model: string; providerId: string }
  export interface Settings { /* app settings… */ bindings: Bindings;
    resolved: Record<Function, ResolvedFunction>; }   // resolved = binding + provider.apiUrl
  ```
- Drop `ProviderKind`, `resolveChatConfig`, `resolveEmbeddingConfig`,
  `PROVIDER_DEFAULTS`, `EMBEDDING_DEFAULTS`, `ChatConfig`, `EmbeddingConfig`
  (or keep thin aliases during transition). Update `SettingsPatch` accordingly.

### P1 — DB (`sidecar/src/schema.sql`, `sidecar/src/db.ts`)
- New schema (§2). `migrate()` (line 134) updated for fresh-DB shape (no migration
  of old data per decision).
- `seedProviders()` (line 314) → seed `local-zai` + `local-tesseract` + 5 bindings.
- `getSettings()` (line 1016): resolve all 5 bindings → `resolved[fn] = {apiUrl,
  model, providerId}` by joining `function_bindings` ↔ `providers`.
- New:
  - `getBindings(): Bindings`
  - `setBinding(fn, {providerId, model}): { revectorize: boolean }`
    - For `embed`: if providerId or model changed → **re-vectorize side effect**:
      `UPDATE chunks SET embedding_status='pending'` (ALL rows) + `DROP TABLE
      embeddings` (vec0 dims are locked; `lockDimensions` recreates on next embed
      with new dims). Returns `revectorize:true` so caller can kick the background
      worker + emit an event.
  - `listModels(apiUrl, key): Promise<string[]>` — proxy `GET {apiUrl}/models`,
    normalize `{data:[{id}]}` → `string[]`. (Keys arrive via header; see P2.)
- CRUD relax (`createProvider` 650 / `updateProvider` 695 / `deleteProvider` 731):
  drop `kind` validation, no `model` column, RESTRICT if bound.
- `getProvider` (626) / `getProviders` → return `ProviderRow[]`.

### P2 — Sidecar routes (`sidecar/src/index.ts`)
Key convention: **caller sends the key for the function being invoked** as
`Authorization: Bearer <key>`. Routes read their function's resolved config from
`getSettings().resolved[fn]` and the key from the header.

Update:
- `POST /sources/:id/ocr` (532) — vision path uses `resolved.vision_doc`; if bound
  provider `type==='tesseract'` → run local tesseract (no key); else vision model
  + key from header.
- `POST /sources/:id/transcribe` (570) — uses `resolved.stt` (+ model from binding,
  no more hardcoded `whisper-1` default).
- chat route `POST /chat` (1116) — uses `resolved.chat`.
- embed route `POST /embed` (604) + corpus — uses `resolved.embed`; key header
  already `Authorization` (rename any `X-Embedding-Key` usage to the same Bearer).
- `GET /settings` (113) / `PUT /settings` (118) — return/accept `bindings`.
- `POST/PUT/DELETE /providers` (151/180/203) — use new `ProviderInput`, no `kind`.

New routes:
- `GET /providers/:id/models` — proxies `GET {provider.apiUrl}/models` using the
  caller's `Authorization` header. Returns `{ models: string[] }`. (Provider row
  supplies apiUrl; key comes from the frontend which holds keychain.)
- `POST /functions/:fn/test` — minimal real call using `resolved[fn]` + header key:
  - chat → 1-token completion ("hi")
  - stt → bundle a tiny ~1s wav (sidecar asset) to `/audio/transcriptions`
  - vision_doc → tiny png, extraction prompt
  - vision_image → tiny png, description prompt
  - embed → embed the string `"test"`
  - returns `{ ok, latencyMs, error? }`
- (embed revectorize is triggered implicitly by `PUT /settings`/`setBinding`; add
  `GET /embed/revectorize-status` if a progress UI is wanted.)

### P3 — Frontend state (`src/App.tsx`)
- Load `bindings` into state alongside `providers` + `keys`.
- Derive **5 keys** instead of 2:
  ```ts
  const keyFor = (fn: Function) => keys[ providers[bindings[fn].providerId].keyUser ];
  // → chatKey, sttKey, visionDocKey, visionImageKey, embedKey
  ```
- Pass the matching key to each call site (chat already; `AttentionPanel` for
  ocr/transcribe; embed already).

### P4 — Frontend UI (`src/components/SettingsDialog.tsx`)
**Providers tab** (pool):
```
┌─ Providers ──────────────────────────────── [+ Add] ─┐
│ ● Z.ai (GLM)    api.z.ai         ✓ key    ⚙  ✕     │
│ ● OpenAI        api.openai.com   ✓ key    ⚙  ✕     │
│ ● Local-Tesseract built-in       —        ✕         │
└──────────────────────────────────────────────────────┘
```
Add modal: `provider_defs` quick-start dropdown → prefills name/apiUrl + key link;
API key field (writes keychain); **Test** = `GET /providers/:id/models`.

**Functions tab** (matrix):
```
┌─ Functions ────────────────────────────────────────────────┐
│ Chat          [ Z.ai ▾ ]   model [ glm-4.6      ▾ ]  ✓     │
│ STT           [ Z.ai ▾ ]   model [ whisper-1    ▾ ]  ✓     │
│ Vision · docs [ Z.ai ▾ ]   model [ glm-4v       ▾ ]  ✓     │
│ Vision · image[ Z.ai ▾ ]   model [ glm-4v       ▾ ]  ✓     │
│ Embed ⚠       [ Z.ai ▾ ]   model [ embedding-3  ▾ ]  ✓     │
└────────────────────────────────────────────────────────────┘
```
- provider dropdown = pool (from Providers tab).
- model dropdown = **live** from `GET /providers/:id/models` on provider change;
  free-text fallback if empty/failed.
- `vision_doc` provider dropdown includes `local-tesseract`; `vision_image` excludes it.
- per-row **Test** → `POST /functions/:fn/test`.
- **embed row**: on provider/model change + Save → show re-vectorize modal (§5);
  only `embed` is destructive.

### P5 — Adapters (`sidecar/src/ocr/`, `transcribe/`, `chat/`, `embed/`)
- Collapse all to a single OpenAI-compatible code path keyed on `{apiUrl, model, key}`.
  Remove per-`type` branching (claude/zai/openrouter) — all use OpenAI format now.
- **`vision_doc`** (`ocr/vision.ts`): keep extraction prompt ("transcribe text on
  this page image"). tesseract path stays for `type==='tesseract'`.
- **`vision_image`** (NEW, `ocr/image.ts`): description prompt ("describe this
  image in detail for search"). Output becomes the source file's text (a jpg/png/
  webp has no extractable text). New ingest branch for image source files.
- `transcribe/index.ts`: model from binding (was hardcoded `whisper-1`).

---

## 5. Embed re-vectorize flow (the destructive case)

Triggered when `setBinding('embed', …)` changes providerId or model:

1. **Frontend**: on Save of embed row change, show modal:
   ```
   ┌─ ⚠ Re-vectorize everything? ──────────────────────┐
   │ You changed the Embed provider/model.             │
   │ • 4,382 chunks → reset to "pending"               │
   │ • vector index rebuilt (dims change)              │
   │ • costs API calls; runs in background (~min)      │
   │ Chats, notes, and source text are NOT touched.    │
   │                [ Cancel ]   [ Re-vectorize ]      │
   └───────────────────────────────────────────────────┘
   ```
2. **Backend** `setBinding('embed')` (on confirm): in one tx —
   `UPDATE chunks SET embedding_status='pending'`; `DROP TABLE embeddings`;
   `UPDATE function_bindings SET provider_id=?, model=? WHERE function='embed'`.
3. `lockDimensions(N)` (db.ts:1149) recreates the vec0 table lazily on the next
   successful embed with the new model's dimension.
4. Existing embed background worker drains `pending` chunks; show a corner
   progress chip ("Re-vectorizing 1,204/4,382…").

Changing chat/stt/vision bindings is instant — no warning.

---

## 6. Build order & checkpoints

1. **P0 shared** — types + `provider_defs`. *Check: `shared` compiles; TS errors
   elsewhere expected, fixed as we go.*
2. **P1 db** — schema + seed + `getSettings`/`getBindings`/`setBinding`/`listModels`.
   *Check: fresh project inits, `GET /settings` returns 5 resolved bindings.*
3. **P2 routes** — rebind `/ocr`,`/transcribe`,`/chat`,`/embed` to resolved; add
   `/providers/:id/models` + `/functions/:fn/test`. *Check: chat + a vision OCR
   + a transcribe each work end-to-end through their own binding.*
4. **P3 App keys** — 5 derived keys. *Check: calls carry correct keys.*
5. **P4 UI** — Providers tab + Functions tab + embed modal. *Check: full matrix
   editable; live model dropdowns; tests pass; embed change re-vectorizes.*
6. **P5 adapters** — collapse to OpenAI-style; add `vision_image` + image ingest.
   *Check: jpg/png/webp sources get described text; tesseract still works for doc OCR.*

Each checkpoint leaves the app green. P1 keeps the old UI nominally working via
the flat `resolved` view until P4 swaps it.

---

## 7. Open items / risks

- **Model dimension caching**: `lockDimensions` stores the model id; ensure the
  embed worker reads the *current* binding's model + recomputes dims after a
  re-vectorize (don't trust a stale cached dimension).
- **`/models` shape variance**: some backends paginate or return non-standard
  envelopes. `listModels` should be defensive (`data?.map?.(x=>x.id) ?? []`).
- **STT/vision test assets**: bundle a tiny wav + png in `sidecar/` (a few hundred
  bytes) for `/functions/:fn/test`. Avoid network for the asset itself.
- **`vision_image` ingest**: decide trigger — on add of a jpg/png/webp source, run
  description and store as the file's text (status `done` once described). Re-run
  lives behind a "re-describe" action if the binding changes (non-destructive, no
  warning — just regenerates description text).
- **Delete-bound provider**: RESTRICT forces rebind in UI before delete; surface a
  clear message ("Reassign Embed away from this provider first").
- **Tesseract presence**: still a build/runtime dependency for the `local-tesseract`
  provider; if absent, the `vision_doc` tesseract option is disabled with a note.
