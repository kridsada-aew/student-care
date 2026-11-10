'use strict';

/* =====================================================================
   หน้าสอบของนักเรียน (HTML ล้วน) — ขั้น 2
   - ตัวตนนักเรียน: ใช้ token จากการ login หน้าเดิม (sessionStorage 'ignite_session')
   - ทุกอย่างผ่านฟังก์ชัน Supabase: exam_list_sets / exam_start_attempt /
     exam_get_exam / exam_log_event / exam_submit_attempt
   - ไม่เก็บเฉลย ไม่ตัดสินเวลาในเบราว์เซอร์ นาฬิกาที่เห็นเป็นแค่การแสดงผล
     เวลาจริงตัดสินที่เซิร์ฟเวอร์ (ปรับให้ตรงเซิร์ฟเวอร์ทุกครั้งที่ตอบกลับ)
   ===================================================================== */

/* ---------- 1) ค่าตั้งต้น ---------- */
const SB_URL = 'https://apzntujfqhzadgejdpwf.supabase.co';
const SB_KEY = 'sb_publishable_6hPDr97QyuYA9gX8qCRYqw_cKQPhSGq';
const IMG_BUCKET = 'exam-images';          // bucket แบบ Public ใน Supabase Storage
const SESSION_KEY = 'ignite_session';      // key เดียวกับหน้าเดิม
const HOME_URL = '../';                    // หน้าหลักเดิม
const DESMOS_URL = 'https://www.desmos.com/calculator';
const WARN_SECONDS = 300;                  // เหลือ 5 นาที: เตือนสีเหลือง
const DANGER_SECONDS = 60;                 // เหลือ 1 นาที: เตือนสีแดง
const NUM_DEBOUNCE_MS = 700;               // ช่องกรอกตัวเลข: รอพิมพ์เสร็จก่อนบันทึก
const PRELOAD_CONCURRENCY = 3;

/* ---------- 2) ตัวช่วย ---------- */
function $(id) { return document.getElementById(id); }
function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
function pad2(n) { return (n < 10 ? '0' : '') + n; }

// สร้าง element (ข้อความใส่ผ่าน textContent เท่านั้น ไม่ใช้ innerHTML)
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

function fmtClock(sec) {
  sec = Math.max(0, Math.floor(sec));
  return pad2(Math.floor(sec / 60)) + ':' + pad2(sec % 60);
}
function fmtDateTime(iso) {
  try {
    return new Date(iso).toLocaleString('th-TH', {
      timeZone: 'Asia/Bangkok', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit'
    });
  } catch (e) { return ''; }
}
function imageUrl(path) {
  return SB_URL + '/storage/v1/object/public/' + IMG_BUCKET + '/' +
    String(path).split('/').map(encodeURIComponent).join('/');
}

/* ---------- 3) เรียก Supabase ---------- */
async function rpc(name, body) {
  const headers = { 'Content-Type': 'application/json', apikey: SB_KEY };
  if (/^eyJ/.test(SB_KEY)) headers.Authorization = 'Bearer ' + SB_KEY;
  const r = await fetch(SB_URL + '/rest/v1/rpc/' + name, {
    method: 'POST', headers: headers, body: JSON.stringify(body)
  });
  let data = null;
  try { data = await r.json(); } catch (e) { /* ไม่มีเนื้อหา */ }
  if (!r.ok) {
    const err = new Error((data && data.message) || ('HTTP ' + r.status));
    err.status = r.status;
    throw err;
  }
  return data;
}
function isRetryable(err) { return !err.status || err.status >= 500 || err.status === 429; }

// ลองซ้ำเมื่อเน็ตหรือเซิร์ฟเวอร์ล้มเหลวชั่วคราว
async function rpcRetry(name, body, tries) {
  let last;
  for (let i = 0; i < (tries || 3); i++) {
    try { return await rpc(name, body); }
    catch (e) {
      last = e;
      if (!isRetryable(e)) throw e;
      await sleep(800 * (i + 1));
    }
  }
  throw last;
}

/* ---------- 4) สถานะ ---------- */
const S = { token: '', name: '' };   // ตัวตน (จาก session หน้าเดิม)
let E = null;                         // สถานะของการสอบที่กำลังทำ (null = ไม่ได้สอบอยู่)

function newExamState(attemptId) {
  return {
    attemptId: attemptId, mode: '', attemptNo: 1, setName: '',
    q: [], i: 0, answers: {}, marked: {},
    deadline: 0,
    locked: false,   // ผู้ใช้กดส่งแล้ว: ห้ามแก้
    ended: false,    // จบแล้ว: หยุดส่ง event
    queue: [], flushing: false, online: true,
    timerId: 0, numTimer: 0, pendingNum: null
  };
}

