"use client";
import { useEffect, useState } from "react";
import { api } from "../lib";
import { useI18n } from "../i18n";

interface Row { id: string; email: string | null; displayName: string; role: string; status: string; mfaEnabled: boolean; mustChangePassword: boolean; locked: boolean }
const ROLES = ["ADMIN", "OPERATOR", "VERIFIER", "VIEWER", "AUDITOR"];

function Counts({ title, data }: { title: string; data: Record<string, number> }) {
  const rows = Object.entries(data ?? {});
  return (
    <div className="card" style={{ minWidth: 190 }}>
      <h3>{title}</h3>
      {rows.length === 0 ? <p className="muted">—</p> : <table><tbody>{rows.map(([k, n]) => <tr key={k}><td>{k}</td><td style={{ textAlign: "right" }}><b>{n}</b></td></tr>)}</tbody></table>}
    </div>
  );
}

export default function Admin() {
  const { t, tx } = useI18n();
  const [stats, setStats] = useState<any>(null);
  const [users, setUsers] = useState<Row[] | null>(null);
  const [meId, setMeId] = useState("");
  const [err, setErr] = useState("");
  const [temp, setTemp] = useState<{ who: string; pw: string } | null>(null);
  const [pending, setPending] = useState<string>(""); // "<id>:<action>" awaiting the second click (no browser dialogs)

  const load = async () => {
    const me = await api("GET", "/auth/me"); if (me.status !== 200) { window.location.href = "/login"; return; } setMeId(me.data.id);
    const [s, u] = await Promise.all([api("GET", "/admin/stats"), api("GET", "/admin/users")]);
    if (s.status === 200) setStats(s.data);
    if (u.status === 200) setUsers(u.data); else setUsers([]); // auditors see stats only
  };
  useEffect(() => { void load(); }, []);

  const fail = (r: { status: number; data: any }) => setErr(tx(`admin.err.${r.data?.message}`, undefined, t("admin.err.GENERIC")));

  // create
  const [email, setEmail] = useState(""); const [name, setName] = useState(""); const [role, setRole] = useState("OPERATOR");
  async function create(e: React.FormEvent) {
    e.preventDefault(); setErr(""); setTemp(null);
    const r = await api("POST", "/admin/users", { email, displayName: name, role });
    if (r.status === 201) { setTemp({ who: r.data.user.email, pw: r.data.tempPassword }); setEmail(""); setName(""); await load(); } else fail(r);
  }

  async function act(u: Row, action: "suspend" | "activate" | "reset-password" | "reset-mfa" | "unlock") {
    const key = `${u.id}:${action}`;
    if (pending !== key) { setPending(key); return; } // first click arms, second confirms
    setPending(""); setErr(""); setTemp(null);
    const r = action === "suspend" || action === "activate"
      ? await api("PATCH", `/admin/users/${u.id}`, { status: action === "suspend" ? "SUSPENDED" : "ACTIVE" })
      : await api("POST", `/admin/users/${u.id}/${action}`);
    if (r.status >= 200 && r.status < 300) { if (action === "reset-password") setTemp({ who: u.email ?? u.displayName, pw: r.data.tempPassword }); await load(); } else fail(r);
  }
  const btn = (u: Row, action: Parameters<typeof act>[1], label: string) => (
    <button key={action} type="button" className="secondary" style={{ marginRight: 4 }} onClick={() => act(u, action)}>{pending === `${u.id}:${action}` ? t("admin.confirm") : label}</button>
  );

  return (
    <div>
      <h1>{t("admin.title")}</h1>
      {err && <p className="err" role="alert">{err}</p>}
      {stats && (
        <section aria-label={t("admin.stats")}>
          <h2>{t("admin.stats")}</h2>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 12 }}>
            <Counts title={t("admin.docs")} data={stats.documents} />
            <Counts title={t("admin.farmers")} data={stats.farmersByTrust} />
            <Counts title={t("admin.cards")} data={stats.cards} />
            <Counts title={t("admin.jobs")} data={stats.jobs} />
            <Counts title={t("admin.users")} data={stats.activeUsersByRole} />
            <Counts title="" data={{ [t("admin.queueAge")]: stats.oldestQueuedSeconds, [t("admin.failed24")]: stats.failedLast24h, [t("admin.lockedUsers")]: stats.lockedUsers }} />
          </div>
        </section>
      )}

      {users && users.length > 0 && (
        <section>
          <h2>{t("admin.users")}</h2>
          {temp && (
            <div className="card" role="status">
              <p><b>{temp.who}</b></p>
              <p className="err">{t("admin.tempShown")}</p>
              <p><code style={{ fontSize: 20 }} data-testid="temp-password">{temp.pw}</code></p>
            </div>
          )}
          <table>
            <thead><tr><th>{t("admin.name")}</th><th>{t("admin.email")}</th><th>{t("admin.role")}</th><th>{t("admin.status")}</th><th>{t("admin.mfa")}</th><th /></tr></thead>
            <tbody>
              {users.map((u) => (
                <tr key={u.id}>
                  <td>{u.displayName} {u.id === meId && <span className="muted">{t("admin.you")}</span>}</td>
                  <td>{u.email}</td>
                  <td>{tx(`role.${u.role}`, undefined, u.role)}</td>
                  <td>{tx(`status.${u.status}`, undefined, u.status)}{u.locked && <span className="badge warn"> {t("admin.locked")}</span>}</td>
                  <td>{u.mfaEnabled ? "✔" : "—"}</td>
                  <td>{u.id !== meId && u.role !== "SUPER_ADMIN" && (<>
                    {u.status === "ACTIVE" ? btn(u, "suspend", t("admin.suspend")) : btn(u, "activate", t("admin.activate"))}
                    {btn(u, "reset-password", t("admin.resetPw"))}
                    {u.mfaEnabled && btn(u, "reset-mfa", t("admin.resetMfa"))}
                    {u.locked && btn(u, "unlock", t("admin.unlock"))}
                  </>)}</td>
                </tr>
              ))}
            </tbody>
          </table>

          <form onSubmit={create} className="card" style={{ maxWidth: 520 }}>
            <h3>{t("admin.newUser")}</h3>
            <p><label>{t("admin.email")}<br /><input className="wide" type="email" name="email" value={email} onChange={(e) => setEmail(e.target.value)} required /></label></p>
            <p><label>{t("admin.name")}<br /><input className="wide" name="displayName" value={name} onChange={(e) => setName(e.target.value)} required minLength={2} /></label></p>
            <p><label>{t("admin.role")}<br /><select name="role" value={role} onChange={(e) => setRole(e.target.value)}>{ROLES.map((r) => <option key={r} value={r}>{tx(`role.${r}`, undefined, r)}</option>)}</select></label></p>
            <button>{t("admin.create")}</button>
          </form>
        </section>
      )}
      <p><a href="/">{t("common.back")}</a></p>
    </div>
  );
}
