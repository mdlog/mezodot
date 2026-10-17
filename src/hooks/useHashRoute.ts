import { useCallback, useEffect, useState } from 'react';

export const VIEWS = ['dashboard', 'markets', 'crosschain', 'borrow', 'loop', 'agents', 'architecture', 'activity'] as const;
export type View = (typeof VIEWS)[number];

const parse = (hash: string): View => {
  const key = hash.replace(/^#\/?/, '');
  return (VIEWS as readonly string[]).includes(key) ? (key as View) : 'dashboard';
};

/** Hash-based routing (`#/markets`) so views survive reloads and can be deep-linked without server config. */
export function useHashRoute(): [View, (view: View) => void] {
  const [view, setView] = useState<View>(() => parse(window.location.hash));

  useEffect(() => {
    const onChange = () => setView(parse(window.location.hash));
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);

  const navigate = useCallback((next: View) => {
    const hash = next === 'dashboard' ? '#/' : `#/${next}`;
    if (window.location.hash !== hash) window.location.hash = hash;
    setView(next);
  }, []);

  return [view, navigate];
}
