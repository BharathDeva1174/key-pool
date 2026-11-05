import { useCallback, useEffect, useState } from 'react';

/**
 * Light and dark are two printings of one document, not two designs.
 *
 * The default follows the operating system rather than a hardcoded choice: the
 * dashboard is a wall display read all day, in rooms that are dim at night and
 * bright at midday. Pinning one scheme would be wrong half the year. An
 * explicit choice wins from then on and is remembered.
 *
 * Three states, not two. A two-state switch looked tidier but was a lie: once
 * you toggled it, nothing could put you back on "follow the system" without
 * clearing site data, so a user who overrode it once at night was stuck on light
 * every midday afterwards. "Auto" is a state the document is genuinely in, so it
 * is one the operator can return to.
 *
 * index.html sets the class before first paint; this hook only keeps React in
 * step with it afterwards.
 */
export type Theme = 'light' | 'dark';
export type ThemeChoice = 'auto' | Theme;

const STORAGE_KEY = 'keypool.theme';

function readStored(): ThemeChoice | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    // 'system' is the name the earlier release used for the default; accept it
    // so an upgrade does not pin a user who never chose.
    if (raw === 'auto' || raw === 'system') return 'auto';
    if (raw === 'light' || raw === 'dark') return raw;
    return null;
  } catch {
    return null;
  }
}

function current(): Theme {
  if (typeof document === 'undefined') return 'light';
  return document.documentElement.classList.contains('dark') ? 'dark' : 'light';
}

function systemTheme(): Theme {
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

// ------------------------------------------------------- the theme transition

/**
 * The circular reveal.
 *
 * A theme change used to be a flat cross-fade of every colour on the page at
 * once, which is the cheap reading of "it changed": the entire document dims
 * and re-brightens in place, and the eye has nothing to hold onto. The reveal
 * instead sets the new printing down from the control the operator actually
 * touched, so the change has a cause and a direction, and the rest of the
 * screen stays put as a reference.
 *
 * Three details make it read as deliberate rather than as a gimmick:
 *
 *  - the radius is the distance to the *farthest corner*, not to the near one,
 *    so the wipe always finishes by covering the whole viewport regardless of
 *    where on the page the control sits;
 *  - the new snapshot is clipped while the old one is held static beneath it,
 *    so the edge of the circle is a clean boundary between two complete
 *    printings rather than a cross-fade with a moving seam;
 *  - the easing accelerates outward (a fast start settling into a slow arrival
 *    at the far edge), which is what a sheet of paper actually does when it is
 *    set down.
 *
 * View Transitions is an enhancement, never a requirement: where it is missing,
 * or where the operator has asked for reduced motion, the theme simply changes.
 */
type ViewTransitionLike = {
  ready: Promise<void>;
  finished: Promise<void>;
};

type DocumentWithViewTransition = Document & {
  startViewTransition?: (cb: () => void | Promise<void>) => ViewTransitionLike;
};

const WIPE_MS = 520;

export function circularReveal(origin: { x: number; y: number }, mutate: () => void): void {
  const doc = document as DocumentWithViewTransition;
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  if (!doc.startViewTransition || reduced) {
    mutate();
    return;
  }

  const root = document.documentElement;
  // The old rule cross-faded background-color on body. During a transition the
  // new snapshot is captured from a live element, so an in-flight 240ms colour
  // fade would be photographed half-finished. Suspending it for the duration
  // means the snapshot is the settled new printing.
  root.classList.add('theme-wipe');

  const transition = doc.startViewTransition(mutate);

  transition.ready
    .then(() => {
      const w = window.innerWidth;
      const h = window.innerHeight;
      const radius = Math.hypot(
        Math.max(origin.x, w - origin.x),
        Math.max(origin.y, h - origin.y),
      );
      root.animate(
        {
          clipPath: [
            `circle(0px at ${origin.x}px ${origin.y}px)`,
            `circle(${radius}px at ${origin.x}px ${origin.y}px)`,
          ],
        },
        {
          duration: WIPE_MS,
          easing: 'cubic-bezier(0.32, 0.72, 0, 1)',
          pseudoElement: '::view-transition-new(root)',
        },
      );
    })
    // A transition that is skipped or interrupted is not a failure - the theme
    // has still been applied by the callback. Swallowing keeps one rejected
    // promise from surfacing as an unhandled rejection.
    .catch(() => {});

  transition.finished
    .catch(() => {})
    .finally(() => root.classList.remove('theme-wipe'));
}

export function useTheme(): {
  choice: ThemeChoice;
  theme: Theme;
  setChoice: (next: ThemeChoice, origin?: { x: number; y: number }) => void;
} {
  const [choice, setChoiceState] = useState<ThemeChoice>(() => readStored() ?? 'auto');
  const [theme, setTheme] = useState<Theme>(current);

  const setChoice = useCallback(
    (next: ThemeChoice, origin?: { x: number; y: number }) => {
      setChoiceState((currentChoice) => {
        if (currentChoice === next) return currentChoice;

        try {
          if (next === 'auto') localStorage.removeItem(STORAGE_KEY);
          else localStorage.setItem(STORAGE_KEY, next);
        } catch {
          /* private mode: the choice lasts for this page view only */
        }

        // On 'auto' the class is left to the media listener below - writing it
        // here would pin the document to whatever the system says at this
        // instant and stop it following later.
        const change = () => {
          const resolved = next === 'auto' ? systemTheme() : next;
          document.documentElement.classList.toggle('dark', resolved === 'dark');
          setTheme(resolved);
        };

        if (origin) circularReveal(origin, change);
        else change();

        return next;
      });
    },
    [],
  );

  // Follow the system until the operator overrides it. Without this, someone
  // who flips their OS to light at sunset still sees a dark dashboard until
  // they think to go and change it here.
  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = (event: MediaQueryListEvent) => {
      if (readStored() !== null) return;
      document.documentElement.classList.toggle('dark', event.matches);
      setTheme(event.matches ? 'dark' : 'light');
    };
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, []);

  return { choice, theme, setChoice };
}

