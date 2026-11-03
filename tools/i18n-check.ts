// Verifies the message catalogs: same keys in every language, same {placeholders}, no empty strings,
// and that every t("...")/tx(`...`) literal key used in the web app exists. Run: pnpm exec tsx tools/i18n-check.ts
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
const ROOT = resolve(__dirname, "..");
import { LANGS, messages } from "../apps/web/app/i18n/messages";

let bad = 0;
const fail = (m: string) => { console.log("FAIL ", m); bad++; };
const en = messages.en as Record<string, string>;
const ph = (s: string) => (s.match(/\{\w+\}/g) ?? []).sort().join(",");

for (const l of LANGS) {
  const m = messages[l] as Record<string, string>;
  for (const k of Object.keys(en)) {
    if (!(k in m)) fail(`${l}: missing ${k}`);
    else {
      if (!m[k].trim()) fail(`${l}: empty ${k}`);
      if (ph(m[k]) !== ph(en[k])) fail(`${l}: placeholder mismatch in ${k}`);
    }
  }
  for (const k of Object.keys(m)) if (!(k in en)) fail(`${l}: extra key ${k}`);
}

function walk(dir: string, out: string[] = []) {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) { if (f !== "node_modules" && f !== ".next") walk(p, out); } else if (/\.tsx?$/.test(f) && !p.includes("i18n")) out.push(p);
  }
  return out;
}
const used = new Set<string>();
for (const file of walk(join(ROOT, "apps/web/app"))) {
  const src = readFileSync(file, "utf8");
  for (const m of src.matchAll(/\bt\(\s*"([\w.]+)"/g)) used.add(m[1]);
  for (const m of src.matchAll(/\btx\(\s*"([\w.]+)"/g)) used.add(m[1]);
}
for (const k of used) if (!(k in en)) fail(`code uses unknown key ${k}`);
// dynamic prefixes that must be fully defined
const dyn: Record<string, string[]> = {
  "trust.": ["L0_DRAFT", "L1_SUBMITTED", "L2_DOCUMENT_REVIEWED", "L3_OFFICIALLY_VERIFIED", "L4_REVERIFICATION_REQUIRED"],
  "pw.": ["PASSWORD_TOO_SHORT", "PASSWORD_TOO_LONG", "PASSWORD_TOO_COMMON", "PASSWORD_CONTAINS_IDENTIFIER", "PASSWORD_UNCHANGED", "PASSWORD_TOO_SIMPLE", "WRONG", "MFA_CODE_INVALID"],
  "status.": ["ACTIVE", "SUSPENDED"],
  "admin.err.": ["EMAIL_EXISTS", "MOBILE_EXISTS", "CANNOT_MODIFY_SELF", "GENERIC"],
  "role.": ["SUPER_ADMIN", "ADMIN", "OPERATOR", "VERIFIER", "VIEWER", "AUDITOR"],
  "state.": ["PROPOSED", "CONFIRMED", "EDITED", "REJECTED"],
  "gender.": ["MALE", "FEMALE", "OTHER"], "rel.": ["OWNER", "TENANT", "SHARECROPPER", "FAMILY", "OTHER"],
  "verify.": ["ACTIVE", "REVOKED", "EXPIRED", "SUPERSEDED", "NOT_FOUND", "RATE_LIMITED", "UNAVAILABLE"],
  "l.": ["state", "district", "sub_district", "village", "survey_no", "sub_survey_no", "owner_name", "identifier_name", "owner_type", "share_type", "area_total_ha", "area_assigned_ha"],
  "f.": ["enrollment_number", "farmer_id", "name_en", "name_local", "gender", "caste_category", "dob", "age", "identifier_name_en", "identifier_name_local", "mobile", "email", "address_en", "address_local", "farmer_type", "occupation"],
  "ftype.": ["OWNER", "TENANT", "SHARECROPPER", "FAMILY_CULTIVATOR", "LANDLESS_LABOUR_OR_ALLIED", "OTHER"],
  "scheme.": ["AGRISTACK_FARMER_ID", "AGRISTACK_ENROLLMENT_NO"],
  "e.": ["OWNER_NAME_DIFFERS_FROM_FARMER_NAME", "AGE_DOB_MISMATCH", "DISTRICT_UNRECOGNISED", "STATE_UNRECOGNISED", "MOBILE_FORMAT", "DATE_FORMAT", "DATE_INVALID", "EMAIL_FORMAT", "AGE_RANGE", "FARMER_ID_LENGTH", "ENROLLMENT_FORMAT", "GENDER_UNKNOWN", "AREA_FORMAT", "WRAPPED_CHECK", "LOCAL_TEXT_CHECK"],
};
for (const [p, ks] of Object.entries(dyn)) for (const k of ks) if (!(`${p}${k}` in en)) fail(`dynamic key not defined: ${p}${k}`);

console.log(bad ? `\n${bad} problem(s)` : `i18n OK: ${Object.keys(en).length} keys × ${LANGS.length} languages, ${used.size} literal keys used`);
process.exit(bad ? 1 : 0);
