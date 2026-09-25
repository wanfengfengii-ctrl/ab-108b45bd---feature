'use strict';

/* 移动式穹顶测绘平台 · 安全操作演练前端 */

const MIN_LEGS = 4;
const MAX_LEGS = 6;
const MIN_POSTURES = 4;
const MAX_POSTURES = 8;

const $ = (sel) => document.querySelector(sel);

let session = null; // 最近一次从服务端拿到的状态视图
let pollTimer = null;

/* ---------------- 录入区 ---------------- */

function addLegRow(leg) {
  const tbody = $('#legs-table tbody');
  const row = document.createElement('tr');
  row.innerHTML = `
    <td class="row-label"></td>
    <td><input type="number" step="any" class="leg-x" value="${leg?.x ?? 0}"></td>
    <td><input type="number" step="any" class="leg-y" value="${leg?.y ?? 0}"></td>
    <td><input type="checkbox" class="leg-deployed" ${leg?.deployed === false ? '' : 'checked'}></td>
    <td><button type="button" class="danger remove-row">删除</button></td>`;
  row.querySelector('.remove-row').addEventListener('click', () => {
    if (tbody.rows.length <= MIN_LEGS) return alert(`支腿不能少于 ${MIN_LEGS} 只`);
    row.remove();
    relabelRows();
  });
  tbody.appendChild(row);
  relabelRows();
}

function addPostureRow(p) {
  const tbody = $('#postures-table tbody');
  const row = document.createElement('tr');
  row.innerHTML = `
    <td class="row-label"></td>
    <td><input type="number" step="any" class="p-x" value="${p?.x ?? 0}"></td>
    <td><input type="number" step="any" class="p-y" value="${p?.y ?? 0}"></td>
    <td><input type="number" step="any" min="0" class="p-r" value="${p?.r ?? 0.5}"></td>
    <td><button type="button" class="danger remove-row">删除</button></td>`;
  row.querySelector('.remove-row').addEventListener('click', () => {
    if (tbody.rows.length <= MIN_POSTURES) return alert(`姿态不能少于 ${MIN_POSTURES} 个`);
    row.remove();
    relabelRows();
  });
  tbody.appendChild(row);
  relabelRows();
}

function relabelRows() {
  [...$('#legs-table tbody').rows].forEach((r, i) => { r.querySelector('.row-label').textContent = `L${i + 1}`; });
  [...$('#postures-table tbody').rows].forEach((r, i) => { r.querySelector('.row-label').textContent = `P${i + 1}`; });
  $('#add-leg').disabled = $('#legs-table tbody').rows.length >= MAX_LEGS;
  $('#add-posture').disabled = $('#postures-table tbody').rows.length >= MAX_POSTURES;
}

function readSetup() {
  const legs = [...$('#legs-table tbody').rows].map((r) => ({
    x: Number(r.querySelector('.leg-x').value),
    y: Number(r.querySelector('.leg-y').value),
    deployed: r.querySelector('.leg-deployed').checked,
  }));
  const postures = [...$('#postures-table tbody').rows].map((r) => ({
    x: Number(r.querySelector('.p-x').value),
    y: Number(r.querySelector('.p-y').value),
    r: Number(r.querySelector('.p-r').value),
  }));
  return { legs, postures };
}

function loadExample() {
  $('#legs-table tbody').innerHTML = '';
  $('#postures-table tbody').innerHTML = '';
  [
    { x: -2, y: -2, deployed: true },
    { x: 2, y: -2, deployed: true },
    { x: 2, y: 2, deployed: true },
    { x: -2, y: 2, deployed: true },
    { x: 0, y: 3.2, deployed: false },
  ].forEach(addLegRow);
  [
    { x: 0, y: 0, r: 0.5 },
    { x: 0.6, y: 0.4, r: 0.8 },
    { x: -0.8, y: 0.6, r: 0.6 },
    { x: 0, y: -1, r: 0.9 },
    { x: 1.2, y: -0.6, r: 0.4 },
  ].forEach(addPostureRow);
  relabelRows();
}

