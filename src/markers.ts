import * as path from 'node:path';
import * as vscode from 'vscode';
import { Change, Git } from './git';
import { markerSnapshotUri } from './snapshots';

export interface MarkerBaseline {
  readonly root: vscode.Uri;
  readonly baseCommit: string;
  readonly baseName: string;
  readonly changes: readonly Change[];
  readonly repositoryRoots: readonly vscode.Uri[];
}

function relativeFilePath(root: vscode.Uri, uri: vscode.Uri): string | undefined {
  if (uri.scheme !== 'file') {
    return undefined;
  }
  const relative = path.relative(root.fsPath, uri.fsPath);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)
    || relative.split(path.sep)[0].toLowerCase() === '.git') {
    return undefined;
  }
  return relative.split(path.sep).join('/');
}

/** Supplies an additional native quick-diff baseline without replacing VS Code's Git provider. */
export class BranchMarkers implements vscode.Disposable {
  private sourceControl: vscode.SourceControl | undefined;
  private baseline: MarkerBaseline | undefined;
  private signature = '';
  private generation = 0;

  constructor(
    private readonly git: Git,
    private readonly output: vscode.OutputChannel,
    private markersEnabled: boolean,
  ) {}

  get enabled(): boolean {
    return this.markersEnabled;
  }

  setEnabled(enabled: boolean): void {
    if (enabled !== this.markersEnabled) {
      this.markersEnabled = enabled;
      this.registerProvider();
    }
  }

  prepare(root: vscode.Uri, baseName: string): void {
    if (this.baseline && (this.baseline.root.toString() !== root.toString() || this.baseline.baseName !== baseName)) {
      this.update(undefined);
    }
  }

  update(baseline: MarkerBaseline | undefined): void {
    const signature = baseline ? JSON.stringify([
      baseline.root.toString(), baseline.baseCommit, baseline.baseName,
      baseline.changes, baseline.repositoryRoots.map((root) => root.toString()),
    ]) : '';
    if (signature === this.signature) {
      return;
    }
    this.signature = signature;
    this.baseline = baseline;
    this.registerProvider();
  }

  private registerProvider(): void {
    const generation = ++this.generation;
    this.sourceControl?.dispose();
    this.sourceControl = undefined;
    const baseline = this.baseline;
    if (!this.markersEnabled || !baseline) {
      return;
    }

    const changes = new Map(baseline.changes.map((change) => [change.path, change]));
    const originals = new Map<string, Promise<vscode.Uri | undefined>>();
    const sourceControl = vscode.scm.createSourceControl('branchDiff', `Branch Diff (${baseline.baseName})`, baseline.root);
    this.sourceControl = sourceControl;
    sourceControl.inputBox.visible = false;
    sourceControl.count = 0;
    sourceControl.quickDiffProvider = {
      provideOriginalResource: async (uri, token) => {
        const filePath = relativeFilePath(baseline.root, uri);
        if (!filePath || token.isCancellationRequested || generation !== this.generation) {
          return undefined;
        }
        // Do not paint files belonging to a nested repository as additions in its parent.
        if (baseline.repositoryRoots.some((root) => relativeFilePath(baseline.root, root) !== undefined
          && relativeFilePath(root, uri) !== undefined)) {
          return undefined;
        }
        let original = originals.get(filePath);
        if (!original) {
          original = this.originalResource(baseline, changes.get(filePath), filePath).catch((error: unknown) => {
            originals.delete(filePath);
            this.output.appendLine(`Could not load marker baseline for ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
            return undefined;
          });
          originals.set(filePath, original);
        }
        const result = await original;
        return !token.isCancellationRequested && generation === this.generation ? result : undefined;
      },
    };
  }

  private async originalResource(baseline: MarkerBaseline, change: Change | undefined, filePath: string): Promise<vscode.Uri | undefined> {
    if (change?.status === 'A') {
      return markerSnapshotUri(baseline.root, baseline.baseCommit, filePath, filePath, true);
    }
    const originalPath = change?.originalPath ?? filePath;
    const type = await this.git.fileType(baseline.root.fsPath, baseline.baseCommit, originalPath);
    if (type && type !== 'blob') {
      return undefined;
    }
    if (type === undefined && await this.git.isIgnored(baseline.root.fsPath, filePath)) {
      return undefined;
    }
    // A file absent on both branch tips can still have new, uncommitted content.
    return markerSnapshotUri(baseline.root, baseline.baseCommit, originalPath, filePath, type === undefined);
  }

  dispose(): void {
    this.generation++;
    this.sourceControl?.dispose();
    this.sourceControl = undefined;
  }
}
