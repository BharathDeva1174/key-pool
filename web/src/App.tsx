import { useLayoutEffect, useRef, useState } from 'react';
import { NavLink, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { ToastProvider } from './components/ui';
import { ThemeToggle } from './components/ThemeToggle';
import { Icon, type IconName } from './components/Icon';
import Overview from './pages/Overview';
import Upstreams from './pages/Upstreams';
import Models from './pages/Models';
import Ranking from './pages/Ranking';
import Spoofing from './pages/Spoofing';
import Stats from './pages/Stats';
import Costs from './pages/Costs';
import Logs from './pages/Logs';
import Settings from './pages/Settings';
import About from './pages/About';
import { classNames } from './lib/format';
import { t } from './lib/i18n';

const NAV: { to: string; label: string; icon: IconName; end?: boolean }[] = [
  { to: '/', label: 'Overview', icon: 'overview', end: true },
  { to: '/upstreams', label: 'Upstreams', icon: 'upstreams' },
  { to: '/models', label: 'Models', icon: 'models' },
  { to: '/ranking', label: 'Intelligent ranking', icon: 'ranking' },
  { to: '/spoofing', label: 'Model spoofing', icon: 'spoof' },
  { to: '/stats', label: 'Stats', icon: 'stats' },
  { to: '/costs', label: 'Costs', icon: 'costs' },
  { to: '/logs', label: 'Request log', icon: 'logs' },
  { to: '/settings', label: 'Settings', icon: 'settings' },
  { to: '/about', label: 'About', icon: 'info' },
];

/**
 * The contents column.
 *
 * The selection is a single travelling mark rather than six independently lit
 * items. Every link used to gain its own accent fill the moment it was pressed,
 * so the highlight teleported and the two ends of the column were never
 * connected - on a list this short, that reads as a set of unrelated buttons
 * rather than a position in a sequence.
 *
 * One bar that slides from the old section to the new one makes the move
 * legible, and it takes one transform: it is the only thing on the surface that
 * says where you were, and it says it while you are already reading the page you
 * just opened.
 *
 * Its geometry is measured rather than hard-coded, because the rows are
 * measured by their own labels and would drift the moment one of them changed.
 */
function Contents() {
  const { pathname } = useLocation();
  const listRef = useRef<HTMLElement>(null);
  const [mark, setMark] = useState<{ y: number; h: number } | null>(null);

  // Measured before paint, so the bar is already beside the right row on the
  // first frame of a new page rather than catching up a frame later.
  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const measure = () => {
      const active = list.querySelector<HTMLElement>('[data-active="true"]');
      if (active) setMark({ y: active.offsetTop, h: active.offsetHeight });
    };
    measure();
    // A window narrower than the desktop breakpoint reflows the label beside
    // each icon, which changes every row's height.
    const observer = new ResizeObserver(measure);
    observer.observe(list);
    return () => observer.disconnect();
  }, [pathname]);

  return (
    <nav
      ref={listRef}
      className="relative flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto"
    >
      {mark && (
        <span
          aria-hidden
          style={{ transform: `translateY(${mark.y}px)`, height: `${mark.h}px` }}
          className="absolute top-0 left-0 w-0.5 rounded-full bg-accent
                     transition-transform duration-200 ease-out motion-reduce:transition-none"
        />
      )}
      {NAV.map((item) => {
        // Derived here rather than taken from NavLink's render prop, because the
        // bar has to measure the link itself and a child span would report an
        // offset relative to its own link, not to this column.
        const active = item.end ? pathname === item.to : pathname.startsWith(item.to);
        return (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.end}
            data-active={active}
            className={classNames(
              'group relative flex items-center gap-2.5 rounded-[var(--radius-control)] py-2 pr-3 pl-3.5',
              'text-sm transition-colors duration-150',
              // The bar above is the accent. Tinting the row as well would print
              // "selected" twice, and a filled block is the thing this surface
              // refuses to be.
              active ? 'bg-raised font-medium text-fg' : 'text-muted hover:bg-raised hover:text-fg',
            )}
          >
            {/* The icon holds its own box so that swapping a symbol for a drawn
                glyph cannot shift the label off the shared left edge the six
                items are aligned on. */}
            <span
              className={classNames(
                'flex h-4 w-4 shrink-0 items-center justify-center transition-colors duration-150',
                active ? 'text-accent' : 'text-muted group-hover:text-fg',
              )}
            >
              <Icon name={item.icon} size={16} />
            </span>
            {t(item.label)}
          </NavLink>
        );
      })}
    </nav>
  );
}

