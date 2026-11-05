// Works with the Apps Script of the Google Form "CLIENT'S FEEDBACK & PERFORMANCE EVALUATION FORM"
// (supabase/google-form/client-eval.gs):
//   - stores the answers in hris_docs "clientevals", matched to the employee (name + date hired) and the
//     evaluation (1st, 3rd or 5th month);
//   - tells the script which evaluation links to email to client supervisors, and records what it sent.
import { createClient } from "npm:@supabase/supabase-js@2.50.0";

// SHA-256 of the token in the form's Apps Script property HRIS_TOKEN (CLIENT_EVAL_TOKEN in .env.local).
// Only the hash is kept here, so this file holds no secret.
const TOKEN_SHA256 = "6645225890d651a238d96cc7b6c231ce167d364d359f8041cf31fc3427249e50";

const env = (k: string) => Deno.env.get(k) ?? "";
const sb = createClient(env("SUPABASE_URL"), env("HRIS_SECRET_KEY"), { auth: { persistSession: false } });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

type Doc = Record<string, any>;
type Row = { id: string; at: string; email: string; answers: { title: string; value: unknown }[] };
const s = (v: unknown) => (v == null ? "" : String(v).trim());
const low = (v: unknown) => s(v).toLowerCase().replace(/[^a-z0-9ñ ]+/g, " ").replace(/\s+/g, " ").trim();
const r2 = (v: number) => Math.round(v * 100) / 100;

async function sha256(t: string) {
  const b = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(t)));
  return [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}

// The five rated factors, by the start of their question titles
const FACTORS: [string, RegExp][] = [
  ["quality", /^1\.\s*quality/i], ["productivity", /^2\.\s*productivity/i], ["accuracy", /^3\.\s*accuracy/i],
  ["knowledge", /^4\.\s*knowledge/i], ["instructions", /^5\.\s*ability/i],
];
const period = (v: string) => { const t = low(v); return /^(1|1st|first)\b/.test(t) ? "m1" : /^(3|3rd|third)\b/.test(t) ? "m3" : /^(5|5th|fifth)\b/.test(t) ? "m5" : ""; };

// The HRIS pre-fills the employee's full name and date hired, so both normally match exactly.
// A name alone counts only when it fits a single employee.
function matcher(emps: Doc[]) {
  return (name: string, hired: string) => {
    const n = ` ${low(name)} `;
    const has = (w: string) => !!w && n.includes(` ${w} `);
    const cands = emps.filter((e) => has(low(e.lastName)) && has(low(e.firstName).split(" ")[0]));
    const byDate = hired ? cands.filter((e) => e.hireDate === hired) : [];
    if (byDate.length === 1) return byDate[0];
    return cands.length === 1 ? cands[0] : undefined;
  };
}

function toDoc(r: Row, match: ReturnType<typeof matcher>) {
  const get = (re: RegExp) => r.answers.find((a) => re.test(s(a.title)))?.value;
  const ratings: Record<string, number | null> = {};
  for (const [k, re] of FACTORS) { const v = Number(s(get(re))); ratings[k] = v >= 1 && v <= 5 ? v : null; }
  const vals = Object.values(ratings).filter((v): v is number => v != null);
  const name = s(get(/^name$/i)), dateHired = s(get(/^date hired$/i)), periodText = s(get(/^evaluation period$/i));
  const e = match(name, dateHired);
  return {
    id: `gf-${r.id}`,
    data: {
      source: "googleform", responseId: r.id, submittedAt: s(r.at), email: s(r.email).toLowerCase(),
      periodText, period: period(periodText), name, site: s(get(/^site$/i)), dateHired,
      ratings, avg: vals.length === FACTORS.length ? r2(vals.reduce((t, v) => t + v, 0) / vals.length) : null,
      remarks: s(get(/^remarks$/i)), employeeId: e?.id ?? "",
    },
  };
}

// ---------- evaluation links emailed to client supervisors ----------
// The form's Apps Script asks every hour (action "due") and emails what comes back from the form owner's Gmail:
// an invitation within 7 days before an evaluation is due, and one reminder 3 days later if the client has
// not answered. It then reports what it sent (action "sent"), so nothing goes out twice.
const FORM = "https://docs.google.com/forms/d/e/1FAIpQLSdXduIjXLRV0t_u3TGyi6hXsOjjAXHCSV4mkaxC0NsROcvjPg/viewform";
const MS: [string, string, number][] = [["m1", "1st Month", 1], ["m3", "3rd Month", 3], ["m5", "5th Month", 5]];
const INVITE_DAYS = 7, REMIND_AFTER = 3, SEND_FROM_HOUR = 8;
const iso = (d: Date) => d.toISOString().slice(0, 10);
const addDays = (d: string, n: number) => { const x = new Date(d + "T00:00:00Z"); x.setUTCDate(x.getUTCDate() + n); return iso(x); };
// same as addMonths() in the HRIS: the day is kept, or the month's last day when it is shorter
const addMonths = (d: string, n: number) => {
  const [y, m, day] = d.split("-").map(Number);
  const r = new Date(Date.UTC(y, m - 1 + n, 1)), last = new Date(Date.UTC(r.getUTCFullYear(), r.getUTCMonth() + 1, 0)).getUTCDate();
  r.setUTCDate(Math.min(day, last));
  return iso(r);
};
const longDate = (d: string) => new Date(d + "T00:00:00Z").toLocaleDateString("en-US", { timeZone: "UTC", weekday: "long", month: "long", day: "numeric", year: "numeric" });
const fullName = (e: Doc) => [e.firstName, e.middleName ? s(e.middleName)[0] + "." : "", e.lastName, e.suffix].filter(Boolean).join(" ");
const SEPARATED = ["Separated", "Blocklisted", "Resigned", "Terminated", "End of Contract"];

