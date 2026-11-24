'use strict';

/* =====================================================================
   หน้าครู ส่วนที่ 2 (4b): Season + ชุดข้อสอบ
   ใช้ตัวช่วยจาก app.js (h, btn, api, rpc, shell, mount, showDialog, showBusy, handleErr ...)
   - บันทึกชุดพร้อมรายการข้อผ่าน exam_admin_save_set (ทรานแซกชันเดียว)
   - ชุดที่มีคนสอบแล้ว: แก้รายการข้อ/เวลาสอบ/season ไม่ได้ (ฐานข้อมูลบังคับ หน้าเว็บแค่ปิดปุ่มและอธิบาย)
   ===================================================================== */

/* ---------- วันที่ (ใช้เวลาไทยเสมอ ไม่ขึ้นกับเครื่องที่เปิด) ---------- */
function fmtDT(iso) {
  if (!iso) return '-';
  try {
    return new Date(iso).toLocaleString('th-TH', {
      timeZone: 'Asia/Bangkok', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit'
    });
  } catch (e) { return String(iso); }
}
function toLocalInput(iso) {            // สำหรับช่อง datetime-local: "YYYY-MM-DDTHH:mm" เวลาไทย
  if (!iso) return '';
  try {
    const p = new Intl.DateTimeFormat('sv-SE', {
      timeZone: 'Asia/Bangkok', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
    }).format(new Date(iso));
    return p.replace(' ', 'T');
  } catch (e) { return ''; }
}
function fromLocalInput(v) {            // ตีความค่าในช่องเป็นเวลาไทย (+07:00)
  return v ? v + ':00+07:00' : null;
}

function seasonState(s) {
  const now = Date.now();
  if (s.locked) return { t: 'ล็อกผลแล้ว', c: 'gray' };
  if (now < new Date(s.starts_at).getTime()) return { t: 'ยังไม่เริ่ม', c: 'gray' };
  if (now >= new Date(s.ends_at).getTime()) return { t: 'จบแล้ว (รอล็อกผล)', c: 'mini' };
  return { t: 'กำลังเปิด', c: '' };
}

function formRow(label, control, hint) {
  return h('div', { class: 'field' }, h('label', { class: 'lb', text: label }), control,
    hint ? h('div', { class: 'hint', text: hint }) : null);
}
function numInput(value, min, max, step, onInput) {
  const i = h('input', { type: 'number', value: String(value === null || value === undefined ? '' : value),
    min: String(min), max: String(max), step: String(step || 1) });
  i.oninput = function () { onInput(i.value); };
  return i;
}
function dtInput(value, onInput) {
  const i = h('input', { type: 'datetime-local', value: value || '' });
  i.oninput = function () { onInput(i.value); };
  i.onchange = i.oninput;
  return i;
}

/* =====================================================================
   Season
   ===================================================================== */
let SS = null;   // state ของตัวแก้ไข season

async function showSeasons(msg) {
  SS = null; SE = null;
  showBusy('กำลังโหลด season...');
  let rows;
  try { rows = await api('GET', 'exam_seasons?select=*,exam_sets(count)&order=starts_at.desc'); }
  catch (e) { hideBusy(); handleErr(e, 'โหลด season ไม่สำเร็จ'); return; }
  hideBusy();

  const body = h('div', null,
    msg ? h('div', { class: 'msgbox ok', text: msg }) : null,
    h('div', { class: 'toolbar' }, h('span', { class: 'grow' }), btn('primary', '+ สร้าง season', function () { openSeasonEditor(null); })));
  if (!rows.length) {
    body.appendChild(h('div', { class: 'hint', style: 'margin:16px 4px', text: 'ยังไม่มี season กด "+ สร้าง season" เพื่อเริ่ม (Season ใช้กับชุด Mini Test เท่านั้น)' }));
  }
  rows.forEach(function (s) {
    const st = seasonState(s);
    const nSets = s.exam_sets && s.exam_sets[0] ? s.exam_sets[0].count : 0;
    body.appendChild(h('div', { class: 'qitem' },
      h('div', { class: 'qid', text: '#' + s.id }),
      h('div', { class: 'qmain' },
        h('div', { class: 'qsnip', text: s.name }),
        h('div', { class: 'hint', text: fmtDT(s.starts_at) + '  ถึง  ' + fmtDT(s.ends_at) }),
        h('div', { class: 'qmeta' },
          h('span', { class: 'tag ' + st.c, text: st.t }),
          h('span', { class: 'tag gray', text: 'ป้ายกินเวลา: เกิน ' + s.slow_factor + ' เท่า' }),
          h('span', { class: 'tag gray', text: 'คนขั้นต่ำ ' + s.min_people + ' คน' }),
          h('span', { class: 'tag gray', text: nSets + ' ชุด' }))),
      h('div', { class: 'qact' },
        btn('ghost small', s.locked ? 'ดู' : 'แก้ไข', function () { openSeasonEditor(s); }),
        s.locked ? btn('ghost small', 'ผู้ชนะ', function () { showWinners(s); }) : null,
        btn('ghost small', s.locked ? 'ปลดล็อกผล' : 'ล็อกผล', function () { confirmSeasonLock(s); }),
        s.locked ? null : btn('ghost small', 'ลบ', function () { confirmDeleteSeason(s, nSets); }))));
  });
  mount(shell('seasons', body));
}

function confirmDeleteSeason(s, nSets) {
  showDialog({
    icon: '🗑️', title: 'ลบ season',
    message: 'ลบ season "' + s.name + '" ?' + (nSets ? '\n\nมีชุดข้อสอบ ' + nSets + ' ชุดใช้อยู่ ลบไม่ได้' : ''),
    buttons: [
      { text: 'ไม่ลบ', cls: 'ghost', focus: true },
      { text: 'ลบ', cls: 'danger', onClick: async function () {
        showBusy('กำลังลบ...');
        try { await rpc('exam_admin_delete_season', { p_season_id: s.id }); }
        catch (e) { hideBusy(); handleErr(e, 'ลบไม่สำเร็จ'); return; }
        hideBusy();
        showSeasons();
      } }
    ]
  });
}

function openSeasonEditor(s) {
  SS = s ? {
    id: s.id, locked: !!s.locked, name: s.name, starts: toLocalInput(s.starts_at), ends: toLocalInput(s.ends_at),
    slow: s.slow_factor, min: s.min_people, dirty: false
  } : {
    id: null, locked: false, name: '', starts: toLocalInput(new Date().toISOString()), ends: '', slow: 2, min: 5, dirty: false
  };
  renderSeasonEditor();
}

