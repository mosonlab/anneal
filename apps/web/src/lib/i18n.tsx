import { createContext, Fragment, type ReactNode, useContext, useEffect, useState } from "react";

import { setFormatLocale } from "./format";
import { isLocale, type Locale, LOCALE_KEY, translate } from "./i18n-core";
import { storage } from "./storage";

export type { Locale };

export type Translate = (key: string, vars?: Record<string, string | number>) => string;

type LocaleContextValue = { locale: Locale; setLocale: (next: Locale) => void; t: Translate };

const LocaleContext = createContext<LocaleContextValue | null>(null);

const readLocale = (): Locale => {
  const value = storage.get(LOCALE_KEY);
  return isLocale(value) ? value : "en";
};

export const LocaleProvider = ({
  children,
  initialLocale,
}: {
  children: ReactNode;
  initialLocale?: Locale;
}): ReactNode => {
  const [locale, setLocaleState] = useState<Locale>(initialLocale ?? readLocale);

  // In the render body on purpose, not in an effect: the paint that switches the
  // language must already format dates and relative times in it (spec §6.7). The
  // assignment is idempotent, so re-rendering costs nothing.
  setFormatLocale(locale, (key, vars) => translate(locale, key, vars));

  // Cross-tab sync, mirroring theme.tsx exactly: one `storage` listener, keyed on
  // LOCALE_KEY, an unrecognised value resetting to the default.
  useEffect(() => {
    const sync = (event: StorageEvent): void => {
      if (event.key === LOCALE_KEY) setLocaleState(isLocale(event.newValue) ? event.newValue : "en");
    };
    window.addEventListener("storage", sync);
    return () => window.removeEventListener("storage", sync);
  }, []);

  const setLocale = (next: Locale): void => {
    storage.set(LOCALE_KEY, next);
    setLocaleState(next);
  };

  const value: LocaleContextValue = {
    locale,
    setLocale,
    t: (key, vars) => translate(locale, key, vars),
  };
  return <LocaleContext.Provider value={value}>{children}</LocaleContext.Provider>;
};

/**
 * Provider-free, these fall back to `en` rather than throwing the way `useTheme`
 * does. Eight existing test files render components straight through
 * `renderToStaticMarkup` with no providers at all; a throwing hook would break
 * every one of them, and the English string those tests assert is exactly what
 * the fallback produces. A test that wants Chinese wraps its subject in
 * `<LocaleProvider initialLocale="zh">`.
 */
export const useLocale = (): { locale: Locale; setLocale: (next: Locale) => void } => {
  const held = useContext(LocaleContext);
  if (held === null) return { locale: "en", setLocale: () => undefined };
  return { locale: held.locale, setLocale: held.setLocale };
};

export const useT = (): Translate => {
  const held = useContext(LocaleContext);
  if (held === null) return (key, vars) => translate("en", key, vars);
  return held.t;
};

/**
 * The same interpolation, with nodes instead of strings.
 *
 * Several strings in the app wrap a technical identifier in `<code>`. Their
 * dictionary values stay plain text with a `{placeholder}` where the identifier
 * goes, and the markup lives here, in the caller's tree — a translated value
 * never contains a tag, so a translator can never break the DOM and the
 * identifiers are not translated by accident.
 *
 * An unsubstituted placeholder renders as itself, exactly as `interpolate` does,
 * so a missing node is visible rather than silently blank.
 */
export const useTNodes = (): ((key: string, nodes: Record<string, ReactNode>) => ReactNode) => {
  const t = useT();
  return (key, nodes) => (
    t(key).split(/(\{\w+\})/g).map((part, index) => {
      const name = /^\{(\w+)\}$/.exec(part);
      const node = name === null ? undefined : nodes[name[1]!];
      return <Fragment key={index}>{node === undefined ? part : node}</Fragment>;
    })
  );
};
