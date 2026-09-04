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
 * DAYS is a safety margin, not the retention policy: the browser
 * (src/lib/watchlist.ts) merges every matching filing it sees into a
 * permanent per-visitor archive in localStorage, so once a filing has
 * been fetched at least once it's kept regardless of DAYS. DAYS only
 * matters for a visitor who hasn't opened the site in longer than this
 * many days.
 *
 * Financial figures (see src/lib/edinetFinancials.ts) are a separate,
 * much heavier fetch per filing — download + unzip + parse a CSV package
 * — and unlike the metadata list, a given filing's figures never change
 * once published. Re-extracting them for the same DAYS-day window on
 * every 15-minute run would be pure waste, so that pass only covers the
 * last FINANCIALS_DAYS days: cheap enough to repeat every run, and (since
 * the deploy workflow's cron runs every 15 min on weekdays) still catches
 * every filing shortly after it's submitted. The trade-off: a filing
 * missed during that window (e.g. a visitor away for a month, or a run
 * outage) shows up later with metadata but no figures, since nothing
 * re-attempts the extraction once a filing has aged out of this shorter
 * window. A persisted cross-run cache would remove that gap, but means
 * committing generated data back to the repo (the workflow would need
 * `contents: write`), which is a bigger change than this feature
 * warrants for now.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fetchFinancialsForFiling, fetchRecentFilings, type EdinetFiling } from "../src/lib/edinet";

const DAYS = 30;
const FINANCIALS_DAYS = 3;
const FINANCIALS_CONCURRENCY = 5;

async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

async function attachRecentFinancials(filings: EdinetFiling[]): Promise<EdinetFiling[]> {
  const cutoff = Date.now() - FINANCIALS_DAYS * 24 * 60 * 60 * 1000;
  const recent = filings.filter((f) => new Date(f.submittedAt).getTime() >= cutoff);
  if (recent.length === 0) return filings;

  console.log(
    `Extracting financial highlights for ${recent.length} filing(s) from the last ${FINANCIALS_DAYS} day(s)...`
  );

  const byDocId = new Map(filings.map((f) => [f.docId, f]));
  await mapWithConcurrency(recent, FINANCIALS_CONCURRENCY, async (filing) => {
    try {
      const financials = await fetchFinancialsForFiling(filing.docId);
      if (financials.length > 0) {
        byDocId.set(filing.docId, { ...filing, financials });
      }
    } catch (err) {
      console.warn(`Failed to extract financials for ${filing.docId} (${filing.filerName}):`, err);
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

  const filings = await attachRecentFinancials(await fetchRecentFilings(DAYS));

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
