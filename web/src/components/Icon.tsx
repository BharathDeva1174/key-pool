/**
 * Hairline icon set.
 *
 * The dashboard used Unicode symbols for its navigation and controls - `⬡`,
 * `◈`, `◐`, `✕`. That is the single strongest tell of an unfinished interface:
 * a symbol is a piece of text, so the OS decides its weight, baseline and
 * fallback glyph, it cannot be optically sized against a label, and a screen
 * reader announces "white hexagon" where a control should be named. They also
 * have no shared stroke, so a row of them never optically aligns.
 *
 * These are drawn instead on one 24-unit grid with a single 1.5 stroke and
 * round caps, so they sit on the same optical weight as the 1px rules that
 * carry the rest of the structure. `currentColor` means an icon is always the
 * ink of the text beside it - they cannot drift into being decoration.
 *
 * Every glyph is `aria-hidden`: the label is always the text beside it, and a
 * decorative duplicate of that label is noise, not information.
 */

const PATHS = {
  // Nav
  overview: 'M3 13h4l3-8 4 16 3-8h4',
  upstreams: 'M4 7h16M4 12h16M4 17h10',
  models: 'M12 3 4 7v10l8 4 8-4V7zM4 7l8 4 8-4M12 11v10',
  stats: 'M4 20V10M10 20V4M16 20v-7M22 20H2',
  // A price tag: the mark a catalogue puts on a thing. A coin or a currency
  // glyph would tie the page to one currency, and the display currency is a
  // setting here - the tag is about pricing, not about any one symbol.
  costs: 'M20.6 13.4 13.4 20.6a2 2 0 0 1-2.8 0L3 13V5a2 2 0 0 1 2-2h8l7.6 7.6a2 2 0 0 1 0 2.8zM7.5 7.5h.01',
  logs: 'M4 6h16M4 12h16M4 18h9',
  // A trophy: the one mark that reads as "ranked", not as a statistic.
  ranking: 'M8 21h8M12 17v4M6 3h12v5a6 6 0 0 1-12 0zM6 5H3v1.5a3.5 3.5 0 0 0 3.5 3.5M18 5h3v1.5a3.5 3.5 0 0 1-3.5 3.5',
  // Two opposed arrows: one name standing in for another. A swap reads as
  // "these are interchangeable" where a single arrow only reads as "flows to".
  spoof: 'M4 9h14M14 5l4 4-4 4M20 15H6M10 11l-4 4 4 4',
  settings:
    'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-1.8-.3 1.6 1.6 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1A1.6 1.6 0 0 0 9 19.4a1.6 1.6 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0 .3-1.8 1.6 1.6 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1A1.6 1.6 0 0 0 4.6 9a1.6 1.6 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.8.3H9a1.6 1.6 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 1 1.5 1.6 1.6 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8V9a1.6 1.6 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1z',
  pool: 'M12 2 4 6.5v11L12 22l8-4.5v-11zM4 6.5 12 11l8-4.5M12 11v11',

  // Controls
  close: 'M6 6l12 12M18 6L6 18',
  plus: 'M12 5v14M5 12h14',
  check: 'M4 12.5 9 17.5 20 6.5',
  chevron: 'M6 9.5 12 15.5 18 9.5',
  arrowUp: 'M12 19V5M6 11l6-6 6 6',
  arrowDown: 'M12 5v14M6 13l6 6 6-6',
  arrowLeft: 'M19 12H5M11 6l-6 6 6 6',
  arrowRight: 'M5 12h14M13 6l6 6-6 6',
  copy: 'M9 9h10v10a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2zM15 6.5V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h1.5',
  trash: 'M4 7h16M9.5 7V5a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1v2M6.5 7l1 12.5a1 1 0 0 0 1 .9h7a1 1 0 0 0 1-.9L17.5 7M10 11v5.5M14 11v5.5',

  // Theme
  sun: 'M12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10zM12 1v3M12 20v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M1 12h3M20 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1',
  moon: 'M21 13.1A9 9 0 1 1 10.9 3a7 7 0 0 0 10.1 10.1z',
  // A disc, drawn in outline here and half-filled below. It used to borrow the
  // Overview nav glyph verbatim, so the "follow system" control and the
  // navigation item it sits beside were the same mark on the same screen.
  auto: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z',

  // State
  info: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 11v5M12 8h.01',
  warn: 'M12 3 2 20h20zM12 9v4M12 17h.01',
  refresh: 'M20 11a8 8 0 1 0-.6 4M20 5v6h-6',

  /*
   * The streak flame, drawn on the same 24-unit grid with the same 1.5 stroke
   * so it sits at one optical weight with everything else rather than reading
   * as a sticker from another set.
   *
   * Two tongues over a rounded base: the outer line is the flame, the inner
   * one is the core. The second stroke is what stops a 14px flame reading as a
   * plain teardrop - at the sizes the sidebar uses, a single outline turns into
   * a blob, and the inner mark is what carries the shape at a glance.
   */
  flame: 'M12 2.5c.6 3 2 4.4 3.4 5.9A7.4 7.4 0 0 1 18 13a6 6 0 0 1-12 0c0-1.5.5-2.7 1.3-3.8.3 1 .9 1.8 1.8 2.2-.3-3.3 1-6.1 2.9-8.9zM12 20.5a3 3 0 0 1-1.2-5.7c.5-.3.9-.8 1.2-1.4.3.6.7 1.1 1.2 1.4A3 3 0 0 1 12 20.5z',
} as const;

/**
 * Solid halves, drawn beneath the outline above.
 *
 * The icon set is one optical weight, which is why everything is a stroke and
 * nothing is a fill - a filled glyph beside a stroked one reads as a different
 * family. An outline cannot say "half", though, and "follow the system" is a
 * half-state: it is what the document does when the operator has no opinion.
 * These are the only filled marks in the set, they use the same `currentColor`
 * as everything else, and they exist to make that one idea legible.
 */
const FILLS = {
  auto: 'M12 3a9 9 0 0 0 0 18z',
} as const;

export type IconName = keyof typeof PATHS;

export function Icon({
  name,
  className,
  size = 16,
}: {
  name: IconName;
  className?: string;
  size?: number;
}) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      // Icons are inline-level by default, which leaves a descender gap under
      // them in a flex row. This makes them behave like the text they label.
      style={{ display: 'block', flexShrink: 0 }}
    >
      <path d={PATHS[name]} />
      {name in FILLS && (
        <path d={FILLS[name as keyof typeof FILLS]} fill="currentColor" stroke="none" />
      )}
    </svg>
  );
}
