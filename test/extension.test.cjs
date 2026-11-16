const assert = require('node:assert/strict');
const fs = require('node:fs');
const { createRequire } = require('node:module');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const { fixture } = require('./helpers.cjs');

class Disposable {
  constructor(dispose = () => {}) { this.dispose = dispose; }
}

class EventEmitter {
  listeners = new Set();
  event = (listener) => {
    this.listeners.add(listener);
    return new Disposable(() => this.listeners.delete(listener));
  };
  fire(value) { for (const listener of this.listeners) { listener(value); } }
  dispose() { this.listeners.clear(); }
}

class Uri {
  constructor(scheme, filePath, query = '') {
    this.scheme = scheme;
    this.path = filePath;
    this.query = query;
  }
  static file(filePath) { return new Uri('file', filePath); }
  static from({ scheme, path: filePath, query }) { return new Uri(scheme, filePath, query); }
  static joinPath(root, ...parts) { return new Uri(root.scheme, path.join(root.path, ...parts)); }
  get fsPath() { return this.path; }
  toString() { return `${this.scheme}:${this.path}?${this.query}`; }
}

// Load the production modules with only the VS Code boundary replaced; Git is real.
function loadWithVscode(filename, vscode, cache = new Map()) {
  if (cache.has(filename)) { return cache.get(filename).exports; }
  const module = { exports: {} };
  cache.set(filename, module);
  const nodeRequire = createRequire(filename);
  const localRequire = (name) => {
    if (name === 'vscode') { return vscode; }
    if (name === './snapshots' || name === './markers' || name === './decorations') { return loadWithVscode(nodeRequire.resolve(name), vscode, cache); }
    return nodeRequire(name);
  };
  const source = fs.readFileSync(filename, 'utf8');
  const run = vm.runInThisContext(`(function(require, module, exports) {\n${source}\n})`, { filename });
  run(localRequire, module, module.exports);
  return module.exports;
}

function repository(repo) {
  const changed = new EventEmitter();
  return {
    rootUri: Uri.file(repo.root),
    state: {
      HEAD: { name: repo.git('branch', '--show-current'), commit: repo.git('rev-parse', 'HEAD') },
      onDidChange: changed.event,
    },
    changed,
  };
}

async function harness(t, repositories = [], options = {}) {
  const commands = new Map();
  const providers = new Map();
  const state = new Map(Object.entries(options.state ?? {}));
  const contexts = new Map();
  const sourceControls = [];
  const statusBarItems = [];
  const calls = [];
  const errors = [];
  const opened = new EventEmitter();
  const closed = new EventEmitter();
  const textChanged = new EventEmitter();
  const textOpened = new EventEmitter();
  const textClosed = new EventEmitter();
  const textDocuments = [];
  const api = {
    git: { path: 'git' }, repositories,
    onDidOpenRepository: opened.event, onDidCloseRepository: closed.event,
  };
  let view;
  const decorationProviders = [];
  let pick = () => undefined;
  const vscode = {
    Disposable, EventEmitter, Uri,
    TreeItem: class { constructor(label, state) { this.label = label; this.collapsibleState = state; } },
    TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
    StatusBarAlignment: { Left: 1, Right: 2 },
    ThemeIcon: class { static File = { id: 'file' }; constructor(id) { this.id = id; } },
    ThemeColor: class { constructor(id) { this.id = id; } },
    FileType: { File: 1 },
    FileChangeType: { Changed: 1, Created: 2, Deleted: 3 },
    FileSystemError: {
      Unavailable: (message) => new Error(message),
      NoPermissions: (message) => new Error(message),
      FileNotADirectory: () => new Error('Not a directory'),
    },
    extensions: {
      getExtension: () => ({ activate: async () => ({ enabled: true, getAPI: () => api }) }),
    },
    workspace: {
      fs: { stat: async (uri) => fs.promises.stat(uri.fsPath), readFile: async (uri) => fs.promises.readFile(uri.fsPath) },
      textDocuments,
      onDidChangeTextDocument: textChanged.event,
      onDidOpenTextDocument: textOpened.event,
      onDidCloseTextDocument: textClosed.event,
      getConfiguration: () => ({ get: (_name, fallback) => options.defaultBranch ?? fallback }),
      onDidChangeConfiguration: new EventEmitter().event,
      registerFileSystemProvider: (scheme, provider, settings) => {
        providers.set(scheme, { provider, settings });
        return new Disposable(() => providers.delete(scheme));
      },
    },
    window: {
      createOutputChannel: () => ({ appendLine: () => {}, dispose: () => {} }),
      createStatusBarItem: (id, alignment, priority) => {
        const item = {
          id, alignment, priority, visible: false, disposed: false,
          show() { this.visible = true; },
          hide() { this.visible = false; },
          dispose() { this.disposed = true; this.visible = false; },
        };
        statusBarItems.push(item);
        return item;
      },
      createTreeView: (_id, { treeDataProvider }) => {
        const visibilityChanged = new EventEmitter();
        view = {
          provider: treeDataProvider, visible: false, onDidChangeVisibility: visibilityChanged.event,
          setVisible(visible) { this.visible = visible; visibilityChanged.fire({ visible }); },
          dispose: () => {},
        };
        return view;
      },
      registerFileDecorationProvider: (provider) => {
        decorationProviders.push(provider);
        return new Disposable(() => decorationProviders.splice(decorationProviders.indexOf(provider), 1));
      },
      showQuickPick: async (choices) => pick(choices),
      showInformationMessage: async (message) => calls.push(['information', message]),
      showErrorMessage: async (message) => errors.push(message),
    },
    commands: {
      registerCommand: (name, command) => {
        commands.set(name, command);
        return new Disposable(() => commands.delete(name));
      },
      executeCommand: async (name, ...args) => {
        if (commands.has(name)) { return commands.get(name)(...args); }
        if (name === 'setContext') { contexts.set(args[0], args[1]); }
        calls.push([name, ...args]);
      },
    },
    scm: {
      createSourceControl: (id, label, rootUri) => {
        const sourceControl = {
          id, label, rootUri, inputBox: {}, disposed: false,
          dispose() { this.disposed = true; },
        };
        sourceControls.push(sourceControl);
        return sourceControl;
      },
    },
  };
  const context = {
    subscriptions: [],
    workspaceState: {
      get: (key) => state.get(key),
      update: async (key, value) => { state.set(key, value); },
    },
  };
  const { activate } = loadWithVscode(require.resolve('../dist/extension'), vscode);
  await activate(context);
  t.after(() => context.subscriptions.forEach((item) => item.dispose()));
  if (options.refresh !== false) {
    await commands.get('branchDiff.refresh')();
  }
  return {
    view, api, opened, closed, commands, providers, calls, errors, state, contexts,
    decorations: decorationProviders[0], explorerDecorations: decorationProviders[1], decorationProviders,
    sourceControls, statusBarItems,
    textDocuments, textChanged, textOpened, textClosed,
    marker: () => sourceControls.findLast((control) => !control.disposed),
    select: (fn) => { pick = fn; },
    sections: () => view.provider.getChildren(),
    children: (item) => view.provider.getChildren(item),
    items: () => view.provider.getChildren().flatMap((item) => {
      const children = view.provider.getChildren(item);
      return children.length ? children : [item];
    }),
    run: (command, ...args) => vscode.commands.executeCommand(`branchDiff.${command}`, ...args),
  };
}

function nextRefresh(h, action) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { subscription.dispose(); reject(new Error('View did not refresh')); }, 5000);
    const subscription = h.view.provider.onDidChangeTreeData(() => {
      clearTimeout(timeout);
      subscription.dispose();
      resolve();
    });
    action();
  });
}

test('shows guidance when no repository is open', async (t) => {
  const h = await harness(t);
  assert.deepEqual(h.items(), []);
  assert.match(h.view.message, /Open a folder/);
  await h.run('selectBranch');
  assert.equal(h.calls.at(-1)[0], 'information');
  assert.deepEqual(h.errors, []);
  assert.equal(h.marker(), undefined);
});

