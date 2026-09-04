/**
 * Fetches recently-submitted EDINET filings (有価証券報告書・四半期報告書・
 * 半期報告書, all listed companies, not just any one visitor's watchlist)
 * and writes them to public/edinet-filings.json so the static site can
 * read them same-origin at runtime. See src/lib/edinet.ts for background
 * on EDINET vs TSE's TDnet.
 *
 * Run via `npx tsx scripts/fetch-edinet.ts`. See .github/workflows/deploy.yml
 * for how this fits into the build.
 *
 * Requires an EDINET_API_KEY env var (a free EDINET API v2 Subscription-Key
 * — see README for how to obtain one). A missing key only skips this step
 * (leaving public/edinet-filings.json unwritten, which src/lib/edinet.ts's
 * snapshot loader treats as "not built yet") rather than failing the whole
 * deploy — so the site can go live with an empty state before the key is
 * configured, instead of never deploying at all.
 *
 * DAYS is 400 (a bit over a year), not the usual "safety margin" window a
 * TDnet-style live feed would use: every listed company files exactly one
 * 有価証券報告書 a year, but on a date that depends on its own fiscal
 * year end, so covering "every currently-listed company's latest annual
 * report" means covering a full year of filing dates, not just the last
 * few weeks. Every run rebuilds the snapshot from scratch (there is no
 * cross-run cache — see below), so this window is what "全上場企業"
 * actually means in practice here.
 *
 * Financial figures and the "事業の内容" business-description text (see
 * src/lib/edinetFinancials.ts) are both separate, much heavier fetches per
 * filing — download + unzip + parse a CSV package — and unlike the
 * metadata list, neither changes once published. Re-extracting them for
 * the same DAYS-day window on every run would be pure waste:
 *
 * - Financial highlights only cover filings from the last FINANCIALS_DAYS
 *   days, cheap enough to repeat every run.
 * - The business description only covers each company's single most
 *   recent 有価証券報告書 (docTypeCode "120") within the DAYS window —
 *   effectively one document per currently-listed company (~4,000) — since
 *   a company's business description is what matters for search, not its
 *   full filing history.
 *
 * Even bounded that way, ~4,000 extra downloads is real load, both on
 * EDINET and on this workflow's run time — acceptable for a schedule that
 * runs once a day (see deploy.yml's cron), not something that should run
 * every few minutes. A persisted cross-run cache would let this narrow
 * back down to "only new/changed companies since last time" regardless of
 * schedule, but means committing generated data back to the repo (the
 * workflow would need `contents: write`), which is a bigger change than
 * this feature warrants for now — this whole file trades some repeated
 * work for staying simple and stateless.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  fetchBusinessDescriptionForFiling,
  fetchFinancialsForFiling,
  fetchRecentFilings,
  mapWithConcurrency,
  type EdinetFiling,
} from "../src/lib/edinet";

const DAYS = 400;
const FINANCIALS_DAYS = 3;
const FINANCIALS_CONCURRENCY = 5;
const BUSINESS_DESCRIPTION_CONCURRENCY = 10;
const ANNUAL_REPORT_DOC_TYPE_CODE = "120"; // 有価証券報告書 (not its 訂正/quarterly/half-year siblings)

async function attachRecentFinancials(filings: EdinetFiling[]): Promise<EdinetFiling[]> {
  const cutoff = Date.now() - FINANCIALS_DAYS * 24 * 60 * 60 * 1000;
  const recent = filings.filter((f) => new Date(f.submittedAt).getTime() >= cutoff);
  if (recent.length === 0) return filings;

  console.log(
    `Extracting financial highlights for ${recent.length} filing(s) from the last ${FINANCIALS_DAYS} day(s)...`
  );

  const byDocId = new Map(filings.map((f) => [f.docId, f]));
  const results = await mapWithConcurrency(recent, FINANCIALS_CONCURRENCY, (filing) =>
    fetchFinancialsForFiling(filing.docId)
  );

  recent.forEach((filing, i) => {
    const result = results[i];
    if (result.status === "fulfilled") {
      if (result.value.length > 0) {
        byDocId.set(filing.docId, { ...filing, financials: result.value });
      }
    } else {
      console.warn(`Failed to extract financials for ${filing.docId} (${filing.filerName}):`, result.reason);
    }
  });

  return filings.map((f) => byDocId.get(f.docId) ?? f);
}

/** Each listed company's single most recent 有価証券報告書, if any is in `filings`. */
function latestAnnualReportPerCompany(filings: EdinetFiling[]): EdinetFiling[] {
  const latestByCode = new Map<string, EdinetFiling>();
  for (const filing of filings) {
    if (filing.docTypeCode !== ANNUAL_REPORT_DOC_TYPE_CODE || filing.secCode === null) continue;
    const current = latestByCode.get(filing.secCode);
    if (!current || new Date(filing.submittedAt) > new Date(current.submittedAt)) {
      latestByCode.set(filing.secCode, filing);
    }
  }
  return Array.from(latestByCode.values());
}

async function attachBusinessDescriptions(filings: EdinetFiling[]): Promise<EdinetFiling[]> {
  const targets = latestAnnualReportPerCompany(filings);
  if (targets.length === 0) return filings;

  console.log(
    `Extracting business descriptions for each company's most recent 有価証券報告書 (${targets.length} companies)...`
  );

  const byDocId = new Map(filings.map((f) => [f.docId, f]));
  const results = await mapWithConcurrency(targets, BUSINESS_DESCRIPTION_CONCURRENCY, (filing) =>
    fetchBusinessDescriptionForFiling(filing.docId)
  );

  targets.forEach((filing, i) => {
    const result = results[i];
    if (result.status === "fulfilled") {
      if (result.value) {
        byDocId.set(filing.docId, { ...filing, businessDescription: result.value });
      }
    } else {
      console.warn(
        `Failed to extract business description for ${filing.docId} (${filing.filerName}):`,
        result.reason
      );
    }
  });

  return filings.map((f) => byDocId.get(f.docId) ?? f);
}

async function main() {
  if (!process.env.EDINET_API_KEY) {
    console.warn(
      "EDINET_API_KEY is not set — skipping EDINET filings fetch. " +
        "See README for how to obtain a free EDINET API subscription key and add it as a repo secret."
    );
    return;
  }

  const rawFilings = await fetchRecentFilings(DAYS);
  const withFinancials = await attachRecentFinancials(rawFilings);
  const filings = await attachBusinessDescriptions(withFinancials);

  const outDir = path.join(process.cwd(), "public");
  mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, "edinet-filings.json");

  writeFileSync(
    outPath,
    JSON.stringify({
      generatedAt: new Date().toISOString(),
      days: DAYS,
      filings,
    })
  );

  console.log(`Wrote ${filings.length} EDINET filings (last ${DAYS} days) to ${outPath}`);
}

main().catch((err) => {
  console.error("Failed to fetch EDINET filings:", err);
  process.exit(1);
});
