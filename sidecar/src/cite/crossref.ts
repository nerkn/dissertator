import type { Author, Reference } from "@dissertator/shared";

export interface CrossrefOpts {
  contactEmail?: string;
  fetch?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
}

const CROSSREF_BASE = "https://api.crossref.org/works";

const SEARCH_ROWS = 20;

function userAgent(contactEmail?: string): string {
  const e = (contactEmail ?? "").trim();
  if (e) {
    return `Dissertator/0.1 (https://github.com/nerkn/dissertator; mailto:${e})`;
  }
  return "Dissertator/0.1";
}

interface CrossrefAuthor {
  family?: string;
  given?: string;
}

interface CrossrefDate {
  "date-parts"?: number[][];
}

export interface CrossrefWork {
  DOI?: string;
  type?: string;
  title?: string[];
  "container-title"?: string[];
  author?: CrossrefAuthor[];
  "published-print"?: CrossrefDate;
  "published-online"?: CrossrefDate;
  issued?: CrossrefDate;
  [k: string]: unknown;
}

interface CrossrefSearchEnvelope {
  message?: { items?: CrossrefWork[] };
}

interface CrossrefDoiEnvelope {
  message?: CrossrefWork;
}

function yearOf(work: CrossrefWork): number | null {
  const candidates = [
    work["published-print"],
    work["published-online"],
    work.issued,
  ];
  for (const d of candidates) {
    const y = d?.["date-parts"]?.[0]?.[0];
    if (typeof y === "number" && y > 0) return y;
  }
  return null;
}

function first(arr: string[] | undefined): string | null {
  if (!arr || arr.length === 0) return null;
  const v = arr[0];
  return v && v.trim() ? v : null;
}

export function mapCrossrefToReference(work: CrossrefWork): Reference {
  const authors: Author[] = (work.author ?? []).map((a) => ({
    family: a.family,
    given: a.given,
  }));
  return {
    id: "",
    citekey: "",
    title: first(work.title),
    authors,
    year: yearOf(work),
    doi: work.DOI ?? null,
    type: work.type ?? null,
    venue: first(work["container-title"]),
    csl_json: work as Record<string, unknown>,
    source_file_id: null,
  };
}

export async function crossrefSearch(
  query: string,
  opts: CrossrefOpts = {}
): Promise<Reference[]> {
  const doFetch = opts.fetch ?? fetch;
  const url = `${CROSSREF_BASE}?query=${encodeURIComponent(query)}&rows=${SEARCH_ROWS}`;
  try {
    const res = await doFetch(url, {
      headers: { "User-Agent": userAgent(opts.contactEmail) },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.error(
        `[crossref] search ${res.status} for "${query}": ${body.slice(0, 300)}`
      );
      return [];
    }
    const env = (await res.json()) as CrossrefSearchEnvelope;
    const items = env?.message?.items ?? [];
    return items.map(mapCrossrefToReference);
  } catch (e) {
    console.error(
      `[crossref] search failed for "${query}":`,
      (e as Error)?.message ?? String(e)
    );
    return [];
  }
}

export async function crossrefByDoi(
  doi: string,
  opts: CrossrefOpts = {}
): Promise<Reference | null> {
  const doFetch = opts.fetch ?? fetch;
  const clean = doi.trim();
  if (!clean) return null;
  const url = `${CROSSREF_BASE}/${encodeURIComponent(clean)}`;
  try {
    const res = await doFetch(url, {
      headers: { "User-Agent": userAgent(opts.contactEmail) },
    });
    if (res.status === 404) return null;
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.error(
        `[crossref] doi ${res.status} for "${clean}": ${body.slice(0, 300)}`
      );
      return null;
    }
    const env = (await res.json()) as CrossrefDoiEnvelope;
    const work = env?.message;
    if (!work) return null;
    return mapCrossrefToReference(work);
  } catch (e) {
    console.error(
      `[crossref] doi lookup failed for "${clean}":`,
      (e as Error)?.message ?? String(e)
    );
    return null;
  }
}