function renderSeasonEditor() {
  const ss = SS;
  const dis = ss.locked;
  const name = h('input', { type: 'text', value: ss.name, placeholder: 'เช่น Season 1 (ธ.ค.)' });
  name.oninput = function () { ss.name = name.value; ss.dirty = true; };
  if (dis) { name.disabled = true; }
  const starts = dtInput(ss.starts, function (v) { ss.starts = v; ss.dirty = true; });
  const ends = dtInput(ss.ends, function (v) { ss.ends = v; ss.dirty = true; });
  const slow = numInput(ss.slow, 1.1, 20, 0.1, function (v) { ss.slow = v; ss.dirty = true; });
  const min = numInput(ss.min, 1, 1000, 1, function (v) { ss.min = v; ss.dirty = true; });
  if (dis) { starts.disabled = ends.disabled = slow.disabled = min.disabled = true; }

  const msg = h('div', { id: 'ssMsg' });
  const save = btn('primary', 'บันทึก', async function () {
    const err = validateSeason();
    if (err) { msg.className = 'msgbox err'; msg.textContent = err; return; }
    showBusy('กำลังบันทึก...');
    try {
      await rpc('exam_admin_save_season', {
        p_season_id: ss.id, p_name: ss.name.trim(), p_starts: fromLocalInput(ss.starts),
        p_ends: fromLocalInput(ss.ends), p_slow: Number(ss.slow), p_min: Number(ss.min)
      });
    } catch (e) {
      hideBusy();
      if (isAuthError(e)) { handleErr(e); return; }
      msg.className = 'msgbox err'; msg.textContent = 'บันทึกไม่สำเร็จ: ' + e.message;
      return;
    }
    hideBusy();
    ss.dirty = false;
    showSeasons();
  });

  const back = btn('ghost small', '‹ กลับรายการ season', function () {
    if (ss.dirty) {
      showDialog({ icon: '❓', title: 'ยังไม่ได้บันทึก', message: 'การแก้ไขที่ยังไม่บันทึกจะหายไป ต้องการออกไหม?',
        buttons: [{ text: 'อยู่ต่อ', cls: 'ghost', focus: true }, { text: 'ออก', cls: 'danger', onClick: function () { ss.dirty = false; showSeasons(); } }] });
    } else { showSeasons(); }
  });

  mount(h('div', { class: 'wrap' },
    h('div', { class: 'topbar' }, back, h('div', { class: 'who', text: 'เข้าสู่ระบบ: ' + (SESS ? SESS.user.email : '') })),
    h('div', { class: 'card', style: 'margin-top:12px' },
      h('h3', { text: ss.id ? 'แก้ season #' + ss.id : 'สร้าง season ใหม่' }),
      dis ? h('div', { class: 'msgbox info', text: 'season นี้ล็อกผลแล้ว แก้ไขไม่ได้' }) : null,
      formRow('ชื่อ season', name),
      formRow('วันเริ่ม (เวลาไทย)', starts, 'นักเรียนเริ่มสอบชุด Mini Test ของ season นี้ได้ตั้งแต่เวลานี้'),
      formRow('วันจบ (เวลาไทย)', ends, 'ระบบไม่ให้เริ่มสอบถ้าเวลาที่เหลือของ season น้อยกว่าเวลาสอบของชุด (ทุกรอบจบก่อน season จบ)'),
      formRow('ป้าย "ข้อนี้กินเวลานานเกิน X เท่า" ค่า X', slow, 'เทียบกับเวลาเฉลี่ยของคนที่ตอบถูกข้อนั้น (ค่าเริ่มต้น 2)'),
      formRow('จำนวนคนขั้นต่ำก่อนแสดงสถิติ', min, 'ต่ำกว่านี้จะไม่แสดงเวลาเฉลี่ย ป้ายกินเวลา และเปอร์เซ็นไทล์ (ค่าเริ่มต้น 5)'),
      ss.id ? h('div', { class: 'hint', style: 'margin-top:8px', text: 'ถ้ามีคนสอบใน season นี้แล้ว จะเปลี่ยนวันเริ่มหรือร่นวันจบไม่ได้ (ขยายวันจบออกไปได้) ส่วนเกณฑ์ป้ายกินเวลาและจำนวนคนขั้นต่ำเปลี่ยนได้ และมีผลกับการแสดงผลของรอบที่ผ่านมาด้วย' }) : null),
    msg,
    dis ? null : h('div', { class: 'savebar' }, save)));
}

function validateSeason() {
  const ss = SS;
  if (!ss.name.trim()) return 'กรุณาตั้งชื่อ season';
  if (!ss.starts || !ss.ends) return 'กรุณาระบุวันเริ่มและวันจบ';
  if (fromLocalInput(ss.ends) <= fromLocalInput(ss.starts)) return 'วันจบต้องหลังวันเริ่ม';
  const slow = Number(ss.slow), min = Number(ss.min);
  if (!(slow > 1) || slow > 20) return 'เกณฑ์ป้ายกินเวลาต้องมากกว่า 1 เท่า (และไม่เกิน 20)';
  if (!(min >= 1) || min > 1000 || Math.floor(min) !== min) return 'จำนวนคนขั้นต่ำต้องเป็นจำนวนเต็ม 1 ถึง 1000';
  return '';
}

/* =====================================================================
   ชุดข้อสอบ
   ===================================================================== */
let SE = null;   // state ของตัวแก้ไขชุด

async function showSets() {
  SS = null; SE = null;
  showBusy('กำลังโหลดชุดข้อสอบ...');
  let rows;
  try { rows = await rpc('exam_admin_list_sets', {}); }
  catch (e) { hideBusy(); handleErr(e, 'โหลดชุดข้อสอบไม่สำเร็จ'); return; }
  hideBusy();

  const body = h('div', null,
    h('div', { class: 'toolbar' }, h('span', { class: 'grow' }), btn('primary', '+ สร้างชุดข้อสอบ', function () { openSetEditor(null); })));
  if (!rows.length) {
    body.appendChild(h('div', { class: 'hint', style: 'margin:16px 4px', text: 'ยังไม่มีชุดข้อสอบ กด "+ สร้างชุดข้อสอบ" เพื่อเริ่ม' }));
  }
  rows.forEach(function (s) {
    const isMini = s.mode === 'arena';
    body.appendChild(h('div', { class: 'qitem' },
      h('div', { class: 'qid', text: '#' + s.id }),
      h('div', { class: 'qmain' },
        h('div', { class: 'qsnip', text: s.name }),
        h('div', { class: 'hint', text: 'เปิด ' + fmtDT(s.opens_at) + (s.closes_at ? '  ปิด ' + fmtDT(s.closes_at) : '  (ไม่กำหนดวันปิด)') }),
        h('div', { class: 'qmeta' },
          h('span', { class: 'tag' + (isMini ? ' mini' : ''), text: isMini ? MINI_NAME : 'ฝึก' }),
          h('span', { class: 'tag gray', text: s.duration_minutes + ' นาที' }),
          h('span', { class: 'tag gray', text: s.n_questions + ' ข้อ' }),
          isMini && s.season_name ? h('span', { class: 'tag gray', text: 'Season: ' + s.season_name }) : null,
          !isMini ? h('span', { class: 'tag gray', text: 'ฝึกได้ ' + s.practice_attempts_allowed + ' รอบ' }) : null,
          s.n_attempts_all > 0 ? h('span', { class: 'tag', text: 'มีคนสอบแล้ว ' + s.n_attempts + ' รอบ' }) : null,
          s.n_questions === 0 ? h('span', { class: 'tag mini', text: 'ยังไม่มีข้อ (นักเรียนเริ่มสอบไม่ได้)' }) : null)),
      h('div', { class: 'qact' },
        btn('ghost small', 'แก้ไข', function () { openSetEditor(s.id); }),
        btn('ghost small', 'ผู้สอบ', function () { showAttempts(s); }),
        btn('ghost small', 'ทำสำเนา', function () { openSetEditor(null, null, s.id); }),
        btn('ghost small', 'ลบ', function () { confirmDeleteSet(s); }))));
  });
  mount(shell('sets', body));
}

