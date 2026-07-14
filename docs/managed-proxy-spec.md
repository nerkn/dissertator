# Managed Proxy Spec — "Dissertator Cloud" OpenAI-compatible service

An **OpenAI-compatible, credit-metered proxy** that resells upstream LLM
providers. Self-hostable, OSS. Anyone with an API key can call it like it's
OpenAI. The Dissertator app connects to it as **just another OpenAI-compatible
provider row** (per `multi-provider-plan.md`) — no new code path in the app.

Status: planning. Separate service, separate repo/deploy from the Tauri app.

## Locked decisions (from planning)

- **Audience (b): public.** Any OpenAI client can call it with a key — not
  locked to Dissertator. → abuse-limiting + metering must be solid on day one.
- **Endpoints: all.** `/v1/chat/completions`, `/v1/embeddings`,
  `/v1/audio/transcriptions`, `/v1/audio/translations`, `/v1/models`.
  (Dissertator uses chat/embed/transcribe; translations is cheap to include.)
- **Upstream (c): many providers, model→backend routing.** Request's `model`
  resolves to a configured backend. **If omitted or `"default"`, the per-modality
  system default is used** (one default for chat, one for embed, one for audio).
- **Concrete v1 endpoint:** base `https://aiprovider.sici.dev/v1`; account/key
  management at `https://aiprovider.sici.dev/account`. Default model aliases
  follow `sici/<function>`: `sici/chat`, `sici/stt`, `sici/vision_doc`,
  `sici/vision_image`, `sici/embed` (each maps to a configured `upstream_model`;
  one `is_default` per modality). The Dissertator app preset ships these as its
  per-function `defaults`.
- **Auth: Bearer `sk-...` key, minted on magic-link login.** Standard OpenAI
  wire auth. App stores the key in the OS keychain like any provider key.
- **Streaming: yes** (SSE for chat). Required for chat UX.
- **Credits: prepaid packs only** (no subscriptions in v1). Per-token metering
  with a markup.
- **Stack constraints:** OSS / self-hostable. **Bun + SQLite** (matches sidecar).
  No Clerk/Supabase/Firebase/Stripe. Magic-link email auth. **BTCPay Server** +
  manual invoice/bank-transfer for payments. One region in v1; `tr.`/`eu.`
  templated after.

---

## 1. Two auth surfaces (don't conflate them)

| Surface | Who | Credential | Where used |
|---|---|---|---|
| **Web dashboard** | humans managing account/keys/billing | signed **session cookie** (magic link) | `app.dissertator…/account` |
| **API** | any OpenAI client (incl. Dissertator app) | **`sk-...` Bearer key** | `/v1/*` |

The API speaks plain OpenAI Bearer auth — **not** cookies — because OpenAI
clients send `Authorization: Bearer`. Keys are created in the dashboard, or
auto-minted at login for the in-app flow.

**In-app login flow:** magic-link verify → response includes a freshly minted
`sk-...` key (and a dashboard session) → app stores the key in the keychain
under the managed provider row's `keyUser` → app uses it as a normal OpenAI key.
The app's provider layer is **unchanged** (per `multi-provider-plan.md` §1, the
managed endpoint is one `providers` row with `apiUrl = https://<region>/v1`).

---

## 2. Architecture

Single Bun HTTP process + SQLite per region. Logical layers:

```
client ──Bearer sk-──▶ [ edge/rate-limit ]
                         │
              ┌──────────▼──────────┐
              │  routes/v1/*        │  OpenAI-shaped I/O
              │  chat|embed|audio   │
              └──────────┬──────────┘
                         │
              ┌──────────▼──────────┐
              │  router (model→up)  │  resolve alias / default
              └──────────┬──────────┘
                         │
              ┌──────────▼──────────┐
              │  meter              │  estimate → hold → reconcile
              │  (the core/risk)    │
              └──────────┬──────────┘
                         │
              ┌──────────▼──────────┐
              │  upstream adapters  │  openai-compatible (zai/openai/…)
              └──────────┬──────────┘
                         ▼
                   real provider
```

