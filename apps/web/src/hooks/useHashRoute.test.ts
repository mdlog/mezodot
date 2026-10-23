import { afterEach, describe, expect, it, vi } from 'vitest';
import { hashFor, scrollToTop, viewFromHash } from './useHashRoute';

describe('hash routes', () => {
  it('opens the landing page at the root and for unknown hashes', () => {
    expect(viewFromHash('')).toBe('landing');
    expect(viewFromHash('#/')).toBe('landing');
    expect(viewFromHash('#/nowhere')).toBe('landing');
  });

  it('keeps every app view deep-linkable, the dashboard included', () => {
    expect(viewFromHash('#/dashboard')).toBe('dashboard');
    expect(viewFromHash('#/markets')).toBe('markets');
    expect(viewFromHash('#activity')).toBe('activity');
  });

  it('round-trips each view through its hash', () => {
    expect(hashFor('landing')).toBe('#/');
    expect(hashFor('dashboard')).toBe('#/dashboard');
    for (const view of ['landing', 'dashboard', 'crosschain', 'architecture'] as const) expect(viewFromHash(hashFor(view))).toBe(view);
  });
});

describe('scroll reset on a view change', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('returns nothing where window.scrollTo returns a promise (Chrome 153), so React never calls it as a cleanup', () => {
    const scrollTo = vi.fn(() => Promise.resolve());
    vi.stubGlobal('window', { scrollTo });
    expect(scrollToTop()).toBeUndefined();
    expect(scrollTo).toHaveBeenCalledWith(0, 0);
  });
});