function confirmDeleteSet(s) {
  showDialog({
    icon: '🗑️', title: 'ลบชุดข้อสอบ',
    message: 'ลบชุด "' + s.name + '" ?\n(ข้อสอบในคลังไม่ถูกลบ)' +
      (s.n_attempts_all > 0 ? '\n\nชุดนี้มีคนสอบแล้ว ลบไม่ได้' : ''),
    buttons: [
      { text: 'ไม่ลบ', cls: 'ghost', focus: true },
      { text: 'ลบ', cls: 'danger', onClick: async function () {
        showBusy('กำลังลบ...');
        try { await rpc('exam_admin_delete_set', { p_set_id: s.id }); }
        catch (e) { hideBusy(); handleErr(e, 'ลบไม่สำเร็จ'); return; }
        hideBusy();
        showSets();
      } }
    ]
  });
}

function blankSet() {
  return {
    id: null, mode: 'practice', name: '', seasonId: null, duration: 35,
    opens: toLocalInput(new Date().toISOString()), closes: '', allowed: 3,
    items: [], nAttempts: 0, nAll: 0, seasons: [], dirty: false, msg: null, rendered: false
  };
}

async function openSetEditor(id, msg, copyFromId) {
  showBusy('กำลังโหลด...');
  const srcId = id || copyFromId || null;
  let seasons, setRows, listRows, vers = [];
  try {
    seasons = await api('GET', 'exam_seasons?select=id,name,starts_at,ends_at,locked&order=starts_at.desc');
    if (srcId) {
      setRows = await api('GET', 'exam_sets?id=eq.' + encodeURIComponent(srcId) +
        '&select=*,exam_set_questions(q_order,question_version_id,exam_question_versions(id,version_no,qtype,body,question_id))' +
        '&exam_set_questions.order=q_order');
      listRows = id ? await rpc('exam_admin_list_sets', {}) : [];
    }
  } catch (e) { hideBusy(); handleErr(e, 'โหลดไม่สำเร็จ'); return; }

  const se = blankSet();
  se.seasons = seasons || [];
  if (srcId) {
    if (!setRows || !setRows.length) { hideBusy(); handleErr(new Error('ไม่พบชุดข้อสอบนี้'), 'โหลดไม่สำเร็จ'); return; }
    const r = setRows[0];
    se.mode = r.mode;
    se.name = r.name;
    se.seasonId = r.season_id;
    se.duration = r.duration_minutes;
    se.opens = toLocalInput(r.opens_at);
    se.closes = toLocalInput(r.closes_at);
    se.allowed = r.practice_attempts_allowed;
    se.items = (r.exam_set_questions || []).map(function (q) {
      const v = Array.isArray(q.exam_question_versions) ? q.exam_question_versions[0] : q.exam_question_versions;
      return { qv: q.question_version_id, qid: v ? v.question_id : null, vno: v ? v.version_no : 0,
               qtype: v ? v.qtype : '', body: v ? v.body : '', maxNo: v ? v.version_no : 0 };
    });
    if (id) {
      se.id = id;
      const info = (listRows || []).filter(function (x) { return x.id === id; })[0];
      if (info) { se.nAttempts = info.n_attempts; se.nAll = info.n_attempts_all; }
    } else {
      se.name = se.name + ' (สำเนา)';
      se.dirty = true;
    }
    // เวอร์ชันล่าสุดของแต่ละข้อ (เพื่อแจ้งเตือนว่ามีเวอร์ชันใหม่กว่า)
    const qids = se.items.map(function (i) { return i.qid; }).filter(function (x) { return x !== null; });
    if (qids.length) {
      try {
        vers = await api('GET', 'exam_question_versions?select=id,question_id,version_no&question_id=in.(' + qids.join(',') + ')');
      } catch (e) { vers = []; }
      se.items.forEach(function (it) {
        vers.forEach(function (v) {
          if (v.question_id === it.qid && v.version_no > it.maxNo) { it.maxNo = v.version_no; it.latestId = v.id; }
        });
      });
    }
  }
  hideBusy();
  se.msg = msg || null;
  SE = se;
  renderSetEditor();
}

function setMsgBox(text, cls) {
  const m = $('seMsg');
  if (!m) return;
  m.className = text ? 'msgbox ' + (cls || 'info') : '';
  m.textContent = text || '';
}

