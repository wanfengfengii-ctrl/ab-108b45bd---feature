'use strict';

/**
 * 几何业务冒烟：走一遍真实演练流程，验证支承几何规则、
 * 修订号并发控制与事件轨迹的不可改写性。
 *
 * - 默认在进程内启动服务（临时端口）；
 * - 若设置 SMOKE_BASE_URL（如 compose 中的 http://web:8080），则直接打该服务。
 *
 * 退出码：0 = 验收通过；1 = 存在失败项。
 */

const { createServer } = require('../src/server');
const { SessionStore } = require('../src/session');

let failures = 0;
let checks = 0;

function check(name, cond, detail = '') {
  checks += 1;
  if (cond) {
    console.log(`  PASS  ${name}`);
  } else {
    failures += 1;
    console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

async function api(base, path, options = {}) {
  const res = await fetch(`${base}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

const post = (base, path, payload) =>
  api(base, path, { method: 'POST', body: JSON.stringify(payload) });

async function waitForService(base, attempts = 60) {
  for (let i = 0; i < attempts; i += 1) {
    try {
      const res = await fetch(`${base}/health`);
      if (res.ok) return true;
    } catch {
      /* 尚未就绪 */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

async function run(base) {
  console.log(`[smoke] target: ${base}`);

  // 0. 健康检查
  const health = await api(base, '/health');
  check('健康检查 /health 返回 200', health.status === 200 && health.body.status === 'ok');

  // 1. 录入：5 只支腿（全部部署）+ 4 个载荷姿态
  const legs = [
    { x: -2, y: -2, deployed: true },
    { x: 2, y: -2, deployed: true },
    { x: 2, y: 2, deployed: true },
    { x: -2, y: 2, deployed: true },
    { x: 0, y: 3.4, deployed: true },
  ];
  const postures = [
    { x: 0.9, y: 0.9, r: 0.5 }, // P1 安全
    { x: 0, y: 0, r: 2 }, // P2 与四边相切（边界相切=安全）
    { x: 0, y: 0, r: 2.0001 }, // P3 越界
    { x: -0.9, y: -0.9, r: 0.5 }, // P4 安全
  ];
  const created = await post(base, '/api/sessions', { legs, postures });
  check('创建演练返回 201', created.status === 201, JSON.stringify(created.body));
  const sid = created.body.sessionId;
  let state = created.body.state;
  check('初始修订号为 1（session_created 事件）', state.revision === 1);
  check('初始支承安全', state.safe === true);
  check('支承凸包为五边形', state.supportPolygon.length === 5);

  // 2. 切换到相切姿态 P2 —— 边界相切必须视为安全
  let r = await post(base, `/api/sessions/${sid}/ops`, { baseRevision: 1, op: { type: 'switch_posture', posture: 1 } });
  check('切换相切姿态被接受（相切=安全）', r.status === 200 && r.body.state.currentPosture === 1, JSON.stringify(r.body));
  check('修订号推进到 2', r.body.state && r.body.state.revision === 2);

  // 3. 切换到越界姿态 P3 —— 必须拒绝且不写轨迹
  r = await post(base, `/api/sessions/${sid}/ops`, { baseRevision: 2, op: { type: 'switch_posture', posture: 2 } });
  check('越界姿态被拒绝（422）', r.status === 422, `got ${r.status}`);
  check('拒绝理由说明圆盘越界', /越出/.test(r.body.error || ''), r.body.error);
  state = r.body.state;
  check('拒绝后修订号保持 2', state.revision === 2);
  check('最近拒绝理由已展示', Boolean(state.lastRejection && state.lastRejection.reason));

  // 4. 修订号过期 —— 409
  r = await post(base, `/api/sessions/${sid}/ops`, { baseRevision: 42, op: { type: 'switch_posture', posture: 3 } });
  check('过期修订号被拒绝（409）', r.status === 409, `got ${r.status}`);
  check('409 响应携带最新状态以便重同步', r.body.state && r.body.state.revision === 2);

  // 5. 切回 P1，再依次收起两只支腿（安全），第三只收起会被拒绝
  r = await post(base, `/api/sessions/${sid}/ops`, { baseRevision: 2, op: { type: 'switch_posture', posture: 0 } });
  check('切回 P1 被接受', r.status === 200 && r.body.state.revision === 3);

  r = await post(base, `/api/sessions/${sid}/ops`, { baseRevision: 3, op: { type: 'toggle_leg', leg: 4, deployed: false } });
  check('收起 L5 后凸包仍包含圆盘（接受）', r.status === 200 && r.body.state.supportPolygon.length === 4, JSON.stringify(r.body.error));

  r = await post(base, `/api/sessions/${sid}/ops`, { baseRevision: 4, op: { type: 'toggle_leg', leg: 0, deployed: false } });
  check('收起 L1 后三角支承仍包含圆盘（接受）', r.status === 200 && r.body.state.supportPolygon.length === 3, JSON.stringify(r.body.error));

  r = await post(base, `/api/sessions/${sid}/ops`, { baseRevision: 5, op: { type: 'toggle_leg', leg: 1, deployed: false } });
  check('再收 L2 只剩 2 只支腿被拒绝（422）', r.status === 422 && /不足 3 只/.test(r.body.error || ''), r.body.error);
  check('拒绝后修订号保持 5', r.body.state.revision === 5);

  // 6. 当前三角支承下，P4 圆盘越界 —— 拒绝
  r = await post(base, `/api/sessions/${sid}/ops`, { baseRevision: 5, op: { type: 'switch_posture', posture: 3 } });
  check('三角支承下越界姿态被拒绝（422）', r.status === 422 && /越出/.test(r.body.error || ''), r.body.error);

  // 7. 事件轨迹：只含被接受的操作
  const events = await api(base, `/api/sessions/${sid}/events`);
  const types = (events.body.events || []).map((e) => e.type);
  check('轨迹长度 = 修订号 = 5', events.body.events.length === 5);
  check(
    '轨迹只记录被接受的操作',
    JSON.stringify(types) === JSON.stringify(['session_created', 'posture_switched', 'posture_switched', 'leg_toggled', 'leg_toggled']),
    JSON.stringify(types),
  );

  // 8. 重新展开支腿恢复安全
  r = await post(base, `/api/sessions/${sid}/ops`, { baseRevision: 5, op: { type: 'toggle_leg', leg: 0, deployed: true } });
  check('重新展开 L1 被接受', r.status === 200 && r.body.state.safe === true);

  // 9. 非法录入：初始即不安全 / 支腿数越界 / 负半径
  r = await post(base, '/api/sessions', {
    legs: legs.slice(0, 4),
    postures: [{ x: 10, y: 10, r: 1 }, ...postures.slice(1)],
  });
  check('初始不安全的录入被拒绝（422）', r.status === 422, `got ${r.status}`);

  r = await post(base, '/api/sessions', { legs: legs.slice(0, 3), postures });
  check('支腿不足 4 只的录入被拒绝（400）', r.status === 400, `got ${r.status}`);

  r = await post(base, '/api/sessions', {
    legs,
    postures: [{ x: 0, y: 0, r: -0.5 }, ...postures.slice(1)],
  });
  check('负不确定半径的录入被拒绝（400）', r.status === 400, `got ${r.status}`);

  // 10. 不存在的会话
  r = await api(base, '/api/sessions/does-not-exist');
  check('未知会话返回 404', r.status === 404);
}

async function main() {
  const external = process.env.SMOKE_BASE_URL;
  let server = null;
  let base = external;

  if (external) {
    console.log(`[smoke] waiting for service at ${external} ...`);
    if (!(await waitForService(external))) {
      console.error('[smoke] service not ready in time');
      process.exit(1);
    }
  } else {
    const store = new SessionStore(null);
    server = createServer(store);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
  }

  try {
    await run(base);
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
  }

  console.log(`[smoke] ${checks - failures}/${checks} checks passed`);
  if (failures > 0) {
    console.error('[smoke] ACCEPTANCE FAILED');
    process.exit(1);
  }
  console.log('[smoke] ACCEPTANCE PASSED');
}

main().catch((err) => {
  console.error(`[smoke] unexpected error: ${err.stack || err}`);
  process.exit(1);
});
