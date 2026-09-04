import { zipSync } from "fflate";
import { describe, expect, it, vi } from "vitest";
import {
  edinetDocumentPdfUrl,
  fetchBusinessDescriptionForFiling,
  fetchDocumentCsvZip,
  fetchEdinetFilingsSnapshot,
  fetchFilingsForDate,
  fetchFinancialsForFiling,
  fetchRecentFilings,
  mapWithConcurrency,
  normalizeSecCode,
  searchFilings,
} from "@/lib/edinet";

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("normalizeSecCode", () => {
  it("strips the trailing check digit from a 5-character secCode", () => {
    expect(normalizeSecCode("72030")).toBe("7203");
  });

  it("returns null for a missing or too-short secCode (unlisted filer)", () => {
    expect(normalizeSecCode(null)).toBeNull();
    expect(normalizeSecCode(undefined)).toBeNull();
    expect(normalizeSecCode("")).toBeNull();
    expect(normalizeSecCode("12")).toBeNull();
  });
});

describe("edinetDocumentPdfUrl", () => {
  it("builds the public, no-API-key PDF URL from a docId", () => {
    expect(edinetDocumentPdfUrl("S100W5IE")).toBe(
      "https://disclosure2dl.edinet-fsa.go.jp/searchdocument/pdf/S100W5IE.pdf"
    );
  });
});

describe("fetchFilingsForDate", () => {
  it("keeps only recognized doc types, drops withdrawn filings", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({
        metadata: { status: "200" },
        results: [
          {
            docID: "S100AAAA",
            edinetCode: "E00001",
            secCode: "72030",
            filerName: "トヨタ自動車株式会社",
            docTypeCode: "120",
            docDescription: "有価証券報告書－第123期",
            periodStart: "2025-04-01",
            periodEnd: "2026-03-31",
            submitDateTime: "2026-06-27 15:00",
            withdrawalStatus: "0",
          },
          {
            docID: "S100BBBB",
            edinetCode: "E00002",
            secCode: "99840",
            filerName: "取り下げ会社",
            docTypeCode: "120",
            submitDateTime: "2026-06-27 15:00",
            withdrawalStatus: "1",
          },
          {
            docID: "S100CCCC",
            edinetCode: "E00003",
            secCode: "12340",
            filerName: "有価証券届出書だけの会社",
            docTypeCode: "030",
            submitDateTime: "2026-06-27 15:00",
            withdrawalStatus: "0",
          },
        ],
      })
    );

    const result = await fetchFilingsForDate(new Date("2026-06-27"), { apiKey: "key", fetchImpl });

    expect(result).toEqual([
      {
        docId: "S100AAAA",
        edinetCode: "E00001",
        secCode: "7203",
        filerName: "トヨタ自動車株式会社",
        docTypeCode: "120",
        docTypeLabel: "有価証券報告書",
        docDescription: "有価証券報告書－第123期",
        periodStart: "2025-04-01",
        periodEnd: "2026-03-31",
        submittedAt: "2026-06-27T15:00:00+09:00",
      },
    ]);
  });

  it("skips entries missing required fields instead of throwing", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({
        metadata: { status: "200" },
        results: [{ docID: "S1", docTypeCode: "120" }],
      })
    );

    const result = await fetchFilingsForDate(new Date("2026-06-27"), { apiKey: "key", fetchImpl });
    expect(result).toEqual([]);
  });

  it("throws when no API key is available", async () => {
    const fetchImpl = vi.fn();
    await expect(
      fetchFilingsForDate(new Date("2026-06-27"), { apiKey: undefined, fetchImpl })
    ).rejects.toThrow(/EDINET_API_KEY/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("throws on a non-ok HTTP response", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({}, 500));
    await expect(
      fetchFilingsForDate(new Date("2026-06-27"), { apiKey: "key", fetchImpl })
    ).rejects.toThrow();
  });

  it("throws when the API reports a logical error status", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({ metadata: { status: "400", message: "invalid date" }, results: [] })
    );
    await expect(
      fetchFilingsForDate(new Date("2026-06-27"), { apiKey: "key", fetchImpl })
    ).rejects.toThrow(/invalid date/);
  });
});

