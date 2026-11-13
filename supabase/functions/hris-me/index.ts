// Employee page (/employee/). Deployed employees sign in with their Employee ID and a password HR gives them.
// Their accounts (app_metadata.hris_role = "employee", employee_id = 201 record id) cannot read the HRIS
// tables at all (see supabase/sql/employee_portal.sql); this function returns only their own records.
//   who      (no sign-in needed) Employee ID -> the sign-in email of that employee's account
//   me       the employee's own name/position/site, leaves, permits to work, overtime and memos
//   ack      the employee acknowledges receipt of a memo addressed to them
//   password the employee sets a new password (required on first sign-in and after HR resets it)
import { createClient } from "npm:@supabase/supabase-js@2.50.0";

const env = (k: string) => Deno.env.get(k) ?? "";
const sb = createClient(env("SUPABASE_URL"), env("HRIS_SECRET_KEY"), { auth: { persistSession: false } });
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });
const s = (v: unknown) => (v == null ? "" : String(v).trim());
// deno-lint-ignore no-explicit-any
type Doc = Record<string, any>;

const OFFICE = "Head Office";
const deptKey = (d: unknown) => s(d).toLowerCase().replace(/\s+/g, " ");
const FORMS = {
  leave: "https://form.jotform.com/261329099923466",
  permit: "https://form.jotform.com/261331432840448",
  overtime: "https://form.jotform.com/263009342008044",
};

async function docs(col: string, filter?: [string, string]): Promise<Doc[]> {
  const out: Doc[] = [];
  for (let from = 0; ; from += 1000) {
    let q = sb.from("hris_docs").select("data").eq("collection", col);
    if (filter) q = q.eq(`data->>${filter[0]}`, filter[1]);
    const { data, error } = await q.order("id").range(from, from + 999);
    if (error) throw error;
    out.push(...data.map((r) => r.data as Doc));
    if (data.length < 1000) break;
  }
  return out;
}
async function doc(col: string, id: string): Promise<Doc | null> {
  const { data } = await sb.from("hris_docs").select("data").eq("collection", col).eq("id", id).maybeSingle();
  return (data?.data as Doc) ?? null;
}
const fullName = (e: Doc) => [s(e.firstName), s(e.middleName) ? s(e.middleName)[0] + "." : "", s(e.lastName), s(e.suffix)].filter(Boolean).join(" ");

// same recipients as the employee's 201 file in the HRIS
const isFor = (m: Doc, e: Doc) => {
  const office = e.client === OFFICE;
  return (m.toType === "employee" && m.toValue === e.id) || m.toType === "all" || (m.toType === "solo" && !!e.soloParent) ||
    (m.toType === "deployed" && !office) || (m.toType === "office" && office) ||
    (m.toType === "department" && office && deptKey(m.toValue) === deptKey(e.department)) ||
    (m.toType === "client" && !!e.client && m.toValue === e.client);
};
const memoTo = (m: Doc, e: Doc) => ({
  office: "All GBMA Office Staff", deployed: "All Deployed Employees", all: "All Employees", solo: "All Solo Parent Employees",
  client: `All staff deployed at ${s(m.toValue)}`, department: `${s(m.toValue)} Department`,
}[s(m.toType)] ?? fullName(e));
const memoView = (m: Doc, e: Doc) => ({
  id: m.id, no: s(m.no), type: s(m.type), cat: s(m.cat), subject: s(m.subject), issuedOn: s(m.issuedOn), from: s(m.from),
  to: memoTo(m, e), body: s(m.text) ? "" : s(m.body), text: s(m.text), responseDue: m.type === "Notice to Explain" ? s(m.responseDue) : "",
  holiday: m.event && m.event.date ? { date: s(m.event.date), name: s(m.event.name), kind: s(m.event.kind) } : null,
  ackAt: m.toType === "employee" ? s(m.ackAt) : s(m.acks?.[e.id]),
});