Plus: `auth` (magic link + keys + sessions), `billing` (BTCPay + invoice +
ledger), `admin` (catalog/pricing/ban dashboard).

---

## 3. Data model (SQLite)

```sql
CREATE TABLE accounts (
  id         TEXT PRIMARY KEY,
  email      TEXT NOT NULL UNIQUE,
  region     TEXT NOT NULL,              -- 'tr' | 'eu' | … (own region only)
  status     TEXT NOT NULL DEFAULT 'active',  -- active|banned
  created_at TEXT NOT NULL
);

CREATE TABLE api_keys (
  id         TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  key_hash   TEXT NOT NULL,              -- sha256(secret) — never store plaintext
  prefix     TEXT NOT NULL,              -- 'sk-diss-…abc' for display
  label      TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  last_used_at TEXT,
  revoked_at TEXT
);

CREATE TABLE magic_links (
  token      TEXT PRIMARY KEY,           -- opaque, single-use, ~10min TTL
  email      TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT
);

CREATE TABLE models (                     -- the exposed catalog + routing
  alias        TEXT PRIMARY KEY,          -- exposed name, e.g. 'glm-4.6'
  modality     TEXT NOT NULL,             -- chat|embed|audio
  upstream_id  TEXT NOT NULL REFERENCES upstreams(id),
  upstream_model TEXT NOT NULL,          -- real model name at upstream
  in_rate      INTEGER NOT NULL,          -- credits per 1K input tokens (or per sec audio)
  out_rate     INTEGER NOT NULL,          -- credits per 1K output tokens
  is_default   INTEGER NOT NULL DEFAULT 0 -- one true per modality
);

CREATE TABLE upstreams (                  -- provider credentials (region-held)
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  api_url    TEXT NOT NULL,
  key_secret TEXT NOT NULL,               -- the real upstream key, region-stored
  created_at TEXT NOT NULL
);

CREATE TABLE credit_packs (
  id        TEXT PRIMARY KEY,
  credits   INTEGER NOT NULL,
  price_usd INTEGER NOT NULL,             -- cents
  label     TEXT NOT NULL
);

CREATE TABLE ledger (                     -- immutable, append-only; source of truth
  id         TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  delta      INTEGER NOT NULL,            -- +purchase/refund, -hold/charge
  kind       TEXT NOT NULL,               -- purchase|hold|charge|refund|admin
  ref        TEXT,                        -- request id / btcpay invoice id
  model      TEXT, tokens_in INTEGER, tokens_out INTEGER,
  created_at TEXT NOT NULL
);
-- balance = SUM(delta). holds are negative deltas reconciled later.

CREATE TABLE rate_limits (                -- per-key caps (admin/user editable)
  api_key_id      TEXT PRIMARY KEY REFERENCES api_keys(id) ON DELETE CASCADE,
  rpm             INTEGER,                -- requests/min
  tpm             INTEGER,                -- tokens/min
  daily_credits   INTEGER
);
```

`accounts.balance` is a cached sum of `ledger`; ledger is canonical.

---

## 4. Auth & keys

- **Magic link:** `POST /auth/magic/request {email}` → email with
  `https://<region>/auth/magic/verify?t=<token>` (10-min TTL, single use).
  `GET /auth/magic/verify?t=…` → sets signed session cookie; redirects to
  dashboard. For the **in-app** variant, the verify endpoint also returns a JSON
  `{ session, apiKey }` so the app grabs a key without a browser.
- **API keys:** secrets look like `sk-diss-<32 random>`. Store `sha256(secret)`
  only. Show plaintext **once** at creation. `prefix` = first/last chars for
  display in the dashboard (`sk-diss-…a1b2`). Lookup on each request:
  `WHERE key_hash = ? AND revoked_at IS NULL`.
