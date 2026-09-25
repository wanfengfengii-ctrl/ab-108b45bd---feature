'use strict';

/**
 * 平面支承几何：凸包、圆盘-凸多边形包含、支承安全评估、安全窗口（内缩区域）。
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
 * 支承面（已部署支腿凸包）有效性判定。
 * 返回 { ok, hull, reason }；reason 为不可用的中文说明（可用时为 null）。
 */
function supportSurface(legs) {
  const deployed = legs.filter((l) => l.deployed);
  if (deployed.length < 3) {
    return {
      ok: false,
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
      ok: false,
      hull,
      reason: '已部署支腿共线或重合，支承多边形退化，无法形成安全支承',
    };
  }
  return { ok: true, hull, reason: null };
}

/**
 * 支承安全评估：所有已部署支腿的凸包必须完整包含当前载荷圆盘。
 * 返回 { safe, hull, reason }；reason 为拒绝/不安全的中文说明（安全时为 null）。
 */
function evaluateSupport(legs, posture) {
  const surface = supportSurface(legs);
  if (!surface.ok) {
    return { safe: false, hull: surface.hull, reason: surface.reason };
  }
  if (!diskInsidePolygon(surface.hull, posture, posture.r)) {
    return {
      safe: false,
      hull: surface.hull,
      reason: '载荷投影圆盘将越出支承多边形边界',
    };
  }
  return { safe: true, hull: surface.hull, reason: null };
}

/**
 * 用闭半平面 n·p >= c 裁剪凸多边形（n 为指向内侧的单位法向）。
 * Sutherland–Hodgman：边界上的点保留（闭区域，相切仍安全）。
 * 返回裁剪后的顶点列（CCW，可能为空）。
 */
function clipHalfPlane(poly, nx, ny, c) {
  const out = [];
  const n = poly.length;
  for (let i = 0; i < n; i += 1) {
    const cur = poly[i];
    const prev = poly[(i + n - 1) % n];
    const curD = nx * cur.x + ny * cur.y - c;
    const prevD = nx * prev.x + ny * prev.y - c;
    const curIn = curD >= 0;
    const prevIn = prevD >= 0;
    if (curIn !== prevIn) {
      const t = prevD / (prevD - curD);
      out.push({ x: prev.x + t * (cur.x - prev.x), y: prev.y + t * (cur.y - prev.y) });
    }
    if (curIn) out.push(cur);
  }
  return out;
}

/** 去除相邻（含首尾）距离不超过 tol 的重复顶点。 */
function dedupePoints(points, tol) {
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
 * 可放置投影中心的闭合区域：CCW 凸多边形向内收缩 radius 后的半平面交集，
 * 即所有使半径 radius 的圆盘完整落在多边形内的圆心集合。
 * 区域为闭集（边界接触仍安全）；可能退化为线段/点，或为空。
 * 返回 { kind: 'polygon'|'segment'|'point'|'empty', vertices, reason }，
 * reason 为退化/为空时的中文解释（正常多边形时为 null）。
 */
function safePlacementRegion(poly, radius) {
  const coords = [radius];
  for (const p of poly) coords.push(p.x, p.y);
  const scale = scaleOf(coords);
  const tol = EPS * scale;

  if (poly.length < 3 || Math.abs(polygonArea(poly)) <= tol * scale) {
    return { kind: 'empty', vertices: [], reason: '支承多边形退化，不存在安全放置区域' };
  }

  let region = poly.map((p) => ({ x: p.x, y: p.y }));
  for (let i = 0; i < poly.length && region.length > 0; i += 1) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy);
    if (len === 0) continue;
    // CCW 边的内侧单位法向（边方向左转 90°）
    const nx = -dy / len;
    const ny = dx / len;
    region = clipHalfPlane(region, nx, ny, nx * a.x + ny * a.y + radius);
  }

  const vertices = dedupePoints(region, tol);
  if (vertices.length === 0) {
    return {
      kind: 'empty',
      vertices: [],
      reason: '安全窗口为空：该有效半径下支承面内没有可放置投影中心的位置',
    };
  }
  if (vertices.length === 1) {
    return { kind: 'point', vertices, reason: '安全窗口退化为一个点' };
  }
  if (vertices.length === 2) {
    return { kind: 'segment', vertices, reason: '安全窗口退化为一条线段' };
  }
  if (Math.abs(polygonArea(vertices)) <= tol * scale) {
    // 数值上退化的细长条：按最大跨度归类为点或线段
    let far = [vertices[0], vertices[0]];
    let maxD = 0;
    for (let i = 0; i < vertices.length; i += 1) {
      for (let j = i + 1; j < vertices.length; j += 1) {
        const d = Math.hypot(vertices[i].x - vertices[j].x, vertices[i].y - vertices[j].y);
        if (d > maxD) {
          maxD = d;
          far = [vertices[i], vertices[j]];
        }
      }
    }
    if (maxD <= tol) return { kind: 'point', vertices: [far[0]], reason: '安全窗口退化为一个点' };
    return { kind: 'segment', vertices: far, reason: '安全窗口退化为一条线段' };
  }
  return { kind: 'polygon', vertices, reason: null };
}