test('shows native-style status decorations scoped to the branch view', async (t) => {
  const repo = fixture(t);
  repo.write('modified.txt', 'before\n');
  repo.write('deleted.txt', 'deleted\n');
  repo.commit('base');
  repo.git('checkout', '-b', 'feature');
  repo.write('modified.txt', 'after\n');
  repo.write('nested/added.txt', 'new\n');
  repo.git('rm', 'deleted.txt');
  repo.commit('feature');
  const h = await harness(t, [repository(repo)]);

  assert.equal(h.view.description, 'main → feature');
  assert.equal(h.view.badge.value, 3);
  assert.deepEqual(h.sections().map((section) => section.label), ['Committed changes (3)']);
  assert.equal(h.sections()[0].collapsibleState, 2);
  assert.equal(h.sections()[0].command, undefined);
  assert.deepEqual(h.children(h.items()[0]), []);
  assert.deepEqual(h.items().map((item) => item.label), ['deleted.txt', 'modified.txt', 'added.txt']);
  assert.equal(h.items()[2].description, 'nested');
  for (const item of h.items()) {
    assert.equal(item.command.command, 'branchDiff.openFile');
    assert.equal(item.contextValue, 'branchDiff.change');
    const decoration = h.decorations.provideFileDecoration(item.resourceUri);
    assert.equal(decoration.badge, item.change.status);
    assert.match(decoration.color.id, /^gitDecoration\./);
  }
  assert.equal(h.decorations.provideFileDecoration(Uri.file(path.join(repo.root, 'modified.txt'))), undefined);
});

test('opens working files, deleted snapshots, and committed diffs including empty sides', async (t) => {
  const repo = fixture(t);
  repo.write('modified.txt', 'before\n');
  repo.write('deleted.txt', 'deleted\n');
  const base = repo.commit('base');
  repo.git('checkout', '-b', 'feature');
  repo.write('modified.txt', 'after\n');
  repo.write('added.txt', 'new\n');
  repo.git('rm', 'deleted.txt');
  const head = repo.commit('feature');
  const h = await harness(t, [repository(repo)]);
  const files = Object.fromEntries(h.items().map((item) => [item.change.status, item]));
  const snapshots = h.providers.get('branch-diff-snapshot');
  assert.equal(snapshots.settings.isReadonly, true);

  await h.run('openFile', files.M);
  assert.equal(h.calls.at(-1)[0], 'vscode.open');
  assert.equal(h.calls.at(-1)[1].fsPath, path.join(repo.root, 'modified.txt'));

  await h.run('openFile', files.D);
  const deleted = h.calls.at(-1)[1];
  assert.equal(deleted.scheme, 'branch-diff-snapshot');
  assert.equal(JSON.parse(deleted.query).commit, base);
  assert.equal(Buffer.from(await snapshots.provider.readFile(deleted)).toString(), 'deleted\n');
  assert.throws(() => snapshots.provider.writeFile(deleted, new Uint8Array()), /read-only/);

  for (const status of ['A', 'M', 'D']) {
    await h.run('openDiff', files[status]);
    const [command, left, right, title] = h.calls.at(-1);
    assert.equal(command, 'vscode.diff');
    assert.match(title, /main ↔ feature/);
    assert.equal(JSON.parse(left.query).commit, base);
    assert.equal(JSON.parse(right.query).commit, head);
    const oldContent = Buffer.from(await snapshots.provider.readFile(left)).toString();
    const newContent = Buffer.from(await snapshots.provider.readFile(right)).toString();
    assert.equal(oldContent, status === 'A' ? '' : status === 'M' ? 'before\n' : 'deleted\n');
    assert.equal(newContent, status === 'D' ? '' : status === 'M' ? 'after\n' : 'new\n');
  }
  assert.deepEqual(h.errors, []);
});

function explorerDecoration(h, repo, filePath) {
  return h.explorerDecorations.provideFileDecoration(Uri.file(path.join(repo.root, filePath)));
}

test('decorates committed branch files with status badges and native parent-folder propagation', async (t) => {
  const repo = fixture(t);
  repo.write('modified.txt', 'before\n');
  repo.write('unchanged.txt', 'unchanged\n');
  repo.write('staged.txt', 'before\n');
  repo.write('old name.txt', 'content retained across rename\n');
  repo.write('binary.bin', Buffer.from([0, 255, 10]));
  repo.commit('base');
  repo.git('checkout', '-b', 'feature');
  repo.write('modified.txt', 'after\n');
  repo.write('nested/[new] ü.txt', 'added\n');
  repo.write('binary.bin', Buffer.from([0, 254, 10]));
  repo.git('mv', 'old name.txt', 'new name.txt');
  repo.commit('feature');
  repo.write('unchanged.txt', 'local only\n');
  repo.write('staged.txt', 'staged only\n');
  repo.git('add', 'staged.txt');
  repo.write('untracked.txt', 'untracked\n');
  const h = await harness(t, [repository(repo)]);
  for (const [file, color] of [
    ['modified.txt', 'gitDecoration.modifiedResourceForeground'],
    ['nested/[new] ü.txt', 'gitDecoration.addedResourceForeground'],
    ['new name.txt', 'gitDecoration.renamedResourceForeground'],
    ['binary.bin', 'gitDecoration.modifiedResourceForeground'],
  ]) {
    const decoration = explorerDecoration(h, repo, file);
    assert.equal(decoration.color.id, color, file);
    const item = h.children(h.sections()[0]).find((item) => item.change?.path === file);
    assert.equal(decoration.color.id, h.decorations.provideFileDecoration(item.resourceUri).color.id);
    assert.equal(decoration.badge, item.change.status, 'Changed files show their Git-style status letter');
    assert.equal(decoration.propagate, true, 'VS Code propagates decorations to parent folders like native Git');
  }
  // Parent folders inherit through VS Code, not through explicit file status decorations.
  for (const file of ['unchanged.txt', 'staged.txt', 'untracked.txt', 'old name.txt', 'nested', '.git/config', '../outside.txt']) {
    assert.equal(explorerDecoration(h, repo, file), undefined, file);
  }
  for (const scheme of ['branch-diff-status', 'branch-diff-snapshot', 'git', 'untitled']) {
    assert.equal(h.explorerDecorations.provideFileDecoration(Uri.from({ scheme, path: path.join(repo.root, 'modified.txt') })), undefined);
  }
  assert.equal(h.decorations.provideFileDecoration(h.items().find((item) => item.change?.path === 'modified.txt').resourceUri).badge, 'M');
});

test('matches every committed status badge and color and invalidates decorations when a status changes at the same path', async (t) => {
  const repo = fixture(t);
  const h = await harness(t);
  const colors = {
    A: 'gitDecoration.addedResourceForeground',
    M: 'gitDecoration.modifiedResourceForeground',
    D: 'gitDecoration.deletedResourceForeground',
    R: 'gitDecoration.renamedResourceForeground',
    C: 'gitDecoration.addedResourceForeground',
    T: 'gitDecoration.modifiedResourceForeground',
  };
  const baseline = {
    root: Uri.file(repo.root), baseName: 'main', repositoryRoots: [],
    changes: Object.keys(colors).map((status) => ({ status, path: `${status}.txt` })),
  };
  h.explorerDecorations.update(baseline);
  for (const [status, color] of Object.entries(colors)) {
    const decoration = explorerDecoration(h, repo, `${status}.txt`);
    const sidebar = h.decorations.provideFileDecoration(Uri.from({ scheme: 'branch-diff-status', path: `/${status}.txt`, query: status }));
    assert.equal(decoration.color.id, color, status);
    assert.equal(decoration.color.id, sidebar.color.id, status);
    assert.equal(decoration.badge, status);
    assert.equal(decoration.propagate, status !== 'D', 'Deletion decorations stay on the file, like native Git');
    assert.match(decoration.tooltip, new RegExp(`^${sidebar.tooltip} between`));
  }
  const events = [];
  h.explorerDecorations.onDidChangeFileDecorations(() => events.push(true));
  h.explorerDecorations.update({
    ...baseline, changes: baseline.changes.map((change) => change.path === 'A.txt' ? { ...change, status: 'M' } : change),
  });
  assert.equal(explorerDecoration(h, repo, 'A.txt').color.id, colors.M);
  assert.equal(explorerDecoration(h, repo, 'A.txt').badge, 'M');
  assert.deepEqual(events, [true], 'Changing only the status still invalidates cached decorations');
});

