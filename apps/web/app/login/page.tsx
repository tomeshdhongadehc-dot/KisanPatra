"use client";
import { useState } from "react";
import { api } from "../lib";
import { useI18n } from "../i18n";

export default function Login() {
  const { t } = useI18n();
  const [identifier, setId] = useState("");
  const [password, setPw] = useState("");
  const [needMfa, setNeedMfa] = useState(false);
  const [useRecovery, setUseRecovery] = useState(false);
  const [totp, setTotp] = useState("");
  const [recovery, setRecovery] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  async function submit(e: React.FormEvent) {
    e.preventDefault(); setBusy(true); setErr("");
    const second = needMfa ? (useRecovery ? { recoveryCode: recovery } : { totp }) : {};
    const r = await api("POST", "/auth/login", { identifier, password, ...second });
    setBusy(false);
    if (r.status === 200) window.location.href = r.data.mustChangePassword || r.data.mfaSetupRequired ? "/account" : "/";
    else if (r.status === 401 && r.data?.message === "MFA_REQUIRED") setNeedMfa(true); // password was right: ask for the second factor
    else setErr(r.status === 403 ? t("login.tooMany") : t("login.invalid"));
  }
  return (
    <form onSubmit={submit} className="card" style={{ maxWidth: 420, margin: "40px auto" }}>
      <h1>{t("login.title")}</h1>
      <p><label>{t("login.identifier")}<br /><input className="wide" value={identifier} onChange={(e) => setId(e.target.value)} autoComplete="username" required readOnly={needMfa} /></label></p>
      <p><label>{t("login.password")}<br /><input className="wide" type="password" value={password} onChange={(e) => setPw(e.target.value)} autoComplete="current-password" required minLength={8} readOnly={needMfa} /></label></p>
      {needMfa && !useRecovery && (
        <p><label>{t("login.mfaCode")}<br /><input className="wide" name="totp" inputMode="numeric" pattern="\d{6}" maxLength={6} value={totp} onChange={(e) => setTotp(e.target.value.trim())} autoComplete="one-time-code" autoFocus required /></label></p>
      )}
      {needMfa && useRecovery && (
        <p><label>{t("login.recoveryCode")}<br /><input className="wide" name="recovery" value={recovery} onChange={(e) => setRecovery(e.target.value)} autoComplete="off" autoFocus required /></label></p>
      )}
      {needMfa && <p><a href="#" onClick={(e) => { e.preventDefault(); setUseRecovery(!useRecovery); setErr(""); }}>{useRecovery ? t("login.mfaUseApp") : t("login.mfaUseRecovery")}</a></p>}
      {err && <p className="err" role="alert">{err}</p>}
      <button disabled={busy}>{busy ? t("login.submitting") : t("login.submit")}</button>
    </form>
  );
}
