'use strict';

/**
 * 构建：对全部源码做语法校验，校验前端资源存在且非空，
 * 并把可运行产物（src/ + public/）复制到 dist/，写入构建信息。
 */

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DIST = path.join(ROOT, 'dist');

function listJs(dir) {
  const out = [];
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    const stat = fs.statSync(full);
    if (stat.isDirectory()) out.push(...listJs(full));
    else if (name.endsWith('.js')) out.push(full);
  }
  return out;
}

function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const name of fs.readdirSync(src)) {
    const from = path.join(src, name);
    const to = path.join(dst, name);
    if (fs.statSync(from).isDirectory()) copyDir(from, to);
    else fs.copyFileSync(from, to);
  }
}

function main() {
  const targets = [
    ...listJs(path.join(ROOT, 'src')),
    ...listJs(path.join(ROOT, 'scripts')),
    ...listJs(path.join(ROOT, 'test')),
    ...listJs(path.join(ROOT, 'public')),
  ];

  for (const file of targets) {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
    console.log(`[build] syntax ok: ${path.relative(ROOT, file)}`);
  }

  for (const asset of ['index.html', 'app.js', 'styles.css']) {
    const full = path.join(ROOT, 'public', asset);
    if (!fs.existsSync(full) || fs.statSync(full).size === 0) {
      throw new Error(`前端资源缺失或为空: public/${asset}`);
    }
  }
  console.log('[build] public assets ok');

  fs.rmSync(DIST, { recursive: true, force: true });
  copyDir(path.join(ROOT, 'src'), path.join(DIST, 'src'));
  copyDir(path.join(ROOT, 'public'), path.join(DIST, 'public'));

  const info = {
    builtAt: new Date().toISOString(),
    node: process.version,
    files: targets.length,
    entry: 'src/server.js',
  };
  fs.writeFileSync(path.join(DIST, 'build-info.json'), `${JSON.stringify(info, null, 2)}\n`);
  console.log(`[build] dist/ ready (${targets.length} files checked)`);
}

try {
  main();
} catch (err) {
  console.error(`[build] FAILED: ${err.message}`);
  process.exit(1);
}
