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

interface DecoratedFile {
  readonly uri: vscode.Uri;
  readonly status: Change['status'];
}

function fileKey(uri: vscode.Uri): string {
  const key = path.normalize(uri.fsPath);
  return process.platform === 'win32' ? key.toLowerCase() : key;
}

/** Decorates working files and their parent folders like native Git changes. */
export class BranchFileDecorations implements vscode.FileDecorationProvider, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<vscode.Uri[] | undefined>();
  readonly onDidChangeFileDecorations = this.changed.event;
  private readonly registration = vscode.window.registerFileDecorationProvider(this);
  private baseline: BranchDecorationBaseline | undefined;
  private files = new Map<string, DecoratedFile>();

  constructor(private enabled: boolean) {}

  setEnabled(enabled: boolean): void {
    if (enabled !== this.enabled) {
      this.enabled = enabled;
      this.changed.fire([...this.files.values()].map((file) => file.uri));
    }
  }

  prepare(root: vscode.Uri, baseName: string): void {
    if (this.baseline && (this.baseline.root.toString() !== root.toString() || this.baseline.baseName !== baseName)) {
      this.update(undefined);
    }
  }

  update(baseline: BranchDecorationBaseline | undefined): void {
    const files = new Map<string, DecoratedFile>();
    if (baseline) {
      const nestedRoots = baseline.repositoryRoots.filter((root) => root.scheme === 'file').filter((root) => {
        const relative = path.relative(baseline.root.fsPath, root.fsPath);
        return relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
      }).map(fileKey);
      for (const change of baseline.changes) {
        const uri = vscode.Uri.joinPath(baseline.root, ...change.path.split('/'));
        const key = fileKey(uri);
        if (!nestedRoots.some((root) => key === root || key.startsWith(`${root}${path.sep}`))) {
          files.set(key, { uri, status: change.status });
        }
      }
    }
    this.baseline = baseline;
    if (files.size !== this.files.size || [...files].some(([key, file]) => this.files.get(key)?.status !== file.status)) {
      const affected = new Map([...this.files, ...files]);
      this.files = files;
      if (this.enabled) {
        // Explicit resources let VS Code propagate into folders whose children were never revealed.
        // Include removed files so their inherited folder decorations are cleared as well.
        this.changed.fire([...affected.values()].map((file) => file.uri));
      }
    }
  }

  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    if (!this.enabled || uri.scheme !== 'file') {
      return undefined;
    }
    const file = this.files.get(fileKey(uri));
    if (!file) {
      return undefined;
    }
    const { status } = file;
    const info = statusInfo[status];
    return {
      badge: status,
      color: new vscode.ThemeColor(info.color),
      tooltip: `${info.label} between the comparison branch and HEAD`,
      propagate: status !== 'D',
    };
  }

  dispose(): void {
    this.enabled = false;
    this.files.clear();
    this.registration.dispose();
    this.changed.dispose();
  }
}
