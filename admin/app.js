'use strict';

/* =====================================================================
   หน้าครู (4a): เข้าสู่ระบบ + คลังข้อสอบ + อัปโหลดรูป
   - เข้าสู่ระบบด้วย Supabase Auth (อีเมล + รหัสผ่าน) สิทธิ์ครูตรวจจากตาราง exam_admins
   - อ่านรายการข้อสอบผ่าน PostgREST (นโยบายให้เฉพาะครูเท่านั้น)
   - บันทึก/ลบข้อสอบผ่านฟังก์ชัน exam_admin_save_question / exam_admin_delete_question
     (ทำในทรานแซกชันเดียว พร้อมตรวจความถูกต้องที่ฐานข้อมูลอีกชั้น)
   - รูป: ย่อและแปลงเป็น webp ในเบราว์เซอร์ แล้วอัปโหลดไป bucket exam-images ด้วยชื่อสุ่ม
   ===================================================================== */

/* ---------- 1) ค่าตั้งต้น ---------- */
const SB_URL = 'https://apzntujfqhzadgejdpwf.supabase.co';
const SB_KEY = 'sb_publishable_6hPDr97QyuYA9gX8qCRYqw_cKQPhSGq';
const IMG_BUCKET = 'exam-images';
const AUTH_KEY = 'exam_admin_session';
const MINI_NAME = 'Mini Test';              // ชื่อที่แสดงของโหมดที่ในฐานข้อมูลเรียก arena
const MAX_STEM_W = 1000;                    // รูปโจทย์ กว้างสูงสุด (พิกเซล)
const MAX_CHOICE_W = 400;                   // รูปตัวเลือก กว้างสูงสุด
const MAX_BYTES = 480 * 1024;               // ขนาดไฟล์สูงสุด (bucket จำกัด 500 KB)
const PAGE = 100;                           // โหลดรายการทีละกี่ข้อ
const LETTERS = ['A', 'B', 'C', 'D', 'E', 'F'];
const POOL_LABEL = { practice: 'ฝึก', arena: MINI_NAME };
const TYPE_LABEL = { mcq: 'เลือกตอบ', numeric: 'กรอกตัวเลข' };

/* ---------- 2) ตัวช่วย ---------- */
function $(id) { return document.getElementById(id); }
function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

function h(tag, attrs) {
  const e = document.createElement(tag);
  if (attrs) {
    Object.keys(attrs).forEach(function (k) {
      const v = attrs[k];
      if (v === null || v === undefined || v === false) return;
      if (k === 'class') e.className = v;
      else if (k === 'text') e.textContent = v;
      else if (k.indexOf('on') === 0) e[k] = v;
      else if (v === true) e.setAttribute(k, '');
      else e.setAttribute(k, v);
    });
  }
  for (let i = 2; i < arguments.length; i++) appendKid(e, arguments[i]);
  return e;
}
function appendKid(parent, kid) {
  if (kid === null || kid === undefined || kid === false) return;
  if (Array.isArray(kid)) { kid.forEach(function (k) { appendKid(parent, k); }); return; }
  parent.appendChild(typeof kid === 'object' ? kid : document.createTextNode(String(kid)));
}
function btn(cls, text, onclick) { return h('button', { type: 'button', class: 'btn ' + cls, text: text, onclick: onclick }); }

function imageUrl(path) {
  return SB_URL + '/storage/v1/object/public/' + IMG_BUCKET + '/' + String(path).split('/').map(encodeURIComponent).join('/');
}
function renderMath(el) {
  if (typeof window.renderMathInElement !== 'function') return;
  try {
    window.renderMathInElement(el, {
      delimiters: [
        { left: '$$', right: '$$', display: true },
        { left: '\\(', right: '\\)', display: false },
        { left: '$', right: '$', display: false }
      ],
      throwOnError: false
    });
  } catch (e) { /* แสดงเป็นข้อความธรรมดา */ }
}
function snippet(text, n) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n) + '…' : s;
}

// อ่านค่าตัวเลขแบบเดียวกับฝั่งฐานข้อมูล (จำนวน / ทศนิยม / เศษส่วน) ใช้เตือนครูเท่านั้น ตัวตัดสินจริงอยู่ที่เซิร์ฟเวอร์
function parseNum(p) {
  const s = String(p === null || p === undefined ? '' : p).trim().replace(/\s*\/\s*/g, '/');
  if (!s || /\s/.test(s)) return null;
  if (/^[+-]?(\d+(\.\d*)?|\.\d+)$/.test(s)) return Math.round(Number(s) * 1e10) / 1e10;
  if (/^[+-]?\d+\/[+-]?\d+$/.test(s)) {
    const a = s.split('/');
    const den = Number(a[1]);
    if (den === 0) return null;
    return Math.round((Number(a[0]) / den) * 1e10) / 1e10;
  }
  return null;
}

/* ---------- 3) เข้าสู่ระบบ / เรียก API ---------- */
let SESS = null;   // { access_token, refresh_token, expires_at, user: { id, email } }

function normalizeSession(d) {
  const now = Math.floor(Date.now() / 1000);
  return {
    access_token: d.access_token,
    refresh_token: d.refresh_token,
    expires_at: d.expires_at || (now + Number(d.expires_in || 3600)),
    user: { id: d.user && d.user.id, email: d.user && d.user.email }
  };
}
function saveSession(s) { SESS = s; try { localStorage.setItem(AUTH_KEY, JSON.stringify(s)); } catch (e) { /* ไม่เป็นไร */ } }
function clearSession() { SESS = null; try { localStorage.removeItem(AUTH_KEY); } catch (e) { /* ไม่เป็นไร */ } }
function loadSession() {
  try {
    const s = JSON.parse(localStorage.getItem(AUTH_KEY) || 'null');
    if (s && s.access_token && s.refresh_token && s.user && s.user.id) return s;
  } catch (e) { /* ไม่มี session */ }
  return null;
}

async function authPost(path, body) {
  const r = await fetch(SB_URL + '/auth/v1/' + path, {
    method: 'POST', headers: { apikey: SB_KEY, 'Content-Type': 'application/json' }, body: JSON.stringify(body)
  });
  let data = null;
  try { data = await r.json(); } catch (e) { /* ไม่มีเนื้อหา */ }
  if (!r.ok) {
    const err = new Error((data && (data.error_description || data.msg || data.message)) || ('HTTP ' + r.status));
    err.status = r.status;
    throw err;
  }
  return data;
}

