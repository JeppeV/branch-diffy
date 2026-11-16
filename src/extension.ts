import * as path from 'node:path';
import * as vscode from 'vscode';
import { BranchFileDecorations } from './decorations';
import { branchLabel, Change, Git, MissingReferenceError, UnstagedChange } from './git';
import { GitApi, GitExtension, Repository } from './gitApi';
import { BranchMarkers } from './markers';
import { indexSnapshotUri, SnapshotFileSystem, snapshotScheme, snapshotUri } from './snapshots';
import { statusInfo } from './status';

type Section = 'committed' | 'unstaged';

const statusScheme = 'branch-diff-status';

class ChangeItem extends vscode.TreeItem {
  constructor(
    readonly change: Change | UnstagedChange,
    readonly root: vscode.Uri,
    readonly baseCommit: string,
    readonly headCommit: string,
    readonly baseName: string,
    readonly headName: string,
    readonly section: Section = 'committed',
  ) {
    super(path.posix.basename(change.path), vscode.TreeItemCollapsibleState.None);
    this.id = `${root.toString()}:${section}:${change.path}`;
    this.contextValue = 'branchDiff.change';
    // Use a dedicated URI so branch badges cannot override normal Explorer/SCM decorations.
    this.resourceUri = vscode.Uri.from({ scheme: statusScheme, path: `/${change.path}`, query: change.status });
    this.iconPath = vscode.ThemeIcon.File;
    this.description = path.posix.dirname(change.path) === '.' ? '' : path.posix.dirname(change.path);
    const name = statusInfo[change.status].label;
    const comparison = section === 'unstaged' ? 'Index → Working tree (unstaged)' : `${baseName} → ${headName}`;
    this.tooltip = `${change.path}\n${name}${change.originalPath ? ` from ${change.originalPath}` : ''}\n${comparison}`;
    this.accessibilityInformation = { label: `${change.path}, ${name}` };
    this.command = { command: 'branchDiff.openFile', title: 'Open File', arguments: [this] };
  }
}

class MessageItem extends vscode.TreeItem {
  constructor(label: string, command?: vscode.Command, warning = false) {
    super(label, vscode.TreeItemCollapsibleState.None);
    this.iconPath = new vscode.ThemeIcon(warning ? 'warning' : 'info');
    this.command = command;
    this.tooltip = label;
  }
}

class SectionItem extends vscode.TreeItem {
  constructor(
    root: vscode.Uri,
    section: Section,
    count: number,
    readonly children: (ChangeItem | MessageItem)[],
  ) {
    super(`${section === 'committed' ? 'Committed changes' : 'Unstaged changes'} (${count})`, vscode.TreeItemCollapsibleState.Expanded);
    this.id = `${root.toString()}:${section}`;
  }
}

type Item = SectionItem | ChangeItem | MessageItem;