async function docsOf(col: string) {
  const { data, error } = await sb.rpc("hris_jotform_docs", { col });
  if (error) throw new Error(error.message);
  return (data ?? []) as Doc[];
}
function mail(e: Doc, k: string, label: string, due: string, reminder: boolean) {
  const name = fullName(e), site = [e.client, e.site].filter(Boolean).join(" – ");
  const link = `${FORM}?usp=pp_url&entry.825751300=${encodeURIComponent(label + " Evaluation")}&entry.171539888=${encodeURIComponent(name)}&entry.1567188607=${encodeURIComponent(site)}${e.hireDate ? `&entry.1828040482=${e.hireDate}` : ""}`;
  const subject = `${reminder ? "Reminder: " : ""}${label} Evaluation of ${name} (due ${longDate(due)})`;
  const body = `Dear ${s(e.supervisorName) || "Sir/Madam"},

Good day! ${reminder ? `This is a friendly reminder that we have not yet received your ${label.toLowerCase()} evaluation of ${name}` : `May we request your ${label.toLowerCase()} evaluation of ${name}`}${e.position ? `, ${e.position}` : ""}, deployed at ${site || "your company"}. The evaluation is due on ${longDate(due)}.

Please fill out the Client's Feedback & Performance Evaluation Form through this link:
${link}

The employee's name, site, date hired and evaluation period are already filled in. It takes about 5 minutes.

Thank you very much.

Human Resources Department
Golden Bear Manpower Agency`;
  return { key: `${e.id}_${k}`, kind: reminder ? "reminder" : "invite", employeeId: e.id, period: k, to: s(e.supervisorEmail), subject, body };
}
async function due() {
  const ph = new Date(Date.now() + 8 * 36e5), today = iso(ph);
  if (ph.getUTCHours() < SEND_FROM_HOUR) return { today, items: [] };
  const [emps, invites, answers] = await Promise.all([docsOf("employees"), docsOf("evalinvites"), docsOf("clientevals")]);
  const inv = new Map(invites.map((x) => [x.id, x]));
  const items = [];
  for (const e of emps) {
    if (e.employmentType !== "Probationary" || SEPARATED.includes(e.status) || !e.hireDate || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s(e.supervisorEmail))) continue;
    for (const [k, label, n] of MS) {
      const rec = e.evals?.[k];
      if (rec?.date) { if (rec.recommendation === "Not recommended") break; continue; } // a Not recommended evaluation stops the later ones
      if (answers.some((a) => a.employeeId === e.id && a.period === k)) continue;
      const d = addMonths(e.hireDate, n), sent = inv.get(`${e.id}_${k}`);
      if (!sent?.sentAt) { if (today >= addDays(d, -INVITE_DAYS) && today <= d) items.push(mail(e, k, label, d, false)); }
      else if (!sent.reminderAt && today >= addDays(iso(new Date(new Date(sent.sentAt).getTime() + 8 * 36e5)), REMIND_AFTER)) items.push(mail(e, k, label, d, true));
    }
  }
  return { today, items };
}
async function markSent(list: { key: string; kind: string; to: string; employeeId: string; period: string }[]) {
  const at = new Date().toISOString();
  const rows = list.filter((x) => x && x.key).map((x) => ({
    id: x.key,
    data: { employeeId: x.employeeId, period: x.period, to: x.to, ...(x.kind === "reminder" ? { reminderAt: at } : { sentAt: at }) },
  }));
  if (!rows.length) return 0;
  const { data, error } = await sb.rpc("hris_merge_evalinvites", { rows });
  if (error) throw new Error(error.message);
  return Number(data ?? 0);
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  const body = await req.json().catch(() => null);
  if (!body || typeof body.token !== "string" || (await sha256(body.token)) !== TOKEN_SHA256) return json({ error: "not allowed" }, 401);
  try {
    if (body.action === "due") return json({ ok: true, ...(await due()) });
    if (body.action === "sent") return json({ ok: true, written: await markSent(Array.isArray(body.items) ? body.items : []) });
  } catch (e) {
    return json({ ok: false, error: String((e as Error)?.message ?? e) }, 502);
  }
  const rows = (Array.isArray(body.rows) ? body.rows : []) as Row[];
  if (!rows.length) return json({ ok: true, written: 0 });
  try {
    const { data: emps, error } = await sb.rpc("hris_jotform_docs", { col: "employees" });
    if (error) throw new Error(error.message);
    const match = matcher((emps ?? []) as Doc[]);
    const docs = rows.filter((r) => r && r.id && Array.isArray(r.answers)).map((r) => toDoc(r, match));
    let written = 0;
    for (let i = 0; i < docs.length; i += 200) {
      const { data, error: e2 } = await sb.rpc("hris_upsert_client_evals", { rows: docs.slice(i, i + 200) });
      if (e2) throw new Error(e2.message);
      written += Number(data ?? 0);
    }
    return json({ ok: true, received: rows.length, written, matched: docs.filter((d) => d.data.employeeId).length });
  } catch (e) {
    return json({ ok: false, error: String((e as Error)?.message ?? e) }, 502);
  }
});