async function doLoginRequest(email, password) {
  const d = await authPost('token?grant_type=password', { email: email, password: password });
  saveSession(normalizeSession(d));
}

let refreshing = null;
async function getToken() {
  if (!SESS) throw new Error('SESSION_EXPIRED');
  const now = Math.floor(Date.now() / 1000);
  if (SESS.expires_at - now > 60) return SESS.access_token;
  if (!refreshing) {
    refreshing = authPost('token?grant_type=refresh_token', { refresh_token: SESS.refresh_token })
      .then(function (d) { saveSession(normalizeSession(d)); })
      .catch(function () { clearSession(); throw new Error('SESSION_EXPIRED'); })
      .then(function () { refreshing = null; }, function (e) { refreshing = null; throw e; });
  }
  await refreshing;
  return SESS.access_token;
}

async function api(method, path, body, extra) {
  const token = await getToken();
  const headers = { apikey: SB_KEY, Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' };
  if (extra) Object.keys(extra).forEach(function (k) { headers[k] = extra[k]; });
  const r = await fetch(SB_URL + '/rest/v1/' + path, {
    method: method, headers: headers, body: body === undefined ? undefined : JSON.stringify(body)
  });
  let data = null;
  try { data = await r.json(); } catch (e) { /* ไม่มีเนื้อหา */ }
  if (!r.ok) {
    const err = new Error((data && (data.message || data.error)) || ('HTTP ' + r.status));
    err.status = r.status;
    throw err;
  }
  return data;
}
function rpc(name, args) { return api('POST', 'rpc/' + name, args); }

function isAuthError(e) { return e && (e.message === 'SESSION_EXPIRED' || e.status === 401); }

/* ---------- 4) รูปภาพ: ย่อ + อัปโหลด ---------- */
function toBlob(canvas, type, quality) {
  return new Promise(function (resolve) { canvas.toBlob(function (b) { resolve(b); }, type, quality); });
}

async function shrinkImage(file, maxW) {
  let bmp;
  try { bmp = await createImageBitmap(file); }
  catch (e) { throw new Error('อ่านรูปนี้ไม่ได้ ใช้ไฟล์ JPG, PNG หรือ WebP'); }
  let w = Math.round(bmp.width * Math.min(1, maxW / bmp.width));
  let hh = Math.round(bmp.height * Math.min(1, maxW / bmp.width));
  const cv = document.createElement('canvas');
  const ctx = cv.getContext('2d');
  function draw() {
    cv.width = w; cv.height = hh;
    ctx.fillStyle = '#ffffff';              // พื้นขาว (รูป PNG โปร่งใสจะไม่กลายเป็นพื้นดำ)
    ctx.fillRect(0, 0, w, hh);
    ctx.drawImage(bmp, 0, 0, w, hh);
  }
  draw();
  let type = 'image/webp';
  let blob = await toBlob(cv, type, 0.85);
  if (!blob || blob.type !== 'image/webp') { type = 'image/jpeg'; blob = await toBlob(cv, type, 0.85); }
  let q = 0.85;
  while (blob && blob.size > MAX_BYTES && q > 0.45) { q -= 0.1; blob = await toBlob(cv, type, q); }
  while (blob && blob.size > MAX_BYTES && w > 200) {   // ยังใหญ่เกิน: ลดขนาดภาพลงทีละ 20%
    w = Math.round(w * 0.8); hh = Math.round(hh * 0.8); draw();
    blob = await toBlob(cv, type, 0.7);
  }
  if (!blob || blob.size > MAX_BYTES) throw new Error('รูปใหญ่เกินไป ลองใช้รูปที่เล็กลง');
  return blob;
}

function randomName() {
  const a = new Uint8Array(10);
  (window.crypto || self.crypto).getRandomValues(a);
  return Array.prototype.map.call(a, function (x) { return (x < 16 ? '0' : '') + x.toString(16); }).join('');
}

async function uploadImage(blob) {
  const token = await getToken();
  const name = randomName() + (blob.type === 'image/webp' ? '.webp' : blob.type === 'image/png' ? '.png' : '.jpg');
  const r = await fetch(SB_URL + '/storage/v1/object/' + IMG_BUCKET + '/' + name, {
    method: 'POST',
    headers: { apikey: SB_KEY, Authorization: 'Bearer ' + token, 'Content-Type': blob.type, 'x-upsert': 'false' },
    body: blob
  });
  if (!r.ok) {
    let msg = '';
    try { const d = await r.json(); msg = d.message || d.error || ''; } catch (e) { /* ไม่มีเนื้อหา */ }
    const err = new Error('อัปโหลดรูปไม่สำเร็จ' + (msg ? ': ' + msg : ''));
    err.status = r.status;
    throw err;
  }
  return name;
}

function imgEl(path) {
  const wrap = h('span', { class: 'imgbox loading' });
  const im = new Image();
  im.alt = '';
  im.onload = function () { wrap.classList.remove('loading'); wrap.classList.remove('err'); };
  im.onerror = function () { wrap.classList.remove('loading'); wrap.classList.add('err'); };
  wrap.onclick = function () {
    if (!wrap.classList.contains('err')) return;
    wrap.classList.remove('err'); wrap.classList.add('loading');
    im.src = imageUrl(path) + '?r=' + Date.now();
  };
  im.src = imageUrl(path);
  wrap.appendChild(im);
  return wrap;
}

/* ---------- ตำแหน่งรูปในโจทย์ ----------
   เขียนในโจทย์ได้ว่าจะให้รูปอยู่ตรงไหน:
     [[รูป]]                          วางรูปตรงนี้ (ขนาดกลาง)
     [[รูป เล็ก]]  [[รูป กลาง]]  [[รูป ใหญ่]]   เลือกขนาด
     [[รูป กลาง | Note: Figure not to scale.]]  มีคำบรรยายตัวหนาใต้รูป
   ถ้าไม่ใส่ [[รูป]] เลย ระบบวางรูปไว้ใต้ข้อความ (เหมือนเดิม) */
const STEM_TOKEN_SRC = '\\[\\[\\s*(?:รูป|img)([^\\]]*)\\]\\]';

function parseStemToken(rest) {
  const i = String(rest).indexOf('|');
  const head = (i >= 0 ? String(rest).slice(0, i) : String(rest)).toLowerCase();
  const caption = i >= 0 ? String(rest).slice(i + 1).trim() : '';
  const size = /เล็ก|small/.test(head) ? 's' : /ใหญ่|large/.test(head) ? 'l' : 'm';
  return { size: size, caption: caption };
}

function figureNode(path, size, caption) {
  return h('div', { class: 'fig ' + size },
    imgEl(path),
    caption ? h('div', { class: 'fig-cap', text: caption }) : null);
}

function stemNode(body, imagePath) {
  const wrap = h('div', { class: 'stem' });
  const text = String(body === null || body === undefined ? '' : body);
  const probe = new RegExp(STEM_TOKEN_SRC, 'i');
  const hasToken = probe.test(text);
  function addText(t, trimStart, trimEnd) {
    let s = t;
    if (trimStart) s = s.replace(/^\n+/, '');
    if (trimEnd) s = s.replace(/\n+$/, '');
    if (s.trim()) wrap.appendChild(h('div', { class: 'q-body', text: s }));
  }
  if (!imagePath || !hasToken) {
    // ไม่มีรูป หรือไม่ได้ระบุตำแหน่ง: ข้อความแล้วรูปใต้ข้อความ (เหมือนเดิม) และตัด [[รูป]] ที่ไม่มีรูปให้ออก
    addText(text.replace(new RegExp(STEM_TOKEN_SRC, 'ig'), ''), false, false);
    if (imagePath) wrap.appendChild(figureNode(imagePath, 'l', ''));
    return wrap;
  }
  const re = new RegExp(STEM_TOKEN_SRC, 'ig');
  let last = 0, m, placed = false;
  while ((m = re.exec(text)) !== null) {
    addText(text.slice(last, m.index), last > 0, true);
    if (!placed) {
      placed = true;
      const t = parseStemToken(m[1]);
      wrap.appendChild(figureNode(imagePath, t.size, t.caption));
    }
    last = re.lastIndex;
  }
  addText(text.slice(last), true, false);
  return wrap;
}

/* ---------- 5) ป๊อปอัป / ข้อความ ---------- */
let dlgLastFocus = null;
function showDialog(o) {
  const ov = $('dlg');
  if (!ov.classList.contains('open')) dlgLastFocus = document.activeElement;
  $('dlgTitle').textContent = o.title || '';
  $('dlgIcon').textContent = o.icon || '';
  $('dlgBody').textContent = o.message || '';
  const act = $('dlgActions');
  act.textContent = '';
  let first = null;
  (o.buttons || []).forEach(function (b, i) {
    const bt = btn(b.cls || 'primary', b.text, function () { closeDialog(); if (b.onClick) b.onClick(); });
    act.appendChild(bt);
    if (b.focus || (!first && i === 0)) first = bt;
  });
  ov.classList.add('open');
  if (first) first.focus();
}
function closeDialog() {
  $('dlg').classList.remove('open');
  try { if (dlgLastFocus && dlgLastFocus.focus) dlgLastFocus.focus(); } catch (e) { /* ไม่เป็นไร */ }
  dlgLastFocus = null;
}
function showBusy(text) {
  hideBusy();
  document.body.appendChild(h('div', { class: 'overlay-busy', id: 'busy', text: text }));
}
function hideBusy() { const o = $('busy'); if (o && o.parentNode) o.parentNode.removeChild(o); }

function mount(node, keepScroll) {
  const y = keepScroll ? (window.scrollY || window.pageYOffset || 0) : 0;
  const app = $('app');
  app.textContent = '';
  app.appendChild(node);
  window.scrollTo(0, y);
}

// จัดการ error ทั่วไป: ถ้า session หมดอายุให้กลับไปหน้า login
function handleErr(e, fallback) {
  if (isAuthError(e)) { clearSession(); showLogin('หมดเวลาการใช้งาน กรุณาเข้าสู่ระบบใหม่'); return true; }
  showDialog({ icon: '⚠️', title: fallback || 'เกิดข้อผิดพลาด', message: (e && e.message) || '', buttons: [{ text: 'ตกลง', cls: 'primary' }] });
  return false;
}

/* ---------- 6) หน้าเข้าสู่ระบบ ---------- */
function showLogin(msg) {
  const email = h('input', { type: 'email', autocomplete: 'username', placeholder: 'อีเมลครู', 'aria-label': 'อีเมล' });
  const pw = h('input', { type: 'password', autocomplete: 'current-password', placeholder: 'รหัสผ่าน', 'aria-label': 'รหัสผ่าน' });
  const err = h('div', { class: 'msgbox err', style: msg ? '' : 'display:none', text: msg || '' });
  const go = btn('primary block', 'เข้าสู่ระบบ', async function () {
    const e = email.value.trim();
    if (!e || !pw.value) { err.style.display = ''; err.textContent = 'กรุณากรอกอีเมลและรหัสผ่าน'; return; }
    go.disabled = true; go.textContent = 'กำลังตรวจสอบ...'; err.style.display = 'none';
    try {
      await doLoginRequest(e, pw.value);
      pw.value = '';
      await afterLogin();
    } catch (ex) {
      go.disabled = false; go.textContent = 'เข้าสู่ระบบ';
      err.style.display = '';
      err.textContent = ex.status === 400 || ex.status === 401 || /invalid/i.test(ex.message)
        ? 'อีเมลหรือรหัสผ่านไม่ถูกต้อง' : 'เข้าสู่ระบบไม่สำเร็จ: ' + ex.message;
    }
  });
  pw.onkeydown = function (ev) { if (ev.key === 'Enter') go.click(); };
  mount(h('div', { class: 'wrap' },
    h('div', { class: 'login' },
      h('h1', { text: 'หน้าครู' }),
      h('div', { class: 'hint', text: 'SAT Math Check Point — สำหรับครูที่ได้รับสิทธิ์เท่านั้น' }),
      email, pw, err, go)));
}

async function afterLogin() {
  showBusy('กำลังตรวจสอบสิทธิ์...');
  let ok = false;
  try {
    const rows = await api('GET', 'exam_admins?select=user_id&user_id=eq.' + encodeURIComponent(SESS.user.id));
    ok = rows && rows.length > 0;
  } catch (e) { hideBusy(); handleErr(e, 'ตรวจสอบสิทธิ์ไม่สำเร็จ'); return; }
  hideBusy();
  if (!ok) {
    mount(h('div', { class: 'wrap' }, h('div', { class: 'login' },
      h('h1', { text: 'ไม่มีสิทธิ์ครู' }),
      h('div', { class: 'msgbox err', text: 'บัญชีนี้ (' + SESS.user.email + ') ยังไม่ได้รับสิทธิ์ครู กรุณาติดต่อผู้ดูแลระบบ' }),
      btn('ghost block', 'ออกจากระบบ', logout))));
    return;
  }
  showList();
}

async function logout() {
  try {
    if (SESS) await fetch(SB_URL + '/auth/v1/logout', { method: 'POST', headers: { apikey: SB_KEY, Authorization: 'Bearer ' + SESS.access_token } });
  } catch (e) { /* ออกจากระบบฝั่งเครื่องอยู่ดี */ }
  clearSession();
  ED = null;
  showLogin('');
}

/* ---------- 7) โครงหน้า (หัว + แท็บ) ---------- */
function shell(active, children) {
  const tabs = h('div', { class: 'tabs' },
    h('button', { type: 'button', class: 'tab' + (active === 'bank' ? ' active' : ''), text: 'คลังข้อสอบ', onclick: function () { showList(); } }),
    h('button', { type: 'button', class: 'tab', text: 'ชุดข้อสอบ (เร็วๆ นี้)', disabled: true }),
    h('button', { type: 'button', class: 'tab', text: 'Season (เร็วๆ นี้)', disabled: true }));
  return h('div', { class: 'wrap' },
    h('div', { class: 'topbar' },
      h('div', { class: 'who', text: 'เข้าสู่ระบบ: ' + (SESS ? SESS.user.email : '') }),
      btn('ghost small', 'ออกจากระบบ', logout)),
    h('div', { class: 'title', text: 'หน้าครู' }),
    tabs, children);
}

/* ---------- 8) รายการข้อสอบ ---------- */
const L = { items: [], more: false, pool: 'arena', q: '', loading: false };   // pool: 'arena' = ข้อ Mini Test, 'practice' = ข้อฝึก (แยกแท็บ ไม่คละกัน)

async function fetchPage(offset) {
  return api('GET', 'exam_questions?select=id,pool,created_at,exam_question_versions(id,version_no,qtype,body,image_path,choices)' +
    '&pool=eq.' + encodeURIComponent(L.pool) +
    '&exam_question_versions.order=version_no.desc&order=id.desc&limit=' + PAGE + '&offset=' + offset);
}

async function showList() {
  ED = null;
  L.items = []; L.more = false;
  showBusy('กำลังโหลดคลังข้อสอบ...');
  try {
    const rows = await fetchPage(0);
    L.items = rows || [];
    L.more = (rows || []).length === PAGE;
  } catch (e) { hideBusy(); handleErr(e, 'โหลดรายการไม่สำเร็จ'); return; }
  hideBusy();
  renderList();
}

function latest(item) { return (item.exam_question_versions || [])[0] || null; }

function renderList() {
  const search = h('input', { type: 'search', placeholder: 'ค้นหาในโจทย์ หรือพิมพ์เลขข้อ', value: L.q, 'aria-label': 'ค้นหา' });
  search.oninput = function () { L.q = search.value; renderListBody(); };
  const seg = h('div', { class: 'seg', role: 'tablist' },
    h('button', { type: 'button', role: 'tab', class: 'seg-b' + (L.pool === 'arena' ? ' active' : ''), text: 'ข้อ ' + MINI_NAME,
      onclick: function () { if (L.pool !== 'arena') { L.pool = 'arena'; showList(); } } }),
    h('button', { type: 'button', role: 'tab', class: 'seg-b' + (L.pool === 'practice' ? ' active' : ''), text: 'ข้อฝึก',
      onclick: function () { if (L.pool !== 'practice') { L.pool = 'practice'; showList(); } } }));

  const body = h('div', { id: 'listBody' });
  const content = h('div', null,
    h('div', { class: 'toolbar' }, seg, search, h('span', { class: 'grow' }), btn('primary', '+ เพิ่มข้อใหม่', function () { openEditor(null); })),
    body);
  mount(shell('bank', content));
  renderListBody();
}

function renderListBody() {
  const body = $('listBody');
  if (!body) return;
  const q = L.q.trim().toLowerCase();
  const rows = L.items.filter(function (it) {
    if (L.pool && it.pool !== L.pool) return false;
    if (!q) return true;
    const v = latest(it);
    return String(it.id) === q || (v && String(v.body).toLowerCase().indexOf(q) >= 0);
  });
  body.textContent = '';
  if (!rows.length) {
    body.appendChild(h('div', { class: 'hint', style: 'margin:16px 4px', text: L.items.length ? 'ไม่พบข้อที่ตรงกับคำค้น (ค้นเฉพาะในแท็บนี้)' : 'ยังไม่มีข้อในกลุ่มนี้ กด "+ เพิ่มข้อใหม่" เพื่อเริ่ม' }));
  }
  rows.forEach(function (it) {
    const v = latest(it);
    const hasImg = v && (v.image_path || (v.choices || []).some(function (c) { return c.image_path; }));
    body.appendChild(h('div', { class: 'qitem' },
      h('div', { class: 'qid', text: '#' + it.id }),
      h('div', { class: 'qmain' },
        h('div', { class: 'qsnip', text: v ? snippet(v.body, 140) : '(ยังไม่มีเวอร์ชัน)' }),
        h('div', { class: 'qmeta' },
          h('span', { class: 'tag' + (it.pool === 'arena' ? ' mini' : ''), text: POOL_LABEL[it.pool] || it.pool }),
          v ? h('span', { class: 'tag gray', text: TYPE_LABEL[v.qtype] || v.qtype }) : null,
          v ? h('span', { class: 'tag gray', text: 'v' + v.version_no + (it.exam_question_versions.length > 1 ? ' (มี ' + it.exam_question_versions.length + ' เวอร์ชัน)' : '') }) : null,
          hasImg ? h('span', { class: 'tag gray', text: '🖼 มีรูป' }) : null)),
      h('div', { class: 'qact h' },
        btn('ghost small', 'แก้ไข', function () { openEditor(it.id); }),
        btn('ghost small', 'ลบ', function () { confirmDelete(it); }))));
  });
  if (L.more) {
    body.appendChild(h('div', { style: 'margin-top:14px;text-align:center' },
      btn('ghost', 'โหลดเพิ่ม', async function (ev) {
        const b = ev.currentTarget; b.disabled = true;
        try {
          const rows2 = await fetchPage(L.items.length);
          L.items = L.items.concat(rows2 || []);
          L.more = (rows2 || []).length === PAGE;
          renderListBody();
        } catch (e) { b.disabled = false; handleErr(e, 'โหลดเพิ่มไม่สำเร็จ'); }
      })));
  }
}

function confirmDelete(it) {
  const v = latest(it);
  showDialog({
    icon: '🗑️', title: 'ลบข้อสอบ',
    message: 'ลบข้อ #' + it.id + ' ทุกเวอร์ชันและเฉลย?\n' + (v ? snippet(v.body, 60) : '') +
      '\n\n(ลบได้เฉพาะข้อที่ยังไม่เคยอยู่ในชุดข้อสอบใดเลย)',
    buttons: [
      { text: 'ไม่ลบ', cls: 'ghost', focus: true },
      { text: 'ลบ', cls: 'danger', onClick: async function () {
        showBusy('กำลังลบ...');
        try { await rpc('exam_admin_delete_question', { p_question_id: it.id }); }
        catch (e) { hideBusy(); handleErr(e, 'ลบไม่สำเร็จ'); return; }
        hideBusy();
        L.items = L.items.filter(function (x) { return x.id !== it.id; });
        renderList();
      } }
    ]
  });
}

/* ---------- 9) ตัวแก้ไขข้อสอบ ---------- */
let ED = null;

function blankEd() {
  return {
    questionId: null, versionId: null, versions: [], pool: 'practice',
    qtype: 'mcq', body: '', imagePath: '',
    choices: LETTERS.slice(0, 4).map(function (l) { return { id: l, text: '', image_path: '' }; }),
    correctId: '', numAnswers: [''], explanation: '', source: '', note: '', dirty: false, msg: null
  };
}

function loadVersionInto(ed, ver) {
  const key = Array.isArray(ver.exam_answer_keys) ? ver.exam_answer_keys[0] : ver.exam_answer_keys;
  ed.versionId = ver.id;
  ed.qtype = ver.qtype;
  ed.body = ver.body || '';
  ed.imagePath = ver.image_path || '';
  ed.source = ver.source || '';
  ed.note = ver.note || '';
  ed.explanation = (key && key.explanation) || '';
  const correct = (key && key.correct) || [];
  if (ver.qtype === 'mcq') {
    const ch = (ver.choices || []).map(function (c) { return { id: c.id, text: c.text || '', image_path: c.image_path || '' }; });
    ed.choices = ch.length ? ch : blankEd().choices;
    ed.correctId = correct[0] || '';
    ed.numAnswers = [''];
  } else {
    ed.choices = blankEd().choices;
    ed.correctId = '';
    ed.numAnswers = correct.length ? correct.slice() : [''];
  }
  ed.dirty = false;
}

async function openEditor(questionId, versionId, msg) {
  if (questionId === null || questionId === undefined) {
    ED = blankEd();
    renderEditor();
    return;
  }
  showBusy('กำลังโหลดข้อสอบ...');
  let rows;
  try {
    rows = await api('GET', 'exam_questions?id=eq.' + encodeURIComponent(questionId) +
      '&select=id,pool,exam_question_versions(id,version_no,qtype,body,choices,image_path,source,note,exam_answer_keys(correct,explanation))' +
      '&exam_question_versions.order=version_no.desc');
  } catch (e) { hideBusy(); handleErr(e, 'โหลดข้อสอบไม่สำเร็จ'); return; }
  hideBusy();
  if (!rows || !rows.length) { handleErr(new Error('ไม่พบข้อสอบนี้'), 'โหลดข้อสอบไม่สำเร็จ'); return; }
  const q = rows[0];
  const ed = blankEd();
  ed.questionId = q.id;
  ed.pool = q.pool;
  ed.versions = q.exam_question_versions || [];
  const ver = ed.versions.filter(function (v) { return v.id === versionId; })[0] || ed.versions[0];
  if (ver) loadVersionInto(ed, ver);
  ed.msg = msg || null;
  ED = ed;
  renderEditor();
}

function markDirty() { if (ED) ED.dirty = true; }

let pvTimer = 0;
function schedulePreview() { clearTimeout(pvTimer); pvTimer = setTimeout(refreshPreview, 180); }

function setMsg(text, cls) {
  const m = $('edMsg');
  if (!m) return;
  m.className = text ? 'msgbox ' + (cls || 'info') : '';
  m.textContent = text || '';
}

function field(label, control, hint) {
  return h('div', { class: 'field' }, h('label', { class: 'lb', text: label }), control, hint ? h('div', { class: 'hint', text: hint }) : null);
}

function textInput(value, onInput, ph) {
  const i = h('input', { type: 'text', value: value || '', placeholder: ph || '' });
  i.oninput = function () { onInput(i.value); markDirty(); schedulePreview(); };
  return i;
}

function imageControl(path, maxW, onChange) {
  const pick = h('label', { class: 'btn ghost small filebtn' }, path ? 'เปลี่ยนรูป' : 'เลือกรูป',
    h('input', { type: 'file', accept: 'image/*', style: 'display:none', onchange: function (ev) {
      const f = ev.target.files && ev.target.files[0];
      ev.target.value = '';
      if (f) pickAndUpload(f, maxW, onChange);
    } }));
  return h('div', { class: 'imgrow' },
    path ? h('img', { class: 'thumb', src: imageUrl(path), alt: '' }) : null,
    pick,
    path ? btn('ghost small', 'เอารูปออก', function () { onChange(''); }) : null,
    h('span', { class: 'hint', text: path ? '' : 'ระบบย่อและแปลงเป็น webp ให้อัตโนมัติ' }));
}

async function pickAndUpload(file, maxW, onChange) {
  showBusy('กำลังย่อและอัปโหลดรูป...');
  try {
    const blob = await shrinkImage(file, maxW);
    const name = await uploadImage(blob);
    hideBusy();
    onChange(name);
  } catch (e) {
    hideBusy();
    handleErr(e, 'อัปโหลดรูปไม่สำเร็จ');
  }
}

function renderEditor() {
  const ed = ED;
  const isNew = ed.questionId === null;
  const curVer = ed.versions.filter(function (v) { return v.id === ed.versionId; })[0];
  const maxNo = ed.versions.reduce(function (m, v) { return Math.max(m, v.version_no); }, 0);

  // --- กลุ่ม ---
  let poolBox;
  if (isNew) {
    const mk = function (val, title, sub) {
      const r = h('input', { type: 'radio', name: 'pool', value: val });
      r.checked = ed.pool === val;
      r.onchange = function () { ed.pool = val; markDirty(); };
      return h('label', { class: 'pool-opt' }, r, h('span', null, title, h('small', { text: sub })));
    };
    poolBox = h('div', null,
      h('div', { class: 'pools' },
        mk('practice', 'ข้อฝึก', 'ใช้ในชุดโหมดฝึก'),
        mk('arena', 'ข้อ ' + MINI_NAME, 'ใช้ในชุด ' + MINI_NAME + ' ของ season')),
      h('div', { class: 'hint', style: 'margin-top:6px', text: '⚠ เลือกแล้วเปลี่ยนทีหลังไม่ได้ (ข้อ ' + MINI_NAME + ' ห้ามย้ายไปเป็นข้อฝึก)' }));
  } else {
    poolBox = h('div', null,
      h('span', { class: 'tag' + (ed.pool === 'arena' ? ' mini' : ''), text: 'กลุ่ม: ' + (POOL_LABEL[ed.pool] || ed.pool) }),
      h('span', { class: 'hint', text: '  (เปลี่ยนไม่ได้)  ข้อ #' + ed.questionId }));
  }

  // --- เวอร์ชัน ---
  let verBox = null;
  if (!isNew && ed.versions.length) {
    const vs = h('select', { 'aria-label': 'เวอร์ชัน' }, ed.versions.map(function (v) {
      return h('option', { value: String(v.id), text: 'เวอร์ชัน ' + v.version_no + (v.version_no === maxNo ? ' (ล่าสุด)' : '') });
    }));
    vs.value = String(ed.versionId);
    vs.onchange = function () {
      const target = ed.versions.filter(function (v) { return String(v.id) === vs.value; })[0];
      const go = function () { loadVersionInto(ed, target); renderEditor(); };
      if (ed.dirty) {
        showDialog({ icon: '❓', title: 'ยังไม่ได้บันทึก', message: 'การแก้ไขที่ยังไม่บันทึกจะหายไป ต้องการสลับเวอร์ชันไหม?',
          buttons: [{ text: 'ไม่สลับ', cls: 'ghost', focus: true, onClick: function () { vs.value = String(ed.versionId); } },
                    { text: 'สลับ', cls: 'primary', onClick: go }] });
      } else { go(); }
    };
    verBox = field('เวอร์ชันที่กำลังแก้', vs);
  }

  // --- ประเภท ---
  const typeSel = h('select', { 'aria-label': 'ประเภท' },
    h('option', { value: 'mcq', text: 'เลือกตอบ (A ถึง D)' }),
    h('option', { value: 'numeric', text: 'กรอกตัวเลข' }));
  typeSel.value = ed.qtype;
  typeSel.onchange = function () { ed.qtype = typeSel.value; markDirty(); renderEditor(); };

  // --- โจทย์ ---
  const bodyTa = h('textarea', { placeholder: 'พิมพ์โจทย์ ใช้ $x^2$ สำหรับสูตรในบรรทัด และ $$...$$ สำหรับสูตรกลางบรรทัดใหม่' });
  bodyTa.value = ed.body;
  bodyTa.oninput = function () { ed.body = bodyTa.value; markDirty(); schedulePreview(); };

  const stemImg = imageControl(ed.imagePath, MAX_STEM_W, function (name) { ed.imagePath = name; markDirty(); renderEditor(); });

  // --- ตัวเลือก / เฉลยตัวเลข ---
  let answerCard;
  if (ed.qtype === 'mcq') {
    const nSel = h('select', { 'aria-label': 'จำนวนตัวเลือก' }, [2, 3, 4, 5, 6].map(function (n) { return h('option', { value: String(n), text: n + ' ตัวเลือก' }); }));
    nSel.value = String(ed.choices.length);
    nSel.onchange = function () {
      const n = Number(nSel.value);
      while (ed.choices.length < n) ed.choices.push({ id: LETTERS[ed.choices.length], text: '', image_path: '' });
      if (ed.choices.length > n) {
        ed.choices = ed.choices.slice(0, n);
        if (!ed.choices.some(function (c) { return c.id === ed.correctId; })) ed.correctId = '';
      }
      markDirty(); renderEditor();
    };
    answerCard = h('div', { class: 'card' },
      h('h3', { text: 'ตัวเลือกและเฉลย' }),
      h('div', { class: 'field' }, nSel),
      ed.choices.map(function (c) {
        const radio = h('input', { type: 'radio', name: 'correct', value: c.id });
        radio.checked = ed.correctId === c.id;
        radio.onchange = function () { ed.correctId = c.id; markDirty(); renderEditor(); };
        return h('div', { class: 'crow' + (ed.correctId === c.id ? ' ok' : '') },
          h('div', { class: 'letter', text: c.id }),
          h('div', { class: 'cbody' },
            textInput(c.text, function (v) { c.text = v; }, 'ข้อความตัวเลือก (ถ้าเป็นรูปล้วนเว้นว่างได้)'),
            imageControl(c.image_path, MAX_CHOICE_W, function (name) { c.image_path = name; markDirty(); renderEditor(); }),
            h('label', { class: 'okpick' }, radio, 'ตัวเลือกนี้คือเฉลย')));
      }));
  } else {
    answerCard = h('div', { class: 'card' },
      h('h3', { text: 'เฉลย (ค่าที่ยอมรับได้)' }),
      h('div', { class: 'hint', text: 'ใส่ทุกรูปแบบที่ยอมรับ เช่น 1/2 และ 0.5 ระบบเทียบค่าให้ (1/2 = 0.5 = .5 = 2/4) แต่ไม่ปัดเศษเอง ถ้าตอบทศนิยมได้หลายแบบ เช่น 0.833 กับ 0.8333 ให้ใส่ทุกค่า' }),
      ed.numAnswers.map(function (a, i) {
        const inp = h('input', { type: 'text', value: a, placeholder: 'เช่น 1/2', maxlength: '20' });
        const val = h('span', { class: 'val' });
        const show = function () {
          const p = parseNum(inp.value);
          val.className = 'val' + (inp.value.trim() && p === null ? ' bad' : '');
          val.textContent = !inp.value.trim() ? '' : (p === null ? 'อ่านค่าไม่ได้' : '= ' + p);
        };
        inp.oninput = function () { ed.numAnswers[i] = inp.value; show(); markDirty(); schedulePreview(); };
        show();
        return h('div', { class: 'arow' }, inp, val,
          ed.numAnswers.length > 1 ? btn('ghost small', 'ลบ', function () { ed.numAnswers.splice(i, 1); markDirty(); renderEditor(); }) : null);
      }),
      h('div', { style: 'margin-top:10px' }, btn('ghost small', '+ เพิ่มค่าที่ยอมรับ', function () { ed.numAnswers.push(''); markDirty(); renderEditor(); })));
  }

  // --- คำอธิบาย / แหล่งที่มา / หมายเหตุ ---
  const explTa = h('textarea', { placeholder: 'คำอธิบายเฉลย (นักเรียนเห็นหลังส่งข้อสอบ ใช้สูตร KaTeX ได้)' });
  explTa.value = ed.explanation;
  explTa.oninput = function () { ed.explanation = explTa.value; markDirty(); schedulePreview(); };

  // --- ปุ่มบันทึก ---
  const saveBar = h('div', { class: 'savebar' });
  if (isNew) {
    saveBar.appendChild(btn('primary', 'บันทึกข้อสอบ', function () { save(false); }));
  } else {
    saveBar.appendChild(btn('primary', 'บันทึกแก้เล็กน้อย (คงเวอร์ชัน ' + (curVer ? curVer.version_no : '') + ')', function () { save(false); }));
    saveBar.appendChild(btn('ghost', 'บันทึกเป็นเวอร์ชันใหม่ (v' + (maxNo + 1) + ')', function () { save(true); }));
  }

  const left = h('div', null,
    h('div', { class: 'card' },
      h('h3', { text: isNew ? 'ข้อใหม่' : 'แก้ข้อ #' + ed.questionId }),
      field('กลุ่มของข้อ', poolBox),
      verBox,
      field('ประเภท', typeSel),
          h('div', { class: 'field' },
        h('label', { class: 'lb', text: 'โจทย์' }), bodyTa,
        h('div', { class: 'imgrow' },
          btn('ghost small', 'แทรกตำแหน่งรูป [[รูป]]', function () { insertAtCursor(bodyTa, '[[รูป]]'); }),
          h('span', { class: 'hint', id: 'stemWarn' })),
        h('details', { class: 'help' },
          h('summary', { text: 'วิธีวางรูปและคำบรรยายในโจทย์' }),
          h('div', { class: 'hint', text: 'พิมพ์ [[รูป]] ตรงที่อยากให้รูปอยู่ จะมีข้อความเหนือรูป ใต้รูป หรือทั้งสองด้านก็ได้ ถ้าไม่พิมพ์ รูปจะอยู่ใต้ข้อความ' }),
          h('pre', { class: 'syn', text:
            'ข้อความที่อยู่เหนือรูป\n[[รูป]]\nข้อความที่อยู่ใต้รูป\n\n' +
            '[[รูป เล็ก]]   [[รูป กลาง]]   [[รูป ใหญ่]]   ← เลือกขนาด (ไม่ระบุ = กลาง)\n\n' +
            '[[รูป กลาง | Note: Figure not to scale.]]\n' +
            '           ↑ ข้อความหลังเครื่องหมาย | = คำบรรยายตัวหนา กึ่งกลาง ใต้รูป' }),
          h('div', { class: 'hint', text: 'ใช้ [[รูป]] ได้ครั้งเดียวต่อข้อ (รูปประกอบโจทย์มีรูปเดียว) สูตร KaTeX ใช้ได้ทั้งในข้อความและคำบรรยาย' }))),
      field('รูปประกอบโจทย์ (ไม่บังคับ)', stemImg)),
    answerCard,
    h('div', { class: 'card' },
      field('คำอธิบายเฉลย (ไม่บังคับ)', explTa),
      field('แหล่งที่มา (ครูเท่านั้น)', textInput(ed.source, function (v) { ed.source = v; })),
      field('หมายเหตุ (ครูเท่านั้น)', textInput(ed.note, function (v) { ed.note = v; }))),
    h('div', { id: 'edMsg' }),
    saveBar,
    isNew ? null : h('div', { class: 'hint', style: 'margin-top:8px', text:
      'แก้เล็กน้อย = แก้คำผิด/เฉลยผิด ชุดที่ใช้ข้อนี้อยู่จะได้รับการแก้ด้วย • เวอร์ชันใหม่ = แก้เนื้อหาจริง ชุดที่มีอยู่ยังใช้เวอร์ชันเดิม ต้องไปเลือกเวอร์ชันใหม่ในชุดเอง' }));

  const right = h('div', { class: 'preview' },
    h('div', { class: 'card' },
      h('div', { class: 'pv-note', text: 'ตัวอย่างที่นักเรียนเห็น (สีเขียว = เฉลย เห็นเฉพาะครู)' }),
      h('div', { id: 'pvBox' })));

  const back = btn('ghost small', '‹ กลับคลังข้อสอบ', function () {
    if (ED && ED.dirty) {
      showDialog({ icon: '❓', title: 'ยังไม่ได้บันทึก', message: 'การแก้ไขที่ยังไม่บันทึกจะหายไป ต้องการออกไหม?',
        buttons: [{ text: 'อยู่ต่อ', cls: 'ghost', focus: true }, { text: 'ออก', cls: 'danger', onClick: function () { ED.dirty = false; showList(); } }] });
    } else { showList(); }
  });

  const root = h('div', { class: 'wrap wide' },
    h('div', { class: 'topbar' }, back,
      h('div', { class: 'who', text: 'เข้าสู่ระบบ: ' + (SESS ? SESS.user.email : '') })),
    h('div', { class: 'ed-grid' }, left, right));
  mount(root, !!ed.rendered);   // แก้ต่อเนื่อง (เช่น หลังอัปโหลดรูป) ไม่เด้งกลับไปบนสุด
  ed.rendered = true;
  if (ed.msg) { setMsg(ed.msg.text, ed.msg.cls); ed.msg = null; }
  refreshPreview();
}

function insertAtCursor(ta, str) {
  const v = ta.value;
  const a = typeof ta.selectionStart === 'number' ? ta.selectionStart : v.length;
  const b = typeof ta.selectionEnd === 'number' ? ta.selectionEnd : a;
  ta.value = v.slice(0, a) + str + v.slice(b);
  if (ta.setSelectionRange) ta.setSelectionRange(a + str.length, a + str.length);
  if (ta.focus) ta.focus();
  ta.oninput();
}

function updateStemWarn() {
  const w = $('stemWarn');
  if (!w || !ED) return;
  const n = (ED.body.match(new RegExp(STEM_TOKEN_SRC, 'ig')) || []).length;
  let t = '';
  if (n > 0 && !ED.imagePath) t = '⚠ มี [[รูป]] ในโจทย์ แต่ยังไม่ได้อัปโหลดรูป';
  else if (n > 1) t = '⚠ ใช้ [[รูป]] ได้ครั้งเดียว ตัวที่สองเป็นต้นไปจะไม่แสดงรูป';
  w.textContent = t;
}

function refreshPreview() {
  const box = $('pvBox');
  if (!box || !ED) return;
  const ed = ED;
  updateStemWarn();
  box.textContent = '';
  box.appendChild(stemNode(ed.body || '(ยังไม่ได้พิมพ์โจทย์)', ed.imagePath));
  if (ed.qtype === 'mcq') {
    const grid = ed.choices.some(function (c) { return c.image_path; });
    box.appendChild(h('div', { class: 'choices' + (grid ? ' grid' : '') }, ed.choices.map(function (c) {
      const good = ed.correctId === c.id;
      return h('div', { class: 'choice' + (good ? ' good' : '') },
        h('span', { class: 'letter', text: c.id }),
        h('span', { class: 'ctext' },
          c.text ? h('span', { text: c.text }) : null,
          c.image_path ? imgEl(c.image_path) : null,
          good ? h('span', { class: 'ck', text: '✓ เฉลย' }) : null));
    })));
  } else {
    const ans = ed.numAnswers.map(function (a) { return a.trim(); }).filter(Boolean);
    box.appendChild(h('div', { class: 'numpv' },
      h('div', { text: 'นักเรียนพิมพ์คำตอบเป็นตัวเลขหรือเศษส่วน' }),
      h('div', { text: 'เฉลย: ' + (ans.length ? ans.join('  หรือ  ') : '(ยังไม่ได้ใส่)') })));
  }
  if (ed.explanation.trim()) {
    box.appendChild(h('div', { class: 'expl' }, h('b', { text: 'คำอธิบาย' }), h('div', { text: ed.explanation })));
  }
  renderMath(box);
}

function validateEd() {
  const ed = ED;
  if (ed.questionId === null && ed.pool !== 'practice' && ed.pool !== 'arena') return 'กรุณาเลือกกลุ่มของข้อ (ฝึก หรือ ' + MINI_NAME + ')';
  if (!ed.body.trim()) return 'กรุณาพิมพ์โจทย์';
  if (ed.qtype === 'mcq') {
    for (let i = 0; i < ed.choices.length; i++) {
      const c = ed.choices[i];
      if (!c.text.trim() && !c.image_path) return 'ตัวเลือก ' + c.id + ' ยังว่าง ต้องมีข้อความหรือรูปอย่างน้อยหนึ่งอย่าง';
    }
    if (!ed.correctId) return 'กรุณาเลือกว่าตัวเลือกไหนคือเฉลย';
  } else {
    const ans = ed.numAnswers.map(function (a) { return a.trim(); }).filter(Boolean);
    if (!ans.length) return 'กรุณาใส่เฉลยอย่างน้อย 1 ค่า';
    for (let i = 0; i < ans.length; i++) {
      if (parseNum(ans[i]) === null) return 'เฉลย "' + ans[i] + '" อ่านค่าไม่ได้ (ใช้จำนวน ทศนิยม หรือเศษส่วน เช่น 12, 0.5, 1/2)';
    }
  }
  return '';
}

function savePayload(newVersion) {
  const ed = ED;
  const correct = ed.qtype === 'mcq'
    ? [ed.correctId]
    : ed.numAnswers.map(function (a) { return a.trim(); }).filter(Boolean);
  return {
    p_question_id: ed.questionId,
    p_version_id: ed.versionId,
    p_new_version: !!newVersion,
    p_pool: ed.questionId === null ? ed.pool : null,
    p_qtype: ed.qtype,
    p_body: ed.body.trim(),
    p_choices: ed.qtype === 'mcq'
      ? ed.choices.map(function (c) {
          const o = { id: c.id, text: c.text.trim() };
          if (c.image_path) o.image_path = c.image_path;
          return o;
        })
      : null,
    p_image_path: ed.imagePath || null,
    p_source: ed.source.trim() || null,
    p_note: ed.note.trim() || null,
    p_correct: correct,
    p_explanation: ed.explanation.trim() || null
  };
}

async function save(newVersion) {
  const err = validateEd();
  if (err) { setMsg(err, 'err'); return; }
  setMsg('');
  showBusy('กำลังบันทึก...');
  let res;
  try { res = await rpc('exam_admin_save_question', savePayload(newVersion)); }
  catch (e) {
    hideBusy();
    if (isAuthError(e)) { handleErr(e); return; }
    setMsg('บันทึกไม่สำเร็จ: ' + e.message, 'err');
    return;
  }
  hideBusy();
  ED.dirty = false;
  // จำรหัสที่ได้ไว้ก่อน: ถ้าโหลดซ้ำไม่สำเร็จ การกดบันทึกอีกครั้งจะแก้ข้อเดิม ไม่สร้างข้อซ้ำ
  const wasNew = ED.questionId === null;
  if (wasNew) ED.questionId = res.question_id;
  ED.versionId = res.version_id;
  const text = newVersion ? 'บันทึกเป็นเวอร์ชันใหม่แล้ว' : (wasNew ? 'บันทึกข้อใหม่แล้ว (#' + res.question_id + ')' : 'บันทึกแล้ว');
  openEditor(res.question_id, res.version_id, { text: text, cls: 'ok' });
}

window.addEventListener('beforeunload', function (e) {
  if (ED && ED.dirty) { e.preventDefault(); e.returnValue = ''; }
});
$('dlg').addEventListener('click', function (e) { if (e.target === $('dlg')) closeDialog(); });
document.addEventListener('keydown', function (e) {
  if (e.key === 'Escape' && $('dlg').classList.contains('open')) closeDialog();
});

/* ---------- 10) เริ่มทำงาน ---------- */
(function boot() {
  const s = loadSession();
  if (!s) { showLogin(''); return; }
  SESS = s;
  afterLogin();
})();
