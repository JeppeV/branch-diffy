const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { Git, MissingReferenceError, branchLabel, parseNameStatus, parseUnstagedStatus } = require('../dist/git');
const { fixture } = require('./helpers.cjs');

const client = new Git('git');

test('parses Git statuses, rename scores, copies, and unusual filenames', () => {
  assert.deepEqual(parseNameStatus('A\0folder/你好 file.ts\0M\0tab\tand\nnewline.ts\0D\0gone.ts\0R098\0old.ts\0new.ts\0C100\0source.ts\0copy.ts\0T\0link\0'), [
    { status: 'C', path: 'copy.ts', originalPath: 'source.ts' },
    { status: 'A', path: 'folder/你好 file.ts' },
    { status: 'D', path: 'gone.ts' },
    { status: 'T', path: 'link' },
    { status: 'R', path: 'new.ts', originalPath: 'old.ts' },
    { status: 'M', path: 'tab\tand\nnewline.ts' },
  ]);
});

test('handles an empty diff and rejects malformed status output', () => {
  assert.deepEqual(parseNameStatus(''), []);
  assert.throws(() => parseNameStatus('M\0'), /Incomplete/);
  assert.throws(() => parseNameStatus('R100\0old\0'), /Incomplete/);
  assert.throws(() => parseNameStatus('U\0file\0'), /Unexpected/);
});

test('parses the unstaged status column, staged renames, conflicts, and unusual filenames', () => {
  const output = 'M  staged.txt\0A  staged-added.txt\0D  staged-deleted.txt\0R  staged-new.txt\0staged-old.txt\0'
    + ' M modified.txt\0MM partial.txt\0AM added-then-edited.txt\0 D deleted.txt\0 T type.txt\0 A intent.txt\0'
    + 'RM renamed-and-edited.txt\0old.txt\0 R new.txt\0original.txt\0??  tab\tand\nnewline \0'
    + '?? nested-repo/\0!! ignored.txt\0UU conflict.txt\0';
  assert.deepEqual(parseUnstagedStatus(output), [
    { status: 'U', path: ' tab\tand\nnewline ' },
    { status: 'M', path: 'added-then-edited.txt' },
    { status: '!', path: 'conflict.txt' },
    { status: 'D', path: 'deleted.txt' },
    { status: 'A', path: 'intent.txt' },
    { status: 'M', path: 'modified.txt' },
    { status: 'R', path: 'new.txt', originalPath: 'original.txt' },
    { status: 'M', path: 'partial.txt' },
    { status: 'M', path: 'renamed-and-edited.txt' },
    { status: 'T', path: 'type.txt' },
  ].sort((a, b) => a.path.localeCompare(b.path)));
  assert.deepEqual(parseUnstagedStatus(''), []);
  assert.throws(() => parseUnstagedStatus(' M\0'), /Incomplete/);
  assert.throws(() => parseUnstagedStatus('R  new.txt\0'), /Incomplete renamed/);
  assert.throws(() => parseUnstagedStatus(' Z file.txt\0'), /Unexpected/);
});

test('formats full local and remote refs without changing arbitrary branch names', () => {
  assert.equal(branchLabel('refs/heads/feature/main'), 'feature/main');
  assert.equal(branchLabel('refs/remotes/origin/main'), 'origin/main');
  assert.equal(branchLabel('main'), 'main');
});

test('compares committed additions, modifications, deletions, and renames', async (t) => {
  const repo = fixture(t);
  repo.write('modified.txt', 'before\n');
  repo.write('deleted.txt', 'deleted\n');
  repo.write('old name.txt', 'stable content to detect a rename\n');
  const base = repo.commit('base');
  repo.git('checkout', '-b', 'feature');
  repo.write('modified.txt', 'after\n');
  repo.write('nested/你好 added.txt', 'added\n');
  repo.git('rm', 'deleted.txt');
  repo.git('mv', 'old name.txt', 'new name.txt');
  const head = repo.commit('feature changes');

  const result = await client.compare(repo.root, 'main');
  assert.equal(result.baseCommit, base);
  assert.equal(result.headCommit, head);
  assert.deepEqual(result.changes, [
    { status: 'D', path: 'deleted.txt' },
    { status: 'M', path: 'modified.txt' },
    { status: 'A', path: 'nested/你好 added.txt' },
    { status: 'R', path: 'new name.txt', originalPath: 'old name.txt' },
  ]);
  assert.equal((await client.readFile(repo.root, base, 'old name.txt')).toString(), 'stable content to detect a rename\n');
  assert.equal((await client.readFile(repo.root, head, 'modified.txt')).toString(), 'after\n');
});

