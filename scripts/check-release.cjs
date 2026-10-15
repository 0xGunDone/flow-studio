#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const args = process.argv.slice(2);
const value = name => args.includes(name) ? args[args.indexOf(name) + 1] : undefined;
const bundle = value('--app');
const arch = value('--arch');
const packageJson = require('../app/package.json');
const config = require('../electron-builder.cjs');
const required = ['main.cjs', 'runtime.cjs', 'bootstrap.cjs', 'preload.cjs', 'accounts.cjs', 'recovery.cjs', 'agent-bridge.cjs', 'mcp-server.cjs', 'bridge-client.cjs', 'exports.cjs', 'index.html', 'help-content.html', 'renderer.js', 'styles.css', 'package.json'];
const forbidden = /(?:^|\/)(?:machine\.json|\.env(?:\..*)?|\.git|\.DS_Store|__pycache__|\.venv|history\.json|agent-bridge\.json|managed-accounts\.json|setting\.toml|data|tmp|logs|browser_data|browser_profiles|node_modules\/electron)(?:\/|$)|\.(?:sqlite3?|db|pyc)$/i;

function checkText(name, bytes) {
  if (/\.(?:cjs|js|json|html|css|md|py|toml|txt|sh)$/.test(name)) {
    assert(!/\/Users\/[^/\s]+\//.test(bytes.toString('utf8')), `Personal absolute path: ${name}`);
  }
}

function walk(folder, relative = '') {
  return fs.readdirSync(folder, { withFileTypes: true }).flatMap(entry => {
    const name = path.posix.join(relative, entry.name);
    const full = path.join(folder, entry.name);
    assert(!entry.isSymbolicLink(), `Unexpected resource symlink: ${name}`);
    return entry.isDirectory() ? walk(full, name) : [{ name, full }];
  });
}

function checkResources(resources) {
  for (const name of ['backend/main.py', 'backend/requirements.txt', 'backend/Dockerfile.headed', 'backend/.dockerignore', 'backend/docker/entrypoint.headed.sh', 'backend/config/setting_example.toml', 'backend/LICENSE', 'extension/manifest.json', 'skills/flow-studio/SKILL.md', 'LICENSE', 'THIRD_PARTY_NOTICES.md']) {
    assert(fs.existsSync(path.join(resources, name)), `Missing resource: ${name}`);
  }
  for (const directory of ['backend', 'extension', 'skills']) {
    for (const file of walk(path.join(resources, directory))) {
      if (!bundle && directory === 'backend' && /(?:^|\/)(tests|\.git|__pycache__)(\/|$)/.test(file.name)) continue;
      assert(!forbidden.test(file.name), `Private/runtime resource: ${directory}/${file.name}`);
      if (bundle) assert(!/(^|\/)tests?(\/|$)/.test(file.name), `Test resource in release: ${directory}/${file.name}`);
      checkText(file.name, fs.readFileSync(file.full));
    }
  }
}

assert.equal(packageJson.version, '1.0.0');
assert.equal(packageJson.devDependencies.electron, '44.7.1');
assert.equal(packageJson.devDependencies['electron-builder'], '26.15.3');
assert.equal(config.appId, 'io.github.0xgundone.flowstudio');
assert.equal(config.mac.identity, '-');
assert.equal(config.mac.notarize, false);
assert.equal(config.mac.hardenedRuntime, false);
assert(packageJson.dependencies['@modelcontextprotocol/sdk']);
assert(packageJson.dependencies.zod);

if (bundle) {
  const resources = path.join(path.resolve(bundle), 'Contents', 'Resources');
  const asar = require('../app/node_modules/@electron/asar');
  const archive = path.join(resources, 'app.asar');
  const files = asar.listPackage(archive).map(name => name.replace(/^\//, ''));
  for (const name of required) assert(files.includes(name), `Missing app file: ${name}`);
  for (const name of ['node_modules/@modelcontextprotocol/sdk/package.json', 'node_modules/zod/package.json']) assert(files.includes(name), `Missing production dependency: ${name}`);
  for (const name of files) {
    assert(!/(^|\/)(?:machine\.json|[^/]*\.test\.cjs|\.env(?:\.[^/]*)?)$/.test(name), `Private/test app file: ${name}`);
    assert(!/^node_modules\/(electron|electron-builder|app-builder-lib)(\/|$)/.test(name), `Dev dependency in app: ${name}`);
  }
  for (const name of required) checkText(name, asar.extractFile(archive, name));
  checkResources(resources);
  if (arch) {
    assert(['arm64', 'x64'].includes(arch), 'Architecture must be arm64 or x64');
    const executable = path.join(path.resolve(bundle), 'Contents', 'MacOS', 'Flow Studio');
    assert.equal(execFileSync('lipo', ['-archs', executable], { encoding: 'utf8' }).trim(), arch === 'x64' ? 'x86_64' : 'arm64');
  }
  if (process.platform === 'darwin') execFileSync('codesign', ['--verify', '--deep', '--strict', path.resolve(bundle)], { stdio: 'pipe' });
  console.log(`Release bundle verified${arch ? ` (${arch})` : ''}: ${bundle}`);
} else {
  for (const name of required) {
    const full = path.join(root, 'app', name);
    assert(fs.existsSync(full), `Missing app source: ${name}`);
    checkText(name, fs.readFileSync(full));
  }
  assert(!fs.existsSync(path.join(root, 'app', 'machine.json')), 'machine.json must not be released');
  checkResources(root);
  console.log('Release source and packaging configuration verified.');
}
