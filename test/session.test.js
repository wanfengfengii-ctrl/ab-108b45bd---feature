'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { SessionStore } = require('../src/session');
const { replay } = require('../src/events');

function sampleSetup(overrides = {}) {
  return {
    legs: [
      { x: -2, y: -2, deployed: true },
      { x: 2, y: -2, deployed: true },
      { x: 2, y: 2, deployed: true },
      { x: -2, y: 2, deployed: true },
    ],
    postures: [
      { x: 0.8, y: 0.2, r: 0.3 }, // 偏离对角线，收起角点后仍可安全
      { x: 0, y: 0, r: 2 }, // 相切
      { x: 0, y: 0, r: 2.5 }, // 越界
      { x: 0.2, y: 0.2, r: 0.5 }, // 靠近反对角线，收起 L1 后越界
    ],
    ...overrides,
  };
}

test('录入校验：支腿/姿态数量边界', () => {
  const store = new SessionStore(null);
  assert.equal(store.createSession(sampleSetup({ legs: sampleSetup().legs.slice(0, 3) })).status, 400);
  assert.equal(store.createSession(sampleSetup({ legs: [...sampleSetup().legs, { x: 0, y: 3, deployed: true }, { x: 1, y: 3, deployed: true }, { x: 2, y: 3, deployed: true }] })).status, 400);
  assert.equal(store.createSession(sampleSetup({ postures: sampleSetup().postures.slice(0, 3) })).status, 400);
  const nine = Array.from({ length: 9 }, (_, i) => ({ x: 0, y: 0, r: 0.1 + i * 0.01 }));
  assert.equal(store.createSession(sampleSetup({ postures: nine })).status, 400);
});

test('录入校验：坐标/半径/部署状态', () => {
  const store = new SessionStore(null);
  const bad1 = sampleSetup();
  bad1.legs[0].x = NaN;
  assert.equal(store.createSession(bad1).status, 400);
  const bad2 = sampleSetup();
  bad2.postures[0].r = -1;
  assert.equal(store.createSession(bad2).status, 400);
  const bad3 = sampleSetup();
  bad3.legs[0].deployed = 'yes';
  assert.equal(store.createSession(bad3).status, 400);
});

test('初始状态不安全则拒绝创建', () => {
  const store = new SessionStore(null);
  const setup = sampleSetup();
  setup.postures[0] = { x: 10, y: 10, r: 1 };
  const r = store.createSession(setup);
  assert.equal(r.ok, false);
  assert.equal(r.status, 422);
  assert.match(r.error, /初始状态不安全/);
});

test('相切姿态可切换，越界姿态被拒绝且不写轨迹', () => {
  const store = new SessionStore(null);
  const { sessionId } = store.createSession(sampleSetup());

  const tangent = store.applyOp(sessionId, 1, { type: 'switch_posture', posture: 1 });
  assert.equal(tangent.ok, true, '相切必须视为安全');
  assert.equal(tangent.state.revision, 2);

  const before = store.getEvents(sessionId).length;
  const outside = store.applyOp(sessionId, 2, { type: 'switch_posture', posture: 2 });
  assert.equal(outside.ok, false);
  assert.equal(outside.status, 422);
  assert.match(outside.error, /越出/);
  assert.equal(store.getEvents(sessionId).length, before, '被拒绝的操作不得写入轨迹');
  assert.equal(store.getState(sessionId).revision, 2);
  assert.ok(store.getState(sessionId).lastRejection.reason.includes('越出'));
});

test('修订号过期返回 409 且不写轨迹', () => {
  const store = new SessionStore(null);
  const { sessionId } = store.createSession(sampleSetup());
  const r = store.applyOp(sessionId, 99, { type: 'switch_posture', posture: 1 });
  assert.equal(r.ok, false);
  assert.equal(r.status, 409);
  assert.match(r.error, /修订号过期/);
  assert.equal(store.getEvents(sessionId).length, 1);
  assert.equal(r.state.revision, 1, '响应携带最新状态');
});