test('stops propagating folder decorations when a modified branch file becomes deleted', async (t) => {
  const repo = fixture(t);
  const h = await harness(t);
  const baseline = {
    root: Uri.file(repo.root), baseName: 'main', repositoryRoots: [],
    changes: [{ status: 'M', path: 'parent/child/file.txt' }],
  };
  h.explorerDecorations.update(baseline);
  assert.equal(explorerDecoration(h, repo, 'parent/child/file.txt').propagate, true);
  const events = [];
  h.explorerDecorations.onDidChangeFileDecorations((uris) => events.push(uris.map((uri) => uri.fsPath)));
  h.explorerDecorations.update({ ...baseline, changes: [{ status: 'D', path: 'parent/child/file.txt' }] });
  const decoration = explorerDecoration(h, repo, 'parent/child/file.txt');
  assert.equal(decoration.propagate, false, 'Deleted files must not color or badge their ancestors');
  assert.equal(decoration.badge, 'D');
  assert.equal(decoration.color.id, 'gitDecoration.deletedResourceForeground');
  assert.deepEqual(events, [[path.join(repo.root, 'parent/child/file.txt')]],
    'The status change invalidates previously propagated folder decorations');
});

test('ties Explorer colors, badges, and propagation to the remembered marker toggle while leaving sidebar badges unchanged', async (t) => {
  const repo = fixture(t);
  repo.write('file.txt', 'before\n'); repo.commit('base');
  repo.git('checkout', '-b', 'feature');
  repo.write('file.txt', 'after\n'); repo.commit('feature');
  const h = await harness(t, [repository(repo)], { state: { markersEnabled: false } });
  const events = [];
  h.explorerDecorations.onDidChangeFileDecorations((uris) => events.push(uris));
  assert.equal(explorerDecoration(h, repo, 'file.txt'), undefined);
  await h.run('refresh');
  assert.equal(events.length, 0, 'Refreshing while disabled does not repaint decorations');
  for (const [command, enabled] of [['enableMarkers', true], ['toggleMarkers', false], ['toggleMarkers', true], ['disableMarkers', false]]) {
    await h.run(command);
    assert.equal(!!explorerDecoration(h, repo, 'file.txt'), enabled, command);
    if (enabled) {
      assert.equal(explorerDecoration(h, repo, 'file.txt').badge, 'M');
      assert.equal(explorerDecoration(h, repo, 'file.txt').propagate, true);
    }
    assert.equal(h.decorations.provideFileDecoration(h.items()[0].resourceUri).badge, 'M');
  }
  assert.deepEqual(events.map((uris) => uris.map((uri) => uri.fsPath)),
    Array.from({ length: 4 }, () => [path.join(repo.root, 'file.txt')]),
    'Each state change explicitly refreshes file decorations, including inherited folder decorations');
  await h.run('disableMarkers');
  assert.equal(events.length, 4, 'Idempotent marker commands do not repaint decorations');
  assert.equal(h.decorationProviders.length, 2, 'Toggling reuses the registered provider');
});

test('notifies explicit added and removed file URIs so unopened parent folders update', async (t) => {
  const repo = fixture(t);
  const h = await harness(t);
  const events = [];
  h.explorerDecorations.onDidChangeFileDecorations((uris) => events.push(uris.map((uri) => path.relative(repo.root, uri.fsPath))));
  const first = path.join('parent', 'child', 'first.txt');
  const second = path.join('other', 'second.txt');
  const baseline = {
    root: Uri.file(repo.root), baseName: 'main', repositoryRoots: [],
    changes: [{ status: 'M', path: 'parent/child/first.txt' }],
  };
  h.explorerDecorations.update(baseline);
  assert.deepEqual(events, [[first]], 'New files are notified without requesting their decoration first');
  h.explorerDecorations.update({ ...baseline, changes: [{ status: 'A', path: 'other/second.txt' }] });
  assert.deepEqual(events.at(-1), [first, second], 'Removed and newly changed paths both update their ancestors');
  h.explorerDecorations.update(undefined);
  assert.deepEqual(events.at(-1), [second], 'Clearing the comparison removes remaining propagated decorations');
});

test('refreshes Explorer coloring on commits, comparison ref updates, and missing branches', async (t) => {
  const repo = fixture(t);
  repo.write('file.txt', 'before\n'); repo.commit('base');
  repo.git('checkout', '-b', 'feature');
  const tracked = repository(repo);
  const h = await harness(t, [tracked]);
  const events = [];
  h.explorerDecorations.onDidChangeFileDecorations(() => events.push(true));
  repo.write('file.txt', 'after\n');
  const head = repo.commit('feature');
  await nextRefresh(h, () => tracked.changed.fire());
  assert.ok(explorerDecoration(h, repo, 'file.txt'));
  assert.equal(events.length, 1);
  await h.run('refresh');
  assert.equal(events.length, 1, 'Unchanged comparisons do not repaint decorations');
  repo.git('update-ref', 'refs/heads/main', head);
  await h.run('refresh');
  assert.equal(explorerDecoration(h, repo, 'file.txt'), undefined);
  repo.write('another.txt', 'new\n'); repo.commit('another');
  await h.run('refresh');
  assert.ok(explorerDecoration(h, repo, 'another.txt'));
  repo.git('branch', '-D', 'main');
  await h.run('refresh');
  assert.equal(explorerDecoration(h, repo, 'another.txt'), undefined);
  h.select((choices) => choices.find((choice) => choice.branch.name === 'feature'));
  await h.run('selectBranch');
  assert.equal(explorerDecoration(h, repo, 'another.txt'), undefined);
});

test('scopes Explorer coloring to the selected repository and excludes nested repository roots and files', async (t) => {
  const one = fixture(t);
  const two = fixture(t);
  for (const repo of [one, two]) {
    repo.write('own.txt', 'before\n'); repo.commit('base');
    repo.git('checkout', '-b', 'feature');
    repo.write('own.txt', 'after\n');
    repo.write('nested/file.txt', 'nested\n');
    repo.write('nested-sibling/file.txt', 'own\n');
    repo.write('nested-root', 'covered by a nested repository root\n');
    repo.commit('feature');
  }
  const first = repository(one);
  const second = repository(two);
  const nested = ['nested', 'nested-root'].map((name) => ({
    rootUri: Uri.file(path.join(one.root, name)), state: { HEAD: undefined, onDidChange: new EventEmitter().event },
  }));
  const h = await harness(t, [first, second, ...nested]);
  assert.ok(explorerDecoration(h, one, 'own.txt'));
  assert.ok(explorerDecoration(h, one, 'nested-sibling/file.txt'));
  assert.equal(explorerDecoration(h, one, 'nested/file.txt'), undefined);
  assert.equal(explorerDecoration(h, one, 'nested-root'), undefined);
  assert.equal(explorerDecoration(h, two, 'own.txt'), undefined);
  await nextRefresh(h, () => {
    h.api.repositories = [first, second];
    h.closed.fire(nested[0]);
  });
  assert.ok(explorerDecoration(h, one, 'nested/file.txt'), 'Closing a nested repository updates exclusions');
  h.select((choices) => choices.find((choice) => choice.repository === second));
  await h.run('selectRepository');
  assert.equal(explorerDecoration(h, one, 'own.txt'), undefined);
  assert.ok(explorerDecoration(h, two, 'own.txt'));
  await nextRefresh(h, () => { h.api.repositories = []; h.closed.fire(second); });
  assert.equal(explorerDecoration(h, two, 'own.txt'), undefined);
});

test('clears old Explorer coloring while switching branches and discards stale comparison results', async (t) => {
  const repo = fixture(t);
  repo.write('file.txt', 'before\n'); repo.commit('base');
  repo.git('checkout', '-b', 'feature');
  repo.write('file.txt', 'after\n'); repo.commit('feature');
  const h = await harness(t, [repository(repo)]);
  const { Git } = require('../dist/git');
  const compare = Git.prototype.compare;
  let release;
  let started;
  const gate = new Promise((resolve) => { release = resolve; });
  const queried = new Promise((resolve) => { started = resolve; });
  t.after(() => release());
  t.mock.method(Git.prototype, 'compare', async function (root, base) {
    const comparison = await compare.call(this, root, base);
    if (base === 'refs/heads/feature') {
      started();
      await gate;
    }
    return comparison;
  });
  h.select((choices) => choices.find((choice) => choice.branch.name === 'feature'));
  const pending = h.run('selectBranch');
  await queried;
  assert.equal(explorerDecoration(h, repo, 'file.txt'), undefined, 'Old comparison coloring clears before the new query completes');
  h.select((choices) => choices.find((choice) => choice.branch.name === 'main'));
  await h.run('selectBranch');
  assert.ok(explorerDecoration(h, repo, 'file.txt'));
  await h.run('disableMarkers');
  release();
  await pending;
  assert.equal(explorerDecoration(h, repo, 'file.txt'), undefined, 'Pending refreshes cannot re-enable coloring');
  await h.run('enableMarkers');
  assert.ok(explorerDecoration(h, repo, 'file.txt'), 'Stale branch results cannot overwrite the selected comparison');
});

