import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export type StoreOptions = {
  /**
   * Never write the file; follow it instead (reloaded when it changes). For a second process that shares the
   * running agent's state directory (the stdio MCP server): its in-memory changes must not clobber the agent's.
   */
  readOnly?: boolean;
};

/** A read-only store looks at the file's mtime at most this often. */
const RELOAD_CHECK_MS = 1_000;

/**
 * Identity of the file's current version. Every write renames a new file into place, so the inode changes even when
 * two writes land within the filesystem's timestamp granularity (a few ms) and the mtime does not.
 */
const versionOf = (path: string): string => {
  const st = statSync(path);
  return `${st.ino}:${st.mtimeMs}:${st.size}`;
};

/** Tiny JSON-file store with atomic writes (write temp + rename). */
export class JsonStore<T extends object> {
  private data: T;
  private version = '';
  private checkedAt = 0;

  constructor(
    private readonly path: string,
    private readonly initial: T,
    private readonly options: StoreOptions = {},
  ) {
    this.data = this.load() ?? structuredClone(initial);
  }

  get readOnly(): boolean {
    return this.options.readOnly === true;
  }

  get(): T {
    if (this.readOnly) this.reloadIfChanged();
    return this.data;
  }

  update(mutate: (draft: T) => void): void {
    if (this.readOnly) this.reloadIfChanged();
    mutate(this.data);
    if (this.readOnly) return;
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data, replaceBigInt, 2));
    renameSync(tmp, this.path);
  }

  private load(): T | null {
    try {
      this.version = versionOf(this.path);
      return { ...structuredClone(this.initial), ...(JSON.parse(readFileSync(this.path, 'utf8'), reviveBigInt) as T) };
    } catch {
      return null; // missing or corrupt file: start fresh
    }
  }

  private reloadIfChanged(): void {
    const now = Date.now();
    if (now - this.checkedAt < RELOAD_CHECK_MS) return;
    this.checkedAt = now;
    try {
      if (versionOf(this.path) === this.version) return;
    } catch {
      return;
    }
    const fresh = this.load();
    if (fresh) this.data = fresh;
  }
}

/**
 * Appends `entry` to a JSON array file next to the state (e.g. borrowers and undelivered messages of a replaced
 * deployment), so nothing that still needs attention disappears silently.
 */
export function appendArchive(path: string, entry: object): void {
  let entries: unknown[] = [];
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (Array.isArray(parsed)) entries = parsed;
  } catch {
    // first archive entry
  }
  entries.push(entry);
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(entries, replaceBigInt, 2));
  renameSync(tmp, path);
}

export const sameAddress = (a: string | null | undefined, b: string | null | undefined): boolean =>
  typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();

const replaceBigInt = (_key: string, value: unknown) => (typeof value === 'bigint' ? { $bigint: value.toString() } : value);
const reviveBigInt = (_key: string, value: unknown) =>
  value && typeof value === 'object' && '$bigint' in value ? BigInt((value as { $bigint: string }).$bigint) : value;