/* ---------- 5) การแสดงผลทั่วไป ---------- */
function mount() {
  const app = $('app');
  app.textContent = '';
  for (let i = 0; i < arguments.length; i++) app.appendChild(arguments[i]);
  document.body.classList.remove('in-exam');
  window.scrollTo(0, 0);
}
function screenMessage(icon, title, text, buttons) {
  mount(h('div', { class: 'wrap' },
    h('div', { class: 'center-screen' },
      h('div', { class: 'big', text: icon }),
      h('h2', { text: title }),
      h('p', { text: text || '' }),
      buttons || [])));
}
function btn(cls, text, onclick) {
  return h('button', { type: 'button', class: 'btn ' + cls, text: text, onclick: onclick });
}
function homeLink(text) {
  return h('a', { class: 'btn ghost', href: HOME_URL, text: text || 'กลับหน้าหลัก' });
}
function showLoading(text) {
  screenMessage('⏳', text || 'กำลังโหลด...', '');
}
function showError(title, text, retryFn) {
  screenMessage('⚠️', title, text,
    [retryFn ? btn('primary', 'ลองใหม่', retryFn) : null, h('div', { style: 'height:8px' }), homeLink()]);
}
function showExpired() {
  stopTimer();
  if (E) E.ended = true;
  screenMessage('🔒', 'หมดเวลาการใช้งาน',
    'กรุณาเข้าสู่ระบบใหม่ที่หน้าหลัก แล้วกลับมาทำข้อสอบต่อ',
    [h('a', { class: 'btn primary', href: HOME_URL, text: 'ไปหน้าเข้าสู่ระบบ' })]);
}

// ป๊อปอัป
let dlgLastFocus = null;
function showDialog(o) {
  const ov = $('dlg');
  if (!ov.classList.contains('open')) dlgLastFocus = document.activeElement;
  $('dlgTitle').textContent = o.title || '';
  $('dlgIcon').textContent = o.icon || '';
  const body = $('dlgBody');
  body.textContent = '';
  if (o.message) body.appendChild(h('div', { text: o.message }));
  if (o.lines && o.lines.length) {
    body.appendChild(h('div', { class: 'dlg-list' }, o.lines.map(function (t) { return h('span', { text: t }); })));
  }
  if (o.note) body.appendChild(h('div', { class: 'dlg-note', text: o.note }));
  const act = $('dlgActions');
  act.textContent = '';
  let first = null;
  (o.buttons || []).forEach(function (b, i) {
    const bt = btn(b.cls || 'primary', b.text, function () {
      closeDialog();
      if (b.onClick) b.onClick();
    });
    act.appendChild(bt);
    if (b.focus || (!first && i === 0)) first = bt;
  });
  ov.classList.add('open');
  if (first) first.focus();
}
function closeDialog() {
  const ov = $('dlg');
  ov.classList.remove('open');
  try { if (dlgLastFocus && dlgLastFocus.focus) dlgLastFocus.focus(); } catch (e) { /* ไม่เป็นไร */ }
  dlgLastFocus = null;
}
function showBusy(text) {
  hideBusy();
  const o = h('div', { class: 'overlay-busy', id: 'busy', text: text });
  document.body.appendChild(o);
}
function hideBusy() {
  const o = $('busy');
  if (o) o.parentNode.removeChild(o);
}

// KaTeX: ถ้า CDN โหลดไม่ขึ้น ก็แสดงเป็นข้อความธรรมดา ไม่ให้หน้าพัง
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

/* ---------- 6) เริ่มต้น ---------- */
function readSession() {
  try {
    const s = JSON.parse(sessionStorage.getItem(SESSION_KEY) || 'null');
    if (s && s.token && s.name) return s;
  } catch (e) { /* ไม่มี session */ }
  return null;
}

function boot() {
  const s = readSession();
  if (!s) {
    screenMessage('🔑', 'ยังไม่ได้เข้าสู่ระบบ',
      'กรุณาเข้าสู่ระบบที่หน้าหลักก่อน แล้วกดปุ่ม "ไปทำข้อสอบ" ในหน้าเดิมของแท็บนี้',
      [h('a', { class: 'btn primary', href: HOME_URL, text: 'ไปหน้าเข้าสู่ระบบ' })]);
    return;
  }
  S.token = s.token;
  S.name = s.name;
  const m = /^#\/a\/(\d+)$/.exec(location.hash);
  if (m) loadExam(Number(m[1])); else showList();
}

