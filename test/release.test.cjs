const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { releaseMetadata } = require('../.github/scripts/release-metadata.cjs');

const manifest = { name: 'branch-diff', displayName: 'Branch Diff', version: '0.2.0' };
const lock = { version: '0.2.0', packages: { '': { version: '0.2.0' } } };

test('uses only the selected version changelog section as release notes', () => {
  const changelog = '# Changelog\n\n## Unreleased\n\nFuture work.\n\n## 0.2.0 - 2026-11-16\n\nNew features.\n\n### Fixed\n\n- A fix.\n\n## 0.1.0\n\nOld notes.\n';
  assert.deepEqual(releaseMetadata(manifest, lock, changelog), {
    tag: 'v0.2.0', title: 'Branch Diff 0.2.0', asset: 'branch-diff-0.2.0.vsix',
    notes: 'New features.\n\n### Fixed\n\n- A fix.',
  });
});

test('supports an undated final changelog section and Windows line endings', () => {
  assert.equal(releaseMetadata(manifest, lock, '# Changelog\r\n\r\n## 0.2.0\r\n\r\nInitial release.\r\n').notes,
    'Initial release.');
});

test('rejects missing or empty release notes instead of publishing unrelated changelog content', () => {
  for (const changelog of ['## 0.2.00\n\nWrong version.', '## 0.1.0\n\nOld notes.']) {
    assert.throws(() => releaseMetadata(manifest, lock, changelog), /Missing changelog entry/);
  }
  assert.throws(() => releaseMetadata(manifest, lock, '## 0.2.0\n\n## 0.1.0\n\nOld notes.'), /is empty/);
});

test('requires consistent manifest and lockfile versions', () => {
  for (const invalid of [{ ...lock, version: '0.1.0' }, { ...lock, packages: { '': { version: '0.1.0' } } }, {}]) {
    assert.throws(() => releaseMetadata(manifest, invalid, '## 0.2.0\n\nNotes.'), /versions must match/);
  }
});

test('rejects invalid versions and unsafe release output names', () => {
  for (const version of ['v0.2.0', '01.2.0', '0.2.0-beta.1', '0.2.0\n', '0.2.0\nasset=other', undefined]) {
    assert.throws(() => releaseMetadata({ ...manifest, version }, lock, ''), /major.minor.patch/);
  }
  for (const change of [{ name: '../other' }, { name: 'branch-diff\n' }, { displayName: 'Title\nasset=other' }, { displayName: '' }]) {
    assert.throws(() => releaseMetadata({ ...manifest, ...change }, lock, ''), /Invalid extension name/);
  }
});

test('writes workflow outputs and current release notes without modifying the repository', (t) => {
  const parent = path.join(os.tmpdir(), 'opencode');
  fs.mkdirSync(parent, { recursive: true });
  const directory = fs.mkdtempSync(path.join(parent, 'branch-diff-release-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const output = path.join(directory, 'github-output');
  const root = path.resolve(__dirname, '..');
  const current = require('../package.json');
  execFileSync(process.execPath, [path.join(root, '.github/scripts/release-metadata.cjs'), path.join(directory, 'assets')], {
    cwd: directory,
    env: { ...process.env, GITHUB_OUTPUT: output },
    windowsHide: true,
  });
  assert.equal(fs.readFileSync(output, 'utf8'),
    `tag=v${current.version}\ntitle=${current.displayName} ${current.version}\nasset=${current.name}-${current.version}.vsix\n`);
  const notes = fs.readFileSync(path.join(directory, 'assets/release-notes.md'), 'utf8');
  assert.ok(notes.trim());
  assert.ok(!notes.includes('# Changelog'));
});
