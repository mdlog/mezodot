import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/** Tiny JSON-file store with atomic writes (write temp + rename). */
export class JsonStore<T extends object> {
  private data: T;

  constructor(
    private readonly path: string,
    initial: T,
  ) {
    this.data = initial;
    try {
      this.data = { ...initial, ...(JSON.parse(readFileSync(path, 'utf8'), reviveBigInt) as T) };
    } catch {
      // Missing or corrupt file: start fresh.
    }
  }

  get(): T {
    return this.data;
  }

  update(mutate: (draft: T) => void): void {
    mutate(this.data);
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data, replaceBigInt, 2));
    renameSync(tmp, this.path);
  }
}

const replaceBigInt = (_key: string, value: unknown) => (typeof value === 'bigint' ? { $bigint: value.toString() } : value);
const reviveBigInt = (_key: string, value: unknown) =>
  value && typeof value === 'object' && '$bigint' in value ? BigInt((value as { $bigint: string }).$bigint) : value;
