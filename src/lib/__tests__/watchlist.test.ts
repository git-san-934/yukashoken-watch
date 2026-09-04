import { describe, expect, it } from "vitest";
import {
  addWatchedCompany,
  DuplicateCompanyError,
  getArchivedFilings,
  listWatchedCompanies,
  mergeArchivedFilings,
  removeWatchedCompany,
  type StorageLike,
} from "@/lib/watchlist";
import type { EdinetFiling } from "@/lib/edinet";

function makeFiling(docId: string, overrides: Partial<EdinetFiling> = {}): EdinetFiling {
  return {
    docId,
    edinetCode: "E00001",
    secCode: "7203",
    filerName: "トヨタ自動車株式会社",
    docTypeCode: "120",
    docTypeLabel: "有価証券報告書",
    docDescription: `書類 ${docId}`,
    periodStart: "2025-04-01",
    periodEnd: "2026-03-31",
    submittedAt: "2026-06-27T15:00:00+09:00",
    ...overrides,
  };
}

function createMemoryStorage(): StorageLike {
  const data = new Map<string, string>();
  return {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => {
      data.set(key, value);
    },
  };
}

describe("watchlist storage", () => {
  it("adds and lists companies", () => {
    const storage = createMemoryStorage();
    const company = addWatchedCompany("7203", "トヨタ自動車", storage);
    expect(company.code).toBe("7203");
    expect(listWatchedCompanies(storage)).toHaveLength(1);
  });

  it("keeps separate storages independent", () => {
    const storageA = createMemoryStorage();
    const storageB = createMemoryStorage();
    addWatchedCompany("7203", "トヨタ自動車", storageA);
    expect(listWatchedCompanies(storageA)).toHaveLength(1);
    expect(listWatchedCompanies(storageB)).toHaveLength(0);
  });

  it("rejects duplicate codes", () => {
    const storage = createMemoryStorage();
    addWatchedCompany("9984", "ソフトバンクグループ", storage);
    expect(() => addWatchedCompany("9984", "SBG", storage)).toThrow(
      DuplicateCompanyError
    );
  });

  it("removes a company by id", () => {
    const storage = createMemoryStorage();
    const company = addWatchedCompany("4321", "B社", storage);
    expect(removeWatchedCompany("does-not-exist", storage)).toBe(false);
    expect(removeWatchedCompany(company.id, storage)).toBe(true);
    expect(listWatchedCompanies(storage)).toHaveLength(0);
  });

  it("returns an empty list instead of throwing on corrupt stored JSON", () => {
    const storage = createMemoryStorage();
    storage.setItem("yukashoken-watch:companies", "not json");
    expect(listWatchedCompanies(storage)).toEqual([]);
  });

  it("archives EDINET filings permanently, merging in only unseen ones", () => {
    const storage = createMemoryStorage();
    expect(getArchivedFilings(storage)).toEqual([]);

    const first = mergeArchivedFilings([makeFiling("a"), makeFiling("b")], storage);
    expect(first.map((f) => f.docId)).toEqual(["a", "b"]);
    expect(getArchivedFilings(storage)).toHaveLength(2);

    // Re-merging the same ids plus one new one only reports the new one,
    // and the archive keeps everything (nothing rolls off).
    const second = mergeArchivedFilings(
      [makeFiling("a"), makeFiling("b"), makeFiling("c")],
      storage
    );
    expect(second.map((f) => f.docId)).toEqual(["c"]);
    expect(getArchivedFilings(storage).map((f) => f.docId)).toEqual(["a", "b", "c"]);
  });
});
