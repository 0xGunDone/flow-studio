#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

assert(process.platform === 'darwin', 'Build the native browser helper on macOS.');
const architectures = [...new Set(process.argv.slice(2).length ? process.argv.slice(2) : [process.arch])];
assert(architectures.every(arch => ['arm64', 'x64'].includes(arch)), 'Usage: node scripts/build-native.cjs [arm64|x64] [...]');
const root = path.resolve(__dirname, '..');
const output = path.join(root, 'app', 'native', 'bin');
const source = path.join(root, 'app', 'native', 'FlowBrowser.swift');
const env = Object.fromEntries(['PATH', 'HOME', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL', 'SDKROOT', 'DEVELOPER_DIR'].filter(name => process.env[name]).map(name => [name, process.env[name]]));
fs.mkdirSync(output, { recursive: true });
for (const arch of architectures) {
  const destination = path.join(output, `flow-browser-${arch}`);
  const temporary = `${destination}.building-${process.pid}`;
  try {
    execFileSync('/usr/bin/xcrun', ['swiftc', '-O', '-target', `${arch === 'x64' ? 'x86_64' : arch}-apple-macosx14.0`, '-framework', 'Foundation', '-framework', 'AppKit', '-framework', 'ApplicationServices', '-framework', 'ImageIO', '-framework', 'Vision', '-framework', 'CoreText', '-framework', 'CryptoKit', source, '-o', temporary], { cwd: root, env, stdio: 'inherit' });
    fs.chmodSync(temporary, 0o755);
    fs.renameSync(temporary, destination);
    console.log(`Built native browser helper (${arch}).`);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}
