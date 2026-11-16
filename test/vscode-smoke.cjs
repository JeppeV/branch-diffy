const assert = require('node:assert/strict');
const { execFile, execFileSync } = require('node:child_process');
const path = require('node:path');
const { promisify } = require('node:util');
const vscode = require('vscode');
const manifest = require('../package.json');
const { indexSnapshotUri, snapshotUri } = require('../dist/snapshots');

async function workbench(expression) {
  const { stdout } = await promisify(execFile)(process.env.BRANCH_DIFFY_TEST_NODE, [
    path.join(__dirname, 'vscode-renderer.cjs'), process.env.BRANCH_DIFFY_TEST_DEBUG_PORT, expression,
  ], { windowsHide: true, timeout: 10000 });
  return JSON.parse(stdout);
}

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
  const root = vscode.Uri.file(process.env.BRANCH_DIFFY_TEST_ROOT);
  const git = (await vscode.extensions.getExtension('vscode.git').activate()).getAPI(1);
  await waitFor(() => git.repositories.some((repo) => repo.state.HEAD?.name === 'feature'), 'Git discovers the test repository');
  const extension = vscode.extensions.getExtension(`${manifest.publisher}.${manifest.name}`);
  assert.ok(extension, 'Development extension was discovered');
  await waitFor(() => extension.isActive, 'Branch Diffy activates after startup without opening its sidebar');
  const statusShown = (enabled) => workbench(`(() => {
    const item = [...document.querySelectorAll('.statusbar-item')].find(item => item.textContent.includes('Branch Diffy:'));
    return !!item && item.getClientRects().length > 0
      && item.textContent.includes(${JSON.stringify(`Branch Diffy: ${enabled ? 'On' : 'Off'}`)})
      && !!item.querySelector(${JSON.stringify(`.codicon-${enabled ? 'eye' : 'eye-closed'}`)});
  })()`);
  const clickStatus = () => workbench(`(() => {
    const item = [...document.querySelectorAll('.statusbar-item')].find(item => item.textContent.includes('Branch Diffy:'));
    item.querySelector('a').click();
    return true;
  })()`);
  await waitFor(() => statusShown(true), 'The status bar shows markers On before the Branch Diffy sidebar is opened');
  await clickStatus();
  await waitFor(() => statusShown(false), 'Clicking the status bar turns markers Off without opening the sidebar');
  await clickStatus();
  await waitFor(() => statusShown(true), 'Clicking again turns markers On');
  await vscode.commands.executeCommand('branchDiffy.files.focus');
  await vscode.commands.executeCommand('branchDiffy.refresh');

  const commands = await vscode.commands.getCommands(true);
  for (const command of ['refresh', 'selectBranch', 'selectRepository', 'openFile', 'openDiff', 'toggleMarkers', 'enableMarkers', 'disableMarkers']) {
    assert.ok(commands.includes(`branchDiffy.${command}`), `${command} is registered`);
  }
  assert.equal(vscode.workspace.getConfiguration('branchDiffy').get('defaultBaseBranch'), 'main');
  assert.equal(vscode.workspace.fs.isWritableFileSystem('branch-diffy-snapshot'), false);

  const base = process.env.BRANCH_DIFFY_TEST_BASE;
  const head = process.env.BRANCH_DIFFY_TEST_HEAD;
  const deleted = snapshotUri(root, base, 'deleted.txt');
  const left = snapshotUri(root, base, 'modified.txt');
  const right = snapshotUri(root, head, 'modified.txt');
  const empty = snapshotUri(root, base, 'added.txt', true);
  assert.equal(Buffer.from(await vscode.workspace.fs.readFile(left)).toString(), 'unchanged first\nbefore\nunchanged third\nunchanged fourth\n');
  assert.equal(Buffer.from(await vscode.workspace.fs.readFile(right)).toString(), 'unchanged first\nafter\nunchanged third\nunchanged fourth\n');
  assert.equal((await vscode.workspace.fs.readFile(empty)).byteLength, 0);

  // Check the editor before retrying: a successful check must not queue another file-open command.
  const selectRow = async (offset, uri, message, collapseFirst = false) => {
    await waitFor(async () => {
      if (vscode.window.activeTextEditor?.document.uri.toString() === uri.toString()) {
        return true;
      }
      // View focus and file opening settle asynchronously, so retry the full interaction.
      await vscode.commands.executeCommand('branchDiffy.files.focus');
      await vscode.commands.executeCommand('list.focusFirst');
      if (collapseFirst) {
        await vscode.commands.executeCommand('list.collapse');
      }
      for (let index = 0; index < offset; index++) {
        await vscode.commands.executeCommand('list.focusDown');
      }
      await vscode.commands.executeCommand('list.select');
      return false;
    }, message);
  };

  // Exercise the actual tree's selection command, rather than calling our open handler directly.
  await waitFor(() => workbench(`
    [...document.querySelectorAll('.monaco-list-row')].some(row => row.textContent.includes('Committed changes'))
      && [...document.querySelectorAll('.monaco-list-row')].some(row => row.textContent.includes('added.txt'))
  `), 'The committed file tree finishes rendering before selection');
  await selectRow(1, vscode.Uri.joinPath(root, 'added.txt'), 'Selecting the first changed file opens the working copy');
  assert.equal(vscode.window.activeTextEditor.document.getText(), 'added\n');
  await selectRow(2, deleted, 'Selecting a deleted file opens its historical snapshot');
  assert.equal(vscode.window.activeTextEditor.document.getText(), 'deleted\n');

  // Collapsing committed changes leaves the separate unstaged section accessible.
  const localDeleted = indexSnapshotUri(root, 'local-deleted.txt');
  await selectRow(2, localDeleted, 'Selecting an unstaged deletion opens the index version', true);
  assert.equal(vscode.window.activeTextEditor.document.getText(), 'local deletion baseline\n');
  const localModified = vscode.Uri.joinPath(root, 'local-modified.txt');
  await selectRow(3, localModified, 'Selecting an unstaged tracked modification opens the working file', true);
  assert.equal(vscode.window.activeTextEditor.document.getText(), 'working local version\n');
  const untracked = vscode.Uri.joinPath(root, 'untracked.txt');
  await selectRow(4, untracked, 'Selecting an untracked file in the unstaged section opens the working copy', true);
  assert.equal(vscode.window.activeTextEditor.document.getText(), 'untracked\n');
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
  await vscode.commands.executeCommand('branchDiffy.refresh');
  await waitFor(() => vscode.workspace.textDocuments.some((document) => document.uri.toString() === index.toString()
    && document.getText() === 'working local version\n'),
  'An already-open index baseline updates after staging without pinning an old commit');

  const binary = vscode.Uri.joinPath(root, 'index-binary.bin');
  const bytes = Buffer.from([0, 255, 128, 10, 13, 42]);
  await vscode.workspace.fs.writeFile(binary, bytes);
  execFileSync(git.git.path, ['add', 'index-binary.bin'], { cwd: root.fsPath, windowsHide: true });
  assert.deepEqual(Buffer.from(await vscode.workspace.fs.readFile(indexSnapshotUri(root, 'index-binary.bin'))), bytes);

  await vscode.commands.executeCommand('vscode.diff', left, right, 'Branch Diffy smoke test');
  await waitFor(() => vscode.window.activeTextEditor?.document.getText() === 'unchanged first\nafter\nunchanged third\nunchanged fourth\n',
    'Committed diffs open the historical HEAD snapshot');
  await vscode.commands.executeCommand('workbench.action.closeAllEditors');

  // Verify native Explorer colors, status letters, and inherited folder indicators.
  await vscode.workspace.getConfiguration('explorer').update('compactFolders', false, vscode.ConfigurationTarget.Global);
  // Select a different row: focused selections override decoration colors in some themes.
  await vscode.commands.executeCommand('revealInExplorer', vscode.Uri.joinPath(root, 'added.txt'));
  const explorerColors = () => workbench(`(() => {
    const labels = [...document.querySelectorAll('.explorer-viewlet .label-name')];
    const colors = Object.fromEntries(['modified.txt', 'z-added-no-eol.txt', 'untracked.txt', 'local-modified.txt'].map(name => {
      const label = labels.find(label => label.textContent === name);
      return [name, label ? getComputedStyle(label).color : null];
    }));
    const probe = document.createElement('span');
    document.querySelector('.monaco-workbench').append(probe);
    for (const status of ['added', 'modified']) {
      probe.style.color = 'var(--vscode-gitDecoration-' + status + 'ResourceForeground)';
      colors[status] = getComputedStyle(probe).color;
    }
    probe.remove();
    return colors;
  })()`);
  const explorerBadges = () => workbench(`(() => {
    const labels = [...document.querySelectorAll('.explorer-viewlet .label-name')];
    return Object.fromEntries([
      'modified.txt', 'z-added-no-eol.txt', 'untracked.txt', 'local-modified.txt',
      'z-branch-parent', 'z-branch-child', 'branch-nested.txt',
      'z-native-parent', 'z-native-child', 'native-nested.txt',
      'z-branch-deletions', 'z-native-deletions',
    ].map(name => {
      const label = labels.find(label => label.textContent === name);
      const iconLabel = label?.closest('.monaco-icon-label');
      return [name, iconLabel ? {
        color: getComputedStyle(label).color,
        badge: getComputedStyle(iconLabel, '::after').content,
      } : null];
    }));
  })()`);
  await waitFor(async () => {
    const badges = await explorerBadges();
    const branch = badges['z-branch-parent'];
    const native = badges['z-native-parent'];
    return branch && native && branch.color === native.color
      && branch.badge === native.badge && !['none', 'normal', '""'].includes(native.badge)
      && !badges['branch-nested.txt'] && !badges['native-nested.txt'];
  }, 'Unopened collapsed folders inherit branch colors and change indicators just like native unstaged changes');
  await waitFor(async () => {
    const badges = await explorerBadges();
    const branch = badges['z-branch-deletions'];
    const native = badges['z-native-deletions'];
    return branch && native && branch.color === native.color
      && ['none', 'normal', '""'].includes(branch.badge)
      && ['none', 'normal', '""'].includes(native.badge);
  }, 'Folders containing only branch deletions stay undecorated, just like folders with unstaged deletions');
  await vscode.commands.executeCommand('revealInExplorer', vscode.Uri.joinPath(root, 'z-branch-parent/z-branch-child/branch-nested.txt'));
  await vscode.commands.executeCommand('revealInExplorer', vscode.Uri.joinPath(root, 'z-native-parent/z-native-child/native-nested.txt'));
  await vscode.commands.executeCommand('revealInExplorer', vscode.Uri.joinPath(root, 'added.txt'));
  await waitFor(async () => {
    const colors = await explorerColors();
    return colors['modified.txt'] && colors['z-added-no-eol.txt'] && colors['untracked.txt'] && colors['local-modified.txt']
      && colors['modified.txt'] === colors.modified
      && colors['z-added-no-eol.txt'] === colors.added
      && colors['modified.txt'] !== colors['z-added-no-eol.txt'];
  }, 'Committed modified and added files use their corresponding native Git status colors in Explorer');
  await waitFor(async () => {
    const badges = await explorerBadges();
    const native = badges['native-nested.txt'];
    const folder = badges['z-native-parent'];
    return native?.badge === '"M"' && badges['modified.txt']?.badge === native.badge
      && badges['branch-nested.txt']?.badge === native.badge
      && badges['z-added-no-eol.txt']?.badge === '"A"'
      && folder && folder.badge !== 'none' && folder.badge !== '""'
      && ['z-branch-parent', 'z-branch-child', 'z-native-child'].every(name =>
        badges[name]?.color === folder.color && badges[name]?.badge === folder.badge)
      && folder.color === native.color;
  }, 'Branch status letters and both ancestor folder colors/indicators match native unstaged Git decorations');
  const enabledColors = await explorerColors();
  const enabledBadges = await explorerBadges();
  await waitFor(() => statusShown(true), 'Marker status remains visible while Explorer replaces the Branch Diffy sidebar');
  await clickStatus();
  await waitFor(() => statusShown(false), 'The status bar toggles markers Off while Branch Diffy is hidden');
  await waitFor(async () => {
    const colors = await explorerColors();
    return colors['modified.txt'] !== enabledColors['modified.txt']
      && colors['z-added-no-eol.txt'] !== enabledColors['z-added-no-eol.txt']
      && colors['untracked.txt'] === enabledColors['untracked.txt']
      && colors['local-modified.txt'] === enabledColors['local-modified.txt'];
  }, 'Disabling markers removes cached branch coloring but leaves native Git colors intact');
  await waitFor(async () => {
    const badges = await explorerBadges();
    return ['modified.txt', 'z-added-no-eol.txt', 'z-branch-parent', 'z-branch-child', 'branch-nested.txt'].every(name =>
      badges[name] && badges[name].color !== enabledBadges[name].color
        && ['none', 'normal', '""'].includes(badges[name].badge))
      && ['untracked.txt', 'local-modified.txt', 'z-native-parent', 'z-native-child', 'native-nested.txt',
        'z-branch-deletions', 'z-native-deletions'].every(name =>
        JSON.stringify(badges[name]) === JSON.stringify(enabledBadges[name]));
  }, 'Disabling markers clears branch badges and both ancestor decorations without affecting native Git');
  await vscode.commands.executeCommand('branchDiffy.enableMarkers');
  await waitFor(() => statusShown(true), 'The status bar reflects markers enabled through a command');
  await waitFor(async () => {
    const colors = await explorerColors();
    return colors['modified.txt'] === enabledColors['modified.txt']
      && colors['z-added-no-eol.txt'] === enabledColors['z-added-no-eol.txt'];
  }, 'Enabling markers restores Explorer coloring while the Branch Diffy sidebar is closed');
  await waitFor(async () => JSON.stringify(await explorerBadges()) === JSON.stringify(enabledBadges),
    'Enabling markers restores branch status letters and all inherited folder decorations');

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
  await clickStatus();
  await waitFor(() => statusShown(false), 'Clicking the status bar disables native branch markers in the open editor');
  await nextChange(0, 0);
  await clickStatus();
  await waitFor(() => statusShown(true), 'Clicking the status bar restores native branch markers in the open editor');
  await nextChange(0, 1);

  const branchOriginal = () => vscode.workspace.textDocuments.find((document) => {
    if (document.uri.scheme !== 'branch-diffy-snapshot') {
      return false;
    }
    const snapshot = JSON.parse(document.uri.query);
    return snapshot.commit === base && snapshot.markerPath === 'modified.txt';
  });
  await editor.edit((edit) => edit.insert(new vscode.Position(2, 0), 'local addition\n'));
  await waitFor(() => branchOriginal()?.getText() === 'unchanged first\nbefore\nlocal addition\nunchanged third\nunchanged fourth\n',
    'The native branch baseline absorbs an adjacent unsaved addition');
  await nextChange(0, 1);
  await nextChange(1, 2);
  await vscode.commands.executeCommand('branchDiffy.disableMarkers');
  await waitFor(() => statusShown(false), 'The status bar reflects markers disabled through a command');
  await nextChange(0, 2);
  await vscode.commands.executeCommand('branchDiffy.enableMarkers');
  await nextChange(0, 1);
  await editor.document.save();
  await git.repositories.find((repo) => repo.rootUri.toString() === root.toString()).status();
  await vscode.commands.executeCommand('branchDiffy.refresh');
  await waitFor(() => branchOriginal()?.getText() === 'unchanged first\nbefore\nlocal addition\nunchanged third\nunchanged fourth\n',
    'Saving keeps the native branch baseline adjusted for the now-saved unstaged addition');
  await nextChange(1, 2);
  execFileSync(git.git.path, ['add', 'modified.txt'], { cwd: root.fsPath, windowsHide: true });
  await git.repositories.find((repo) => repo.rootUri.toString() === root.toString()).status();
  await vscode.commands.executeCommand('branchDiffy.refresh');
  await waitFor(() => branchOriginal()?.getText() === 'unchanged first\nbefore\nunchanged third\nunchanged fourth\n',
    'Staging makes the added line part of the native branch comparison again');
  execFileSync(git.git.path, ['reset', 'HEAD', '--', 'modified.txt'], { cwd: root.fsPath, windowsHide: true });
  await git.repositories.find((repo) => repo.rootUri.toString() === root.toString()).status();
  await vscode.commands.executeCommand('branchDiffy.refresh');
  await waitFor(() => branchOriginal()?.getText() === 'unchanged first\nbefore\nlocal addition\nunchanged third\nunchanged fourth\n',
    'Unstaging restores the adjusted native baseline without reopening the editor');
  await nextChange(1, 2);
  await editor.edit((edit) => edit.delete(new vscode.Range(2, 0, 3, 0)));
  await editor.document.save();
  await git.repositories.find((repo) => repo.rootUri.toString() === root.toString()).status();
  await vscode.commands.executeCommand('branchDiffy.refresh');
  await waitFor(() => branchOriginal()?.getText() === 'unchanged first\nbefore\nunchanged third\nunchanged fourth\n',
    'Removing the local addition restores the original branch baseline in the open editor');

  for (const [name, deletedLine, baseline, anchor] of [
    ['case 4', 2, 'unchanged first\nbefore\nunchanged fourth\n', 1],
    ['case 5', 0, 'before\nunchanged third\nunchanged fourth\n', 0],
  ]) {
    await editor.edit((edit) => edit.delete(new vscode.Range(deletedLine, 0, deletedLine + 1, 0)));
    await waitFor(() => branchOriginal()?.getText() === baseline,
      `${name}: a shared local deletion anchor retains the independent branch comparison`);
    for (const saved of [false, true]) {
      if (saved) {
        await editor.document.save();
        await git.repositories.find((repo) => repo.rootUri.toString() === root.toString()).status();
        await vscode.commands.executeCommand('branchDiffy.refresh');
      }
      const state = `${name}, ${saved ? 'saved' : 'unsaved'}`;
      editor.selection = new vscode.Selection(anchor, 0, anchor, 0);
      // Both providers can be listed before native Git finishes recomputing its change anchor.
      await waitFor(async () => {
        await vscode.commands.executeCommand('closeDirtyDiff');
        await vscode.commands.executeCommand('editor.action.dirtydiff.next');
        return workbench(`(() => {
          const dropdown = document.querySelector('.dirty-diff .peekview-title .dropdown');
          const select = dropdown?.querySelector('select');
          return !!dropdown && getComputedStyle(dropdown).display !== 'none'
            && !!select && [...select.options].some(option => option.text === 'Git local working changes')
            && [...select.options].some(option => option.text === 'Branch Diffy (main)')
            && select.value === 'Git local working changes';
        })()`);
      }, `${state}: the native inline preview offers both providers and prefers the updated local Git change`);
      assert.equal(await workbench(`document.querySelector('.dirty-diff .dropdown select').value`),
        'Git local working changes', `${state}: opening the shared anchor still prefers local Git`);
      // The preview can update before the outer editor paints its gutter decorations.
      await waitFor(() => workbench(`!!document.querySelector('.margin-view-overlays .dirty-diff-deleted')`),
        `${state}: native Git still paints its deletion marker`);
      for (const [provider, showsBranch] of [['Branch Diffy (main)', true], ['Git local working changes', false]]) {
        await workbench(`(() => {
          const select = document.querySelector('.dirty-diff .dropdown select');
          select.value = ${JSON.stringify(provider)};
          select.dispatchEvent(new Event('change', { bubbles: true }));
          return true;
        })()`);
        await waitFor(async () => (await workbench(`
          [...document.querySelectorAll('.dirty-diff .view-line')].some(line => line.textContent === 'before')
        `)) === showsBranch, `${state}: selecting ${provider} displays the corresponding comparison`);
      }
      await vscode.commands.executeCommand('closeDirtyDiff');
    }
    await vscode.commands.executeCommand('undo');
    await editor.document.save();
    await git.repositories.find((repo) => repo.rootUri.toString() === root.toString()).status();
    await vscode.commands.executeCommand('branchDiffy.refresh');
    await waitFor(() => branchOriginal()?.getText() === 'unchanged first\nbefore\nunchanged third\nunchanged fourth\n',
      `${name}: undoing the deletion restores the original branch baseline`);
  }

  await editor.edit((edit) => edit.replace(editor.document.lineAt(3).range, 'unsaved fourth'));
  assert.equal(editor.document.isDirty, true);
  await nextChange(2, 3);
  await vscode.commands.executeCommand('undo');
  assert.equal(editor.document.isDirty, false);

  // Moving the same branch ref must invalidate the old baseline in already-open editors.
  execFileSync(git.git.path, ['update-ref', 'refs/heads/main', head], { cwd: root.fsPath, windowsHide: true });
  await vscode.commands.executeCommand('branchDiffy.refresh');
  await nextChange(0, 0);
  execFileSync(git.git.path, ['update-ref', 'refs/heads/main', base], { cwd: root.fsPath, windowsHide: true });
  await vscode.commands.executeCommand('branchDiffy.refresh');
  await nextChange(0, 1);
  // Case 9: appending must keep the committed addition separate from the local addition,
  // including a one-line file created without a trailing newline.
  for (const file of ['added.txt', 'z-added-no-eol.txt']) {
    const addedEditor = await vscode.window.showTextDocument(vscode.Uri.joinPath(root, file));
    const committed = addedEditor.document.getText();
    await addedEditor.edit((edit) => edit.insert(addedEditor.document.positionAt(committed.length),
      `${committed.endsWith('\n') ? '' : '\n'}local addition\n`));
    for (const saved of [false, true]) {
      if (saved) {
        await addedEditor.document.save();
        await git.repositories.find((repo) => repo.rootUri.toString() === root.toString()).status();
        await vscode.commands.executeCommand('branchDiffy.refresh');
      }
      const state = `case 9, ${file}, ${saved ? 'saved' : 'unsaved'}`;
      await waitFor(async () => {
        addedEditor.selection = new vscode.Selection(2, 0, 2, 0);
        await vscode.commands.executeCommand('workbench.action.editor.nextChange');
        return addedEditor.selection.active.line === 0;
      }, `${state}: native change navigation still finds the committed addition`);
      await waitFor(async () => {
        addedEditor.selection = new vscode.Selection(0, 0, 0, 0);
        await vscode.commands.executeCommand('workbench.action.editor.nextChange');
        return addedEditor.selection.active.line === 1;
      }, `${state}: native Git still marks the appended local addition separately`);
    }
  }
  await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  console.log('Branch Diffy: VS Code extension-host smoke test passed.');
}

module.exports = { run };
