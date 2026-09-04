/**
 * Client for EDINET (the FSA's disclosure system under the Financial
 * Instruments and Exchange Act) securities/quarterly/半期 report metadata.
 *
 * Not to be confused with TSE's TDnet, which is a separate system for
 * *timely disclosures* (earnings summaries, corporate actions). 有価証券
 * 報告書 (annual securities reports) and 四半期報告書/半期報告書
 * (quarterly / half-year reports) are filed with the FSA via EDINET
 * instead — TSE is not involved in collecting or publishing them. Note
 * also that 四半期報告書 itself was abolished as a mandatory filing for
 * fiscal years starting on or after 2024-04-01: most companies now file
 * only Q2 as 半期報告書 (via EDINET) with Q1/Q3 covered by a 四半期決算
 * 短信 on TDnet instead, so docTypeCode "140" below will naturally become
 * rarer over time while "160" grows — both are kept since transitional/
 * legacy filings can still appear.
 *
 * EDINET API v2 (https://api.edinet-fsa.go.jp/api/v2) requires a free
 * Subscription-Key issued via EDINET's own API user registration, sent as
 * a query parameter. This shape is based on EDINET's published API v2
 * documentation, not a live call — outbound network in this environment
 * is restricted to an allowlist that does not include this host — so
 * parsing here is defensive: unrecognized/incomplete entries are skipped
 * rather than throwing.
 *
 * Filing metadata (who filed what, for which period, when) is fetched
 * eagerly for every matching filer (see fetchRecentFilings). Both the
 * financial highlights and the "事業の内容" business-description text
 * inside a filing are separate, heavier fetches — downloading and
 * unzipping a CSV package per document (see fetchFinancialsForFiling and
 * fetchBusinessDescriptionForFiling / edinetFinancials.ts) — so
 * scripts/fetch-edinet.ts is selective about which filings it tries that
 * for; see that script for the reasoning.
 */

import {
  extractBusinessDescriptionFromZip,
  extractFinancialsFromZip,
  type FinancialPeriod,
} from "./edinetFinancials";

export type { FinancialPeriod } from "./edinetFinancials";

export interface EdinetFiling {
  docId: string;
  edinetCode: string | null;
  /** Normalized 4-character TSE ticker, or null for an unlisted filer. */
  secCode: string | null;
  filerName: string;
  docTypeCode: string;
  docTypeLabel: string;
  docDescription: string | null;
  periodStart: string | null;
  periodEnd: string | null;
  submittedAt: string;
  /**
   * Financial highlights extracted from the filing's CSV package, if
   * scripts/fetch-edinet.ts attempted and succeeded at that for this
   * filing (only tried for recent filings — see that script). Absent
   * otherwise; never an empty array.
   */
  financials?: FinancialPeriod[];
  /**
   * The filer's "事業の内容" (description of business) text, if
   * scripts/fetch-edinet.ts attempted and succeeded at that for this
   * filing. Only attempted for each company's single most recent 有価証券
   * 報告書 (see that script), so this is absent on every other filing.
   */
  businessDescription?: string;
}

const DEFAULT_BASE_URL = "https://api.edinet-fsa.go.jp/api/v2";

const DOC_TYPE_LABELS: Record<string, string> = {
  "120": "有価証券報告書",
  "130": "訂正有価証券報告書",
  "140": "四半期報告書",
  "150": "訂正四半期報告書",
  "160": "半期報告書",
  "170": "訂正半期報告書",
};

interface RawEdinetDoc {
  docID?: string | null;
  edinetCode?: string | null;
  secCode?: string | null;
  filerName?: string | null;
  docTypeCode?: string | null;
  docDescription?: string | null;
  periodStart?: string | null;
  periodEnd?: string | null;
  submitDateTime?: string | null;
  withdrawalStatus?: string | null;
}

interface RawEdinetListResponse {
  metadata?: { status?: string; message?: string };
  results?: RawEdinetDoc[];
}

