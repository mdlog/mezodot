import { useCallback, useEffect, useState } from 'react';

export const VIEWS = ['landing', 'dashboard', 'portfolio', 'markets', 'crosschain', 'borrow', 'loop', 'agents', 'architecture', 'activity'] as const;
export type View = (typeof VIEWS)[number];

/** View for a location hash: `#/markets` → markets. The bare root, and anything unknown, is the landing page. */
export const viewFromHash = (hash: string): View => {
  const key = hash.replace(/^#\/?/, '');
  return (VIEWS as readonly string[]).includes(key) ? (key as View) : 'landing';
};

export const hashFor = (view: View): string => (view === 'landing' ? '#/' : `#/${view}`);

/**
 * The view-change effect. Returns nothing: Chrome 153 returns a promise from `window.scrollTo`, and an effect that
 * passed it on would give React a non-function cleanup, which throws "destroy is not a function" on the next view.
 */
export const scrollToTop = (): void => {
  window.scrollTo(0, 0);
};

/** Hash-based routing (`#/markets`) so views survive reloads and can be deep-linked without server config. */
export function useHashRoute(): [View, (view: View) => void] {
  const [view, setView] = useState<View>(() => viewFromHash(window.location.hash));

  useEffect(() => {
    const onChange = () => setView(viewFromHash(window.location.hash));
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);

  // A new view starts at its top (the landing page is long; the app keeps the window as its scroller).
  useEffect(scrollToTop, [view]);

  const navigate = useCallback((next: View) => {
    const hash = hashFor(next);
    if (window.location.hash !== hash) window.location.hash = hash;
    setView(next);
  }, []);

  return [view, navigate];
}
