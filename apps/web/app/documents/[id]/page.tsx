"use client";
import { use, useCallback, useEffect, useState } from "react";
import { api } from "../../lib";
import { useI18n } from "../../i18n";

type Field = { id: string; key: string; raw: string | null; value: string | null; finalValue: string | null; confidence: number | null; errors: string[]; state: string; needsReview: boolean; page: number };
type Doc = { id: string; status: string; rejectReason?: string; farmerId?: string; pages: { pageNo: number }[]; fields: Field[] };

// Display order follows the source form (not alphabetical).
const FORM_ORDER = ["enrollment_number", "farmer_id", "name_en", "name_local", "gender", "caste_category", "dob", "age", "identifier_name_en", "identifier_name_local", "mobile", "email", "address_en", "address_local", "farmer_type", "occupation"];
const LAND_ORDER = ["state", "district", "sub_district", "village", "survey_no", "sub_survey_no", "owner_name", "identifier_name", "owner_type", "share_type", "area_total_ha", "area_assigned_ha"];
const landParts = (k: string) => { const m = /^land\[(\d+)\]\.(.+)$/.exec(k); return m ? { n: Number(m[1]), col: m[2] } : null; };
const rank = (k: string) => { const l = landParts(k); return l ? l.n * 100 + LAND_ORDER.indexOf(l.col) : FORM_ORDER.indexOf(k); };

export default function Review({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { t, tx } = useI18n();
  const [doc, setDoc] = useState<Doc | null>(null);
  const [edit, setEdit] = useState<Record<string, string>>({});
  const [attest, setAttest] = useState(false);
  const [msg, setMsg] = useState("");

  const label = (k: string) => {
    const l = landParts(k);
    return l ? `${t("review.parcel", { n: l.n + 1 })} · ${tx(`l.${l.col}`, undefined, l.col)}` : tx(`f.${k}`, undefined, k);
  };

  const load = useCallback(async () => {
    const r = await api<Doc>("GET", `/documents/${id}`);
    if (r.status === 401) { window.location.href = "/login"; return; }
    if (r.status === 200) setDoc(r.data); else setMsg("notfound");
  }, [id]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    if (!doc || !["VALIDATED", "PROCESSING", "UPLOADED"].includes(doc.status)) return;
    const timer = setInterval(load, 1500); return () => clearInterval(timer);
  }, [doc, load]);

  async function act(f: Field, action: "confirm" | "edit" | "reject") {
    const r = await api("PATCH", `/documents/${id}/fields/${f.id}`, action === "edit" ? { action, value: edit[f.id] ?? f.finalValue ?? f.value ?? "" } : { action });
    if (r.status !== 200) setMsg(t("review.saveFailed", { reason: String(r.data?.message ?? r.status) }));
    else setEdit((e) => { const { [f.id]: _drop, ...rest } = e; return rest; });
    await load();
  }
  async function submit() {
    setMsg("");
    const r = await api("POST", `/documents/${id}/submit`, { attested: true });
    if (r.status === 201) window.location.href = `/farmers/${r.data.farmerId}`;
    else if (r.data?.message === "UNRESOLVED_FIELDS") setMsg(t("review.needReview", { list: r.data.fields.map(label).join(", ") }));
    else if (r.data?.message === "MISSING_REQUIRED") setMsg(t("review.needRequired", { list: r.data.fields.map(label).join(", ") }));
    else if (r.data?.message === "DUPLICATE_FARMER") setMsg(t("review.dupFarmer"));
    else setMsg(t("review.submitFailed", { reason: String(r.data?.message ?? r.status) }));
  }

  if (!doc) return <p className="muted">{msg === "notfound" ? t("review.notFound") : t("common.loading")}</p>;
  if (doc.status === "FAILED") return <div className="card"><h1>{t("review.failedTitle")}</h1><p className="err">{doc.rejectReason}</p><a className="btn secondary" href="/">{t("review.back")}</a></div>;
  if (doc.status !== "READY_FOR_REVIEW") {
    if (doc.farmerId) return <div className="card"><h1>{t("review.already")}</h1><a className="btn" href={`/farmers/${doc.farmerId}`}>{t("review.openFarmer")}</a></div>;
    return <div className="card"><h1>{t("review.reading")}</h1><p className="muted">{t("review.readingHint")}</p></div>;
  }
  const sorted = [...doc.fields].sort((a, b) => rank(a.key) - rank(b.key));
  const pending = doc.fields.filter((f) => f.needsReview && f.state === "PROPOSED").length;
  const form = sorted.filter((f) => !f.key.startsWith("land["));
  const land = sorted.filter((f) => f.key.startsWith("land["));

  const row = (f: Field) => {
    const base = f.finalValue ?? f.value ?? "";
    const cur = edit[f.id] ?? base;
    const changed = edit[f.id] !== undefined && edit[f.id] !== base;
    return (
      <div key={f.id} className={`field ${f.needsReview && f.state === "PROPOSED" ? "flag" : ""}`}>
        <div className="k">
          {label(f.key)} {f.confidence != null && <span>· {t("review.ocr", { p: Math.round(f.confidence * 100) })}</span>} ·{" "}
          <span className={f.state === "PROPOSED" ? "" : "ok"}>{tx(`state.${f.state}`, undefined, f.state)}</span>
        </div>
        <div className="row">
          <input style={{ flex: 1, minWidth: 160 }} value={cur} onChange={(e) => setEdit({ ...edit, [f.id]: e.target.value })} aria-label={label(f.key)} />
          <button className="secondary" onClick={() => act(f, changed ? "edit" : "confirm")}>{changed ? t("review.saveEdit") : t("review.confirm")}</button>
        </div>
        {f.raw !== f.value && <div className="raw">{t("review.asRead", { v: f.raw ?? "" })}</div>}
        {f.errors.map((e) => <div key={e} className="err">⚠ {tx(`e.${e}`, undefined, e)}</div>)}
      </div>
    );
  };
  return (
    <>
      <h1>{t("review.title")}</h1>
      <p className="muted">{t("review.intro")}</p>
      <div className="grid">
        <div>{doc.pages.map((p) => <p key={p.pageNo}><img className="pageimg" alt={t("review.pageAlt", { n: p.pageNo })} src={`/api/v1/documents/${id}/pages/${p.pageNo}/image`} /></p>)}</div>
        <div className="card">
          <h2>{t("review.farmerDetails")}</h2>{form.map(row)}
          <h2>{t("review.landTitle")}</h2>{land.map(row)}
          <hr />
          <p>{t("review.pending", { n: pending })}</p>
          <label className="row"><input type="checkbox" checked={attest} onChange={(e) => setAttest(e.target.checked)} /> {t("review.attest")}</label>
          {msg && <p className="err" role="alert">{msg}</p>}
          <p><button disabled={!attest || pending > 0} onClick={submit}>{t("review.submit")}</button></p>
        </div>
      </div>
    </>
  );
}
