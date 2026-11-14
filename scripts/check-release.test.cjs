'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

test('release validation requires declared extension assets and rejects unsafe local paths', t => {
  const source = path.resolve(__dirname, '..'), root = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-release-check-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const name of ['app', 'backend', 'extension', 'skills', 'scripts', 'electron-builder.cjs', 'LICENSE', 'THIRD_PARTY_NOTICES.md']) {
    fs.cpSync(path.join(source, name), path.join(root, name), { recursive: true, filter: full => !/(?:^|\/)(?:node_modules|\.git|dist|__pycache__|\.venv)(?:\/|$)/.test(full) });
  }
  const run = () => spawnSync(process.execPath, ['scripts/check-release.cjs'], { cwd: root, encoding: 'utf8' });
  let result = run(); assert.equal(result.status, 0, result.stderr);
  for (const name of ['background.js', 'popup.html', 'popup.js', 'popup.css']) {
    const file = path.join(root, 'extension', name), bytes = fs.readFileSync(file); fs.unlinkSync(file);
    result = run(); assert.notEqual(result.status, 0); assert.match(result.stderr, /Missing extension asset/); fs.writeFileSync(file, bytes);
  }
  const manifestFile = path.join(root, 'extension/manifest.json'), manifest = JSON.parse(fs.readFileSync(manifestFile));
  for (const name of ['../escape.js', '/absolute.js', 'https://example.test/background.js', 'sub/../background.js', 'background.js?x', 'background.js\n']) {
    fs.writeFileSync(manifestFile, JSON.stringify({ ...manifest, background: { service_worker: name } }));
    result = run(); assert.notEqual(result.status, 0); assert.match(result.stderr, /local relative path/);
  }
  fs.writeFileSync(manifestFile, JSON.stringify(manifest));
  const background = path.join(root, 'extension/background.js'); fs.unlinkSync(background); fs.mkdirSync(background);
  result = run(); assert.notEqual(result.status, 0); assert.match(result.stderr, /Missing extension asset/);
});
