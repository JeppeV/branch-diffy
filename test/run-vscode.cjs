const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runTests } = require('@vscode/test-electron');
const { fixture } = require('./helpers.cjs');

async function main() {
  const cleanup = [];
  const repo = fixture({ after: (action) => cleanup.push(action) });
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode', 'branch-diff-vscode-'));
  cleanup.push(() => fs.rmSync(data, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  try {
    repo.write('modified.txt', 'unchanged first\nbefore\nunchanged third\nunchanged fourth\n');
    repo.write('deleted.txt', 'deleted\n');
    repo.write('local-deleted.txt', 'local deletion baseline\n');
    repo.write('local-modified.txt', 'local HEAD version\n');
    const base = repo.commit('base');
    repo.git('checkout', '-b', 'feature');
    repo.write('modified.txt', 'unchanged first\nafter\nunchanged third\nunchanged fourth\n');
    repo.write('added.txt', 'added\n');
    repo.git('rm', 'deleted.txt');
    const head = repo.commit('feature');
    repo.write('local-modified.txt', 'staged local version\n');
    repo.git('add', 'local-modified.txt');
    repo.write('local-modified.txt', 'working local version\n');
    fs.unlinkSync(path.join(repo.root, 'local-deleted.txt'));
    repo.write('untracked.txt', 'untracked\n');
    await runTests({
      version: '1.95.3',
      vscodeExecutablePath: process.env.VSCODE_EXECUTABLE_PATH,
      extensionDevelopmentPath: path.resolve(__dirname, '..'),
      extensionTestsPath: path.join(__dirname, 'vscode-smoke.cjs'),
      extensionTestsEnv: { BRANCH_DIFF_TEST_ROOT: repo.root, BRANCH_DIFF_TEST_BASE: base, BRANCH_DIFF_TEST_HEAD: head },
      launchArgs: [
        repo.root, '--disable-extensions', '--disable-gpu', '--disable-workspace-trust',
        '--skip-welcome', '--skip-release-notes',
        '--user-data-dir', path.join(data, 'user'), '--extensions-dir', path.join(data, 'extensions'),
      ],
    });
  } finally {
    for (const action of cleanup.reverse()) { action(); }
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
