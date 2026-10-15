#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
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
// Sign outside synced folders: iCloud can restore Finder metadata during codesign.
const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-studio-build-'));
const output = path.join(root, 'dist');
fs.mkdirSync(output, { recursive: true });
try {
  for (const arch of architectures) {
    run(path.join(root, 'app/node_modules/electron-builder/cli.js'), ['--config', '../electron-builder.cjs', `--config.directories.output=${staging}`, '--mac', `--${arch}`, '--publish', 'never']);
    const folder = arch === 'x64' ? 'mac' : 'mac-arm64';
    run(path.join(__dirname, 'check-release.cjs'), ['--app', path.join(staging, folder, 'Flow Studio.app'), '--arch', arch]);
    for (const file of fs.readdirSync(staging).filter(name => name.endsWith(`-mac-${arch}.zip`) || name.endsWith(`-mac-${arch}.dmg`))) fs.copyFileSync(path.join(staging, file), path.join(output, file));
    const basename = `Flow-Studio-${require('../app/package.json').version}-mac-${arch}`;
    const extracted = path.join(staging, `verify-${arch}`);
    execFileSync('ditto', ['-xk', path.join(output, `${basename}.zip`), extracted], { env });
    run(path.join(__dirname, 'check-release.cjs'), ['--app', path.join(extracted, 'Flow Studio.app'), '--arch', arch]);
    execFileSync('hdiutil', ['verify', path.join(output, `${basename}.dmg`)], { env, stdio: 'inherit' });
  }
} finally {
  fs.rmSync(staging, { recursive: true, force: true });
}
