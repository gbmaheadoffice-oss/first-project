// Copies Jotform submissions into hris_docs:
//   GBMA Online Job Application Form -> "applicants" (only the answers are refreshed; HR's status and notes are kept)
//   GBMA Leave Form                  -> "leaves"  (new requests start as Pending)
//   GBMA Permit to Work              -> "permits" (new requests start as Pending, linked to their leave)
// Runs every 5 minutes from pg_cron, and on demand from the HRIS "Check Jotform now" buttons.
import { createClient } from "npm:@supabase/supabase-js@2.50.0";

const FORM_ID = "261088132496057";
const LEAVE_FORM = "261329099923466";
const PERMIT_FORM = "261331432840448";
const JF = "https://api.jotform.com";
const PAGE = 1000;
const BUCKET = "hris-files";
const MAX_FILES = 40; // files copied per run; the rest are copied on the next runs

const env = (k: string) => Deno.env.get(k) ?? "";
const sb = createClient(env("SUPABASE_URL"), env("HRIS_SECRET_KEY"), { auth: { persistSession: false } });
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-sync-token",
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

// ---------- leaves and permits ----------
type Sub = { id: string; status: string; created_at: string; updated_at: string | null; answers: A };
type Doc = Record<string, any>;
type File = { id?: string; name: string; type?: string; size?: number; at?: string; url?: string; source: string; error?: string };

// Jotform times are in the account's time zone (Asia/Singapore, UTC+8, same as the Philippines).
const isoAt = (t: string) => new Date(t.replace(" ", "T") + "+08:00").toISOString();
const iso = (d: Date) => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
const addDays = (d: string, n: number) => { const x = new Date(d + "T00:00:00Z"); x.setUTCDate(x.getUTCDate() + n); return iso(x); };
const sunday = (d: string) => new Date(d + "T00:00:00Z").getUTCDay() === 0;
const workdays = (a: string, b: string) => { let n = 0; for (let d = a; d <= b; d = addDays(d, 1)) if (!sunday(d)) n++; return n; };
const nextWorkday = (d: string) => { let x = addDays(d, 1); if (sunday(x)) x = addDays(x, 1); return x; };
const hhmm = (h?: string, m?: string, ap?: string) => (h ? `${h}:${m || "00"}${ap ? " " + ap : ""}` : "");
const schedule = (a: A, q: string) => {
  const v = a[q]?.answer as Record<string, string> | undefined;
  if (!v || typeof v !== "object") return "";
  return [hhmm(v.hourSelect, v.minuteSelect, v.ampm), hhmm(v.hourSelectRange, v.minuteSelectRange, v.ampmRange)].filter(Boolean).join(" – ");
};
const urls = (a: A, q: string) => {
  const v = a[q]?.answer;
  return (Array.isArray(v) ? v : [v]).map(s).filter((x) => /^https:\/\/\S+$/.test(x));
};
const parts = (a: A, q: string) => {
  const v = a[q]?.answer as Record<string, string> | undefined;
  return v && typeof v === "object" ? { first: s(v.first), middle: s(v.middle), last: s(v.last), suffix: s(v.suffix) } : { first: "", middle: "", last: txt(a, q), suffix: "" };
};

// Employee ID typed by the employee, e.g. "Gbma07-02-025" or "GBMA01-25-37": compared without case, separators or leading zeros.
const idKey = (v: string) => s(v).toUpperCase().replace(/\d+/g, (n) => String(+n)).replace(/[^A-Z0-9]+/g, "-").replace(/^-|-$/g, "");
const low = (v: string) => s(v).toLowerCase().replace(/\s+/g, " ");
// By name when the ID does not match: same last name, and the first name as typed, with the middle name
// (some type "Diane" + "Rose" for "Diane Rose"), or the same first word. Only a single match counts.
function matcher(emps: Doc[]) {
  const byId = new Map<string, Doc>();
  for (const e of emps) if (e.empNo) byId.set(idKey(e.empNo), e);
  return (empNo: string, n: { first: string; middle: string; last: string }) => {
    const e = empNo ? byId.get(idKey(empNo)) : undefined;
    if (e) return e;
    const last = low(n.last), first = low(n.first), both = low(`${n.first} ${n.middle}`);
    if (!last || !first) return undefined;
    const same = emps.filter((x) => low(x.lastName) === last);
    for (const ok of [(f: string) => f === first || f === both, (f: string) => f.split(" ")[0] === first.split(" ")[0]]) {
      const m = same.filter((x) => ok(low(x.firstName)));
      if (m.length === 1) return m[0];
      if (m.length > 1) return undefined;
    }
    return undefined;
  };
}

