'use strict';

/**
 * 事件溯源：状态完全由不可改写的事件轨迹重放得到。
 * 事件一经写入只允许追加，被拒绝的操作绝不进入轨迹。
 */

const EVENT_TYPES = Object.freeze({
  SESSION_CREATED: 'session_created',
  POSTURE_SWITCHED: 'posture_switched',
  LEG_TOGGLED: 'leg_toggled',
});

function cloneLeg(l) {
  return { x: l.x, y: l.y, deployed: l.deployed === true };
}

function clonePosture(p) {
  return { x: p.x, y: p.y, r: p.r };
}

/** 纯函数：把单个事件应用到投影状态上。 */
function reduceEvent(state, event) {
  switch (event.type) {
    case EVENT_TYPES.SESSION_CREATED:
      return {
        legs: event.legs.map(cloneLeg),
        postures: event.postures.map(clonePosture),
        currentPosture: event.currentPosture,
      };
    case EVENT_TYPES.POSTURE_SWITCHED:
      return { ...state, currentPosture: event.posture };
    case EVENT_TYPES.LEG_TOGGLED:
      return {
        ...state,
        legs: state.legs.map((l, i) => (i === event.leg ? { ...l, deployed: event.deployed } : l)),
      };
    default:
      throw new Error(`未知事件类型: ${event.type}`);
  }
}

/** 从事件轨迹重放投影状态 { legs, postures, currentPosture }。 */
function replay(events) {
  let state = null;
  for (const event of events) {
    state = reduceEvent(state, event);
  }
  return state;
}

module.exports = { EVENT_TYPES, reduceEvent, replay };
