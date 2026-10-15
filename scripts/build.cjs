#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const architectures = process.argv.slice(2);
assert(process.platform === 'darwin', 'Build macOS release assets on macOS.');
assert(architectures.length && architectures.every(arch => ['arm64', 'x64'].includes(arch)), 'Usage: node scripts/build.cjs <arm64|x64> [...]');
// Keep build helpers from inheriting credentials or using a personal signing identity.
const env = Object.fromEntries(['PATH', 'HOME', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL', 'SHELL', 'ELECTRON_CACHE', 'ELECTRON_BUILDER_CACHE', 'CI'].filter(name => process.env[name]).map(name => [name, process.env[name]]));
env.CSC_IDENTITY_AUTO_DISCOVERY = 'false';
const run = (script, args) => execFileSync(process.execPath, [script, ...args], { cwd: path.join(root, 'app'), env, stdio: 'inherit' });
run(path.join(__dirname, 'check-release.cjs'), []);
for (const arch of architectures) {
  run(path.join(root, 'app/node_modules/electron-builder/cli.js'), ['--config', '../electron-builder.cjs', '--mac', `--${arch}`, '--publish', 'never']);
  const folder = arch === 'x64' ? 'mac' : 'mac-arm64';
  run(path.join(__dirname, 'check-release.cjs'), ['--app', path.join(root, 'dist', folder, 'Flow Studio.app'), '--arch', arch]);
}
