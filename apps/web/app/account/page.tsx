"use client";
import { useEffect, useState } from "react";
import { api } from "../lib";
import { useI18n } from "../i18n";

interface Me { id: string; role: string; displayName: string; mustChangePassword: boolean; mfaEnabled: boolean; mfaSetupRequired: boolean }

export default function Account() {
  const { t, tx } = useI18n();
  const [me, setMe] = useState<Me | null>(null);
  const load = async () => { const r = await api<Me>("GET", "/auth/me"); if (r.status === 200) setMe(r.data); else window.location.href = "/login"; };
  useEffect(() => { void load(); }, []);

  // --- change password
  const [cur, setCur] = useState(""); const [nw, setNw] = useState("");
  const [pwMsg, setPwMsg] = useState<{ ok: boolean; text: string } | null>(null);
  async function changePw(e: React.FormEvent) {
    e.preventDefault(); setPwMsg(null);
    const r = await api("POST", "/auth/change-password", { current: cur, next: nw });
    if (r.status === 204) {
      setPwMsg({ ok: true, text: t("account.saved") }); setCur(""); setNw("");
      const was = !!me?.mustChangePassword;
      const fresh = await api<Me>("GET", "/auth/me"); // re-read: the closure's `me` is stale
      if (fresh.status === 200) { setMe(fresh.data); if (was && !fresh.data.mfaSetupRequired) window.location.href = "/"; }
    }
    else setPwMsg({ ok: false, text: r.status === 409 ? tx(`pw.${r.data?.message}`, undefined, r.data?.message) : r.status === 401 ? t("pw.WRONG") : t("login.tooMany") });
  }

  // --- two-step sign-in
  const [setup, setSetup] = useState<{ secret: string; qr: string } | null>(null);
  const [code, setCode] = useState("");
  const [codes, setCodes] = useState<string[] | null>(null);
  const [mfaErr, setMfaErr] = useState("");
  async function startMfa() { setMfaErr(""); const r = await api("POST", "/auth/mfa/setup"); if (r.status === 201) setSetup(r.data); else setMfaErr(t("admin.err.GENERIC")); }
  async function enableMfa(e: React.FormEvent) {
    e.preventDefault(); setMfaErr("");
    const r = await api("POST", "/auth/mfa/enable", { code });
    if (r.status === 201) { setCodes(r.data.recoveryCodes); setSetup(null); setCode(""); await load(); } else setMfaErr(t("pw.MFA_CODE_INVALID"));
  }
  const [dpw, setDpw] = useState(""); const [dcode, setDcode] = useState("");
  async function disableMfa(e: React.FormEvent) {
    e.preventDefault(); setMfaErr("");
    const r = await api("POST", "/auth/mfa/disable", { password: dpw, totp: dcode });
    if (r.status === 204) { setDpw(""); setDcode(""); await load(); } else setMfaErr(r.status === 403 ? t("admin.err.GENERIC") : t("pw.MFA_CODE_INVALID"));
  }

  if (!me) return <p>{t("common.loading")}</p>;
  return (
    <div>
      <h1>{t("account.title")}</h1>
      <p className="muted">{me.displayName} · {tx(`role.${me.role}`, undefined, me.role)}</p>
      {me.mustChangePassword && <p className="err" role="alert">{t("account.mustChange")}</p>}
      {!me.mustChangePassword && me.mfaSetupRequired && <p className="err" role="alert">{t("account.mfaRequired")}</p>}

      <form onSubmit={changePw} className="card" style={{ maxWidth: 460 }}>
        <h2>{t("account.changePw")}</h2>
        <p><label>{t("account.current")}<br /><input className="wide" type="password" name="current" value={cur} onChange={(e) => setCur(e.target.value)} autoComplete="current-password" required /></label></p>
        <p><label>{t("account.new")}<br /><input className="wide" type="password" name="next" value={nw} onChange={(e) => setNw(e.target.value)} autoComplete="new-password" required minLength={12} /></label></p>
        {pwMsg && <p className={pwMsg.ok ? "ok" : "err"} role="alert">{pwMsg.text}</p>}
        <button>{t("account.save")}</button>
      </form>

      <div className="card" style={{ maxWidth: 460 }}>
        <h2>{t("account.mfaTitle")}</h2>
        <p>{me.mfaEnabled ? t("account.mfaOn") : t("account.mfaOff")}</p>
        {mfaErr && <p className="err" role="alert">{mfaErr}</p>}

        {!me.mfaEnabled && !setup && <button type="button" onClick={startMfa}>{t("account.mfaStart")}</button>}
        {setup && (
          <form onSubmit={enableMfa}>
            <p>{t("account.mfaScan")}</p>
            <img src={setup.qr} alt="QR" width={200} height={200} />
            <p className="muted">{t("account.mfaKey")}: <code>{setup.secret}</code></p>
            <p><label>{t("account.code")}<br /><input name="code" inputMode="numeric" pattern="\d{6}" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.trim())} autoComplete="one-time-code" required /></label></p>
            <button>{t("account.mfaEnable")}</button>
          </form>
        )}
        {codes && (
          <div role="status">
            <h3>{t("account.mfaRecoveryTitle")}</h3>
            <p className="err">{t("account.mfaRecoveryNote")}</p>
            <pre style={{ fontSize: 16, lineHeight: 1.6 }}>{codes.join("\n")}</pre>
          </div>
        )}
        {me.mfaEnabled && !me.mfaSetupRequired && !codes && (
          <form onSubmit={disableMfa}>
            <p><label>{t("login.password")}<br /><input className="wide" type="password" value={dpw} onChange={(e) => setDpw(e.target.value)} autoComplete="current-password" required /></label></p>
            <p><label>{t("account.code")}<br /><input inputMode="numeric" pattern="\d{6}" maxLength={6} value={dcode} onChange={(e) => setDcode(e.target.value.trim())} required /></label></p>
            <button className="secondary">{t("account.mfaDisable")}</button>
          </form>
        )}
      </div>
      <p><a href="/">{t("common.back")}</a></p>
    </div>
  );
}