test('does not include staged, unstaged, or untracked changes', async (t) => {
  const repo = fixture(t);
  repo.write('tracked.txt', 'base\n');
  repo.commit('base');
  repo.git('checkout', '-b', 'feature');
  repo.write('tracked.txt', 'unstaged\n');
  repo.write('staged.txt', 'staged\n');
  repo.git('add', 'staged.txt');
  repo.write('untracked.txt', 'untracked\n');
  assert.deepEqual((await client.compare(repo.root, 'main')).changes, []);
});

test('lists unstaged changes, respecting every standard Git ignore source', async (t) => {
  const repo = fixture(t);
  repo.write('tracked.txt', 'base\n');
  repo.write('.gitignore', 'ignored/\n');
  repo.commit('base');
  assert.deepEqual(await client.unstagedChanges(repo.root), []);
  repo.write('.git/info/exclude', 'local-excluded.txt\n');
  repo.write('.git/global-ignore', 'global-excluded.txt\n');
  repo.git('config', 'core.excludesFile', path.join(repo.root, '.git', 'global-ignore'));
  repo.write('tracked.txt', 'unstaged\n');
  repo.write('staged.txt', 'staged\n');
  repo.git('add', 'staged.txt');
  repo.write('ignored/generated.txt', 'ignored\n');
  repo.write('local-excluded.txt', 'excluded locally\n');
  repo.write('global-excluded.txt', 'excluded globally\n');
  repo.write('nested/你好 file.txt', 'new\n');
  repo.write('[literal].txt', 'literal\n');
  repo.write('--option-looking.txt', 'not an option\n');
  const expected = [
    { status: 'U', path: 'nested/你好 file.txt' },
    { status: 'U', path: '[literal].txt' },
    { status: 'U', path: '--option-looking.txt' },
    { status: 'M', path: 'tracked.txt' },
  ].sort((a, b) => a.path.localeCompare(b.path));
  assert.deepEqual(await client.unstagedChanges(repo.root), expected);
  assert.deepEqual((await client.compare(repo.root, 'main')).changes, []);
  assert.equal(repo.git('diff', '--cached', '--name-only'), 'staged.txt', 'Listing leaves the index unchanged');
});

test('includes saved tracked edits and deletions but excludes changes that are only staged', async (t) => {
  const repo = fixture(t);
  for (const file of ['modified.txt', 'deleted.txt', 'partial.txt', 'staged.txt', 'staged-deleted.txt', 'old.txt']) {
    repo.write(file, 'base\n');
  }
  repo.commit('base');
  repo.write('modified.txt', 'unstaged\n');
  fs.unlinkSync(path.join(repo.root, 'deleted.txt'));
  repo.write('partial.txt', 'staged\n');
  repo.write('staged.txt', 'staged only\n');
  repo.write('added.txt', 'staged new file\n');
  repo.git('add', 'partial.txt', 'staged.txt', 'added.txt');
  repo.git('rm', 'staged-deleted.txt');
  repo.git('mv', 'old.txt', 'renamed.txt');
  repo.write('renamed.txt', 'new unstaged content after a staged rename\n');
  repo.write('partial.txt', 'staged plus unstaged\n');
  repo.write('added.txt', 'staged addition plus unstaged\n');
  repo.write('intent.txt', 'intent to add\n');
  repo.git('add', '--intent-to-add', 'intent.txt');
  const before = fs.readFileSync(path.join(repo.root, '.git', 'index'));
  assert.deepEqual(await client.unstagedChanges(repo.root), [
    { status: 'M', path: 'added.txt' },
    { status: 'D', path: 'deleted.txt' },
    { status: 'A', path: 'intent.txt' },
    { status: 'M', path: 'modified.txt' },
    { status: 'M', path: 'partial.txt' },
    { status: 'M', path: 'renamed.txt' },
  ]);
  assert.deepEqual(fs.readFileSync(path.join(repo.root, '.git', 'index')), before, 'Status does not rewrite the index');
  assert.deepEqual((await client.compare(repo.root, 'main')).changes, []);
});