/* ---------- 7) รายการชุดข้อสอบ ---------- */
async function showList() {
  E = null;
  try { history.replaceState(null, '', '#/'); } catch (e) { /* ไม่เป็นไร */ }
  showLoading('กำลังโหลดรายการข้อสอบ...');
  let res;
  try { res = await rpcRetry('exam_list_sets', { p_token: S.token }); }
  catch (e) { showError('โหลดรายการไม่สำเร็จ', 'ตรวจสอบอินเทอร์เน็ตแล้วลองใหม่', showList); return; }
  if (res && res.expired) { showExpired(); return; }
  if (!res || !res.ok) { showError('โหลดรายการไม่สำเร็จ', (res && res.message) || '', showList); return; }

  const sets = res.sets || [];
  const practice = sets.filter(function (s) { return s.mode === 'practice' && s.phase === 'open'; });
  const arena = sets.filter(function (s) { return s.mode === 'arena' && s.phase === 'open'; });
  const ended = sets.filter(function (s) { return s.phase !== 'open'; });

  const root = h('div', { class: 'wrap' },
    h('div', { class: 'topbar' }, h('a', { class: 'back', href: HOME_URL, text: '‹ กลับหน้าหลัก' })),
    h('div', { class: 'page-title', text: 'ข้อสอบ' }),
    h('div', { class: 'hint', style: 'margin:2px 4px 0', text: 'สวัสดี ' + S.name }));

  function group(title, list, emptyText) {
    root.appendChild(h('div', { class: 'sec', text: title }));
    const box = h('div', { class: 'sets' });
    if (!list.length) box.appendChild(h('div', { class: 'hint', style: 'margin:8px 4px', text: emptyText }));
    list.forEach(function (s) { box.appendChild(setCard(s)); });
    root.appendChild(box);
  }
  group('โหมดฝึก', practice, 'ยังไม่มีชุดฝึกที่เปิดอยู่');
  group('Arena ที่เปิดอยู่', arena, 'ยังไม่มี Arena ที่เปิดอยู่');
  if (ended.length) group('ที่จบแล้ว / ที่เคยสอบ', ended, '');
  mount(root);
}

function setCard(s) {
  const isArena = s.mode === 'arena';
  const meta = ['เวลา ' + s.duration_minutes + ' นาที'];
  if (isArena) {
    if (s.season_name) meta.push('Season: ' + s.season_name);
    if (s.season_ends_at) meta.push('ปิด ' + fmtDateTime(s.season_ends_at));
  } else if (s.attempts_allowed !== null && s.attempts_allowed !== undefined) {
    meta.push('ทำไปแล้ว ' + s.attempts_used + ' / ' + s.attempts_allowed + ' รอบ');
  }

  const card = h('div', { class: 'card' },
    h('div', { class: 'name' }, h('span', { class: 'tag' + (isArena ? ' arena' : ''), text: isArena ? 'Arena' : 'ฝึก' }), s.name),
    h('div', { class: 'meta', text: meta.join(' • ') }));

  if (s.action === 'start') {
    card.appendChild(btn('primary', 'เริ่มทำข้อสอบ', function () { showRules(s); }));
  } else if (s.action === 'resume') {
    card.appendChild(btn('primary', 'ทำต่อ (เหลือ ' + fmtClock(s.seconds_left) + ')', function (ev) {
      startAttempt(s, false, ev.currentTarget);
    }));
  } else if (s.action === 'done') {
    const b = btn('ghost', isArena ? 'สอบแล้ว' : 'ทำครบรอบแล้ว', null);
    b.disabled = true;
    card.appendChild(b);
    card.appendChild(h('div', { class: 'hint', style: 'margin-top:6px', text: 'หน้าดูผลและเฉลยจะเปิดให้ใช้เร็วๆ นี้' }));
  } else if (s.action === 'closing') {
    const b = btn('ghost', 'ปิดรับแล้ว', null);
    b.disabled = true;
    card.appendChild(b);
    card.appendChild(h('div', { class: 'note', text: 'เวลาที่เหลือของ season น้อยกว่าเวลาสอบ จึงเริ่มไม่ได้แล้ว' }));
  } else {
    const b = btn('ghost', 'ปิดแล้ว', null);
    b.disabled = true;
    card.appendChild(b);
  }
  return card;
}

