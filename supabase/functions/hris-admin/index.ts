// HRIS Settings → User access. Only an HRIS admin may call this. The admin creates staff accounts (email + a
// temporary password they give the person), sets each one's access, resets passwords and turns accounts off.
// Access is kept in the account's app_metadata (users cannot change it themselves):
//   hris_role  "admin" (everything + Settings) | "staff" (add and edit records) | "viewer" (view only)
//   approver   "HR" | "Owner" | ""  (preselected in the Approve/Decline window)
// Accounts made before this have no hris_role and count as staff; the database rules read hris_role too.
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

type Meta = Record<string, unknown>;
const ROLES = ["admin", "staff", "viewer"];
const APPROVERS = ["", "HR", "Owner"];
const role = (m: Meta | undefined) => (ROLES.includes(s(m?.hris_role)) ? s(m?.hris_role) : "staff");
const OFF = "876000h"; // about 100 years: the account cannot sign in

// deno-lint-ignore no-explicit-any
const view = (u: any) => ({
  id: u.id, email: u.email, name: s(u.user_metadata?.full_name), role: role(u.app_metadata), approver: s(u.app_metadata?.approver),
  active: !u.banned_until || new Date(u.banned_until) < new Date(), lastSignIn: u.last_sign_in_at ?? null, createdAt: u.created_at,
});
async function all() {
  const out = [];
  for (let page = 1; ; page++) {
    const { data, error } = await sb.auth.admin.listUsers({ page, perPage: 200 });
    if (error) throw error;
    out.push(...data.users);
    if (data.users.length < 200) break;
  }
  return out;
}
const goodPassword = (p: string) => p.length >= 8;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const jwt = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  const { data: me } = jwt ? await sb.auth.getUser(jwt) : { data: { user: null } };
  if (!me?.user) return json({ error: "Please sign in again." }, 401);
  // read the role fresh, not from the caller's token, so a removed admin loses access at once
  const { data: fresh } = await sb.auth.admin.getUserById(me.user.id);
  if (role(fresh?.user?.app_metadata) !== "admin") return json({ error: "Only an HRIS admin can manage user access." }, 403);

  const b = await req.json().catch(() => ({}));
  const action = s(b.action), id = s(b.id);
  try {
    if (action === "list") return json({ users: (await all()).map(view) });

    if (action === "create") {
      const email = s(b.email).toLowerCase(), name = s(b.name), password = String(b.password ?? "");
      if (!/^\S+@\S+\.\S+$/.test(email)) return json({ error: "Enter a valid email address." }, 400);
      if (!name) return json({ error: "Enter the person's full name." }, 400);
      if (!goodPassword(password)) return json({ error: "The temporary password needs at least 8 characters." }, 400);
      if (!ROLES.includes(s(b.role))) return json({ error: "Choose an access level." }, 400);
      const { data, error } = await sb.auth.admin.createUser({
        email, password, email_confirm: true, user_metadata: { full_name: name },
        app_metadata: { hris_role: s(b.role), approver: APPROVERS.includes(s(b.approver)) ? s(b.approver) : "" },
      });
      if (error) return json({ error: /already/i.test(error.message) ? "There is already an account with this email." : error.message }, 400);
      await sb.from("hris_profiles").upsert({ id: data.user.id, name, email, updated_at: new Date().toISOString() });
      return json({ user: view(data.user) });
    }

    if (!id) return json({ error: "No account given." }, 400);
    const { data: got, error: gerr } = await sb.auth.admin.getUserById(id);
    if (gerr || !got?.user) return json({ error: "That account no longer exists." }, 404);
    const u = got.user, self = id === me.user.id;
    const admins = async () => (await all()).filter((x) => role(x.app_metadata) === "admin" && view(x).active && x.id !== id).length;

    if (action === "update") {
      const r = s(b.role), ap = s(b.approver), name = s(b.name);
      if (!ROLES.includes(r) || !APPROVERS.includes(ap)) return json({ error: "Choose an access level." }, 400);
      if (r !== "admin" && role(u.app_metadata) === "admin" && !(await admins())) return json({ error: "Keep at least one admin, or nobody can manage access." }, 400);
      const { data, error } = await sb.auth.admin.updateUserById(id, {
        app_metadata: { ...u.app_metadata, hris_role: r, approver: ap },
        ...(name ? { user_metadata: { ...u.user_metadata, full_name: name } } : {}),
      });
      if (error) throw error;
      if (name) await sb.from("hris_profiles").upsert({ id, name, email: u.email, updated_at: new Date().toISOString() });
      return json({ user: view(data.user) });
    }
    if (action === "password") {
      const password = String(b.password ?? "");
      if (!goodPassword(password)) return json({ error: "The new password needs at least 8 characters." }, 400);
      const { data, error } = await sb.auth.admin.updateUserById(id, { password });
      if (error) throw error;
      return json({ user: view(data.user) });
    }
    if (action === "disable" || action === "enable") {
      if (action === "disable" && self) return json({ error: "You cannot turn off your own account." }, 400);
      if (action === "disable" && role(u.app_metadata) === "admin" && !(await admins())) return json({ error: "Keep at least one admin, or nobody can manage access." }, 400);
      const { data, error } = await sb.auth.admin.updateUserById(id, { ban_duration: action === "disable" ? OFF : "none" });
      if (error) throw error;
      return json({ user: view(data.user) });
    }
    return json({ error: "Unknown action." }, 400);
  } catch (e) {
    return json({ error: String((e as Error)?.message ?? e) }, 500);
  }
});
