'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { SessionStore } = require('./session');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const MAX_BODY_BYTES = 1024 * 1024;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(payload);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function readJson(req) {
  const raw = await readBody(req);
  try {
    return JSON.parse(raw || '{}');
  } catch {
    throw new Error('请求体不是合法 JSON');
  }
}

function serveStatic(res, urlPath) {
  const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  const filePath = path.normalize(path.join(PUBLIC_DIR, rel));
  if (filePath !== PUBLIC_DIR && !filePath.startsWith(PUBLIC_DIR + path.sep)) {
    sendJson(res, 403, { error: '禁止访问' });
    return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      sendJson(res, 404, { error: '资源不存在' });
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
    res.end(data);
  });
}

function createServer(store) {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const parts = url.pathname.split('/').filter(Boolean);

    try {
      if (req.method === 'GET' && url.pathname === '/health') {
        sendJson(res, 200, { status: 'ok', uptime: process.uptime() });
        return;
      }

      if (parts[0] === 'api') {
        // POST /api/sessions
        if (req.method === 'POST' && url.pathname === '/api/sessions') {
          const body = await readJson(req);
          const result = store.createSession(body);
          if (!result.ok) {
            sendJson(res, result.status, { error: result.error });
            return;
          }
          sendJson(res, 201, result);
          return;
        }

        // /api/sessions/:id/...
        if (parts[1] === 'sessions' && parts[2]) {
          const id = parts[2];
          if (req.method === 'GET' && parts.length === 3) {
            const state = store.getState(id);
            if (!state) sendJson(res, 404, { error: '演练会话不存在' });
            else sendJson(res, 200, state);
            return;
          }
          if (req.method === 'GET' && parts[3] === 'events' && parts.length === 4) {
            const events = store.getEvents(id);
            if (!events) sendJson(res, 404, { error: '演练会话不存在' });
            else sendJson(res, 200, { events });
            return;
          }
          if (req.method === 'POST' && parts[3] === 'ops' && parts.length === 4) {
            const body = await readJson(req);
            const result = store.applyOp(id, body.baseRevision, body.op);
            if (!result.ok) {
              sendJson(res, result.status, { error: result.error, state: result.state || null });
              return;
            }
            sendJson(res, 200, result);
            return;
          }
          if (req.method === 'POST' && parts[3] === 'safety-window' && parts.length === 4) {
            const body = await readJson(req);
            const result = store.reviewSafetyWindow(id, body.baseRevision, body.extraError);
            if (!result.ok) {
              sendJson(res, result.status, { error: result.error, state: result.state || null });
              return;
            }
            sendJson(res, 200, result.review);
            return;
          }
        }

        sendJson(res, 404, { error: '接口不存在' });
        return;
      }

      if (req.method === 'GET') {
        serveStatic(res, url.pathname);
        return;
      }
      sendJson(res, 405, { error: '方法不允许' });
    } catch (err) {
      sendJson(res, 400, { error: err.message || '请求处理失败' });
    }
  });
}

function main() {
  const port = Number(process.env.PORT || 8080);
  const dataDir = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
  const store = new SessionStore(dataDir);
  const server = createServer(store);
  server.listen(port, () => {
    console.log(`[dome-platform]  listening on :${port}, event trail dir: ${dataDir}`);
  });
}

if (require.main === module) {
  main();
}

module.exports = { createServer };
