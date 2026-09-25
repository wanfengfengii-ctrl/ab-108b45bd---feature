'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { EVENT_TYPES, replay } = require('./events');
const { isFiniteNumber, evaluateSupport } = require('./geometry');

const MIN_LEGS = 4;
const MAX_LEGS = 6;
const MIN_POSTURES = 4;
const MAX_POSTURES = 8;

function fail(status, error) {
  return { ok: false, status, error };
}

/** 录入校验：返回 { ok, legs, postures, currentPosture } 或 { ok:false, status, error }。 */
function validateSetup(input) {
  if (!input || typeof input !== 'object') {
    return fail(400, '请求体必须是 JSON 对象');
  }
  const { legs, postures } = input;
  if (!Array.isArray(legs) || legs.length < MIN_LEGS || legs.length > MAX_LEGS) {
    return fail(400, `支腿数量须在 ${MIN_LEGS}~${MAX_LEGS} 只之间`);
  }
  for (let i = 0; i < legs.length; i += 1) {
    const l = legs[i];
    if (!l || !isFiniteNumber(l.x) || !isFiniteNumber(l.y)) {
      return fail(400, `支腿 L${i + 1} 的坐标必须是有限数值`);
    }
    if (typeof l.deployed !== 'boolean') {
      return fail(400, `支腿 L${i + 1} 的部署状态 deployed 必须是布尔值`);
    }
  }
  if (!Array.isArray(postures) || postures.length < MIN_POSTURES || postures.length > MAX_POSTURES) {
    return fail(400, `载荷姿态数量须在 ${MIN_POSTURES}~${MAX_POSTURES} 个之间`);
  }
  for (let i = 0; i < postures.length; i += 1) {
    const p = postures[i];
    if (!p || !isFiniteNumber(p.x) || !isFiniteNumber(p.y)) {
      return fail(400, `载荷姿态 P${i + 1} 的投影中心必须是有限数值`);
    }
    if (!isFiniteNumber(p.r) || p.r < 0) {
      return fail(400, `载荷姿态 P${i + 1} 的不确定半径必须是非负有限数值`);
    }
  }
  let currentPosture = 0;
  if (input.currentPosture !== undefined) {
    if (!Number.isInteger(input.currentPosture) || input.currentPosture < 0 || input.currentPosture >= postures.length) {
      return fail(400, '初始姿态索引越界');
    }
    currentPosture = input.currentPosture;
  }
  return {
    ok: true,
    legs: legs.map((l) => ({ x: l.x, y: l.y, deployed: l.deployed })),
    postures: postures.map((p) => ({ x: p.x, y: p.y, r: p.r })),
    currentPosture,
  };
}

class SessionStore {
  /**
   * @param {string|null} dataDir 事件轨迹落盘目录；null 表示仅内存（测试用）。
   */
  constructor(dataDir = null) {
    this.dataDir = dataDir;
    /** @type {Map<string, {id:string, events:object[], lastRejection:object|null}>} */
    this.sessions = new Map();
    if (this.dataDir) {
      fs.mkdirSync(this.dataDir, { recursive: true });
      this._loadFromDisk();
    }
  }

  _logFile(id) {
    return path.join(this.dataDir, `session-${id}.jsonl`);
  }

  _loadFromDisk() {
    for (const name of fs.readdirSync(this.dataDir)) {
      if (!/^session-.+\.jsonl$/.test(name)) continue;
      const id = name.slice('session-'.length, -'.jsonl'.length);
      const lines = fs.readFileSync(path.join(this.dataDir, name), 'utf8').split('\n').filter(Boolean);
      const events = lines.map((line) => JSON.parse(line));
      this.sessions.set(id, { id, events, lastRejection: null });
    }
  }

  /** 追加事件到内存轨迹与本地只增日志文件。 */
  _append(session, event) {
    session.events.push(event);
    if (this.dataDir) {
      fs.appendFileSync(this._logFile(session.id), `${JSON.stringify(event)}\n`, 'utf8');
    }
  }

