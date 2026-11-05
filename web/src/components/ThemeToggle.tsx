import { useLayoutEffect, useRef, useState } from 'react';
import { Icon } from './Icon';
import { useTheme, type ThemeChoice } from '../lib/theme';
import { t } from '../lib/i18n';

const OPTIONS: { value: ThemeChoice; label: string; icon: 'auto' | 'sun' | 'moon' }[] = [
  { value: 'auto', label: 'Follow system', icon: 'auto' },
  { value: 'light', label: 'Light', icon: 'sun' },
  { value: 'dark', label: 'Dark', icon: 'moon' },
];

/**
 * Light / dark / follow-the-system.
 *
 * Three states, and the third is not decoration. The dashboard genuinely does
 * follow the system until someone overrides it, so "follow the system" is a
 * real state of the document - but the old two-state switch offered no way back
 * to it, so one override was permanent. Selecting it clears the stored choice
 * and hands the document back to the OS.
 *
 * A segmented control rather than a switch, because three positions do not fit
 * on a switch, and a cycle-on-click control hides the options it is cycling
 * through. As a radiogroup it is keyboard-navigable and each state is named,
 * which a two-glyph button never was.
 *
 * The control is a capsule, and the thumb is a capsule inside it. This is the
 * one place the surface breaks its own rule that radii stay small, so it is
 * worth saying why: a 6px corner on a 34px-tall control is not restraint, it is
 * a box with its edges filed off. The thumb has to be a capsule to sit inside a
 * capsule without its corners showing past the track, so the track is made one
 * too - the two agreeing is what makes the thumb read as part of the control
 * rather than a shape parked on top of it.
 *
 * The selection is a single moving piece rather than three independently
 * repainted buttons. Each option used to gain its own background on click, so
 * the highlight appeared where it was pressed and the rest of the control was
 * static. A thumb that travels from the old position to the new one gives the
 * change a direction: the operator sees *which way* the document moved, which
 * on a light/dark/auto control is the entire meaning of the gesture.
 *
 * Its geometry is measured rather than computed. The control is icon-only in
 * the margin and icon-plus-label on narrow screens, so the three positions are
 * not equal thirds and no fixed `left` or `width` survives both layouts.
 */
export function ThemeToggle({ compact = false }: { compact?: boolean }) {
  const { choice, setChoice } = useTheme();
  const groupRef = useRef<HTMLDivElement>(null);
  const [thumb, setThumb] = useState<{ x: number; y: number; w: number; h: number } | null>(null);

  // Measured before paint, so the thumb is already under the correct option on
  // the first frame rather than sliding in from the left after it appears.
  useLayoutEffect(() => {
    const group = groupRef.current;
    if (!group) return;
    const measure = () => {
      const active = group.querySelector<HTMLElement>('[data-active="true"]');
      if (active) {
        setThumb({
          x: active.offsetLeft,
          y: active.offsetTop,
          w: active.offsetWidth,
          h: active.offsetHeight,
        });
      }
    };
    measure();
    // The labels appear and disappear at the container-query breakpoint, so the
    // thumb has to be re-measured when the control changes width - not only when
    // the choice changes.
    const observer = new ResizeObserver(measure);
    observer.observe(group);
    return () => observer.disconnect();
  }, [choice, compact]);

  const pick = (value: ThemeChoice, el: HTMLButtonElement) => {
    // The reveal starts from the control that was pressed, so the change has a
    // visible cause instead of arriving from nowhere.
    const rect = el.getBoundingClientRect();
    setChoice(value, { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 });
  };

  return (
    <div
      ref={groupRef}
      role="radiogroup"
      aria-label={t('Colour theme')}
      className="relative inline-flex items-center gap-0.5 rounded-full border border-line bg-inset p-0.5"
    >
      {/*
        The thumb sits behind the options and carries no state of its own - it is
        a drawing of where the selection is. `aria-hidden` because the selection
        is already announced by the radiogroup below.

        "Behind" has to be earned. A positioned element paints after in-flow
        non-positioned content, so an absolutely-positioned thumb laid down
        first still covers the icons and labels under it - the selected option
        was being blacked out, leaving only the sliver that spilled past the
        thumb's own insets. The options below are `relative` for the same reason.
      */}
      {thumb && (
        <span
          aria-hidden
          style={{
            transform: `translate(${thumb.x}px, ${thumb.y}px)`,
            width: `${thumb.w}px`,
            height: `${thumb.h}px`,
          }}
          className="absolute left-0 top-0 rounded-full border border-line bg-surface
                     transition-[transform,width,height] duration-200 ease-out motion-reduce:transition-none"
        />
      )}
      {OPTIONS.map((opt) => {
        const active = choice === opt.value;
        return (
          <button
            key={opt.value}
            type="button"
            role="radio"
            aria-checked={active}
            data-active={active}
            title={t(opt.label)}
            aria-label={t(opt.label)}
            onClick={(e) => pick(opt.value, e.currentTarget)}
            className={
              // `relative` lifts each option above the thumb. Without it the
              // thumb - being positioned, and so painted later - covered the
              // label of whichever option was selected.
              'relative flex h-7 items-center justify-center rounded-full text-subtle ' +
              'transition-colors duration-150 ' +
              (compact ? 'w-7' : 'w-7 sm:w-auto sm:gap-1.5 sm:px-2') +
              // No fill of its own: the thumb owns it, and a second fill sitting
              // at the destination would show the highlight twice while the thumb
              // is still travelling there.
              (active ? 'text-accent' : 'hover:text-fg')
            }
          >
            <Icon name={opt.icon} size={14} />
            {!compact && <span className="hidden text-xs font-medium sm:inline">{t(opt.label)}</span>}
          </button>
        );
      })}
    </div>
  );
}