function renderSetEditor() {
  const se = SE;
  const isNew = se.id === null;
  const locked = se.nAll > 0;                       // มีรอบสอบแล้ว (รวมรอบที่ไม่นับ)
  const isMini = se.mode === 'arena';
  const dirty = function () { se.dirty = true; };

  // --- โหมด ---
  let modeBox;
  if (isNew) {
    const mk = function (val, title, sub) {
      const r = h('input', { type: 'radio', name: 'mode', value: val });
      r.checked = se.mode === val;
      r.onchange = function () {
        if (se.items.length && se.mode !== val) {
          showDialog({ icon: '⚠️', title: 'เปลี่ยนโหมดไม่ได้ขณะมีข้อในชุด',
            message: 'ข้อฝึกและข้อ ' + MINI_NAME + ' ปนกันไม่ได้ ต้องเอาข้อทั้งหมดออกจากชุดก่อนจึงจะเปลี่ยนโหมดได้',
            buttons: [{ text: 'ตกลง', cls: 'primary' }] });
          r.checked = false;
          renderSetEditor();
          return;
        }
        se.mode = val; dirty(); renderSetEditor();
      };
      return h('label', { class: 'pool-opt' }, r, h('span', null, title, h('small', { text: sub })));
    };
    modeBox = h('div', null,
      h('div', { class: 'pools' }, mk('practice', 'ชุดฝึก', 'ทำได้หลายรอบ ไม่มีอันดับ'),
        mk('arena', 'ชุด ' + MINI_NAME, 'ผูกกับ season สอบได้ 1 ครั้ง มีสถิติ')),
      h('div', { class: 'hint', style: 'margin-top:6px', text: '⚠ เลือกแล้วเปลี่ยนทีหลังไม่ได้' }));
  } else {
    modeBox = h('div', null,
      h('span', { class: 'tag' + (isMini ? ' mini' : ''), text: isMini ? 'ชุด ' + MINI_NAME : 'ชุดฝึก' }),
      h('span', { class: 'hint', text: '  (เปลี่ยนไม่ได้)  ชุด #' + se.id }));
  }

  // --- ช่องกรอก ---
  const name = h('input', { type: 'text', value: se.name, placeholder: isMini ? 'เช่น Mini Test 1 (Module 2)' : 'เช่น ชุดฝึก Algebra 1' });
  name.oninput = function () { se.name = name.value; dirty(); };

  let seasonField = null;
  if (isMini) {
    const sel = h('select', { 'aria-label': 'season' }, [h('option', { value: '', text: '(เลือก season)' })].concat(
      se.seasons.map(function (s) {
        return h('option', { value: String(s.id), text: s.name + (s.locked ? ' (ล็อกแล้ว)' : '') });
      })));
    sel.value = se.seasonId ? String(se.seasonId) : '';
    sel.onchange = function () { se.seasonId = sel.value ? Number(sel.value) : null; dirty(); };
    if (locked) sel.disabled = true;
    seasonField = formRow('Season', sel, se.seasons.length ? (locked ? 'ชุดนี้มีคนสอบแล้ว เปลี่ยน season ไม่ได้' : null) : 'ยังไม่มี season ไปสร้างที่แท็บ Season ก่อน');
  }

  const duration = numInput(se.duration, 1, 600, 1, function (v) { se.duration = v; dirty(); });
  if (locked) duration.disabled = true;
  const opens = dtInput(se.opens, function (v) { se.opens = v; dirty(); });
  const closes = dtInput(se.closes, function (v) { se.closes = v; dirty(); });
  const allowed = isMini ? null : numInput(se.allowed, 0, 100, 1, function (v) { se.allowed = v; dirty(); });

  // --- รายการข้อ ---
  const itemsBox = h('div', null);
  if (!se.items.length) {
    itemsBox.appendChild(h('div', { class: 'hint', style: 'margin-top:8px', text: 'ยังไม่มีข้อในชุด กด "+ เพิ่มข้อจากคลัง"' }));
  }
  se.items.forEach(function (it, i) {
    const up = btn('ghost small', '↑', function () { moveItem(i, -1); });
    const down = btn('ghost small', '↓', function () { moveItem(i, 1); });
    up.disabled = locked || i === 0;
    down.disabled = locked || i === se.items.length - 1;
    const rm = btn('ghost small', 'เอาออก', function () { se.items.splice(i, 1); dirty(); renderSetEditor(); });
    rm.disabled = locked;
    const newer = !locked && it.maxNo > it.vno && it.latestId;
    itemsBox.appendChild(h('div', { class: 'crow' },
      h('div', { class: 'letter', text: String(i + 1) }),
      h('div', { class: 'cbody' },
        h('div', { class: 'qsnip', text: snippet(it.body, 110) }),
        h('div', { class: 'qmeta' },
          h('span', { class: 'tag gray', text: '#' + it.qid + ' v' + it.vno }),
          h('span', { class: 'tag gray', text: TYPE_LABEL[it.qtype] || it.qtype }),
          it.maxNo > it.vno ? h('span', { class: 'tag mini', text: 'มีเวอร์ชันใหม่กว่า v' + it.maxNo }) : null),
        newer ? h('div', { style: 'margin-top:6px' }, btn('ghost small', 'ใช้เวอร์ชันล่าสุด (v' + it.maxNo + ')', function () {
          it.qv = it.latestId; it.vno = it.maxNo; dirty(); renderSetEditor();
        })) : null),
      h('div', { class: 'qact' }, up, down, rm)));
  });
  const addBtn = btn('ghost', '+ เพิ่มข้อจากคลัง', openPicker);
  addBtn.disabled = locked;

  const save = btn('primary', 'บันทึกชุดข้อสอบ', saveSet);
  const back = btn('ghost small', '‹ กลับรายการชุด', function () {
    if (se.dirty) {
      showDialog({ icon: '❓', title: 'ยังไม่ได้บันทึก', message: 'การแก้ไขที่ยังไม่บันทึกจะหายไป ต้องการออกไหม?',
        buttons: [{ text: 'อยู่ต่อ', cls: 'ghost', focus: true }, { text: 'ออก', cls: 'danger', onClick: function () { se.dirty = false; showSets(); } }] });
    } else { showSets(); }
  });

  const root = h('div', { class: 'wrap' },
    h('div', { class: 'topbar' }, back, h('div', { class: 'who', text: 'เข้าสู่ระบบ: ' + (SESS ? SESS.user.email : '') })),
    h('div', { class: 'card', style: 'margin-top:12px' },
      h('h3', { text: isNew ? 'สร้างชุดข้อสอบ' : 'แก้ชุด #' + se.id }),
      locked ? h('div', { class: 'msgbox info', text: 'ชุดนี้มีคนสอบแล้ว (' + se.nAttempts + ' รอบ) แก้รายการข้อ เวลาสอบ และ season ไม่ได้ เพื่อให้คะแนนและอันดับเทียบกันได้ ถ้าต้องการเปลี่ยน ให้ "ทำสำเนา" เป็นชุดใหม่ ส่วนชื่อ วันเปิด/ปิด และจำนวนรอบฝึก ยังแก้ได้' }) : null,
      formRow('โหมด', modeBox),
      formRow('ชื่อชุด', name),
      seasonField,
      formRow('เวลาสอบ (นาที)', duration, locked ? 'ชุดนี้มีคนสอบแล้ว เปลี่ยนเวลาสอบไม่ได้ (ถ้าต้องการ ให้ทำสำเนาเป็นชุดใหม่)' : 'Digital SAT Math แต่ละ module = 35 นาที'),
      formRow('วันเปิด (เวลาไทย)', opens),
      formRow('วันปิด (เวลาไทย, ไม่บังคับ)', closes, 'เว้นว่างไว้ = ไม่ปิด'),
      allowed ? formRow('จำนวนรอบฝึกที่ทำได้', allowed, 'ครูปลดล็อกเพิ่มรายคนได้ภายหลัง (ค่าเริ่มต้น 3)') : null),
    h('div', { class: 'card' },
      h('h3', { text: 'ข้อในชุด (' + se.items.length + ' ข้อ) — ' + (isMini ? 'เลือกได้เฉพาะข้อ ' + MINI_NAME : 'เลือกได้เฉพาะข้อฝึก') }),
      itemsBox,
      h('div', { style: 'margin-top:10px' }, addBtn)),
    h('div', { id: 'seMsg' }),
    h('div', { class: 'savebar' }, save));
  mount(root, !!se.rendered);
  se.rendered = true;
  if (se.msg) { setMsgBox(se.msg.text, se.msg.cls); se.msg = null; }
}

function moveItem(i, d) {
  const j = i + d;
  if (j < 0 || j >= SE.items.length) return;
  const t = SE.items[i]; SE.items[i] = SE.items[j]; SE.items[j] = t;
  SE.dirty = true;
  renderSetEditor();
}

function validateSet() {
  const se = SE;
  if (!se.name.trim()) return 'กรุณาตั้งชื่อชุด';
  if (se.mode === 'arena' && !se.seasonId) return 'ชุด ' + MINI_NAME + ' ต้องเลือก season';
  const d = Number(se.duration);
  if (!(d >= 1) || d > 600 || Math.floor(d) !== d) return 'เวลาสอบต้องเป็นจำนวนเต็ม 1 ถึง 600 นาที';
  if (!se.opens) return 'กรุณาระบุวันเปิด';
  if (se.closes && fromLocalInput(se.closes) <= fromLocalInput(se.opens)) return 'วันปิดต้องหลังวันเปิด';
  if (se.mode === 'practice') {
    const a = Number(se.allowed);
    if (!(a >= 0) || a > 100 || Math.floor(a) !== a) return 'จำนวนรอบฝึกต้องเป็นจำนวนเต็ม 0 ถึง 100';
  }
  return '';
}