function toIsoDate(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/**
 * EDINET's submitDateTime is "YYYY-MM-DD HH:MM" in JST (no timezone, no
 * seconds). Normalize to a proper ISO 8601 string so downstream Date
 * parsing/sorting is reliable across browsers — a bare space-separated
 * string isn't guaranteed to parse the same way everywhere. Left as-is if
 * it doesn't match the expected shape (e.g. already ISO, as in tests).
 */
function toIsoSubmittedAt(raw: string): string {
  const match = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2})$/.exec(raw.trim());
  if (!match) return raw;
  return `${match[1]}T${match[2]}:00+09:00`;
}

/** Ticker codes are compared by their first 4 alphanumeric characters, uppercased. */
export function normalizeCode(code: string): string {
  return code.trim().replace(/[^0-9A-Za-z]/g, "").slice(0, 4).toUpperCase();
}

/** EDINET's secCode is the 4-digit/char TSE ticker plus a trailing check digit. */
export function normalizeSecCode(secCode: string | null | undefined): string | null {
  if (!secCode) return null;
  const normalized = normalizeCode(secCode);
  return normalized.length === 4 ? normalized : null;
}

/**
 * The public, no-API-key URL for a filing's PDF on EDINET's own disclosure
 * site (disclosure2dl.edinet-fsa.go.jp — a static-file host, separate from
 * the authenticated api.edinet-fsa.go.jp used elsewhere in this file).
 * Anyone can view/download a filing's PDF at this URL in a browser; it's
 * how EDINET's own search results link out to documents. Not every filing
 * necessarily has a PDF at this exact path (a very small number of doc
 * types don't), so a 404 here is possible but rare.
 */
export function edinetDocumentPdfUrl(docId: string): string {
  return `https://disclosure2dl.edinet-fsa.go.jp/searchdocument/pdf/${docId}.pdf`;
}

function normalizeDoc(raw: RawEdinetDoc): EdinetFiling | null {
  const docId = raw.docID;
  const docTypeCode = raw.docTypeCode;
  const filerName = raw.filerName;
  const submittedAt = raw.submitDateTime;

  if (!docId || !docTypeCode || !filerName || !submittedAt) return null;
  const docTypeLabel = DOC_TYPE_LABELS[docTypeCode];
  if (!docTypeLabel) return null;
  if (raw.withdrawalStatus === "1") return null;

  return {
    docId,
    edinetCode: raw.edinetCode ?? null,
    secCode: normalizeSecCode(raw.secCode),
    filerName,
    docTypeCode,
    docTypeLabel,
    docDescription: raw.docDescription ?? null,
    periodStart: raw.periodStart ?? null,
    periodEnd: raw.periodEnd ?? null,
    submittedAt: toIsoSubmittedAt(submittedAt),
  };
}

export interface FetchEdinetOptions {
  baseUrl?: string;
  apiKey?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /** Only used by fetchDocumentCsvZip's rate-limit retry. Defaults to 5. */
  maxRetries?: number;
  /** Only used by fetchDocumentCsvZip's rate-limit retry. Defaults to 3000 (doubles each attempt). */
  retryDelayMs?: number;
}

/**
 * EDINET signals "too many requests" as an HTTP **200** whose body is
 * `{"StatusCode":"429","message":"Too Many Requests"}` — a real 429/503
 * would be caught by `!res.ok` above, but this one isn't, so it has to be
 * detected from the body itself. Confirmed against production logs: under
 * sustained concurrency-10 load across ~3,800 documents, this was the
 * dominant cause of business-description extraction failures (see
 * scripts/fetch-edinet.ts's BUSINESS_DESCRIPTION_CONCURRENCY).
 */
