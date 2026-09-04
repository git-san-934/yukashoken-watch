"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  addWatchedCompany,
  DuplicateCompanyError,
  getArchivedFilings,
  listWatchedCompanies,
  mergeArchivedFilings,
  removeWatchedCompany,
  type WatchedCompany,
} from "@/lib/watchlist";
import {
  fetchEdinetFilingsSnapshot,
  filterFilingsByCodes,
  type EdinetFiling,
} from "@/lib/edinet";

type FilingItem = EdinetFiling & { isNew: boolean };

// TSE tickers are normally 4 digits, but JPX's newer alphanumeric codes
// (e.g. "130A") mix in letters too — accept either, case-insensitively.
const CODE_PATTERN = /^[0-9A-Za-z]{4}$/;

// The server-side snapshot refreshes every 15 min (see
// .github/workflows/deploy.yml); poll a bit more often than that so an
// open tab picks up a new snapshot soon after it's published.
const AUTO_REFRESH_INTERVAL_MS = 5 * 60 * 1000;

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
  const [hydrated, setHydrated] = useState(false);
  const [companies, setCompanies] = useState<WatchedCompany[]>([]);

  const [filings, setFilings] = useState<FilingItem[]>([]);
  const [filingsGeneratedAt, setFilingsGeneratedAt] = useState<string | null>(null);
  const [loadingFilings, setLoadingFilings] = useState(false);
  const [filingsError, setFilingsError] = useState<string | null>(null);

  const [codeInput, setCodeInput] = useState("");
  const [nameInput, setNameInput] = useState("");
  const [formError, setFormError] = useState<string | null>(null);

  // Read by the auto-refresh effect below, which shouldn't need to
  // restart its interval/listener every time the watchlist changes.
  const companiesRef = useRef(companies);
  useEffect(() => {
    companiesRef.current = companies;
  }, [companies]);

  const loadFilings = useCallback(async (watchList: WatchedCompany[]) => {
    if (watchList.length === 0) {
      setFilings([]);
      return;
    }
    setLoadingFilings(true);
    setFilingsError(null);
    try {
      const codes = watchList.map((c) => c.code);
      const snapshot = await fetchEdinetFilingsSnapshot();

      // Merge only the ones not already archived — everything merged in
      // stays permanently, regardless of how long the server-side
      // snapshot itself keeps a given filing around.
      const candidates = filterFilingsByCodes(snapshot.filings, codes);
      const added = mergeArchivedFilings(candidates);
      const addedIds = new Set(added.map((f) => f.docId));

      const archive = getArchivedFilings();
      const visible = filterFilingsByCodes(archive, codes)
        .map((f) => ({ ...f, isNew: addedIds.has(f.docId) }))
        .sort((a, b) => new Date(b.submittedAt).getTime() - new Date(a.submittedAt).getTime());

      setFilings(visible);
      setFilingsGeneratedAt(snapshot.generatedAt);
    } catch {
      setFilingsError(
        "有価証券報告書等の取得に失敗しました。しばらくしてから再度お試しください。"
      );
    } finally {
      setLoadingFilings(false);
    }
  }, []);

  useEffect(() => {
    // Defer to a microtask so these state updates (hydrating from
    // localStorage, which is only available client-side) don't run
    // synchronously within the effect body itself.
    queueMicrotask(() => {
      const initial = listWatchedCompanies();
      setCompanies(initial);
      setHydrated(true);
      if (initial.length > 0) {
        void loadFilings(initial);
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Keep the feed in sync with the server-side snapshot while the tab is
  // open: poll periodically, and also refetch immediately whenever the
  // visitor switches back to this tab (covers the case where they were
  // away longer than the poll interval).
  useEffect(() => {
    function refreshIfWatchingAnything() {
      if (companiesRef.current.length > 0) {
        void loadFilings(companiesRef.current);
      }
    }

    const intervalId = setInterval(refreshIfWatchingAnything, AUTO_REFRESH_INTERVAL_MS);

    function handleVisibilityChange() {
      if (document.visibilityState === "visible") {
        refreshIfWatchingAnything();
      }
    }
    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      clearInterval(intervalId);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [loadFilings]);

  function handleAddCompany(e: React.FormEvent) {
    e.preventDefault();
    setFormError(null);

    const code = codeInput.trim().toUpperCase();
    const name = nameInput.trim();

    if (!CODE_PATTERN.test(code)) {
      setFormError("証券コードは4桁の英数字で入力してください");
      return;
    }
    if (!name) {
      setFormError("会社名を入力してください");
      return;
    }

    try {
      const company = addWatchedCompany(code, name);
      const next = [...companies, company];
      setCompanies(next);
      setCodeInput("");
      setNameInput("");
      void loadFilings(next);
    } catch (err) {
      setFormError(
        err instanceof DuplicateCompanyError ? "既に登録済みの銘柄です" : "登録に失敗しました"
      );
    }
  }

  function handleRemoveCompany(id: string) {
    removeWatchedCompany(id);
    const next = companies.filter((c) => c.id !== id);
    setCompanies(next);
    void loadFilings(next);
  }

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-8 px-6 py-10">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Yukashoken Watch</h1>
        <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
          EDINET(金融庁)に提出された有価証券報告書・四半期報告書・半期報告書を、登録した銘柄ごとにまとめて確認できます。登録内容はこの端末のブラウザ内にのみ保存され、他の人には見えません。
        </p>
      </header>

      <section className="rounded-lg border border-zinc-200 p-5 dark:border-zinc-800">
        <h2 className="text-lg font-medium">監視銘柄</h2>

        <form onSubmit={handleAddCompany} className="mt-4 flex flex-wrap items-start gap-2">
          <div className="flex flex-col gap-1">
            <label htmlFor="code" className="text-xs text-zinc-500 dark:text-zinc-400">
              証券コード
            </label>
            <input
              id="code"
              value={codeInput}
              onChange={(e) => setCodeInput(e.target.value.toUpperCase())}
              placeholder="7203 / 130A"
              maxLength={4}
              className="w-28 rounded-md border border-zinc-300 bg-transparent px-3 py-1.5 text-sm dark:border-zinc-700"
            />
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor="name" className="text-xs text-zinc-500 dark:text-zinc-400">
              会社名
            </label>
            <input
              id="name"
              value={nameInput}
              onChange={(e) => setNameInput(e.target.value)}
              placeholder="トヨタ自動車"
              className="w-56 rounded-md border border-zinc-300 bg-transparent px-3 py-1.5 text-sm dark:border-zinc-700"
            />
          </div>
          <button
            type="submit"
            className="mt-5 rounded-md bg-zinc-900 px-4 py-1.5 text-sm font-medium text-white hover:bg-zinc-700 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300"
          >
            追加
          </button>
        </form>
        {formError && <p className="mt-2 text-sm text-red-600 dark:text-red-400">{formError}</p>}

        {!hydrated ? null : companies.length === 0 ? (
          <p className="mt-4 text-sm text-zinc-500 dark:text-zinc-400">
            まだ銘柄が登録されていません。証券コードと会社名を入力して追加してください。
          </p>
        ) : (
          <ul className="mt-4 flex flex-wrap gap-2">
            {companies.map((c) => (
              <li
                key={c.id}
                className="flex items-center gap-2 rounded-full border border-zinc-300 py-1 pl-3 pr-1 text-sm dark:border-zinc-700"
              >
                <span className="text-zinc-500 dark:text-zinc-400">{c.code}</span>
                <span>{c.name}</span>
                <button
                  type="button"
                  onClick={() => handleRemoveCompany(c.id)}
                  aria-label={`${c.name} を削除`}
                  className="rounded-full px-1.5 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="flex-1">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-medium">有価証券報告書・四半期/半期報告書</h2>
          <button
            type="button"
            onClick={() => void loadFilings(companies)}
            disabled={loadingFilings || companies.length === 0}
            className="text-sm text-zinc-500 hover:text-zinc-900 disabled:opacity-40 dark:text-zinc-400 dark:hover:text-zinc-100"
          >
            {loadingFilings ? "更新中..." : "更新"}
          </button>
        </div>

        <p className="mt-1 text-xs text-zinc-400 dark:text-zinc-500">
          EDINET(金融庁)に提出された書類の一覧です。提出から数日以内のものは主要な経営指標(売上高等)も表示されます。比較・スクリーニングなどの分析機能はまだ未実装です。
        </p>

        {filingsGeneratedAt && (
          <p className="mt-1 text-xs text-zinc-400 dark:text-zinc-500">
            データ更新: {formatDate(filingsGeneratedAt)}時点・一度表示された書類は残り続けます
          </p>
        )}

        {filingsError && (
          <p className="mt-3 text-sm text-red-600 dark:text-red-400">{filingsError}</p>
        )}

        {companies.length === 0 ? (
          <p className="mt-4 text-sm text-zinc-500 dark:text-zinc-400">
            銘柄を登録すると、ここに提出書類が表示されます。
          </p>
        ) : !loadingFilings && filings.length === 0 && !filingsError && filingsGeneratedAt === null ? (
          <p className="mt-4 text-sm text-zinc-500 dark:text-zinc-400">
            このデータはまだ準備中です(EDINET連携の設定待ち)。
          </p>
        ) : !loadingFilings && filings.length === 0 && !filingsError ? (
          <p className="mt-4 text-sm text-zinc-500 dark:text-zinc-400">
            登録銘柄の提出書類はまだありません。
          </p>
        ) : (
          <ul className="mt-4 flex flex-col divide-y divide-zinc-200 dark:divide-zinc-800">
            {filings.map((f) => (
              <li key={f.docId} className="flex flex-col gap-1 py-3">
                <div className="flex flex-wrap items-center gap-2 text-xs text-zinc-500 dark:text-zinc-400">
                  {f.isNew && (
                    <span className="rounded bg-emerald-100 px-1.5 py-0.5 font-medium text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-400">
                      NEW
                    </span>
                  )}
                  <span className="rounded bg-zinc-100 px-1.5 py-0.5 font-medium text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300">
                    {f.docTypeLabel}
                  </span>
                  <span>{f.secCode}</span>
                  <span>{f.filerName}</span>
                  {f.periodStart && f.periodEnd && (
                    <span>
                      {f.periodStart} 〜 {f.periodEnd}
                    </span>
                  )}
                  <span>{formatDate(f.submittedAt)}</span>
                </div>
                {f.docDescription && (
                  <p className="text-sm font-medium">{f.docDescription}</p>
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