test('uses a HEAD snapshot when a committed file is missing from the working tree', async (t) => {
  const repo = fixture(t);
  repo.write('file.txt', 'before\n');
  repo.commit('base');
  repo.git('checkout', '-b', 'feature');
  repo.write('file.txt', 'after\n');
  const head = repo.commit('feature');
  fs.unlinkSync(path.join(repo.root, 'file.txt'));
  const h = await harness(t, [repository(repo)]);
  await h.run('openFile', h.items()[0]);
  const snapshot = h.calls.at(-1)[1];
  assert.equal(snapshot.scheme, 'branch-diff-snapshot');
  assert.equal(JSON.parse(snapshot.query).commit, head);
  assert.deepEqual(h.errors, []);
});

test('offers a branch picker when the default branch is missing and remembers the selection', async (t) => {
  const repo = fixture(t);
  repo.write('file.txt', 'before\n');
  repo.commit('base');
  repo.git('checkout', '-b', 'feature');
  const h = await harness(t, [repository(repo)], { defaultBranch: 'missing-main' });
  assert.match(h.items()[0].label, /not found/);
  assert.equal(h.items()[0].command.command, 'branchDiff.selectBranch');
  h.select((choices) => choices.find((choice) => choice.branch.name === 'main'));
  await h.run('selectBranch');
  assert.equal(h.state.get(`baseBranch:${Uri.file(repo.root).toString()}`), 'refs/heads/main');
  assert.equal(h.view.description, 'main → feature');
  assert.match(h.items()[0].label, /No committed differences/);
  assert.deepEqual(h.errors, []);
});

test('supports selecting repositories and updates as repositories close', async (t) => {
  const one = fixture(t);
  const two = fixture(t);
  one.write('one.txt', 'one'); one.commit('one');
  two.write('two.txt', 'two'); two.commit('two');
  const first = repository(one);
  const second = repository(two);
  const h = await harness(t, [first, second]);
  const firstMarker = h.marker();
  assert.ok(h.calls.some(([command, key, value]) => command === 'setContext' && key === 'branchDiff.repositoryCount' && value === 2));
  h.select((choices) => choices.find((choice) => choice.repository === second));
  await h.run('selectRepository');
  assert.equal(h.state.get('selectedRepository'), second.rootUri.toString());
  assert.equal(h.view.message, path.basename(two.root));
  assert.equal(firstMarker.disposed, true);
  assert.equal(h.marker().rootUri.toString(), second.rootUri.toString());
  await nextRefresh(h, () => {
    h.api.repositories = [first];
    h.closed.fire(second);
  });
  assert.equal(h.view.message, undefined);
  assert.equal(h.marker().rootUri.toString(), first.rootUri.toString());
  assert.deepEqual(h.errors, []);
});

function original(h, repo, filePath, token = { isCancellationRequested: false }) {
  return h.marker().quickDiffProvider.provideOriginalResource(Uri.file(path.join(repo.root, filePath)), token);
}

test('registers an additional read-only native quick-diff provider without inflating the SCM count', async (t) => {
  const repo = fixture(t);
  repo.write('file.txt', 'base\n');
  const base = repo.commit('base');
  repo.git('checkout', '-b', 'feature');
  repo.write('file.txt', 'feature\n');
  repo.commit('feature');
  const h = await harness(t, [repository(repo)]);
  const marker = h.marker();
  assert.equal(marker.id, 'branchDiff');
  assert.equal(marker.label, 'Branch Diff (main)');
  assert.equal(marker.rootUri.fsPath, repo.root);
  assert.equal(marker.inputBox.visible, false);
  assert.equal(marker.count, 0);
  const uri = await original(h, repo, 'file.txt');
  assert.equal(JSON.parse(uri.query).commit, base);
  const content = await h.providers.get('branch-diff-snapshot').provider.readFile(uri);
  assert.equal(Buffer.from(content).toString(), 'base\n');
});

test('uses empty baselines for added files and the original path for renames', async (t) => {
  const repo = fixture(t);
  repo.write('old name.txt', 'content to retain across the rename\n');
  repo.commit('base');
  repo.git('checkout', '-b', 'feature');
  repo.git('mv', 'old name.txt', 'new name.txt');
  repo.write('added.txt', 'added\n');
  repo.commit('feature');
  const h = await harness(t, [repository(repo)]);
  assert.equal(JSON.parse((await original(h, repo, 'added.txt')).query).empty, true);
  const renamed = JSON.parse((await original(h, repo, 'new name.txt')).query);
  assert.equal(renamed.path, 'old name.txt');
  assert.equal(renamed.empty, false);
});

test('synthesizes native marker baselines without changing historical sidebar snapshots', async (t) => {
  const repo = fixture(t);
  repo.write('file.txt', 'first\nbefore\nlast\n');
  repo.commit('base');
  repo.git('checkout', '-b', 'feature');
  repo.write('file.txt', 'first\nafter\nlast\n');
  repo.commit('feature');
  repo.write('file.txt', 'first\nafter\nlocal addition\nlast\n');
  const h = await harness(t, [repository(repo)]);
  const marker = h.marker();
  const uri = await original(h, repo, 'file.txt');
  const snapshots = h.providers.get(uri.scheme).provider;
  const read = async () => Buffer.from(await snapshots.readFile(uri)).toString();
  assert.equal(await read(), 'first\nbefore\nlocal addition\nlast\n');

  await h.run('openDiff', h.children(h.sections()[0])[0]);
  const [, historical, head] = h.calls.at(-1);
  assert.equal(Buffer.from(await snapshots.readFile(historical)).toString(), 'first\nbefore\nlast\n');
  assert.equal(Buffer.from(await snapshots.readFile(head)).toString(), 'first\nafter\nlast\n');

  const events = [];
  snapshots.onDidChangeFile((changes) => events.push(...changes));
  const mtime = (await snapshots.stat(uri)).mtime;
  let text = 'first\nafter\nunsaved addition\nlast\n';
  const document = { uri: Uri.file(path.join(repo.root, 'file.txt')), getText: () => text };
  h.textDocuments.push(document);
  h.textOpened.fire(document);
  h.textChanged.fire({ document });
  assert.ok(events.some((event) => event.uri.toString() === uri.toString()));
  assert.ok(events.every((event) => event.uri.toString() !== historical.toString()));
  assert.ok((await snapshots.stat(uri)).mtime > mtime);
  assert.equal(await read(), 'first\nbefore\nunsaved addition\nlast\n');

  text = 'first\nafter\nlast\n';
  h.textChanged.fire({ document });
  assert.equal(await read(), 'first\nbefore\nlast\n', 'Undo restores the unadjusted baseline');
  h.textDocuments.pop();
  h.textClosed.fire(document);
  assert.equal(await read(), 'first\nbefore\nlocal addition\nlast\n', 'Closing reloads saved disk contents');

  repo.git('add', 'file.txt');
  await h.run('refresh');
  assert.equal(h.marker(), marker, 'Staging does not recreate the provider');
  assert.equal(await read(), 'first\nbefore\nlast\n', 'Staged additions become branch markers again');
  repo.git('reset', '--', 'file.txt');
  await h.run('refresh');
  assert.equal(await read(), 'first\nbefore\nlocal addition\nlast\n');
});

test('synthesizes renamed and added files using their current index paths', async (t) => {
  const repo = fixture(t);
  repo.write('old.txt', 'first\nbefore\nlast\n');
  repo.commit('base');
  repo.git('checkout', '-b', 'feature');
  repo.git('mv', 'old.txt', 'new.txt');
  repo.write('new.txt', 'first\nafter\nlast\n');
  repo.write('added.txt', 'committed addition\n');
  repo.commit('feature');
  repo.write('new.txt', 'first\nafter\nlocal\nlast\n');
  repo.write('added.txt', 'committed addition\nlocal\n');
  const h = await harness(t, [repository(repo)]);
  const snapshots = h.providers.get('branch-diff-snapshot').provider;
  const renamed = await original(h, repo, 'new.txt');
  assert.equal(JSON.parse(renamed.query).path, 'old.txt');
  assert.equal(JSON.parse(renamed.query).markerPath, 'new.txt');
  assert.equal(Buffer.from(await snapshots.readFile(renamed)).toString(), 'first\nbefore\nlocal\nlast\n');
  assert.equal(Buffer.from(await snapshots.readFile(await original(h, repo, 'added.txt'))).toString(), 'local\n');
});

