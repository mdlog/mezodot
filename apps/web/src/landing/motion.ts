import { useEffect, useRef, useState } from 'react';

export const easeOutCubic = (t: number): number => 1 - (1 - Math.min(1, Math.max(0, t))) ** 3;

/** Value `elapsed` ms into a `duration` ms ease from `from` to `to`. */
export const tweenAt = (from: number, to: number, elapsed: number, duration: number): number =>
  duration <= 0 ? to : from + (to - from) * easeOutCubic(elapsed / duration);

export const prefersReducedMotion = (): boolean => typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;

/** True once the element has scrolled into view, and from then on. With reduced motion it starts true. */
export function useInView<T extends Element>(threshold = 0.18) {
  const ref = useRef<T>(null);
  const [seen, setSeen] = useState(() => prefersReducedMotion() || typeof IntersectionObserver === 'undefined');
  useEffect(() => {
    const el = ref.current;
    if (seen || !el) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((e) => e.isIntersecting)) return;
        setSeen(true);
        observer.disconnect();
      },
      { threshold, rootMargin: '0px 0px -8% 0px' },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [seen, threshold]);
  return [ref, seen] as const;
}

/**
 * Number that counts up to `target` once `start` is true, and glides to each later target from the value
 * already on screen (live stats refetch). Null while there is no target.
 */
export function useCountUp(target: number | null, start: boolean, duration = 1400): number | null {
  const [value, setValue] = useState(0);
  const shown = useRef(0);
  const reduced = prefersReducedMotion();
  useEffect(() => {
    if (target === null || !start || reduced) return;
    const from = shown.current;
    const begin = performance.now();
    let frame = requestAnimationFrame(function tick(now) {
      shown.current = tweenAt(from, target, now - begin, duration);
      setValue(shown.current);
      if (now - begin < duration) frame = requestAnimationFrame(tick);
    });
    return () => cancelAnimationFrame(frame);
  }, [target, start, duration, reduced]);
  if (target === null) return null;
  return reduced ? target : value;
}

/** Whether the page has scrolled past `offset` px (the landing nav turns solid). */
export function useScrolled(offset = 12): boolean {
  const [scrolled, setScrolled] = useState(() => typeof window !== 'undefined' && window.scrollY > offset);
  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > offset);
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, [offset]);
  return scrolled;
}