async function saveSet(forceEmpty) {
  const err = validateSet();
  if (err) { setMsgBox(err, 'err'); return; }
  if (!SE.items.length && forceEmpty !== true) {
    showDialog({ icon: '❓', title: 'ชุดนี้ยังไม่มีข้อ', message: 'นักเรียนจะเริ่มสอบชุดนี้ไม่ได้จนกว่าจะมีข้อ ต้องการบันทึกเลยไหม?',
      buttons: [{ text: 'กลับไปเพิ่มข้อ', cls: 'ghost', focus: true }, { text: 'บันทึกเลย', cls: 'primary', onClick: function () { saveSet(true); } }] });
    return;
  }
  setMsgBox('');
  showBusy('กำลังบันทึก...');
  const se = SE;
  let res;
  try {
    res = await rpc('exam_admin_save_set', {
      p_set_id: se.id, p_name: se.name.trim(), p_mode: se.id === null ? se.mode : null,
      p_season_id: se.mode === 'arena' ? se.seasonId : null,
      p_duration: Number(se.duration), p_opens_at: fromLocalInput(se.opens), p_closes_at: fromLocalInput(se.closes),
      p_allowed: se.mode === 'practice' ? Number(se.allowed) : 0,
      p_version_ids: se.items.map(function (i) { return i.qv; })
    });
  } catch (e) {
    hideBusy();
    if (isAuthError(e)) { handleErr(e); return; }
    setMsgBox('บันทึกไม่สำเร็จ: ' + e.message, 'err');
    return;
  }
  hideBusy();
  se.dirty = false;
  if (se.id === null) se.id = res.set_id;    // ถ้าโหลดซ้ำไม่สำเร็จ การบันทึกครั้งต่อไปจะแก้ชุดเดิม ไม่สร้างซ้ำ
  openSetEditor(res.set_id, { text: 'บันทึกแล้ว', cls: 'ok' });
}

/* ---------- เลือกข้อจากคลังเข้าชุด ---------- */
async function openPicker() {
  const pool = SE.mode === 'arena' ? 'arena' : 'practice';
  showBusy('กำลังโหลดคลังข้อสอบ...');
  let rows;
  try {
    rows = await api('GET', 'exam_questions?pool=eq.' + pool +
      '&select=id,exam_question_versions(id,version_no,qtype,body,image_path)' +
      '&exam_question_versions.order=version_no.desc&order=id.desc&limit=500');
  } catch (e) { hideBusy(); handleErr(e, 'โหลดคลังข้อสอบไม่สำเร็จ'); return; }
  hideBusy();

  const have = {};                                   // ข้อที่อยู่ในชุดแล้ว (ใช้ได้ข้อละเวอร์ชันเดียว)
  SE.items.forEach(function (i) { have[i.qid] = true; });
  const picked = [];                                 // ข้อที่ติ๊กไว้ เรียงตามลำดับที่ติ๊ก
  const list = h('div', { class: 'plist' });
  const search = h('input', { type: 'search', placeholder: 'ค้นหาในโจทย์ หรือพิมพ์เลขข้อ' });
  const info = h('span', { class: 'hint' });
  const addBtn = btn('primary', 'เพิ่มที่เลือก (0)', null);
  let overlay = null;

  function close() { if (overlay && overlay.parentNode) overlay.parentNode.removeChild(overlay); }
  function updateAdd() {
    addBtn.disabled = picked.length === 0;
    addBtn.textContent = 'เพิ่มที่เลือก (' + picked.length + ')';
  }
  function renderRows() {
    const q = search.value.trim().toLowerCase();
    list.textContent = '';
    let shown = 0;
    (rows || []).forEach(function (r) {
      const v = (r.exam_question_versions || [])[0];   // เวอร์ชันล่าสุด
      if (!v) return;
      if (q && String(r.id) !== q && String(v.body).toLowerCase().indexOf(q) < 0) return;
      shown++;
      const used = !!have[r.id];
      const cb = h('input', { type: 'checkbox' });
      cb.checked = picked.some(function (p) { return p.qid === r.id; });
      cb.disabled = used;
      cb.onchange = function () {
        if (cb.checked) {
          picked.push({ qv: v.id, qid: r.id, vno: v.version_no, qtype: v.qtype, body: v.body, maxNo: v.version_no });
        } else {
          const k = picked.findIndex(function (p) { return p.qid === r.id; });
          if (k >= 0) picked.splice(k, 1);
        }
        updateAdd();
      };
      list.appendChild(h('label', { class: 'prow' + (used ? ' used' : '') },
        cb,
        h('div', { class: 'pmain' },
          h('div', { class: 'qsnip', text: snippet(v.body, 130) }),
          h('div', { class: 'qmeta' },
            h('span', { class: 'tag gray', text: '#' + r.id + ' v' + v.version_no }),
            h('span', { class: 'tag gray', text: TYPE_LABEL[v.qtype] || v.qtype }),
            v.image_path ? h('span', { class: 'tag gray', text: '🖼 มีรูป' }) : null,
            used ? h('span', { class: 'tag', text: 'อยู่ในชุดแล้ว' }) : null))));
    });
    if (!shown) {
      list.appendChild(h('div', { class: 'hint', style: 'padding:14px',
        text: (rows && rows.length) ? 'ไม่พบข้อที่ตรงกับคำค้น' : 'ยังไม่มีข้อกลุ่มนี้ในคลัง ไปเพิ่มที่แท็บ คลังข้อสอบ ก่อน' }));
    }
    info.textContent = 'แสดง ' + shown + ' ข้อ (เลือกเวอร์ชันล่าสุดของแต่ละข้อ)';
  }

  addBtn.onclick = function () {
    picked.forEach(function (it) { SE.items.push(it); });
    if (picked.length) SE.dirty = true;
    close();
    renderSetEditor();
  };
  search.oninput = renderRows;

  overlay = h('div', { class: 'picker' },
    h('div', { class: 'pbox' },
      h('div', { class: 'phead' },
        h('div', { class: 'title', style: 'margin:0;font-size:18px',
          text: 'เลือกข้อจากคลัง (' + (SE.mode === 'arena' ? 'ข้อ ' + MINI_NAME : 'ข้อฝึก') + ')' }),
        search, info),
      list,
      h('div', { class: 'pfoot' }, btn('ghost', 'ยกเลิก', close), addBtn)));
  addBtn.disabled = true;
  document.body.appendChild(overlay);
  renderRows();
  updateAdd();
}

window.addEventListener('beforeunload', function (e) {
  if ((SE && SE.dirty) || (SS && SS.dirty)) { e.preventDefault(); e.returnValue = ''; }
});


