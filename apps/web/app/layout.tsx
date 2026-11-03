import type { ReactNode } from "react";
import "./globals.css";
import { I18nProvider } from "./i18n";
import { getLang, serverT } from "./i18n/server";
import { Header } from "./header";

export const metadata = { title: "Agri·Card", description: "Platform-generated farmer identity cards (not a government credential)" };

export default async function RootLayout({ children }: { children: ReactNode }) {
  const lang = await getLang();
  const t = serverT(lang);
  return (
    <html lang={lang}>
      <body>
        <I18nProvider initial={lang}>
          <Header />
          <main>{children}</main>
        </I18nProvider>
        <noscript>{t("app.tagline")}</noscript>
      </body>
    </html>
  );
}