/* ---------- 8) หน้ากติกา + เริ่มสอบ ---------- */
function showRules(s) {
  const isArena = s.mode === 'arena';
  const rules = [];
  rules.push('เวลาสอบ ' + s.duration_minutes + ' นาที นับจากตอนกดเริ่ม และเดินต่อแม้ปิดหน้าจอหรือสลับแท็บ');
  rules.push('ระบบบันทึกเวลาต่อข้อ ข้อที่ข้าม และการสลับแท็บ');
  rules.push('ถ้าหน้าเว็บรีเฟรชหรือเน็ตหลุด ให้กลับเข้ามาที่รายการข้อสอบแล้วกด "ทำต่อ" เวลาไม่รีเซ็ต');
  rules.push('เมื่อหมดเวลา ระบบส่งข้อสอบให้อัตโนมัติ คำตอบที่เลือกไว้แล้วจะถูกนับ');
  if (isArena) {
    rules.push('Arena สอบได้ 1 ครั้งต่อชุดต่อ season');
  } else {
    rules.push('ทำได้ ' + (s.attempts_allowed || 3) + ' รอบต่อชุด (ออกกลางคันหรือหมดเวลานับเป็น 1 รอบ)');
    if (s.attempts_used >= 1) rules.push('นี่คือรอบที่ ' + (s.attempts_used + 1) + ' เวลาที่ลดลงส่วนหนึ่งอาจมาจากการจำข้อได้');
  }

  const startBtn = btn('primary', 'เริ่มทำข้อสอบ', function (ev) {
    startAttempt(s, isArena ? chk.checked : false, ev.currentTarget);
  });
  let chk = { checked: true };
  const extra = [];
  if (isArena) {
    chk = h('input', { type: 'checkbox', id: 'acceptRules' });
    chk.onchange = function () { startBtn.disabled = !chk.checked; };
    startBtn.disabled = true;
    extra.push(h('label', { class: 'accept', for: 'acceptRules' }, chk,
      h('span', { text: 'ฉันรับทราบกติกา และจะไม่บอกเฉลยต่อจนกว่า season จะจบ' })));
  }

  mount(h('div', { class: 'wrap' },
    h('div', { class: 'topbar' }, h('a', { class: 'back', href: '#/', onclick: function (e) { e.preventDefault(); showList(); }, text: '‹ กลับรายการข้อสอบ' })),
    h('div', { class: 'page-title', text: s.name }),
    h('div', { class: 'panel' },
      h('ul', { class: 'rules' }, rules.map(function (t) { return h('li', { text: t }); })),
      extra),
    h('div', { style: 'margin-top:16px' }, startBtn)));
}

async function startAttempt(set, accept, button) {
  if (button) button.disabled = true;
  showBusy('กำลังเริ่มข้อสอบ...');
  let res;
  try {
    res = await rpcRetry('exam_start_attempt',
      { p_token: S.token, p_exam_set_id: set.id, p_accept_rules: !!accept });
  } catch (e) {
    hideBusy();
    if (button) button.disabled = false;
    showDialog({
      icon: '⚠️', title: 'เริ่มไม่สำเร็จ',
      message: 'เชื่อมต่อไม่สำเร็จ กรุณาตรวจสอบอินเทอร์เน็ตแล้วลองใหม่ ถ้าไม่แน่ใจว่าเริ่มไปแล้วหรือยัง ให้กลับไปที่รายการข้อสอบแล้วดูปุ่ม "ทำต่อ"',
      buttons: [{ text: 'ตกลง', cls: 'primary' }]
    });
    return;
  }
  hideBusy();
  if (res && res.expired) { showExpired(); return; }
  if (!res || !res.ok) {
    if (button) button.disabled = false;
    showDialog({
      icon: res && res.maintenance ? '🛠' : 'ℹ️', title: 'เริ่มสอบไม่ได้',
      message: (res && res.message) || 'เกิดข้อผิดพลาด ลองใหม่อีกครั้ง',
      buttons: [{ text: 'กลับรายการข้อสอบ', cls: 'primary', onClick: showList }]
    });
    return;
  }
  loadExam(res.attempt_id, set.name);
}

/* ---------- 9) โหลดข้อสอบ + ตั้งค่า ---------- */
async function loadExam(attemptId, setName) {
  showLoading('กำลังโหลดข้อสอบ...');
  let res;
  try { res = await rpcRetry('exam_get_exam', { p_token: S.token, p_attempt_id: attemptId }); }
  catch (e) { showError('โหลดข้อสอบไม่สำเร็จ', 'ตรวจสอบอินเทอร์เน็ตแล้วลองใหม่', function () { loadExam(attemptId, setName); }); return; }
  if (res && res.expired) { showExpired(); return; }
  if (!res || !res.ok) {
    if (res && res.closed) { renderDone(res.status); return; }
    screenMessage('⚠️', 'เปิดข้อสอบไม่ได้', (res && res.message) || '', [btn('primary', 'กลับรายการข้อสอบ', showList)]);
    return;
  }
  if (!res.questions || !res.questions.length) {
    screenMessage('⚠️', 'ชุดข้อสอบนี้ยังไม่มีข้อสอบ', '', [btn('primary', 'กลับรายการข้อสอบ', showList)]);
    return;
  }
  setupExam(res, setName);
}