test('收起支腿导致圆盘越界被拒绝', () => {
  const store = new SessionStore(null);
  const { sessionId } = store.createSession(sampleSetup());
  // 切到靠近反对角线的姿态后，收起 L1 会使圆盘越出三角支承
  store.applyOp(sessionId, 1, { type: 'switch_posture', posture: 3 }); // (0.2,0.2,r=0.5)
  const r = store.applyOp(sessionId, 2, { type: 'toggle_leg', leg: 0, deployed: false });
  assert.equal(r.ok, false);
  assert.equal(r.status, 422);
  assert.equal(store.getState(sessionId).legs[0].deployed, true, '状态未被改动');
});

test('支腿不足 3 只的收起被拒绝', () => {
  const store = new SessionStore(null);
  const setup = sampleSetup();
  setup.legs[3].deployed = false; // 初始仅 3 只部署，仍可安全支承
  const { sessionId } = store.createSession(setup);
  const r = store.applyOp(sessionId, 1, { type: 'toggle_leg', leg: 2, deployed: false });
  assert.equal(r.ok, false);
  assert.match(r.error, /不足 3 只/);
});

test('无变化操作被拒绝（幂等防护）', () => {
  const store = new SessionStore(null);
  const { sessionId } = store.createSession(sampleSetup());
  const same = store.applyOp(sessionId, 1, { type: 'switch_posture', posture: 0 });
  assert.equal(same.ok, false);
  assert.equal(same.status, 422);
  const toggle = store.applyOp(sessionId, 1, { type: 'toggle_leg', leg: 0, deployed: true });
  assert.equal(toggle.ok, false);
  assert.equal(toggle.status, 422);
});

