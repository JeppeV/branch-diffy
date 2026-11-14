const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const vscode = require('vscode');
const { indexSnapshotUri, snapshotUri } = require('../dist/snapshots');

async function waitFor(check, message) {
  const deadline = Date.now() + 10000;
  while (!await check()) {
    assert.ok(Date.now() < deadline, `${message}\nActive editor: ${vscode.window.activeTextEditor?.document.uri.toString()}\nTabs: ${JSON.stringify(
      vscode.window.tabGroups.all.flatMap((group) => group.tabs.map((tab) => ({
        label: tab.label, active: tab.isActive, type: tab.input?.constructor.name,
        original: tab.input?.original?.toString(), modified: tab.input?.modified?.toString(),
      }))),
    )}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

async function run() {
  const root = vscode.Uri.file(process.env.BRANCH_DIFF_TEST_ROOT);
  const git = (await vscode.extensions.getExtension('vscode.git').activate()).getAPI(1);
  await waitFor(() => git.repositories.some((repo) => repo.state.HEAD?.name === 'feature'), 'Git discovers the test repository');
  const extension = vscode.extensions.getExtension('branch-diff-local.branch-diff');
  assert.ok(extension, 'Development extension was discovered');
  await extension.activate();
  await vscode.commands.executeCommand('branchDiff.files.focus');
  await vscode.commands.executeCommand('branchDiff.refresh');

  const commands = await vscode.commands.getCommands(true);
  for (const command of ['refresh', 'selectBranch', 'selectRepository', 'openFile', 'openDiff', 'toggleMarkers', 'enableMarkers', 'disableMarkers']) {
    assert.ok(commands.includes(`branchDiff.${command}`), `${command} is registered`);
  }
  assert.equal(vscode.workspace.getConfiguration('branchDiff').get('defaultBaseBranch'), 'main');
  assert.equal(vscode.workspace.fs.isWritableFileSystem('branch-diff-snapshot'), false);

  const base = process.env.BRANCH_DIFF_TEST_BASE;
  const head = process.env.BRANCH_DIFF_TEST_HEAD;
  const deleted = snapshotUri(root, base, 'deleted.txt');
  const left = snapshotUri(root, base, 'modified.txt');
  const right = snapshotUri(root, head, 'modified.txt');
  const empty = snapshotUri(root, base, 'added.txt', true);
  assert.equal(Buffer.from(await vscode.workspace.fs.readFile(left)).toString(), 'unchanged first\nbefore\nunchanged third\nunchanged fourth\n');
  assert.equal(Buffer.from(await vscode.workspace.fs.readFile(right)).toString(), 'unchanged first\nafter\nunchanged third\nunchanged fourth\n');
  assert.equal((await vscode.workspace.fs.readFile(empty)).byteLength, 0);

  // Check the editor before retrying: a successful check must not queue another file-open command.
  const selectRow = async (offset, collapseFirst = false) => {
    await vscode.commands.executeCommand('branchDiff.files.focus');
    await vscode.commands.executeCommand('list.focusFirst');
    if (collapseFirst) {
      await vscode.commands.executeCommand('list.collapse');
    }
    for (let index = 0; index < offset; index++) {
      await vscode.commands.executeCommand('list.focusDown');
    }
    await vscode.commands.executeCommand('list.select');
  };

  // Exercise the actual tree's selection command, rather than calling our open handler directly.
  await waitFor(async () => {
    const document = vscode.window.activeTextEditor?.document;
    if (document?.uri.scheme === 'file' && document.getText() === 'added\n') {
      return true;
    }
    await selectRow(1);
    return false;
  }, 'Selecting the first changed file opens the working copy');
  await selectRow(2);
  await waitFor(() => {
    return vscode.window.activeTextEditor?.document.uri.toString() === deleted.toString();
  }, 'Selecting a deleted file opens its historical snapshot');
  assert.equal(vscode.window.activeTextEditor.document.getText(), 'deleted\n');

  // Collapsing committed changes leaves the separate unstaged section accessible.
  await selectRow(2, true);
  const localDeleted = indexSnapshotUri(root, 'local-deleted.txt');
  await waitFor(() => vscode.window.activeTextEditor?.document.uri.toString() === localDeleted.toString(),
    'Selecting an unstaged deletion opens the index version');
  assert.equal(vscode.window.activeTextEditor.document.getText(), 'local deletion baseline\n');
  await selectRow(3, true);
  const localModified = vscode.Uri.joinPath(root, 'local-modified.txt');
  await waitFor(() => vscode.window.activeTextEditor?.document.uri.toString() === localModified.toString(),
    'Selecting an unstaged tracked modification opens the working file');
  assert.equal(vscode.window.activeTextEditor.document.getText(), 'working local version\n');
  await selectRow(4, true);
  await waitFor(() => {
    return vscode.window.activeTextEditor?.document.uri.toString() === vscode.Uri.joinPath(root, 'untracked.txt').toString();
  }, 'Selecting an untracked file in the unstaged section opens the working copy');
  assert.equal(vscode.window.activeTextEditor.document.getText(), 'untracked\n');
  const untracked = vscode.Uri.joinPath(root, 'untracked.txt');
  await vscode.commands.executeCommand('vscode.diff', snapshotUri(root, base, 'untracked.txt', true), untracked, 'Untracked file smoke test');
  await waitFor(() => {
    const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
    return input instanceof vscode.TabInputTextDiff && input.modified.toString() === untracked.toString();
  }, 'Untracked files support a native empty-to-working-file diff');
  const untrackedEditor = await vscode.window.showTextDocument(untracked);
  await untrackedEditor.edit((edit) => edit.insert(new vscode.Position(1, 0), 'unsaved\n'));
  await vscode.commands.executeCommand('vscode.diff', snapshotUri(root, base, 'untracked.txt', true), untracked, 'Untracked file smoke test');
  await waitFor(() => vscode.window.activeTextEditor?.document.getText() === 'untracked\nunsaved\n',
    'Untracked diffs include unsaved editor contents');
  await vscode.commands.executeCommand('undo');

  const index = indexSnapshotUri(root, 'local-modified.txt');
  assert.equal(Buffer.from(await vscode.workspace.fs.readFile(index)).toString(), 'staged local version\n');
  await vscode.commands.executeCommand('vscode.diff', index, localModified, 'Unstaged tracked file smoke test');
  await waitFor(() => {
    const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
    return input instanceof vscode.TabInputTextDiff && input.original.toString() === index.toString()
      && vscode.window.activeTextEditor?.document.getText() === 'working local version\n';
  }, 'Unstaged tracked diffs compare the staged index against the working copy');
  execFileSync(git.git.path, ['add', 'local-modified.txt'], { cwd: root.fsPath, windowsHide: true });
  await git.repositories.find((repo) => repo.rootUri.toString() === root.toString()).status();
  await vscode.commands.executeCommand('branchDiff.refresh');
  await waitFor(() => vscode.workspace.textDocuments.some((document) => document.uri.toString() === index.toString()
    && document.getText() === 'working local version\n'),
  'An already-open index baseline updates after staging without pinning an old commit');

  const binary = vscode.Uri.joinPath(root, 'index-binary.bin');
  const bytes = Buffer.from([0, 255, 128, 10, 13, 42]);
  await vscode.workspace.fs.writeFile(binary, bytes);
  execFileSync(git.git.path, ['add', 'index-binary.bin'], { cwd: root.fsPath, windowsHide: true });
  assert.deepEqual(Buffer.from(await vscode.workspace.fs.readFile(indexSnapshotUri(root, 'index-binary.bin'))), bytes);

  await vscode.commands.executeCommand('vscode.diff', left, right, 'Branch Diff smoke test');
  await waitFor(() => vscode.window.activeTextEditor?.document.getText() === 'unchanged first\nafter\nunchanged third\nunchanged fourth\n',
    'Committed diffs open the historical HEAD snapshot');
  await vscode.commands.executeCommand('workbench.action.closeAllEditors');

  const editor = await vscode.window.showTextDocument(vscode.Uri.joinPath(root, 'modified.txt'));
  const nextChange = async (from, expected) => {
    await waitFor(async () => {
      editor.selection = new vscode.Selection(from, 0, from, 0);
      await vscode.commands.executeCommand('workbench.action.editor.nextChange');
      return editor.selection.active.line === expected;
    }, `Native change navigation from line ${from + 1} reaches line ${expected + 1}`);
  };
  // This tracked file is clean relative to HEAD: only our provider exposes the committed change.
  await nextChange(0, 1);
  await vscode.commands.executeCommand('branchDiff.disableMarkers');
  await nextChange(0, 0);
  await vscode.commands.executeCommand('branchDiff.enableMarkers');
  await nextChange(0, 1);

  await editor.edit((edit) => edit.replace(editor.document.lineAt(3).range, 'unsaved fourth'));
  assert.equal(editor.document.isDirty, true);
  await nextChange(2, 3);
  await vscode.commands.executeCommand('undo');
  assert.equal(editor.document.isDirty, false);

  // Moving the same branch ref must invalidate the old baseline in already-open editors.
  execFileSync(git.git.path, ['update-ref', 'refs/heads/main', head], { cwd: root.fsPath, windowsHide: true });
  await vscode.commands.executeCommand('branchDiff.refresh');
  await nextChange(0, 0);
  execFileSync(git.git.path, ['update-ref', 'refs/heads/main', base], { cwd: root.fsPath, windowsHide: true });
  await vscode.commands.executeCommand('branchDiff.refresh');
  await nextChange(0, 1);
  await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  console.log('Branch Diff: VS Code extension-host smoke test passed.');
}

module.exports = { run };