function setupExam(res, setName) {
  E = newExamState(res.attempt_id);
  E.mode = res.mode;
  E.attemptNo = res.attempt_no;
  try {
    if (setName) sessionStorage.setItem('exam_set_' + res.attempt_id, setName);
    E.setName = setName || sessionStorage.getItem('exam_set_' + res.attempt_id) || '';
  } catch (e) { E.setName = setName || ''; }
  E.q = res.questions;
  E.q.forEach(function (q) {
    E.answers[q.question_version_id] = q.answer || '';
    E.marked[q.question_version_id] = !!q.marked;
  });
  setDeadline(res.seconds_left);

  let idx = 0;
  let needEnter = true;
  if (res.open_question) {
    const f = E.q.findIndex(function (q) { return q.question_version_id === res.open_question; });
    if (f >= 0) { idx = f; needEnter = false; }   // รีเฟรช: ข้อนี้ยังเปิดค้างอยู่ที่เซิร์ฟเวอร์ ไม่ต้องส่ง enter ซ้ำ
  }
  E.i = idx;

  try { history.replaceState(null, '', '#/a/' + E.attemptId); } catch (e) { /* ไม่เป็นไร */ }
  buildShell();
  renderQuestion();
  renderNav();
  startTimer();
  preloadFrom(idx);
  if (needEnter) pushEvent('enter', E.q[idx].question_version_id);
}

/* ---------- 10) นาฬิกา (แสดงผลอย่างเดียว) ---------- */
function setDeadline(secondsLeft) {
  if (!E || secondsLeft === null || secondsLeft === undefined) return;
  E.deadline = Date.now() + Number(secondsLeft) * 1000;
}
function startTimer() {
  stopTimer();
  tick();
  E.timerId = setInterval(tick, 250);
}
function stopTimer() {
  if (E && E.timerId) { clearInterval(E.timerId); E.timerId = 0; }
}
function tick() {
  if (!E) return;
  const left = (E.deadline - Date.now()) / 1000;
  const t = $('timer');
  if (t) {
    t.textContent = fmtClock(Math.ceil(left));
    t.className = 'timer' + (left <= DANGER_SECONDS ? ' danger' : left <= WARN_SECONDS ? ' warn' : '');
  }
  if (left <= 0 && !E.locked && !E.ended) submitNow(true);
}

/* ---------- 11) ส่ง event (บันทึกอัตโนมัติ + ลองซ้ำเมื่อเน็ตหลุด) ---------- */
function pushEvent(type, qvid, value) {
  if (!E || E.ended) return;
  E.queue.push({ type: type, qvid: qvid === undefined ? null : qvid, value: value === undefined ? null : value,
                 clientAt: new Date().toISOString(), tries: 0 });
  flush();
}

async function flush() {
  if (!E || E.flushing) return;
  const me = E;
  me.flushing = true;
  try {
    while (me.queue.length && !me.ended) {
      const ev = me.queue[0];
      let res;
      try {
        res = await rpc('exam_log_event', {
          p_token: S.token, p_attempt_id: me.attemptId, p_type: ev.type,
          p_question_version_id: ev.qvid, p_value: ev.value, p_client_at: ev.clientAt
        });
      } catch (err) {
        if (!isRetryable(err)) { me.queue.shift(); continue; }   // คำขอผิดรูปแบบ: ทิ้ง ไม่ลองซ้ำไม่รู้จบ
        ev.tries++;
        setNet(false);
        await sleep(Math.min(1000 * Math.pow(2, Math.min(ev.tries, 4)), 15000));
        continue;                                                // เก็บลำดับเดิม ลองใหม่
      }
      setNet(true);
      me.queue.shift();
      if (res && res.expired) { showExpired(); return; }
      if (res && (res.time_up || res.closed)) { handleEnded(res.status); return; }
      if (res && res.seconds_left !== undefined && res.seconds_left !== null && !me.ended) setDeadline(res.seconds_left);
      // ok:false แบบอื่น (เช่น ค่าไม่ถูกต้อง): ทิ้ง event นี้แล้วไปต่อ
    }
  } finally {
    me.flushing = false;
  }
}

function setNet(online) {
  if (!E) return;
  E.online = online;
  const n = $('net');
  if (n) n.className = 'net' + (online ? '' : ' show');
}

async function drainQueue(ms) {
  const t0 = Date.now();
  while (E && (E.queue.length || E.flushing) && !E.ended && Date.now() - t0 < ms) {
    flush();
    await sleep(150);
  }
}

// event หน้าจอ/เน็ต (เซิร์ฟเวอร์ผูกกับข้อที่เปิดอยู่เอง)
document.addEventListener('visibilitychange', function () {
  if (E && !E.ended) pushEvent(document.hidden ? 'tab_hidden' : 'tab_visible');
});
window.addEventListener('offline', function () { if (E && !E.ended) { setNet(false); pushEvent('offline'); } });
window.addEventListener('online', function () { if (E && !E.ended) { pushEvent('online'); flush(); } });
window.addEventListener('beforeunload', function (e) {
  if (E && !E.ended) { e.preventDefault(); e.returnValue = ''; }
});

