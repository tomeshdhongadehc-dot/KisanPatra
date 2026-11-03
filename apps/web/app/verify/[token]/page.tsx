import { getLang, serverT, serverTx } from "../../i18n/server";

// Public page: server-rendered, no login, no third-party scripts, minimal data. Language from cookie / Accept-Language.
export const dynamic = "force-dynamic";

const API = process.env.API_URL ?? "http://localhost:4000";
const CLS: Record<string, string> = { ACTIVE: "ok" };

export default async function Verify({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const lang = await getLang();
  const t = serverT(lang), tx = serverTx(lang);
  const loc = lang === "en" ? "en-IN" : lang === "hi" ? "hi-IN" : "mr-IN";

  let d: any = { status: "NOT_FOUND" };
  try {
    const r = await fetch(`${API}/api/v1/public/verify/${encodeURIComponent(token)}`, { cache: "no-store" });
    d = r.status === 403 ? { status: "RATE_LIMITED" } : await r.json();
  } catch { d = { status: "UNAVAILABLE" }; }
  const known = ["ACTIVE", "REVOKED", "EXPIRED", "SUPERSEDED", "NOT_FOUND", "RATE_LIMITED", "UNAVAILABLE"];
  const status = known.includes(d.status) ? d.status : "UNAVAILABLE";
  return (
    <div className="card" style={{ maxWidth: 560, margin: "30px auto" }}>
      <h1>{t("verify.title")}</h1>
      <p className={`big ${CLS[status] ?? "err"}`} role="status">{tx(`verify.${status}`)}</p>
      {d.platformId && (
        <table><tbody>
          <tr><th>{t("verify.id")}</th><td>{d.platformId}</td></tr>
          <tr><th>{t("verify.level")}</th><td>{tx(`trust.${d.trustLevel}`, d.trustLevel)}</td></tr>
          <tr><th>{t("verify.issued")}</th><td>{d.issuedAt ? new Date(d.issuedAt).toLocaleDateString(loc, { day: "numeric", month: "short", year: "numeric" }) : ""}</td></tr>
          <tr><th>{t("verify.ref")}</th><td>{d.reference}</td></tr>
          <tr><th>{t("verify.checked")}</th><td>{new Date(d.checkedAt).toLocaleString(loc)}</td></tr>
        </tbody></table>
      )}
      <p className="muted">{t("verify.disclaimer")}</p>
    </div>
  );
}