function fmtMargin(v) {
  return Math.abs(v).toFixed(3);
}

/** 由区域形态、中心内外与裕量生成可解释的中文结论。 */
function windowConclusion(region, centerInside, margin, tol) {
  if (region.kind === 'empty') return region.reason;
  const tangent = Math.abs(margin) <= tol;
  if (region.kind === 'point' || region.kind === 'segment') {
    const place = region.kind === 'point' ? '该点' : '该线段';
    return centerInside
      ? `${region.reason}，当前中心落在${place}上（边界接触，仍安全）`
      : `${region.reason}，当前中心偏离${place} ${fmtMargin(-margin)}，不可停留`;
  }
  const n = region.vertices.length;
  if (tangent) return `安全窗口为 ${n} 边形，当前中心与最近安全边界相切（仍安全），裕量 0`;
  if (centerInside) return `安全窗口为 ${n} 边形，当前中心在窗口内，距最近安全边界 ${fmtMargin(margin)}`;
  return `安全窗口为 ${n} 边形，当前中心越出窗口 ${fmtMargin(-margin)}，不可停留`;
}

/**
 * 安全窗口复核：把统一附加定位误差叠加到每个姿态自身的不确定半径上，
 * 在当时已部署支腿形成的支承面上，求各姿态可放置投影中心的闭合区域。
 *
 * 返回 { supportPolygon, supportOk, supportReason, postures: [...] }；
 * 每个姿态含：
 *   region       可放置投影中心的闭合区域（含退化/为空解释）
 *   centerInside 当前中心是否落入该区域（边界接触仍安全）
 *   margin       距最近安全边界的有符号裕量：>0 内净距，0 相切，<0 越界量；
 *                支承面无效时为 null
 *   conclusion   可解释的中文结论
 */
function assessSafetyWindows(legs, postures, extraError) {
  const surface = supportSurface(legs);
  const results = postures.map((p) => {
    const effectiveRadius = p.r + extraError;
    if (!surface.ok) {
      return {
        center: { x: p.x, y: p.y },
        ownRadius: p.r,
        effectiveRadius,
        region: { kind: 'empty', vertices: [], reason: surface.reason },
        centerInside: false,
        margin: null,
        conclusion: `${surface.reason}，该姿态无可停留的安全窗口`,
      };
    }
    const hull = surface.hull;
    const region = safePlacementRegion(hull, effectiveRadius);
    const coords = [p.x, p.y, effectiveRadius];
    for (const v of hull) coords.push(v.x, v.y);
    const tol = EPS * scaleOf(coords);
    let margin = Infinity;
    for (let i = 0; i < hull.length; i += 1) {
      const a = hull[i];
      const b = hull[(i + 1) % hull.length];
      margin = Math.min(margin, edgeMargin(a, b, p) - effectiveRadius);
    }
    const centerInside = region.kind !== 'empty' && margin >= -tol;
    return {
      center: { x: p.x, y: p.y },
      ownRadius: p.r,
      effectiveRadius,
      region,
      centerInside,
      margin,
      conclusion: windowConclusion(region, centerInside, margin, tol),
    };
  });
  return {
    supportPolygon: surface.hull,
    supportOk: surface.ok,
    supportReason: surface.reason,
    postures: results,
  };
}

module.exports = {
  EPS,
  isFiniteNumber,
  convexHull,
  polygonArea,
  edgeMargin,
  diskInsidePolygon,
  evaluateSupport,
  supportSurface,
  safePlacementRegion,
  assessSafetyWindows,
};