const INK_KEYS = [
  'canvas',
  'surface',
  'raised',
  'inset',
  'line',
  'line-strong',
  'fg',
  'subtle',
  'muted',
  'faint',
  'accent',
  'ok',
  'warn',
  'bad',
] as const;

export type Ink = Record<(typeof INK_KEYS)[number], string>;

/**
 * The resolved ink palette, as real colour values.
 *
 * SVG attributes - Recharts strokes, fills, gridlines - cannot read a Tailwind
 * class, and `stroke="var(--ink-accent)"` is not dependable across browsers for
 * presentation attributes. Reading the computed value is the honest way to let
 * a chart follow the theme, and it re-reads whenever the theme changes so a
 * chart redraws in the new ink rather than keeping the old.
 */
function readInk(): Ink {
  const next = {} as Record<string, string>;
  if (typeof document === 'undefined') return next as Ink;
  const styles = getComputedStyle(document.documentElement);
  for (const key of INK_KEYS) next[key] = styles.getPropertyValue(`--ink-${key}`).trim();
  return next as Ink;
}

/**
 * Watches the resolved scheme rather than the stored choice.
 *
 * Keying on the choice looked right and was wrong: on 'auto' the document's
 * class changes when the OS flips, but the choice does not, so every chart on
 * the page would have kept the old ink until the operator re-clicked the
 * toggle. The class is the thing the tokens actually follow, so this observes
 * the class - which also covers the pre-paint script in index.html, before
 * React has mounted at all.
 */
function useResolvedTheme(): string {
  const [resolved, setResolved] = useState(() => document.documentElement.className);
  useEffect(() => {
    const observer = new MutationObserver(() =>
      setResolved(document.documentElement.className),
    );
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    return () => observer.disconnect();
  }, []);
  return resolved;
}

export function useInk(): Ink {
  const resolved = useResolvedTheme();
  // Read synchronously on the first render, not from an effect. Seeding with an
  // empty object meant every chart's first paint asked for stroke={undefined}:
  // the axes and the trace were briefly invisible, which is exactly the sort of
  // half-finished flicker a wall display cannot afford.
  const [ink, setInk] = useState<Ink>(readInk);

  useEffect(() => {
    setInk(readInk());
  }, [resolved]);

  return ink;
}
