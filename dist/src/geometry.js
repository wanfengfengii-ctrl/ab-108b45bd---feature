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

/** 多边形是否退化（顶点不足 3 个或面积近零）。 */
function isDegeneratePolygon(poly) {
  if (!Array.isArray(poly) || poly.length < 3) return true;
  const coords = [];
  for (const p of poly) coords.push(p.x, p.y);
  return Math.abs(polygonArea(poly)) <= EPS * scaleOf(coords) ** 2;
}

/** 用半平面 edgeMargin(a, b, c) >= r 裁剪凸多边形（Sutherland–Hodgman）。 */
function clipHalfPlane(poly, a, b, r, tol) {
  const out = [];
  const n = poly.length;
  for (let i = 0; i < n; i += 1) {
    const cur = poly[i];
    const prev = poly[(i + n - 1) % n];
    const dCur = edgeMargin(a, b, cur) - r;
    const dPrev = edgeMargin(a, b, prev) - r;
    const curIn = dCur >= -tol;
    const prevIn = dPrev >= -tol;
    if (curIn !== prevIn) {
      const t = dPrev / (dPrev - dCur);
      out.push({ x: prev.x + t * (cur.x - prev.x), y: prev.y + t * (cur.y - prev.y) });
    }
    if (curIn) out.push(cur);
  }
  return out;
}

/** 去掉相邻（含首尾）距离在容差内的重复顶点。 */
function dedupeVertices(points, tol) {
  const out = [];
  for (const p of points) {
    const last = out[out.length - 1];
    if (!last || Math.hypot(p.x - last.x, p.y - last.y) > tol) out.push(p);
  }
  while (out.length > 1) {
    const first = out[0];
    const last = out[out.length - 1];
    if (Math.hypot(first.x - last.x, first.y - last.y) > tol) break;
    out.pop();
  }
  return out;
}

/**
 * 安全窗口区域：CCW 凸多边形向内偏移 r 后，仍可完整容纳半径 r 圆盘的
 * 投影中心闭合区域 = 各边内侧半平面（距离 >= r）的交集，仍为凸形。
 * 返回顶点数组：可能为空集、单点、线段（退化）或正常多边形。
 */
function erodePolygon(poly, r) {
  const coords = [r];
  for (const p of poly) coords.push(p.x, p.y);
  const tol = EPS * scaleOf(coords);
  let out = poly.map((p) => ({ x: p.x, y: p.y }));
  for (let i = 0; i < poly.length && out.length > 0; i += 1) {
    out = clipHalfPlane(out, poly[i], poly[(i + 1) % poly.length], r, tol);
  }
  return dedupeVertices(out, tol);
}

function fmtNum(v) {
  const rounded = Math.round(v * 1000) / 1000;
  return String(Object.is(rounded, -0) ? 0 : rounded);
}

/**
 * 单姿态安全窗口评估：在 CCW 支承凸包 poly 内，有效半径 r 的载荷圆盘
 * 可放置投影中心的闭合区域、当前中心 center 是否落入、以及距最近安全边界的裕量。
 *
 * 返回 { region, empty, degenerate, inside, margin, conclusion }：
 * - region    闭合区域顶点（空集为 []，退化为 1~2 点或近零面积多边形）；
 * - inside    当前中心是否落入区域（边界接触 = 安全）；
 * - margin    当前中心距最近安全边界的裕量，负值表示越出边界的距离；
 * - conclusion 可解释结论（区域为空/退化时同样给出）。
 */
function assessSafetyWindow(poly, center, r) {
  const coords = [center.x, center.y, r];
  for (const p of poly) coords.push(p.x, p.y);
  const tol = EPS * scaleOf(coords);

  let margin = Infinity;
  for (let i = 0; i < poly.length; i += 1) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    margin = Math.min(margin, edgeMargin(a, b, center) - r);
  }
  const inside = margin >= -tol;

  const region = erodePolygon(poly, r);
  const empty = region.length === 0;
  const degenerate = !empty && isDegeneratePolygon(region);

  const shownMargin = Math.abs(margin) < tol ? 0 : margin;
  let conclusion;
  if (empty) {
    conclusion = `安全窗口为空：有效半径 ${fmtNum(r)} 的载荷圆盘在当前支承面内已不存在可完整容纳的投影中心位置`;
  } else if (degenerate) {
    conclusion = inside
      ? `安全窗口退化为点/线段：当前中心处于边界接触位置（边界接触仍安全），裕量 ${fmtNum(Math.max(shownMargin, 0))}`
      : `安全窗口退化为点/线段：当前中心不在窗口内，越出最近安全边界 ${fmtNum(-shownMargin)}`;
  } else {
    conclusion = inside
      ? `当前中心位于安全窗口内，距最近安全边界裕量 ${fmtNum(shownMargin)}`
      : `当前中心不在安全窗口内，越出最近安全边界 ${fmtNum(-shownMargin)}`;
  }
  return { region, empty, degenerate, inside, margin, conclusion };
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
  if (isDegeneratePolygon(hull)) {
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
  isDegeneratePolygon,
  erodePolygon,
  assessSafetyWindow,
  evaluateSupport,
};
