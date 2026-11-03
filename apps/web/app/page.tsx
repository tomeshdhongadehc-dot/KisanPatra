"use client";
import { useEffect, useRef, useState } from "react";
import { api } from "./lib";
import { useI18n } from "./i18n";

type Me = { id: string; role: string; displayName: string };
type FarmerRow = { id: string; platformId: string; nameEn?: string; nameLocal?: string; trustLevel: string };

export default function Home() {
  const { t, tx, lang } = useI18n();
  const [me, setMe] = useState<Me | null>(null);
  const [farmers, setFarmers] = useState<FarmerRow[]>([]);
  const [q, setQ] = useState("");
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const file = useRef<HTMLInputElement>(null);

  async function load(query = "") {
    const m = await api<Me>("GET", "/auth/me");
    if (m.status !== 200) { window.location.href = "/login"; return; }
    setMe(m.data);
    const f = await api<FarmerRow[]>("GET", `/farmers${query ? `?q=${encodeURIComponent(query)}` : ""}`);
    if (f.status === 200) setFarmers(f.data);
  }
  useEffect(() => { void load(); }, []);

  async function upload(e: React.FormEvent) {
    e.preventDefault();
    const f = file.current?.files?.[0];
    if (!f) return;
    setBusy(true); setMsg("");
    const fd = new FormData(); fd.append("file", f);
    const r = await api("POST", "/documents", fd);
    setBusy(false);
    if (r.status === 201) window.location.href = `/documents/${r.data.id}`;
    else if (r.status === 409) setMsg(t("home.duplicate"));
    else setMsg(t("home.rejected", { reason: String(r.data?.message ?? r.status) }));
  }
  async function logout() { await api("POST", "/auth/logout"); window.location.href = "/login"; }

  if (!me) return <p className="muted">{t("common.loading")}</p>;
  const canUpload = ["OPERATOR", "ADMIN", "SUPER_ADMIN"].includes(me.role);
  return (
    <>
      <div className="row" style={{ justifyContent: "space-between" }}>
        <h1>{t("home.welcome", { name: me.displayName })} <span className="badge">{tx(`role.${me.role}`, undefined, me.role)}</span></h1>
        <button className="secondary" onClick={logout}>{t("common.signOut")}</button>
      </div>
      {canUpload && (
        <form onSubmit={upload} className="card">
          <h2>{t("home.uploadTitle")}</h2>
          <p className="muted">{t("home.uploadHint")}</p>
          <div className="row">
            <input ref={file} type="file" accept="application/pdf,.pdf" required />
            <button disabled={busy}>{busy ? t("home.uploading") : t("home.uploadBtn")}</button>
          </div>
          {msg && <p className="err" role="alert">{msg}</p>}
        </form>
      )}
      <div className="card">
        <div className="row" style={{ justifyContent: "space-between" }}>
          <h2 style={{ margin: 0 }}>{t("home.records")}</h2>
          <form className="row" onSubmit={(e) => { e.preventDefault(); void load(q); }}>
            <input placeholder={t("home.searchPlaceholder")} aria-label={t("home.searchPlaceholder")} value={q} onChange={(e) => setQ(e.target.value)} />
            <button className="secondary">{t("home.search")}</button>
          </form>
        </div>
        <table>
          <thead><tr><th>{t("home.colId")}</th><th>{t("home.colName")}</th><th>{t("home.colStatus")}</th><th /></tr></thead>
          <tbody>
            {farmers.map((f) => (
              <tr key={f.id}>
                <td>{f.platformId}</td>
                {/* show the name in the UI language where we have it; keep the other as secondary text */}
                <td>{lang === "en" ? f.nameEn : (f.nameLocal ?? f.nameEn)}<div className="muted">{lang === "en" ? f.nameLocal : f.nameEn}</div></td>
                <td><span className={`badge ${f.trustLevel === "L1_SUBMITTED" ? "warn" : ""}`}>{tx(`trust.${f.trustLevel}`, undefined, f.trustLevel)}</span></td>
                <td><a className="btn secondary" href={`/farmers/${f.id}`}>{t("home.open")}</a></td>
              </tr>
            ))}
            {!farmers.length && <tr><td colSpan={4} className="muted">{t("home.none")}</td></tr>}
          </tbody>
        </table>
      </div>
    </>
  );
}
