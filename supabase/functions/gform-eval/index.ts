// Receives answers to the Google Form "CLIENT'S FEEDBACK & PERFORMANCE EVALUATION FORM" from the form's
// Apps Script (supabase/google-form/client-eval.gs) and stores them in hris_docs "clientevals",
// matched to the employee (name + date hired) and the evaluation (1st, 3rd or 5th month).
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

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  const body = await req.json().catch(() => null);
  if (!body || typeof body.token !== "string" || (await sha256(body.token)) !== TOKEN_SHA256) return json({ error: "not allowed" }, 401);
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
