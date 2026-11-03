"use client";
import { use, useCallback, useEffect, useState } from "react";
import { api } from "../../lib";
import { fmtDate, useI18n } from "../../i18n";

type Farmer = {
  id: string; platformId: string; trustLevel: string; submittedById: string; farmerType: string;
  identity: { nameEn: string; nameLocal?: string; gender?: string; dob?: string };
  mobile?: string; email?: string; address?: { en?: string; local?: string };
  linkedIds: { scheme: string; value: string; verified: boolean }[];
  parcels: { rightId: string; relationship: string; village: string; subDistrict?: string; district: string; survey: string; areaAssignedHa?: string; ownerNameOnRecord?: string }[];
  cards: { id: string; version: number; status: string; issuedAt: string }[];
};

export default function FarmerPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { t, tx, lang } = useI18n();
  const [f, setF] = useState<Farmer | null>(null);
  const [me, setMe] = useState<{ id: string; role: string } | null>(null);
  const [msg, setMsg] = useState<{ key: "notfound" | "denied" | "failed"; reason?: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [nonce, setNonce] = useState(0);

  const load = useCallback(async () => {
    const m = await api("GET", "/auth/me");
    if (m.status !== 200) { window.location.href = "/login"; return; }
    setMe(m.data);
    const r = await api<Farmer>("GET", `/farmers/${id}`);
    if (r.status === 200) setF(r.data); else setMsg({ key: "notfound" });
  }, [id]);
  useEffect(() => { void load(); }, [load]);

  async function approve() {
    setBusy(true); setMsg(null);
    const r = await api("POST", `/farmers/${id}/approve`);
    setBusy(false);
    if (r.status === 201) { setNonce(nonce + 1); await load(); }
    else setMsg(r.status === 403 ? { key: "denied" } : { key: "failed", reason: String(r.data?.message ?? r.status) });
  }
  const msgText = msg && (msg.key === "notfound" ? t("farmer.notFound") : msg.key === "denied" ? t("farmer.cannotApprove") : t("farmer.failed", { reason: msg.reason ?? "" }));

  if (!f) return <p className="muted">{msgText || t("common.loading")}</p>;
  const active = f.cards.find((c) => c.status === "ACTIVE");
  const canApprove = me && ["VERIFIER", "ADMIN", "SUPER_ADMIN"].includes(me.role) && f.trustLevel === "L1_SUBMITTED";
  const primary = lang === "en" ? f.identity.nameEn : (f.identity.nameLocal ?? f.identity.nameEn);
  const secondary = lang === "en" ? f.identity.nameLocal : f.identity.nameEn;
  return (
    <>
      <p><a href="/">{t("common.back")}</a></p>
      <div className="row"><h1 style={{ margin: 0 }}>{primary}</h1><span className={`badge ${f.trustLevel === "L1_SUBMITTED" ? "warn" : ""}`}>{tx(`trust.${f.trustLevel}`, undefined, f.trustLevel)}</span></div>
      <p className="muted">{t("farmer.platformNote", { en: secondary ?? "", id: f.platformId })}</p>
      <div className="grid">
        <div>
          <div className="card">
            <h2>{t("farmer.details")}</h2>
            <table><tbody>
              <tr><th>{t("farmer.dob")}</th><td>{f.identity.dob ? fmtDate(lang, f.identity.dob) : ""}</td></tr>
              <tr><th>{t("farmer.gender")}</th><td>{f.identity.gender ? tx(`gender.${f.identity.gender}`, undefined, f.identity.gender) : ""}</td></tr>
              <tr><th>{t("farmer.mobile")}</th><td>{f.mobile}</td></tr>
              <tr><th>{t("farmer.email")}</th><td>{f.email}</td></tr>
              <tr><th>{t("farmer.address")}</th><td>{lang === "en" ? f.address?.en : f.address?.local}<div className="muted">{lang === "en" ? f.address?.local : f.address?.en}</div></td></tr>
              <tr><th>{t("farmer.type")}</th><td>{f.farmerType ? tx(`ftype.${f.farmerType}`, undefined, f.farmerType) : ""}</td></tr>
              {f.linkedIds.map((l) => (
                <tr key={l.scheme}><th>{tx(`scheme.${l.scheme}`, undefined, l.scheme)}</th>
                  <td>{l.value} <span className={`badge ${l.verified ? "" : "warn"}`}>{l.verified ? t("farmer.verified") : t("farmer.unverified")}</span></td></tr>
              ))}
            </tbody></table>
          </div>
          <div className="card">
            <h2>{t("farmer.land")} <span className="muted">{t("farmer.notProof")}</span></h2>
            <table><thead><tr><th>{tx("l.survey_no")}</th><th>{tx("l.village")}</th><th>{tx("l.sub_district")}</th><th>{tx("l.district")}</th><th>{t("farmer.relation")}</th></tr></thead><tbody>
              {f.parcels.map((p) => <tr key={p.rightId}><td>{p.survey}</td><td>{p.village}</td><td>{p.subDistrict}</td><td>{p.district}</td><td>{tx(`rel.${p.relationship}`, undefined, p.relationship)}</td></tr>)}
              {!f.parcels.length && <tr><td colSpan={5} className="muted">{t("farmer.noParcels")}</td></tr>}
            </tbody></table>
          </div>
        </div>
        <div className="card">
          <h2>{t("farmer.card")}</h2>
          {active ? (
            <>
              <img className="cardimg" alt={t("farmer.cardAlt")} src={`/api/v1/farmers/${id}/card?format=png&v=${nonce}`} />
              <p className="row"><a className="btn" href={`/api/v1/farmers/${id}/card?format=pdf`} target="_blank" rel="noreferrer">{t("farmer.openPdf")}</a></p>
              <p className="muted">{t("farmer.cardInfo", { v: active.version, d: fmtDate(lang, active.issuedAt) })}</p>
            </>
          ) : <p className="muted">{t("farmer.noCard")}</p>}
          {canApprove && (
            <>
              <p>{t("farmer.approveHelp")}</p>
              <button disabled={busy} onClick={approve}>{busy ? t("farmer.approving") : t("farmer.approve")}</button>
            </>
          )}
          {msgText && <p className="err" role="alert">{msgText}</p>}
        </div>
      </div>
    </>
  );
}
