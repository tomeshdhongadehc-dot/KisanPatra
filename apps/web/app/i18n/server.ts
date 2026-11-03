import { cookies, headers } from "next/headers";
import { DEFAULT_LANG, Key, Lang, isLang, messages } from "./messages";
import { interpolate } from "./format";

/** Language for server components: cookie first, then Accept-Language, else default (Marathi). */
export async function getLang(): Promise<Lang> {
  const c = (await cookies()).get("lang")?.value;
  if (isLang(c)) return c;
  const al = (await headers()).get("accept-language")?.toLowerCase() ?? "";
  for (const part of al.split(",")) {
    const code = part.trim().slice(0, 2);
    if (isLang(code)) return code;
  }
  return DEFAULT_LANG;
}
export const serverT = (lang: Lang) => (key: Key, vars?: Record<string, string | number>) => interpolate(messages[lang][key] ?? messages.en[key], vars);
export const serverTx = (lang: Lang) => (key: string, fallback?: string) => (messages[lang] as Record<string, string>)[key] ?? (messages.en as Record<string, string>)[key] ?? fallback ?? key;