- **Sessions:** signed cookie (HMAC), server-side session table optional. Just
  for the dashboard.
- **SMTP:** self-hosted (Postal, or any SMTP relay). No third-party mail SaaS.

**"Is it hard?" → No.** Minting a key is `randomBytes → hash → insert → return`.
~half a day including the dashboard create/revoke UI.

---

## 5. The wire (OpenAI compatibility)

| Route | Behavior |
|---|---|
| `POST /v1/chat/completions` | full passthrough; rewrite `model` (§6); cap `max_tokens`; inject `stream_options.include_usage` upstream; proxy SSE (§7) |
| `POST /v1/embeddings` | passthrough; meter input tokens |
| `POST /v1/audio/transcriptions` | multipart; meter by audio seconds (probe duration) |
| `POST /v1/audio/translations` | same as transcriptions |
| `GET /v1/models` | returns the `models` catalog (`{data:[{id:alias,…}]}`) |

- **Request:** accept OpenAI bodies; pass through all params except `model`
  (resolved) and `max_tokens` (capped). Don't invent non-OpenAI fields.
- **Response:** OpenAI-shaped, including the `usage` object (required — metering
  reads it). Preserve streaming SSE format byte-for-byte from upstream.
- **Errors:** OpenAI shape `{error:{message,type,code}}`. Quota exhaustion →
  **`429 insufficient_quota`** (mirrors OpenAI; keeps client libs happy). Auth →
  `401 invalid_api_key`. Bad model → `404 model_not_found`.
- **Auth header:** `Authorization: Bearer sk-...` only.

---

## 6. Routing — model → upstream ("if no pick, sys default")

```
modality = from endpoint (chat|embed|audio)
alias    = request.model
if alias absent or === 'default':
    alias = (SELECT alias FROM models WHERE modality=? AND is_default=1)
row = (SELECT * FROM models WHERE alias=?)
upstream = (SELECT * FROM upstreams WHERE id=row.upstream_id)
call upstream.api_url with upstream_model=row.upstream_model
```

- Exactly **one `is_default` per modality** (chat/embed/audio) enforced by DB
  constraint or app logic.
- Exposed `alias` may differ from `upstream_model` (reseller flexibility: expose
  `gpt-4o-equivalent` → route to whatever you want). ⚠️ **ToS caution:** don't
  impersonate vendors' exact model names to mislead; alias freely, label honestly.
- Unknown alias → `404 model_not_found`.
- `/v1/models` lists aliases only (hides upstream internals).
- **v1 catalog:** `sici/chat | sici/stt | sici/vision_doc | sici/vision_image |
  sici/embed`, each routing to an admin-set `upstream_model`. `sici/chat`,
  `sici/embed`, and `sici/stt` are the chat/embed/audio modality defaults.
  Note: `vision_doc`/`vision_image` ride on `/chat/completions` (multimodal), so
  they are **chat-modality** rows pointing at vision-capable upstream models —
  not separate modalities, and not the chat default.

---

## 7. Metering & credits (the core, and the risk)

**Goal:** never let a call through you can't pay for; never overcharge; refund
failures. Credits = the internal currency; users buy packs; you set per-model
rates with a markup over upstream cost.

**Per-request flow:**

1. **Authn:** hash Bearer → key row → account. Reject if `revoked` or `banned`.
2. **Rate-limit check:** rpm/tpm/daily-credits (in-memory counters, refilled).
3. **Resolve model** (§6).
4. **Estimate cost (the HOLD):**
   - chat/embed input: count input tokens (fast tokenizer or
     `ceil(chars/4)` heuristic) → `in_tokens × in_rate`.
   - chat output worst case: `min(max_tokens, SERVER_CAP) × out_rate`.
     (`SERVER_CAP` per modality, e.g. 4096, prevents `max_tokens: 128000` abuse.)
   - audio: probe duration from the upload → `seconds × in_rate`.
   - `hold = input_cost + worst_case_output_cost`.