test('lists unresolved conflicts without breaking the committed comparison', async (t) => {
  const repo = fixture(t);
  repo.write('file.txt', 'base\n');
  repo.commit('base');
  repo.git('checkout', '-b', 'feature');
  repo.write('file.txt', 'feature\n');
  repo.commit('feature');
  repo.git('checkout', 'main');
  repo.write('file.txt', 'main\n');
  repo.commit('main');
  assert.throws(() => repo.git('merge', 'feature'));
  assert.deepEqual(await client.unstagedChanges(repo.root), [{ status: '!', path: 'file.txt' }]);
  assert.deepEqual((await client.compare(repo.root, 'main')).changes, []);
});

test('reads raw index bytes with text conversion disabled and literal unusual paths', async (t) => {
  const repo = fixture(t);
  repo.write('file.txt', 'HEAD\n');
  repo.write('.gitattributes', '*.bin diff=unsafe\n');
  repo.commit('base');
  repo.git('config', 'diff.unsafe.textconv', 'nonexistent-converter-must-not-run');
  const bytes = Buffer.from([0, 255, 128, 10, 13, 42]);
  repo.write('[literal] image.bin', bytes);
  repo.write('file.txt', 'staged\n');
  repo.git('add', '--all');
  repo.write('[literal] image.bin', 'working copy\n');
  repo.write('file.txt', 'unstaged\n');
  assert.deepEqual(await client.readIndexFile(repo.root, '[literal] image.bin'), bytes);
  assert.equal((await client.readIndexFile(repo.root, 'file.txt')).toString(), 'staged\n');
});

test('does not treat embedded repository directories as untracked files', async (t) => {
  const repo = fixture(t);
  repo.write('tracked.txt', 'base\n');
  repo.commit('base');
  repo.write('embedded/new.txt', 'nested\n');
  repo.git('-C', 'embedded', 'init', '--initial-branch=main');
  repo.write('own.txt', 'local\n');
  assert.deepEqual(await client.unstagedChanges(repo.root), [{ status: 'U', path: 'own.txt' }]);
});