test('retains branch additions when appending saved and unsaved lines to an unterminated new file (case 9)', async (t) => {
  const repo = fixture(t);
  repo.write('existing.txt', 'base\n');
  const base = repo.commit('base');
  repo.git('checkout', '-b', 'feature');
  repo.write('added.txt', 'committed addition');
  repo.commit('feature');
  const h = await harness(t, [repository(repo)]);
  const uri = await original(h, repo, 'added.txt');
  const snapshots = h.providers.get(uri.scheme).provider;
  const read = async () => Buffer.from(await snapshots.readFile(uri)).toString();
  assert.equal(await read(), '');

  const document = { uri: Uri.file(path.join(repo.root, 'added.txt')), getText: () => 'committed addition\nlocal addition' };
  h.textDocuments.push(document);
  h.textChanged.fire({ document });
  assert.equal(await read(), 'local addition', 'Only the local line enters the synthetic baseline');
  repo.write('added.txt', document.getText());
  h.textDocuments.pop();
  h.textClosed.fire(document);
  await h.run('refresh');
  assert.equal(await read(), 'local addition', 'Saving keeps the committed addition separate');

  repo.git('add', 'added.txt');
  await h.run('refresh');
  assert.equal(await read(), '', 'Staging makes both lines branch additions');
  await h.run('openDiff', h.children(h.sections()[0]).find((item) => item.change.path === 'added.txt'));
  const [, historical] = h.calls.at(-1);
  assert.equal(JSON.parse(historical.query).commit, base);
  assert.equal((await snapshots.readFile(historical)).byteLength, 0,
    'The historical empty snapshot stays exact');
});

test('leaves untracked files to native Git and preserves raw binary marker baselines', async (t) => {
  const repo = fixture(t);
  const bytes = Buffer.from([0, 255, 128, 10, 42]);
  repo.write('binary.bin', bytes);
  repo.commit('base');
  repo.write('binary.bin', Buffer.from([0, 1, 2, 3]));
  repo.write('[untracked].txt', 'local only\n');
  const h = await harness(t, [repository(repo)]);
  const snapshots = h.providers.get('branch-diff-snapshot').provider;
  assert.equal(Buffer.from(await snapshots.readFile(await original(h, repo, '[untracked].txt'))).toString(), 'local only\n');
  assert.deepEqual(Buffer.from(await snapshots.readFile(await original(h, repo, 'binary.bin'))), bytes);
});

test('caches marker Git inputs across typing but invalidates in-flight inputs on repository refresh', async (t) => {
  const repo = fixture(t);
  repo.write('file.txt', 'before\nlast\n');
  repo.commit('base');
  repo.git('checkout', '-b', 'feature');
  repo.write('file.txt', 'after\nlast\n');
  repo.commit('feature');
  repo.write('file.txt', 'after\nlocal\nlast\n');
  const h = await harness(t, [repository(repo)]);
  const uri = await original(h, repo, 'file.txt');
  const snapshots = h.providers.get(uri.scheme).provider;
  const { Git } = require('../dist/git');
  const readIndexBaseline = Git.prototype.readIndexBaseline;
  let release;
  let started;
  const gate = new Promise((resolve) => { release = resolve; });
  const queried = new Promise((resolve) => { started = resolve; });
  t.after(() => release());
  let queries = 0;
  t.mock.method(Git.prototype, 'readIndexBaseline', async function (...args) {
    const bytes = await readIndexBaseline.apply(this, args);
    if (++queries === 1) {
      started();
      await gate;
    }
    return bytes;
  });
  const pending = snapshots.readFile(uri);
  await queried;
  repo.git('add', 'file.txt');
  await h.run('refresh');
  release();
  assert.equal(Buffer.from(await pending).toString(), 'before\nlast\n', 'A stale index read cannot restore the old synthetic baseline');
  assert.equal(queries, 2);

  let text = 'after\nlocal\nunsaved\nlast\n';
  const document = { uri: Uri.file(path.join(repo.root, 'file.txt')), getText: () => text };
  h.textDocuments.push(document);
  h.textChanged.fire({ document });
  assert.equal(Buffer.from(await snapshots.readFile(uri)).toString(), 'before\nunsaved\nlast\n');
  text = 'after\nlocal\nmore unsaved\nlast\n';
  h.textChanged.fire({ document });
  assert.equal(Buffer.from(await snapshots.readFile(uri)).toString(), 'before\nmore unsaved\nlast\n');
  assert.equal(queries, 2, 'Typing reuses the cached raw index and branch contents');
});

test('supports local edits in otherwise unchanged files without changing the committed sidebar', async (t) => {
  const repo = fixture(t);
  repo.write('file.txt', 'base\n');
  const base = repo.commit('base');
  const h = await harness(t, [repository(repo)]);
  const marker = h.marker();
  repo.write('file.txt', 'local edits\n');
  repo.write('untracked.txt', 'new\n');
  await h.run('refresh');
  assert.equal(h.marker(), marker, 'Local edits do not churn the native provider');
  assert.equal(JSON.parse((await original(h, repo, 'file.txt')).query).commit, base);
  assert.equal(JSON.parse((await original(h, repo, 'untracked.txt')).query).empty, true);
  assert.match(h.items()[0].label, /No committed differences/);
  assert.deepEqual(h.sections().map((section) => section.label), ['Committed changes (0)', 'Unstaged changes (2)']);
  assert.deepEqual(h.children(h.sections()[1]).map((item) => item.change.status), ['M', 'U']);
});

test('groups unstaged files separately with native badges and stable section identities', async (t) => {
  const repo = fixture(t);
  repo.write('file.txt', 'before\n');
  repo.commit('base');
  repo.git('checkout', '-b', 'feature');
  repo.write('file.txt', 'after\n');
  repo.commit('feature');
  repo.write('nested/new file.txt', 'new\n');
  repo.write('[literal].txt', 'literal\n');
  const h = await harness(t, [repository(repo)]);
  const [committed, untracked] = h.sections();
  assert.deepEqual(h.sections().map((section) => section.label), ['Committed changes (1)', 'Unstaged changes (2)']);
  assert.equal(untracked.collapsibleState, 2);
  assert.equal(untracked.command, undefined);
  assert.equal(h.view.badge.value, 3);
  assert.equal(h.view.badge.tooltip, '1 committed changes, 2 unstaged changes');
  assert.deepEqual(h.children(committed).map((item) => item.change.status), ['M']);
  assert.deepEqual(h.children(untracked).map((item) => item.change.path), ['[literal].txt', 'nested/new file.txt']);
  for (const item of h.children(untracked)) {
    assert.equal(item.change.status, 'U');
    assert.equal(item.contextValue, 'branchDiff.change');
    assert.equal(item.command.command, 'branchDiff.openFile');
    assert.match(item.tooltip, /Index → Working tree \(unstaged\)/);
    assert.deepEqual(h.children(item), []);
    const decoration = h.decorations.provideFileDecoration(item.resourceUri);
    assert.equal(decoration.badge, 'U');
    assert.equal(decoration.tooltip, 'Untracked');
    assert.equal(decoration.color.id, 'gitDecoration.untrackedResourceForeground');
  }
  assert.equal(h.children(untracked)[1].description, 'nested');
  repo.write('another.txt', 'another\n');
  await h.run('refresh');
  assert.deepEqual(h.sections().map((section) => section.id), [committed.id, untracked.id]);
});

test('opens untracked working files and diffs them against an empty byte-preserving side', async (t) => {
  const repo = fixture(t);
  repo.write('file.txt', 'base\n');
  repo.commit('base');
  const bytes = Buffer.from([0, 255, 128, 10, 13, 42]);
  repo.write('new image.bin', bytes);
  const h = await harness(t, [repository(repo)]);
  const item = h.children(h.sections()[1])[0];
  await h.run('openFile', item);
  assert.equal(h.calls.at(-1)[0], 'vscode.open');
  assert.equal(h.calls.at(-1)[1].fsPath, path.join(repo.root, 'new image.bin'));
  await h.run('openDiff', item);
  const [command, left, right, title] = h.calls.at(-1);
  assert.equal(command, 'vscode.diff');
  assert.equal(title, 'new image.bin (Unstaged)');
  assert.equal(left.scheme, 'branch-diff-snapshot');
  assert.equal(JSON.parse(left.query).empty, true);
  assert.equal((await h.providers.get(left.scheme).provider.readFile(left)).byteLength, 0);
  assert.equal(right.scheme, 'file');
  assert.deepEqual(await fs.promises.readFile(right.fsPath), bytes);
  repo.write('new image.bin', 'updated after listing\n');
  await h.run('openDiff', item);
  assert.equal(await fs.promises.readFile(h.calls.at(-1)[2].fsPath, 'utf8'), 'updated after listing\n');
  assert.deepEqual(h.errors, []);
});