class EdinetRateLimitError extends Error {
  constructor(docId: string) {
    super(`EDINET rate limit hit for ${docId} (HTTP 200 body reported StatusCode 429)`);
    this.name = "EdinetRateLimitError";
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function fetchFilingsForDate(
  date: Date,
  options: FetchEdinetOptions = {}
): Promise<EdinetFiling[]> {
  const baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 15_000;
  const apiKey = options.apiKey ?? process.env.EDINET_API_KEY;

  if (!apiKey) {
    throw new Error("EDINET_API_KEY is required (EDINET API v2 Subscription-Key)");
  }

  const dateStr = toIsoDate(date);
  const url = `${baseUrl}/documents.json?date=${dateStr}&type=2&Subscription-Key=${encodeURIComponent(apiKey)}`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { signal: controller.signal });
    if (!res.ok) {
      throw new Error(`EDINET request failed: ${res.status} ${res.statusText}`);
    }
    const payload = (await res.json()) as RawEdinetListResponse;
    if (payload.metadata?.status && payload.metadata.status !== "200") {
      throw new Error(
        `EDINET API error: ${payload.metadata.status} ${payload.metadata.message ?? ""}`.trim()
      );
    }
    const results = payload.results ?? [];
    return results.map(normalizeDoc).filter((v): v is EdinetFiling => v !== null);
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchDocumentCsvZipOnce(
  docId: string,
  options: FetchEdinetOptions
): Promise<Uint8Array> {
  const baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 30_000;
  const apiKey = options.apiKey ?? process.env.EDINET_API_KEY;

  if (!apiKey) {
    throw new Error("EDINET_API_KEY is required (EDINET API v2 Subscription-Key)");
  }

  const url = `${baseUrl}/documents/${docId}?type=5&Subscription-Key=${encodeURIComponent(apiKey)}`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { signal: controller.signal });
    if (!res.ok) {
      throw new Error(`EDINET document download failed: ${res.status} ${res.statusText}`);
    }
    const bytes = new Uint8Array(await res.arrayBuffer());

    // A 200 response isn't necessarily a real zip — some APIs return an
    // HTML/JSON error or rate-limit notice with a 200 status. Check the
    // zip magic bytes ("PK") ourselves so a bad body produces a diagnostic
    // error here (with the response's own content-type and a text preview)
    // instead of the opaque "invalid zip data" fflate throws later, deep
    // inside extractFinancialsFromZip/extractBusinessDescriptionFromZip.
    const looksLikeZip = bytes.length >= 2 && bytes[0] === 0x50 && bytes[1] === 0x4b; // "PK"
    if (!looksLikeZip) {
      const contentType = res.headers.get("content-type") ?? "(no content-type)";
      const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);

      if (contentType.includes("json")) {
        try {
          const parsed = JSON.parse(text) as { StatusCode?: string; metadata?: { status?: string } };
          if (parsed.StatusCode === "429" || parsed.metadata?.status === "429") {
            throw new EdinetRateLimitError(docId);
          }
        } catch (err) {
          if (err instanceof EdinetRateLimitError) throw err;
          // Not parseable JSON despite the content-type — fall through to
          // the generic diagnostic error below.
        }
      }

      const preview = text.replace(/\s+/g, " ").trim().slice(0, 200);
      throw new Error(
        `EDINET document response for ${docId} doesn't look like a zip file ` +
          `(content-type: ${contentType}, ${bytes.length} bytes, starts with: "${preview}")`
      );
    }

