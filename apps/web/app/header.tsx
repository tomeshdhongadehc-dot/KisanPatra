"use client";
import { useEffect, useState } from "react";
import { api } from "./lib";
import { LangSwitch, useI18n } from "./i18n";

export function Header() {
  const { t } = useI18n();
  const [role, setRole] = useState<string | null>(null);
  useEffect(() => { void api("GET", "/auth/me").then((r) => setRole(r.status === 200 ? r.data.role : null)); }, []);
  const canAdmin = role === "ADMIN" || role === "SUPER_ADMIN" || role === "AUDITOR";
  return (
    <header className="top">
      <a href="/">{t("app.name")}</a>
      <span className="muted">{t("app.tagline")}</span>
      <span style={{ marginLeft: "auto", display: "flex", gap: 12, alignItems: "center" }}>
        {role && <a href="/account">{t("nav.account")}</a>}
        {canAdmin && <a href="/admin">{t("nav.admin")}</a>}
        <LangSwitch />
      </span>
    </header>
  );
}
