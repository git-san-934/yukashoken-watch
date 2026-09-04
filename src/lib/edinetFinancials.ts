/**
 * Extracts the standardized "主要な経営指標等の推移" (business results
 * highlights) figures from an EDINET filing's CSV output package (書類取得
 * API type=5). This table is required in every 有価証券報告書/四半期報告書/
 * 半期報告書 regardless of the filer's accounting standard (JGAAP/IFRS/
 * US-GAAP), which is what makes it a practical, consistent place to pull
 * headline numbers from without handling every standard's full financial-
 * statement taxonomy.
 *
 * As with the rest of this EDINET integration (see edinet.ts), the CSV
 * package's exact shape — UTF-16LE encoding, tab-separated, double-quoted
 * fields, these column names — is based on FSA's published CSV output
 * spec, not verified against a live download: outbound network in this
 * environment can't reach EDINET. Parsing is correspondingly defensive:
 * unrecognized rows/files are skipped rather than thrown on, and a UTF-8
 * decode is tried if UTF-16LE doesn't look right. This needs validating
 * against a real downloaded package the first time it runs for real (in
 * CI, with an actual EDINET_API_KEY).
 *
 * Deliberately reads period ("相対年度": 当期/1期前/…) and consolidation
 * ("連結・個別": 連結/個別) straight from EDINET's own CSV columns rather
 * than trying to reverse-engineer them from the XBRL contextRef naming
 * convention — those columns are already human-readable text meant for
 * exactly this, so there's no need to duplicate that logic less reliably.
 */
import { unzipSync } from "fflate";

export interface FinancialPeriod {
  /** EDINET's own "相対年度" column value, e.g. "当期", "1期前". */
  periodLabel: string;
  /** From EDINET's own "連結・個別" column: true for "連結", false for "個別". */
  consolidated: boolean;
  netSales: number | null;
  operatingIncome: number | null;
  ordinaryIncome: number | null;
  profit: number | null;
  basicEarningsPerShare: number | null;
  totalAssets: number | null;
  netAssets: number | null;
}

type MetricKey = Exclude<keyof FinancialPeriod, "periodLabel" | "consolidated">;

// Matched by suffix (not exact equality) since the element's namespace
// prefix can vary (e.g. jpcrp_cor vs. a form-specific namespace).
const METRIC_ELEMENT_SUFFIXES: Record<MetricKey, string> = {
  netSales: "NetSalesSummaryOfBusinessResults",
  operatingIncome: "OperatingIncomeSummaryOfBusinessResults",
  ordinaryIncome: "OrdinaryIncomeSummaryOfBusinessResults",
  profit: "ProfitLossAttributableToOwnersOfParentSummaryOfBusinessResults",
  basicEarningsPerShare: "BasicEarningsPerShareSummaryOfBusinessResults",
  totalAssets: "TotalAssetsSummaryOfBusinessResults",
  netAssets: "NetAssetsSummaryOfBusinessResults",
};

const METRIC_ENTRIES = Object.entries(METRIC_ELEMENT_SUFFIXES) as [MetricKey, string][];

function metricKeyForElementId(elementId: string): MetricKey | null {
  for (const [key, suffix] of METRIC_ENTRIES) {
    if (elementId.endsWith(suffix)) return key;
  }
  return null;
}

/**
 * EDINET's CSV output is UTF-16LE with a BOM. Falls back to UTF-8 if that
 * doesn't decode into something recognizable (e.g. an unexpected real-world
 * encoding, or a plain-UTF-8 fixture in tests).
 */
function decodeCsvText(bytes: Uint8Array): string {
  const utf16 = new TextDecoder("utf-16le").decode(bytes);
  if (utf16.includes("要素ID")) return utf16;
  return new TextDecoder("utf-8").decode(bytes);
}

function splitCsvLine(line: string): string[] {
  return line.split("\t").map((field) => {
    const trimmed = field.trim();
    if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
      return trimmed.slice(1, -1).replace(/""/g, '"');
    }
    return trimmed;
  });
}

function parseCsvRows(text: string): Record<string, string>[] {
  const lines = text.split(/\r\n|\r|\n/).filter((line) => line.trim() !== "");
  if (lines.length === 0) return [];
  const header = splitCsvLine(lines[0]);
  return lines.slice(1).map((line) => {
    const fields = splitCsvLine(line);
    const row: Record<string, string> = {};
    header.forEach((name, i) => {
      row[name] = fields[i] ?? "";
    });
    return row;
  });
}

function parseNumber(raw: string): number | null {
  const cleaned = raw.replace(/,/g, "").trim();
  if (cleaned === "" || cleaned === "－" || cleaned === "-") return null;
  const value = Number(cleaned);
  return Number.isFinite(value) ? value : null;
}

function emptyPeriod(periodLabel: string, consolidated: boolean): FinancialPeriod {
  return {
    periodLabel,
    consolidated,
    netSales: null,
    operatingIncome: null,
    ordinaryIncome: null,
    profit: null,
    basicEarningsPerShare: null,
    totalAssets: null,
    netAssets: null,
  };
}

/**
 * Parses one EDINET CSV file's rows into per-period financial highlight
 * records, keyed by (相対年度, 連結・個別) so repeated rows for the same
 * period/basis merge into a single record instead of duplicating.
 */
function extractFromCsvText(text: string): FinancialPeriod[] {
  const rows = parseCsvRows(text);
  const periods = new Map<string, FinancialPeriod>();

  for (const row of rows) {
    const elementId = row["要素ID"];
    const periodLabel = row["相対年度"];
    const rawValue = row["値"];
    if (!elementId || !periodLabel || rawValue === undefined) continue;

    const metricKey = metricKeyForElementId(elementId);
    if (!metricKey) continue;

    const consolidated = row["連結・個別"] !== "個別";
    const mapKey = `${periodLabel}::${consolidated ? "consolidated" : "individual"}`;
    const period = periods.get(mapKey) ?? emptyPeriod(periodLabel, consolidated);
    period[metricKey] = parseNumber(rawValue);
    periods.set(mapKey, period);
  }

  return Array.from(periods.values());
}

/**
 * Unzips an EDINET CSV package (書類取得API type=5 response body) and
 * extracts financial highlight periods from every .csv file inside it.
 * Scans by file extension rather than a hardcoded folder/file name, since
 * the exact internal layout isn't something this environment could verify
 * live — files that don't look like the expected CSV are simply skipped.
 */
export function extractFinancialsFromZip(zipBytes: Uint8Array): FinancialPeriod[] {
  const files = unzipSync(zipBytes);
  const results: FinancialPeriod[] = [];
  for (const [name, bytes] of Object.entries(files)) {
    if (!name.toLowerCase().endsWith(".csv")) continue;
    try {
      results.push(...extractFromCsvText(decodeCsvText(bytes)));
    } catch {
      // Skip a file we can't read rather than failing the whole document.
    }
  }
  return results;
}
