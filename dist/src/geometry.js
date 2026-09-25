'use strict';

/**
 * 平面支承几何：凸包、圆盘-凸多边形包含、支承安全评估。
 * 约定：凸包顶点按逆时针（CCW）返回；边界相切视为安全。
 */

const EPS = 1e-9;

function isFiniteNumber(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

function cross2(o, a, b) {
  return (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
}

/**
 * 单调链凸包。输入 [{x, y}, ...]，返回去重后的 CCW 顶点（不重复首点）。
 * 少于 3 个有效点或全部共线时返回退化的点列（长度 < 3 或面积为 0，由调用方判定）。
 */
function convexHull(points) {
  const sorted = points
    .map((p) => ({ x: p.x, y: p.y }))
    .sort((a, b) => a.x - b.x || a.y - b.y);
  const unique = [];
  for (const p of sorted) {
    const last = unique[unique.length - 1];
    if (!last || last.x !== p.x || last.y !== p.y) unique.push(p);
  }
  if (unique.length <= 2) return unique;

  const lower = [];
  for (const p of unique) {
    while (lower.length >= 2 && cross2(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) {
      lower.pop();
    }
    lower.push(p);
  }
  const upper = [];
  for (let i = unique.length - 1; i >= 0; i -= 1) {
    const p = unique[i];
    while (upper.length >= 2 && cross2(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) {
      upper.pop();
    }
    upper.push(p);
  }
  lower.pop();
  upper.pop();
  return lower.concat(upper);
}

/** 有向面积（CCW 为正）。 */
function polygonArea(poly) {
  let s = 0;
  for (let i = 0; i < poly.length; i += 1) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    s += a.x * b.y - b.x * a.y;
  }
  return s / 2;
}

/** 点 c 到 CCW 边 a->b 内侧的有向距离（内侧为正）。 */
function edgeMargin(a, b, c) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy);
  if (len === 0) return -Infinity;
  return (dx * (c.y - a.y) - dy * (c.x - a.x)) / len;
}

function scaleOf(values) {
  let m = 1;
  for (const v of values) m = Math.max(m, Math.abs(v));
  return m;
}

/**
 * 圆盘 (c, r) 是否完整落在 CCW 凸多边形内（含边界，相切为安全）。
 */
function diskInsidePolygon(poly, c, r) {
  const coords = [c.x, c.y, r];
  for (const p of poly) coords.push(p.x, p.y);
  const tol = EPS * scaleOf(coords);
  for (let i = 0; i < poly.length; i += 1) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    if (edgeMargin(a, b, c) < r - tol) return false;
  }
  return true;
}

/**
 * 支承安全评估：所有已部署支腿的凸包必须完整包含当前载荷圆盘。
 * 返回 { safe, hull, reason }；reason 为拒绝/不安全的中文说明（安全时为 null）。
 */
function evaluateSupport(legs, posture) {
  const deployed = legs.filter((l) => l.deployed);
  if (deployed.length < 3) {
    return {
      safe: false,
      hull: convexHull(deployed),
      reason: `已部署支腿仅 ${deployed.length} 只，不足 3 只，无法构成安全支承多边形`,
    };
  }
  const hull = convexHull(deployed);
  const coords = [];
  for (const p of hull) coords.push(p.x, p.y);
  const degenerate = hull.length < 3 || Math.abs(polygonArea(hull)) <= EPS * scaleOf(coords) ** 2;
  if (degenerate) {
    return {
      safe: false,
      hull,
      reason: '已部署支腿共线或重合，支承多边形退化，无法形成安全支承',
    };
  }
  if (!diskInsidePolygon(hull, posture, posture.r)) {
    return {
      safe: false,
      hull,
      reason: '载荷投影圆盘将越出支承多边形边界',
    };
  }
  return { safe: true, hull, reason: null };
}

module.exports = {
  EPS,
  isFiniteNumber,
  convexHull,
  polygonArea,
  edgeMargin,
  diskInsidePolygon,
  evaluateSupport,
};