/* ---------------- 与服务端交互 ---------------- */

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

async function startSession() {
  $('#setup-error').textContent = '';
  const payload = readSetup();
  const { status, body } = await api('/api/sessions', { method: 'POST', body: JSON.stringify(payload) });
  if (status !== 201) {
    $('#setup-error').textContent = body.error || '创建演练失败';
    return;
  }
  session = body.state;
  $('#setup').classList.add('hidden');
  $('#rehearsal').classList.remove('hidden');
  $('#statusbar').classList.remove('hidden');
  $('#op-message').textContent = '';
  renderAll();
  startPolling();
}

async function refreshState() {
  if (!session) return;
  const { status, body } = await api(`/api/sessions/${session.sessionId}`);
  if (status === 200) {
    session = body;
    renderAll();
  }
}

async function sendOp(op) {
  if (!session) return;
  $('#op-message').textContent = '';
  const { status, body } = await api(`/api/sessions/${session.sessionId}/ops`, {
    method: 'POST',
    body: JSON.stringify({ baseRevision: session.revision, op }),
  });
  if (status === 200) {
    session = body.state;
  } else {
    // 拒绝（含修订号过期）：展示理由，并用返回的最新状态重新同步。
    $('#op-message').textContent = `已拒绝：${body.error || '未知原因'}`;
    if (body.state) session = body.state;
    else await refreshState();
  }
  renderAll();
}

/* ---------------- 渲染 ---------------- */

function renderStatus() {
  $('#st-revision').textContent = String(session.revision);
  $('#st-legs').innerHTML = session.legs
    .map((l) => `<span class="${l.deployed ? 'leg-on' : 'leg-off'}">L${l.id + 1}${l.deployed ? '●' : '○'}</span>`)
    .join(' ');
  const p = session.postures[session.currentPosture];
  $('#st-posture').textContent = `P${session.currentPosture + 1}（中心 ${fmt(p.x)}, ${fmt(p.y)}，半径 ${fmt(p.r)}）`;
  const safeEl = $('#st-safe');
  safeEl.textContent = session.safe ? '安全' : '不安全';
  safeEl.style.color = session.safe ? '#7ee2a0' : '#ffb3ad';
  $('#st-rejection').textContent = session.lastRejection
    ? `${session.lastRejection.reason}（所见修订号 ${session.lastRejection.baseRevision}）`
    : '无';
}

function fmt(v) {
  return Number.isInteger(v) ? String(v) : v.toFixed(2);
}

function renderControls() {
  const select = $('#posture-select');
  select.innerHTML = '';
  session.postures.forEach((p) => {
    if (p.id === session.currentPosture) return;
    const opt = document.createElement('option');
    opt.value = String(p.id);
    opt.textContent = `P${p.id + 1}（中心 ${fmt(p.x)}, ${fmt(p.y)}，半径 ${fmt(p.r)}）`;
    select.appendChild(opt);
  });

  const box = $('#leg-buttons');
  box.innerHTML = '';
  session.legs.forEach((l) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = `${l.deployed ? '收起' : '展开'} L${l.id + 1}`;
    btn.addEventListener('click', () => sendOp({ type: 'toggle_leg', leg: l.id, deployed: !l.deployed }));
    box.appendChild(btn);
  });
}

const SVG_NS = 'http://www.w3.org/2000/svg';

function svgEl(tag, attrs) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  return el;
}