test('shows tracked unstaged edits separately and uses the index rather than HEAD for local diffs', async (t) => {
  const repo = fixture(t);
  repo.write('file.txt', 'base\n');
  repo.write('staged-only.txt', 'base\n');
  repo.commit('base');
  repo.git('checkout', '-b', 'feature');
  repo.write('file.txt', 'committed\n');
  const head = repo.commit('feature');
  repo.write('file.txt', 'staged\n');
  repo.write('staged-only.txt', 'staged only\n');
  repo.git('add', 'file.txt', 'staged-only.txt');
  repo.write('file.txt', 'staged plus unstaged\n');
  const h = await harness(t, [repository(repo)]);
  assert.deepEqual(h.sections().map((section) => section.label), ['Committed changes (1)', 'Unstaged changes (1)']);
  const committed = h.children(h.sections()[0])[0];
  const local = h.children(h.sections()[1])[0];
  assert.equal(local.change.path, committed.change.path);
  assert.equal(local.change.status, 'M');
  assert.notEqual(local.id, committed.id);
  assert.equal(h.decorations.provideFileDecoration(local.resourceUri).color.id, 'gitDecoration.modifiedResourceForeground');
  await h.run('openFile', local);
  assert.equal(h.calls.at(-1)[1].scheme, 'file');
  assert.equal(await fs.promises.readFile(h.calls.at(-1)[1].fsPath, 'utf8'), 'staged plus unstaged\n');
  await h.run('openDiff', local);
  const [command, left, right, title] = h.calls.at(-1);
  assert.equal(command, 'vscode.diff');
  assert.equal(title, 'file.txt (Unstaged)');
  assert.equal(left.scheme, 'branch-diff-snapshot');
  assert.deepEqual(JSON.parse(left.query), { root: repo.root, path: 'file.txt', indexStage: 0 });
  assert.equal(Buffer.from(await h.providers.get(left.scheme).provider.readFile(left)).toString(), 'staged\n');
  assert.equal(right.scheme, 'file');
  await h.run('openDiff', committed);
  assert.equal(JSON.parse(h.calls.at(-1)[2].query).commit, head);
  assert.deepEqual(h.errors, []);
});

test('opens unstaged deletions from the index and diffs them against an empty side', async (t) => {
  const repo = fixture(t);
  repo.write('deleted.txt', 'base\n');
  repo.commit('base');
  repo.write('deleted.txt', 'staged before deletion\n');
  repo.git('add', 'deleted.txt');
  fs.unlinkSync(path.join(repo.root, 'deleted.txt'));
  const h = await harness(t, [repository(repo)]);
  const item = h.children(h.sections()[1])[0];
  assert.equal(item.change.status, 'D');
  await h.run('openFile', item);
  assert.equal(h.calls.at(-1)[1].scheme, 'branch-diff-snapshot');
  assert.deepEqual(JSON.parse(h.calls.at(-1)[1].query), { root: repo.root, path: 'deleted.txt', indexStage: 0 });
  await h.run('openDiff', item);
  const [, left, right] = h.calls.at(-1);
  assert.equal(left.scheme, 'branch-diff-snapshot');
  assert.equal(JSON.parse(left.query).indexStage, 0);
  assert.equal(Buffer.from(await h.providers.get(left.scheme).provider.readFile(left)).toString(), 'staged before deletion\n');
  assert.equal(JSON.parse(right.query).empty, true);
  assert.equal((await h.providers.get(right.scheme).provider.readFile(right)).byteLength, 0);
  assert.deepEqual(h.errors, []);
});

test('refreshes live index snapshots per repository while committed snapshots stay pinned', async (t) => {
  const repo = fixture(t);
  const other = fixture(t);
  repo.write('file.txt', 'HEAD\n'); repo.commit('base');
  other.write('file.txt', 'other HEAD\n'); other.commit('base');
  repo.write('file.txt', 'staged\n'); repo.git('add', 'file.txt');
  repo.write('file.txt', 'working\n');
  const tracked = repository(repo);
  const h = await harness(t, [tracked, repository(other)]);
  const provider = h.providers.get('branch-diff-snapshot').provider;
  await h.run('openDiff', h.children(h.sections()[1])[0]);
  const index = h.calls.at(-1)[1];
  const before = await provider.stat(index);
  const otherIndex = Uri.from({ scheme: index.scheme, path: '/file.txt', query: JSON.stringify({ root: other.root, path: 'file.txt', indexStage: 0 }) });
  await provider.readFile(otherIndex);
  const pinned = Uri.from({ scheme: index.scheme, path: '/file.txt', query: JSON.stringify({ root: repo.root, path: 'file.txt', commit: tracked.state.HEAD.commit, empty: false }) });
  await provider.readFile(pinned);
  const events = [];
  const subscription = provider.onDidChangeFile((changes) => events.push(...changes));
  t.after(() => subscription.dispose());
  repo.git('add', 'file.txt');
  await nextRefresh(h, () => tracked.changed.fire());
  assert.deepEqual(events.map((event) => event.uri.toString()), [index.toString()]);
  assert.equal(events[0].type, 1);
  assert.ok((await provider.stat(index)).mtime > before.mtime);
  assert.equal(Buffer.from(await provider.readFile(index)).toString(), 'working\n');
  assert.equal(Buffer.from(await provider.readFile(pinned)).toString(), 'HEAD\n');
  assert.equal((await provider.stat(pinned)).mtime, 0);
  assert.equal(h.sections().length, 1, 'Fully staged edits leave the unstaged section');
  const invalid = Uri.from({ scheme: index.scheme, path: '/file.txt', query: JSON.stringify({ root: repo.root, path: 'file.txt', indexStage: 9 }) });
  await assert.rejects(provider.readFile(invalid), /Invalid index snapshot stage/);
});

test('refreshes tracked unstaged entries after saving, staging, and editing a staged file again', async (t) => {
  const repo = fixture(t);
  repo.write('file.txt', 'base\n');
  repo.commit('base');
  const tracked = repository(repo);
  const h = await harness(t, [tracked]);
  const marker = h.marker();
  repo.write('file.txt', 'saved edit\n');
  await nextRefresh(h, () => tracked.changed.fire());
  assert.equal(h.sections()[1].label, 'Unstaged changes (1)');
  const id = h.children(h.sections()[1])[0].id;
  repo.git('add', 'file.txt');
  await nextRefresh(h, () => tracked.changed.fire());
  assert.equal(h.sections().length, 1);
  repo.write('file.txt', 'another edit\n');
  await nextRefresh(h, () => tracked.changed.fire());
  assert.equal(h.children(h.sections()[1])[0].id, id);
  assert.equal(h.marker(), marker, 'Local status changes do not recreate branch markers');
});

test('diffs edits after a staged rename against the new index path', async (t) => {
  const repo = fixture(t);
  repo.write('old.txt', 'base\n');
  repo.commit('base');
  repo.git('mv', 'old.txt', 'new.txt');
  repo.write('new.txt', 'edited after rename\n');
  const h = await harness(t, [repository(repo)]);
  const item = h.children(h.sections()[1])[0];
  assert.equal(item.change.path, 'new.txt');
  assert.equal(item.change.originalPath, undefined);
  await h.run('openDiff', item);
  assert.deepEqual(JSON.parse(h.calls.at(-1)[1].query), { root: repo.root, path: 'new.txt', indexStage: 0 });
  assert.deepEqual(h.errors, []);
});

test('uses empty baselines for intent-to-add files and ours for unresolved conflicts', async (t) => {
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
  repo.write('intent.txt', 'intent to add\n');
  repo.git('add', '--intent-to-add', 'intent.txt');
  const h = await harness(t, [repository(repo)]);
  const [conflict, intent] = h.children(h.sections()[1]);
  assert.equal(conflict.change.status, '!');
  assert.equal(h.decorations.provideFileDecoration(conflict.resourceUri).tooltip, 'Conflicted');
  await h.run('openDiff', conflict);
  const left = h.calls.at(-1)[1];
  assert.equal(JSON.parse(left.query).indexStage, 2);
  assert.equal(Buffer.from(await h.providers.get(left.scheme).provider.readFile(left)).toString(), 'main\n');
  await h.run('openDiff', intent);
  assert.equal(JSON.parse(h.calls.at(-1)[1].query).empty, true);
  assert.equal(h.calls.at(-1)[2].scheme, 'file');
  assert.deepEqual(h.errors, []);
});

