#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const pkg = require('../app/package.json');
const lock = require('../app/package-lock.json');
const output = path.join(root, 'dist');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-studio-release-'));
fs.mkdirSync(output, { recursive: true });
try {
  fs.cpSync(path.join(root, 'extension'), path.join(temporary, 'flow-studio-extension'), {
    recursive: true, filter: file => !/(?:^|\/)(?:tests|\.DS_Store)$/.test(file),
  });
  const mcp = path.join(temporary, 'flow-studio-mcp');
  fs.mkdirSync(mcp);
  for (const file of ['mcp-server.cjs', 'bridge-client.cjs']) fs.copyFileSync(path.join(root, 'app', file), path.join(mcp, file));
  fs.copyFileSync(path.join(root, 'LICENSE'), path.join(mcp, 'LICENSE'));
  const skillSource = path.join(root, 'skills', 'flow-studio');
  fs.cpSync(skillSource, path.join(mcp, 'skills', 'flow-studio'), {
    recursive: true,
    filter: file => {
      const relative = path.relative(skillSource, file);
      if (/(?:^|[\/])(?:\.[^\/]+|node_modules|__pycache__|data|tmp|logs|machine\.json|history\.json|agent-bridge\.json|managed-accounts\.json|browser-account-state\.json|account-participation\.json|browser-receipts|browser-diagnostics)(?:[\/]|$)|\.(?:pyc|db|sqlite3?)$/i.test(relative)) return false;
      assert(!fs.lstatSync(file).isSymbolicLink(), `Skill symlink cannot be packaged: ${relative || '.'}`);
      return true;
    },
  });
  const mcpPackage = {
    name: 'flow-studio-mcp', version: pkg.version, private: true, license: 'MIT',
    description: 'MCP server for the installed Flow Studio macOS app',
    main: 'mcp-server.cjs', scripts: { start: 'node mcp-server.cjs' },
    engines: { node: '>=22.12.0' }, dependencies: pkg.dependencies,
  };
  const mcpLock = {
    name: mcpPackage.name, version: pkg.version, lockfileVersion: 3, requires: true,
    packages: { '': { name: mcpPackage.name, version: pkg.version, license: 'MIT', engines: mcpPackage.engines, dependencies: pkg.dependencies } },
  };
  for (const [name, entry] of Object.entries(lock.packages)) if (name && !entry.dev) mcpLock.packages[name] = entry;
  fs.writeFileSync(path.join(mcp, 'package.json'), JSON.stringify(mcpPackage, null, 2) + '\n');
  fs.writeFileSync(path.join(mcp, 'package-lock.json'), JSON.stringify(mcpLock, null, 2) + '\n');
  fs.writeFileSync(path.join(mcp, 'README.md'), [
    "# Flow Studio MCP",
    "Requires Node.js 22.12 or later and the installed Flow Studio macOS app.",
    "Run `npm ci --ignore-scripts` in this folder, then configure your MCP client with command `node` and the absolute path to `mcp-server.cjs` as its argument. Start Flow Studio and connect your Google account before generating. Run `node mcp-server.cjs --list-tools` to inspect all 24 tools without starting the app, reading credentials or generating. Reconnect the MCP client after updating the adapter to load its current schema.",
    "## Agent skill",
    "This archive includes the complete Flow Studio skill in `skills/flow-studio/`. For Codex, copy that folder into `${CODEX_HOME:-$HOME/.codex}/skills/flow-studio`, preserving its `SKILL.md`, `agents` and `references` contents. Review any existing local edits before replacing an installed skill. Skill installation does not configure the MCP server; keep the adapter path above in your MCP client.",
    "The adapter and skill can live outside iCloud Drive, for example in `~/Applications/Flow-Studio-MCP`. The archive contains no accounts or authentication data.",
    "Full setup: https://github.com/0xgundone/flow-studio/blob/main/docs/mcp.md",
  ].join('\n\n') + '\n');
  for (const [folder, asset] of [['flow-studio-extension', 'extension'], ['flow-studio-mcp', 'mcp']]) {
    const file = path.join(output, `Flow-Studio-${pkg.version}-${asset}.zip`);
    fs.rmSync(file, { force: true });
    execFileSync('zip', ['-qr', file, folder, '-x', '*/.DS_Store'], { cwd: temporary });
    console.log(path.basename(file));
  }
  const assets = fs.readdirSync(output).filter(file => file.startsWith(`Flow-Studio-${pkg.version}-`) && /\.(zip|dmg)$/.test(file)).sort();
  fs.writeFileSync(path.join(output, 'SHA256SUMS.txt'), assets.map(file => `${crypto.createHash('sha256').update(fs.readFileSync(path.join(output, file))).digest('hex')}  ${file}`).join('\n') + '\n');
  console.log('SHA256SUMS.txt');
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}
