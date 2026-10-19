/**
 * CI check: every owner-only function in contracts/src is named in docs/SECURITY.md "Admin powers".
 *
 *   pnpm check:admin-docs
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { markdownSection, ownerFunctions, undocumented, type OwnerFunction } from './lib/admin-docs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SOURCES = join(ROOT, 'contracts', 'src');
const SECURITY = join(ROOT, 'docs', 'SECURITY.md');
const SECTION = 'Admin powers';

const solidityFiles = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? solidityFiles(join(dir, e.name)) : e.name.endsWith('.sol') ? [join(dir, e.name)] : [],
  );

const functions: OwnerFunction[] = solidityFiles(SOURCES).flatMap((file) => ownerFunctions(readFileSync(file, 'utf8'), relative(ROOT, file)));
const section = markdownSection(readFileSync(SECURITY, 'utf8'), SECTION);
if (section === null) {
  console.error(`docs/SECURITY.md has no "${SECTION}" section`);
  process.exit(2);
}
const missing = undocumented(functions, section);
if (missing.length > 0) {
  console.error(`docs/SECURITY.md "${SECTION}" does not name these owner-only functions:`);
  for (const f of missing) console.error(`  ${f.contract}.${f.name}  (${f.file})`);
  process.exit(1);
}
console.log(`docs/SECURITY.md "${SECTION}" names all ${functions.length} owner-only functions (${new Set(functions.map((f) => f.contract)).size} contracts)`);