test('queries NUL-delimited status without trimming whitespace or splitting lines', async (t) => {
  const git = new Git('git');
  t.mock.method(git, 'run', async (_root, args) => {
    assert.deepEqual(args, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignore-submodules=none', '--']);
    return Buffer.from('?? tab\tand\nnewline.ts\0??  leading and trailing \0?? nested-repo/\0');
  });
  assert.deepEqual(await git.unstagedChanges('unused'), [
    { status: 'U', path: ' leading and trailing ' },
    { status: 'U', path: 'tab\tand\nnewline.ts' },
  ]);
});

test('lists untracked files in linked worktrees without leaking files from the main worktree', async (t) => {
  const repo = fixture(t);
  repo.write('tracked.txt', 'base\n');
  repo.commit('base');
  const worktree = path.join(repo.root, 'linked-worktree');
  repo.git('worktree', 'add', '-b', 'worktree-feature', worktree);
  repo.write('main-only.txt', 'main worktree\n');
  fs.writeFileSync(path.join(worktree, 'worktree-only.txt'), 'linked worktree\n');
  assert.deepEqual(await client.unstagedChanges(worktree), [{ status: 'U', path: 'worktree-only.txt' }]);
});

test('compares branch tips rather than using a merge base', async (t) => {
  const repo = fixture(t);
  repo.write('shared.txt', 'base\n');
  repo.commit('base');
  repo.git('branch', 'feature');
  repo.write('only-on-main.txt', 'main\n');
  repo.commit('main advances');
  repo.git('checkout', 'feature');
  repo.write('only-on-feature.txt', 'feature\n');
  repo.commit('feature advances');
  assert.deepEqual((await client.compare(repo.root, 'main')).changes, [
    { status: 'A', path: 'only-on-feature.txt' },
    { status: 'D', path: 'only-on-main.txt' },
  ]);
});

test('lists local and remote branches, excluding symbolic remote HEAD', async (t) => {
  const repo = fixture(t);
  repo.write('file.txt', 'base\n');
  const sha = repo.commit('base');
  repo.git('branch', 'feature/nested');
  repo.git('update-ref', 'refs/remotes/origin/main', sha);
  repo.git('symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main');
  assert.deepEqual(await client.branches(repo.root), [
    { ref: 'refs/heads/feature/nested', name: 'feature/nested', remote: false },
    { ref: 'refs/heads/main', name: 'main', remote: false },
    { ref: 'refs/remotes/origin/main', name: 'origin/main', remote: true },
  ]);
});

test('reports missing branches and unborn HEAD without passing refs as options', async (t) => {
  const repo = fixture(t);
  await assert.rejects(client.resolveCommit(repo.root, 'HEAD'), MissingReferenceError);
  repo.write('file.txt', 'base\n');
  repo.commit('base');
  await assert.rejects(client.compare(repo.root, 'missing'), (error) => error instanceof MissingReferenceError && error.reference === 'missing');
  await assert.rejects(client.resolveCommit(repo.root, '--help'), MissingReferenceError);
  await assert.rejects(client.readFile(repo.root, '--help', 'file.txt'), /Invalid snapshot commit/);
});

test('preserves execution errors instead of misreporting a missing branch', async (t) => {
  const repo = fixture(t);
  const missingGit = new Git(path.join(repo.root, 'nonexistent-git-executable'));
  await assert.rejects(missingGit.resolveCommit(repo.root, 'main'), (error) => {
    assert.ok(!(error instanceof MissingReferenceError));
    assert.match(error.message, /ENOENT/);
    return true;
  });
});

test('looks up blob types using literal paths, including wildcard-looking filenames', async (t) => {
  const repo = fixture(t);
  repo.write('nested/file.txt', 'base\n');
  repo.write('[literal].txt', 'literal\n');
  const commit = repo.commit('base');
  assert.equal(await client.fileType(repo.root, commit, 'nested/file.txt'), 'blob');
  assert.equal(await client.fileType(repo.root, commit, '[literal].txt'), 'blob');
  assert.equal(await client.fileType(repo.root, commit, 'nested'), 'tree');
  assert.equal(await client.fileType(repo.root, commit, 'missing.txt'), undefined);
  assert.equal(await client.fileType(repo.root, commit, '*.txt'), undefined);
});

test('checks ignore rules without confusing untracked and ignored files', async (t) => {
  const repo = fixture(t);
  repo.write('.gitignore', 'ignored/\n');
  repo.commit('base');
  assert.equal(await client.isIgnored(repo.root, 'ignored/file.txt'), true);
  assert.equal(await client.isIgnored(repo.root, 'untracked.txt'), false);
});

test('supports detached HEAD and retains binary file bytes', async (t) => {
  const repo = fixture(t);
  repo.write('base.txt', 'base\n');
  repo.commit('base');
  repo.git('checkout', '-b', 'feature');
  const bytes = Buffer.from([0, 255, 128, 10, 13, 42]);
  repo.write('image.bin', bytes);
  const sha = repo.commit('binary file');
  repo.git('checkout', '--detach', sha);
  const result = await client.compare(repo.root, 'main');
  assert.deepEqual(result.changes, [{ status: 'A', path: 'image.bin' }]);
  assert.deepEqual(await client.readFile(repo.root, sha, 'image.bin'), bytes);
});

test('supports linked Git worktrees', async (t) => {
  const repo = fixture(t);
  repo.write('file.txt', 'base\n');
  repo.commit('base');
  const worktree = path.join(repo.root, 'linked-worktree');
  repo.git('worktree', 'add', '-b', 'worktree-feature', worktree);
  fs.writeFileSync(path.join(worktree, 'file.txt'), 'worktree changes\n');
  repo.git('-C', worktree, 'add', 'file.txt');
  repo.git('-C', worktree, 'commit', '--no-gpg-sign', '-m', 'worktree change');
  assert.deepEqual((await client.compare(worktree, 'main')).changes, [{ status: 'M', path: 'file.txt' }]);
});
