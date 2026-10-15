'use strict';

const path = require('node:path');
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');

module.exports = {
  appId: 'io.github.0xgundone.flowstudio',
  productName: 'Flow Studio',
  artifactName: 'Flow-Studio-${version}-mac-${arch}.${ext}',
  directories: { output: '../dist' },
  asar: true,
  npmRebuild: false,
  afterExtract: context => {
    if (context.electronPlatformName !== 'darwin') return;
    const notices = path.join(context.appOutDir, 'Electron.app', 'Contents', 'Resources', 'licenses');
    fs.mkdirSync(notices, { recursive: true });
    fs.copyFileSync(path.join(context.appOutDir, 'LICENSE'), path.join(notices, 'LICENSE.electron.txt'));
    fs.copyFileSync(path.join(context.appOutDir, 'LICENSES.chromium.html'), path.join(notices, 'LICENSES.chromium.html'));
  },
  afterPack: context => {
    // Finder metadata can arrive from a downloaded Electron archive on local macOS.
    if (context.electronPlatformName === 'darwin') execFileSync('xattr', ['-cr', path.join(context.appOutDir, 'Flow Studio.app')]);
  },
  files: [
    '*.cjs', '!*.test.cjs',
    'index.html', 'help-content.html', 'renderer.js', 'styles.css', 'package.json',
    'node_modules/**/*',
  ],
  extraResources: [
    {
      from: '../backend', to: 'backend',
      filter: [
        'main.py', 'requirements.txt', 'Dockerfile.headed', '.dockerignore',
        'docker/entrypoint.headed.sh', 'config/setting_example.toml',
        'src/**/*', 'static/**/*', 'LICENSE', 'README.md',
        '!**/__pycache__/**', '!**/*.pyc', '!**/.DS_Store',
      ],
    },
    { from: '../extension', to: 'extension', filter: ['**/*', '!tests/**', '!**/.DS_Store'] },
    { from: '../skills', to: 'skills', filter: ['**/*', '!**/.DS_Store'] },
    { from: '../LICENSE', to: 'LICENSE' },
    { from: '../THIRD_PARTY_NOTICES.md', to: 'THIRD_PARTY_NOTICES.md' },
  ],
  mac: {
    category: 'public.app-category.graphics-design',
    icon: path.join(__dirname, 'app', 'AppIcon.icns'),
    target: ['zip', 'dmg'],
    identity: '-',
    hardenedRuntime: false,
    gatekeeperAssess: false,
    notarize: false,
    timestamp: 'none',
  },
  dmg: { sign: false },
  publish: null,
};