test('keeps committed deletions and recreated untracked files as distinct rows', async (t) => {
  const repo = fixture(t);
  repo.write('recreated.txt', 'original\n');
  repo.commit('base');
  repo.git('checkout', '-b', 'feature');
  repo.git('rm', 'recreated.txt');
  repo.commit('delete');
  repo.write('recreated.txt', 'local replacement\n');
  const h = await harness(t, [repository(repo)]);
  const deleted = h.children(h.sections()[0])[0];
  const untracked = h.children(h.sections()[1])[0];
  assert.equal(deleted.change.path, untracked.change.path);
  assert.equal(deleted.change.status, 'D');
  assert.equal(untracked.change.status, 'U');
  assert.notEqual(deleted.id, untracked.id);
  assert.equal(h.view.badge.value, 2);
  await h.run('openFile', deleted);
  assert.equal(h.calls.at(-1)[1].scheme, 'branch-diff-snapshot');
  await h.run('openFile', untracked);
  assert.equal(h.calls.at(-1)[1].scheme, 'file');
  await h.run('openDiff', deleted);
  assert.equal(JSON.parse(h.calls.at(-1)[2].query).empty, true);
  await h.run('openDiff', untracked);
  assert.equal(JSON.parse(h.calls.at(-1)[1].query).empty, true);
  assert.equal(h.calls.at(-1)[2].scheme, 'file');
  assert.deepEqual(h.errors, []);
});

test('reports vanished untracked files without falling back to a nonexistent HEAD snapshot', async (t) => {
  const repo = fixture(t);
  repo.write('file.txt', 'base\n');
  repo.commit('base');
  repo.write('vanished.txt', 'local\n');
  const h = await harness(t, [repository(repo)]);
  const item = h.children(h.sections()[1])[0];
  fs.unlinkSync(path.join(repo.root, 'vanished.txt'));
  const calls = h.calls.length;
  await h.run('openFile', item);
  await h.run('openDiff', item);
  assert.equal(h.calls.length, calls, 'Neither opens a snapshot nor a broken diff');
  assert.equal(h.errors.length, 2);
  assert.ok(h.errors.every((message) => /Working file.*vanished\.txt.*Refresh the view/.test(message)));
  await h.run('refresh');
  assert.deepEqual(h.sections().map((section) => section.label), ['Committed changes (0)']);
  assert.equal(h.view.badge.value, 0);
});

test('refreshes untracked files on Git events and hides the section after staging or deletion', async (t) => {
  const repo = fixture(t);
  repo.write('file.txt', 'base\n');
  repo.commit('base');
  const tracked = repository(repo);
  const h = await harness(t, [tracked]);
  assert.equal(h.sections().length, 1);
  repo.write('new.txt', 'new\n');
  await nextRefresh(h, () => tracked.changed.fire());
  assert.equal(h.sections()[1].label, 'Unstaged changes (1)');
  repo.git('add', 'new.txt');
  await nextRefresh(h, () => tracked.changed.fire());
  assert.deepEqual(h.sections().map((section) => section.label), ['Committed changes (0)']);
  repo.git('reset', '--', 'new.txt');
  await nextRefresh(h, () => tracked.changed.fire());
  assert.equal(h.sections()[1].label, 'Unstaged changes (1)');
  fs.unlinkSync(path.join(repo.root, 'new.txt'));
  await nextRefresh(h, () => tracked.changed.fire());
  assert.equal(h.sections().length, 1);
  assert.equal(h.view.badge.value, 0);
});

test('excludes ignored files and nested repositories from the selected repository section', async (t) => {
  const repo = fixture(t);
  repo.write('.gitignore', 'ignored/\n');
  repo.commit('base');
  repo.write('ignored/generated.txt', 'ignored\n');
  repo.write('nested/file.txt', 'belongs to another open repository\n');
  repo.write('embedded/file.txt', 'embedded repository\n');
  repo.git('-C', 'embedded', 'init', '--initial-branch=main');
  repo.write('nested-sibling/file.txt', 'belongs to the selected repository\n');
  repo.write('own.txt', 'local\n');
  const nested = { rootUri: Uri.file(path.join(repo.root, 'nested')), state: { HEAD: undefined, onDidChange: new EventEmitter().event } };
  const h = await harness(t, [repository(repo), nested]);
  assert.deepEqual(h.children(h.sections()[1]).map((item) => item.change.path), ['nested-sibling/file.txt', 'own.txt']);
  await h.run('disableMarkers');
  assert.equal(h.sections()[1].label, 'Unstaged changes (2)', 'Unstaged listing is independent of the marker toggle');
});

test('discards pending unstaged results after switching repositories', async (t) => {
  const one = fixture(t);
  const two = fixture(t);
  one.write('base.txt', 'one\n'); one.commit('base');
  two.write('base.txt', 'two\n'); two.commit('base');
  one.write('one-untracked.txt', 'one\n');
  two.write('two-untracked.txt', 'two\n');
  const first = repository(one);
  const second = repository(two);
  const h = await harness(t, [first, second]);
  const { Git } = require('../dist/git');
  const unstagedChanges = Git.prototype.unstagedChanges;
  let release;
  let started;
  const gate = new Promise((resolve) => { release = resolve; });
  const queried = new Promise((resolve) => { started = resolve; });
  t.after(() => release());
  t.mock.method(Git.prototype, 'unstagedChanges', async function (root) {
    const files = await unstagedChanges.call(this, root);
    if (root === one.root) {
      started();
      await gate;
    }
    return files;
  });
  const pending = h.run('refresh');
  await queried;
  h.select((choices) => choices.find((choice) => choice.repository === second));
  await h.run('selectRepository');
  const ids = h.sections().map((section) => section.id);
  const marker = h.marker();
  release();
  await pending;
  assert.deepEqual(h.sections().map((section) => section.id), ids);
  assert.deepEqual(h.children(h.sections()[1]).map((item) => item.change.path), ['two-untracked.txt']);
  assert.equal(h.marker(), marker);
  assert.equal(h.marker().rootUri.fsPath, two.root);
  assert.deepEqual(h.errors, []);
});

test('ignores other repositories, snapshots, Git metadata, and ignored files', async (t) => {
  const repo = fixture(t);
  repo.write('file.txt', 'base\n');
  repo.write('.gitignore', 'ignored/\n');
  repo.commit('base');
  const nested = { rootUri: Uri.file(path.join(repo.root, 'nested')), state: { HEAD: undefined, onDidChange: new EventEmitter().event } };
  const h = await harness(t, [repository(repo), nested]);
  const provider = h.marker().quickDiffProvider;
  const token = { isCancellationRequested: false };
  assert.equal(await provider.provideOriginalResource(Uri.file(path.join(repo.root, '..', 'outside.txt')), token), undefined);
  assert.equal(await original(h, repo, 'nested/file.txt'), undefined);
  assert.equal(await original(h, repo, '.git/config'), undefined);
  assert.equal(await original(h, repo, 'ignored/file.txt'), undefined);
  assert.equal(await provider.provideOriginalResource(Uri.from({ scheme: 'branch-diff-snapshot', path: '/file.txt' }), token), undefined);
});

test('toggles branch markers independently and remembers the choice for the workspace', async (t) => {
  const repo = fixture(t);
  repo.write('file.txt', 'base\n');
  repo.commit('base');
  const h = await harness(t, [repository(repo)]);
  const marker = h.marker();
  assert.equal(h.contexts.get('branchDiff.markersEnabled'), true);
  await h.run('toggleMarkers');
  assert.equal(marker.disposed, true);
  assert.equal(h.marker(), undefined);
  assert.equal(h.state.get('markersEnabled'), false);
  assert.equal(h.contexts.get('branchDiff.markersEnabled'), false);
  assert.ok(h.calls.some(([command, key, value]) => command === 'setContext' && key === 'branchDiff.markersEnabled' && value === false));
  await h.run('refresh');
  assert.equal(h.marker(), undefined, 'Refresh does not turn markers back on');
  await h.run('toggleMarkers');
  assert.equal(h.state.get('markersEnabled'), true);
  assert.equal(h.contexts.get('branchDiff.markersEnabled'), true);
  assert.equal(h.marker().label, 'Branch Diff (main)');
  const disabled = await harness(t, [repository(repo)], { state: { markersEnabled: false } });
  assert.equal(disabled.marker(), undefined, 'A remembered off state is respected on activation');
  assert.equal(disabled.contexts.get('branchDiff.markersEnabled'), false);
});

