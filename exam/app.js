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
const MINI_NAME = 'Mini Test';             // ชื่อที่นักเรียนเห็นของโหมดที่ในฐานข้อมูลเรียก arena
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
  const r = /^#\/r\/(\d+)$/.exec(location.hash);
  if (m) loadExam(Number(m[1]));
  else if (r) showResult(Number(r[1]));
  else showList();
}

/* ---------- 7) รายการชุดข้อสอบ ---------- */
// แท็บล่าสุดของหน้ารายการ (จำไว้เวลากดกลับจากหน้าสอบ/หน้าผล)
// LIST_TAB: 'practice' | 'arena'   LIST_SUB (เฉพาะ Mini Test): 'open' | 'ended' | 'win'
let LIST_TAB = 'practice';
let LIST_SUB = 'open';
let LAST_SETS = null;   // รายการชุดล่าสุดจาก showList (ใช้หา season ของผลที่เปิดดู)
try {
  LIST_TAB = sessionStorage.getItem('exam_list_tab') || 'practice';
  LIST_SUB = sessionStorage.getItem('exam_list_sub') || 'open';
  if (LIST_TAB === 'win') { LIST_TAB = 'arena'; LIST_SUB = 'win'; }   // ค่าเก่าจากเวอร์ชันก่อน
} catch (e) { /* ไม่เป็นไร */ }

