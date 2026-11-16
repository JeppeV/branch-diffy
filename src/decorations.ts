import * as path from 'node:path';
import * as vscode from 'vscode';
import { Change } from './git';
import { statusInfo } from './status';

interface BranchDecorationBaseline {
  readonly root: vscode.Uri;
  readonly baseName: string;
  readonly changes: readonly Change[];
  readonly repositoryRoots: readonly vscode.Uri[];
}

function fileKey(uri: vscode.Uri): string {
  const key = path.normalize(uri.fsPath);
  return process.platform === 'win32' ? key.toLowerCase() : key;
}

/** Colors working-file resources separately from the sidebar's status badges. */
export class BranchFileDecorations implements vscode.FileDecorationProvider, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<vscode.Uri[] | undefined>();
  readonly onDidChangeFileDecorations = this.changed.event;
  private readonly registration = vscode.window.registerFileDecorationProvider(this);
  private baseline: BranchDecorationBaseline | undefined;
  private files = new Map<string, Change['status']>();

  constructor(private enabled: boolean) {}

  setEnabled(enabled: boolean): void {
    if (enabled !== this.enabled) {
      this.enabled = enabled;
      this.changed.fire(undefined);
    }
  }

  prepare(root: vscode.Uri, baseName: string): void {
    if (this.baseline && (this.baseline.root.toString() !== root.toString() || this.baseline.baseName !== baseName)) {
      this.update(undefined);
    }
  }

  update(baseline: BranchDecorationBaseline | undefined): void {
    const files = new Map<string, Change['status']>();
    if (baseline) {
      const nestedRoots = baseline.repositoryRoots.filter((root) => root.scheme === 'file').filter((root) => {
        const relative = path.relative(baseline.root.fsPath, root.fsPath);
        return relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
      }).map(fileKey);
      for (const change of baseline.changes) {
        const key = fileKey(vscode.Uri.joinPath(baseline.root, ...change.path.split('/')));
        if (!nestedRoots.some((root) => key === root || key.startsWith(`${root}${path.sep}`))) {
          files.set(key, change.status);
        }
      }
    }
    this.baseline = baseline;
    if (files.size !== this.files.size || [...files].some(([key, status]) => this.files.get(key) !== status)) {
      this.files = files;
      if (this.enabled) {
        this.changed.fire(undefined);
      }
    }
  }

  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    if (!this.enabled || uri.scheme !== 'file') {
      return undefined;
    }
    const status = this.files.get(fileKey(uri));
    if (!status) {
      return undefined;
    }
    const info = statusInfo[status];
    return {
      color: new vscode.ThemeColor(info.color),
      tooltip: `${info.label} between the comparison branch and HEAD`,
    };
  }

  dispose(): void {
    this.enabled = false;
    this.files.clear();
    this.registration.dispose();
    this.changed.dispose();
  }
}