test('shows a clickable marker status before the sidebar opens and disposes it with the view', async (t) => {
  const h = await harness(t, [], { refresh: false });
  assert.equal(h.statusBarItems.length, 1);
  const [status] = h.statusBarItems;
  assert.equal(h.view.visible, false);
  assert.equal(status.id, 'branchDiff.markers');
  assert.equal(status.name, 'Branch Diff Markers');
  assert.equal(status.alignment, 1);
  assert.equal(status.visible, true, 'The status item is shown even without a repository or sidebar refresh');
  assert.equal(status.text, '$(eye) Branch Diff: On');
  assert.equal(status.command, 'branchDiff.toggleMarkers');
  assert.match(status.tooltip, /markers are on.*Click to disable/);
  assert.match(status.accessibilityInformation.label, /markers: On.*Click to disable/);

  await h.commands.get(status.command)();
  assert.equal(status.text, '$(eye-closed) Branch Diff: Off');
  assert.equal(h.contexts.get('branchDiff.markersEnabled'), false);
  assert.equal(h.state.get('markersEnabled'), false);
  assert.equal(status.visible, true);
  h.view.provider.dispose();
  assert.equal(status.disposed, true);
  assert.equal(status.visible, false);
});

test('keeps marker status synchronized with remembered state and every toggle while the sidebar is hidden', async (t) => {
  const repo = fixture(t);
  repo.write('file.txt', 'base\n'); repo.commit('base');
  const h = await harness(t, [repository(repo)], { state: { markersEnabled: false } });
  const [status] = h.statusBarItems;
  assert.equal(status.text, '$(eye-closed) Branch Diff: Off');
  assert.match(status.tooltip, /markers are off.*Click to enable/);
  assert.match(status.accessibilityInformation.label, /markers: Off.*Click to enable/);
  await nextRefresh(h, () => h.view.setVisible(true));
  h.view.setVisible(false);
  for (const [command, enabled] of [
    ['enableMarkers', true], ['enableMarkers', true], ['disableMarkers', false], ['disableMarkers', false],
    ['toggleMarkers', true], ['toggleMarkers', false],
  ]) {
    await h.run(command);
    assert.equal(status.text, `$(${enabled ? 'eye' : 'eye-closed'}) Branch Diff: ${enabled ? 'On' : 'Off'}`, command);
    assert.match(status.tooltip, enabled ? /markers are on.*Click to disable/ : /markers are off.*Click to enable/);
    assert.match(status.accessibilityInformation.label, enabled ? /markers: On.*Click to disable/ : /markers: Off.*Click to enable/);
    assert.equal(status.visible, true);
    assert.equal(h.view.visible, false);
    assert.equal(h.contexts.get('branchDiff.markersEnabled'), enabled);
    assert.equal(h.state.get('markersEnabled'), enabled);
    assert.equal(!!h.marker(), enabled);
  }
  await h.run('refresh');
  assert.equal(status.text, '$(eye-closed) Branch Diff: Off');
  assert.equal(h.statusBarItems.length, 1, 'Toggling and refreshing reuse the same status bar item');
});

test('activates after startup so marker status is available without opening the sidebar', () => {
  const { activationEvents } = require('../package.json');
  assert.ok(activationEvents.includes('onStartupFinished'));
});

test('contributes distinct on/off icons and labels using supported menu conditions', () => {
  const { contributes } = require('../package.json');
  const on = contributes.commands.find((command) => command.command === 'branchDiff.disableMarkers');
  const off = contributes.commands.find((command) => command.command === 'branchDiff.enableMarkers');
  assert.equal(on.icon, '$(eye)');
  assert.match(on.title, /Disable.*Currently On/);
  assert.equal(off.icon, '$(eye-closed)');
  assert.match(off.title, /Enable.*Currently Off/);
  assert.ok(contributes.commands.every((command) => !Object.hasOwn(command, 'toggled')), 'Unsupported toggled metadata must not return');
  for (const [command, condition] of [[on, 'branchDiff.markersEnabled'], [off, '!branchDiff.markersEnabled']]) {
    assert.ok(contributes.menus['view/title'].some((item) => item.command === command.command
      && item.when === `view == branchDiff.files && ${condition}`));
    assert.ok(contributes.menus.commandPalette.some((item) => item.command === command.command && item.when === condition));
  }
});

test('explicit on/off actions keep the visible state synchronized and are idempotent', async (t) => {
  const repo = fixture(t);
  repo.write('file.txt', 'base\n');
  repo.commit('base');
  const h = await harness(t, [repository(repo)]);
  const first = h.marker();
  await h.run('enableMarkers');
  assert.equal(h.marker(), first, 'Enabling an already-enabled provider does not recreate it');
  await h.run('disableMarkers');
  assert.equal(h.contexts.get('branchDiff.markersEnabled'), false);
  assert.equal(h.marker(), undefined);
  await h.run('disableMarkers');
  assert.equal(h.state.get('markersEnabled'), false, 'A stale toolbar action cannot toggle back on');
  assert.equal(h.marker(), undefined);
  await h.run('enableMarkers');
  assert.equal(h.contexts.get('branchDiff.markersEnabled'), true);
  assert.equal(h.state.get('markersEnabled'), true);
  assert.ok(h.marker());
});

test('refreshes markers when the comparison ref advances even if its name stays the same', async (t) => {
  const repo = fixture(t);
  repo.write('file.txt', 'base\n');
  repo.commit('base');
  repo.git('checkout', '-b', 'feature');
  repo.write('file.txt', 'feature\n');
  const head = repo.commit('feature');
  const h = await harness(t, [repository(repo)]);
  const marker = h.marker();
  repo.git('update-ref', 'refs/heads/main', head);
  await h.run('refresh');
  assert.equal(marker.disposed, true);
  assert.notEqual(h.marker(), marker);
  assert.equal(JSON.parse((await original(h, repo, 'file.txt')).query).commit, head);
  assert.equal(await marker.quickDiffProvider.provideOriginalResource(Uri.file(path.join(repo.root, 'file.txt')), { isCancellationRequested: false }), undefined);
});

test('removes stale markers when a comparison branch disappears and recovers after selection', async (t) => {
  const repo = fixture(t);
  repo.write('file.txt', 'base\n');
  repo.commit('base');
  repo.git('checkout', '-b', 'feature');
  const h = await harness(t, [repository(repo)]);
  const marker = h.marker();
  repo.git('branch', '-D', 'main');
  await h.run('refresh');
  assert.equal(marker.disposed, true);
  assert.equal(h.marker(), undefined);
  h.select((choices) => choices.find((choice) => choice.branch.name === 'feature'));
  await h.run('selectBranch');
  assert.equal(h.marker().label, 'Branch Diff (feature)');
});

test('honors cancellation without poisoning the shared original-resource cache', async (t) => {
  const repo = fixture(t);
  repo.write('file.txt', 'base\n');
  repo.commit('base');
  const h = await harness(t, [repository(repo)]);
  const token = { isCancellationRequested: false };
  const cancelled = original(h, repo, 'file.txt', token);
  token.isCancellationRequested = true;
  const valid = original(h, repo, 'file.txt');
  assert.equal(await cancelled, undefined);
  assert.equal(JSON.parse((await valid).query).empty, false);
  const pending = original(h, repo, 'other.txt');
  await h.run('toggleMarkers');
  assert.equal(await pending, undefined, 'Disabling invalidates in-flight requests');
});

test('refreshes the file list after Git repository events', async (t) => {
  const repo = fixture(t);
  repo.write('file.txt', 'before\n');
  repo.commit('base');
  repo.git('checkout', '-b', 'feature');
  const tracked = repository(repo);
  const h = await harness(t, [tracked]);
  assert.match(h.items()[0].label, /No committed differences/);
  repo.write('file.txt', 'after\n');
  tracked.state.HEAD.commit = repo.commit('feature');
  await nextRefresh(h, () => tracked.changed.fire());
  assert.equal(h.items()[0].change.status, 'M');
  assert.equal(h.view.badge.value, 1);
});