async function showList() {
  E = null;
  try { history.replaceState(null, '', '#/'); } catch (e) { /* ไม่เป็นไร */ }
  showLoading('กำลังโหลดรายการข้อสอบ...');
  let res;
  try { res = await rpcRetry('exam_list_sets', { p_token: S.token }); }
  catch (e) { showError('โหลดรายการไม่สำเร็จ', 'ตรวจสอบอินเทอร์เน็ตแล้วลองใหม่', showList); return; }
  if (res && res.expired) { showExpired(); return; }
  if (!res || !res.ok) { showError('โหลดรายการไม่สำเร็จ', (res && res.message) || '', showList); return; }

  let win = null;
  try { win = await rpcRetry('exam_winner_overview', { p_token: S.token }, 2); } catch (e) { win = null; }
  if (!win || !win.ok) win = null;

  const sets = res.sets || [];
  LAST_SETS = sets;
  const practice = sets.filter(function (s) { return s.mode === 'practice' && s.phase === 'open'; });
  const arena = sets.filter(function (s) { return s.mode === 'arena' && s.phase === 'open'; });
  const endedPractice = sets.filter(function (s) { return s.mode === 'practice' && s.phase !== 'open'; });
  const endedArena = sets.filter(function (s) { return s.mode !== 'practice' && s.phase !== 'open'; });

  const mine = win ? (win.mine || []) : [];
  const board = win ? (win.board || []) : [];
  // สิ่งที่ผู้ชนะต้องทำ: ยังไม่ได้ตอบ หรือครูขอให้แก้ข้อความ (ใช้ทำจุดแดง)
  const todo = mine.filter(function (w) { return w.status === 'invited' || w.status === 'rejected'; }).length;

  const root = h('div', { class: 'wrap wide' },
    h('div', { class: 'topbar' }, h('a', { class: 'back', href: HOME_URL, text: '‹ กลับหน้าหลัก' })),
    h('div', { class: 'page-title', text: 'ข้อสอบ' }),
    h('div', { class: 'hint', style: 'margin:2px 4px 0', text: 'สวัสดี ' + S.name }));

  const TOPS = [
    { id: 'practice', label: '📝 โหมดฝึก', dot: false },
    { id: 'arena', label: '🏆 ' + MINI_NAME, dot: todo > 0 }
  ];
  const SUBS = [
    { id: 'open', label: MINI_NAME + ' ที่เปิดอยู่', dot: false },
    { id: 'win', label: 'ประกาศผลประจำ season', dot: todo > 0 }
  ];
  if (LIST_TAB !== 'practice' && LIST_TAB !== 'arena') LIST_TAB = 'practice';
  if (!SUBS.some(function (t) { return t.id === LIST_SUB; })) LIST_SUB = 'open';

  const nav = h('div', { class: 'lnav', role: 'tablist' });
  const subBar = h('div', { class: 'subtabs', role: 'tablist' });
  const body = h('div', null);

  function remember() {
    try { sessionStorage.setItem('exam_list_tab', LIST_TAB); sessionStorage.setItem('exam_list_sub', LIST_SUB); } catch (e) { /* ไม่เป็นไร */ }
  }

  function group(title, list, emptyText) {
    if (!list.length && !emptyText) return;
    body.appendChild(h('div', { class: 'sec', text: title }));
    const box = h('div', { class: 'sets' });
    if (!list.length) box.appendChild(h('div', { class: 'hint', style: 'margin:8px 4px', text: emptyText }));
    list.forEach(function (s) { box.appendChild(setCard(s)); });
    body.appendChild(box);
  }

  function drawWinners() {
    // ผู้ชนะที่ยังต้องทำอะไรต่อ (ยังไม่ตอบ/รอครูตรวจ/ครูขอแก้/เลือกไม่ประกาศ) ส่วนที่แสดงแล้วอยู่ในกระดานด้านล่างอยู่แล้ว ไม่ต้องซ้ำ
    const needAct = mine.filter(function (w) { return w.status !== 'approved'; });
    if (needAct.length) {
      body.appendChild(h('div', { class: 'sec', text: '🏆 ยินดีด้วย คุณเป็นผู้ชนะ' }));
      body.appendChild(h('div', { class: 'sets' }, needAct.map(winnerMineCard)));
    }
    body.appendChild(h('div', { class: 'sec', text: 'ผู้ชนะ ' + MINI_NAME + ' ประจำ season' }));
    if (board.length) body.appendChild(h('div', { class: 'sets' }, winnerBoardCards(board, mine, sets)));
    else body.appendChild(h('div', { class: 'hint', style: 'margin:8px 4px', text: 'ยังไม่มีการประกาศผู้ชนะ จะแสดงเมื่อครูล็อกผล season และอนุมัติข้อความของผู้ชนะ' }));
    const onBoard = {};
    board.forEach(function (r) { onBoard[r.season_name + '||' + r.set_name] = true; });
    group('ผลของฉัน (ชุดที่ยังไม่มีการประกาศผู้ชนะ)', endedArena.filter(function (x) {
      return x.results && x.results.length && !onBoard[x.season_name + '||' + x.name];
    }), '');
  }

  function drawTab() {
    body.textContent = '';
    subBar.textContent = '';
    Array.prototype.forEach.call(nav.children, function (b) {
      const on = b.getAttribute('data-tab') === LIST_TAB;
      b.className = 'ltab' + (on ? ' on' : '');
      b.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    if (LIST_TAB === 'practice') {
      group('ชุดฝึกที่เปิดอยู่', practice, 'ยังไม่มีชุดฝึกที่เปิดอยู่');
      group('ที่จบแล้ว / ที่เคยสอบ', endedPractice, '');
      return;
    }
    SUBS.forEach(function (t) {
      subBar.appendChild(h('button', {
        type: 'button', role: 'tab', class: t.id === LIST_SUB ? 'on' : '',
        'aria-selected': t.id === LIST_SUB ? 'true' : 'false',
        onclick: function () { LIST_SUB = t.id; remember(); drawTab(); }
      }, t.label, t.dot ? h('span', { class: 'dot', 'aria-label': 'มีรายการที่ต้องทำ' }) : null));
    });
    body.appendChild(subBar);
    if (LIST_SUB === 'open') group(MINI_NAME + ' ที่เปิดอยู่', arena, 'ยังไม่มี ' + MINI_NAME + ' ที่เปิดอยู่');
    else drawWinners();
  }

  TOPS.forEach(function (t) {
    nav.appendChild(h('button', {
      type: 'button', role: 'tab', 'data-tab': t.id,
      onclick: function () { LIST_TAB = t.id; remember(); drawTab(); }
    }, t.label, t.dot ? h('span', { class: 'dot', 'aria-label': 'มีรายการที่ต้องทำ' }) : null));
  });

  root.appendChild(h('div', { class: 'llayout' }, nav, h('div', { class: 'lpages' }, body)));
  drawTab();
  mount(root);
}

/* ---------- 7.5) ประกาศผู้ชนะ (ขั้น 5.5) ---------- */
const MEDAL = { 1: '🥇', 2: '🥈', 3: '🥉' };

function winnerScoreText(w) {
  return 'คะแนน ' + w.score + '/' + w.total + '  •  เวลารวม ' + fmtClock(w.total_secs);
}

// บรรทัดที่มีป้ายกำกับ: "ชื่อ: น้ำปลา" / "คณะที่อยากเข้า: วิดวะ" / "อยากบอกเพื่อนๆ / คำคม: ง่วงจัง"
function winnerLine(label, value, bold) {
  return h('div', { style: 'margin-top:4px;white-space:pre-wrap;overflow-wrap:anywhere' },
    h('span', { style: 'color:#64748b;font-size:13px', text: label + ': ' }),
    h('span', { style: bold ? 'font-weight:700' : '', text: value }));
}
function winnerLines(w, bold) {
  return [
    winnerLine('ชื่อ', w.nickname || '-', bold),
    w.faculty ? winnerLine('คณะที่อยากเข้า', w.faculty) : null,
    w.message ? winnerLine('อยากบอกเพื่อนๆ / คำคม', w.message) : null
  ];
}

function winnerPreview(w) {
  return h('div', { style: 'margin-top:8px;padding:10px 12px;border-radius:10px;background:#f1f5f9' }, winnerLines(w, true));
}

// การ์ดของผู้ชนะเอง: แสดงตามสถานะ (ยังไม่ตอบ / รอครูตรวจ / แสดงแล้ว / ครูขอให้แก้ / เลือกไม่ประกาศ)
function winnerMineCard(w) {
  const card = h('div', { class: 'card' },
    h('div', { class: 'name', text: (MEDAL[w.rank] || '🏆') + ' อันดับ ' + w.rank + ' ของ ' + w.set_name }),
    h('div', { class: 'meta', text: 'Season: ' + w.season_name + '  •  ' + winnerScoreText(w) }));
  const acts = h('div', { class: 'resbtns' });
  function write(label) { return btn('primary small', label, function () { openWinnerForm(w); }); }
  function decline(label) { return btn('ghost small', label, function () { askDeclineWinner(w); }); }

  if (w.status === 'invited') {
    card.appendChild(h('div', { class: 'note', text: 'เขียนข้อความสั้นๆ ถึงเพื่อนๆ ได้ เช่น คณะที่อยากเข้า หรือคติประจำใจ ครูจะตรวจก่อนแสดง เพื่อนที่ทำชุดเดียวกันจะย้อนดูการสอบของคุณได้ (คะแนน เวลา คำตอบที่เลือก ลำดับการทำข้อสอบ) คู่กับชื่อเล่น หรือจะเลือกไม่ประกาศก็ได้' }));
    acts.appendChild(write('เขียนข้อความ'));
    acts.appendChild(decline('ไม่ประสงค์ประกาศ'));
  } else if (w.status === 'pending') {
    card.appendChild(h('div', { class: 'note', text: '⏳ ส่งแล้ว รอครูตรวจ' }));
    card.appendChild(winnerPreview(w));
    acts.appendChild(write('แก้ไขข้อความ'));
    acts.appendChild(decline('ไม่ประสงค์ประกาศ'));
  } else if (w.status === 'approved') {
    card.appendChild(h('div', { class: 'note', text: '✅ แสดงให้เพื่อนๆ เห็นแล้ว' }));
    card.appendChild(winnerPreview(w));
    acts.appendChild(decline('ถอนการประกาศ'));
  } else if (w.status === 'rejected') {
    card.appendChild(h('div', { class: 'note', text: 'ครูขอให้แก้ไขข้อความ' + (w.review_note ? ': ' + w.review_note : '') }));
    if (w.nickname) card.appendChild(winnerPreview(w));
    acts.appendChild(write('แก้ไขและส่งใหม่'));
    acts.appendChild(decline('ไม่ประสงค์ประกาศ'));
  } else {   // declined
    card.appendChild(h('div', { class: 'note', text: 'คุณเลือกไม่ประกาศ (เปลี่ยนใจได้ถ้ายังต้องการ)' }));
    acts.appendChild(write('เปลี่ยนใจ เขียนข้อความ'));
  }
  card.appendChild(acts);
  return card;
}

function openWinnerForm(w, vals) {
  vals = vals || { nickname: w.nickname || '', faculty: w.faculty || '', message: w.message || '' };
  const st = 'width:100%;box-sizing:border-box;padding:10px 12px;border:1.5px solid #e2e8f0;' +
    'border-radius:10px;font-size:15px;font-family:inherit;margin-top:10px';
  const nick = h('input', { type: 'text', maxlength: '30', 'aria-label': 'ชื่อเล่น', style: st,
    placeholder: 'ชื่อที่จะแสดง เช่น ชื่อเล่น (ไม่เกิน 30 ตัวอักษร)' });
  const fac = h('input', { type: 'text', maxlength: '60', 'aria-label': 'คณะที่อยากเข้า', style: st,
    placeholder: 'คณะที่อยากเข้า (ไม่บังคับ)' });
  const msg = h('textarea', { maxlength: '140', rows: '3', 'aria-label': 'อยากบอกเพื่อนๆ หรือคำคม', style: st,
    placeholder: 'อยากบอกอะไรเพื่อนๆ หรือคำคม (ไม่บังคับ ไม่เกิน 140 ตัวอักษร)' });
  nick.value = vals.nickname; fac.value = vals.faculty; msg.value = vals.message;
  const cnt = h('div', { class: 'hint', style: 'text-align:right;margin-top:2px', text: msg.value.length + '/140' });
  msg.oninput = function () { cnt.textContent = msg.value.length + '/140'; };

  showDialog({
    icon: '🏆', title: 'ข้อความถึงเพื่อนๆ',
    message: 'ครูจะตรวจก่อนแสดง ชื่อเล่น คณะ และข้อความนี้นักเรียนทุกคนที่ล็อกอินเห็นได้ และผู้ที่ทำชุดเดียวกันจะย้อนดูการสอบของคุณได้ทั้งคะแนน เวลา คำตอบที่คุณเลือกในแต่ละข้อ และลำดับการทำข้อสอบ คู่กับชื่อเล่นของคุณ อย่าใส่ข้อมูลส่วนตัว เช่น เบอร์โทร',
    buttons: [
      { text: 'ยกเลิก', cls: 'ghost' },
      { text: 'ส่งให้ครูตรวจ', cls: 'primary', focus: true, onClick: function () {
        const v = { nickname: nick.value.trim(), faculty: fac.value.trim(), message: msg.value.trim() };
        if (!v.nickname) {
          showDialog({ icon: 'ℹ️', title: 'ต้องใส่ชื่อเล่น', message: 'กรุณาใส่ชื่อเล่นที่จะแสดงในประกาศ',
            buttons: [{ text: 'ตกลง', cls: 'primary', onClick: function () { openWinnerForm(w, v); } }] });
          return;
        }
        submitWinner(w, v);
      } }
    ]
  });
  const body = $('dlgBody');
  body.appendChild(nick); body.appendChild(fac); body.appendChild(msg); body.appendChild(cnt);
}

async function submitWinner(w, v) {
  showBusy('กำลังส่ง...');
  let res;
  try {
    res = await rpcRetry('exam_winner_submit', {
      p_token: S.token, p_winner_id: w.id, p_nickname: v.nickname, p_faculty: v.faculty, p_message: v.message });
  } catch (e) {
    hideBusy();
    showDialog({ icon: '⚠️', title: 'ส่งไม่สำเร็จ', message: 'ตรวจสอบอินเทอร์เน็ตแล้วลองใหม่',
      buttons: [{ text: 'ลองใหม่', cls: 'primary', onClick: function () { openWinnerForm(w, v); } },
                { text: 'ปิด', cls: 'ghost' }] });
    return;
  }
  hideBusy();
  if (res && res.expired) { showExpired(); return; }
  if (!res || !res.ok) {
    showDialog({ icon: 'ℹ️', title: 'ส่งไม่ได้', message: (res && res.message) || '',
      buttons: [{ text: 'ตกลง', cls: 'primary', onClick: showList }] });
    return;
  }
  showDialog({ icon: '✅', title: 'ส่งให้ครูตรวจแล้ว', message: 'เมื่อครูอนุมัติ ข้อความจะแสดงให้เพื่อนๆ เห็น',
    buttons: [{ text: 'ตกลง', cls: 'primary', onClick: showList }] });
}

function askDeclineWinner(w) {
  const wasShown = w.status === 'approved';
  showDialog({
    icon: '🙈', title: wasShown ? 'ถอนการประกาศ' : 'ไม่ประสงค์ประกาศ',
    message: wasShown
      ? 'ข้อความของคุณจะหายจากหน้าผู้ชนะ และข้อความที่เคยกรอกจะถูกลบ ถ้าเปลี่ยนใจต้องกรอกใหม่'
      : 'คุณจะไม่ถูกประกาศชื่อ และข้อความที่เคยกรอกจะถูกลบ เปลี่ยนใจกลับมากรอกได้ภายหลัง',
    buttons: [
      { text: 'ยกเลิก', cls: 'ghost', focus: true },
      { text: 'ยืนยัน', cls: 'primary', onClick: async function () {
        showBusy('กำลังบันทึก...');
        let res;
        try { res = await rpcRetry('exam_winner_decline', { p_token: S.token, p_winner_id: w.id }); }
        catch (e) {
          hideBusy();
          showDialog({ icon: '⚠️', title: 'บันทึกไม่สำเร็จ', message: 'ตรวจสอบอินเทอร์เน็ตแล้วลองใหม่',
            buttons: [{ text: 'ตกลง', cls: 'primary' }] });
          return;
        }
        hideBusy();
        if (res && res.expired) { showExpired(); return; }
        showList();
      } }
    ]
  });
}

/* ---------- ย้อนดูการสอบ (replay) ----------
   เล่นเหตุการณ์จริงตามลำดับเวลา: การ์ดแสดงข้อที่กำลังทำ เวลาที่อยู่หน้านี้ คำตอบ ณ เวลานั้น และสิ่งที่ทำต่อ
   เล่นพร้อมกัน 2 การ์ด (ผู้ชนะ / คุณ) บนนาฬิกาเดียวกัน ทุกอย่างคำนวณจากเวลา T จึงเล่น/หยุด/เลื่อน/เร็วช้าได้ */
const RP_SPEEDS = [1, 2, 3, 5];
let RP_STOP = null;   // ฟังก์ชันหยุด animation ของรอบที่เล่นอยู่

function rpClock(sec) {
  sec = Math.max(0, Math.floor(sec));
  return Math.floor(sec / 60) + ':' + pad2(sec % 60);
}

async function showWinnerReplay(r, back) {
  showBusy('กำลังโหลดการสอบ...');
  let res;
  try { res = await rpcRetry('exam_winner_replay', { p_token: S.token, p_winner_id: r.id }); }
  catch (e) {
    hideBusy();
    showDialog({ icon: '⚠️', title: 'โหลดไม่สำเร็จ', message: 'ตรวจสอบอินเทอร์เน็ตแล้วลองใหม่',
      buttons: [{ text: 'ลองใหม่', cls: 'primary', onClick: function () { showWinnerReplay(r, back); } }, { text: 'ปิด', cls: 'ghost' }] });
    return;
  }
  hideBusy();
  if (res && res.expired) { showExpired(); return; }
  if (!res || !res.ok) {
    showDialog({ icon: 'ℹ️', title: 'ย้อนดูไม่ได้', message: (res && res.message) || '',
      buttons: [{ text: 'ตกลง', cls: 'primary', onClick: back }] });
    return;
  }
  renderReplay(r, res, back);
}

// ---- สร้าง "แทร็ก" ของคนหนึ่งคนจากรายการเหตุการณ์ ----
function rpAnsAt(tr, q, T) {
  const list = tr.ans[q] || [];
  let a = { v: '', ok: false };
  for (let i = 0; i < list.length && list[i].t <= T; i++) a = list[i];
  return a;
}
function rpMarkAt(tr, q, T) {
  const list = tr.marks[q] || [];
  let on = false;
  for (let i = 0; i < list.length && list[i].t <= T; i++) on = list[i].on;
  return on;
}
function rpFlagAt(tr, T, onKey, offKey) {
  let on = false;
  for (let i = 0; i < tr.flags.length && tr.flags[i].t <= T; i++) {
    if (tr.flags[i].k === onKey) on = true;
    else if (tr.flags[i].k === offKey) on = false;
  }
  return on;
}

function rpBuildTrack(label, data) {
  // เริ่มนับเวลาของแต่ละคนจาก "ตอนที่เห็นข้อแรก" เพื่อให้ทุกการ์ดเริ่มพร้อมกันที่ 0:00
  // (เวลาในฐานข้อมูลนับจากตอนกดเริ่มสอบ ซึ่งแต่ละคนห่างจากการเห็นข้อแรกไม่เท่ากัน เพราะต้องโหลดข้อสอบก่อน)
  const raw = (data && data.events) || [];
  let off = null;
  raw.forEach(function (e) { if (e.k === 'enter' && (off === null || e.t < off)) off = e.t; });
  off = off === null ? 0 : off;
  const ev = raw.map(function (e) {
    return { t: Math.max(0, Math.round((e.t - off) * 10) / 10), k: e.k, q: e.q, v: e.v, ok: e.ok };
  });
  const tr = { label: label, visits: [], ans: {}, marks: {}, flags: [], end: 0 };
  const lastAns = {}, counts = {};
  let open = null, lastT = 0;
  const FLAG_TEXT = { tab_hidden: '⚠ ออกจากหน้าจอสอบ', tab_visible: 'กลับมาที่หน้าจอสอบ', offline: '📡 อินเทอร์เน็ตหลุด', online: 'อินเทอร์เน็ตกลับมา' };

  function logTo(t, text, kind) {
    const v = open || tr.visits[tr.visits.length - 1];
    if (v) v.logs.push({ t: t, text: text, kind: kind || '' });
  }

  ev.forEach(function (e) {
    lastT = Math.max(lastT, e.t || 0);
    const q = e.q;
    if (e.k === 'enter') {
      if (q === null || q === undefined) return;
      if (open) open.t1 = e.t;
      counts[q] = (counts[q] || 0) + 1;
      open = { q: q, t0: e.t, t1: null, nth: counts[q], logs: [], note: '' };
      tr.visits.push(open);
    } else if (e.k === 'leave') {
      if (open && open.q === q) { open.t1 = e.t; open = null; }
    } else if (e.k === 'answer_change') {
      const v = String(e.v === null || e.v === undefined ? '' : e.v).trim();
      const prev = lastAns[q] || '';
      lastAns[q] = v;
      (tr.ans[q] = tr.ans[q] || []).push({ t: e.t, v: v, ok: e.ok === true });
      let text = v === '' ? 'ลบคำตอบ' : (prev === '' ? 'เลือกตอบ ' + v : 'เปลี่ยนคำตอบจาก ' + prev + ' เป็น ' + v);
      if (v !== '') text += e.ok === true ? '  ✓ ถูก' : '  ✗ ผิด';
      logTo(e.t, text, v === '' ? '' : (e.ok === true ? 'good' : 'bad'));
    } else if (e.k === 'mark_review') {
      const on = String(e.v) === 'true';
      (tr.marks[q] = tr.marks[q] || []).push({ t: e.t, on: on });
      logTo(e.t, on ? '⭐ ติดดาวทบทวน' : 'เอาดาวออก', '');
    } else if (FLAG_TEXT[e.k]) {
      tr.flags.push({ t: e.t, k: e.k });
      logTo(e.t, FLAG_TEXT[e.k], e.k === 'tab_hidden' || e.k === 'offline' ? 'warn' : '');
    }
  });

  tr.end = Math.max(Math.max(0, ((data && data.end) || 0) - off), lastT);
  tr.visits.forEach(function (v) { if (v.t1 === null) v.t1 = tr.end; });

  // ข้อความ "มาถึงข้อนี้ได้ยังไง" (ข้ามข้อ / ถัดไป / ย้อนกลับ / เลือกจากรายการ)
  tr.visits.forEach(function (v, i) {
    if (i === 0) { v.note = 'เริ่มทำข้อสอบที่ข้อ ' + v.q; return; }
    const p = tr.visits[i - 1];
    const a = rpAnsAt(tr, p.q, p.t1);
    const how = v.q === p.q + 1 ? 'กด ถัดไป' : v.q === p.q - 1 ? 'กด ก่อนหน้า' : v.q === p.q ? 'กลับเข้าข้อเดิม' : 'เลือกข้อ ' + v.q + ' จากรายการทุกข้อ';
    v.note = 'จากข้อ ' + p.q + (a.v ? ' (ตอบ ' + a.v + ' แล้ว)' : ' (ยังไม่ตอบ ข้ามไป)') + '  ›  ' + how;
  });
  return tr;
}

function rpScore(tr, qMap) {
  let n = 0;
  Object.keys(qMap).forEach(function (q) {
    const list = tr.ans[q] || [];
    const last = list[list.length - 1];
    if (last && last.v !== '' && last.ok) n++;
  });
  return n;
}

function rpState(tr, T) {
  const vs = tr.visits;
  if (!vs.length || T < vs[0].t0) return { phase: 'before' };
  if (T >= tr.end) return { phase: 'done' };
  let i = vs.length - 1;
  while (i > 0 && vs[i].t0 > T) i--;
  const v = vs[i];
  return { phase: 'in', i: i, v: v, tin: Math.min(T, v.t1) - v.t0 };
}

// ---- การ์ดของคนหนึ่งคน: update(T) วาดซ้ำเฉพาะส่วนที่เปลี่ยน ----
function rpMakeCard(tr, qMap) {
  const nQ = Object.keys(qMap).length;
  const el = h('div', { class: 'rp-card' });
  const qno = h('div', { class: 'rp-qno' });
  const timer = h('div', { class: 'rp-timer' });
  const note = h('div', { class: 'rp-note' });
  const chips = h('div', { class: 'rp-chips' });
  const ansLine = h('div', { class: 'rp-ansline' });
  const qbox = h('div', { class: 'rp-q' });
  const logs = h('div', { class: 'rp-logs' });
  const body = h('div', { class: 'rp-body' }, note, chips, ansLine, qbox, logs);
  if (tr.isMe) el.classList.add('mine');
  el.appendChild(h('div', { class: 'rp-who', text: tr.label }));
  el.appendChild(h('div', { class: 'rp-top' }, qno, timer));
  el.appendChild(body);

  let mode = '', curVisit = -1, curShowQ = null, ansSig = null, chipSig = '', logN = -1;
  let choiceEls = {}, numEl = null;

  function flip() { body.classList.remove('flip'); void body.offsetWidth; body.classList.add('flip'); }

  function buildQuestion(q, showQ) {
    qbox.textContent = ''; choiceEls = {}; numEl = null;
    if (!showQ || !q) return;
    qbox.appendChild(stemNode(q.body, q.image_path));
    if (q.qtype === 'mcq') {
      const choices = q.choices || [];
      const grid = choices.some(function (c) { return c.image_path; });
      qbox.appendChild(h('div', { class: 'choices' + (grid ? ' grid' : '') }, choices.map(function (c) {
        const tag = h('span', { class: 'tagl', style: 'display:none' });
        const row = h('div', { class: 'choice rs' },
          h('span', { class: 'letter', text: c.id }),
          h('span', { class: 'ctext' }, c.text ? h('span', { text: c.text }) : null, c.image_path ? imgEl(c.image_path) : null, tag));
        choiceEls[String(c.id).toUpperCase()] = { row: row, tag: tag };
        return row;
      })));
    } else {
      numEl = h('div', { class: 'numrow' });
      qbox.appendChild(numEl);
    }
    renderMath(qbox);
  }

  function paintAnswer(q, a) {
    if (!q) return;
    if (q.qtype === 'mcq') {
      const mine = String(a.v || '').toUpperCase();
      Object.keys(choiceEls).forEach(function (id) {
        const c = choiceEls[id];
        const on = id === mine;
        c.row.className = 'choice rs' + (on ? ' mine ' + (a.ok ? 'good' : 'bad') : '');
        c.tag.style.display = on ? '' : 'none';
        c.tag.textContent = a.ok ? '✓ ที่เลือก (ถูก)' : '✗ ที่เลือก (ผิด)';
      });
    } else if (numEl) {
      numEl.textContent = 'คำตอบที่กรอก: ' + (a.v ? a.v + (a.ok ? '   ✓ ถูก' : '   ✗ ผิด') : '(ยังไม่ได้กรอก)');
    }
  }

  function clearAll() { note.textContent = ''; chips.textContent = ''; ansLine.textContent = ''; qbox.textContent = ''; logs.textContent = ''; }

  function update(T, showQ) {
    const st = rpState(tr, T);
    if (st.phase !== mode) { mode = st.phase; curVisit = -1; ansSig = null; chipSig = ''; logN = -1; }
    if (st.phase === 'before') {
      qno.textContent = 'ยังไม่เริ่ม'; timer.textContent = ''; clearAll();
      return;
    }
    if (st.phase === 'done') {
      qno.textContent = '🏁 ส่งข้อสอบแล้ว';
      timer.textContent = 'ใช้เวลา ' + rpClock(tr.end);
      clearAll();
      note.textContent = 'ได้ ' + rpScore(tr, qMap) + '/' + nQ + ' ข้อ  •  เข้าข้อทั้งหมด ' + tr.visits.length + ' ครั้ง';
      return;
    }
    const v = st.v;
    if (curVisit !== st.i || curShowQ !== showQ) {
      curVisit = st.i; curShowQ = showQ; ansSig = null; chipSig = ''; logN = -1;
      qno.textContent = 'ข้อที่ ' + v.q;
      note.textContent = v.note + (v.nth > 1 ? '  •  เข้าข้อนี้ครั้งที่ ' + v.nth : '');
      buildQuestion(qMap[v.q], showQ);
      flip();
    }
    timer.textContent = 'อยู่หน้านี้ ' + rpClock(st.tin);

    const a = rpAnsAt(tr, v.q, T);
    const sig = a.v + '|' + a.ok;
    if (sig !== ansSig) {
      ansSig = sig; paintAnswer(qMap[v.q], a);
      ansLine.textContent = showQ ? '' : 'คำตอบที่เลือก: ' + (a.v ? a.v + (a.ok ? '   ✓ ถูก' : '   ✗ ผิด') : '(ยังไม่ตอบ)');
    }

    const c = [a.v ? 'ตอบแล้ว' : 'ยังไม่ตอบ'];
    if (rpMarkAt(tr, v.q, T)) c.push('⭐ ติดดาวทบทวน');
    if (rpFlagAt(tr, T, 'tab_hidden', 'tab_visible')) c.push('⚠ ออกจากหน้าจอสอบอยู่');
    if (rpFlagAt(tr, T, 'offline', 'online')) c.push('📡 เน็ตหลุดอยู่');
    const cs = c.join('|');
    if (cs !== chipSig) {
      chipSig = cs; chips.textContent = '';
      c.forEach(function (t, i) { chips.appendChild(h('span', { class: 'rp-chip' + (i === 0 ? (a.v ? ' ok' : ' none') : (t.indexOf('⭐') === 0 ? '' : ' warn')), text: t })); });
    }

    const shown = v.logs.filter(function (l) { return l.t <= T; });
    if (shown.length !== logN) {
      logN = shown.length; logs.textContent = '';
      shown.slice(-6).forEach(function (l) {
        logs.appendChild(h('div', { class: 'rp-log ' + l.kind },
          h('span', { class: 'rp-lt', text: rpClock(Math.max(0, l.t - v.t0)) }),
          h('span', { text: l.text })));
      });
    }
  }
  return { el: el, update: update };
}

// หน้าผู้ชนะ: เลือกดูทีละคน (ผู้ชนะที่เปิดเผยแล้ว + คุณ) ค่าเริ่มต้นคือคนที่กดเข้ามา
function renderReplay(r, res, back) {
  const qMap = {};
  (res.questions || []).forEach(function (q) { qMap[q.q_order] = q; });

  const people = [];
  let start = -1;
  (res.winners || []).forEach(function (w) {
    const medal = MEDAL[w.rank] || '#' + w.rank;
    if (w.shown && w.replay) {
      const name = w.nickname + (w.is_me ? ' (คุณ)' : '');
      if (w.id === r.id) start = people.length;
      people.push({ pill: medal + ' อันดับ ' + w.rank + '  ' + name, tr: rpBuildTrack(medal + ' อันดับ ' + w.rank + '  ' + name, w.replay) });
    } else {
      people.push({ pill: medal + ' อันดับ ' + w.rank + ' (ไม่เปิดเผย)', disabled: true });
    }
  });
  if (res.me) people.push({ pill: '🙋 คุณ', tr: rpBuildTrack('🙋 คุณ', res.me) });
  if (start < 0) start = people.findIndex(function (x) { return !x.disabled; });
  if (start < 0) {
    showDialog({ icon: 'ℹ️', title: 'ไม่มีข้อมูลให้ย้อนดู', message: 'ผู้ชนะในชุดนี้ไม่ได้เปิดเผยการสอบ',
      buttons: [{ text: 'ตกลง', cls: 'primary', onClick: back }] });
    return;
  }
  rpShowPlayer({
    title: '🎬 ย้อนดูการสอบ', sub: r.set_name + '  •  Season: ' + r.season_name,
    back: back, qMap: qMap, people: people, start: start
  });
}

// ตัวเล่น replay ทีละคน/ทีละรอบ (ใช้ร่วมกันทุกที่): o = { title, sub, back, qMap, people:[{pill, tr, disabled}], start,
//   hasMore, loadMore() -> Promise<{people, hasMore}> (ปุ่ม "รอบก่อนหน้า" ใส่รายการเพิ่มทางซ้าย) }
// ปุ่มเล่นและแถบเวลาอยู่ด้านล่างสุด ค้างติดขอบล่างจอ โจทย์แสดงเสมอ
function rpShowPlayer(o) {
  if (RP_STOP) RP_STOP();
  const qMap = o.qMap;
  const people = o.people;
  people.forEach(function (x) { if (x.tr) x.card = rpMakeCard(x.tr, qMap); });

  const P = { sel: -1, T: 0, playing: false, speed: 1, last: 0, raf: 0, maxT: 1, keyTimes: [0] };

  const stage = h('div', { class: 'rp-stage' });
  const pillBar = h('div', { class: 'rp-pills', role: 'tablist' });
  const moreBtn = h('button', { type: 'button', class: 'rp-pill more', text: '‹ รอบก่อนหน้า', onclick: function () { loadMoreClick(); } });
  let loadingMore = false;

  // แถบปุ่มเลือกคน/รอบ: สร้างใหม่ทุกครั้งที่เลือกหรือโหลดเพิ่ม (มีไม่กี่ปุ่ม)
  function renderPills() {
    pillBar.textContent = '';
    pillBar.style.display = people.length > 1 || o.hasMore ? '' : 'none';
    if (o.hasMore) pillBar.appendChild(moreBtn);
    people.forEach(function (x, i) {
      const b = h('button', { type: 'button', role: 'tab', class: 'rp-pill' + (i === P.sel ? ' on' : ''), text: x.pill,
                              'aria-selected': i === P.sel ? 'true' : 'false', onclick: function () { select(i); } });
      if (x.disabled) { b.disabled = true; b.classList.add('off'); }
      pillBar.appendChild(b);
    });
  }
  function loadMoreClick() {
    if (loadingMore || !o.loadMore) return;
    loadingMore = true; moreBtn.disabled = true; moreBtn.textContent = 'กำลังโหลด...';
    o.loadMore().then(function (r) {
      loadingMore = false; moreBtn.disabled = false; moreBtn.textContent = '‹ รอบก่อนหน้า';
      const add = (r && r.people) || [];
      add.forEach(function (x) { if (x.tr) x.card = rpMakeCard(x.tr, qMap); });
      Array.prototype.unshift.apply(people, add);
      P.sel += add.length;
      o.hasMore = !!(r && r.hasMore);
      renderPills();
    }).catch(function () {
      loadingMore = false; moreBtn.disabled = false; moreBtn.textContent = '‹ รอบก่อนหน้า (ลองใหม่)';
    });
  }

  const playBtn = btn('primary small', '▶ เล่น', function () { if (P.playing) pause(); else play(); });
  const slider = h('input', { type: 'range', min: '0', max: '1', step: 'any', value: '0', 'aria-label': 'ตำแหน่งเวลาในการสอบ', class: 'rp-slider' });
  const timeLbl = h('div', { class: 'rp-time' });
  const speedBtns = RP_SPEEDS.map(function (sp) {
    return h('button', { type: 'button', class: 'rp-sp', text: '×' + sp, onclick: function () { P.speed = sp; syncSpeed(); } });
  });

  function cur() { return people[P.sel]; }
  function syncPlay() { playBtn.textContent = P.playing ? '⏸ หยุด' : '▶ เล่น'; }
  function syncSpeed() { speedBtns.forEach(function (b, i) { b.className = 'rp-sp' + (RP_SPEEDS[i] === P.speed ? ' on' : ''); }); }
  function paint() {
    cur().card.update(P.T, true);
    slider.value = String(P.T);
    timeLbl.textContent = rpClock(P.T) + ' / ' + rpClock(P.maxT);
  }
  function frame(now) {
    P.raf = 0;
    if (!root.isConnected) return;   // ออกจากหน้านี้แล้ว
    const dt = Math.max(0, Math.min(0.25, (now - P.last) / 1000));   // กัน dt ติดลบ (rAF timestamp อาจเก่ากว่าตอนกดปุ่ม) ไม่งั้นเวลาถอยต่ำกว่า 0 แล้วการ์ดล้างและวาดใหม่ = กระพริบ
    P.last = now;
    if (P.playing) {
      P.T = Math.min(P.maxT, P.T + dt * P.speed);
      if (P.T >= P.maxT) { P.playing = false; syncPlay(); }
    }
    paint();
    if (P.playing) P.raf = requestAnimationFrame(frame);
  }
  function play() {
    if (P.T >= P.maxT) P.T = 0;
    P.playing = true; P.last = performance.now(); syncPlay();
    if (!P.raf) P.raf = requestAnimationFrame(frame);
  }
  function pause() { P.playing = false; syncPlay(); }
  RP_STOP = function () { P.playing = false; if (P.raf) cancelAnimationFrame(P.raf); P.raf = 0; };

  // จุดเวลาสำคัญของคนที่เลือก: เริ่ม, เข้าข้อ, ทุกเหตุการณ์ (เลือกตอบ/ติดดาว/ออกจากหน้าจอ ฯลฯ), ส่งข้อสอบ
  function keyTimesOf(tr) {
    const all = [0];
    tr.visits.forEach(function (v) {
      all.push(v.t0);
      v.logs.forEach(function (l) { all.push(l.t); });
    });
    all.push(tr.end);
    all.sort(function (a, b) { return a - b; });
    return all.filter(function (t, i) { return i === 0 || t - all[i - 1] > 0.05; });
  }
  function select(i) {
    if (i === P.sel || !people[i] || people[i].disabled) return;
    P.sel = i;
    P.T = 0;
    P.maxT = Math.max(1, cur().tr.end);
    P.keyTimes = keyTimesOf(cur().tr);
    slider.max = String(P.maxT);   // ใช้ค่าจริง (ไม่ปัดขึ้น) เพื่อให้หลอดเต็มพอดีตอนเล่นจนจบ
    stage.textContent = '';
    stage.appendChild(cur().card.el);
    renderPills();
    if (P.playing) P.last = performance.now();
    paint();
  }

  slider.oninput = function () { P.T = parseFloat(slider.value) || 0; paint(); };
  function jump(t) { P.T = Math.max(0, Math.min(P.maxT, t)); paint(); }
  function stepTo(t) { pause(); jump(t); }
  const prevBtn = btn('ghost small', '‹ ขั้นก่อนหน้า', function () {
    let t = 0;
    for (let i = 0; i < P.keyTimes.length; i++) if (P.keyTimes[i] < P.T - 0.05) t = P.keyTimes[i];
    stepTo(t);
  });
  const nextBtn = btn('ghost small', 'ขั้นถัดไป ›', function () {
    let t = P.maxT;
    for (let i = 0; i < P.keyTimes.length; i++) if (P.keyTimes[i] > P.T + 0.05) { t = P.keyTimes[i]; break; }
    stepTo(t);
  });
  const restartBtn = btn('ghost small', '↺ เริ่มใหม่', function () { P.T = 0; paint(); play(); });

  const root = h('div', { class: 'wrap wide' },
    h('div', { class: 'topbar' }, h('a', { class: 'back', href: '#/', onclick: function (e) { e.preventDefault(); if (RP_STOP) RP_STOP(); o.back(); }, text: '‹ กลับ' })),
    h('div', { class: 'page-title', text: o.title }),
    h('div', { class: 'hint', style: 'margin:2px 4px 0', text: o.sub }),
    pillBar,
    h('div', { class: 'rp-main' },
      h('div', { class: 'rp-spacer' }),
      h('div', { class: 'panel rp-top-ctl' },
        h('div', { class: 'rp-scrub' }, slider, timeLbl),
        h('div', { class: 'rp-opts' }, h('span', { class: 'hint', text: 'ความเร็ว' }), speedBtns)),
      h('div', { class: 'rp-side' }, playBtn, restartBtn, prevBtn, nextBtn),
      stage));

  mount(root);
  syncSpeed(); syncPlay();
  renderPills();
  select(o.start);   // ไม่เล่นอัตโนมัติ: รอให้กดปุ่ม "เล่น" เอง
}

// ย้อนดูการสอบของตัวเอง (โหมดฝึก): เลือกรอบได้ ล่าสุด 5 รอบ และกด "รอบก่อนหน้า" เพื่อโหลดเพิ่มทีละ 5 รอบ
async function showAttemptReplay(attemptId, setName) {
  showBusy('กำลังโหลดการสอบ...');
  let res;
  try { res = await rpcRetry('exam_attempt_replay', { p_token: S.token, p_attempt_id: attemptId, p_before: null }); }
  catch (e) {
    hideBusy();
    showDialog({ icon: '⚠️', title: 'โหลดไม่สำเร็จ', message: 'ตรวจสอบอินเทอร์เน็ตแล้วลองใหม่',
      buttons: [{ text: 'ลองใหม่', cls: 'primary', onClick: function () { showAttemptReplay(attemptId, setName); } }, { text: 'ปิด', cls: 'ghost' }] });
    return;
  }
  hideBusy();
  if (res && res.expired) { showExpired(); return; }
  if (!res || !res.ok || !(res.attempts || []).length) {
    showDialog({ icon: 'ℹ️', title: 'ย้อนดูไม่ได้', message: (res && res.message) || '', buttons: [{ text: 'ตกลง', cls: 'primary' }] });
    return;
  }
  const qMap = {};
  (res.questions || []).forEach(function (q) { qMap[q.q_order] = q; });
  function mk(x) {
    const label = 'รอบที่ ' + x.attempt_no;
    return { pill: label, no: x.attempt_no, id: x.attempt_id, tr: rpBuildTrack(label, x.replay) };
  }
  const people = res.attempts.map(mk);
  let start = people.findIndex(function (x) { return x.id === attemptId; });
  if (start < 0) start = people.length - 1;

  rpShowPlayer({
    title: '🎬 ย้อนดูการสอบ', sub: (setName || '') + '  •  การทำข้อสอบของคุณ',
    back: function () { showResult(attemptId); },
    qMap: qMap, people: people, start: start, hasMore: !!res.has_more,
    loadMore: async function () {
      const r2 = await rpcRetry('exam_attempt_replay', { p_token: S.token, p_attempt_id: attemptId, p_before: people[0].no });
      if (!r2 || !r2.ok) throw new Error('load');
      return { people: (r2.attempts || []).map(mk), hasMore: !!r2.has_more };
    }
  });
}

// หน้ารายละเอียดคะแนน/เวลารายข้อของผู้ชนะ (เห็นเฉพาะผู้ที่ทำชุดเดียวกันจบแล้ว ไม่มีคำตอบที่เลือก)
async function showWinnerDetail(r) {
  showBusy('กำลังโหลด...');
  let res;
  try { res = await rpcRetry('exam_winner_detail', { p_token: S.token, p_winner_id: r.id }); }
  catch (e) {
    hideBusy();
    showDialog({ icon: '⚠️', title: 'โหลดไม่สำเร็จ', message: 'ตรวจสอบอินเทอร์เน็ตแล้วลองใหม่',
      buttons: [{ text: 'ลองใหม่', cls: 'primary', onClick: function () { showWinnerDetail(r); } }, { text: 'ปิด', cls: 'ghost' }] });
    return;
  }
  hideBusy();
  if (res && res.expired) { showExpired(); return; }
  if (!res || !res.ok) {
    showDialog({ icon: 'ℹ️', title: 'ดูรายละเอียดไม่ได้', message: (res && res.message) || '',
      buttons: [{ text: 'ตกลง', cls: 'primary', onClick: showList }] });
    return;
  }

  const qs = res.questions || [];
  const maxSecs = Math.max.apply(null, [1].concat(qs.map(function (q) { return q.secs; })));
  const nRight = qs.filter(function (q) { return q.correct; }).length;
  const nRevisit = qs.filter(function (q) { return q.visits > 1; }).length;
  const nSkipReturn = qs.filter(function (q) { return q.skip_return; }).length;
  const avg = qs.length ? Math.round(qs.reduce(function (a, q) { return a + q.secs; }, 0) / qs.length) : 0;

  const rows = qs.map(function (q) {
    const color = q.correct ? '#15803d' : (q.answered ? '#b91c1c' : '#94a3b8');
    return h('tr', null,
      h('td', { text: String(q.q_order) }),
      h('td', { text: q.correct ? '✓' : (q.answered ? '✗' : '–'), style: 'color:' + color + ';font-weight:700' }),
      h('td', null,
        h('div', { text: fmtClock(q.secs) }),
        h('div', { style: 'margin-top:3px;height:6px;border-radius:3px;background:' + color + ';opacity:.7;width:' + Math.max(3, Math.round(100 * q.secs / maxSecs)) + '%' })),
      h('td', { text: q.visits > 1 ? 'เข้า ' + q.visits + ' รอบ' + (q.skip_return ? ' (ข้ามแล้วกลับมาทำ)' : '') : (q.visits === 1 ? '1 รอบ' : '–'),
                style: 'font-size:13px;color:#64748b' }));
  });

  mount(h('div', { class: 'wrap' },
    h('div', { class: 'topbar' }, h('a', { class: 'back', href: '#/', onclick: function (e) { e.preventDefault(); showList(); }, text: '‹ กลับหน้าประกาศผล' })),
    h('div', { class: 'page-title', text: (MEDAL[res.rank] || '#' + res.rank) + ' ' + res.nickname }),
    h('div', { class: 'hint', style: 'margin:2px 4px 0', text: (res.faculty ? 'คณะที่อยากเข้า: ' + res.faculty + '  •  ' : '') + r.set_name + '  •  Season: ' + r.season_name }),
    h('div', { class: 'panel' },
      h('div', { class: 'stats' },
        h('div', { class: 'stat' }, h('div', { class: 'sv', text: res.score + '/' + res.total }), h('div', { class: 'sl', text: 'คะแนน' })),
        h('div', { class: 'stat' }, h('div', { class: 'sv', text: fmtClock(res.total_secs) }), h('div', { class: 'sl', text: 'เวลารวม' })),
        h('div', { class: 'stat' }, h('div', { class: 'sv', text: fmtClock(avg) }), h('div', { class: 'sl', text: 'เฉลี่ยต่อข้อ' }))),
      h('div', { class: 'hint', style: 'margin-top:10px',
        text: 'กลับมาดูข้อเดิม ' + nRevisit + ' ข้อ  •  ข้ามแล้วกลับมาทำ ' + nSkipReturn + ' ข้อ  •  ถูก ' + nRight + ' ข้อ' })),
    h('div', { style: 'margin-top:14px' },
      btn('primary', '🎬 ย้อนดูการสอบ' + (res.is_me ? '' : ' เทียบกับของคุณ'), function () {
        showWinnerReplay(r, function () { showWinnerDetail(r); });
      })),
    h('div', { class: 'sec', text: 'เวลาและผลรายข้อ' }),
    h('div', { class: 'panel', style: 'margin-top:8px' },
      h('div', { class: 'cmp-wrap' },
        h('table', { class: 'cmp' },
          h('thead', null, h('tr', null, h('th', { text: 'ข้อ' }), h('th', { text: 'ผล' }), h('th', { text: 'เวลา' }), h('th', { text: 'การเข้าข้อ' }))),
          h('tbody', null, rows)))),
    h('div', { class: 'hint', style: 'margin:10px 4px', text: 'แถบแสดงสัดส่วนเวลาของแต่ละข้อเทียบกับข้อที่ใช้เวลานานที่สุด ลองเทียบกับตาราง Top 3 ในหน้า "ดูผลของฉัน" เพื่อดูว่าผู้ชนะแบ่งเวลาต่างจากคุณตรงไหน' })));
}

// หน้ารวมคะแนน/เวลารายข้อของผู้ชนะทุกคนในชุดเดียวกัน (ใช้ exam_winner_detail ต่อคน แล้วเอามาวางเทียบกันในตารางเดียว)
async function showWinnersDetail(g) {
  const list = g.rows.filter(function (r) { return r.can_detail; });
  showBusy('กำลังโหลด...');
  let all;
  try {
    all = await Promise.all(list.map(function (r) { return rpcRetry('exam_winner_detail', { p_token: S.token, p_winner_id: r.id }); }));
  } catch (e) {
    hideBusy();
    showDialog({ icon: '⚠️', title: 'โหลดไม่สำเร็จ', message: 'ตรวจสอบอินเทอร์เน็ตแล้วลองใหม่',
      buttons: [{ text: 'ลองใหม่', cls: 'primary', onClick: function () { showWinnersDetail(g); } }, { text: 'ปิด', cls: 'ghost' }] });
    return;
  }
  hideBusy();
  if (all.some(function (x) { return x && x.expired; })) { showExpired(); return; }
  const bad = all.filter(function (x) { return !x || !x.ok; })[0];
  if (bad || !all.length) {
    showDialog({ icon: 'ℹ️', title: 'ดูรายละเอียดไม่ได้', message: (bad && bad.message) || '',
      buttons: [{ text: 'ตกลง', cls: 'primary', onClick: showList }] });
    return;
  }

  const first = all[0].questions || [];
  const head = h('tr', null, h('th', { class: 'rowh', text: '' }), all.map(function (res) {
    return h('th', { class: res.is_me ? 'curcol' : '' },
      (MEDAL[res.rank] || '#' + res.rank) + ' ' + (res.nickname || ''),
      h('small', { text: 'อันดับ ' + res.rank + (res.is_me ? ' (คุณ)' : '') }));
  }));
  const rows = [
    h('tr', null, h('th', { class: 'rowh', text: 'คะแนน' }),
      all.map(function (res) { return h('td', { class: res.is_me ? 'curcol' : '', text: res.score + '/' + res.total }); })),
    h('tr', null, h('th', { class: 'rowh', text: 'เวลารวม' }),
      all.map(function (res) { return h('td', { class: res.is_me ? 'curcol' : '', text: fmtClock(res.total_secs) }); }))
  ];
  first.forEach(function (fq) {
    rows.push(h('tr', null, h('th', { class: 'rowh', text: 'ข้อ ' + fq.q_order }), all.map(function (res) {
      const q = (res.questions || []).filter(function (x) { return x.q_order === fq.q_order; })[0];
      if (!q) return h('td', { text: '–' });
      const mark = q.correct ? '✓ ' : q.answered ? '✗ ' : '– ';
      const sub = q.skip_return ? '↩ ข้ามก่อนแล้วกลับมาตอบ' : (q.visits > 1 ? 'เปิด ' + q.visits + ' ครั้ง' : '');
      return h('td', { class: (res.is_me ? 'curcol ' : '') + (q.correct ? 'ok' : q.answered ? 'bad' : '') },
        h('div', { text: !q.answered && !q.secs ? '–' : mark + fmtClock(q.secs) }),
        sub ? h('div', { class: 'tp-sub', text: sub }) : null);
    })));
  });

  mount(h('div', { class: 'wrap wide' },
    h('div', { class: 'topbar' }, h('a', { class: 'back', href: '#/', onclick: function (e) { e.preventDefault(); showList(); }, text: '‹ กลับหน้าประกาศผล' })),
    h('div', { class: 'page-title', text: 'คะแนนและเวลารายข้อของผู้ชนะ' }),
    h('div', { class: 'hint', style: 'margin:2px 4px 0', text: g.set + '  •  Season: ' + g.season }),
    h('div', { class: 'cmp-wrap' }, h('table', { class: 'cmp' }, h('thead', null, head), h('tbody', null, rows))),
    h('div', { style: 'margin-top:14px' },
      btn('primary', '🎬 ย้อนดูการสอบเทียบกับของคุณ', function () {
        showWinnerReplay(list[0], function () { showWinnersDetail(g); });
      }))));
}

// กระดานผู้ชนะ: จัดกลุ่มตาม season + ชุดสอบ แล้ววางเป็นโพเดียม (อันดับ 1 บนกลาง อันดับถัดไปแถวล่างซ้าย-ขวา)
// mine = สิทธิ์ของตัวเอง ใช้ติดป้าย "คุณ" และปุ่มถอนการประกาศ
function winnerBoardCards(board, mine, sets) {
  const mineById = {};
  (mine || []).forEach(function (w) { mineById[w.id] = w; });
  const groups = [];
  const index = {};
  board.forEach(function (r) {
    const key = r.season_name + '||' + r.set_name;
    if (index[key] === undefined) { index[key] = groups.length; groups.push({ season: r.season_name, set: r.set_name, rows: [] }); }
    groups[index[key]].rows.push(r);
  });
  return groups.map(function (g) {
    const pod = h('div', { class: 'wpod' + (g.rows.length >= 3 ? ' pod3' : '') });
    g.rows.forEach(function (r, i) {
      const me = mineById[r.id];
      const first = g.rows.length >= 3 && i === 0;   // 3 คนขึ้นไป: คนแรกอยู่บนกลาง
      pod.appendChild(h('div', { class: 'wcell' + (first ? ' first' : '') + (me ? ' me' : '') },
        h('div', { class: 'wcell-head' },
          (MEDAL[r.rank] || '#' + r.rank) + ' อันดับ ' + r.rank + (me ? '  ' : ''),
          me ? h('span', { class: 'tag', text: 'คุณ' }) : null),
        winnerLines(r, false)));
    });
    const myRes = (sets || []).filter(function (x) {
      return x.mode !== 'practice' && x.name === g.set && x.season_name === g.season && x.results && x.results.length;
    })[0];
    const canDetail = g.rows.some(function (r) { return r.can_detail; });
    const card = h('div', { class: 'card' },
      h('div', { class: 'wc-head' },
        h('div', null,
          h('div', { class: 'name', text: g.set }),
          h('div', { class: 'meta', text: 'Season: ' + g.season })),
        h('div', { class: 'wc-btns' },
          canDetail ? btn('ghost small', 'ดูคะแนนและเวลารายข้อของผู้ชนะ', function () { showWinnersDetail(g); }) : null,
          myRes ? btn('ghost small', 'ดูผลของฉัน', function () { showResult(myRes.results[0].attempt_id); }) : null)),
      pod);
    if (!g.rows.some(function (r) { return r.can_detail; })) {
      card.appendChild(h('div', { class: 'hint', style: 'margin-top:10px', text: 'ดูเวลารายข้อของผู้ชนะได้เฉพาะผู้ที่ทำชุดนี้จนจบแล้ว' }));
    }
    return card;
  });
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
    h('div', { class: 'name' }, h('span', { class: 'tag' + (isArena ? ' arena' : ''), text: isArena ? MINI_NAME : 'ฝึก' }), s.name),
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
  if (s.results && s.results.length) {
    const wrap = h('div', { class: 'resbtns' });
    s.results.forEach(function (r) {
      wrap.appendChild(h('button', {
        type: 'button', class: 'btn ghost small',
        text: isArena ? 'ดูผลของฉัน' : 'ดูผลรอบที่ ' + r.attempt_no,
        onclick: function () { showResult(r.attempt_id); }
      }));
    });
    card.appendChild(wrap);
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
    rules.push(MINI_NAME + ' สอบได้ 1 ครั้งต่อชุดต่อ season');
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
      message: (e && e.status && e.status < 500 && e.status !== 429)
      ? 'ระบบขัดข้อง (รหัส ' + e.status + ') กรุณาแจ้งครูพร้อมแคปหน้าจอนี้'
      : 'เชื่อมต่อไม่สำเร็จ กรุณาตรวจสอบอินเทอร์เน็ตแล้วลองใหม่ ถ้าไม่แน่ใจว่าเริ่มไปแล้วหรือยัง ให้กลับไปที่รายการข้อสอบแล้วดูปุ่ม "ทำต่อ"',
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
    if (res && res.closed) { renderDone(res.status, attemptId); return; }
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
  E.i = i;   // ไม่ส่ง leave: เซิร์ฟเวอร์ปิดข้อเดิมให้เองตอนได้ enter ข้อใหม่

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

  box.appendChild(stemNode(q.body, q.image_path));

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
  renderDone(status, E ? E.attemptId : 0);
}

function renderDone(status, attemptId) {
  stopTimer();
  E = null;
  try { history.replaceState(null, '', '#/'); } catch (e) { /* ไม่เป็นไร */ }
  const map = {
    submitted: ['✅', 'ส่งข้อสอบเรียบร้อย', 'ระบบบันทึกคำตอบและเวลาของคุณแล้ว'],
    timed_out: ['⏰', 'หมดเวลา', 'ระบบส่งข้อสอบให้อัตโนมัติ คำตอบที่เลือกไว้แล้วถูกนับ'],
    voided: ['ℹ️', 'รอบนี้ไม่นับ (ไม่ได้เข้าทำข้อใดเลยจนหมดเวลา หรือครูยกเลิกรอบให้) กลับไปรายการข้อสอบเพื่อเริ่มใหม่ได้']
  };
  const m = map[status] || ['✅', 'การสอบนี้จบแล้ว', ''];
  const canView = attemptId && status !== 'voided';
  screenMessage(m[0], m[1], m[2], [
    canView ? btn('primary', 'ดูผลของฉัน', function () { showResult(attemptId); }) : null,
    canView ? h('div', { style: 'height:8px' }) : null,
    btn(canView ? 'ghost' : 'primary', 'กลับรายการข้อสอบ', showList)
  ]);
}

/* ---------- 14.5) หน้าผลลัพธ์ ---------- */
async function showResult(attemptId, scrollToList) {
  E = null;
  showLoading('กำลังโหลดผลลัพธ์...');
  let res;
  try { res = await rpcRetry('exam_get_result', { p_token: S.token, p_attempt_id: attemptId }); }
  catch (e) {
    showError('โหลดผลลัพธ์ไม่สำเร็จ', 'ตรวจสอบอินเทอร์เน็ตแล้วลองใหม่', function () { showResult(attemptId); });
    return;
  }
  if (res && res.expired) { showExpired(); return; }
  if (!res || !res.ok) {
    screenMessage('ℹ️', 'ดูผลไม่ได้', (res && res.message) || '', [btn('primary', 'กลับรายการข้อสอบ', showList)]);
    return;
  }
  try { history.replaceState(null, '', '#/r/' + attemptId); } catch (e) { /* ไม่เป็นไร */ }
  res.my_attempt_id = attemptId;   // renderResult ใช้เปิดตัวย้อนดูการสอบ
  res.winner_cols = [];
  if (res.attempt && res.attempt.mode === 'arena') {
    try { res.winner_cols = await loadWinnerCols(res.attempt, attemptId); } catch (e) { res.winner_cols = []; }   // โหลดไม่ได้ก็แสดงแค่เวลาของคุณ
  }
  renderResult(res, scrollToList);
}

// เวลารายข้อของผู้ชนะที่ประกาศแล้วในชุดเดียวกัน (ใช้ชื่อเล่นแทน A/B/C) ยังไม่มีผู้ชนะ = ไม่มีคอลัมน์
async function loadWinnerCols(a, attemptId) {
  let season = a.season_name || null;
  if (!season && LAST_SETS) {
    const s = LAST_SETS.filter(function (x) {
      return (x.results || []).some(function (r) { return String(r.attempt_id) === String(attemptId); });
    })[0];
    if (s) season = s.season_name;
  }
  const ov = await rpcRetry('exam_winner_overview', { p_token: S.token }, 2);
  if (!ov || !ov.ok) return [];
  const rows = (ov.board || []).filter(function (r) {
    return r.set_name === a.set_name && (!season || r.season_name === season) && r.can_detail;
  }).sort(function (x, y) { return x.rank - y.rank; });
  const dets = await Promise.all(rows.map(function (r) {
    return rpcRetry('exam_winner_detail', { p_token: S.token, p_winner_id: r.id });
  }));
  const cols = [];
  dets.forEach(function (d) {
    if (!d || !d.ok || d.is_me) return;   // ของตัวเองมีคอลัมน์ "คุณ" อยู่แล้ว
    const byQ = {};
    (d.questions || []).forEach(function (q) { byQ[q.q_order] = q; });
    cols.push({ label: d.nickname || ('#' + d.rank), byQ: byQ });
  });
  return cols;
}

function statBox(label, value, sub) {
  return h('div', { class: 'stat' },
    h('div', { class: 'sv', text: String(value) }),
    h('div', { class: 'sl', text: label }),
    sub ? h('div', { class: 'ss', text: sub }) : null);
}

function renderResult(res, scrollToList) {
  const a = res.attempt;
  const sm = res.summary;
  const fl = res.flags || {};
  const isMini = a.mode === 'arena';
  const qs = res.questions || [];
  const hidden = !!res.answers_hidden;   // Mini Test ที่ season ยังไม่ล็อก: เซิร์ฟเวอร์ไม่ส่งเฉลย/คำอธิบายมา

  // นับผิด/ว่าง/ไม่ทัน ไว้เป็นบรรทัดเล็กใต้คะแนน
  const cnt = { wrong: 0, blank: 0, out_of_time: 0 };
  qs.forEach(function (q) { if (cnt[q.result] !== undefined) cnt[q.result]++; });
  const parts = [];
  if (cnt.wrong) parts.push('ผิด ' + cnt.wrong);
  if (cnt.blank) parts.push('ว่าง ' + cnt.blank);
  if (cnt.out_of_time) parts.push('ไม่ทัน ' + cnt.out_of_time);

  const root = h('div', { class: 'wrap' },
    h('div', { class: 'topbar' },
      h('a', { class: 'back', href: '#/', onclick: function (e) { e.preventDefault(); showList(); }, text: '‹ กลับรายการข้อสอบ' })),
    h('div', { class: 'page-title', text: 'ผลลัพธ์: ' + a.set_name }),
    h('div', { class: 'hint', style: 'margin:4px 4px 0' },
      h('span', { class: 'tag' + (isMini ? ' arena' : ''), text: isMini ? MINI_NAME : 'ฝึก' }),
      isMini ? '' : 'รอบที่ ' + a.attempt_no));

  // สรุป 3 อย่าง (Mini Test เพิ่มเปอร์เซ็นไทล์ความเร็ว)
  root.appendChild(h('div', { class: 'stats' },
    statBox('คะแนน', sm.score + ' / ' + sm.total, parts.length ? parts.join(' • ') : null),
    statBox('เวลารวมในข้อ', fmtClock(sm.time_secs)),
    isMini ? (function () {
      const noData = sm.speed_percentile === null || sm.speed_percentile === undefined;
      return statBox('เปอร์เซ็นไทล์ความเร็ว', noData ? '–' : sm.speed_percentile,
        noData ? 'ข้อมูลยังไม่พอ' : 'ยิ่งสูงยิ่งเร็ว (วัดเฉพาะข้อที่ตอบถูก)');
    })() : null));

  // โหมดฝึก: ปุ่มย้อนดูการสอบรอบนี้ (เล่น animation ตามลำดับเหตุการณ์จริง)
  if (!isMini && res.my_attempt_id) {
    root.appendChild(h('div', { style: 'margin-top:12px' },
      btn('primary', '🎬 ย้อนดูการสอบ (ดูพฤติกรรมทีละข้อ เทียบกับรอบอื่น)', function () { showAttemptReplay(res.my_attempt_id, a.set_name); })));
  }

  // หมายเหตุ: บรรทัดเดียว
  const notes = [];
  if (fl.timed_out) notes.push('หมดเวลา: ข้อที่ค้างนับเวลาถึงจุดหมดเวลา');
  if (fl.offline) notes.push('เน็ตหลุด: เวลาต่อข้ออาจคลาดเคลื่อน');
  if (fl.tab_hidden > 0) notes.push('ออกจากหน้าจอ ' + fl.tab_hidden + ' ครั้ง (เวลายังนับต่อ)');
  if (notes.length) root.appendChild(h('div', { class: 'noteline', text: 'หมายเหตุ: ' + notes.join(' • ') }));

  // โหมดฝึก: ตารางผลรายข้อ (รอบเป็นคอลัมน์ ข้อเป็นแถว กดชื่อรอบเพื่อดูรอบนั้น กดชื่อข้อเพื่อดูโจทย์+เฉลย)
  // ป้ายพฤติกรรม (ข้ามก่อนแล้วกลับมาตอบ / เปิดกี่ครั้ง / ติดดาว) อยู่ในช่องของรอบที่กำลังดู
  if (!isMini) {
    const multi = !!(res.compare && res.compare.length > 1);
    const cmp = multi ? res.compare : [{
      attempt_id: res.my_attempt_id, attempt_no: a.attempt_no, is_current: true,
      score: sm.score, time_secs: sm.time_secs,
      per_q: qs.map(function (q) { return { correct: q.result === 'correct', answered: !!q.my_answer, secs: q.secs }; })
    }];
    const nq = cmp[0].per_q.length;

    root.appendChild(h('div', { class: 'sec', id: 'qlist', text: multi ? 'เทียบกับรอบอื่นของคุณ' : 'ผลรายข้อ' }));
    root.appendChild(h('div', { class: 'hint', style: 'margin:2px 4px 0', text: 'แตะ \"ข้อ ...\" เพื่อดูโจทย์และเฉลย' }));

    const head = h('tr', null, h('th', { class: 'rowh', text: '' }),
      cmp.map(function (c) {
        return h('th', { class: c.is_current ? 'curcol' : '' },
          c.is_current
            ? h('span', { class: 'cur-r', text: 'รอบที่ ' + c.attempt_no + (multi ? ' (กำลังดู)' : '') })
            : h('button', { type: 'button', class: 'rb', text: 'รอบที่ ' + c.attempt_no,
                            onclick: function () { showResult(c.attempt_id, true); } }));
      }));

    function cmpRow(labelNode, cellFn) {
      return h('tr', null, h('th', { class: 'rowh' }, labelNode),
        cmp.map(function (c) {
          const cell = cellFn(c);
          return h('td', { class: (c.is_current ? 'curcol ' : '') + (cell.cls || '') },
            h('div', { text: cell.text }),
            (cell.subs || []).map(function (t) { return h('div', { class: 'tp-sub', text: t }); }));
        }));
    }
    function subsOf(q) {
      const t = [];
      if (q.skipped && q.my_answer) t.push('↩ ข้ามก่อนแล้วกลับมาตอบ');
      if (q.visits > 1) t.push('เปิด ' + q.visits + ' ครั้ง');
      if (q.marked) t.push('⚑ ติดดาว');
      return t;
    }
    const rows = [
      cmpRow('คะแนน', function (c) { return { text: c.score + '/' + nq }; }),
      cmpRow('เวลารวม', function (c) { return { text: fmtClock(c.time_secs) }; })
    ];
    for (let i = 0; i < nq; i++) {
      rows.push(cmpRow(
        h('button', { type: 'button', class: 'qrow-b', text: 'ข้อ ' + (qs[i] ? qs[i].q_order : i + 1),
                      onclick: function () { openQuestionModal(qs, i); } }),
        function (c) {
          const q = c.per_q[i];
          if (!q) return { text: '–' };
          const subs = c.is_current && qs[i] ? subsOf(qs[i]) : [];
          if (q.correct) return { text: '✓ ' + fmtClock(q.secs), cls: 'ok', subs: subs };
          if (q.answered) return { text: '✗ ' + fmtClock(q.secs), cls: 'bad', subs: subs };
          return { text: q.secs > 0 ? '– ' + fmtClock(q.secs) : '–', subs: subs };
        }));
    }
    root.appendChild(h('div', { class: 'cmp-wrap' },
      h('table', { class: 'cmp' }, h('thead', null, head), h('tbody', null, rows))));
    if (multi && a.attempt_no >= 2) {
      root.appendChild(h('div', { class: 'hint', style: 'margin:6px 4px 0', text: 'เวลาที่ลดลงส่วนหนึ่งอาจมาจากการจำข้อได้' }));
    }
  }

  // รายข้อ (เฉพาะ Mini Test: มีสถิติและ Top 3 ต่อข้อ / โหมดฝึกใช้ตารางด้านบนแทน)
  if (isMini) {
    root.appendChild(h('div', { class: 'sec', id: 'qlist', text: 'รายข้อ' }));
    if (hidden) {
      root.appendChild(h('div', { class: 'hint', style: 'margin:2px 4px 8px',
        text: '🔒 เฉลยและคำอธิบายของ ' + MINI_NAME + ' จะเปิดให้ดูเมื่อ season ถูกล็อกผล กลับมาดูอีกครั้งได้ที่ \"ดูผลของฉัน\"' }));
    }
    root.appendChild(questionPager(qs, a, isMini, hidden, res.winner_cols || []));
  }

  mount(root);
  if (scrollToList) {
    const el = $('qlist');
    if (el && el.scrollIntoView) el.scrollIntoView();
  }
}

function topProfileSection(res, qs) {
  const tp = res.top_profiles;
  if (!tp || !tp.people || !tp.people.length) return null;   // น้อยกว่าเกณฑ์ขั้นต่ำ: ไม่แสดงข้อความอะไรเลย
  const total = qs.length;
  const meInTop = tp.people.some(function (p) { return p.is_me; });

  // คอลัมน์: "คุณ" (ถ้าไม่ได้อยู่ใน Top 3) แล้วตามด้วยผู้ทำคะแนนสูงสุดเรียงตามอันดับ (A, B, C...)
  const cols = [];
  if (!meInTop) {
    const byQ = {};
    qs.forEach(function (q) {
      byQ[q.q_order] = { correct: q.result === 'correct', answered: !!q.my_answer, secs: q.secs,
                         visits: q.visits, skip_return: !!(q.skipped && q.my_answer) };
    });
    cols.push({ label: 'คุณ', me: true, rank: null, score: res.summary.score, total_secs: res.summary.time_secs, byQ: byQ });
  }
  let letter = 0;
  tp.people.forEach(function (p) {
    const byQ = {};
    (p.questions || []).forEach(function (q) { byQ[q.q_order] = q; });
    cols.push({ label: p.is_me ? 'คุณ' : String.fromCharCode(65 + (letter++)), me: p.is_me, rank: p.rank,
                score: p.score, total_secs: p.total_secs, byQ: byQ });
  });

  const head = h('tr', null, h('th', { class: 'rowh', text: '' }), cols.map(function (c) {
    return h('th', { class: c.me ? 'curcol' : '' }, c.label, c.rank ? h('small', { text: 'อันดับ ' + c.rank }) : null);
  }));
  const rows = [
    h('tr', null, h('th', { class: 'rowh', text: 'คะแนน' }),
      cols.map(function (c) { return h('td', { class: c.me ? 'curcol' : '', text: c.score + '/' + total }); })),
    h('tr', null, h('th', { class: 'rowh', text: 'เวลารวม' }),
      cols.map(function (c) { return h('td', { class: c.me ? 'curcol' : '', text: fmtClock(c.total_secs) }); }))
  ];
  qs.forEach(function (qq) {
    rows.push(h('tr', null, h('th', { class: 'rowh', text: 'ข้อ ' + qq.q_order }), cols.map(function (c) {
      const q = c.byQ[qq.q_order];
      if (!q) return h('td', { text: '–' });
      const mark = q.correct ? '✓ ' : q.answered ? '✗ ' : '– ';
      const t = !q.answered && !q.secs ? '–' : mark + fmtClock(q.secs);
      const sub = q.skip_return ? '↩ ข้ามก่อนแล้วกลับมาตอบ' : (q.visits > 1 ? 'เปิด ' + q.visits + ' ครั้ง' : '');
      return h('td', { class: (c.me ? 'curcol ' : '') + (q.correct ? 'ok' : q.answered ? 'bad' : '') },
        h('div', { text: t }), sub ? h('div', { class: 'tp-sub', text: sub }) : null);
    })));
  });

  // สรุปรูปแบบการทำของแต่ละคน
  const sums = cols.filter(function (c) { return c.rank; }).map(function (c) {
    const sr = [], rv = [];
    Object.keys(c.byQ).forEach(function (k) {
      const q = c.byQ[k];
      if (q.skip_return) sr.push(Number(k)); else if (q.visits > 1) rv.push(Number(k));
    });
    sr.sort(function (a, b) { return a - b; });
    const parts = [];
    if (sr.length) parts.push('ข้ามก่อนแล้วกลับมาตอบ ' + sr.length + ' ข้อ (ข้อ ' + sr.join(', ') + ')');
    if (rv.length) parts.push('เปิดซ้ำ ' + rv.length + ' ข้อ');
    return h('div', { text: c.label + ': ' + (parts.length ? parts.join(' • ') : 'ทำตามลำดับ ไม่ข้ามเลย') });
  });

  return h('div', null,
    h('div', { class: 'sec', text: 'วิธีทำข้อสอบของผู้ทำคะแนนสูงสุด' }),
    h('div', { class: 'hint', style: 'margin:2px 4px 0', text:
      (tp.provisional ? 'อันดับ ณ ตอนนี้ (season ยังไม่จบ อาจเปลี่ยนได้) • ' : '') +
      'จัดอันดับจากคะแนนสูงสุด ถ้าเท่ากันดูเวลารวมที่น้อยกว่า • ไม่แสดงชื่อผู้ทำข้อสอบ' }),
    h('div', { class: 'cmp-wrap' }, h('table', { class: 'cmp' }, h('thead', null, head), h('tbody', null, rows))),
    h('div', { class: 'tp-sum' }, sums));
}

// หน้าต่างโจทย์ + เฉลยของข้อที่กดจากตาราง (โหมดฝึก) เลื่อนไปข้อก่อนหน้า/ถัดไปได้ ปิดด้วย Esc หรือกดพื้นหลัง
function openQuestionModal(qs, idx) {
  const icons = { correct: '✅', wrong: '❌', blank: '⬜', out_of_time: '⏰' };
  const labels = { correct: 'ถูก', wrong: 'ผิด', blank: 'ว่าง', out_of_time: 'ไม่ทัน' };
  const prevFocus = document.activeElement;
  let i = idx;

  const title = h('div', { class: 'qm-title' });
  const content = h('div', { class: 'qm-content' });
  const closeB = h('button', { type: 'button', class: 'qm-x', 'aria-label': 'ปิด', text: '✕', onclick: close });
  const prevB = btn('ghost small', '‹ ข้อก่อนหน้า', function () { go(i - 1); });
  const nextB = btn('ghost small', 'ข้อถัดไป ›', function () { go(i + 1); });
  const ov = h('div', { class: 'qm-overlay' },
    h('div', { class: 'qm-sheet', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'โจทย์และเฉลย' },
      h('div', { class: 'qm-bar' }, title, closeB),
      content,
      h('div', { class: 'qm-nav' }, prevB, nextB)));

  function onKey(e) {
    if (e.key === 'Escape') close();
    else if (e.key === 'ArrowLeft') go(i - 1);
    else if (e.key === 'ArrowRight') go(i + 1);
  }
  function close() {
    document.removeEventListener('keydown', onKey);
    ov.remove();
    document.body.classList.remove('qm-open');
    if (prevFocus && prevFocus.focus) prevFocus.focus();
  }
  function go(n) { if (n >= 0 && n < qs.length) { i = n; draw(); } }
  function draw() {
    const q = qs[i];
    title.textContent = (icons[q.result] || '') + ' ข้อ ' + q.q_order + '  ' + (labels[q.result] || '') + '  •  ' + fmtClock(q.secs);
    content.textContent = '';
    content.appendChild(resultBody(q, false, false));
    content.scrollTop = 0;
    prevB.disabled = i === 0;
    nextB.disabled = i === qs.length - 1;
  }
  ov.addEventListener('click', function (e) { if (e.target === ov) close(); });
  document.addEventListener('keydown', onKey);
  document.body.appendChild(ov);
  document.body.classList.add('qm-open');
  draw();
  closeB.focus();
}

// รายข้อแบบการ์ดทีละหน้า: แถบเลขข้อด้านบน + ปุ่มก่อนหน้า/ถัดไป (การ์ดแสดงโจทย์เต็ม ตัวเลือก เฉลย และสถิติ)
function questionPager(qs, a, isMini, hidden, tcols) {
  if (!qs.length) return h('div', null);
  let cur = 0;
  const chips = h('div', { class: 'qp-chips', role: 'tablist' });
  const cardBox = h('div', null);
  const prev = btn('ghost', '‹ ข้อก่อนหน้า', function () { go(cur - 1, true); });
  const next = btn('primary', 'ข้อถัดไป ›', function () { go(cur + 1, true); });
  const box = h('div', null, chips, cardBox, h('div', { class: 'qp-nav' }, prev, next));

  function draw() {
    Array.prototype.forEach.call(chips.children, function (c, i) {
      c.className = 'qp-chip ' + (qs[i].result || '') + (i === cur ? ' on' : '');
      c.setAttribute('aria-selected', i === cur ? 'true' : 'false');
    });
    const el = chips.children[cur];
    if (el) chips.scrollLeft = el.offsetLeft - chips.clientWidth / 2 + el.offsetWidth / 2;
    cardBox.textContent = '';
    cardBox.appendChild(resultQuestion(qs[cur], a, isMini, hidden, tcols));
    prev.disabled = cur === 0;
    next.disabled = cur === qs.length - 1;
  }
  function go(i, scroll) {
    if (i < 0 || i >= qs.length) return;
    cur = i;
    draw();
    if (scroll && chips.scrollIntoView) chips.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }
  qs.forEach(function (q, i) {
    chips.appendChild(h('button', { type: 'button', role: 'tab', text: String(q.q_order), onclick: function () { go(i, false); } }));
  });
  draw();
  return box;
}

function resultQuestion(q, a, isMini, hidden, tcols) {
  const icons = { correct: '✅', wrong: '❌', blank: '⬜', out_of_time: '⏰' };
  const labels = { correct: 'ถูก', wrong: 'ผิด', blank: 'ว่าง', out_of_time: 'ไม่ทัน' };
  const badges = [];
  if (q.skipped && q.my_answer) badges.push('ข้ามก่อนแล้วกลับมาตอบ');
  if (q.visits > 1) badges.push('เปิดข้อนี้ ' + q.visits + ' ครั้ง');
  if (q.slow) badges.push('⏱ ใช้เวลานานเกิน ' + (a.slow_factor ? a.slow_factor + ' เท่า' : 'เกณฑ์') + 'ของค่าเฉลี่ย');
  if (q.marked) badges.push('⚑ ติดดาว');

  const sum = h('div', { class: 'rq-sum' },
    h('div', { class: 'rq-row' },
      h('span', { class: 'rq-ic', text: icons[q.result] || '' }),
      h('span', { class: 'rq-n', text: 'ข้อ ' + q.q_order }),
      h('span', { class: 'rq-l', text: labels[q.result] || '' }),
      timesBlock(q, tcols)),
    badges.length ? h('div', { class: 'rq-badges' }, badges.map(function (b) { return h('span', { class: 'bd', text: b }); })) : null);

  return h('div', { class: 'rq ' + q.result }, sum, resultBody(q, isMini, hidden));
}

function timesBlock(q, tcols) {
  const items = [h('span', { class: q.result === 'correct' ? 'ok' : (q.my_answer ? 'bad' : '') }, h('b', { text: 'คุณ' }), fmtClock(q.secs))];
  (tcols || []).forEach(function (c) {
    const x = c.byQ[q.q_order];
    const has = x && (x.answered || x.secs);
    items.push(h('span', { class: has ? (x.correct ? 'ok' : (x.answered ? 'bad' : '')) : '' }, h('b', { text: c.label }), has ? fmtClock(x.secs) : '–'));
  });
  return h('div', { class: 'rq-times' }, h('div', { class: 'rq-tl', text: 'เวลาที่ใช้' }), h('div', { class: 'rq-tv' }, items));
}

function resultBody(q, isMini, hidden) {
  const box = h('div', { class: 'rq-body' });
  box.appendChild(stemNode(q.body, q.image_path));

  if (q.qtype === 'mcq') {
    const correct = (q.correct_answers || []).map(function (x) { return String(x).toUpperCase(); });
    const mine = String(q.my_answer || '').toUpperCase();
    const choices = q.choices || [];
    const grid = choices.some(function (c) { return c.image_path; });
    box.appendChild(h('div', { class: 'choices' + (grid ? ' grid' : '') }, choices.map(function (c) {
      const id = String(c.id).toUpperCase();
      const isC = !hidden && correct.indexOf(id) >= 0;
      const isMine = mine === id;
      return h('div', { class: 'choice rs' + (isC ? ' good' : '') + (isMine && !isC && !hidden ? ' bad' : '') + (isMine ? ' mine' : '') },
        h('span', { class: 'letter', text: c.id }),
        h('span', { class: 'ctext' },
          c.text ? h('span', { text: c.text }) : null,
          c.image_path ? imgEl(c.image_path) : null,
          isC || isMine ? h('span', { class: 'tagl', text: hidden ? 'คำตอบของคุณ' : isC ? (isMine ? '✓ คำตอบของคุณ (ถูก)' : '✓ เฉลย') : '✗ คำตอบของคุณ' }) : null));
    })));
    if (!mine) box.appendChild(h('div', { class: 'hint', style: 'margin-top:8px', text: 'คุณไม่ได้ตอบข้อนี้' }));
  } else {
    box.appendChild(h('div', { class: 'numrow' },
      h('div', { text: 'คำตอบของคุณ: ' + (q.my_answer ? q.my_answer : '(ไม่ได้ตอบ)') }),
      hidden ? null : h('div', { text: 'คำตอบที่ถูก: ' + (q.correct_answers || []).join('  หรือ  ') })));
  }

  if (q.explanation) {
    box.appendChild(h('div', { class: 'expl' }, h('b', { text: 'คำอธิบาย' }), h('div', { text: q.explanation })));
  }

  if (isMini) {
    const rows = [
      h('div', { text: '% คนตอบถูก: ' + (q.pct_correct === null || q.pct_correct === undefined ? 'ข้อมูลยังไม่พอ' : q.pct_correct + '%') }),
      h('div', { text: 'เวลาเฉลี่ยของคนตอบถูก: ' + (q.avg_secs_correct === null || q.avg_secs_correct === undefined
        ? 'ข้อมูลยังไม่พอ' : fmtClock(q.avg_secs_correct) + ' (ของคุณ ' + fmtClock(q.secs) + ')') })
    ];
    box.appendChild(h('div', { class: 'mstats' }, rows));
  }
  renderMath(box);
  return box;
}

/* ---------- 15) เริ่มทำงาน ---------- */
$('dlg').addEventListener('click', function (e) {
  if (e.target === $('dlg')) closeDialog();
});
document.addEventListener('keydown', function (e) {
  if (e.key === 'Escape' && $('dlg').classList.contains('open')) closeDialog();
});
boot();