/* ---------- 12) หน้าสอบ ---------- */
function buildShell() {
  document.body.classList.add('in-exam');
  const shell = h('div', { class: 'wrap' },
    h('div', { class: 'ex-head' },
      h('div', { class: 'ex-title', text: E.setName || 'ข้อสอบ' }),
      h('a', { class: 'tool', href: DESMOS_URL, target: '_blank', rel: 'noopener', text: '🧮 Desmos' }),
      h('div', { class: 'timer', id: 'timer', text: '--:--' }),
      h('button', { type: 'button', class: 'tool submit', text: 'ส่ง', onclick: openSubmitDialog })),
    h('div', { class: 'net', id: 'net', text: 'เชื่อมต่อไม่ได้ ระบบจะบันทึกให้อัตโนมัติเมื่อเน็ตกลับมา (เวลายังเดินต่อ)' }),
    h('div', { class: 'ex-body' },
      h('div', { class: 'qcard', id: 'qwrap' }),
      h('div', { class: 'navpanel', id: 'navpanel' })),
    h('div', { class: 'ex-foot' },
      h('button', { type: 'button', class: 'btn ghost', id: 'prevBtn', text: '‹ ก่อนหน้า', onclick: function () { goTo(E.i - 1); } }),
      h('button', { type: 'button', class: 'btn ghost mid', id: 'navToggle', text: 'ทุกข้อ', onclick: function () { $('navpanel').classList.toggle('open'); } }),
      h('button', { type: 'button', class: 'btn primary', id: 'nextBtn', text: 'ถัดไป ›', onclick: onNext })));
  const app = $('app');
  app.textContent = '';
  app.appendChild(shell);
  window.scrollTo(0, 0);
}

function onNext() {
  if (E.i >= E.q.length - 1) openSubmitDialog(); else goTo(E.i + 1);
}

function curQ() { return E.q[E.i]; }
function hasAnswer(q) { return !!E.answers[q.question_version_id]; }

function goTo(i) {
  if (!E || E.locked || E.ended || i < 0 || i >= E.q.length || i === E.i) return;
  commitNumeric();
  pushEvent('leave', curQ().question_version_id);
  E.i = i;
  pushEvent('enter', curQ().question_version_id);
  renderQuestion();
  renderNav();
  preloadFrom(i);
  try { window.scrollTo(0, 0); } catch (e) { /* ไม่เป็นไร */ }
}

function renderQuestion() {
  const q = curQ();
  const qvid = q.question_version_id;
  const box = $('qwrap');
  box.textContent = '';

  const on = !!E.marked[qvid];
  box.appendChild(h('div', { class: 'q-head' },
    h('span', { class: 'q-num', text: 'ข้อ ' + (E.i + 1) + ' / ' + E.q.length }),
    h('button', {
      type: 'button', class: 'mark' + (on ? ' on' : ''), 'aria-pressed': String(on),
      text: on ? '⚑ ติดดาวไว้แล้ว' : '⚐ ติดดาวไว้ทบทวน', onclick: toggleMark
    })));

  box.appendChild(h('div', { class: 'q-body', text: q.body }));
  if (q.image_path) box.appendChild(imgEl(q.image_path));

  if (q.qtype === 'mcq') {
    const choices = q.choices || [];
    const grid = choices.some(function (c) { return c.image_path; });
    const cur = E.answers[qvid] || '';
    box.appendChild(h('div', { class: 'choices' + (grid ? ' grid' : '') },
      choices.map(function (c) {
        return h('button', {
          type: 'button', class: 'choice' + (cur === c.id ? ' sel' : ''), 'data-id': c.id,
          'aria-pressed': String(cur === c.id),
          onclick: function () { selectChoice(c.id); }
        },
          h('span', { class: 'letter', text: c.id }),
          h('span', { class: 'ctext' },
            c.text ? h('span', { text: c.text }) : null,
            c.image_path ? imgEl(c.image_path) : null));
      })));
  } else {
    const inp = h('input', {
      type: 'text', class: 'numinput', inputmode: 'text', autocomplete: 'off', autocapitalize: 'off',
      spellcheck: 'false', maxlength: '20', placeholder: 'พิมพ์คำตอบ เช่น 12, 0.5 หรือ 1/2',
      value: E.answers[qvid] || '', 'aria-label': 'คำตอบ'
    });
    inp.oninput = function () { onNumericInput(inp.value); };
    inp.onblur = commitNumeric;
    box.appendChild(inp);
  }

  const last = E.i >= E.q.length - 1;
  $('prevBtn').disabled = E.i === 0;
  $('nextBtn').textContent = last ? 'ตรวจและส่ง' : 'ถัดไป ›';
  renderMath(box);
}

