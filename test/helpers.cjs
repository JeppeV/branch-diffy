const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function fixture(t) {
  const temporaryRoot = path.join(os.tmpdir(), 'opencode');
  fs.mkdirSync(temporaryRoot, { recursive: true });
  const root = fs.mkdtempSync(path.join(temporaryRoot, 'branch-diff-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const git = (...args) => execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(root, 'no-global-config') },
  }).trim();
  git('init', '--initial-branch=main');
  git('config', 'user.name', 'Branch Diff Tests');
  git('config', 'user.email', 'branch-diff@example.invalid');
  git('config', 'core.autocrlf', 'false');
  const write = (file, content) => {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), content);
  };
  const commit = (message) => {
    git('add', '--all');
    git('commit', '--no-gpg-sign', '-m', message);
    return git('rev-parse', 'HEAD');
  };
  return { root, git, write, commit };
}

module.exports = { fixture };
