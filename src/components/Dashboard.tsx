"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { edinetDocumentPdfUrl, fetchEdinetFilingsSnapshot, searchFilings, type EdinetFiling } from "@/lib/edinet";

// The server-side snapshot refreshes once a day (see
// .github/workflows/deploy.yml — the business-description backfill this
// covers is too heavy to run more often than that), so there's no benefit
// to polling more often than this; it just picks up a fresh snapshot for
// a tab left open across that daily refresh.
const AUTO_REFRESH_INTERVAL_MS = 30 * 60 * 1000;

// How much of a matched business description to show inline per filing —
// enough to show why it matched a search, not the whole thing.
const BUSINESS_DESCRIPTION_PREVIEW_LENGTH = 160;

// Rendering every filing in a 1600+-item snapshot at once is wasteful —
// cap the DOM to a reasonable page size. Narrowing the search query is
// the way to see more of a specific company/period.
const MAX_VISIBLE = 200;

function formatDate(iso: string): string {
  try {
    return new Intl.DateTimeFormat("ja-JP", {
      dateStyle: "medium",
      timeStyle: "short",
    }).format(new Date(iso));
  } catch {
    return iso;
  }
}

function formatYen(value: number | null): string {
  if (value === null) return "—";
  return value.toLocaleString("ja-JP");
}

export default function Dashboard() {
  const [filings, setFilings] = useState<EdinetFiling[]>([]);
  const [generatedAt, setGeneratedAt] = useState<string | null>(null);
  const [days, setDays] = useState<number>(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const snapshot = await fetchEdinetFilingsSnapshot();
      setFilings(snapshot.filings);
      setGeneratedAt(snapshot.generatedAt);
      setDays(snapshot.days);
    } catch {
      setError("書類一覧の取得に失敗しました。しばらくしてから再度お試しください。");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // Defer to a microtask so this initial fetch's state updates don't
    // run synchronously within the effect body itself.
    queueMicrotask(() => void load());
  }, [load]);

  // Keep the feed in sync with the server-side snapshot while the tab is
  // open: poll periodically, and also refetch immediately whenever the
  // visitor switches back to this tab (covers the case where they were
  // away longer than the poll interval).
  useEffect(() => {
    const intervalId = setInterval(() => void load(), AUTO_REFRESH_INTERVAL_MS);

    function handleVisibilityChange() {
      if (document.visibilityState === "visible") {
        void load();
      }
    }
    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      clearInterval(intervalId);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [load]);

  const matched = useMemo(() => searchFilings(filings, query), [filings, query]);
  const visible = matched.slice(0, MAX_VISIBLE);

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-8 px-6 py-10">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Yukashoken Watch</h1>
        <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
          EDINET(金融庁)に提出された全上場企業の有価証券報告書・四半期報告書・半期報告書を確認できます。会社名・証券コードに加えて、各社の最新の有価証券報告書に記載された【事業の内容】のテキストからも検索できます。
        </p>
      </header>

      <section className="flex-1">
        <div className="flex items-center justify-between gap-2">
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="会社名・証券コード・事業内容で検索 (例: トヨタ / 7203 / GPU / ドローン)"
            className="w-full max-w-sm rounded-md border border-zinc-300 bg-transparent px-3 py-1.5 text-sm dark:border-zinc-700"
          />
          <button
            type="button"
            onClick={() => void load()}
            disabled={loading}
            className="shrink-0 text-sm text-zinc-500 hover:text-zinc-900 disabled:opacity-40 dark:text-zinc-400 dark:hover:text-zinc-100"
          >
            {loading ? "更新中..." : "更新"}
          </button>
        </div>

        {generatedAt ? (
          <p className="mt-2 text-xs text-zinc-400 dark:text-zinc-500">
            データ更新: {formatDate(generatedAt)}時点・直近{days}日分・{matched.length}件
            {matched.length > MAX_VISIBLE && `(先頭${MAX_VISIBLE}件を表示)`}
          </p>
        ) : (
          !loading &&
          !error && (
            <p className="mt-2 text-xs text-zinc-400 dark:text-zinc-500">
              このデータはまだ準備中です(EDINET連携の設定待ち)。
            </p>
          )
        )}

        {error && <p className="mt-3 text-sm text-red-600 dark:text-red-400">{error}</p>}

        {!loading && generatedAt && matched.length === 0 && !error ? (
          <p className="mt-4 text-sm text-zinc-500 dark:text-zinc-400">
            該当する書類が見つかりませんでした。
          </p>
        ) : (
          <ul className="mt-4 flex flex-col divide-y divide-zinc-200 dark:divide-zinc-800">
            {visible.map((f) => (
              <li key={f.docId} className="flex flex-col gap-1 py-3">
                <div className="flex flex-wrap items-center gap-2 text-xs text-zinc-500 dark:text-zinc-400">
                  <span className="rounded bg-zinc-100 px-1.5 py-0.5 font-medium text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300">
                    {f.docTypeLabel}
                  </span>
                  {f.secCode && <span>{f.secCode}</span>}
                  <span>{f.filerName}</span>
                  {f.periodStart && f.periodEnd && (
                    <span>
                      {f.periodStart} 〜 {f.periodEnd}
                    </span>
                  )}
                  <span>{formatDate(f.submittedAt)}</span>
                </div>
                <p className="text-sm font-medium">
                  {f.docDescription && <span>{f.docDescription} </span>}
                  <a
                    href={edinetDocumentPdfUrl(f.docId)}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="font-normal text-blue-600 underline decoration-blue-600/30 underline-offset-2 hover:decoration-blue-600 dark:text-blue-400 dark:decoration-blue-400/30 dark:hover:decoration-blue-400"
                  >
                    PDFを見る
                  </a>
                </p>
                {f.businessDescription && (
                  <p className="text-xs text-zinc-500 dark:text-zinc-400">
                    【事業の内容】
                    {f.businessDescription.length > BUSINESS_DESCRIPTION_PREVIEW_LENGTH
                      ? `${f.businessDescription.slice(0, BUSINESS_DESCRIPTION_PREVIEW_LENGTH)}…`
                      : f.businessDescription}
                  </p>
                )}
                {f.financials && f.financials.length > 0 && (
                  <div className="mt-1 overflow-x-auto">
                    <table className="text-xs">
                      <thead>
                        <tr className="text-zinc-400 dark:text-zinc-500">
                          <th className="pr-3 text-left font-normal">期間</th>
                          <th className="pr-3 text-left font-normal">区分</th>
                          <th className="pr-3 text-right font-normal">売上高</th>
                          <th className="pr-3 text-right font-normal">営業利益</th>
                          <th className="pr-3 text-right font-normal">経常利益</th>
                          <th className="pr-3 text-right font-normal">当期純利益</th>
                          <th className="text-right font-normal">EPS</th>
                        </tr>
                      </thead>
                      <tbody>
                        {f.financials.map((p, i) => (
                          <tr key={i}>
                            <td className="pr-3">{p.periodLabel}</td>
                            <td className="pr-3">{p.consolidated ? "連結" : "個別"}</td>
                            <td className="pr-3 text-right">{formatYen(p.netSales)}</td>
                            <td className="pr-3 text-right">{formatYen(p.operatingIncome)}</td>
                            <td className="pr-3 text-right">{formatYen(p.ordinaryIncome)}</td>
                            <td className="pr-3 text-right">{formatYen(p.profit)}</td>
                            <td className="text-right">{p.basicEarningsPerShare ?? "—"}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
