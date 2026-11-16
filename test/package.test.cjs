const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { listFiles } = require('@vscode/vsce');
const manifest = require('../package.json');

const root = path.resolve(__dirname, '..');

test('uses the Branch Diffy identity throughout the extension manifest', () => {
  assert.equal(manifest.name, 'branch-diffy');
  assert.equal(manifest.displayName, 'Branch Diffy');
  assert.ok(manifest.activationEvents.includes('onView:branchDiffy.files'));
  assert.deepEqual(manifest.contributes.viewsContainers.activitybar, [
    { id: 'branchDiffy', title: 'Branch Diffy', icon: 'media/branch-diffy.svg' },
  ]);
  assert.deepEqual(manifest.contributes.views.branchDiffy, [
    { id: 'branchDiffy.files', name: 'Changed Files', contextualTitle: 'Branch Diffy' },
  ]);
  for (const command of manifest.contributes.commands) {
    assert.ok(command.command.startsWith('branchDiffy.'));
    assert.equal(command.category, 'Branch Diffy');
  }
  assert.equal(manifest.contributes.configuration.title, 'Branch Diffy');
  assert.deepEqual(Object.keys(manifest.contributes.configuration.properties), ['branchDiffy.defaultBaseBranch']);
});

test('packages only runtime files, assets, and public release documentation', async () => {
  const files = (await listFiles({ cwd: root })).map((file) => file.replace(/\\/g, '/'));
  const required = [
    'package.json', 'README.md', 'CHANGELOG.md', 'LICENSE',
    manifest.main.replace(/^\.\//, ''),
    ...manifest.contributes.viewsContainers.activitybar.map((container) => container.icon),
  ];
  if (manifest.icon) {
    required.push(manifest.icon);
  }
  for (const file of required) {
    assert.ok(files.includes(file), `Missing release file: ${file}`);
  }
  const publicFiles = new Set(['package.json', 'README.md', 'CHANGELOG.md', 'LICENSE']);
  for (const file of files) {
    assert.ok(publicFiles.has(file) || /^dist\/[^/]+\.js$/.test(file) || /^media\/[^/]+\.(svg|png)$/.test(file),
      `Unexpected packaged file: ${file}`);
  }
});

test('pins API types to the minimum supported VS Code version', () => {
  assert.equal(manifest.devDependencies['@types/vscode'], manifest.engines.vscode.replace(/^\^/, ''));
});

test('keeps release metadata consistent with the lockfile and changelog', () => {
  const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
  assert.equal(lock.name, manifest.name);
  assert.equal(lock.packages[''].name, manifest.name);
  assert.equal(lock.version, manifest.version);
  assert.equal(lock.packages[''].version, manifest.version);
  const changelog = fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8');
  assert.ok(changelog.split(/\r?\n/).some((line) => line === `## ${manifest.version}` || line.startsWith(`## ${manifest.version} - `)),
    `Missing changelog entry for ${manifest.version}`);
});
