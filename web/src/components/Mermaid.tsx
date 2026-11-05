import { useEffect, useState } from 'react';
import { t } from '../lib/i18n';
import { useInk } from '../lib/theme';

let counter = 0;

/*
 * One diagram, drawn from a mermaid definition string.
 *
 * `mermaid` is imported dynamically: it is larger than the rest of the bundle
 * put together, and only this page needs it, so Vite splits it into a chunk
 * that loads when a diagram first renders rather than taxing every page.
 *
 * Charts cannot read a Tailwind class, so the diagram is re-rendered with the
 * resolved ink palette whenever the theme changes - the same rule as Recharts
 * in `lib/theme.ts`, applied to mermaid's theme variables. `securityLevel:
 * 'strict'` is mermaid's own sanitiser; the rendered SVG is trusted output of
 * that pipeline and nothing user-supplied ever reaches it.
 */
export function Mermaid({ chart }: { chart: string }) {
  const ink = useInk();
  const [svg, setSvg] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    setFailed(false);
    void (async () => {
      try {
        const mermaid = (await import('mermaid')).default;
        if (!alive) return;
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: 'strict',
          theme: 'base',
          themeVariables: {
            background: 'transparent',
            fontFamily: 'ui-sans-serif, system-ui, sans-serif',
            fontSize: '13px',
            textColor: ink.fg,
            primaryColor: ink.inset,
            primaryTextColor: ink.fg,
            primaryBorderColor: ink['line-strong'],
            secondaryColor: ink.surface,
            secondaryTextColor: ink.fg,
            secondaryBorderColor: ink['line-strong'],
            tertiaryColor: ink.canvas,
            lineColor: ink['line-strong'],
            mainBkg: ink.inset,
            nodeBorder: ink['line-strong'],
            edgeLabelBackground: ink.surface,
            labelBackground: ink.surface,
          },
        });
        const rendered = await mermaid.render(`mermaid-${++counter}`, chart);
        if (alive) setSvg(rendered.svg);
      } catch {
        if (alive) setFailed(true);
      }
    })();
    return () => {
      alive = false;
    };
  }, [chart, ink]);

  if (failed) {
    // A diagram that cannot be drawn is said, not hidden - the copy around it
    // carries the meaning either way.
    return <p className="text-xs text-faint">{t('Diagram could not be rendered.')}</p>;
  }
  if (!svg) return null;
  return <div className="mt-4 overflow-x-auto" dangerouslySetInnerHTML={{ __html: svg }} />;
}