// the employee's account, read fresh so a turned-off or changed account takes effect at once
async function caller(req: Request) {
  const jwt = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!jwt) return null;
  const { data: me } = await sb.auth.getUser(jwt);
  if (!me?.user) return null;
  const { data: fresh } = await sb.auth.admin.getUserById(me.user.id);
  const u = fresh?.user;
  if (!u || u.app_metadata?.hris_role !== "employee" || !s(u.app_metadata?.employee_id)) return null;
  if (u.banned_until && new Date(u.banned_until) > new Date()) return null;
  return u;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const b = await req.json().catch(() => ({}));
  const action = s(b.action);
  try {
    if (action === "who") {
      const no = s(b.empNo).toLowerCase();
      if (!no) return json({ error: "Enter your Employee ID." }, 400);
      const { data } = await sb.from("hris_docs").select("id,data").eq("collection", "employees").ilike("data->>empNo", no.replace(/[%_\\]/g, "\\$&"));
      const e = (data ?? []).find((r) => s(r.data?.empNo).toLowerCase() === no);
      // the same answer whether the ID is unknown or has no account, so IDs cannot be tested one by one
      if (!e) return json({ email: null });
      const { data: rows } = await sb.rpc("hris_employee_login_email", { emp_id: e.id });
      return json({ email: rows ?? null });
    }

    const u = await caller(req);
    if (!u) return json({ error: "Please sign in again." }, 401);
    const empId = s(u.app_metadata.employee_id);
    const e = await doc("employees", empId);
    if (!e) return json({ error: "Your 201 file was not found. Please contact HR." }, 404);

    if (action === "password") {
      const p = String(b.password ?? "");
      if (p.length < 8) return json({ error: "Use at least 8 characters." }, 400);
      const { error } = await sb.auth.admin.updateUserById(u.id, { password: p, app_metadata: { ...u.app_metadata, must_change: false } });
      if (error) return json({ error: error.message }, 400);
      return json({ ok: true });
    }

    if (action === "ack") {
      const m = await doc("memos", s(b.id));
      if (!m || m.status === "Draft" || !isFor(m, e)) return json({ error: "Memo not found." }, 404);
      const at = new Date().toISOString();
      const nd: Doc = { ...m, updatedAt: at };
      if (m.toType === "employee") {
        if (!m.ackAt) { nd.ackAt = at; nd.ackVia = "Employee page"; if (m.status === "Open") nd.status = "Acknowledged"; }
      } else {
        nd.acks = { ...(m.acks ?? {}) };
        if (!nd.acks[empId]) nd.acks[empId] = at;
      }
      const { error } = await sb.from("hris_docs").update({ data: nd, updated_at: at }).eq("collection", "memos").eq("id", m.id);
      if (error) throw error;
      return json({ ackAt: m.toType === "employee" ? nd.ackAt : nd.acks[empId] });
    }

    if (action === "me") {
      const [lv, pm, ot, mm] = await Promise.all([
        docs("leaves", ["employeeId", empId]), docs("permits", ["employeeId", empId]),
        docs("overtime", ["employeeId", empId]), docs("memos"),
      ]);
      const desc = (k: string) => (a: Doc, b2: Doc) => (s(a[k]) < s(b2[k]) ? 1 : -1);
      return json({
        mustChange: u.app_metadata.must_change === true,
        employee: {
          name: fullName(e), firstName: s(e.firstName), empNo: s(e.empNo), position: s(e.position), client: s(e.client),
          site: s(e.site), department: s(e.department), hireDate: s(e.hireDate), employmentType: s(e.employmentType),
        },
        forms: FORMS,
        leaves: lv.sort(desc("from")).map((l) => ({
          id: l.id, type: s(l.type), from: s(l.from), to: s(l.to), days: l.days ?? null, status: s(l.status), filedAt: s(l.filedAt),
          reason: s(l.reason), remarks: l.status === "Pending" ? "" : s(l.remarks), unpaidDays: l.unpaidDays ?? null,
        })),
        permits: pm.sort(desc("returnDate")).map((p) => ({
          id: p.id, no: s(p.no), returnDate: s(p.returnDate), leaveType: s(p.leaveType), leaveFrom: s(p.leaveFrom),
          leaveTo: s(p.leaveTo), status: s(p.status), filedAt: s(p.filedAt),
        })),
        overtime: ot.sort(desc("date")).map((o) => ({
          id: o.id, date: s(o.date), hours: Number(o.hours) || 0, reason: s(o.reason), status: s(o.status), filedAt: s(o.filedAt),
        })),
        memos: mm.filter((m) => m.status !== "Draft" && isFor(m, e)).sort(desc("issuedOn")).map((m) => memoView(m, e)),
      });
    }
    return json({ error: "Unknown action." }, 400);
  } catch (err) {
    console.error(err);
    return json({ error: "Something went wrong. Please try again." }, 500);
  }
});