  /** 创建演练：校验录入 + 初始状态必须安全，然后写入 session_created 事件。 */
  createSession(input) {
    const checked = validateSetup(input);
    if (!checked.ok) return checked;

    const initial = evaluateSupport(checked.legs, checked.postures[checked.currentPosture]);
    if (!initial.safe) {
      return fail(422, `初始状态不安全，无法开始演练：${initial.reason}`);
    }

    const id = crypto.randomUUID();
    const session = { id, events: [], lastRejection: null };
    this.sessions.set(id, session);
    this._append(session, {
      seq: 0,
      type: EVENT_TYPES.SESSION_CREATED,
      at: new Date().toISOString(),
      legs: checked.legs,
      postures: checked.postures,
      currentPosture: checked.currentPosture,
    });
    return { ok: true, sessionId: id, state: this.getState(id) };
  }

  /** 重放轨迹得到当前状态视图。 */
  getState(id) {
    const session = this.sessions.get(id);
    if (!session) return null;
    const projected = replay(session.events);
    const posture = projected.postures[projected.currentPosture];
    const support = evaluateSupport(projected.legs, posture);
    return {
      sessionId: id,
      revision: session.events.length,
      legs: projected.legs.map((l, i) => ({ id: i, ...l })),
      postures: projected.postures.map((p, i) => ({ id: i, ...p })),
      currentPosture: projected.currentPosture,
      supportPolygon: support.hull,
      safe: support.safe,
      lastRejection: session.lastRejection,
    };
  }

  getEvents(id) {
    const session = this.sessions.get(id);
    if (!session) return null;
    // 轨迹只读：返回深拷贝，调用方无法借此改写。
    return session.events.map((e) => JSON.parse(JSON.stringify(e)));
  }

  /**
   * 应用一次操作（切换一个姿态 或 收放一只支腿）。
   * 校验失败 / 修订号过期 / 结果不安全 => 拒绝且不写入轨迹。
   */
  applyOp(id, baseRevision, op) {
    const session = this.sessions.get(id);
    if (!session) return fail(404, '演练会话不存在');

    const revision = session.events.length;
    const reject = (status, error) => {
      session.lastRejection = { at: new Date().toISOString(), baseRevision, reason: error };
      return { ok: false, status, error, state: this.getState(id) };
    };

    if (!Number.isInteger(baseRevision)) {
      return reject(400, '操作必须携带整数修订号 baseRevision');
    }
    if (baseRevision !== revision) {
      return reject(409, `修订号过期：所见为 ${baseRevision}，当前为 ${revision}，请刷新后重试`);
    }
    if (!op || typeof op !== 'object') {
      return reject(400, '缺少操作体 op');
    }

    const projected = replay(session.events);
    let event = null;

    if (op.type === 'switch_posture') {
      const target = op.posture;
      if (!Number.isInteger(target) || target < 0 || target >= projected.postures.length) {
        return reject(400, '目标姿态索引越界');
      }
      if (target === projected.currentPosture) {
        return reject(422, `姿态 P${target + 1} 已是当前姿态，无需切换`);
      }
      event = { type: EVENT_TYPES.POSTURE_SWITCHED, posture: target };
    } else if (op.type === 'toggle_leg') {
      const legIndex = op.leg;
      if (!Number.isInteger(legIndex) || legIndex < 0 || legIndex >= projected.legs.length) {
        return reject(400, '目标支腿索引越界');
      }
      if (typeof op.deployed !== 'boolean') {
        return reject(400, '支腿目标状态 deployed 必须是布尔值');
      }
      if (projected.legs[legIndex].deployed === op.deployed) {
        return reject(422, `支腿 L${legIndex + 1} 已处于${op.deployed ? '部署' : '收起'}状态`);
      }
      event = { type: EVENT_TYPES.LEG_TOGGLED, leg: legIndex, deployed: op.deployed };
    } else {
      return reject(400, `不支持的操作类型: ${op.type}`);
    }

    // 先在重放状态的副本上试算，确认安全后才允许落轨迹。
    const trial = replay([...session.events, { ...event, seq: revision, at: new Date().toISOString() }]);
    const support = evaluateSupport(trial.legs, trial.postures[trial.currentPosture]);
    if (!support.safe) {
      return reject(422, `操作被拒绝：${support.reason}`);
    }

    this._append(session, {
      ...event,
      seq: revision,
      at: new Date().toISOString(),
    });
    return { ok: true, state: this.getState(id) };
  }
}

module.exports = {
  SessionStore,
  validateSetup,
  MIN_LEGS,
  MAX_LEGS,
  MIN_POSTURES,
  MAX_POSTURES,
};