const LEAVE_TYPE: Record<string, string> = {
  "sick leave": "Sick", "vacation leave": "Vacation", "maternity leave": "Maternity", "paternity leave": "Paternity",
  "emergency leave": "Emergency", "solo parents leave": "Solo Parent", "solo parent leave": "Solo Parent",
  "half day leave": "Half Day", "undertime leave": "Undertime", "personal leave": "Personal",
};
const leaveType = (v: string) => LEAVE_TYPE[v.toLowerCase()] ?? (v.replace(/\s*leave$/i, "") || "Other");

const MIME: Record<string, string> = { pdf: "application/pdf", jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp", gif: "image/gif" };
let copied = 0;
async function copyFile(url: string): Promise<File> {
  const name = decodeURIComponent(url.split("?")[0].split("/").pop() || "file").slice(0, 140);
  const type = MIME[(name.split(".").pop() || "").toLowerCase()];
  if (!type) return { name, url, source: "jotform", error: "type" };
  if (copied >= MAX_FILES) return { name, url, source: "jotform", error: "later" };
  copied++;
  try {
    const r = await fetch(`${url}${url.includes("?") ? "&" : "?"}apiKey=${encodeURIComponent(env("JOTFORM_API_KEY"))}`);
    if (!r.ok) return { name, url, source: "jotform", error: "download" };
    const buf = new Uint8Array(await r.arrayBuffer());
    if (buf.length > 20 * 1048576) return { name, url, source: "jotform", error: "size" };
    const id = crypto.randomUUID().replace(/-/g, "");
    const { error } = await sb.storage.from(BUCKET).upload(id, buf, { contentType: type, upsert: false });
    if (error) return { name, url, source: "jotform", error: "upload" };
    return { id, name, type, size: buf.length, at: new Date().toISOString(), url, source: "jotform" };
  } catch {
    return { name, url, source: "jotform", error: "download" };
  }
}
// New submissions: copy every file. Already stored: retry only files not copied yet (left for later, or a failed download).
const final = (f: File) => !!f.id || f.error === "type" || f.error === "size" || !f.url;
async function files(list: string[], prev?: File[]) {
  if (!prev) return Promise.all(list.map(copyFile));
  if (prev.every(final)) return null;
  return Promise.all(prev.map((f) => (final(f) ? f : copyFile(f.url!))));
}

async function fetchSubs(form: string, since: string) {
  const out: Sub[] = [];
  for (let offset = 0; ; offset += PAGE) {
    const u = new URL(`${JF}/form/${form}/submissions`);
    u.searchParams.set("limit", String(PAGE));
    u.searchParams.set("offset", String(offset));
    u.searchParams.set("orderby", "created_at");
    if (since) u.searchParams.set("filter", JSON.stringify({ "created_at:gt": since }));
    const r = await fetch(u, { headers: { APIKEY: env("JOTFORM_API_KEY") } });
    const j = await r.json().catch(() => null);
    if (!r.ok || !j || j.responseCode !== 200) throw new Error(`jotform request failed (${r.status}) ${j?.message ?? ""}`);
    const subs = (j.content ?? []) as Sub[];
    out.push(...subs);
    if (subs.length < PAGE) break;
  }
  return out.filter((x) => x.status === "ACTIVE").sort((a, b) => (a.created_at < b.created_at ? -1 : 1));
}
// Look back 2 days from the newest stored submission (catches late edits). Full: everything.
async function sinceFor(rpc: string, args: Record<string, string>, full: boolean) {
  if (full) return "";
  const { data: last } = await sb.rpc(rpc, args);
  return last ? new Date(new Date(last.replace(" ", "T") + "Z").getTime() - 2 * 864e5).toISOString().slice(0, 19).replace("T", " ") : "";
}
async function docs(col: string) {
  const { data, error } = await sb.rpc("hris_jotform_docs", { col });
  if (error) throw new Error(error.message);
  return (data ?? []) as Doc[];
}
async function save(col: string, rows: unknown[]) {
  let n = 0;
  for (let i = 0; i < rows.length; i += 200) {
    const { data, error } = await sb.rpc("hris_upsert_jotform", { col, rows: rows.slice(i, i + 200) });
    if (error) throw new Error(error.message);
    n += Number(data ?? 0);
  }
  return n;
}
// Files that need a retry are in records older than the incremental window, so those are revisited too.
const retryIds = (stored: Map<string, Doc>) => [...stored.values()].filter((d) => d.source === "jotform" && (d.attachments ?? []).some((f: File) => !final(f))).map((d) => d.jotform?.submissionId as string);
async function withRetries(form: string, since: string, stored: Map<string, Doc>) {
  const subs = await fetchSubs(form, since);
  const have = new Set(subs.map((x) => x.id));
  for (const sid of retryIds(stored)) {
    if (!sid || have.has(sid)) continue;
    const r = await fetch(`${JF}/submission/${sid}`, { headers: { APIKEY: env("JOTFORM_API_KEY") } });
    const j = await r.json().catch(() => null);
    if (r.ok && j?.content?.status === "ACTIVE") subs.push(j.content as Sub);
  }
  return subs;
}

async function syncLeaves(full: boolean, match: ReturnType<typeof matcher>, stored: Map<string, Doc>) {
  const subs = await withRetries(LEAVE_FORM, await sinceFor("hris_jotform_last_created", { col: "leaves" }, full), stored);
  const rows = [];
  for (const x of subs) {
    const a = x.answers ?? {}, id = `jf-${x.id}`, prev = stored.get(id);
    const n = parts(a, "15"), empNo = txt(a, "20"), e = match(empNo, n);
    const type = leaveType(txt(a, "8")), part = type === "Half Day" || type === "Undertime";
    const from = date(a, "9"), back = date(a, "10");
    // "Return Date" is the day the employee is back; the leave ends the workday before it (or on the same day).
    let to = from;
    if (from && back > from && !part) { to = addDays(back, -1); while (sunday(to) && to > from) to = addDays(to, -1); }
    let days = !from ? 0 : part ? 0.5 : Math.max(1, workdays(from, to));
    // A mistyped return date (e.g. October for May) is caught by the form's own "No. of Days"; that count is used instead.
    const jd = Math.max(1, Math.round(Number(txt(a, "21")) || 0));
    if (from && !part && Number(txt(a, "21")) > 0 && days > jd + 1) {
      to = from;
      for (let k = 1; k < jd;) { to = addDays(to, 1); if (!sunday(to)) k++; }
      days = jd;
    }
    const jotform = {
      submissionId: x.id, formId: LEAVE_FORM, createdAt: x.created_at, updatedAt: x.updated_at,
      name: [n.first, n.middle, n.last, n.suffix].filter(Boolean).join(" "), firstName: n.first, lastName: n.last,
      empNo, email: txt(a, "28"), site: txt(a, "5"), dateHired: date(a, "19"), leaveType: txt(a, "8"),
      leaveDate: s((a["9"]?.answer as Doc)?.datetime), returnDate: s((a["10"]?.answer as Doc)?.datetime), days: txt(a, "21"), schedule: schedule(a, "27"),
    };
    const sync = { type, from, to, days, reason: txt(a, "24"), jotform };
    const fill = e ? { employeeId: e.id, client: e.client ?? "", site: e.site ?? "" } : {};
    const att = await files(urls(a, "11"), prev?.attachments);
    if (!prev) rows.push({ id, data: { source: "jotform", employeeId: "", client: "", site: "", ...fill, ...sync, attachments: att, status: "Pending", filedAt: isoAt(x.created_at) }, sync, fill });
    else rows.push({ id, sync, fill, ...(att ? { set: { attachments: att } } : {}) });
  }
  return { fetched: subs.length, written: await save("leaves", rows) };
}

async function syncPermits(full: boolean, match: ReturnType<typeof matcher>, stored: Map<string, Doc>, leaves: Doc[]) {
  const subs = await withRetries(PERMIT_FORM, await sinceFor("hris_jotform_last_created", { col: "permits" }, full), stored);
  const byLeave = new Map(leaves.map((l) => [l.id, l]));
  // PTW{year}-{month}-{series per year}, continuing from the numbers already used
  const used: Record<string, number> = {};
  for (const p of stored.values()) { const m = /^PTW(\d{4})-\d{2}-(\d{4})$/.exec(p.no ?? ""); if (m) used[m[1]] = Math.max(used[m[1]] ?? 0, +m[2]); }
  const rows = [];
  for (const x of subs) {
    const a = x.answers ?? {}, id = `jf-${x.id}`, prev = stored.get(id);
    const n = parts(a, "10"), empNo = txt(a, "11"), e = match(empNo, n);
    const start = date(a, "17"), end = date(a, "18") || start, filed = date(a, "7"), leaveSid = txt(a, "28").replace(/\D/g, "");
    // The leave this permit is for: the Submission ID# the employee typed, else the employee's leave that overlaps the absence.
    let l = leaveSid ? byLeave.get(`jf-${leaveSid}`) : undefined;
    if (!l && e && start) l = leaves.filter((v) => v.employeeId === e.id && v.from <= end && v.to >= start).sort((p, q) => (q.from < p.from ? -1 : 1))[0];
    const leaveTo = l?.to || end;
    const jotform = {
      submissionId: x.id, formId: PERMIT_FORM, createdAt: x.created_at, updatedAt: x.updated_at,
      name: [n.first, n.middle, n.last, n.suffix].filter(Boolean).join(" "), firstName: n.first, lastName: n.last,
      empNo, email: txt(a, "26"), site: txt(a, "29"), leaveSubmissionId: txt(a, "28"), dateFiled: filed,
      startDate: start, endDate: end, days: txt(a, "15"), schedule: schedule(a, "20"),
    };
    const sync = { returnDate: filed && filed > leaveTo ? filed : leaveTo ? nextWorkday(leaveTo) : filed, jotform };
    const fill: Doc = {
      ...(e ? { employeeId: e.id, client: e.client ?? "", site: e.site ?? "" } : {}),
      ...(l ? { leaveId: l.id, leaveType: l.type, leaveFrom: l.from, leaveTo: l.to, leaveDays: l.days } : {}),
    };
    const att = await files(urls(a, "23").concat(urls(a, "27")), prev?.attachments);
    if (!prev) {
      const ph = new Date(isoAt(x.created_at)).getTime() + 8 * 36e5, d = new Date(ph);
      const yr = String(d.getUTCFullYear()), mo = String(d.getUTCMonth() + 1).padStart(2, "0");
      used[yr] = (used[yr] ?? 0) + 1;
      rows.push({ id, data: { source: "jotform", no: `PTW${yr}-${mo}-${String(used[yr]).padStart(4, "0")}`, employeeId: "", leaveId: "", client: "", site: "",
        leaveType: "", leaveFrom: start, leaveTo: end, leaveDays: Number(txt(a, "15")) || (start ? workdays(start, end) : 0),
        ...fill, ...sync, note: "", attachments: att, status: "Pending", filedAt: isoAt(x.created_at) }, sync, fill });
    } else rows.push({ id, sync, fill, ...(att ? { set: { attachments: att } } : {}) });
  }
  return { fetched: subs.length, written: await save("permits", rows) };
}

async function syncApplicants(full: boolean) {
  const subs = await fetchSubs(FORM_ID, await sinceFor("hris_applicants_last_created", {}, full));
  const rows = subs.map((x) => ({
    id: `jf-${x.id}`,
    form: toForm(x.answers ?? {}),
    meta: { submissionId: x.id, formId: FORM_ID, createdAt: x.created_at, updatedAt: x.updated_at },
  }));
  let written = 0;
  for (let i = 0; i < rows.length; i += 500) {
    const { data, error } = await sb.rpc("hris_upsert_applicants", { rows: rows.slice(i, i + 500) });
    if (error) throw new Error(error.message);
    written += Number(data ?? 0);
  }
  return { fetched: subs.length, written };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (!(await allowed(req))) return json({ error: "not allowed" }, 401);

  const body = await req.json().catch(() => ({}));
  const full = body?.full === true;
  // only: "applicants" or "requests" (leaves and permits); left out = everything
  const only = s(body?.only);
  copied = 0;
  const out: Record<string, unknown> = { ok: true, mode: full ? "full" : "incremental" };
  try {
    if (only !== "requests") out.applicants = await syncApplicants(full);
    if (only !== "applicants") {
      const [emps, leaves, permits] = await Promise.all([docs("employees"), docs("leaves"), docs("permits")]);
      const match = matcher(emps);
      out.leaves = await syncLeaves(full, match, new Map(leaves.map((l) => [l.id, l])));
      out.permits = await syncPermits(full, match, new Map(permits.map((p) => [p.id, p])), await docs("leaves"));
    }
  } catch (e) {
    return json({ ...out, ok: false, error: String((e as Error)?.message ?? e) }, 502);
  }
  // the applicants button reports how many applications changed
  out.written = (out.applicants as { written?: number } | undefined)?.written ?? 0;
  return json(out);
});
