'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  convexHull,
  polygonArea,
  diskInsidePolygon,
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
