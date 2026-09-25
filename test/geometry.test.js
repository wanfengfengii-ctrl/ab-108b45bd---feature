'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  convexHull,
  polygonArea,
  diskInsidePolygon,
  evaluateSupport,
  safePlacementRegion,
  assessSafetyWindows,
} = require('../src/geometry');

test('凸包：方形点集返回 4 个 CCW 顶点', () => {
  const hull = convexHull([
    { x: 0, y: 0 },
    { x: 2, y: 0 },
    { x: 2, y: 2 },
    { x: 0, y: 2 },
    { x: 1, y: 1 }, // 内部点不应出现
  ]);
  assert.equal(hull.length, 4);
  assert.ok(polygonArea(hull) > 0, '应为逆时针');
  assert.equal(Math.abs(polygonArea(hull)), 4);
});

test('凸包：重复坐标被去重', () => {
  const hull = convexHull([
    { x: 0, y: 0 },
    { x: 0, y: 0 },
    { x: 1, y: 0 },
    { x: 0, y: 1 },
  ]);
  assert.equal(hull.length, 3);
});

test('凸包：共线点集退化', () => {
  const hull = convexHull([
    { x: 0, y: 0 },
    { x: 1, y: 1 },
    { x: 2, y: 2 },
  ]);
  assert.ok(hull.length < 3 || Math.abs(polygonArea(hull)) < 1e-12);
});

test('圆盘包含：内部、相切、越界', () => {
  const square = convexHull([
    { x: -2, y: -2 },
    { x: 2, y: -2 },
    { x: 2, y: 2 },
    { x: -2, y: 2 },
  ]);
  assert.equal(diskInsidePolygon(square, { x: 0, y: 0 }, 1), true, '内部圆盘');
  assert.equal(diskInsidePolygon(square, { x: 0, y: 0 }, 2), true, '四边相切=安全');
  assert.equal(diskInsidePolygon(square, { x: 2, y: 0 }, 0), true, '半径 0 且圆心在边界上=安全');
  assert.equal(diskInsidePolygon(square, { x: 0, y: 0 }, 2.0001), false, '略微越界=不安全');
  assert.equal(diskInsidePolygon(square, { x: 3, y: 0 }, 0.5), false, '圆心在外=不安全');
});

test('支承评估：支腿不足 3 只', () => {
  const legs = [
    { x: 0, y: 0, deployed: true },
    { x: 1, y: 0, deployed: true },
    { x: 0, y: 1, deployed: false },
  ];
  const r = evaluateSupport(legs, { x: 0, y: 0, r: 0 });
  assert.equal(r.safe, false);
  assert.match(r.reason, /不足 3 只/);
});

test('支承评估：已部署支腿共线', () => {
  const legs = [
    { x: 0, y: 0, deployed: true },
    { x: 1, y: 0, deployed: true },
    { x: 2, y: 0, deployed: true },
  ];
  const r = evaluateSupport(legs, { x: 1, y: 0, r: 0 });
  assert.equal(r.safe, false);
  assert.match(r.reason, /退化/);
});

test('支承评估：只统计已部署支腿', () => {
  const legs = [
    { x: -2, y: -2, deployed: true },
    { x: 2, y: -2, deployed: true },
    { x: 0, y: 2, deployed: true },
    { x: 0, y: -100, deployed: false }, // 收起的不参与
  ];
  const ok = evaluateSupport(legs, { x: 0, y: 0, r: 0.5 });
  assert.equal(ok.safe, true);
  const bad = evaluateSupport(legs, { x: 0, y: -2, r: 0.5 });
  assert.equal(bad.safe, false);
  assert.match(bad.reason, /越出/);
});

const square = () =>
  convexHull([
    { x: -2, y: -2 },
    { x: 2, y: -2 },
    { x: 2, y: 2 },
    { x: -2, y: 2 },
  ]);

test('安全放置区域：方形内缩为较小方形（闭合区域）', () => {
  const region = safePlacementRegion(square(), 1);
  assert.equal(region.kind, 'polygon');
  assert.equal(region.vertices.length, 4);
  assert.equal(Math.abs(polygonArea(region.vertices)), 4, '内缩 1 后为 ±1 方形');
  assert.equal(region.reason, null);
});

