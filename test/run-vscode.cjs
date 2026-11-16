const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { runTests } = require('@vscode/test-electron');
const { fixture } = require('./helpers.cjs');

async function availablePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function main() {
  const cleanup = [];
  const repo = fixture({ after: (action) => cleanup.push(action) });
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode', 'branch-diffy-vscode-'));
  cleanup.push(() => fs.rmSync(data, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  try {
    repo.write('modified.txt', 'unchanged first\nbefore\nunchanged third\nunchanged fourth\n');
    repo.write('deleted.txt', 'deleted\n');
    repo.write('local-deleted.txt', 'local deletion baseline\n');
    repo.write('local-modified.txt', 'local HEAD version\n');
    repo.write('z-branch-parent/z-branch-child/branch-nested.txt', 'before\n');
    repo.write('z-native-parent/z-native-child/native-nested.txt', 'before\n');
    for (const folder of ['z-branch-deletions', 'z-native-deletions']) {
      repo.write(`${folder}/keep.txt`, 'unchanged\n');
      repo.write(`${folder}/deleted.txt`, 'deleted\n');
    }
    const base = repo.commit('base');
    repo.git('checkout', '-b', 'feature');
    repo.write('modified.txt', 'unchanged first\nafter\nunchanged third\nunchanged fourth\n');
    repo.write('added.txt', 'added\n');
    repo.write('z-added-no-eol.txt', 'added');
    repo.write('z-branch-parent/z-branch-child/branch-nested.txt', 'after\n');
    repo.git('rm', 'deleted.txt');
    repo.git('rm', 'z-branch-deletions/deleted.txt');
    const head = repo.commit('feature');
    repo.write('local-modified.txt', 'staged local version\n');
    repo.git('add', 'local-modified.txt');
    repo.write('local-modified.txt', 'working local version\n');
    fs.unlinkSync(path.join(repo.root, 'local-deleted.txt'));
    fs.unlinkSync(path.join(repo.root, 'z-native-deletions/deleted.txt'));
    repo.write('untracked.txt', 'untracked\n');
    repo.write('z-native-parent/z-native-child/native-nested.txt', 'after\n');
    const debugPort = await availablePort();
    await runTests({
      version: '1.95.3',
      vscodeExecutablePath: process.env.VSCODE_EXECUTABLE_PATH,
      extensionDevelopmentPath: path.resolve(__dirname, '..'),
      extensionTestsPath: path.join(__dirname, 'vscode-smoke.cjs'),
      extensionTestsEnv: {
        BRANCH_DIFFY_TEST_ROOT: repo.root, BRANCH_DIFFY_TEST_BASE: base, BRANCH_DIFFY_TEST_HEAD: head,
        BRANCH_DIFFY_TEST_NODE: process.execPath, BRANCH_DIFFY_TEST_DEBUG_PORT: String(debugPort),
      },
      launchArgs: [
        repo.root, '--disable-extensions', '--disable-gpu', '--disable-workspace-trust',
        '--skip-welcome', '--skip-release-notes',
        `--remote-debugging-port=${debugPort}`,
        '--user-data-dir', path.join(data, 'user'), '--extensions-dir', path.join(data, 'extensions'),
      ],
    });
  } finally {
    for (const action of cleanup.reverse()) { action(); }
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
