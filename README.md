# 移动式穹顶测绘平台 · 安全操作演练

收车或调整仪器姿态时，任一收起的支腿都可能令带定位误差的载荷投影越出支承面。本应用让现场人员在浏览器中先演练安全操作次序：

- 录入 **4~6 只支腿**的平面坐标与初始部署状态，以及 **4~8 个载荷姿态**的投影中心与非负不确定半径；
- 启动演练后实时查看当前**支承多边形**（已部署支腿凸包）与**载荷圆盘**；
- 演练中每项操作只能是 **切换一个载荷姿态** 或 **收放一只支腿**，且必须携带所见修订号；
- 服务端从**不可改写的本地事件轨迹**（只增 JSONL）重放状态；凸包完整包含当前载荷圆盘才安全，**边界相切视为安全**；
- 会使圆盘越界、部署支腿不足以形成安全支承、或修订号过期的操作一律**明确拒绝且不写入轨迹**；
- 页面持续显示：修订号、支腿状态、当前姿态、最近一次拒绝理由。

## 快速开始（Docker）

```bash
# 启动 Web 服务（宿主机端口默认 8080，可用 WEB_PORT 覆盖）
WEB_PORT=9000 docker compose up web

# 一次性验收：代码测试 + 构建 + 几何业务冒烟，退出码即验收结果
docker compose up --exit-code-from verify --abort-on-container-exit verify
# 或
docker compose run --rm verify
```

健康检查：`GET /health`（容器内亦配置了 HEALTHCHECK）。

## 本地开发（Node ≥ 18，零依赖）

```bash
npm start          # 启动服务，默认 :8080（PORT、DATA_DIR 可配）
npm test           # 单元测试（node:test）
npm run build      # 构建：语法/资源校验并生成 dist/
npm run smoke      # 几何业务冒烟（进程内起服务）
npm run verify     # = test + build + smoke
```

## API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/health` | 健康检查 |
| POST | `/api/sessions` | 录入 `{legs, postures, currentPosture?}` 并创建演练；初始状态不安全返回 422 |
| GET | `/api/sessions/:id` | 当前状态（由事件轨迹重放） |
| GET | `/api/sessions/:id/events` | 只读事件轨迹 |
| POST | `/api/sessions/:id/ops` | `{baseRevision, op}`；`op` 为 `{type:"switch_posture", posture}` 或 `{type:"toggle_leg", leg, deployed}` |

拒绝语义：`400` 请求非法 · `409` 修订号过期 · `422` 业务拒绝（圆盘越界 / 支承不足 / 无变化操作）。拒绝响应携带最新 `state`，且**不会**写入事件轨迹。

## 架构

```
src/geometry.js   凸包（单调链）、圆盘-凸多边形包含（相切为安全）、支承评估
src/events.js     事件类型与纯函数 reducer；状态 = replay(events)
src/session.js    录入校验、操作试算、轨迹追加（内存 + 只增 JSONL）
src/server.js     零依赖 HTTP 服务：REST API + 静态页面
public/           单页演练界面（SVG 视图、状态栏、操作面板）
scripts/build.js  构建：语法/资源校验 + dist/ 产物
scripts/smoke.js  几何业务冒烟（可打 SMOKE_BASE_URL 指向的服务）
test/             node:test 单元与 API 测试
```

事件轨迹写入 `DATA_DIR`（默认 `./data`，容器内 `/app/data`，compose 挂载卷 `dome-data`），重启后自动重建会话。
