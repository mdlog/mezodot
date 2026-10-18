export type Page<T> = {
  rows: T[];
  /** Zero-based page actually shown: the requested one, clamped to the pages that exist. */
  page: number;
  pageCount: number;
  /** Rows across all pages. */
  total: number;
  /** One-based positions of the first and last row shown (0 and 0 when empty). */
  from: number;
  to: number;
};

/** One page of `items`. A page past the end (the list shrank) shows the last page instead. */
export function paginate<T>(items: T[], page: number, size: number): Page<T> {
  const pageCount = Math.max(1, Math.ceil(items.length / size));
  const current = Math.min(Math.max(0, page), pageCount - 1);
  const rows = items.slice(current * size, (current + 1) * size);
  return { rows, page: current, pageCount, total: items.length, from: rows.length ? current * size + 1 : 0, to: current * size + rows.length };
}

/**
 * Page buttons to show: the first and last page and those next to the current one; `null` marks a run of
 * hidden pages. Near either end the run is widened so the control keeps a steady length.
 */
export function pageList(page: number, pageCount: number): (number | null)[] {
  const keep = new Set([0, pageCount - 1, page - 1, page, page + 1]);
  if (page <= 2) [1, 2, 3].forEach((p) => keep.add(p));
  if (page >= pageCount - 3) [pageCount - 4, pageCount - 3, pageCount - 2].forEach((p) => keep.add(p));
  const pages = [...keep].filter((p) => p >= 0 && p < pageCount).sort((a, b) => a - b);
  const out: (number | null)[] = [];
  pages.forEach((p, i) => {
    const gap = i > 0 ? p - pages[i - 1] : 1;
    // A single hidden page is shown rather than replaced by an ellipsis of the same width.
    if (gap === 2) out.push(p - 1);
    else if (gap > 2) out.push(null);
    out.push(p);
  });
  return out;
}