/* =====================================================================
   ผู้สอบของชุด + รีเซ็ตสิทธิ์ (ขั้น 5 ส่วนที่ 1)
   - ดูรอบสอบทั้งหมดของชุดหนึ่ง (ชื่อ สถานะ เวลา) ค้นหาด้วยชื่อหรือรหัสนักเรียนได้
   - "ยกเลิกรอบ" = รีเซ็ตสิทธิ์: รอบนั้นไม่นับและนักเรียนสอบใหม่ได้ ข้อมูลเดิมยังเก็บไว้
     ต้องระบุเหตุผลทุกครั้ง และระบบบันทึกว่าใครยกเลิกเมื่อไหร่ (ตาราง exam_attempt_resets)
   ===================================================================== */
const ATT_STATUS = {
  in_progress: { t: 'กำลังสอบ', c: 'mini' },
  submitted: { t: 'ส่งแล้ว', c: '' },
  timed_out: { t: 'หมดเวลา', c: 'gray' },
  voided: { t: 'ยกเลิก (ไม่นับ)', c: 'gray' }
};

async function showAttempts(s, msg) {
  SS = null; SE = null;
  showBusy('กำลังโหลดรายชื่อผู้สอบ...');
  let rows, allow = [];
  try {
    rows = await rpc('exam_admin_list_attempts', { p_set_id: s.id });
    if (s.mode === 'practice') allow = await rpc('exam_admin_list_allowances', { p_set_id: s.id });
  } catch (e) { hideBusy(); handleErr(e, 'โหลดรายชื่อผู้สอบไม่สำเร็จ'); return; }
  hideBusy();
  rows = rows || [];
  allow = allow || [];

  const count = { in_progress: 0, submitted: 0, timed_out: 0, voided: 0 };
  rows.forEach(function (a) { if (count[a.status] !== undefined) count[a.status]++; });

  const list = h('div', null);
  const search = h('input', { type: 'search', placeholder: 'ค้นหาชื่อหรือรหัสนักเรียน', 'aria-label': 'ค้นหา' });

  function draw() {
    const q = search.value.trim().toLowerCase();
    list.textContent = '';
    let shown = 0;
    rows.forEach(function (a) {
      const label = (a.name || '(ไม่พบชื่อ)') + ' ' + a.student_id;
      if (q && label.toLowerCase().indexOf(q) < 0) return;
      shown++;
      const st = ATT_STATUS[a.status] || { t: a.status, c: 'gray' };
      const isVoid = a.status === 'voided';
      list.appendChild(h('div', { class: 'qitem' },
        h('div', { class: 'qid', text: '#' + a.attempt_id }),
        h('div', { class: 'qmain' },
          h('div', { class: 'qsnip', text: a.name || '(ไม่พบชื่อในระบบ)' }),
          h('div', { class: 'hint', text: 'รหัส ' + a.student_id + '  •  เริ่ม ' + fmtDT(a.started_at) +
            (a.submitted_at ? '  •  ส่ง ' + fmtDT(a.submitted_at) : '') }),
          h('div', { class: 'qmeta' },
            h('span', { class: 'tag ' + st.c, text: st.t }),
            h('span', { class: 'tag gray', text: 'รอบที่ ' + a.attempt_no })),
          isVoid && a.void_reason
            ? h('div', { class: 'hint', style: 'margin-top:6px',
                text: 'เหตุผลที่ยกเลิก: ' + a.void_reason + (a.void_by ? '  (โดย ' + a.void_by + ')' : '') +
                      (a.void_at ? '  ' + fmtDT(a.void_at) : '') })
            : null),
        h('div', { class: 'qact' },
          isVoid ? null : btn('ghost small', 'ยกเลิกรอบ', function () { askVoid(a, s); }))));
    });
    if (!shown) {
      list.appendChild(h('div', { class: 'hint', style: 'margin:16px 4px',
        text: rows.length ? 'ไม่พบรายการที่ตรงกับคำค้น' : 'ยังไม่มีใครสอบชุดนี้' }));
    }
  }
  search.oninput = draw;
  draw();

  const back = btn('ghost small', '‹ กลับรายการชุด', function () { showSets(); });
  mount(h('div', { class: 'wrap' },
    h('div', { class: 'topbar' }, back, h('div', { class: 'who', text: 'เข้าสู่ระบบ: ' + (SESS ? SESS.user.email : '') })),
    h('div', { class: 'card', style: 'margin-top:12px' },
      h('h3', { text: 'ผู้สอบ: ' + s.name }),
      h('div', { class: 'hint', text: 'ทั้งหมด ' + rows.length + ' รอบ  •  ส่งแล้ว ' + count.submitted +
        '  •  หมดเวลา ' + count.timed_out + '  •  กำลังสอบ ' + count.in_progress + '  •  ยกเลิก ' + count.voided }),
      h('div', { class: 'hint', style: 'margin-top:6px',
        text: '"ยกเลิกรอบ" ใช้เมื่อรอบนั้นเสียไปโดยไม่ใช่ความผิดนักเรียน เช่น เน็ตหลุดก่อนเริ่มทำ รอบจะไม่นับในคะแนนและสถิติ และนักเรียนเริ่มสอบใหม่ได้ (Mini Test ต้องยังอยู่ในช่วง season)' })),
    msg ? h('div', { class: 'msgbox ok', text: msg }) : null,
    s.mode === 'practice' ? allowanceCard(s, rows, allow) : null,
    h('div', { class: 'toolbar' }, search),
    list));
}

function askVoid(a, s) {
  const who = (a.name || a.student_id) + ' (รอบที่ ' + a.attempt_no + ')';
  const reason = h('input', {
    type: 'text', maxlength: '200', 'aria-label': 'เหตุผล',
    placeholder: 'เหตุผล เช่น เน็ตหลุดก่อนเริ่มข้อแรก',
    style: 'margin-top:12px;width:100%;padding:10px 12px;border:1.5px solid #e2e8f0;border-radius:10px;font-size:15px'
  });
  showDialog({
    icon: '↩️', title: 'ยกเลิกรอบสอบ (รีเซ็ตสิทธิ์)',
    message: 'ยกเลิกรอบของ ' + who + ' ใช่ไหม?\nรอบนี้จะไม่นับในคะแนนและสถิติ และนักเรียนสอบใหม่ได้ ข้อมูลเดิมยังเก็บไว้ตรวจย้อนหลัง',
    buttons: [
      { text: 'ไม่ยกเลิก', cls: 'ghost', focus: true },
      { text: 'ยืนยันยกเลิกรอบ', cls: 'danger', onClick: function () {
        const text = reason.value.trim();
        if (text.length < 3) {
          showDialog({ icon: 'ℹ️', title: 'ต้องระบุเหตุผล', message: 'กรุณาพิมพ์เหตุผลอย่างน้อย 3 ตัวอักษร เพื่อใช้ตรวจย้อนหลัง',
            buttons: [{ text: 'ตกลง', cls: 'primary', onClick: function () { askVoid(a, s); } }] });
          return;
        }
        doVoid(a, s, text);
      } }
    ]
  });
  $('dlgBody').appendChild(reason);
}