function Shell() {
  return (
    <div className="flex min-h-screen">
      {/*
        A marginal column, ruled off from the sheet with a single hairline.
        It shares the page ground rather than carrying its own fill: the ground
        is the unprinted sheet and the white panels are what sits on top of it,
        so tinting the margin as well would have meant two grounds meeting along
        a rule that was never meant to be a seam.
      */}
      <aside className="sticky top-0 hidden h-screen w-56 shrink-0 flex-col border-r border-line bg-canvas px-3 py-5 md:flex">
        <div className="mb-7 flex items-center gap-2.5 px-2">
          {/* A seal, not an app icon: a hairline box with the mark in it, so the
              accent appears as a stamp on the document rather than as a
              coloured chip competing with the figures. */}
          <span className="flex h-8 w-8 items-center justify-center rounded-[var(--radius-control)] border border-line-strong text-accent">
            <Icon name="pool" size={16} />
          </span>
          <div>
            <p className="text-sm font-semibold text-fg">KeyPool</p>
            <p className="text-[10px] tracking-wider text-muted uppercase">{t('OpenAI proxy')}</p>
          </div>
        </div>
        <Contents />
        {/* The document's own properties, so they live in the margin with the
            rest of the furniture - never floating over the sheet, where a
            control reads as an artefact rather than a control. */}
        <div className="mt-auto space-y-3 px-2 pt-6">
          <ThemeToggle />
          <p className="text-[10px] leading-relaxed text-faint">
            {t('Clients point at')} <span className="font-mono text-muted">/v1</span>
            <br />
            {t('Everything else is pooled upstream.')}
          </p>
        </div>
      </aside>

      <div className="min-w-0 flex-1">
        {/* Nine destinations do not fit a 390px phone, so the bar scrolls. The
            right-edge fade is the affordance: without it, Settings simply
            looks like it does not exist.

            The streak is deliberately absent here. A figure needs room for a
            number and a label, and this row is already a scroller competing for
            horizontal space; a fourth kind of pill in it would read as another
            destination rather than as the margin's furniture. */}
        <header className="nav-scroll sticky top-0 z-30 flex items-center gap-2 overflow-x-auto border-b border-line bg-canvas/90 px-4 py-2.5 backdrop-blur-sm md:hidden">
          {NAV.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              className={({ isActive }) =>
                classNames(
                  'flex shrink-0 items-center gap-1.5 rounded-[var(--radius-control)] px-2.5 py-1.5 text-xs whitespace-nowrap transition-colors duration-150',
                  isActive ? 'bg-raised font-medium text-fg' : 'text-muted',
                )
              }
            >
              {({ isActive }) => (
                <>
                  <span className={isActive ? 'text-accent' : undefined}>
                    <Icon name={item.icon} size={13} />
                  </span>
                  {t(item.label)}
                </>
              )}
            </NavLink>
          ))}
          <span className="ml-auto shrink-0 pl-2">
            <ThemeToggle compact />
          </span>
        </header>

        <main className="mx-auto w-full max-w-7xl px-4 py-6 sm:px-6 sm:py-8">
          <Routes>
            <Route path="/" element={<Overview />} />
            <Route path="/upstreams" element={<Upstreams />} />
            <Route path="/models" element={<Models />} />
            <Route path="/ranking" element={<Ranking />} />
            <Route path="/spoofing" element={<Spoofing />} />
            <Route path="/stats" element={<Stats />} />
            <Route path="/costs" element={<Costs />} />
            <Route path="/logs" element={<Logs />} />
            <Route path="/settings" element={<Settings />} />
            <Route path="/about" element={<About />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </main>
      </div>
    </div>
  );
}

export default function App() {
  return (
    <ToastProvider>
      <Shell />
    </ToastProvider>
  );
}
