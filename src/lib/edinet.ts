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
 * eagerly for every matching filer (see fetchRecentFilings). The
 * financial figures inside each filing are a separate, heavier fetch —
 * downloading and unzipping a CSV package per document (see
 * fetchFinancialsForFiling / edinetFinancials.ts) — so scripts/fetch-
 * edinet.ts only does that for recently-submitted filings, not the full
 * metadata window; see that script for why.
 */

import { extractFinancialsFromZip, type FinancialPeriod } from "./edinetFinancials";

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

/** Downloads an EDINET filing's CSV package (書類取得API type=5) as raw bytes. */
export async function fetchDocumentCsvZip(
  docId: string,
  options: FetchEdinetOptions = {}
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
    return new Uint8Array(await res.arrayBuffer());
  } finally {
    clearTimeout(timeout);
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

  const results = await Promise.allSettled(
    dates.map((date) => fetchFilingsForDate(date, options))
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

export function filterFilingsByCodes(
  filings: EdinetFiling[],
  codes: string[]
): EdinetFiling[] {
  const wanted = new Set(codes.map(normalizeCode));
  return filings.filter((f) => f.secCode !== null && wanted.has(f.secCode));
}