function renderView() {
  const svg = $('#view');
  svg.innerHTML = '';

  // 视图范围：所有支腿、姿态圆盘与凸包的包围盒，留边距。
  const xs = [];
  const ys = [];
  for (const l of session.legs) { xs.push(l.x); ys.push(l.y); }
  for (const p of session.postures) { xs.push(p.x - p.r, p.x + p.r); ys.push(p.y - p.r, p.y + p.r); }
  for (const v of session.supportPolygon) { xs.push(v.x); ys.push(v.y); }
  let minX = Math.min(...xs);
  let maxX = Math.max(...xs);
  let minY = Math.min(...ys);
  let maxY = Math.max(...ys);
  const pad = Math.max(0.5, (maxX - minX) * 0.12, (maxY - minY) * 0.12);
  minX -= pad; maxX += pad; minY -= pad; maxY += pad;
  const w = maxX - minX;
  const h = maxY - minY;
  const Y = (y) => -y; // SVG 纵轴向下，翻转为数学坐标观感
  svg.setAttribute('viewBox', `${minX} ${-maxY} ${w} ${h}`);
  const unit = Math.max(w, h) / 100; // 线宽/字号基准

  // 支承凸包
  if (session.supportPolygon.length >= 2) {
    const pts = session.supportPolygon.map((v) => `${v.x},${Y(v.y)}`).join(' ');
    svg.appendChild(svgEl('polygon', {
      points: pts,
      fill: 'rgba(45,164,78,0.15)',
      stroke: '#2da44e',
      'stroke-width': unit * 0.5,
    }));
  }

  // 其余姿态（淡显）
  session.postures.forEach((p) => {
    if (p.id === session.currentPosture) return;
    svg.appendChild(svgEl('circle', {
      cx: p.x, cy: Y(p.y), r: Math.max(p.r, unit * 0.8),
      fill: 'none', stroke: '#b6c0ca', 'stroke-width': unit * 0.3, 'stroke-dasharray': `${unit} ${unit}`,
    }));
  });

  // 当前载荷圆盘
  const cur = session.postures[session.currentPosture];
  svg.appendChild(svgEl('circle', {
    cx: cur.x, cy: Y(cur.y), r: Math.max(cur.r, unit * 0.8),
    fill: 'rgba(31,111,235,0.18)', stroke: '#1f6feb', 'stroke-width': unit * 0.5, 'stroke-dasharray': `${unit * 1.4} ${unit * 0.9}`,
  }));
  svg.appendChild(svgEl('circle', { cx: cur.x, cy: Y(cur.y), r: unit * 0.9, fill: '#1f6feb' }));
  const pl = svgEl('text', {
    x: cur.x + unit * 1.6, y: Y(cur.y) - unit * 1.2, 'font-size': unit * 3.4, fill: '#1f6feb', 'font-weight': 'bold',
  });
  pl.textContent = `P${cur.id + 1}`;
  svg.appendChild(pl);

  // 支腿
  session.legs.forEach((l) => {
    const s = unit * 2.6;
    svg.appendChild(svgEl('rect', {
      x: l.x - s / 2, y: Y(l.y) - s / 2, width: s, height: s,
      fill: l.deployed ? '#2da44e' : '#aeb8c2',
      stroke: '#1f2328', 'stroke-width': unit * 0.25, rx: unit * 0.5,
    }));
    const t = svgEl('text', {
      x: l.x + unit * 1.8, y: Y(l.y) + unit * 2.6, 'font-size': unit * 3, fill: '#1f2328',
    });
    t.textContent = `L${l.id + 1}`;
    svg.appendChild(t);
  });
}

function renderAll() {
  if (!session) return;
  renderStatus();
  renderControls();
  renderView();
}

function startPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(refreshState, 3000);
}

/* ---------------- 事件绑定 ---------------- */

$('#add-leg').addEventListener('click', () => addLegRow());
$('#add-posture').addEventListener('click', () => addPostureRow());
$('#load-example').addEventListener('click', loadExample);
$('#start').addEventListener('click', startSession);
$('#switch-posture').addEventListener('click', () => {
  const target = Number($('#posture-select').value);
  if (Number.isInteger(target)) sendOp({ type: 'switch_posture', posture: target });
});
$('#new-session').addEventListener('click', () => {
  if (pollTimer) clearInterval(pollTimer);
  session = null;
  $('#rehearsal').classList.add('hidden');
  $('#statusbar').classList.add('hidden');
  $('#setup').classList.remove('hidden');
});

loadExample();
