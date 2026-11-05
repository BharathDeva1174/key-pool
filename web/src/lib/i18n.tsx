/**
 * The whole i18n mechanism: a module-level language store, `t()`, and the
 * React binding.
 *
 * Keys are the English strings themselves, so a missing translation degrades
 * to the original language rather than to a raw key on screen, and reading
 * the source still reads like the product. Interpolation is `{name}`
 * placeholders - enough for counts and names, not a template engine.
 *
 * The store lives outside React so non-component modules (format helpers)
 * can translate too. The provider subscribes once at the top of the tree and
 * re-renders everything on a language change - the dashboard is small enough
 * that a full re-render is cheaper than the class of bug where one forgotten
 * component keeps showing stale text.
 */
import { createContext, useContext, useSyncExternalStore, Fragment, type ReactNode } from 'react';
import { es } from './locales/es';
import { fr } from './locales/fr';
import { de } from './locales/de';
import { hi } from './locales/hi';
import { ja } from './locales/ja';
import { zh } from './locales/zh';

export interface Language {
  code: string;
  /** The language's own name, always shown untranslated - a user picks "日本語" by recognising it. */
  name: string;
  /** BCP 47 tag written to <html lang>. */
  tag: string;
  dictionary: Record<string, string>;
}

export const LANGUAGES: Language[] = [
  { code: 'en', name: 'English', tag: 'en', dictionary: {} },
  { code: 'es', name: 'Español', tag: 'es', dictionary: es },
  { code: 'fr', name: 'Français', tag: 'fr', dictionary: fr },
  { code: 'de', name: 'Deutsch', tag: 'de', dictionary: de },
  { code: 'hi', name: 'हिन्दी', tag: 'hi', dictionary: hi },
  { code: 'ja', name: '日本語', tag: 'ja', dictionary: ja },
  { code: 'zh', name: '简体中文', tag: 'zh-CN', dictionary: zh },
];

const STORAGE_KEY = 'keypool.language';

const listeners = new Set<() => void>();

function readStored(): string {
  try {
    if (typeof localStorage === 'undefined') return 'en';
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored && LANGUAGES.some((l) => l.code === stored)) return stored;
  } catch {
    /* storage unavailable (private mode) - fall through to English */
  }
  return 'en';
}

let current: Language = LANGUAGES.find((l) => l.code === readStored()) ?? LANGUAGES[0];

function applyDocument() {
  if (typeof document === 'undefined') return;
  document.documentElement.lang = current.tag;
}
applyDocument();

function getLanguage(): Language {
  return current;
}

export function setLanguage(code: string): void {
  const next = LANGUAGES.find((l) => l.code === code);
  if (!next || next === current) return;
  current = next;
  try {
    localStorage.setItem(STORAGE_KEY, code);
  } catch {
    /* the session simply will not remember it */
  }
  applyDocument();
  for (const fn of listeners) fn();
}

function subscribeLanguage(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/**
 * Translate `key` into the current language, filling `{name}` placeholders
 * from `params`. An untranslatable key returns English by design; callers
 * must not branch on it.
 */
export function t(key: string, params?: Record<string, string | number>): string {
  let out = current.dictionary[key] ?? key;
  if (params) {
    for (const [name, value] of Object.entries(params)) {
      out = out.replaceAll(`{${name}}`, String(value));
    }
  }
  return out;
}

const LanguageContext = createContext<Language>(current);

export function I18nProvider({ children }: { children: ReactNode }) {
  const language = useSyncExternalStore(
    (fn) => subscribeLanguage(fn),
    () => getLanguage().code,
    () => getLanguage().code,
  );
  // The key is the mechanism, not the hook: `children` is a stable element,
  // so a provider re-render alone lets every subtree bail out and keep its
  // stale text. Remounting on a language change is the guarantee that no
  // component has to remember to subscribe - and a language switch is a
  // deliberate act where losing in-page form state is the right trade.
  return (
    <LanguageContext.Provider value={getLanguage()}>
      <Fragment key={language}>{children}</Fragment>
    </LanguageContext.Provider>
  );
}

export function useLanguage(): Language {
  return useContext(LanguageContext);
}
