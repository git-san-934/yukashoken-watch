/**
 * Client-side watchlist storage. This app is a static export (GitHub
 * Pages) with no server, so the watch list and every EDINET filing ever
 * matched against it live entirely in the visitor's own browser
 * (localStorage) — nothing is sent anywhere, which is also what keeps
 * one visitor's data private from anyone else without needing accounts
 * or a login.
 */

import type { EdinetFiling } from "./edinet";

export interface WatchedCompany {
  id: string;
  code: string;
  name: string;
  createdAt: string;
}

const COMPANIES_KEY = "yukashoken-watch:companies";
const ARCHIVE_KEY = "yukashoken-watch:archived-filings";

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function getStorage(storage?: StorageLike): StorageLike | null {
  if (storage) return storage;
  if (typeof window === "undefined") return null;
  return window.localStorage;
}

function readCompanies(storage?: StorageLike): WatchedCompany[] {
  const store = getStorage(storage);
  if (!store) return [];
  const raw = store.getItem(COMPANIES_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeCompanies(companies: WatchedCompany[], storage?: StorageLike): void {
  const store = getStorage(storage);
  if (!store) return;
  store.setItem(COMPANIES_KEY, JSON.stringify(companies));
}

export function listWatchedCompanies(storage?: StorageLike): WatchedCompany[] {
  return readCompanies(storage);
}

export class DuplicateCompanyError extends Error {
  constructor(code: string) {
    super(`Company ${code} is already on the watchlist`);
    this.name = "DuplicateCompanyError";
  }
}

export function addWatchedCompany(
  code: string,
  name: string,
  storage?: StorageLike
): WatchedCompany {
  const companies = readCompanies(storage);
  if (companies.some((c) => c.code === code)) {
    throw new DuplicateCompanyError(code);
  }

  const company: WatchedCompany = {
    id: typeof crypto !== "undefined" && crypto.randomUUID
      ? crypto.randomUUID()
      : `${code}-${Date.now()}`,
    code,
    name,
    createdAt: new Date().toISOString(),
  };

  writeCompanies([...companies, company], storage);
  return company;
}

export function removeWatchedCompany(id: string, storage?: StorageLike): boolean {
  const companies = readCompanies(storage);
  const next = companies.filter((c) => c.id !== id);
  if (next.length === companies.length) return false;
  writeCompanies(next, storage);
  return true;
}

function readArchive(storage?: StorageLike): EdinetFiling[] {
  const store = getStorage(storage);
  if (!store) return [];
  const raw = store.getItem(ARCHIVE_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeArchive(filings: EdinetFiling[], storage?: StorageLike): void {
  const store = getStorage(storage);
  if (!store) return;
  store.setItem(ARCHIVE_KEY, JSON.stringify(filings));
}

/** Every EDINET filing ever merged in, across all companies ever watched. */
export function getArchivedFilings(storage?: StorageLike): EdinetFiling[] {
  return readArchive(storage);
}

/**
 * Adds any of `candidates` not already in the archive (matched by docId) —
 * everything merged in stays permanently, independent of how long the
 * server-side snapshot's rolling window keeps it around. Returns just the
 * newly-added ones, e.g. to flag them "NEW" in the UI.
 */
export function mergeArchivedFilings(
  candidates: EdinetFiling[],
  storage?: StorageLike
): EdinetFiling[] {
  const archive = readArchive(storage);
  const knownIds = new Set(archive.map((f) => f.docId));
  const added = candidates.filter((f) => !knownIds.has(f.docId));
  if (added.length > 0) {
    writeArchive([...archive, ...added], storage);
  }
  return added;
}
