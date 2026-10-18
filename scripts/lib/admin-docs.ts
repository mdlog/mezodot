/**
 * Keeps docs/SECURITY.md honest for auditors: every owner-only function in contracts/src must be named (in
 * backticks) in its "Admin powers" section.
 */

export type OwnerFunction = { contract: string; name: string; file: string };

/** Ownable / Ownable2Step's own owner-only functions, inherited by every contract that derives from them. */
export const INHERITED_OWNER_FUNCTIONS = ['transferOwnership', 'renounceOwnership'] as const;

/** Drops comments, so NatSpec and commented-out code never count as declarations. */
export const stripComments = (source: string): string => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

/** Owner-only functions declared in one Solidity source, attributed to the contract that declares them. */
export function ownerFunctions(source: string, file = ''): OwnerFunction[] {
  const src = stripComments(source);
  const contracts = [...src.matchAll(/\b(?:abstract\s+)?contract\s+(\w+)([^{]*)\{/g)].map((m) => ({
    name: m[1],
    at: m.index ?? 0,
    ownable: /\bOwnable2Step\b|\bOwnable\b/.test(m[2]),
  }));
  const out: OwnerFunction[] = [];
  // `function name(params) <visibility, modifiers, returns (...)> {` — parameters never contain ')' here.
  for (const m of src.matchAll(/\bfunction\s+(\w+)\s*\([^)]*\)([^{;]*)[{;]/g)) {
    if (!/\bonlyOwner\b/.test(m[2])) continue;
    const contract = contracts.filter((c) => c.at < (m.index ?? 0)).at(-1)?.name ?? '(file scope)';
    out.push({ contract, name: m[1], file });
  }
  for (const c of contracts) {
    if (c.ownable) for (const name of INHERITED_OWNER_FUNCTIONS) out.push({ contract: c.name, name, file });
  }
  return out;
}

/** Body of the first markdown section whose heading contains `heading`, up to the next heading of its level or higher. */
export function markdownSection(markdown: string, heading: string): string | null {
  const lines = markdown.split('\n');
  const start = lines.findIndex((l) => /^#{1,6}\s/.test(l) && l.includes(heading));
  if (start === -1) return null;
  const level = lines[start].match(/^#+/)![0].length;
  const next = lines.findIndex((l, i) => i > start && (l.match(/^(#+)\s/)?.[1].length ?? Infinity) <= level);
  return lines.slice(start + 1, next === -1 ? undefined : next).join('\n');
}

/** Identifiers inside backtick code spans, e.g. `OracleRouter.setFeed` → OracleRouter, setFeed. */
export function codeIdentifiers(markdown: string): Set<string> {
  const names = new Set<string>();
  for (const m of markdown.matchAll(/`([^`\n]+)`/g)) {
    for (const id of m[1].match(/[A-Za-z_]\w*/g) ?? []) names.add(id);
  }
  return names;
}

/** Owner-only functions the section never names. */
export function undocumented(functions: OwnerFunction[], section: string): OwnerFunction[] {
  const names = codeIdentifiers(section);
  return functions.filter((f) => !names.has(f.name));
}
