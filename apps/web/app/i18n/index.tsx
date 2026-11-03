"use client";
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { DEFAULT_LANG, LANGS, LANG_NAMES, Key, Lang, messages } from "./messages";

type Vars = Record<string, string | number>;
interface Ctx { lang: Lang; setLang: (l: Lang) => void; t: (key: Key, vars?: Vars) => string; tx: (key: string, vars?: Vars, fallback?: string) => string }

const I18nContext = createContext<Ctx>({ lang: DEFAULT_LANG, setLang: () => {}, t: (k) => k, tx: (k) => k });

import { interpolate } from "./format";
export { interpolate };

export function I18nProvider({ initial, children }: { initial: Lang; children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>(initial);
  const router = useRouter();
  const setLang = useCallback((l: Lang) => {
    try { document.cookie = `lang=${l}; path=/; max-age=31536000; samesite=lax`; } catch { /* cookies blocked: stay in-memory */ }
    document.documentElement.lang = l;
    setLangState(l);
    router.refresh(); // re-render server components (public verify page)
  }, [router]);
  const value = useMemo<Ctx>(() => {
    const dict = messages[lang];
    return {
      lang, setLang,
      t: (key, vars) => interpolate(dict[key] ?? messages.en[key] ?? key, vars),
      // dynamic keys (server-provided codes); fall back to English then to the supplied text/code
      tx: (key, vars, fallback) => interpolate((dict as Record<string, string>)[key] ?? (messages.en as Record<string, string>)[key] ?? fallback ?? key, vars),
    };
  }, [lang, setLang]);
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export const useI18n = () => useContext(I18nContext);

export function LangSwitch() {
  const { lang, setLang, t } = useI18n();
  return (
    <label className="langswitch">
      <span className="sr">{t("common.language")}</span>
      <select aria-label={t("common.language")} value={lang} onChange={(e) => setLang(e.target.value as Lang)}>
        {LANGS.map((l) => <option key={l} value={l}>{LANG_NAMES[l]}</option>)}
      </select>
    </label>
  );
}

/** Localised date, e.g. 2 Nov 2026 / २ नोव्हेंबर २०२६ per language. */
export function fmtDate(lang: Lang, d: string | Date | null | undefined) {
  if (!d) return "";
  const loc = lang === "en" ? "en-IN" : lang === "hi" ? "hi-IN" : "mr-IN";
  return new Date(d).toLocaleDateString(loc, { day: "numeric", month: "short", year: "numeric" });
}