async function doVoid(a, s, reason) {
  showBusy('กำลังยกเลิกรอบ...');
  try { await rpc('exam_admin_void_attempt', { p_attempt_id: a.attempt_id, p_reason: reason }); }
  catch (e) { hideBusy(); handleErr(e, 'ยกเลิกรอบไม่สำเร็จ'); return; }
  hideBusy();
  showAttempts(s, 'ยกเลิกรอบของ ' + (a.name || a.student_id) + ' แล้ว นักเรียนเริ่มสอบใหม่ได้');
}


/* =====================================================================
   ล็อก/ปลดล็อกผล season + สิทธิ์รอบฝึกรายคน (ขั้น 5 ส่วนที่ 2)
   ===================================================================== */
function confirmSeasonLock(s) {
  const lock = !s.locked;
  showDialog({
    icon: lock ? '🔒' : '🔓',
    title: lock ? 'ล็อกผล season' : 'ปลดล็อก season',
    message: lock
      ? 'ล็อกผล "' + s.name + '" ใช่ไหม?\nนักเรียนจะเริ่มสอบใหม่ใน season นี้ไม่ได้ และอันดับถือเป็นผลสุดท้าย ระบบปิดรอบที่เลยเวลาแล้วให้เอง ถ้ายังมีคนกำลังสอบอยู่จะล็อกไม่ได้ ต้องรอให้ครบเวลาก่อน'
      : 'ปลดล็อก "' + s.name + '" ใช่ไหม?\nใช้เมื่อล็อกผิด จะแก้ไข season ได้อีก และถ้ายังไม่ถึงวันจบ นักเรียนจะเริ่มสอบได้อีก อันดับที่เห็นจะเป็นค่าชั่วคราว',
    buttons: [
      { text: 'ยกเลิก', cls: 'ghost', focus: true },
      { text: lock ? 'ล็อกผล' : 'ปลดล็อก', cls: lock ? 'danger' : 'primary', onClick: async function () {
        showBusy(lock ? 'กำลังล็อกผล...' : 'กำลังปลดล็อก...');
        let res;
        try { res = await rpc('exam_admin_set_season_lock', { p_season_id: s.id, p_locked: lock }); }
        catch (e) { hideBusy(); handleErr(e, lock ? 'ล็อกผลไม่สำเร็จ' : 'ปลดล็อกไม่สำเร็จ'); return; }
        hideBusy();
        const extra = lock && res && res.finalized ? ' (ปิดรอบที่เลยเวลาให้ ' + res.finalized + ' รอบ)' : '';
        showSeasons((lock ? 'ล็อกผล ' : 'ปลดล็อก ') + s.name + ' แล้ว' + extra);
      } }
    ]
  });
}

function allowanceCard(s, rows, allow) {
  const extraMap = {};
  allow.forEach(function (x) { extraMap[x.student_id] = x.extra; });
  const stu = {};
  rows.forEach(function (a) {
    if (!stu[a.student_id]) stu[a.student_id] = { id: a.student_id, name: a.name, used: 0 };
    if (a.status !== 'voided') stu[a.student_id].used++;
  });
  const ids = Object.keys(stu).sort(function (x, y) {
    return String(stu[x].name || x).localeCompare(String(stu[y].name || y), 'th');
  });

  const box = h('div', { class: 'card' },
    h('h3', { text: 'สิทธิ์รอบฝึกรายคน' }),
    h('div', { class: 'hint', text: 'ชุดนี้ให้ทำได้ ' + s.practice_attempts_allowed + ' รอบต่อคน กด "+1 รอบ" เมื่อนักเรียนใช้ครบแล้วและครูอนุญาตให้ทำเพิ่ม (รอบที่ยกเลิกไม่นับในโควตา)' }));
  if (!ids.length) {
    box.appendChild(h('div', { class: 'hint', style: 'margin-top:8px', text: 'ยังไม่มีนักเรียนที่เคยสอบชุดนี้' }));
    return box;
  }
  ids.forEach(function (id) {
    const x = stu[id];
    const extra = extraMap[id] || 0;
    const allowed = s.practice_attempts_allowed + extra;
    box.appendChild(h('div', { class: 'arow', style: 'justify-content:space-between;flex-wrap:wrap' },
      h('div', null,
        h('div', { class: 'qsnip', text: x.name || '(ไม่พบชื่อ) ' + id }),
        h('div', { class: 'hint', text: 'ทำแล้ว ' + x.used + ' / ' + allowed + ' รอบ' +
          (extra ? '  (ครูเพิ่มให้ ' + extra + ')' : '') + (x.used >= allowed ? '  • ครบโควตาแล้ว' : '') })),
      h('div', { class: 'qact', style: 'flex-direction:row' },
        btn('ghost small', '+1 รอบ', function () { changeAllowance(s, id, extra + 1, x); }),
        extra > 0 ? btn('ghost small', '−1', function () { changeAllowance(s, id, extra - 1, x); }) : null)));
  });
  return box;
}

async function changeAllowance(s, studentId, extra, x) {
  showBusy('กำลังบันทึก...');
  try { await rpc('exam_admin_set_allowance', { p_set_id: s.id, p_student_id: studentId, p_extra: extra }); }
  catch (e) { hideBusy(); handleErr(e, 'บันทึกสิทธิ์ไม่สำเร็จ'); return; }
  hideBusy();
  showAttempts(s, 'ปรับสิทธิ์รอบฝึกของ ' + (x.name || studentId) + ' แล้ว');
}

/* ---------- เปิดแท็บ "ชุดข้อสอบ" และ "Season" โดยไม่ต้องแก้ shell() ใน app.js ----------
   ห่อ shell() เดิม: สร้างหน้าตามปกติ แล้วเปลี่ยนปุ่มแท็บที่ 2 และ 3 (เดิมกดไม่ได้) ให้ใช้งานได้
   ถ้าภายหลังแก้ shell() ใน app.js ให้เปิดแท็บเองแล้ว ส่วนนี้ก็ยังทำงานได้ไม่ซ้ำซ้อน */
(function () {
  const origShell = window.shell;
  if (typeof origShell !== 'function') return;
  window.shell = function (active, children) {
    const root = origShell(active, children);
    const tabs = root.querySelectorAll('.tabs .tab');
    const defs = [null, ['sets', 'ชุดข้อสอบ', showSets], ['seasons', 'Season', showSeasons]];
    defs.forEach(function (d, i) {
      const b = tabs[i];
      if (!d || !b) return;
      b.disabled = false;
      b.textContent = d[1];
      b.classList.toggle('active', active === d[0]);
      b.onclick = function () { d[2](); };
    });
    return root;
  };
})();


/* =====================================================================
   ผู้ชนะ season: ตรวจและอนุมัติข้อความประกาศ (ขั้น 5.5)
   ===================================================================== */
const WIN_STATUS = {
  invited:  { t: 'รอผู้ชนะตอบ', c: 'gray' },
  pending:  { t: 'รอครูตรวจ', c: 'mini' },
  approved: { t: 'แสดงแล้ว', c: '' },
  rejected: { t: 'ไม่อนุมัติ', c: 'gray' },
  declined: { t: 'ผู้ชนะไม่ประสงค์ประกาศ', c: 'gray' }
};

