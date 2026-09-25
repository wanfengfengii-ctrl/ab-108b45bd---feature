'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createServer } = require('../src/server');
const { SessionStore } = require('../src/session');

async function withServer(fn) {
  const server = createServer(new SessionStore(null));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await fn(base);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

const post = (base, path, payload) =>
  fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

const setup = () => ({
  legs: [
    { x: -2, y: -2, deployed: true },
    { x: 2, y: -2, deployed: true },
    { x: 2, y: 2, deployed: true },
    { x: -2, y: 2, deployed: true },
  ],
  postures: [
    { x: 0, y: 0, r: 0.5 },
    { x: 0.5, y: 0.5, r: 0.5 },
    { x: -0.5, y: -0.5, r: 0.5 },
    { x: 0, y: 1, r: 0.5 },
  ],
});

test('GET /health 返回 200', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/health`);
    assert.equal(res.status, 200);
    assert.equal((await res.json()).status, 'ok');
  });
});

test('静态页面可访问', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/`);
    assert.equal(res.status, 200);
    assert.match(await res.text(), /安全操作演练/);
  });
});

test('完整 API 流程：创建→操作→状态→轨迹', async () => {
  await withServer(async (base) => {
    const created = await (await post(base, '/api/sessions', setup())).json();
    const sid = created.sessionId;
    assert.ok(sid);
    assert.equal(created.state.revision, 1);

    const op = await post(base, `/api/sessions/${sid}/ops`, {
      baseRevision: 1,
      op: { type: 'switch_posture', posture: 2 },
    });
    assert.equal(op.status, 200);
    assert.equal((await op.json()).state.revision, 2);

    const state = await (await fetch(`${base}/api/sessions/${sid}`)).json();
    assert.equal(state.currentPosture, 2);
    assert.equal(state.safe, true);

    const events = await (await fetch(`${base}/api/sessions/${sid}/events`)).json();
    assert.equal(events.events.length, 2);
  });
});

test('过期修订号返回 409，危险操作返回 422，且轨迹不变', async () => {
  await withServer(async (base) => {
    const created = await (await post(base, '/api/sessions', setup())).json();
    const sid = created.sessionId;

    const stale = await post(base, `/api/sessions/${sid}/ops`, {
      baseRevision: 7,
      op: { type: 'switch_posture', posture: 1 },
    });
    assert.equal(stale.status, 409);

    // 先切到偏心姿态，再收起两只相邻支腿 -> 只剩 2 只部署，第二次收起必须 422
    await post(base, `/api/sessions/${sid}/ops`, { baseRevision: 1, op: { type: 'switch_posture', posture: 3 } });
    await post(base, `/api/sessions/${sid}/ops`, { baseRevision: 2, op: { type: 'toggle_leg', leg: 0, deployed: false } });
    const danger = await post(base, `/api/sessions/${sid}/ops`, { baseRevision: 3, op: { type: 'toggle_leg', leg: 1, deployed: false } });
    assert.equal(danger.status, 422);
    const dangerBody = await danger.json();
    assert.ok(dangerBody.error);
    assert.equal(dangerBody.state.revision, 3);

    const events = await (await fetch(`${base}/api/sessions/${sid}/events`)).json();
    assert.equal(events.events.length, 3, '被拒绝的操作不得出现在轨迹中');

    const state = await (await fetch(`${base}/api/sessions/${sid}`)).json();
    assert.ok(state.lastRejection, '最近拒绝理由应随状态返回');
  });
});

test('错误请求：坏 JSON / 未知路由 / 未知会话', async () => {
  await withServer(async (base) => {
    const badJson = await fetch(`${base}/api/sessions`, { method: 'POST', body: '{oops' });
    assert.equal(badJson.status, 400);

    assert.equal((await fetch(`${base}/api/nope`)).status, 404);
    assert.equal((await fetch(`${base}/api/sessions/missing`)).status, 404);
    assert.equal((await fetch(`${base}/api/sessions/missing/events`)).status, 404);
  });
});

test('安全窗口复核 API：200/400/404/409 与轨迹只读', async () => {
  await withServer(async (base) => {
    const created = await (await post(base, '/api/sessions', setup())).json();
    const sid = created.sessionId;

    const ok = await post(base, `/api/sessions/${sid}/safety-window`, { baseRevision: 1, extraError: 0.3 });
    assert.equal(ok.status, 200);
    const review = await ok.json();
    assert.equal(review.revision, 1, '复核结果对应提交时的修订号');
    assert.equal(review.extraError, 0.3);
    assert.equal(review.postures.length, 4);
    for (const w of review.postures) {
      assert.equal(typeof w.inside, 'boolean');
      assert.equal(typeof w.margin, 'number');
      assert.ok(Array.isArray(w.region));
      assert.ok(w.conclusion);
    }

    // 复核是只读操作：事件轨迹不变
    const events = await (await fetch(`${base}/api/sessions/${sid}/events`)).json();
    assert.equal(events.events.length, 1);

    // 负误差 / 非整数修订号 → 400
    assert.equal((await post(base, `/api/sessions/${sid}/safety-window`, { baseRevision: 1, extraError: -0.5 })).status, 400);
    assert.equal((await post(base, `/api/sessions/${sid}/safety-window`, { baseRevision: 1.5, extraError: 0.1 })).status, 400);

    // 未知会话 → 404
    assert.equal((await post(base, '/api/sessions/nope/safety-window', { baseRevision: 1, extraError: 0.1 })).status, 404);

    // 已接受操作推进修订号后，旧修订号复核 → 409，可用新修订号重新复核
    await post(base, `/api/sessions/${sid}/ops`, { baseRevision: 1, op: { type: 'switch_posture', posture: 1 } });
    const stale = await post(base, `/api/sessions/${sid}/safety-window`, { baseRevision: 1, extraError: 0.3 });
    assert.equal(stale.status, 409);
    assert.equal((await stale.json()).state.revision, 2);
    const fresh = await post(base, `/api/sessions/${sid}/safety-window`, { baseRevision: 2, extraError: 0.3 });
    assert.equal(fresh.status, 200);
    assert.equal((await fresh.json()).revision, 2);
  });
});

test('静态目录路径穿越被拒绝', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/../src/server.js`);
    assert.notEqual(res.status, 200);
    const res2 = await fetch(`${base}/%2e%2e/package.json`);
    assert.notEqual(res2.status, 200);
  });
});
