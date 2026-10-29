/* Supabase adapter for the Manpower HRIS.
   The HRIS was first built as a claude.ai artifact and talks to storage through window.claude.use('db' | 'user' | 'assets' | 'downloads').
   This file provides the same interface backed by Supabase (Postgres table hris_docs, table hris_profiles, private bucket hris-files),
   plus a staff login screen. The HRIS app code itself does not need to know which backend it runs on. */
(function(){
"use strict";
const CFG=window.HRIS_CONFIG;
const BUCKET='hris-files';
const MAX_BYTES=20*1024*1024;
const PAGE=1000;

/* Read the link type before supabase-js consumes the URL hash (invite / password reset emails). */
const LINK_TYPE=(/[#&?]type=(invite|recovery)/.exec(location.hash+location.search)||[])[1]||null;

const sb=window.supabase.createClient(CFG.url,CFG.key,{auth:{persistSession:true,autoRefreshToken:true,detectSessionInUrl:true}});
window.HRIS_SB=sb;

let readyResolve;
const ready=new Promise(r=>readyResolve=r);
let ME=null;

/* ---------------- login screen ---------------- */
const css=`
#gate{position:fixed;inset:0;z-index:1000;background:var(--bg,#f6f5f1);display:grid;place-items:center;padding:16px;font-family:var(--f-body,system-ui,sans-serif)}
#gate .box{width:min(420px,100%);background:var(--surface,#fff);border:1px solid var(--line,#e4e1d9);border-radius:16px;box-shadow:0 12px 40px rgba(15,30,63,.10);overflow:hidden}
#gate .hd{background:var(--side,#0f1e3f);color:#fff;padding:22px 26px;border-bottom:3px solid var(--gold,#f3c623)}
#gate .hd b{display:block;font-size:20px;font-weight:800}
#gate .hd span{color:var(--gold,#f3c623);font-size:12.5px;font-weight:700;letter-spacing:.06em}
#gate form{padding:22px 26px 26px;display:flex;flex-direction:column;gap:14px}
#gate h2{font-size:19px;margin:0}
#gate p{margin:0;color:var(--muted,#596175);font-size:14.5px}
#gate label{font-weight:600;font-size:14px;display:flex;flex-direction:column;gap:6px}
#gate .msg{border-radius:10px;padding:10px 12px;font-size:14px;font-weight:600}
#gate .msg.bad{background:var(--bad-bg,#fae4e1);color:var(--bad,#ac2a20)}
#gate .msg.ok{background:var(--ok-bg,#e1f2e8);color:var(--ok,#1b6e45)}
#gate .row2{display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap}
#gate .lnk{background:none;border:0;color:var(--info,#28589c);font-weight:600;padding:4px 0;cursor:pointer}
#gate .lnk:hover{text-decoration:underline}`;

function gate(){let g=document.getElementById('gate');if(!g){const st=document.createElement('style');st.textContent=css;document.head.appendChild(st);g=document.createElement('div');g.id='gate';document.body.appendChild(g)}return g}
const esc=s=>String(s==null?'':s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const head=`<div class="hd"><b>HRIS</b><span>GOLDEN BEAR MANPOWER AGENCY</span></div>`;
const redirectTo=()=>location.origin+location.pathname;
const OFF_MSG='Your HRIS account is turned off. Ask your HR admin.';

function showLogin(note){
  const g=gate();
  g.innerHTML=`<div class="box">${head}<form id="g-login" novalidate>
    <h2>Staff sign in</h2>
    ${note?`<div class="msg ${note.kind}">${esc(note.text)}</div>`:''}
    <label>Email<input type="email" name="email" autocomplete="username" required></label>
    <label>Password<input type="password" name="password" autocomplete="current-password" required></label>
    <button class="btn" type="submit">Sign in</button>
    <div class="row2"><button type="button" class="lnk" id="g-forgot">Forgot password?</button><p>No account? Ask your HR admin.</p></div>
  </form></div>`;
  const f=g.querySelector('form');f.email.focus();
  f.onsubmit=async ev=>{ev.preventDefault();const b=f.querySelector('[type=submit]');b.disabled=true;b.textContent='Signing in…';
    const{error}=await sb.auth.signInWithPassword({email:f.email.value.trim(),password:f.password.value});
    if(error){showLogin({kind:'bad',text:error.message==='Invalid login credentials'?'Wrong email or password.':/bann/i.test(error.message)?OFF_MSG:error.message});return}
  };
  g.querySelector('#g-forgot').onclick=async()=>{const email=f.email.value.trim();
    if(!email){showLogin({kind:'bad',text:'Type your email first, then click “Forgot password?”.'});return}
    const{error}=await sb.auth.resetPasswordForEmail(email,{redirectTo:redirectTo()});
    showLogin(error?{kind:'bad',text:error.message}:{kind:'ok',text:'If that email has an account, a reset link is on its way. Check your inbox.'});
  };
}

function showSetPassword(user,isInvite,note){
  const g=gate();const nm=(user.user_metadata&&user.user_metadata.full_name)||'';
  g.innerHTML=`<div class="box">${head}<form novalidate>
    <h2>${isInvite?'Welcome! Set up your account':'Choose a new password'}</h2>
    <p>${esc(user.email)}</p>
    ${note?`<div class="msg ${note.kind}">${esc(note.text)}</div>`:''}
    ${isInvite?`<label>Your full name<input name="name" autocomplete="name" value="${esc(nm)}" required></label>`:''}
    <label>New password<input type="password" name="p1" autocomplete="new-password" minlength="8" required></label>
    <label>Type it again<input type="password" name="p2" autocomplete="new-password" minlength="8" required></label>
    <button class="btn" type="submit">Save and continue</button>
  </form></div>`;
  const f=g.querySelector('form');(f.name||f.p1).focus();
  f.onsubmit=async ev=>{ev.preventDefault();
    if(isInvite&&!f.name.value.trim())return showSetPassword(user,isInvite,{kind:'bad',text:'Please enter your full name.'});
    if(f.p1.value.length<8)return showSetPassword(user,isInvite,{kind:'bad',text:'Use at least 8 characters.'});
    if(f.p1.value!==f.p2.value)return showSetPassword(user,isInvite,{kind:'bad',text:'The two passwords do not match.'});
    const upd={password:f.p1.value};if(isInvite)upd.data={full_name:f.name.value.trim()};
    const{data,error}=await sb.auth.updateUser(upd);
    if(error)return showSetPassword(user,isInvite,{kind:'bad',text:error.message});
    history.replaceState(null,'',redirectTo());
    enter(data.user);
  };
}

let entering=false;
async function enter(user){
  if(entering)return;entering=true;
  /* a fresh token carries access changed in Settings since the last sign-in */
  try{const{data,error}=await sb.auth.refreshSession();if(data&&data.user)user=data.user;
    if(error&&/bann/i.test(error.message||'')){await sb.auth.signOut();entering=false;return showLogin({kind:'bad',text:OFF_MSG})}}catch(e){}
  const meta=user.user_metadata||{};
  let name=meta.full_name||'';
  try{const{data}=await sb.from('hris_profiles').select('name').eq('id',user.id).maybeSingle();if(!name&&data&&data.name)name=data.name}catch(e){}
  if(!name)name=user.email.split('@')[0];
  /* access set in Settings → User access (hris-admin); accounts made before that are staff */
  const am=user.app_metadata||{};
  ME={id:user.id,name,email:user.email,role:['admin','staff','viewer'].includes(am.hris_role)?am.hris_role:'staff',approver:am.approver||'',access:am.hris_access||null};
  sb.from('hris_profiles').upsert({id:user.id,name,email:user.email,updated_at:new Date().toISOString()}).then(()=>{},()=>{});
  const g=document.getElementById('gate');if(g)g.remove();
  readyResolve();
}

/* the HRIS profile menu (top right) has Sign out */
async function signOut(){await sb.auth.signOut();location.replace(redirectTo())}

let decided=false;
sb.auth.onAuthStateChange((event,session)=>{
  if(event==='PASSWORD_RECOVERY'&&session){decided=true;return showSetPassword(session.user,false)}
  if(event==='SIGNED_IN'&&session&&!ME){
    if(LINK_TYPE&&!decided){decided=true;return showSetPassword(session.user,LINK_TYPE==='invite')}
    if(!LINK_TYPE)enter(session.user);
  }
  if(event==='SIGNED_OUT'&&ME)location.replace(redirectTo());
});
function boot(){
  sb.auth.getSession().then(({data})=>{
    if(decided||ME)return;
    const s=data&&data.session;
    if(s&&LINK_TYPE){decided=true;return showSetPassword(s.user,LINK_TYPE==='invite')}
    if(s)return enter(s.user);
    const err=/error_description=([^&]+)/.exec(location.hash);
    showLogin(err?{kind:'bad',text:decodeURIComponent(err[1].replace(/\+/g,' '))+' Ask your HR admin to send a new invite.'}:null);
  });
}
if(document.body)boot();else document.addEventListener('DOMContentLoaded',boot);

/* ---------------- db: collections of JSON records ---------------- */
const cache={};          // collection -> Map(id -> data)
const loaded={};         // collection -> Promise
const colSubs={};        // collection -> Set of {cb}
const docSubs={};        // "collection/id" -> Set of {cb}
let channel=null,subscribedOnce=false;

async function loadCol(col){
  const m=new Map();
  for(let from=0;;from+=PAGE){
    const{data,error}=await sb.from('hris_docs').select('id,data').eq('collection',col).order('id').range(from,from+PAGE-1);
    if(error)throw error;
    data.forEach(r=>m.set(r.id,r.data));
    if(data.length<PAGE)break;
  }
  cache[col]=m;
}
function ensure(col){if(!loaded[col])loaded[col]=loadCol(col).catch(e=>{delete loaded[col];throw e});return loaded[col]}

const colSnap=col=>({docs:[...(cache[col]||new Map()).entries()].map(([id,d])=>({id,data:()=>d,exists:true}))});
const docSnap=(col,id)=>{const d=cache[col]&&cache[col].get(id);return{id,exists:d!==undefined,data:()=>d}};
function emit(col){
  (colSubs[col]||new Set()).forEach(s=>{try{s.cb(colSnap(col))}catch(e){console.error(e)}});
  Object.keys(docSubs).forEach(k=>{const i=k.indexOf('/');if(k.slice(0,i)===col)docSubs[k].forEach(s=>{try{s.cb(docSnap(col,k.slice(i+1)))}catch(e){console.error(e)}})});
}
function startRealtime(){
  if(channel)return;
  channel=sb.channel('hris-docs').on('postgres_changes',{event:'*',schema:'public',table:'hris_docs'},p=>{
    const row=p.eventType==='DELETE'?p.old:p.new;if(!row||!row.collection)return;
    const col=row.collection;if(!cache[col])return;
    if(p.eventType==='DELETE')cache[col].delete(row.id);else cache[col].set(row.id,row.data);
    emit(col);
  }).subscribe(status=>{
    if(status==='SUBSCRIBED'){
      /* After a reconnect, reload everything so changes missed while offline show up. */
      if(subscribedOnce)Object.keys(cache).forEach(col=>loadCol(col).then(()=>emit(col),()=>{}));
      subscribedOnce=true;
    }
  });
}
function splitPath(p){const i=p.indexOf('/');return[p.slice(0,i),p.slice(i+1)]}

/* a write refused by the database rules (view-only account) is reported the way the app expects */
const denied=e=>e&&(e.code==='42501'||/row-level security/i.test(e.message||''))?{code:'invalid_argument',message:e.message}:e;
async function put(col,id,obj){
  const{error}=await sb.from('hris_docs').upsert({collection:col,id,data:obj,updated_at:new Date().toISOString(),updated_by:ME&&ME.id});
  if(error)throw denied(error);
  if(cache[col]){cache[col].set(id,obj);emit(col)}
}
async function del(col,id){
  const{data,error}=await sb.from('hris_docs').delete().eq('collection',col).eq('id',id).select('id');
  if(error)throw denied(error);
  if(!data||!data.length)throw{code:'invalid_argument'};
  if(cache[col]){cache[col].delete(id);emit(col)}
}
function docRef(col,id){return{
  set:obj=>put(col,id,JSON.parse(JSON.stringify(obj))),
  delete:()=>del(col,id),
  get:async()=>{await ensure(col);return docSnap(col,id)},
  onSnapshot(cb,onErr){
    const key=col+'/'+id,s={cb};(docSubs[key]=docSubs[key]||new Set()).add(s);startRealtime();
    ensure(col).then(()=>cb(docSnap(col,id)),e=>onErr&&onErr(e));
    return()=>docSubs[key].delete(s);
  }
}}
const db={
  collection:col=>({
    doc:id=>docRef(col,id),
    onSnapshot(cb,onErr){
      const s={cb};(colSubs[col]=colSubs[col]||new Set()).add(s);startRealtime();
      ensure(col).then(()=>cb(colSnap(col)),e=>onErr&&onErr(e));
      return()=>colSubs[col].delete(s);
    }
  }),
  doc:path=>{const[c,i]=splitPath(path);return docRef(c,i)}
};

/* ---------------- user ---------------- */
const user={
  me:async()=>({id:ME.id,name:ME.name,email:ME.email,role:ME.role,approver:ME.approver,access:ME.access}),
  /* re-reads the account from the server, so access changed in Settings reaches a HRIS that is already open */
  refresh:async()=>{
    const{data,error}=await sb.auth.getUser();
    if(error&&/bann/i.test(error.message||'')){await sb.auth.signOut();location.replace(redirectTo());return null}
    if(error||!data||!data.user)return null;
    const am=data.user.app_metadata||{};
    ME.role=['admin','staff','viewer'].includes(am.hris_role)?am.hris_role:'staff';ME.approver=am.approver||'';ME.access=am.hris_access||null;
    return user.me();
  },
  signOut,
  can:async what=>what==='data.write'?ME.role!=='viewer':what==='users.manage'?ME.role==='admin':true,
  /* Settings → User access: list, create, update, password, disable, enable (admins only, checked on the server) */
  admin:async body=>{
    const{data,error}=await sb.functions.invoke('hris-admin',{body});
    if(error){let m='';try{m=(await error.context.json()).error}catch(e){}throw{message:m||'Could not reach the server. Try again.'}}
    return data;
  },
  profiles:async ids=>{
    const out={};if(!ids||!ids.length)return out;
    const{data}=await sb.from('hris_profiles').select('id,name').in('id',ids.filter(x=>/^[0-9a-f-]{36}$/i.test(x)));
    (data||[]).forEach(p=>out[p.id]={name:p.name});return out;
  }
};

/* ---------------- assets: private file storage ---------------- */
const assets={
  upload:async(file,opts)=>{
    const type=(opts&&opts.type)||file.type;
    if(file.size>MAX_BYTES)throw{code:'too_large'};
    if(!type)throw{code:'unsupported_type'};
    const id=crypto.randomUUID().replace(/-/g,'');
    const{error}=await sb.storage.from(BUCKET).upload(id,file,{contentType:type,upsert:false});
    if(error){const m=String(error.message||'');throw{code:/size|large/i.test(m)?'too_large':/mime|type/i.test(m)?'unsupported_type':/rate/i.test(m)?'rate_limited':'store_unavailable',message:m}}
    return{id,contentType:type,sizeBytes:file.size};
  },
  delete:async id=>{const{error}=await sb.storage.from(BUCKET).remove([id]);if(error)throw error}
};

/* The app links files as /_blob/<id>. Swap those for short-lived signed URLs from the private bucket. */
const signed=new Map(); // id -> {url, exp}
const pending=new Map(); // id -> Promise
const SIGN_SECS=3600;
function signUrl(id){
  const c=signed.get(id);if(c&&c.exp>Date.now())return Promise.resolve(c.url);
  if(pending.has(id))return pending.get(id);
  const p=sb.storage.from(BUCKET).createSignedUrl(id,SIGN_SECS).then(({data,error})=>{pending.delete(id);if(error)throw error;
    signed.set(id,{url:data.signedUrl,exp:Date.now()+(SIGN_SECS-300)*1000});return data.signedUrl},e=>{pending.delete(id);throw e});
  pending.set(id,p);return p;
}
const BLOB=/^\/_blob\/([A-Za-z0-9_-]+)$/;
function fix(el){
  ['src','href'].forEach(a=>{const v=el.getAttribute&&el.getAttribute(a);const m=v&&BLOB.exec(v);if(!m)return;
    const c=signed.get(m[1]);if(c&&c.exp>Date.now()){el.setAttribute(a,c.url);return}
    if(a==='src')el.removeAttribute('src');el.dataset.blob=m[1];
    signUrl(m[1]).then(u=>el.setAttribute(a,u),()=>{});
  });
}
function scan(root){if(root.nodeType!==1)return;fix(root);root.querySelectorAll('[src^="/_blob/"],[href^="/_blob/"]').forEach(fix)}
new MutationObserver(ms=>ms.forEach(m=>{if(m.type==='attributes')fix(m.target);else m.addedNodes.forEach(scan)}))
  .observe(document.documentElement,{subtree:true,childList:true,attributes:true,attributeFilter:['src','href']});
/* A click on a file link before its signed URL is ready still opens the file. */
document.addEventListener('click',ev=>{
  const a=ev.target.closest&&ev.target.closest('a[href^="/_blob/"]');if(!a)return;
  const m=BLOB.exec(a.getAttribute('href'));if(!m)return;ev.preventDefault();
  const w=window.open('about:blank','_blank');signUrl(m[1]).then(u=>{if(w)w.location=u;else location.href=u},()=>{if(w)w.close();alert('This file could not be opened.')});
},true);

/* ---------------- downloads ---------------- */
const downloads={
  save:async({filename,data})=>{
    const url=URL.createObjectURL(data instanceof Blob?data:new Blob([data]));
    const a=document.createElement('a');a.href=url;a.download=filename||'download';document.body.appendChild(a);a.click();a.remove();
    setTimeout(()=>URL.revokeObjectURL(url),10000);
  }
};

const impl={db,user,assets,downloads};
window.claude={use:async name=>{await ready;if(!impl[name])throw{code:'capability_disabled'};return impl[name]}};
})();