describe("fetchRecentFilings", () => {
  it("aggregates multiple days, dedupes by docId, and sorts newest first", async () => {
    const fetchImpl = vi.fn().mockImplementation((url: string) => {
      if (url.includes("date=2026-09-03")) {
        return Promise.resolve(
          jsonResponse({
            metadata: { status: "200" },
            results: [
              {
                docID: "new",
                secCode: "11110",
                filerName: "A社",
                docTypeCode: "120",
                submitDateTime: "2026-09-03T09:00:00+09:00",
                withdrawalStatus: "0",
              },
            ],
          })
        );
      }
      return Promise.resolve(
        jsonResponse({
          metadata: { status: "200" },
          results: [
            {
              docID: "old",
              secCode: "22220",
              filerName: "B社",
              docTypeCode: "160",
              submitDateTime: "2026-09-01T09:00:00+09:00",
              withdrawalStatus: "0",
            },
          ],
        })
      );
    });

    vi.setSystemTime(new Date("2026-09-03T12:00:00+09:00"));
    const result = await fetchRecentFilings(3, { apiKey: "key", fetchImpl });
    vi.useRealTimers();

    expect(result.map((f) => f.docId)).toEqual(["new", "old"]);
  });

  it("throws if every day's request fails, instead of silently returning empty", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("network down"));
    await expect(fetchRecentFilings(3, { apiKey: "key", fetchImpl })).rejects.toThrow();
  });
});