    return bytes;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Downloads an EDINET filing's CSV package (書類取得API type=5) as raw
 * bytes, retrying with exponential backoff when EDINET reports a rate limit
 * (see EdinetRateLimitError above). Other failures (a genuine 404 for a
 * document with no CSV package, a network error, etc.) are not retried —
 * they won't resolve by waiting.
 */
export async function fetchDocumentCsvZip(
  docId: string,
  options: FetchEdinetOptions = {}
): Promise<Uint8Array> {
  const maxRetries = options.maxRetries ?? 5;
  const retryDelayMs = options.retryDelayMs ?? 3000;

  for (let attempt = 0; ; attempt++) {
    try {
      return await fetchDocumentCsvZipOnce(docId, options);
    } catch (err) {
      if (!(err instanceof EdinetRateLimitError) || attempt >= maxRetries) {
        throw err;
      }
      await sleep(retryDelayMs * 2 ** attempt);
    }
  }
}

/** Downloads and parses one filing's financial highlights. See edinetFinancials.ts. */
export async function fetchFinancialsForFiling(
  docId: string,
  options: FetchEdinetOptions = {}
): Promise<FinancialPeriod[]> {
  const zipBytes = await fetchDocumentCsvZip(docId, options);
  return extractFinancialsFromZip(zipBytes);
}

/** Downloads and parses one filing's "事業の内容" text. See edinetFinancials.ts. */
export async function fetchBusinessDescriptionForFiling(
  docId: string,
  options: FetchEdinetOptions = {}
): Promise<string | null> {
  const zipBytes = await fetchDocumentCsvZip(docId, options);
  return extractBusinessDescriptionFromZip(zipBytes);
}

/**
 * Runs `fn` over `items` with at most `limit` in flight at once, resolving
 * once every item has settled (never rejects itself — failures are
 * reported per-item, same shape as Promise.allSettled). Used to bound how
 * many concurrent requests this module ever makes to EDINET at once,
 * whether that's dozens of date-list lookups or thousands of per-document
 * downloads (see scripts/fetch-edinet.ts).
 */
export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>
): Promise<PromiseSettledResult<R>[]> {
  const results: PromiseSettledResult<R>[] = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      try {
        results[i] = { status: "fulfilled", value: await fn(items[i]) };
      } catch (reason) {
        results[i] = { status: "rejected", reason };
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

// How many /documents.json date-list requests to have in flight at once.
// These are cheap (metadata only), but a wide DAYS window (see
// scripts/fetch-edinet.ts) can mean hundreds of them — bounding this keeps
// that from turning into hundreds of simultaneous connections.
const LIST_FETCH_CONCURRENCY = 10;

export async function fetchRecentFilings(
  days: number,
  options: FetchEdinetOptions = {}
): Promise<EdinetFiling[]> {
  const today = new Date();
  const dates = Array.from({ length: days }, (_, i) => {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    return d;
  });

  const results = await mapWithConcurrency(dates, LIST_FETCH_CONCURRENCY, (date) =>
    fetchFilingsForDate(date, options)
  );

  if (results.every((r) => r.status === "rejected")) {
    const firstReason = (results[0] as PromiseRejectedResult).reason;
    throw new Error("Failed to fetch EDINET filings for any recent date", {
      cause: firstReason,
    });
  }

  const all = results.flatMap((r) => (r.status === "fulfilled" ? r.value : []));

  const byId = new Map<string, EdinetFiling>();
  for (const item of all) {
    byId.set(item.docId, item);
  }

  return Array.from(byId.values()).sort(
    (a, b) => new Date(b.submittedAt).getTime() - new Date(a.submittedAt).getTime()
  );
}

export interface EdinetFilingsSnapshot {
  generatedAt: string | null;
  days: number;
  filings: EdinetFiling[];
}

/**
 * Loads the pre-fetched, same-origin snapshot at /edinet-filings.json
 * (built by scripts/fetch-edinet.ts). A 404 is treated as "not built yet"
 * (e.g. the EDINET_API_KEY repo secret hasn't been set up) rather than an
 * error, so the UI can show a "not configured yet" message instead of a
 * scary error.
 */
export async function fetchEdinetFilingsSnapshot(
  fetchImpl: typeof fetch = fetch
): Promise<EdinetFilingsSnapshot> {
  const basePath = process.env.NEXT_PUBLIC_BASE_PATH ?? "";
  const res = await fetchImpl(`${basePath}/edinet-filings.json`, {
    cache: "no-store",
  });
  if (res.status === 404) {
    return { generatedAt: null, days: 0, filings: [] };
  }
  if (!res.ok) {
    throw new Error(`Failed to load EDINET filings snapshot: ${res.status} ${res.statusText}`);
  }
  return (await res.json()) as EdinetFilingsSnapshot;
}

/**
 * Filters filings by a free-text query, matched against the company name
 * (substring, case-insensitive), the ticker code (prefix match against the
 * normalized 4-character code), or the business description text when
 * present (substring, case-insensitive — e.g. "GPU", "ドローン"). An
 * empty/whitespace-only query matches everything, so this doubles as the
 * "no filter" case.
 */
export function searchFilings(filings: EdinetFiling[], query: string): EdinetFiling[] {
  const trimmed = query.trim();
  if (!trimmed) return filings;

  const lowerQuery = trimmed.toLowerCase();
  const normalizedCode = normalizeCode(trimmed);

  return filings.filter((f) => {
    if (f.filerName.toLowerCase().includes(lowerQuery)) return true;
    if (normalizedCode.length > 0 && f.secCode !== null && f.secCode.startsWith(normalizedCode)) {
      return true;
    }
    return f.businessDescription !== undefined && f.businessDescription.toLowerCase().includes(lowerQuery);
  });
}