test('安全放置区域：半径等于内切圆半径时退化为点', () => {
  const region = safePlacementRegion(square(), 2);
  assert.equal(region.kind, 'point');
  assert.ok(Math.hypot(region.vertices[0].x, region.vertices[0].y) < 1e-9);
  assert.match(region.reason, /退化为一个点/);
});

test('安全放置区域：窄条内缩退化为线段', () => {
  const strip = convexHull([
    { x: -4, y: -1 },
    { x: 4, y: -1 },
    { x: 4, y: 1 },
    { x: -4, y: 1 },
  ]);
  const region = safePlacementRegion(strip, 1);
  assert.equal(region.kind, 'segment');
  const [a, b] = region.vertices;
  assert.ok(Math.abs(a.y) < 1e-9 && Math.abs(b.y) < 1e-9);
  assert.ok(Math.abs(Math.abs(a.x - b.x) - 6) < 1e-9, '线段应沿 x 轴跨度 6');
  assert.match(region.reason, /退化为一条线段/);
});

test('安全放置区域：半径过大时为空并给出解释', () => {
  const region = safePlacementRegion(square(), 2.5);
  assert.equal(region.kind, 'empty');
  assert.equal(region.vertices.length, 0);
  assert.match(region.reason, /为空/);
});

test('安全窗口评估：逐姿态给出区域、内外判定与裕量', () => {
  const legs = [
    { x: -2, y: -2, deployed: true },
    { x: 2, y: -2, deployed: true },
    { x: 2, y: 2, deployed: true },
    { x: -2, y: 2, deployed: true },
    { x: 0, y: 9, deployed: false }, // 收起的不参与支承面
  ];
  const postures = [
    { x: 0, y: 0, r: 0.5 }, // 有效半径 1.0，居中
    { x: 1.4, y: 0, r: 0.5 }, // 有效半径 1.0，越出右边界
    { x: 0, y: 0, r: 1.5 }, // 有效半径 2.0，与四边相切
  ];
  const r = assessSafetyWindows(legs, postures, 0.5);
  assert.equal(r.supportOk, true);
  assert.equal(r.supportPolygon.length, 4);

  const [p1, p2, p3] = r.postures;
  assert.equal(p1.effectiveRadius, 1);
  assert.equal(p1.region.kind, 'polygon');
  assert.equal(p1.centerInside, true);
  assert.ok(Math.abs(p1.margin - 1) < 1e-9, `居中裕量应为 1，实际 ${p1.margin}`);
  assert.match(p1.conclusion, /在窗口内/);

  assert.equal(p2.centerInside, false);
  assert.ok(Math.abs(p2.margin - -0.4) < 1e-9, `越界量应为 0.4，实际 ${p2.margin}`);
  assert.match(p2.conclusion, /越出窗口/);

  assert.equal(p3.region.kind, 'point', '相切时窗口退化为一点');
  assert.equal(p3.centerInside, true, '边界接触仍安全');
  assert.ok(Math.abs(p3.margin) < 1e-9, '相切裕量为 0');
  assert.match(p3.conclusion, /边界接触，仍安全/);
});

test('安全窗口评估：支承面无效时每个姿态都有可解释结论', () => {
  const legs = [
    { x: -2, y: -2, deployed: true },
    { x: 2, y: -2, deployed: true },
    { x: 2, y: 2, deployed: false },
    { x: -2, y: 2, deployed: false },
  ];
  const r = assessSafetyWindows(legs, [{ x: 0, y: 0, r: 0.5 }], 0.1);
  assert.equal(r.supportOk, false);
  assert.match(r.supportReason, /不足 3 只/);
  assert.equal(r.postures[0].region.kind, 'empty');
  assert.equal(r.postures[0].centerInside, false);
  assert.equal(r.postures[0].margin, null);
  assert.match(r.postures[0].conclusion, /不足 3 只/);
});