class BranchDiffView implements vscode.TreeDataProvider<Item>, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<Item | undefined>();
  readonly onDidChangeTreeData = this.changed.event;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly repositoryListeners = new Map<Repository, vscode.Disposable>();
  private readonly view: vscode.TreeView<Item>;
  private readonly markers: BranchMarkers;
  private readonly explorerDecorations: BranchFileDecorations;
  private readonly markersStatus: vscode.StatusBarItem;
  private repository: Repository | undefined;
  private items: Item[] = [new MessageItem('Loading repositories…')];
  private timer: ReturnType<typeof setTimeout> | undefined;
  private generation = 0;
  private disposed = false;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly api: GitApi,
    private readonly git: Git,
    private readonly snapshots: SnapshotFileSystem,
    private readonly output: vscode.OutputChannel,
  ) {
    this.view = vscode.window.createTreeView('branchDiff.files', { treeDataProvider: this, showCollapseAll: false });
    this.markers = new BranchMarkers(git, output, context.workspaceState.get<boolean>('markersEnabled') ?? true);
    this.explorerDecorations = new BranchFileDecorations(this.markers.enabled);
    this.markersStatus = vscode.window.createStatusBarItem('branchDiff.markers', vscode.StatusBarAlignment.Left, 99);
    this.markersStatus.name = 'Branch Diff Markers';
    this.markersStatus.command = 'branchDiff.toggleMarkers';
    this.updateMarkersStatus();
    void vscode.commands.executeCommand('setContext', 'branchDiff.markersEnabled', this.markers.enabled);
    this.disposables.push(
      this.view,
      this.markers,
      this.explorerDecorations,
      this.markersStatus,
      this.changed,
      api.onDidOpenRepository(() => this.repositoriesChanged()),
      api.onDidCloseRepository(() => this.repositoriesChanged()),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration('branchDiff.defaultBaseBranch')) {
          this.scheduleRefresh();
        }
      }),
      this.view.onDidChangeVisibility((event) => {
        if (event.visible) {
          this.scheduleRefresh();
        }
      }),
      vscode.commands.registerCommand('branchDiff.refresh', () => this.refresh()),
      vscode.commands.registerCommand('branchDiff.selectBranch', () => this.selectBranch()),
      vscode.commands.registerCommand('branchDiff.selectRepository', () => this.selectRepository()),
      vscode.commands.registerCommand('branchDiff.toggleMarkers', () => this.setMarkersEnabled(!this.markers.enabled)),
      vscode.commands.registerCommand('branchDiff.enableMarkers', () => this.setMarkersEnabled(true)),
      vscode.commands.registerCommand('branchDiff.disableMarkers', () => this.setMarkersEnabled(false)),
      vscode.commands.registerCommand('branchDiff.openFile', (item: ChangeItem) => this.openFile(item)),
      vscode.commands.registerCommand('branchDiff.openDiff', (item: ChangeItem) => this.openDiff(item)),
    );
    this.markersStatus.show();
    this.repositoriesChanged();
  }

  getTreeItem(item: Item): vscode.TreeItem {
    return item;
  }

  getChildren(item?: Item): Item[] {
    if (item) {
      return item instanceof SectionItem ? item.children : [];
    }
    return this.items;
  }

  private repositoriesChanged(): void {
    const repositories = this.api.repositories.filter((repo) => repo.rootUri.scheme === 'file');
    void vscode.commands.executeCommand('setContext', 'branchDiff.repositoryCount', repositories.length);
    for (const [repository, listener] of this.repositoryListeners) {
      if (!repositories.includes(repository)) {
        listener.dispose();
        this.repositoryListeners.delete(repository);
      }
    }
    for (const repository of repositories) {
      if (!this.repositoryListeners.has(repository)) {
        this.repositoryListeners.set(repository, repository.state.onDidChange(() => {
          if (repository === this.repository) {
            this.scheduleRefresh();
          }
        }));
      }
    }
    if (!this.repository || !repositories.includes(this.repository)) {
      const saved = this.context.workspaceState.get<string>('selectedRepository');
      this.repository = repositories.find((repo) => repo.rootUri.toString() === saved) ?? repositories[0];
    }
    this.scheduleRefresh();
  }

  private baseBranch(repository: Repository): string {
    return this.context.workspaceState.get<string>(`baseBranch:${repository.rootUri.toString()}`)
      ?? vscode.workspace.getConfiguration('branchDiff', repository.rootUri).get<string>('defaultBaseBranch', 'main');
  }

  private scheduleRefresh(): void {
    // Invalidate in-flight results immediately, not just when the debounce expires.
    this.generation++;
    if (this.timer) {
      clearTimeout(this.timer);
    }
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.refresh();
    }, 200);
  }

  private setItems(items: Item[]): void {
    this.items = items;
    this.changed.fire(undefined);
  }

  private async refresh(): Promise<void> {
    if (this.disposed) {
      return;
    }
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    const generation = ++this.generation;
    const repository = this.repository;
    if (!repository) {
      this.markers.update(undefined);
      this.explorerDecorations.update(undefined);
      this.view.description = undefined;
      this.view.message = 'Open a folder containing a Git repository to compare branches.';
      this.view.badge = undefined;
      this.setItems([]);
      return;
    }

    const base = this.baseBranch(repository);
    const baseName = branchLabel(base);
    this.markers.prepare(repository.rootUri, baseName);
    this.explorerDecorations.prepare(repository.rootUri, baseName);
    const head = repository.state.HEAD;
    const headName = head?.name ?? head?.commit?.slice(0, 8) ?? 'HEAD';
    this.view.description = `${baseName} → ${headName}`;
    this.view.message = this.api.repositories.length > 1 ? path.basename(repository.rootUri.fsPath) : undefined;
    try {
      const [comparison, unstagedChanges] = await Promise.all([
        this.git.compare(repository.rootUri.fsPath, base),
        this.git.unstagedChanges(repository.rootUri.fsPath),
      ]);
      if (this.disposed || generation !== this.generation) {
        return;
      }
      this.snapshots.refreshIndex(repository.rootUri);
      const baseline = {
        root: repository.rootUri,
        baseCommit: comparison.baseCommit,
        baseName,
        changes: comparison.changes,
        repositoryRoots: this.api.repositories.map((repo) => repo.rootUri),
      };
      this.markers.update(baseline);
      this.explorerDecorations.update(baseline);
      const committedItems = comparison.changes.map((change) => new ChangeItem(
        change, repository.rootUri, comparison.baseCommit, comparison.headCommit, baseName, headName,
      ));
      const nestedRoots = this.api.repositories.filter((repo) => repo.rootUri.scheme === 'file')
        .map((repo) => path.relative(repository.rootUri.fsPath, repo.rootUri.fsPath))
        .filter((relative) => relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
        .map((relative) => relative.split(path.sep).join('/'));
      const unstagedItems = unstagedChanges
        .filter((change) => !nestedRoots.some((root) => change.path === root || change.path.startsWith(`${root}/`)))
        .map((change) => new ChangeItem(
          change, repository.rootUri, comparison.baseCommit, comparison.headCommit, baseName, headName, 'unstaged',
        ));
      this.view.badge = {
        value: committedItems.length + unstagedItems.length,
        tooltip: `${committedItems.length} committed changes, ${unstagedItems.length} unstaged changes`,
      };
      this.setItems([
        new SectionItem(repository.rootUri, 'committed', committedItems.length, committedItems.length ? committedItems
          : [new MessageItem(`No committed differences between ${baseName} and ${headName}.`)]),
        ...(unstagedItems.length ? [new SectionItem(repository.rootUri, 'unstaged', unstagedItems.length, unstagedItems)] : []),
      ]);
    } catch (error) {
      if (this.disposed || generation !== this.generation) {
        return;
      }
      this.view.badge = undefined;
      this.markers.update(undefined);
      this.explorerDecorations.update(undefined);
      if (error instanceof MissingReferenceError) {
        const noHead = error.reference === 'HEAD';
        this.setItems([new MessageItem(
          noHead ? 'Create a commit before comparing branches.' : `Branch “${baseName}” not found. Select a comparison branch…`,
          noHead ? undefined : { command: 'branchDiff.selectBranch', title: 'Select Comparison Branch' },
          true,
        )]);
      } else {
        const message = error instanceof Error ? error.message : String(error);
        this.output.appendLine(message);
        this.setItems([new MessageItem(`Could not compare branches: ${message}`, undefined, true)]);
      }
    }
  }

  private updateMarkersStatus(): void {
    const enabled = this.markers.enabled;
    const state = enabled ? 'On' : 'Off';
    const action = enabled ? 'disable' : 'enable';
    this.markersStatus.text = `$(${enabled ? 'eye' : 'eye-closed'}) Branch Diff: ${state}`;
    this.markersStatus.tooltip = `Branch diff markers are ${state.toLowerCase()}. Click to ${action}.`;
    this.markersStatus.accessibilityInformation = { label: `Branch Diff markers: ${state}. Click to ${action}.` };
  }

  private async setMarkersEnabled(enabled: boolean): Promise<void> {
    this.markers.setEnabled(enabled);
    this.explorerDecorations.setEnabled(enabled);
    this.updateMarkersStatus();
    await vscode.commands.executeCommand('setContext', 'branchDiff.markersEnabled', enabled);
    await this.context.workspaceState.update('markersEnabled', enabled);
  }

  private async selectBranch(): Promise<void> {
    const repository = this.repository;
    if (!repository) {
      void vscode.window.showInformationMessage('Open a Git repository before selecting a comparison branch.');
      return;
    }
    try {
      const branches = await this.git.branches(repository.rootUri.fsPath);
      const current = this.baseBranch(repository);
      const choices = branches.map((branch) => ({
        label: branch.name,
        description: [branch.remote ? 'remote' : 'local', branch.ref === current || branch.name === current ? 'selected' : ''].filter(Boolean).join(' · '),
        branch,
      }));
      const selected = await vscode.window.showQuickPick(choices, {
        title: 'Branch Diff: Select Comparison Branch',
        placeHolder: 'Compare the checked-out branch against…',
        matchOnDescription: true,
      });
      if (selected && !this.disposed) {
        await this.context.workspaceState.update(`baseBranch:${repository.rootUri.toString()}`, selected.branch.ref);
        await this.refresh();
      }
    } catch (error) {
      this.showError(error);
    }
  }

  private async selectRepository(): Promise<void> {
    const choices = this.api.repositories.filter((repo) => repo.rootUri.scheme === 'file').map((repository) => ({
      label: path.basename(repository.rootUri.fsPath),
      description: repository.rootUri.fsPath,
      repository,
    }));
    const selected = await vscode.window.showQuickPick(choices, { title: 'Branch Diff: Select Repository' });
    if (selected && !this.disposed && this.api.repositories.includes(selected.repository)) {
      this.repository = selected.repository;
      await this.context.workspaceState.update('selectedRepository', this.repository.rootUri.toString());
      await this.refresh();
    }
  }

  private async openFile(item: ChangeItem): Promise<void> {
    if (!(item instanceof ChangeItem)) {
      return;
    }
    try {
      let uri: vscode.Uri;
      if (item.section === 'unstaged') {
        uri = item.change.status === 'D' ? this.indexResource(item) : await this.workingFile(item);
      } else if (item.change.status === 'D') {
        uri = snapshotUri(item.root, item.baseCommit, item.change.path);
      } else {
        uri = vscode.Uri.joinPath(item.root, ...item.change.path.split('/'));
        try {
          await vscode.workspace.fs.stat(uri);
        } catch {
          // A committed file may be absent locally because of unstaged deletion or sparse checkout.
          uri = snapshotUri(item.root, item.headCommit, item.change.path);
        }
      }
      await vscode.commands.executeCommand('vscode.open', uri, { preview: true });
    } catch (error) {
      this.showError(error);
    }
  }

  private indexResource(item: ChangeItem): vscode.Uri {
    return indexSnapshotUri(item.root, item.change.originalPath ?? item.change.path, item.change.status === '!' ? 2 : 0);
  }

  private async workingFile(item: ChangeItem): Promise<vscode.Uri> {
    const uri = vscode.Uri.joinPath(item.root, ...item.change.path.split('/'));
    try {
      await vscode.workspace.fs.stat(uri);
    } catch {
      throw new Error(`Working file “${item.change.path}” is unavailable. Refresh the view and try again.`);
    }
    return uri;
  }

  private async openDiff(item: ChangeItem): Promise<void> {
    if (!(item instanceof ChangeItem)) {
      return;
    }
    try {
      if (item.section === 'unstaged') {
        const empty = snapshotUri(item.root, item.headCommit, item.change.path, true);
        const left = item.change.status === 'U' || item.change.status === 'A' ? empty : this.indexResource(item);
        const right = item.change.status === 'D' ? empty : await this.workingFile(item);
        await vscode.commands.executeCommand('vscode.diff', left, right, `${item.change.path} (Unstaged)`, { preview: true });
        return;
      }
      const left = snapshotUri(item.root, item.baseCommit, item.change.originalPath ?? item.change.path, item.change.status === 'A');
      const right = snapshotUri(item.root, item.headCommit, item.change.path, item.change.status === 'D');
      await vscode.commands.executeCommand('vscode.diff', left, right,
        `${item.change.path} (${item.baseName} ↔ ${item.headName})`, { preview: true });
    } catch (error) {
      this.showError(error);
    }
  }

  private showError(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    this.output.appendLine(message);
    void vscode.window.showErrorMessage(`Branch Diff: ${message}`);
  }

  dispose(): void {
    this.disposed = true;
    this.generation++;
    if (this.timer) {
      clearTimeout(this.timer);
    }
    for (const listener of this.repositoryListeners.values()) {
      listener.dispose();
    }
    this.disposables.forEach((disposable) => disposable.dispose());
  }
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const output = vscode.window.createOutputChannel('Branch Diff');
  context.subscriptions.push(output);
  try {
    const extension = vscode.extensions.getExtension<GitExtension>('vscode.git');
    const exports = await extension?.activate();
    if (!exports?.enabled) {
      throw new Error('Enable the built-in Git extension to use Branch Diff.');
    }
    const api = exports.getAPI(1);
    const git = new Git(api.git.path);
    const snapshots = new SnapshotFileSystem(git);
    context.subscriptions.push(
      snapshots,
      vscode.workspace.registerFileSystemProvider(snapshotScheme, snapshots, { isReadonly: true, isCaseSensitive: true }),
      vscode.window.registerFileDecorationProvider({
        provideFileDecoration(uri) {
          if (uri.scheme !== statusScheme) {
            return undefined;
          }
          const status = uri.query as UnstagedChange['status'];
          const info = statusInfo[status];
          return info ? { badge: status, tooltip: info.label, color: new vscode.ThemeColor(info.color) } : undefined;
        },
      }),
      new BranchDiffView(context, api, git, snapshots, output),
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    output.appendLine(message);
    void vscode.window.showErrorMessage(`Branch Diff: ${message}`);
    throw error;
  }
}