function winLine(label, value, bold) {
  return h('div', { style: 'margin-top:4px;white-space:pre-wrap;overflow-wrap:anywhere' },
    h('span', { style: 'color:#64748b;font-size:13px', text: label + ': ' }),
    h('span', { style: bold ? 'font-weight:700' : '', text: value }));
}

function fmtSecs(sec) {
  sec = Math.max(0, Math.round(sec || 0));
  return Math.floor(sec / 60) + ':' + (sec % 60 < 10 ? '0' : '') + (sec % 60);
}

async function showWinners(s, msg) {
  SS = null; SE = null;
  showBusy('กำลังโหลดผู้ชนะ...');
  let rows;
  try { rows = await rpc('exam_admin_list_winners', { p_season_id: s.id }); }
  catch (e) { hideBusy(); handleErr(e, 'โหลดผู้ชนะไม่สำเร็จ'); return; }
  hideBusy();
  rows = rows || [];

  const pending = rows.filter(function (r) { return r.status === 'pending'; }).length;
  const list = h('div', null);
  if (!rows.length) {
    list.appendChild(h('div', { class: 'hint', style: 'margin:16px 4px',
      text: 'season นี้ไม่มีผู้ชนะ (ไม่มีชุด Mini Test หรือมีผู้สอบเสร็จน้อยกว่าเกณฑ์ขั้นต่ำ ' + s.min_people + ' คน)' }));
  }
  let lastSet = null;
  rows.forEach(function (r) {
    if (r.set_name !== lastSet) {
      lastSet = r.set_name;
      list.appendChild(h('div', { class: 'hint', style: 'margin:16px 4px 4px;font-weight:700', text: 'ชุด: ' + r.set_name }));
    }
    const st = WIN_STATUS[r.status] || { t: r.status, c: 'gray' };
    const hasText = r.nickname || r.faculty || r.message;
    list.appendChild(h('div', { class: 'qitem' },
      h('div', { class: 'qid', text: 'อันดับ ' + r.rank }),
      h('div', { class: 'qmain' },
        h('div', { class: 'qsnip', text: (r.name || '(ไม่พบชื่อในระบบ)') + '  (รหัส ' + r.student_id + ')' }),
        h('div', { class: 'hint', text: 'คะแนน ' + r.score + '/' + r.total + '  •  เวลารวม ' + fmtSecs(r.total_secs) +
          (r.submitted_at ? '  •  ส่งข้อความ ' + fmtDT(r.submitted_at) : '') }),
        h('div', { class: 'qmeta' }, h('span', { class: 'tag ' + st.c, text: st.t })),
        hasText ? h('div', { style: 'margin-top:8px;padding:10px 12px;border-radius:10px;background:#f1f5f9' },
          winLine('ชื่อ', r.nickname || '-', true),
          r.faculty ? winLine('คณะที่อยากเข้า', r.faculty) : null,
          r.message ? winLine('อยากบอกเพื่อนๆ / คำคม', r.message) : null) : null,
        r.status === 'rejected' && r.review_note
          ? h('div', { class: 'hint', style: 'margin-top:6px', text: 'เหตุผลที่ไม่อนุมัติ: ' + r.review_note }) : null),
      h('div', { class: 'qact' },
        r.status === 'pending' ? btn('primary small', 'อนุมัติ', function () { reviewWinner(s, r, 'approve', null); }) : null,
        r.status === 'pending' ? btn('ghost small', 'ไม่อนุมัติ', function () { askRejectWinner(s, r); }) : null,
        r.status === 'approved' ? btn('ghost small', 'ถอดออก', function () { askRejectWinner(s, r); }) : null)));
  });

  const back = btn('ghost small', '‹ กลับรายการ season', function () { showSeasons(); });
  mount(h('div', { class: 'wrap' },
    h('div', { class: 'topbar' }, back, h('div', { class: 'who', text: 'เข้าสู่ระบบ: ' + (SESS ? SESS.user.email : '') })),
    h('div', { class: 'card', style: 'margin-top:12px' },
      h('h3', { text: 'ผู้ชนะ: ' + s.name }),
      h('div', { class: 'hint', text: 'รอครูตรวจ ' + pending + ' รายการ จากทั้งหมด ' + rows.length + ' รายการ' }),
      h('div', { class: 'hint', style: 'margin-top:6px',
        text: 'อันดับ 1-3 ของแต่ละชุด Mini Test (คะแนนมากสุด เสมอกันดูเวลารวมน้อยกว่า) ข้อความจะแสดงให้นักเรียนที่ล็อกอินเห็นเมื่อกด \"อนุมัติ\" เท่านั้น ผู้ที่ทำชุดเดียวกันจะดูคะแนน เวลารายข้อ และกด \"ย้อนดูการสอบ\" ของผู้ชนะที่อนุมัติแล้วได้ (เห็นคำตอบที่ผู้ชนะเลือกในแต่ละข้อและลำดับการทำข้อสอบ) ผู้ชนะเลือกไม่ประกาศได้ และปลดล็อก season จะซ่อนประกาศทั้งหมดชั่วคราว' })),
    msg ? h('div', { class: 'msgbox ok', text: msg }) : null,
    list));
}

function askRejectWinner(s, r) {
  const wasShown = r.status === 'approved';
  const note = h('input', {
    type: 'text', maxlength: '200', 'aria-label': 'เหตุผล',
    placeholder: 'เหตุผลที่นักเรียนจะเห็น เช่น ขอให้ตัดข้อมูลส่วนตัวออก (ไม่บังคับ)',
    style: 'margin-top:12px;width:100%;padding:10px 12px;border:1.5px solid #e2e8f0;border-radius:10px;font-size:15px'
  });
  showDialog({
    icon: '🚫', title: wasShown ? 'ถอดข้อความออกจากประกาศ' : 'ไม่อนุมัติข้อความ',
    message: (wasShown ? 'ถอดข้อความของ ' : 'ไม่อนุมัติข้อความของ ') + (r.name || r.student_id) +
      ' ใช่ไหม?\nนักเรียนจะเห็นเหตุผลและแก้ไขส่งใหม่ได้',
    buttons: [
      { text: 'ยกเลิก', cls: 'ghost', focus: true },
      { text: 'ยืนยัน', cls: 'danger', onClick: function () { reviewWinner(s, r, 'reject', note.value.trim()); } }
    ]
  });
  $('dlgBody').appendChild(note);
}

async function reviewWinner(s, r, decision, note) {
  showBusy('กำลังบันทึก...');
  try { await rpc('exam_admin_review_winner', { p_winner_id: r.id, p_decision: decision, p_note: note || null }); }
  catch (e) { hideBusy(); handleErr(e, 'บันทึกไม่สำเร็จ'); return; }
  hideBusy();
  showWinners(s, decision === 'approve'
    ? 'อนุมัติแล้ว นักเรียนที่ล็อกอินจะเห็นข้อความนี้ในหน้ารายการข้อสอบ'
    : 'บันทึกแล้ว นักเรียนจะเห็นเหตุผลและแก้ไขส่งใหม่ได้');
}