5. **Balance check:** `balance >= hold`? No → `429 insufficient_quota`.
6. **Reserve atomically:** `INSERT ledger (kind='hold', delta=-hold, ref=requestId)`.
   Single transaction; SQLite serializes writers (fine for v1).
7. **Call upstream** (stream or not).
8. **Reconcile:**
   - **Success, non-stream:** read `usage` from upstream response → actual =
     `in×in_rate + out×out_rate`. `INSERT ledger (kind='charge', delta=-(actual))`
     and `INSERT ledger (kind='refund', delta=+(hold-actual))` if hold>actual; if
     actual>hold (shouldn't happen given cap), charge the extra. Net ledger =
     `-actual`.
   - **Success, stream:** consume upstream `usage` from the final SSE chunk
     (force `stream_options.include_usage=true` upstream regardless of client);
     same reconcile. As a fallback, count streamed output tokens yourself.
   - **Upstream failure (non-2xx):** `INSERT ledger (kind='refund',
     delta=+hold)` — full refund. Forward the upstream error to the client.
     **No charge.**
   - **Client disconnect mid-stream:** charge for tokens already streamed, refund rest.
9. Attach `usage` to the response the client sees (OpenAI clients expect it).

**Stream metering notes:**
- The hold protects you during the stream; reconcile when `usage` arrives.
- If upstream omits usage entirely, fall back to your own token count of the
  streamed delta — never let a call go uncounted.
- Keep an in-flight ledger of `{requestId, accountId, hold}` so a crash can be
  reconciled by a sweeper (any hold older than N minutes with no charge/refund
  → full refund).

**Pricing:** `in_rate`/`out_rate` in credits, set per model by admin, derived as
`upstream_cost × markup × safety_buffer` rounded up. Markup is your margin.
Audio is per-second. Review rates whenever upstream prices change.

---

## 8. Payments (no Stripe)

- **Credit packs** (`credit_packs` table): e.g. `{10k credits, $9}`,
  `{50k, $39}`. Admin-curated.
- **BTCPay Server** (self-hosted, OSS): dashboard "Buy credits" → create BTCPay
  invoice → user pays on BTCPay's hosted page → **webhook** `invoice_paid` →
  `INSERT ledger (kind='purchase', delta=+credits, ref=btcpayInvoiceId)`
  idempotent on the BTCPay invoice id. No card data ever touches you (no PCI scope).
- **Invoice / bank transfer** (for orgs/govt): admin creates a manual invoice,
  marks paid on confirmation → `INSERT ledger (kind='purchase', …)`. This is
  mostly ops, light code. Govt buyers prefer this anyway (POs, budget cycles).
- No subscriptions in v1 → no dunning, proration, churn logic.

---

## 9. Abuse & cost safety (required — public reseller)

| Control | Where |
|---|---|
| Per-key `rpm` / `tpm` / `daily_credits` caps | `rate_limits`, in-memory counters |
| `max_tokens` server cap per modality | rewrite before upstream call |
| Model allowlist (only priced `models` rows routable) | router |
| Concurrent-in-flight limit per key | in-process map |
| File-size cap on audio uploads | route guard |
| Global circuit breaker: upstream spend/min > threshold → reject new (`503`) | meter |
| Account ban + key revocation | admin |
| Edge-level IP throttle for unauthenticated floods | reverse proxy / first hop |

One bug in metering = **you pay**. The circuit breaker is the wallet's airbag.

---

## 10. Region / data residency

- A region = an independent deploy (`tr.dissertator…`, `eu.dissertator…`) with
  its **own DB, upstream keys, SMTP, BTCPay instance** in that jurisdiction.
- **No cross-region accounts** in v1. Account lives where it was created.
- Client **region selector** (default by geoip/locale, always overridable).
- Honest framing for users: *stored data* (sources/embeddings/drafts if you later
  add cloud sync) stays in-region; *LLM prompts/responses* transit to whichever
  upstream provider the region is configured for. A region operator may point at
  an in-country model. Self-hosters control both knobs entirely.

---

## 11. Project layout (Bun)

```
managed-proxy/
  src/
    index.ts                # bootstrap
    routes/
      v1/chat.ts  v1/embeddings.ts  v1/audio.ts  v1/models.ts
      auth.ts                # magic link + session
      account.ts             # /me, keys CRUD, balance
      billing.ts             # packs + btcpay webhook + manual invoice
      admin.ts               # catalog/pricing/upstreams/ban
    lib/
      auth.ts                # keys, hashing, sessions, magic link
      router.ts              # model → upstream
      meter.ts               # estimate, hold, reconcile, sweeper
      ledger.ts
      rateLimit.ts
      streaming.ts           # SSE proxy + usage capture
      upstream/              # one OpenAI-compatible client (covers most)
    db/schema.sql  db/migrations/
  docker-compose.yml  .env.example  README.md
```

---

## 12. Build order & checkpoints

1. **Skeleton + auth** — Bun server, SQLite schema, magic link, `sk-` keys,
   `/v1/models`. *Check: create account, mint key, curl `/v1/models` with Bearer.*
2. **Router + passthrough (no metering yet)** — chat non-stream end-to-end through
   one upstream. *Check: Dissertator app connects as a provider row, chat works.*
3. **Metering** — estimate/hold/reconcile/refund, ledger, balance, `429` path.
   *Check: spend tracked exactly; failed calls refund; balance blocks over-spend.*
4. **Streaming** — SSE proxy + usage capture + stream reconcile.
   *Check: streamed chat metered correctly; disconnect charges partial.*
5. **Rate limits + circuit breaker + caps.** *Check: abuse inputs rejected.*
6. **Billing** — BTCPay packs + webhook + manual invoice. *Check: buy credits,
   balance increments, idempotent.*
7. **Embeddings + audio** routes. *Check: both metered (tokens / seconds).*
8. **Admin dashboard** — catalog/pricing/upstreams/ban/key mgmt.
9. **Multi-region** — template compose; second region.

Each checkpoint leaves the service runnable and testable by curl.

---

## 13. MVP cut (ship first)

One region, **chat + embeddings**, magic-link auth, `sk-` keys, single upstream,
prepaid credits, per-token metering, rate limits + circuit breaker, BTCPay,
`/v1/models`. **~4–6 weeks**, dominated by metering + streaming (weeks 3–4).

Defer to v1.1: audio endpoints, multi-upstream routing, admin polish, second
region, dashboard niceties.

---

## 14. Risks / open questions

- **Upstream ToS on reselling.** OpenAI generally permits building on top and
  being responsible for end users; Z.ai/DeepSeek/others vary. Confirm per
  upstream before going public. This is the biggest *legal* risk of choice (b).
- **Metering correctness = direct money.** Holds must always cover actuals
  (enforce `max_tokens` cap; never trust client-supplied token counts). Sweeper
  reconciles orphaned holds. Unit-test the ledger to the cent.
- **`usage` shape variance.** Not all OpenAI-compatible backends return `usage`
  in streams, or at all. Have a self-count fallback; document which upstreams are
  "metered-clean."
- **Crypto-only payments limit audience.** Some users/institutions can't/won't
  use crypto. The invoice/bank-transfer path covers orgs; individuals in
  card-only markets may be excluded. Acceptable for v1; revisit (e.g. regional
  non-Stripe processors) if it blocks growth.
- **Single-writer SQLite ceiling.** Fine for one region at modest scale; move to
  Postgres + row locks before it bites.
- **Key leakage = spend.** Revocation must be instant (check `revoked_at` every
  request); encourage per-device keys + rotation.
- **Streaming partial-charge edge cases.** Define and test: upstream 200 then
  truncates, client disconnect, slow client timeouts, duplicate final chunks.
