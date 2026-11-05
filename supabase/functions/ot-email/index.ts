// Overtime decision emails, sent by the Apps Script supabase/google-apps-script/overtime-email.gs from the HR Gmail.
//   action "due":  the emails to send now (one per overtime request whose final decision was made)
//   action "sent": the script reports what it sent, so nothing goes out twice
// The final decision is the Owner's approval, or a decline by anyone, in the HRIS or in Jotform. HR's first approval
// sends nothing. Only decisions made from MAIL_FROM on are emailed; overtimeEmail on the record marks it as sent.
import { createClient } from "npm:@supabase/supabase-js@2.50.0";

// SHA-256 of the token in the script property HRIS_TOKEN (OT_EMAIL_TOKEN in .env.local). Only the hash is kept here.
const TOKEN_SHA256 = "2e25bf1154030befa2d67e586c8fa02155e9450c02da259da279c189aa8b52c0";
const MAIL_FROM = "2026-11-05T00:00:00Z";
const MAX = 40; // per run (a Gmail account can send about 100 emails a day)

const env = (k: string) => Deno.env.get(k) ?? "";
const sb = createClient(env("SUPABASE_URL"), env("HRIS_SECRET_KEY"), { auth: { persistSession: false } });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

type Doc = Record<string, any>;
const s = (v: unknown) => (v == null ? "" : String(v).trim());
const okMail = (v: unknown) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s(v));
const longDate = (d: string) => new Date(d + "T00:00:00Z").toLocaleDateString("en-US", { timeZone: "UTC", weekday: "long", month: "long", day: "numeric", year: "numeric" });

async function sha256(t: string) {
  const b = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(t)));
  return [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}
async function docsOf(col: string) {
  const { data, error } = await sb.rpc("hris_jotform_docs", { col });
  if (error) throw new Error(error.message);
  return (data ?? []) as Doc[];
}

function mail(o: Doc, e: Doc | undefined) {
  const to = okMail(o.jotform?.email) ? s(o.jotform.email) : s(e?.email);
  const first = s(e?.firstName) || s(o.jotform?.firstName) || s(o.jotform?.name);
  const ok = o.status === "Approved", word = ok ? "APPROVED" : "DECLINED";
  const day = o.date ? longDate(o.date) : "—", hrs = o.hours ? `${o.hours} hour${Number(o.hours) === 1 ? "" : "s"}` : "";
  const lines = [
    `Date of overtime: ${day}`,
    hrs && `Hours requested: ${hrs}`,
    s(o.reason) && `Reason: ${s(o.reason)}`,
    s(o.remarks) && `${ok ? "Remarks" : "Reason for declining"}: ${s(o.remarks)}`,
  ].filter(Boolean).join("\n");
  const body = `Dear ${first || "Employee"},

Good day! Your overtime request has been ${word}.

${lines}

${ok ? "Please render only the approved overtime." : "If you have questions, please coordinate with the HR Department."}

This is an automatic email from the GBMA HRIS.

Human Resources Department
Golden Bear Manpower Agency`;
  return { id: s(o.id), status: s(o.status), to, subject: `Overtime request ${word}: ${day}${hrs ? ` (${hrs})` : ""}`, body };
}

async function due() {
  const [ots, emps] = await Promise.all([docsOf("overtime"), docsOf("employees")]);
  const byId = new Map(emps.map((e) => [e.id, e]));
  return ots
    .filter((o) => (o.status === "Approved" || o.status === "Declined") && !o.overtimeEmail && s(o.decidedAt) >= MAIL_FROM)
    .map((o) => mail(o, byId.get(o.employeeId)))
    .filter((m) => okMail(m.to))
    .slice(0, MAX);
}

// The record's jotform data is sent back unchanged: hris_upsert_jotform rewrites it on decided records.
async function markSent(list: { id: string; to: string; status: string }[]) {
  const ots = new Map((await docsOf("overtime")).map((o) => [o.id, o]));
  const at = new Date().toISOString();
  const rows = list.filter((x) => x && ots.has(s(x.id))).map((x) => {
    const o = ots.get(s(x.id))!;
    return { id: o.id, sync: { jotform: o.jotform ?? null }, set: { overtimeEmail: { to: s(x.to), status: s(x.status), at } } };
  });
  if (!rows.length) return 0;
  const { data, error } = await sb.rpc("hris_upsert_jotform", { col: "overtime", rows });
  if (error) throw new Error(error.message);
  return Number(data ?? 0);
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  const body = await req.json().catch(() => null);
  if (!body || typeof body.token !== "string" || (await sha256(body.token)) !== TOKEN_SHA256) return json({ error: "not allowed" }, 401);
  try {
    if (body.action === "due") return json({ ok: true, items: await due() });
    if (body.action === "sent") return json({ ok: true, written: await markSent(Array.isArray(body.items) ? body.items : []) });
    return json({ error: "unknown action" }, 400);
  } catch (e) {
    return json({ ok: false, error: String((e as Error)?.message ?? e) }, 502);
  }
});
