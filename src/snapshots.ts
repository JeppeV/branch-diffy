import * as vscode from 'vscode';
import { Git } from './git';

export const snapshotScheme = 'branch-diff-snapshot';

interface CommitSnapshot {
  readonly root: string;
  readonly commit: string;
  readonly path: string;
  readonly empty: boolean;
}

interface IndexSnapshot {
  readonly root: string;
  readonly path: string;
  readonly indexStage: 0 | 2;
}

type Snapshot = CommitSnapshot | IndexSnapshot;

export function snapshotUri(root: vscode.Uri, commit: string, path: string, empty = false): vscode.Uri {
  return vscode.Uri.from({
    scheme: snapshotScheme,
    path: `/${path}`,
    query: JSON.stringify({ root: root.fsPath, commit, path, empty } satisfies Snapshot),
  });
}

export function indexSnapshotUri(root: vscode.Uri, path: string, indexStage: 0 | 2 = 0): vscode.Uri {
  return vscode.Uri.from({
    scheme: snapshotScheme,
    path: `/${path}`,
    query: JSON.stringify({ root: root.fsPath, path, indexStage } satisfies IndexSnapshot),
  });
}

/** A read-only filesystem also lets VS Code display historical images and binary files. */
export class SnapshotFileSystem implements vscode.FileSystemProvider, vscode.Disposable {
  private readonly changes = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
  readonly onDidChangeFile = this.changes.event;
  private readonly indexSnapshots = new Map<string, { root: string; uri: vscode.Uri }>();
  private indexMtime = Date.now();

  constructor(private readonly git: Git) {}

  watch(): vscode.Disposable {
    return new vscode.Disposable(() => {});
  }

  refreshIndex(root: vscode.Uri): void {
    this.indexMtime++;
    const events = [...this.indexSnapshots.values()].filter((snapshot) => snapshot.root === root.fsPath)
      .map(({ uri }) => ({ uri, type: vscode.FileChangeType.Changed }));
    if (events.length) {
      this.changes.fire(events);
    }
  }

  async stat(uri: vscode.Uri): Promise<vscode.FileStat> {
    const content = await this.readFile(uri);
    const mtime = 'indexStage' in JSON.parse(uri.query) ? this.indexMtime : 0;
    return { type: vscode.FileType.File, ctime: 0, mtime, size: content.byteLength };
  }

  async readFile(uri: vscode.Uri): Promise<Uint8Array> {
    try {
      const snapshot = JSON.parse(uri.query) as Snapshot;
      if (typeof snapshot.root !== 'string' || typeof snapshot.path !== 'string') {
        throw new Error('Invalid snapshot URI.');
      }
      if ('indexStage' in snapshot) {
        if (snapshot.indexStage !== 0 && snapshot.indexStage !== 2) {
          throw new Error('Invalid index snapshot stage.');
        }
        this.indexSnapshots.set(uri.toString(), { root: snapshot.root, uri });
        return await this.git.readIndexFile(snapshot.root, snapshot.path, snapshot.indexStage);
      }
      if (typeof snapshot.commit !== 'string' || typeof snapshot.empty !== 'boolean') {
        throw new Error('Invalid snapshot URI.');
      }
      return snapshot.empty ? new Uint8Array() : await this.git.readFile(snapshot.root, snapshot.commit, snapshot.path);
    } catch (error) {
      throw vscode.FileSystemError.Unavailable(error instanceof Error ? error.message : String(error));
    }
  }

  readDirectory(): [string, vscode.FileType][] {
    throw vscode.FileSystemError.FileNotADirectory();
  }

  createDirectory(): never {
    throw vscode.FileSystemError.NoPermissions('Branch snapshots are read-only.');
  }

  writeFile(): never {
    throw vscode.FileSystemError.NoPermissions('Branch snapshots are read-only.');
  }

  delete(): never {
    throw vscode.FileSystemError.NoPermissions('Branch snapshots are read-only.');
  }

  rename(): never {
    throw vscode.FileSystemError.NoPermissions('Branch snapshots are read-only.');
  }

  dispose(): void {
    this.indexSnapshots.clear();
    this.changes.dispose();
  }
}