function imgEl(path) {
  const wrap = h('span', { class: 'imgbox loading' });
  const im = new Image();
  im.alt = '';
  im.decoding = 'async';
  im.onload = function () { wrap.classList.remove('loading'); wrap.classList.remove('err'); };
  im.onerror = function () { wrap.classList.remove('loading'); wrap.classList.add('err'); };
  wrap.onclick = function () {
    if (!wrap.classList.contains('err')) return;
    wrap.classList.remove('err');
    wrap.classList.add('loading');
    im.src = imageUrl(path) + '?r=' + Date.now();
  };
  im.src = imageUrl(path);
  wrap.appendChild(im);
  return wrap;
}

function selectChoice(id) {
  if (E.locked || E.ended) return;
  const qvid = curQ().question_version_id;
  const next = E.answers[qvid] === id ? '' : id;     // กดซ้ำ = ยกเลิกคำตอบ
  E.answers[qvid] = next;
  pushEvent('answer_change', qvid, next);
  const btns = $('qwrap').querySelectorAll('.choice');
  for (let i = 0; i < btns.length; i++) {
    const sel = btns[i].getAttribute('data-id') === next;
    btns[i].classList.toggle('sel', sel);
    btns[i].setAttribute('aria-pressed', String(sel));
  }
  renderNav();
}

function onNumericInput(value) {
  if (E.locked || E.ended) return;
  const qvid = curQ().question_version_id;
  const v = String(value).trim();
  E.answers[qvid] = v;
  E.pendingNum = { qvid: qvid, value: v };
  clearTimeout(E.numTimer);
  E.numTimer = setTimeout(commitNumeric, NUM_DEBOUNCE_MS);
  renderNav();
}
function commitNumeric() {
  if (!E || !E.pendingNum) return;
  clearTimeout(E.numTimer);
  const p = E.pendingNum;
  E.pendingNum = null;
  pushEvent('answer_change', p.qvid, p.value);
}

function toggleMark() {
  if (E.locked || E.ended) return;
  const qvid = curQ().question_version_id;
  E.marked[qvid] = !E.marked[qvid];
  pushEvent('mark_review', qvid, E.marked[qvid] ? 'true' : 'false');
  const b = $('qwrap').querySelector('.mark');
  if (b) {
    b.classList.toggle('on', E.marked[qvid]);
    b.setAttribute('aria-pressed', String(E.marked[qvid]));
    b.textContent = E.marked[qvid] ? '⚑ ติดดาวไว้แล้ว' : '⚐ ติดดาวไว้ทบทวน';
  }
  renderNav();
}

function renderNav() {
  const p = $('navpanel');
  if (!p) return;
  p.textContent = '';
  let answered = 0;
  const grid = h('div', { class: 'qnav' }, E.q.map(function (q, i) {
    const qvid = q.question_version_id;
    const a = hasAnswer(q);
    if (a) answered++;
    return h('button', {
      type: 'button', text: String(i + 1),
      class: (a ? 'ans ' : '') + (i === E.i ? 'cur ' : '') + (E.marked[qvid] ? 'mk' : ''),
      'aria-label': 'ข้อ ' + (i + 1) + (a ? ' ตอบแล้ว' : ' ยังไม่ตอบ') + (E.marked[qvid] ? ' ติดดาว' : ''),
      onclick: function () { goTo(i); $('navpanel').classList.remove('open'); }
    });
  }));
  p.appendChild(grid);
  p.appendChild(h('div', { class: 'legend', text: 'ตอบแล้ว ' + answered + ' / ' + E.q.length + ' ข้อ • สีม่วงอ่อน = ตอบแล้ว • ⚑ = ติดดาวไว้' }));
  const t = $('navToggle');
  if (t) t.textContent = 'ทุกข้อ (' + answered + '/' + E.q.length + ')';
}

/* ---------- 13) โหลดรูปล่วงหน้า (ข้อที่ใกล้ถึงก่อน) ---------- */
function preloadFrom(start) {
  const urls = [];
  const n = E.q.length;
  for (let k = 0; k < n; k++) {
    const q = E.q[(start + k) % n];
    if (q.image_path) urls.push(imageUrl(q.image_path));
    (q.choices || []).forEach(function (c) { if (c.image_path) urls.push(imageUrl(c.image_path)); });
  }
  let next = 0, active = 0;
  function pump() {
    while (active < PRELOAD_CONCURRENCY && next < urls.length) {
      const im = new Image();
      active++;
      im.onload = im.onerror = function () { active--; pump(); };
      im.src = urls[next++];
    }
  }
  pump();
}

