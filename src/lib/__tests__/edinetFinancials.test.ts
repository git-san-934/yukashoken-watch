import { zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { extractFinancialsFromZip } from "@/lib/edinetFinancials";

const HEADER = [
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

function csvRow(fields: string[]): string {
  return fields.map((f) => `"${f.replace(/"/g, '""')}"`).join("\t");
}

function buildCsv(rows: string[][]): Uint8Array {
  const text = [csvRow(HEADER), ...rows.map(csvRow)].join("\r\n");
  return new Uint8Array(Buffer.from(text, "utf16le"));
}

function buildZip(files: Record<string, Uint8Array>): Uint8Array {
  return zipSync(files);
}

describe("extractFinancialsFromZip", () => {
  it("extracts consolidated financial highlights across multiple periods", () => {
    const csv = buildCsv([
      [
        "jpcrp_cor:NetSalesSummaryOfBusinessResults",
        "売上高",
        "CurrentYearDuration",
        "当期",
        "連結",
        "期間",
        "unit1",
        "JPY",
        "1000000",
      ],
      [
        "jpcrp_cor:OperatingIncomeSummaryOfBusinessResults",
        "営業利益",
        "CurrentYearDuration",
        "当期",
        "連結",
        "期間",
        "unit1",
        "JPY",
        "100000",
      ],
      [
        "jpcrp_cor:NetSalesSummaryOfBusinessResults",
        "売上高",
        "Prior1YearDuration",
        "1期前",
        "連結",
        "期間",
        "unit1",
        "JPY",
        "900000",
      ],
      [
        "jpcrp_cor:BasicEarningsPerShareSummaryOfBusinessResults",
        "1株当たり当期純利益",
        "CurrentYearDuration",
        "当期",
        "連結",
        "期間",
        "unit2",
        "JPY",
        "123.45",
      ],
      [
        "jpcrp_cor:SomeUnrelatedElement",
        "無関係",
        "CurrentYearDuration",
        "当期",
        "連結",
        "期間",
        "unit1",
        "JPY",
        "999",
      ],
    ]);

    const zip = buildZip({ "XBRL_TO_CSV/PublicDoc/sample.csv": csv });
    const result = extractFinancialsFromZip(zip);

    expect(result).toHaveLength(2);
    const current = result.find((p) => p.periodLabel === "当期");
    expect(current).toMatchObject({
      periodLabel: "当期",
      consolidated: true,
      netSales: 1_000_000,
      operatingIncome: 100_000,
      basicEarningsPerShare: 123.45,
      ordinaryIncome: null,
    });
    const prior = result.find((p) => p.periodLabel === "1期前");
    expect(prior).toMatchObject({ periodLabel: "1期前", consolidated: true, netSales: 900_000 });
  });

  it("distinguishes consolidated from individual (non-consolidated) rows for the same period", () => {
    const csv = buildCsv([
      [
        "jpcrp_cor:NetSalesSummaryOfBusinessResults",
        "売上高",
        "CurrentYearDuration",
        "当期",
        "連結",
        "期間",
        "unit1",
        "JPY",
        "1000000",
      ],
      [
        "jpcrp_cor:NetSalesSummaryOfBusinessResults",
        "売上高",
        "CurrentYearDuration_NonConsolidatedMember",
        "当期",
        "個別",
        "期間",
        "unit1",
        "JPY",
        "800000",
      ],
    ]);
    const zip = buildZip({ "sample.csv": csv });
    const result = extractFinancialsFromZip(zip);

    expect(result).toHaveLength(2);
    expect(result.find((p) => p.consolidated)?.netSales).toBe(1_000_000);
    expect(result.find((p) => !p.consolidated)?.netSales).toBe(800_000);
  });

  it("treats a dash placeholder value as no data instead of NaN", () => {
    const csv = buildCsv([
      [
        "jpcrp_cor:OrdinaryIncomeSummaryOfBusinessResults",
        "経常利益",
        "CurrentYearDuration",
        "当期",
        "連結",
        "期間",
        "unit1",
        "JPY",
        "－",
      ],
    ]);
    const zip = buildZip({ "sample.csv": csv });
    const result = extractFinancialsFromZip(zip);
    expect(result[0].ordinaryIncome).toBeNull();
  });

  it("ignores non-csv files and doesn't throw on an empty zip", () => {
    expect(extractFinancialsFromZip(buildZip({ "readme.txt": new Uint8Array() }))).toEqual([]);
  });
});
