// Semantic search over embedded chunks (P2 Track 2).
//
// Public entry point: `searchCorpus(query, opts)`. Embeds the query via the
// configured embedding provider (DECOUPLED from chat), runs KNN over the
// sqlite-vec `embeddings` vec0 table, and joins back to `chunks` +
// `source_files` for metadata, returning ranked hits with similarity scores.
//
// KEY ISOLATION (hard design rule — mirrors embed/ + ocr/): the embedding API
// key travels ONLY via `opts.apiKey` → the Authorization Bearer header (or
// `x-goog-api-key` inside the Google adapter). It is never stored, never
// logged, never cached in a module variable, and never put in the DB.
// Provider error bodies are truncated ≤500 chars by the adapters so a
// key-bearing payload can't leak through an error string.
//
// DIMENSIONS MUST MATCH (hard design rule #2): the query embedding's
// dimensionality must equal the locked dimension (`settings.embeddingDimensions`). If
// the corpus isn't embedded yet (`dimensions===0` OR `done===0`), returns an
// empty result with `embedded:false` — NOT an error — so the UI can show
// "embed first". A query returning a different dim throws
// `Error("query dimension mismatch: locked <X>, got <Y>")`.
//
// DISTANCE METRIC — the vec0 table is created with `distance_metric=cosine`
// (sqlite-vec 0.1.9) in db.ts `lockDimensions()`, so KNN returns COSINE
// distance in [0,2]: 0=identical, 1=orthogonal, 2=opposite. The conversion
// `score = clamp(1 - distance, 0, 1)` therefore yields TRUE cosine similarity
// (1=identical, 0=orthogonal). This is the natural metric for semantic
// embeddings and is independent of vector magnitude (no normalization
// needed at embed time). Verified empirically: query [1,0,0] vs [0,1,0] →
// distance 1.0, vs [1,1,0] → 0.293 (= 1 - cos45°).

import {
  adapterFromType,
  type SearchHit,
  type SearchResponse,
} from "@dissertator/shared";
import { embedBatch, type EmbedEngine } from "./embed/index.ts";
import {
  getCurrentProject,
  getEmbeddingStatus,
  getSettings,
} from "./db";
import type { SQLQueryBindings } from "bun:sqlite";

/** Options for {@link searchCorpus}. */
export interface SearchOptions {
  /**
   * Embedding API key. Required when the corpus is embedded (the query must
   * be embedded too). Sent ONLY as a request header inside the adapter;
   * never stored or logged. Sourced from the request Authorization header.
   */
  apiKey?: string;
  /** Max hits to return. Default 8; clamped to [1, 50]. */
  limit?: number;
  /** Optional filter: restrict hits to chunks of this `source_file` id. */
  sourceId?: string;
  /** Minimum similarity score [0,1] to include a hit. Default 0 (no floor). */
  minScore?: number;
}

/** Default result cap — a typical "top 8 relevant passages" UX. */
const DEFAULT_LIMIT = 8;

/** Hard ceiling on hits returned (prevents oversized payloads). */
const MAX_LIMIT = 50;

/** Snippet length: chunk `text` is truncated to this many chars in the hit. */
const SNIPPET_LEN = 500;

/** Type of the embed function — exported so tests can inject a stub. */
export type EmbedFn = typeof embedBatch;

/**
 * Raw row from the KNN + join query. `distance` is sqlite-vec's native
 * distance (lower=closer; cosine distance in [0,2] for this vec0 table —
 * converted to a [0,1] similarity `score` downstream.
 */
interface KnRow {
  chunk_id: string;
  distance: number;
  source_file_id: string;
  physical_page: number | null;
  printed_page: string | null;
  text: string;
  rel_path: string;
  filename: string;
}

/**
 * Convert a sqlite-vec distance (lower=closer) to a [0,1] similarity score.
 *
 * `score = 1 - distance`, clamped to [0,1]. The vec0 table is configured with
 * `distance_metric=cosine` (see db.ts `lockDimensions`), so distance is in
 * [0,2] and this yields TRUE cosine similarity (1=identical, 0=orthogonal).
 * NaN/Infinity (e.g. from an empty/zero vector) collapse to 0.
 */
export function distanceToScore(distance: number): number {
  const s = 1 - distance;
  if (!Number.isFinite(s)) return 0;
  if (s < 0) return 0;
  if (s > 1) return 1;
  return s;
}

/** Truncate a chunk's text to a snippet for the response payload. */
function snippet(text: string): string {
  if (text.length <= SNIPPET_LEN) return text;
  return text.slice(0, SNIPPET_LEN);
}

/** Clamp the requested limit to [1, MAX_LIMIT], defaulting to DEFAULT_LIMIT. */
function clampLimit(n: number | undefined): number {
  if (n === undefined || !Number.isFinite(n)) return DEFAULT_LIMIT;
  const v = Math.floor(n);
  if (v < 1) return 1;
  if (v > MAX_LIMIT) return MAX_LIMIT;
  return v;
}

/**
 * Build the KNN + join SQL. The KNN core — `embedding MATCH ? AND k=?` — is
 * fixed (sqlite-vec requires BOTH: a `MATCH` without `k` errors). When a
 * `sourceId` filter is present it is appended as one more `AND s.id = ?`
 * clause. The trailing `LIMIT ?` re-trims after the optional source filter
 * (the `k=?` constraint caps the KNN scan BEFORE the join/filter runs).
 */