/* ---------- 14) ส่งข้อสอบ ---------- */
function openSubmitDialog() {
  if (!E || E.locked || E.ended) return;
  commitNumeric();
  const un = [], mk = [];
  E.q.forEach(function (q, i) {
    if (!hasAnswer(q)) un.push(i + 1);
    if (E.marked[q.question_version_id]) mk.push(i + 1);
  });
  const lines = [];
  if (un.length) lines.push('ยังไม่ได้ตอบ: ข้อ ' + un.join(', '));
  if (mk.length) lines.push('ติดดาวไว้: ข้อ ' + mk.join(', '));
  showDialog({
    icon: '📤', title: 'ส่งข้อสอบ',
    message: un.length ? 'ยังมี ' + un.length + ' ข้อที่ยังไม่ได้ตอบ ต้องการส่งเลยไหม?' : 'ตอบครบทุกข้อแล้ว ต้องการส่งเลยไหม?',
    lines: lines,
    note: 'เมื่อส่งแล้วแก้ไม่ได้',
    buttons: [
      { text: 'กลับไปทำต่อ', cls: 'ghost', focus: true },
      { text: 'ส่งข้อสอบ', cls: 'primary', onClick: function () { submitNow(false); } }
    ]
  });
}

async function submitNow(auto) {
  if (!E || E.locked || E.ended) return;
  commitNumeric();
  E.locked = true;
  showBusy(auto ? 'หมดเวลา กำลังส่งข้อสอบ...' : 'กำลังส่งข้อสอบ...');
  await drainQueue(8000);      // ให้คำตอบที่ค้างส่งออกไปก่อน (ไม่รอนานเกิน 8 วินาที)
  if (!E || E.ended) { hideBusy(); return; }

  let res = null;
  for (let i = 0; i < 6 && !res; i++) {
    try { res = await rpc('exam_submit_attempt', { p_token: S.token, p_attempt_id: E.attemptId }); }
    catch (err) {
      if (!isRetryable(err)) break;
      await sleep(1500 * (i + 1));
    }
  }
  hideBusy();
  if (!res) {
    // ส่งไม่สำเร็จ: ไม่ปิดการสอบ (เวลายังเดินที่เซิร์ฟเวอร์ และเซิร์ฟเวอร์ปิดรอบให้เองเมื่อเลยเวลา)
    setNet(false);
    if (auto) {   // หมดเวลา: ลองส่งซ้ำอัตโนมัติจนกว่าเน็ตจะกลับมา
      showBusy('เชื่อมต่อไม่ได้ กำลังลองส่งใหม่...');
      await sleep(3000);
      if (!E || E.ended) { hideBusy(); return; }
      E.locked = false;
      submitNow(true);
      return;
    }
    E.locked = false;
    showDialog({
      icon: '⚠️', title: 'ส่งไม่สำเร็จ',
      message: 'เชื่อมต่อไม่ได้ กรุณาตรวจสอบอินเทอร์เน็ตแล้วกดส่งอีกครั้ง คำตอบที่เลือกไว้ถูกบันทึกแล้ว',
      buttons: [{ text: 'ส่งอีกครั้ง', cls: 'primary', onClick: function () { submitNow(auto); } }]
    });
    return;
  }
  if (res.expired) { showExpired(); return; }
  if (!res.ok) {
    E.locked = false;
    showDialog({ icon: '⚠️', title: 'ส่งไม่สำเร็จ', message: res.message || 'เกิดข้อผิดพลาด', buttons: [{ text: 'ตกลง', cls: 'primary' }] });
    return;
  }
  handleEnded(res.status);
}

function handleEnded(status) {
  if (E && E.ended) return;
  if (E) E.ended = true;
  stopTimer();
  hideBusy();
  closeDialog();
  renderDone(status);
}

function renderDone(status) {
  stopTimer();
  E = null;
  try { history.replaceState(null, '', '#/'); } catch (e) { /* ไม่เป็นไร */ }
  const map = {
    submitted: ['✅', 'ส่งข้อสอบเรียบร้อย', 'ระบบบันทึกคำตอบและเวลาของคุณแล้ว'],
    timed_out: ['⏰', 'หมดเวลา', 'ระบบส่งข้อสอบให้อัตโนมัติ คำตอบที่เลือกไว้แล้วถูกนับ'],
    voided: ['ℹ️', 'รอบนี้ไม่นับ', 'ไม่ได้เข้าทำข้อใดเลยจนหมดเวลา จึงไม่นับเป็นรอบ (โหมดฝึก) กลับไปเริ่มใหม่ได้']
  };
  const m = map[status] || ['✅', 'การสอบนี้จบแล้ว', ''];
  screenMessage(m[0], m[1], m[2] + (status === 'voided' ? '' : '\n\nหน้าดูผลและเฉลยจะเปิดให้ใช้เร็วๆ นี้'),
    [btn('primary', 'กลับรายการข้อสอบ', showList)]);
}

/* ---------- 15) เริ่มทำงาน ---------- */
$('dlg').addEventListener('click', function (e) {
  if (e.target === $('dlg')) closeDialog();
});
document.addEventListener('keydown', function (e) {
  if (e.key === 'Escape' && $('dlg').classList.contains('open')) closeDialog();
});
boot();
