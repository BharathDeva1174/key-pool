# Design system — KeyPool

<!-- impeccable:design-schema 1 -->

KeyPool's interface is an **engineering datasheet**: a measured register of a
live instrument, read at a glance. This file records the durable rules. Exact
token values live in `web/src/index.css` and are the source of truth; the values
quoted here are the ones a later change must not silently break.

## The world

Ink on paper, and its inversion under a desk lamp. A datasheet earns its
premium from precision, not ornament: ruled sections, figures that carry their
units, one accent, hairline structure. Elevation is drawn, never cast.

The thing this system refuses is the arrangement the category ships by
default — a grid of identical stat cards, each figure the same size and
therefore equally ignorable. Here the vitals are **one ruled band**, the roster
is a **ruled table**, and the trace is a **figure**. If a new page is assembled
out of equal cards, it has left this world.

## Color

One accent, and it means one thing: *selected, or live*. Nothing decorative is
allowed to be the accent colour.

- Strategy is **Restrained** — neutrals plus a single accent. The visitor came
  to operate, not to be persuaded.
- `ok` / `warn` / `bad` each mean exactly one state and are never used for
  anything else.
- Light is the native printing; dark is the same document read under a lamp.
  They are two values of the same tokens, not two designs.

**A live streak is accented; a dead one is not.** The streak on the Stats page is
the surface's one gamified element, and it is the surface's one addition to what
the accent means — so it is recorded here rather than left to be read as a
violation. The flame, the figure, the filled day-cells and an earned badge take
the accent *only while the run is alive*; at zero the figure falls to the
foreground ink and the flame to `faint`, so the panel reads as inert rather than
as a failure. That is the same rule as everywhere else: the accent reports a
state, it does not decorate a box. What the streak is **not** allowed is a second
accent, a gold or amber "reward" ink, or a colour that changes with the tier —
`warn` in particular means exactly one thing and a milestone is not it. A
**locked** badge is `faint`, not accent: an unearned milestone must not look
earned.

### Tokens are semantic, never literal

There is no `slate-500` in this codebase. Colour is referenced by role:
`canvas`, `surface`, `raised`, `inset`, `line`, `line-strong`, `fg`, `subtle`,
`muted`, `faint`, `accent`, `ok`, `warn`, `bad`. The values are defined twice —
once in `:root`, once in `.dark` — and registered into Tailwind with
`@theme inline`, so one class name resolves to different ink per theme at use
time. Adding a page means using these names, never introducing a new colour.

### Contrast is a floor, not an aspiration

Every ink was measured, not eyeballed. **Measured against `--ink-surface`** (the
panel), because that is where text actually sits — a figure on the bare ground
has more room and reads better than the same figure inside a panel, so the panel
is the number that has to hold.

| Role | Light | Dark | Requirement |
| --- | --- | --- | --- |
| `fg` / `subtle` / `muted` | 18.3 / 10.8 / 6.7 : 1 | 15.9 / 10.8 / 6.7 : 1 | 4.5:1 as text |
| `faint` | 5.4:1 | 5.0:1 | 4.5:1 — it is the quietest ink, never a decorative grey |
| `accent` | 5.8:1 | 9.7:1 | 4.5:1 as text |
| `ok` / `warn` / `bad` | 6.6 / 6.2 / 6.6 : 1 | 9.7 / 11.2 / 6.8 : 1 | 4.5:1 as text |
| `line-strong` | 3.8:1 | 3.5:1 | 3:1 — it carries control boundaries |
| `line` | 1.3:1 | 1.2:1 | Decorative rules only; never identifies a control |

**Re-measure before you re-tune a hex.** These drift: nudging one token moves
the numbers for every figure that uses it, and the table is the only record of
where the floor is. If a change pushes a role under its requirement, fix the
token rather than editing this table to match.

`line` is the one value permitted below 3:1, because a hairline rule inside a
panel is decoration. `line-strong` exists precisely because a rule that *does*
identify a control — a ghost button's frame, the off-state switch — must clear
the WCAG 1.4.11 bar. Do not use `line` for a control boundary.

## Type

- **Sans** is the system UI stack. No webfont is downloaded; KeyPool is a local
  tool and a font request on every dashboard load buys nothing.
- **Mono is for data and measurement only** — figures, model ids, key hints,
  durations, endpoints. It is never applied to prose to look technical.
- **Every figure is tabular** (`.tnum`). A column of numbers that jitters as it
  updates cannot be read at a glance, which is the entire purpose of the page.
- Uppercase tracking is reserved for **column heads and field labels**. It is not
  an eyebrow above a section; a tracked uppercase eyebrow over every section is
  grammar nobody chose.
