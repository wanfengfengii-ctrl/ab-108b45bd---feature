'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  convexHull,
  polygonArea,
  diskInsidePolygon,
  erodePolygon,
  assessSafetyWindow,
  evaluateSupport,
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

const square = () => convexHull([
  { x: -2, y: -2 },
  { x: 2, y: -2 },
  { x: 2, y: 2 },
  { x: -2, y: 2 },
]);

test('安全窗口区域：方形内缩为闭合小方形', () => {
  const region = erodePolygon(square(), 0.5);
  assert.equal(region.length, 4);
  assert.ok(polygonArea(region) > 0, '区域仍为 CCW');
  assert.equal(Math.abs(polygonArea(region)), 9, '内缩 0.5 后应为 [±1.5]²');
});

test('安全窗口区域：内缩至内切圆半径退化为点，再大则为空', () => {
  const point = erodePolygon(square(), 2);
  assert.ok(point.length >= 1 && point.length <= 3, '应退化为点状区域');
  assert.ok(Math.abs(polygonArea(point)) < 1e-9 || point.length < 3);
  assert.deepEqual(erodePolygon(square(), 2.0001), [], '超出内切圆半径应为空集');
});

test('安全窗口评估：内部中心的区域、落入判定与裕量', () => {
  const w = assessSafetyWindow(square(), { x: 0, y: 0 }, 0.5);
  assert.equal(w.empty, false);
  assert.equal(w.degenerate, false);
  assert.equal(w.region.length, 4);
  assert.equal(w.inside, true);
  assert.ok(Math.abs(w.margin - 1.5) < 1e-9, '中心距最近安全边界裕量 1.5');
  assert.match(w.conclusion, /位于安全窗口内/);
});

test('安全窗口评估：边界接触（裕量 0）仍安全', () => {
  const w = assessSafetyWindow(square(), { x: 0, y: 0 }, 2);
  assert.equal(w.inside, true, '四边相切必须视为安全');
  assert.ok(Math.abs(w.margin) < 1e-9);
  assert.equal(w.empty, false);
  assert.equal(w.degenerate, true, '区域退化为点');
  assert.match(w.conclusion, /边界接触仍安全/);
});

test('安全窗口评估：区域为空时给出可解释结论', () => {
  const w = assessSafetyWindow(square(), { x: 0, y: 0 }, 2.5);
  assert.equal(w.empty, true);
  assert.equal(w.inside, false);
  assert.ok(w.margin < 0);
  assert.match(w.conclusion, /为空/);
});

test('安全窗口评估：中心在窗口外时裕量为负且可解释', () => {
  const w = assessSafetyWindow(square(), { x: 1.8, y: 0 }, 0.5);
  assert.equal(w.inside, false);
  assert.ok(Math.abs(w.margin + 0.3) < 1e-9, '中心越出最近安全边界 0.3');
  assert.match(w.conclusion, /越出最近安全边界/);
});

test('安全窗口评估：三角支承面上的偏心姿态', () => {
  const tri = convexHull([
    { x: 2, y: -2 },
    { x: 2, y: 2 },
    { x: -2, y: 2 },
  ]);
  const inside = assessSafetyWindow(tri, { x: 0.9, y: 0.9 }, 0.75);
  assert.equal(inside.inside, true);
  assert.ok(Math.abs(inside.margin - 0.35) < 1e-9, '最近边为 x=2 / y=2，裕量 1.1-0.75');
  const outside = assessSafetyWindow(tri, { x: -0.9, y: -0.9 }, 0.75);
  assert.equal(outside.inside, false, '中心越出对角边');
  assert.ok(outside.margin < 0);
});
