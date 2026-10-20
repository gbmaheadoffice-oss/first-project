// Copies GBMA Online Job Application Form submissions from Jotform into hris_docs (collection "applicants").
// Runs every 5 minutes from pg_cron, and on demand from the HRIS "Sync now" button.
// Only the applicant's answers (data.form / data.jotform) are updated on re-sync; HR's status and notes are kept.
import { createClient } from "npm:@supabase/supabase-js@2.50.0";

const FORM_ID = "261088132496057";
const JF = "https://api.jotform.com";
const PAGE = 1000;

const env = (k: string) => Deno.env.get(k) ?? "";
const sb = createClient(env("SUPABASE_URL"), env("HRIS_SECRET_KEY"), { auth: { persistSession: false } });
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-sync-token",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

// ---------- answer helpers ----------
type A = Record<string, { answer?: unknown; prettyFormat?: string }>;
const s = (v: unknown) => (v == null ? "" : String(v).trim());
const txt = (a: A, q: string) => s(a[q]?.answer);
const date = (a: A, q: string) => {
  const v = a[q]?.answer as { year?: string; month?: string; day?: string } | undefined;
  return v && v.year && v.month && v.day ? `${v.year}-${v.month.padStart(2, "0")}-${v.day.padStart(2, "0")}` : "";
};
const addr = (a: A, q: string) => {
  const v = a[q]?.answer as Record<string, string> | undefined;
  if (!v || typeof v !== "object") return txt(a, q);
  return ["addr_line1", "addr_line2", "city", "state", "postal", "country"].map((k) => s(v[k])).filter(Boolean).join(", ");
};
const phone = (a: A, q: string) => {
  const v = a[q]?.answer as { full?: string } | string | undefined;
  return typeof v === "object" && v ? s(v.full) : s(v);
};
const name = (a: A, q: string) => {
  const v = a[q]?.answer as Record<string, string> | undefined;
  return v && typeof v === "object" ? [v.prefix, v.first, v.middle, v.last, v.suffix].map(s).filter(Boolean).join(" ") : txt(a, q);
};
const pick = (a: A, q: string) => {
  const v = a[q]?.answer;
  return Array.isArray(v) ? v.map(s).filter(Boolean).join(", ") : s(v);
};
const list = (a: A, q: string, keys: Record<string, string>) => {
  let rows: Record<string, unknown>[] = [];
  try { rows = JSON.parse(txt(a, q) || "[]"); } catch { return []; }
  if (!Array.isArray(rows)) return [];
  return rows
    .map((r) => Object.fromEntries(Object.entries(keys).map(([to, from]) => [to, s(r?.[from])])))
    .filter((r) => Object.values(r).some(Boolean));
};
const school = (a: A, n: string, y: string, l: string, h: string, c?: string, m?: string) => {
  const r: Record<string, string> = { school: txt(a, n), years: txt(a, y), location: addr(a, l), honors: txt(a, h) };
  if (c) r.course = txt(a, c);
  if (m) r.major = txt(a, m);
  return r;
};