test('状态由事件轨迹重放得到，且轨迹持久化后可重建', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dome-events-'));
  try {
    const store = new SessionStore(dir);
    const { sessionId } = store.createSession(sampleSetup());
    store.applyOp(sessionId, 1, { type: 'toggle_leg', leg: 3, deployed: false });
    store.applyOp(sessionId, 2, { type: 'toggle_leg', leg: 3, deployed: true });
    store.applyOp(sessionId, 3, { type: 'switch_posture', posture: 1 });

    const events = store.getEvents(sessionId);
    assert.equal(events.length, 4);
    assert.deepEqual(
      events.map((e) => e.type),
      ['session_created', 'leg_toggled', 'leg_toggled', 'posture_switched'],
    );

    // 重放 = 实时状态
    const projected = replay(events);
    const live = store.getState(sessionId);
    assert.equal(projected.currentPosture, live.currentPosture);
    assert.deepEqual(projected.legs, live.legs.map(({ id, ...rest }) => rest));

    // 新实例从磁盘 JSONL 重建
    const restored = new SessionStore(dir);
    const rebuilt = restored.getState(sessionId);
    assert.equal(rebuilt.revision, 4);
    assert.equal(rebuilt.currentPosture, 1);
    assert.equal(rebuilt.legs[3].deployed, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('未知会话返回 404', () => {
  const store = new SessionStore(null);
  assert.equal(store.applyOp('nope', 0, { type: 'switch_posture', posture: 0 }).status, 404);
  assert.equal(store.getState('nope'), null);
});

test('安全窗口复核：逐姿态给出区域/落入/裕量/结论，且不写轨迹', () => {
  const store = new SessionStore(null);
  const setup = sampleSetup();
  const { sessionId } = store.createSession(setup);

  const r = store.reviewSafetyWindow(sessionId, 1, 0.25);
  assert.equal(r.ok, true);
  assert.equal(r.review.revision, 1, '复核结果对应提交时的修订号');
  assert.equal(r.review.extraError, 0.25);
  assert.equal(r.review.supportPolygon.length, 4);
  assert.equal(r.review.postures.length, setup.postures.length);
  for (const w of r.review.postures) {
    const expected = setup.postures[w.id].r + 0.25;
    assert.ok(Math.abs(w.effectiveRadius - expected) < 1e-12, '有效半径 = 自身半径 + 附加误差');
    assert.equal(typeof w.inside, 'boolean');
    assert.equal(typeof w.margin, 'number');
    assert.ok(Array.isArray(w.region));
    assert.ok(w.conclusion, '每个姿态都必须有可解释结论');
  }
  // P1 (0.8,0.2,r=0.3)+0.25=0.55 在 [±2]² 内：窗口 [±1.45]²，裕量 1.45-0.8=0.65
  const p1 = r.review.postures[0];
  assert.equal(p1.inside, true);
  assert.ok(Math.abs(p1.margin - 0.65) < 1e-9);
  assert.equal(p1.region.length, 4);
  // P2 (0,0,r=2)+0.25=2.25 > 内切半径 2：窗口为空
  const p2 = r.review.postures[1];
  assert.equal(p2.empty, true);
  assert.equal(p2.inside, false);
  assert.match(p2.conclusion, /为空/);

  assert.equal(store.getEvents(sessionId).length, 1, '复核是只读操作，不得写入事件轨迹');
  assert.equal(store.getState(sessionId).revision, 1);
});

test('安全窗口复核：边界接触（裕量 0）仍判定为可停留', () => {
  const store = new SessionStore(null);
  const { sessionId } = store.createSession(sampleSetup());
  const r = store.reviewSafetyWindow(sessionId, 1, 0);
  assert.equal(r.ok, true);
  // P2 (0,0,r=2) 与四边相切
  const p2 = r.review.postures[1];
  assert.equal(p2.inside, true, '边界接触仍安全');
  assert.ok(Math.abs(p2.margin) < 1e-9);
  assert.equal(p2.degenerate, true, '区域退化为点');
  assert.match(p2.conclusion, /边界接触仍安全/);
});

test('安全窗口复核：修订号过期返回 409，已接受操作后须重新复核', () => {
  const store = new SessionStore(null);
  const { sessionId } = store.createSession(sampleSetup());

  const stale = store.reviewSafetyWindow(sessionId, 99, 0.1);
  assert.equal(stale.ok, false);
  assert.equal(stale.status, 409);
  assert.match(stale.error, /修订号过期/);
  assert.equal(stale.state.revision, 1, '409 响应携带最新状态以便重同步');

  // 发生已接受操作后，旧修订号的复核不再有效
  store.applyOp(sessionId, 1, { type: 'switch_posture', posture: 1 });
  const outdated = store.reviewSafetyWindow(sessionId, 1, 0.1);
  assert.equal(outdated.status, 409);
  const fresh = store.reviewSafetyWindow(sessionId, 2, 0.1);
  assert.equal(fresh.ok, true);
  assert.equal(fresh.review.revision, 2);
});

test('安全窗口复核：非法误差与未知会话', () => {
  const store = new SessionStore(null);
  const { sessionId } = store.createSession(sampleSetup());
  assert.equal(store.reviewSafetyWindow(sessionId, 1, -0.1).status, 400);
  assert.equal(store.reviewSafetyWindow(sessionId, 1, NaN).status, 400);
  assert.equal(store.reviewSafetyWindow(sessionId, 1, Infinity).status, 400);
  assert.equal(store.reviewSafetyWindow(sessionId, 'x', 0.1).status, 400);
  assert.equal(store.reviewSafetyWindow('nope', 1, 0.1).status, 404);
});

test('安全窗口复核：只针对当时已部署支腿形成的支承面', () => {
  const store = new SessionStore(null);
  const setup = sampleSetup();
  setup.legs.push({ x: 0, y: 3.4, deployed: true }); // 第 5 只支腿
  const { sessionId } = store.createSession(setup);
  // 收起 L5 后，支承面从五边形退回方形 [±2]²
  store.applyOp(sessionId, 1, { type: 'toggle_leg', leg: 4, deployed: false });
  const r = store.reviewSafetyWindow(sessionId, 2, 0);
  assert.equal(r.ok, true);
  assert.equal(r.review.supportPolygon.length, 4, '复核只基于当前已部署支腿');
  // P1 (0.8,0.2,r=0.3)：方形窗口 [±1.7]²，裕量 1.7-0.8=0.9
  assert.ok(Math.abs(r.review.postures[0].margin - 0.9) < 1e-9);
});