- Headings are sentence case. Emphasis comes from size and weight, never from
  gradient text.

## Structure

- The page is the **ground**; panels are paper laid on top of it. The margin
  column shares that ground and is ruled off with one hairline — tinting the
  margin as well would mean two grounds meeting along a rule that was never
  meant to be a seam. Light keeps the ground a half-step under white so the
  panels advance and the hairlines still carry the structure; dark lifts the
  surface off the ground instead. Both are the same four-step ladder:
  `canvas → surface → raised → inset`.
- Panels are `.card`: one hairline, one fill, **no shadow**. A 1px border under
  a wide soft shadow is a ghost card. Elevation is declared once — here, as a
  border.
- **Panels do not nest.** A card inside a card is always wrong. The Overview's
  figures sit in one ruled band precisely so they are not eight cards.
- **A block inserted into the margin pins its height.** The nav measures the
  active row's offset inside a `ResizeObserver` on the `<nav>`, which is
  `flex-1` — so a block that grows after first paint moves every row below it
  *without resizing the observed element*. The observer never fires and the
  travelling bar comes to rest on the wrong row. The failure is invisible in a
  screenshot and only appears on navigation, and a `min-height` does not solve
  it: that reserves space for the loading state and then the content grows past
  it anyway. Pin the height (`height:`, not `minHeight:`) and lay the content
  out to fit. The streak lived in the margin first and is the case this rule was
  written for; it now sits on the Stats page, where the rule no longer applies
  to it but still applies to anything else that goes in the column.
- Radii: 12px for panels, 6px for controls, and **no third value**. An ad-hoc
  `rounded-lg` is a radius nothing else on the page uses. Instruments are not
  pills.
  **One recorded exception: the theme toggle is a full capsule.** A 6px corner
  on a 34px-tall control is not restraint, it is a box with its edges filed off,
  and the travelling thumb already has to be a capsule to sit inside it. Making
  the track one too is what makes the thumb read as part of the control rather
  than a shape parked on top of it. It is the only pill in the surface; the
  other segmented controls stay on `--radius-control`, and a third radius
  anywhere else would still be the ad-hoc value this rule exists to prevent.
- **Wells are the `inset` token, not the ground washed with alpha.** A
  translucent `bg-canvas/50` over a white panel is a workaround for a value
  that already has a name, and it changes with whatever it sits on.
- **The same control is built the same way on every page.** The window selector
  and the theme control both pick one value out of a set; they are both inset
  tracks with a papered chip on the active position. Two mastheads, two
  segmented controls and two heading scales across adjacent pages is what makes
  an app read as assembled rather than designed. The theme toggle's capsule is
  the one departure, and it is deliberate: it is the only control whose chip
  travels between positions rather than repainting in place, and it is the only
  one in the margin, so it reads as a property of the document rather than as
  another instance of the same widget.
- A figure sits under a caption that describes it. No figure numbers unless a
  document has more than one figure to cross-reference.

## Motion

Motion is for **state, feedback and continuity** — this is an Operate surface,
and the visitor is glancing at a wall display between other work. It must never
make anyone wait.

- **The one authored moment: the readout settles.** When a value genuinely
  changes, its figure eases into place and a single hairline of accent sweeps
  beneath it. Driven by `useReadoutTick` in `components/ui.tsx`, which remounts
  the element via `key` so the animation replays. An idle dashboard is
  completely still — the animation fires only on a real change.
  The streak's figure replays the same settle rather than authoring a second
  one, and it adds no keyframes of its own, so the reduced-motion collapse keeps
  working for it for free.
- **A milestone announces itself once, then never again.** Reaching a tier fires
  a single toast, guarded by a ref so the Stats poll cannot re-fire it — that
  page refreshes every three seconds, so an unguarded toast would repeat forever,
  and a toast that repeats every few seconds is an alarm, not a reward. The
  first load adopts what is already earned without announcing it: a toast for a
  milestone reached while the page was closed tells the operator nothing they do
  not already know. Nothing else about the streak
  moves: no looping flame, no pulsing, no confetti. The flame grows in *size*
  across tiers, which is a state change, not an animation.
- **Selection travels; it does not teleport.** The contents bar and the theme
  control's thumb are single marks that move between positions, not sets of
  items that each light up on click. A selection that jumps tells the operator
  *where* they are; one that slides also tells them *which way they came*, and
  on a light/dark/auto control that direction is the entire meaning. Both are
  measured from the real elements in a layout effect, never from a hard-coded
  offset, because the rows and the labels are sized by their own content.