function toForm(a: A) {
  return {
    position: txt(a, "3"), desiredSalary: txt(a, "4"), availableFrom: date(a, "5"), dateApplied: date(a, "6"),
    lastName: txt(a, "8"), firstName: txt(a, "9"), middleName: txt(a, "10"), suffix: txt(a, "11"),
    height: txt(a, "13"), weight: txt(a, "14"), presentAddress: addr(a, "15"), facebook: addr(a, "153"),
    mobile: phone(a, "17"), email: txt(a, "18"), age: txt(a, "19"), birthDate: date(a, "20"), birthPlace: txt(a, "21"),
    civilStatus: txt(a, "22"), citizenship: txt(a, "23"), religion: txt(a, "24"), gender: txt(a, "25"),
    sss: txt(a, "26"), tin: txt(a, "27"), philhealth: txt(a, "28"), pagibig: txt(a, "29"),
    spouseName: txt(a, "31"), spouseOccupation: txt(a, "32"), childrenCount: txt(a, "34"),
    children: list(a, "35", { name: "Name", age: "Age", birthDate: "Date of Birth" }),
    father: { name: txt(a, "36"), age: txt(a, "37"), birthDate: date(a, "38"), occupation: txt(a, "39"), address: addr(a, "40") },
    mother: { name: txt(a, "41"), age: txt(a, "42"), birthDate: date(a, "43"), occupation: txt(a, "44"), address: addr(a, "45") },
    siblings: list(a, "46", { name: "Name", age: "Age", birthDate: "Date of Birth", occupation: "Occupation", address: "Address" }),
    emergency: { name: name(a, "48"), relationship: txt(a, "49"), address: addr(a, "50"), phone: phone(a, "51") },
    currentlyEmployed: pick(a, "53"), formerEmployee: pick(a, "54"), formerWhen: txt(a, "55"),
    hasRelatives: pick(a, "56"), relatives: txt(a, "57"),
    overtime: pick(a, "58"), overtimeReason: txt(a, "59"), sundays: pick(a, "60"), sundaysReason: txt(a, "61"),
    education: {
      primary: school(a, "63", "65", "64", "68"),
      secondary: school(a, "69", "71", "70", "74"),
      tertiary: school(a, "75", "77", "76", "80", "78", "79"),
      vocational: school(a, "81", "83", "82", "86", "84", "85"),
    },
    otherQualifications: txt(a, "94"), equipment: txt(a, "95"), licenses: txt(a, "96"), skills: txt(a, "97"),
    employment: list(a, "99", {
      employer: "Name of Employer", location: "Location", title: "Job Title", nature: "Nature of the Company",
      salary: "Salary", from: "From", to: "To",
    }),
    references: [
      { name: name(a, "137"), occupation: txt(a, "138"), address: addr(a, "139"), phone: phone(a, "140") },
      { name: name(a, "141"), occupation: txt(a, "142"), address: addr(a, "143"), phone: phone(a, "144") },
    ].filter((r) => r.name),
    signatureUrl: txt(a, "150"),
  };
}

// ---------- auth: cron token or a signed-in HRIS user ----------
async function allowed(req: Request) {
  const tok = req.headers.get("x-sync-token");
  if (tok && tok === env("SYNC_TOKEN")) return true;
  const jwt = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!jwt) return false;
  const { data, error } = await sb.auth.getUser(jwt);
  return !error && !!data.user;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (!(await allowed(req))) return json({ error: "not allowed" }, 401);

  const body = await req.json().catch(() => ({}));
  const full = body?.full === true;

  // Incremental: look back 2 days from the newest stored submission (catches late edits). Full: everything.
  let since = "";
  if (!full) {
    const { data } = await sb.from("hris_docs").select("data->jotform->>createdAt").eq("collection", "applicants")
      .order("data->jotform->>createdAt", { ascending: false }).limit(1);
    const last = data?.[0] ? Object.values(data[0])[0] as string : "";
    if (last) since = new Date(new Date(last.replace(" ", "T") + "Z").getTime() - 2 * 864e5).toISOString().slice(0, 19).replace("T", " ");
  }

  let offset = 0, fetched = 0, written = 0;
  for (;;) {
    const u = new URL(`${JF}/form/${FORM_ID}/submissions`);
    u.searchParams.set("limit", String(PAGE));
    u.searchParams.set("offset", String(offset));
    u.searchParams.set("orderby", "created_at");
    if (since) u.searchParams.set("filter", JSON.stringify({ "created_at:gt": since }));
    const r = await fetch(u, { headers: { APIKEY: env("JOTFORM_API_KEY") } });
    const j = await r.json().catch(() => null);
    if (!r.ok || !j || j.responseCode !== 200) return json({ error: "jotform request failed", status: r.status, message: j?.message }, 502);
    const subs = (j.content ?? []) as { id: string; status: string; created_at: string; updated_at: string | null; answers: A }[];
    fetched += subs.length;
    const rows = subs.filter((x) => x.status === "ACTIVE").map((x) => ({
      id: `jf-${x.id}`,
      form: toForm(x.answers ?? {}),
      meta: { submissionId: x.id, formId: FORM_ID, createdAt: x.created_at, updatedAt: x.updated_at },
    }));
    if (rows.length) {
      const { data, error } = await sb.rpc("hris_upsert_applicants", { rows });
      if (error) return json({ error: error.message }, 500);
      written += Number(data ?? 0);
    }
    if (subs.length < PAGE) break;
    offset += PAGE;
  }
  return json({ ok: true, fetched, written, mode: full ? "full" : since ? `since ${since}` : "first run" });
});