describe("fetchDocumentCsvZip", () => {
  it("downloads and returns the raw zip bytes", async () => {
    const zipBytes = zipSync({ "sample.csv": new Uint8Array([1, 2, 3]) });
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(zipBytes, { status: 200 })
    );

    const result = await fetchDocumentCsvZip("S100AAAA", { apiKey: "key", fetchImpl });
    expect(fetchImpl).toHaveBeenCalledWith(
      expect.stringContaining("/documents/S100AAAA?type=5"),
      expect.anything()
    );
    expect(new Uint8Array(result)).toEqual(zipBytes);
  });

  it("throws when no API key is available", async () => {
    const fetchImpl = vi.fn();
    await expect(
      fetchDocumentCsvZip("S100AAAA", { apiKey: undefined, fetchImpl })
    ).rejects.toThrow(/EDINET_API_KEY/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("throws on a non-ok HTTP response", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("", { status: 404 }));
    await expect(
      fetchDocumentCsvZip("S100AAAA", { apiKey: "key", fetchImpl })
    ).rejects.toThrow();
  });

  it("throws a diagnostic error (not fflate's opaque one) when a 200 response isn't actually a zip", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response("<html><body>Too many requests</body></html>", {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
      })
    );
    await expect(
      fetchDocumentCsvZip("S100AAAA", { apiKey: "key", fetchImpl })
    ).rejects.toThrow(/text\/html[\s\S]*Too many requests/);
  });

  it("retries with backoff on EDINET's HTTP-200-wrapped 429, then succeeds", async () => {
    const zipBytes = zipSync({ "sample.csv": new Uint8Array([1, 2, 3]) });
    const rateLimited = () =>
      new Response(JSON.stringify({ StatusCode: "429", message: "Too Many Requests" }), {
        status: 200,
        headers: { "content-type": "application/json; charset=utf-8" },
      });
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(rateLimited())
      .mockResolvedValueOnce(rateLimited())
      .mockResolvedValueOnce(new Response(zipBytes, { status: 200 }));

    const result = await fetchDocumentCsvZip("S100AAAA", { apiKey: "key", fetchImpl, retryDelayMs: 0 });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(new Uint8Array(result)).toEqual(zipBytes);
  });

  it("gives up after maxRetries of a persistent 429", async () => {
    const fetchImpl = vi.fn().mockImplementation(
      async () =>
        new Response(JSON.stringify({ StatusCode: "429", message: "Too Many Requests" }), {
          status: 200,
          headers: { "content-type": "application/json; charset=utf-8" },
        })
    );

    await expect(
      fetchDocumentCsvZip("S100AAAA", { apiKey: "key", fetchImpl, retryDelayMs: 0, maxRetries: 2 })
    ).rejects.toThrow(/rate limit/i);
    expect(fetchImpl).toHaveBeenCalledTimes(3); // initial attempt + 2 retries
  });

  it("does not retry a genuine 404 (a real document-not-found, not a rate limit)", async () => {
    const fetchImpl = vi.fn().mockImplementation(
      async () =>
        new Response(
          JSON.stringify({ metadata: { title: "提出された書類を取得するためのAPI", status: "404", message: "Not Found" } }),
          { status: 200, headers: { "content-type": "application/json; charset=utf-8" } }
        )
    );

    await expect(
      fetchDocumentCsvZip("S100AAAA", { apiKey: "key", fetchImpl, retryDelayMs: 0 })
    ).rejects.toThrow(/doesn't look like a zip file/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe("fetchFinancialsForFiling", () => {
  it("downloads and parses financial highlights from the CSV package", async () => {
    const header = [
      "要素ID",
      "項目名",
      "コンテキストID",
      "相対年度",
      "連結・個別",
      "期間・時点",
      "ユニットID",
      "単位",
      "値",
    ];
    const row = [
      "jpcrp_cor:NetSalesSummaryOfBusinessResults",
      "売上高",
      "CurrentYearDuration",
      "当期",
      "連結",
      "期間",
      "unit1",
      "JPY",
      "500000",
    ];
    const quote = (fields: string[]) => fields.map((f) => `"${f}"`).join("\t");
    const csvText = [quote(header), quote(row)].join("\r\n");
    const csvBytes = new Uint8Array(Buffer.from(csvText, "utf16le"));
    const zipBytes = zipSync({ "sample.csv": csvBytes });

    const fetchImpl = vi.fn().mockResolvedValue(new Response(zipBytes, { status: 200 }));
    const result = await fetchFinancialsForFiling("S100AAAA", { apiKey: "key", fetchImpl });

    expect(result).toEqual([
      {
        periodLabel: "当期",
        consolidated: true,
        netSales: 500000,
        operatingIncome: null,
        ordinaryIncome: null,
        profit: null,
        basicEarningsPerShare: null,
        totalAssets: null,
        netAssets: null,
      },
    ]);
  });
});

describe("fetchBusinessDescriptionForFiling", () => {
  it("downloads and parses the business description text from the CSV package", async () => {
    const header = [
      "要素ID",
      "項目名",
      "コンテキストID",
      "相対年度",
      "連結・個別",
      "期間・時点",
      "ユニットID",
      "単位",
      "値",
    ];
    const row = [
      "jpcrp_cor:DescriptionOfBusinessTextBlock",
      "事業の内容",
      "CurrentYearInstant",
      "当期",
      "連結",
      "時点",
      "",
      "",
      "<p>半導体の製造・販売を行っています。</p>",
    ];
    const quote = (fields: string[]) => fields.map((f) => `"${f}"`).join("\t");
    const csvText = [quote(header), quote(row)].join("\r\n");
    const csvBytes = new Uint8Array(Buffer.from(csvText, "utf16le"));
    const zipBytes = zipSync({ "sample.csv": csvBytes });

    const fetchImpl = vi.fn().mockResolvedValue(new Response(zipBytes, { status: 200 }));
    const result = await fetchBusinessDescriptionForFiling("S100AAAA", { apiKey: "key", fetchImpl });

    expect(result).toBe("半導体の製造・販売を行っています。");
  });

  it("returns null when the filing has no business description element", async () => {
    const zipBytes = zipSync({ "readme.txt": new Uint8Array() });
    const fetchImpl = vi.fn().mockResolvedValue(new Response(zipBytes, { status: 200 }));
    const result = await fetchBusinessDescriptionForFiling("S100AAAA", { apiKey: "key", fetchImpl });
    expect(result).toBeNull();
  });
});

describe("mapWithConcurrency", () => {
  it("resolves every item, reporting failures per-item instead of rejecting the whole batch", async () => {
    const results = await mapWithConcurrency(
      [1, 2, 3, 4],
      2,
      async (n) => {
        if (n === 3) throw new Error("boom");
        return n * 10;
      }
    );

    expect(results).toEqual([
      { status: "fulfilled", value: 10 },
      { status: "fulfilled", value: 20 },
      { status: "rejected", reason: new Error("boom") },
      { status: "fulfilled", value: 40 },
    ]);
  });

  it("never runs more than `limit` items concurrently", async () => {
    let active = 0;
    let maxActive = 0;
    await mapWithConcurrency(Array.from({ length: 10 }, (_, i) => i), 3, async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
    });
    expect(maxActive).toBeLessThanOrEqual(3);
  });
});

