// Post-OCR normalisers. Rule: never "correct" names; only fix mechanical artefacts.
// Cell borders that survive deskew are read as | or ¦; those characters never occur in any field here, so edge ones are stripped.
export const clean = (s: string) => s.replace(/[\r\n\t]+/g, " ").replace(/\s{2,}/g, " ").replace(/^[\s|¦]+|[\s|¦]+$/g, "").trim();

export function digitsOnly(s: string) { return s.replace(/\D/g, ""); }

export function normDate(s: string): { value: string | null; error?: string } {
  const m = clean(s).replace(/[^\d/\-.]/g, "").match(/^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{4})$/);
  if (!m) return { value: null, error: "DATE_FORMAT" };
  const [d, mo, y] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return { value: null, error: "DATE_INVALID" };
  return { value: `${String(y).padStart(4, "0")}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}` };
}

export function normMobile(s: string): { value: string | null; error?: string } {
  const d = digitsOnly(s);
  const v = d.length === 12 && d.startsWith("91") ? d.slice(2) : d;
  if (!/^[6-9]\d{9}$/.test(v)) return { value: v || null, error: "MOBILE_FORMAT" };
  return { value: v };
}

export function normArea(s: string): { value: string | null; error?: string } {
  if (clean(s) === "" || /^[*\-]+$/.test(clean(s))) return { value: null };
  const v = clean(s).replace(/[,\s]+$/g, "").replace(/,/g, ".").replace(/[^\d.]/g, "");
  if (!/^\d+(\.\d+)?$/.test(v)) return { value: null, error: "AREA_FORMAT" };
  return { value: String(Number(v)) };
}

export function normStar(s: string): string | null {
  const v = clean(s);
  return v === "" || /^[*\-.]+$/.test(v) ? null : v;
}

export function normGender(s: string): { value: string | null; error?: string } {
  const v = clean(s).toLowerCase();
  if (/^m/.test(v)) return { value: "MALE" };
  if (/^f/.test(v)) return { value: "FEMALE" };
  if (/^o|^t/.test(v)) return { value: "OTHER" };
  return { value: null, error: "GENDER_UNKNOWN" };
}

export function normEmail(s: string): { value: string | null; error?: string } {
  const v = clean(s).replace(/\s+/g, "");
  if (v === "") return { value: null };
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v) ? { value: v } : { value: v, error: "EMAIL_FORMAT" };
}

export function normEnrollment(s: string): { value: string | null; error?: string } {
  const v = clean(s).replace(/\s+/g, "");
  return /^\d+(_\d+){3,}$/.test(v) ? { value: v } : { value: v || null, error: "ENROLLMENT_FORMAT" };
}

export function normFarmerId(s: string): { value: string | null; error?: string } {
  const d = digitsOnly(s);
  return d.length === 11 ? { value: d } : { value: d || null, error: "FARMER_ID_LENGTH" };
}

export function normAge(s: string): { value: string | null; error?: string } {
  const d = digitsOnly(s);
  const n = Number(d);
  return d && n >= 0 && n <= 120 ? { value: String(n) } : { value: d || null, error: "AGE_RANGE" };
}

export const MAHARASHTRA_DISTRICTS = ["AHMEDNAGAR","AKOLA","AMRAVATI","AURANGABAD","BEED","BHANDARA","BULDHANA","CHANDRAPUR","DHULE","GADCHIROLI","GONDIA","HINGOLI","JALGAON","JALNA","KOLHAPUR","LATUR","MUMBAI","NAGPUR","NANDED","NANDURBAR","NASHIK","OSMANABAD","PALGHAR","PARBHANI","PUNE","RAIGAD","RATNAGIRI","SANGLI","SATARA","SINDHUDURG","SOLAPUR","THANE","WARDHA","WASHIM","YAVATMAL"];
export const STATES = ["MAHARASHTRA","GUJARAT","MADHYA PRADESH","KARNATAKA","TELANGANA","ANDHRA PRADESH","RAJASTHAN","UTTAR PRADESH","CHHATTISGARH","GOA","PUNJAB","HARYANA","BIHAR","TAMIL NADU","KERALA","ODISHA","WEST BENGAL","JHARKHAND","ASSAM"];

/** Table cells wrap mid-word ("MAHARAS HTRA"). Rejoin by matching a known list ignoring spaces; else return text with a flag. */
export function rejoinKnown(s: string, list: string[]): { value: string | null; matched: boolean } {
  const v = clean(s).toUpperCase();
  if (!v) return { value: null, matched: false };
  const squashed = v.replace(/[^A-Z]/g, "");
  const hit = list.find((x) => x.replace(/[^A-Z]/g, "") === squashed);
  if (hit) return { value: hit, matched: true };
  // allow 1-char OCR slips via Levenshtein <= 1 on squashed form
  const near = list.find((x) => lev(x.replace(/[^A-Z]/g, ""), squashed) <= 1);
  return near ? { value: near, matched: true } : { value: v, matched: false };
}
/** Free-text cell that wrapped: join split fragments ("Borgao n" -> "Borgaon") only for single-token-expected cells. */
export function joinWrapped(s: string): string | null {
  const v = clean(s);
  return v ? v.replace(/\s+/g, "") : null;
}
function lev(a: string, b: string) {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return dp[a.length][b.length];
}
