import { describe, expect, it } from 'vitest';
import { pageList, paginate } from './paginate';

const items = Array.from({ length: 23 }, (_, i) => i);

describe('paginate', () => {
  it('slices a page and reports its range', () => {
    expect(paginate(items, 0, 5)).toEqual({ rows: [0, 1, 2, 3, 4], page: 0, pageCount: 5, total: 23, from: 1, to: 5 });
    expect(paginate(items, 4, 5)).toEqual({ rows: [20, 21, 22], page: 4, pageCount: 5, total: 23, from: 21, to: 23 });
  });

  it('clamps a page that no longer exists (fewer items after a refetch or wallet switch)', () => {
    expect(paginate(items, 9, 5).page).toBe(4);
    expect(paginate(items.slice(0, 7), 3, 5)).toMatchObject({ page: 1, rows: [5, 6], from: 6, to: 7 });
    expect(paginate(items, -2, 5).page).toBe(0);
  });

  it('has one empty page when there is nothing to show', () => {
    expect(paginate([], 0, 5)).toEqual({ rows: [], page: 0, pageCount: 1, total: 0, from: 0, to: 0 });
  });
});

describe('pageList', () => {
  it('lists every page when there are few', () => {
    expect(pageList(0, 1)).toEqual([0]);
    expect(pageList(2, 5)).toEqual([0, 1, 2, 3, 4]);
    expect(pageList(3, 7)).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });

  it('keeps the first, last and neighbouring pages, with gaps (null) between', () => {
    expect(pageList(0, 12)).toEqual([0, 1, 2, 3, null, 11]);
    expect(pageList(5, 12)).toEqual([0, null, 4, 5, 6, null, 11]);
    expect(pageList(11, 12)).toEqual([0, null, 8, 9, 10, 11]);
  });
});