- **The trace is drawn when the operator picks a window, and not otherwise.**
  A poll redraws the chart whether or not a sample moved, so an unattended
  display would otherwise rehearse its opening animation forever. The draw is
  gated on the first load and on a deliberate range change; a poll moves the
  trace without redrawing it. Duration is 420ms, set explicitly — Recharts
  defaults to 1500ms.
- Theme changes are the circular reveal, below. An OS-driven flip, which the
  operator did not cause, takes the 240ms cross-fade instead.
- Routine feedback — buttons, toggles, toasts — is 150ms or less. **Exit is
  faster than entrance**: a toast takes 140ms to leave and 200ms to arrive, and
  a toast that vanishes between two frames after animating in reads as a
  glitch. No bounce, no elastic, no parallax, no scroll reveal.
- Every duration comes from the three named steps in `index.css`
  (`--ease-out-quint`, `--ease-standard`, `--ease-wipe`) rather than a number
  written into a component.
- `prefers-reduced-motion: reduce` collapses every duration to 0.01ms, and
  separately disables view-transition pseudo-elements — no element selector
  reaches those, so the blanket rule alone would leave the reveal playing. This
  is not optional.

## Theme

`index.html` resolves the theme **before first paint**; without that the page
renders in the default scheme and snaps, which a wall display cannot afford.

The default follows `prefers-color-scheme`. The operator's room is dim at night
and bright at midday, so pinning one scheme would be wrong half the year. An
explicit choice is stored in `localStorage` under `keypool.theme` and wins from
then on; until then the dashboard keeps following the system, including when
the OS flips at sunset.

The control is **three-state** — follow the system, light, dark — because
"follow the system" is a real state the document is genuinely in, and a
two-state switch offered no way back to it: one override was permanent. It is a
segmented radiogroup rather than a switch, because three positions do not fit
on a switch, and it lives in the margin because the theme is a property of the
document rather than a place on the contents page.

### The reveal

A theme change is a **circular reveal** from the control the operator pressed,
implemented with the View Transitions API in `circularReveal`
(`web/src/lib/theme.ts`). The new printing is clipped to a circle growing out
of the control while the old one is held still beneath it, so the moving edge
is a clean boundary between two complete documents rather than a cross-fade
with a seam travelling with it. The radius is the distance to the **farthest
corner**, so the wipe finishes covering the viewport wherever the control sits;
the easing accelerates outward, the way a sheet is set down.

It is an enhancement and never a requirement: without the API, or under reduced
motion, the theme simply changes. The body cross-fade is suspended for the
duration, because a transition photographs the page after its callback runs and
would otherwise capture a ground colour still half-faded.

## Charts

Recharts cannot read a Tailwind class, and `stroke="var(--ink-accent)"` is not
dependable for SVG presentation attributes. `useInk()` in `lib/theme.ts` reads
the computed token values and re-reads them on theme change, so a chart redraws
in the new ink rather than keeping the old.

- Gridlines and axes are `line` or `muted`, never the accent.
- Series colour is categorical and minimal: traffic is `ok`, failure is `bad`.
- **Error kinds are ranked, not categorical**, so the error bar chart is one ink
  rather than a rainbow. A palette there would imply a relationship between
  error kinds that does not exist.
- Tooltip surfaces use `surface` with a `line` border so they read in both
  themes.
- **A spend breakdown is one ink, not a palette.** The by-model, by-provider and
  by-key charts are a single `accent` series, because the rows beneath each chart
  already name every entry and a categorical palette would imply a comparison
  between spends that nobody asked for. Ranked, not categorised — the same
  reasoning as the error chart.

## Do not

- Do not build a page out of equal stat cards.
- Do not add a shadow to a panel.
- Do not introduce a colour that is not a role above — and do not reach past the
  roles for a literal (`text-sky-400`, `slate-500`) when one already fits. One
  such figure among its neighbours reads as a different kind of figure.
- Do not let a margin block grow after first paint, and do not reach for
  `minHeight` as a substitute — see the pinned-height rule under *Structure*.
- Do not make the streak mean anything competitive. It is the operator against
  their own best run, and adding a rank, a comparison or a shared board would put
  a team in an interface whose whole premise is that there is only one.
- Do not revoke an earned badge or a personal best when a streak breaks, and do
  not let a zero-streak state scold. Both are what turn a streak into a reason to
  stop opening the app.
- Do not use `line` for anything that identifies a control.
- Do not add motion to a static area, and do not repeat one entrance on every
  section.
- Do not let a chart keep a hardcoded hex, and do not let a chart redraw itself
  on a timer.

- Do not build one control two ways, or give the same figure a third radius.