function buildKnQuery(withSourceFilter: boolean): string {
  const where = [
    "e.embedding MATCH ?",
    "e.k = ?",
    ...(withSourceFilter ? ["s.id = ?"] : []),
  ].join(" AND ");
  return (
    "SELECT e.chunk_id AS chunk_id, e.distance AS distance, " +
    "c.source_file_id AS source_file_id, c.physical_page AS physical_page, " +
    "c.printed_page AS printed_page, c.text AS text, " +
    "s.rel_path AS rel_path, s.filename AS filename " +
    "FROM embeddings e " +
    "JOIN chunks c ON c.id = e.chunk_id " +
    "JOIN source_files s ON s.id = c.source_file_id " +
    `WHERE ${where} ` +
    "ORDER BY e.distance ASC " +
    "LIMIT ?"
  );
}

/**
 * Search the embedded corpus for chunks semantically closest to `query`.
 *
 * Flow: read status → early-return if unembedded → embed the query → assert
 * dimension match → KNN over vec0 → join to chunks/source_files → map to
 * ranked hits. The embed function defaults to the real {@link embedBatch};
 * tests pass a stub via {@link searchCorpusWith} to avoid the network/key.
 *
 * Returns `{ hits: [], total: 0, dimensions, embedded: false }` (NOT an
 * error) when the corpus isn't embedded yet. Throws
 * `Error("search failed: <orig>")` on any other failure (dimension mismatch,
 * network, vec0 query error). Never crashes the process — the HTTP route
 * catches and returns a clean JSON error.
 */
export async function searchCorpus(
  query: string,
  opts: SearchOptions = {}
): Promise<SearchResponse> {
  return searchCorpusWith(query, opts, embedBatch);
}

/**
 * Implementation of {@link searchCorpus} with an injected embed function.
 * Exported (test seam) so the embed-then-KNN path can be exercised without a
 * network call or API key: tests pass a stub `embed` returning a fixed
 * vector + dimension. The public `searchCorpus` binds the real `embedBatch`.
 */
export async function searchCorpusWith(
  query: string,
  opts: SearchOptions,
  embed: EmbedFn
): Promise<SearchResponse> {
  try {
    const project = getCurrentProject();
    if (!project) throw new Error("no project initialized");

    // 1. Status: is the corpus embedded at all? `dimensions===0` means the
    //    vec0 table hasn't been created yet (no successful embed); `done===0`
    //    means no chunk has a vector. Either way: empty result, NOT an error,
    //    so the UI can prompt "embed first". We do NOT touch the API key or
    //    call the embed provider in this branch — graceful degradation.
    const status = getEmbeddingStatus();
    if (status.dimensions === 0 || status.done === 0) {
      return {
        hits: [],
        total: 0,
        dimensions: status.dimensions,
        embedded: false,
      };
    }

    // 2. Resolve the embed binding (single source of truth): engine derived
    //    from the provider `type` (google → google adapter; else openai).
    const cfg = getSettings().resolved?.embed;
    if (!cfg?.apiUrl || !cfg?.model) {
      throw new Error(
        "no embed provider/model bound — set one in Settings → Functions",
      );
    }
    const engine: EmbedEngine = adapterFromType(cfg.type);
    const apiUrl = cfg.apiUrl;
    const model = cfg.model;

    // 3. Embed the query (key flows in ONLY via opts.apiKey → header inside
    //    the adapter). `embedBatch` wraps adapter errors as
    //    `Error("embed failed: ...")`.
    const result = await embed([query], engine, {
      apiKey: opts.apiKey,
      apiUrl,
      model,
    });
    const qvec = result.vectors[0];
    if (!qvec || qvec.length === 0) {
      throw new Error("query embedding returned an empty vector");
    }
    // Hard rule #2: the query dim MUST equal the locked dim.
    if (result.dimensions !== status.dimensions) {
      throw new Error(
        `query dimension mismatch: locked ${status.dimensions}, got ${result.dimensions}`
      );
    }

    // 4. KNN over the vec0 table. The query vector is bound as a packed
    //    little-endian float BLOB via `new Float32Array(qvec)` — the SAME
    //    binding the INSERT path in `embedPending` uses (bun:sqlite binds
    //    Float32Array as a BLOB; sqlite-vec accepts it for `MATCH`). `k=?` is
    //    the KNN result cap; with a source filter we bump it to leave
    //    headroom (the cap is applied BEFORE the join/source filter, so a
    //    tight k + sourceId could starve results).
    const limit = clampLimit(opts.limit);
    const minScore = opts.minScore ?? 0;
    const k = opts.sourceId ? Math.max(limit * 8, 64) : limit;
    const sql = buildKnQuery(opts.sourceId !== undefined);
    // `SQLQueryBindings` covers string | number | NodeJS.TypedArray
    // (Float32Array) | bigint | boolean | null — the four value kinds here.
    const params: SQLQueryBindings[] = [
      new Float32Array(qvec),
      k,
      ...(opts.sourceId !== undefined ? [opts.sourceId] : []),
      limit,
    ];
    const rows = project.db.prepare(sql).all(...params) as KnRow[];

    // 5. Map to SearchHit[], convert distance→score, apply the minScore
    //    floor, sort by score desc (rows already come nearest-first from
    //    ORDER BY distance, but re-sort defensively after the floor cut),
    //    and truncate the text snippet.
    const hits: SearchHit[] = [];
    for (const r of rows) {
      const score = distanceToScore(r.distance);
      if (score < minScore) continue;
      hits.push({
        chunkId: r.chunk_id,
        sourceId: r.source_file_id,
        relPath: r.rel_path,
        filename: r.filename,
        physicalPage: r.physical_page,
        printedPage: r.printed_page,
        text: snippet(r.text ?? ""),
        score,
      });
    }
    hits.sort((a, b) => b.score - a.score);

    return {
      hits,
      total: hits.length,
      dimensions: status.dimensions,
      embedded: true,
    };
  } catch (e) {
    throw new Error(`search failed: ${(e as Error)?.message ?? String(e)}`);
  }
}
