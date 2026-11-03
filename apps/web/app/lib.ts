export async function api<T = any>(method: string, path: string, body?: unknown): Promise<{ status: number; data: T }> {
  const isForm = typeof FormData !== "undefined" && body instanceof FormData;
  const res = await fetch(`/api/v1${path}`, {
    method,
    credentials: "same-origin",
    headers: body && !isForm ? { "Content-Type": "application/json" } : undefined,
    body: body ? (isForm ? (body as FormData) : JSON.stringify(body)) : undefined,
  });
  const text = await res.text();
  let data: any = text;
  try { data = JSON.parse(text); } catch { /* not JSON */ }
  // A restricted session (temporary password / mandatory 2-step not set up) can only use the account page: send it there.
  if (res.status === 403 && typeof window !== "undefined" && ["PASSWORD_CHANGE_REQUIRED", "MFA_SETUP_REQUIRED"].includes(data?.message) && !window.location.pathname.startsWith("/account")) window.location.href = "/account";
  return { status: res.status, data };
}

export const TRUST: Record<string, string> = {
  L0_DRAFT: "L0 Draft", L1_SUBMITTED: "L1 Submitted — awaiting verifier", L2_DOCUMENT_REVIEWED: "L2 Document reviewed",
  L3_OFFICIALLY_VERIFIED: "L3 Officially verified", L4_REVERIFICATION_REQUIRED: "L4 Reverification required",
};
