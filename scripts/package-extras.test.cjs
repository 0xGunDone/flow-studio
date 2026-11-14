'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync, spawnSync } = require('node:child_process');

const skillFiles = ['SKILL.md', 'agents/openai.yaml', 'references/cli.md', 'references/generation.md', 'references/native-browser.md'];

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-extras-test-'));
  const write = (name, value) => {
    const full = path.join(root, name);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, value);
  };
  write('scripts/package-extras.cjs', fs.readFileSync(path.join(__dirname, 'package-extras.cjs')));
  write('app/package.json', JSON.stringify({ version: '1.3.0', dependencies: { zod: '^3.25.76' } }));
  write('app/package-lock.json', JSON.stringify({ packages: { '': {}, 'node_modules/zod': { version: '3.25.76' }, 'node_modules/electron': { version: '44.7.1', dev: true } } }));
  write('app/mcp-server.cjs', '// adapter fixture\n');
  write('app/bridge-client.cjs', '// bridge fixture\n');
  write('LICENSE', 'MIT\n');
  write('extension/manifest.json', '{"manifest_version":3}\n');
  for (const name of skillFiles) write(`skills/flow-studio/${name}`, `skill fixture: ${name}\n`);
  return { root, write };
}

test('MCP archive carries complete skill, install guide, production lock and matching checksums', () => {
  const { root, write } = fixture();
  try {
    for (const name of ['.env', '.git/config', 'machine.json', 'history.json', 'browser-receipts/test.json']) write(`skills/flow-studio/${name}`, 'private fixture\n');
    execFileSync(process.execPath, ['scripts/package-extras.cjs'], { cwd: root });
    const archive = path.join(root, 'dist', 'Flow-Studio-1.3.0-mcp.zip');
    const entries = execFileSync('unzip', ['-Z1', archive], { encoding: 'utf8' }).split('\n');
    for (const name of skillFiles) assert(entries.includes(`flow-studio-mcp/skills/flow-studio/${name}`), `Missing skill file: ${name}`);
    assert(!entries.some(name => /(?:\.env|\.git\/|machine\.json|history\.json|browser-receipts\/)/.test(name)));
    const unpacked = path.join(root, 'unpacked');
    execFileSync('unzip', ['-q', archive, '-d', unpacked]);
    const mcp = path.join(unpacked, 'flow-studio-mcp');
    for (const name of skillFiles) assert.equal(fs.readFileSync(path.join(mcp, 'skills/flow-studio', name), 'utf8'), `skill fixture: ${name}\n`);
    const readme = fs.readFileSync(path.join(mcp, 'README.md'), 'utf8');
    assert.match(readme, /npm ci --ignore-scripts/);
    assert.match(readme, /\$\{CODEX_HOME:-\$HOME\/\.codex\}\/skills\/flow-studio/);
    assert.match(readme, /24 tools/);
    const lock = JSON.parse(fs.readFileSync(path.join(mcp, 'package-lock.json')));
    assert(lock.packages['node_modules/zod']);
    assert(!lock.packages['node_modules/electron']);
    const manifest = fs.readFileSync(path.join(root, 'dist/SHA256SUMS.txt'), 'utf8').trim().split('\n');
    assert.equal(manifest.length, 2);
    for (const entry of manifest) {
      const [digest, name] = entry.split('  ');
      assert.equal(digest, crypto.createHash('sha256').update(fs.readFileSync(path.join(root, 'dist', name))).digest('hex'));
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('MCP skill packaging rejects symlinks before archive creation', () => {
  const { root } = fixture();
  try {
    fs.symlinkSync(path.join(root, 'LICENSE'), path.join(root, 'skills/flow-studio/linked-license'));
    const result = spawnSync(process.execPath, ['scripts/package-extras.cjs'], { cwd: root, encoding: 'utf8' });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Skill symlink cannot be packaged/);
    assert(!fs.existsSync(path.join(root, 'dist/Flow-Studio-1.3.0-mcp.zip')));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