describe("searchFilings", () => {
  const filings = [
    {
      docId: "1",
      edinetCode: "E1",
      secCode: "7203",
      filerName: "トヨタ自動車株式会社",
      docTypeCode: "120",
      docTypeLabel: "有価証券報告書",
      docDescription: null,
      periodStart: null,
      periodEnd: null,
      submittedAt: "2026-06-27 15:00",
    },
    {
      docId: "2",
      edinetCode: "E2",
      secCode: null,
      filerName: "非上場会社",
      docTypeCode: "120",
      docTypeLabel: "有価証券報告書",
      docDescription: null,
      periodStart: null,
      periodEnd: null,
      submittedAt: "2026-06-27 15:00",
    },
  ];

  it("returns everything for an empty query", () => {
    expect(searchFilings(filings, "")).toEqual(filings);
    expect(searchFilings(filings, "   ")).toEqual(filings);
  });

  it("matches by ticker code (prefix, case-insensitive)", () => {
    expect(searchFilings(filings, "7203")).toEqual([filings[0]]);
    expect(searchFilings(filings, "9999")).toEqual([]);
  });

  it("matches by company name (substring, case-insensitive)", () => {
    expect(searchFilings(filings, "トヨタ")).toEqual([filings[0]]);
    expect(searchFilings(filings, "非上場")).toEqual([filings[1]]);
  });

  it("matches by business description text when present", () => {
    const withDescriptions = [
      { ...filings[0], businessDescription: "半導体・GPUの製造販売" },
      { ...filings[1], businessDescription: "ドローンの開発" },
    ];
    expect(searchFilings(withDescriptions, "GPU")).toEqual([withDescriptions[0]]);
    expect(searchFilings(withDescriptions, "ドローン")).toEqual([withDescriptions[1]]);
    expect(searchFilings(withDescriptions, "光半導体")).toEqual([]);
  });
});

describe("fetchEdinetFilingsSnapshot", () => {
  it("loads the pre-fetched same-origin snapshot", async () => {
    const snapshot = {
      generatedAt: "2026-09-03T12:00:00Z",
      days: 30,
      filings: [],
    };
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(snapshot));

    const result = await fetchEdinetFilingsSnapshot(fetchImpl);

    expect(result).toEqual(snapshot);
    expect(fetchImpl).toHaveBeenCalledWith(
      expect.stringContaining("/edinet-filings.json"),
      expect.objectContaining({ cache: "no-store" })
    );
  });

  it("treats a 404 as 'not built yet' rather than an error", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({}, 404));
    const result = await fetchEdinetFilingsSnapshot(fetchImpl);
    expect(result).toEqual({ generatedAt: null, days: 0, filings: [] });
  });

  it("throws on other non-ok responses", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({}, 500));
    await expect(fetchEdinetFilingsSnapshot(fetchImpl)).rejects.toThrow();
  });
});
