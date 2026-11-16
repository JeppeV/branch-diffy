import * as vscode from 'vscode';
import { Git } from './git';
import { createMarkerBaseline } from './markerBaseline';

export const snapshotScheme = 'branch-diffy-snapshot';

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

interface MarkerSnapshot extends CommitSnapshot {
  readonly markerPath: string;
}

interface LiveMarker {
  readonly uri: vscode.Uri;
  readonly snapshot: MarkerSnapshot;
  version: number;
  inputs?: Promise<{ base: Buffer; index: Buffer | undefined }>;
}

type Snapshot = CommitSnapshot | IndexSnapshot | MarkerSnapshot;

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

export function markerSnapshotUri(root: vscode.Uri, commit: string, path: string, markerPath: string, empty = false): vscode.Uri {
  return vscode.Uri.from({
    scheme: snapshotScheme,
    path: `/${markerPath}`,
    query: JSON.stringify({ root: root.fsPath, commit, path, empty, markerPath } satisfies MarkerSnapshot),
  });
}

/** A read-only filesystem also lets VS Code display historical images and binary files. */
export class SnapshotFileSystem implements vscode.FileSystemProvider, vscode.Disposable {
  private readonly changes = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
  readonly onDidChangeFile = this.changes.event;
  private readonly indexSnapshots = new Map<string, { root: string; uri: vscode.Uri }>();
  private readonly markerSnapshots = new Map<string, LiveMarker>();
  private readonly listeners: vscode.Disposable[];
  private indexMtime = Date.now();

  constructor(private readonly git: Git) {
    const refresh = (document: vscode.TextDocument) => {
      if (document.uri.scheme !== 'file') {
        return;
      }
      const events: vscode.FileChangeEvent[] = [];
      for (const marker of this.markerSnapshots.values()) {
        if (this.workingUri(marker.snapshot).toString() === document.uri.toString()) {
          marker.version++;
          events.push({ uri: marker.uri, type: vscode.FileChangeType.Changed });
        }
      }
      if (events.length) {
        this.indexMtime++;
        this.changes.fire(events);
      }
    };
    this.listeners = [
      vscode.workspace.onDidChangeTextDocument((event) => refresh(event.document)),
      vscode.workspace.onDidOpenTextDocument(refresh),
      vscode.workspace.onDidCloseTextDocument(refresh),
    ];
  }

  watch(): vscode.Disposable {
    return new vscode.Disposable(() => {});
  }

  refreshIndex(root: vscode.Uri): void {
    this.indexMtime++;
    const events = [...this.indexSnapshots.values()].filter((snapshot) => snapshot.root === root.fsPath)
      .map(({ uri }) => ({ uri, type: vscode.FileChangeType.Changed }));
    for (const marker of this.markerSnapshots.values()) {
      if (marker.snapshot.root === root.fsPath) {
        marker.inputs = undefined;
        marker.version++;
        events.push({ uri: marker.uri, type: vscode.FileChangeType.Changed });
      }
    }
    if (events.length) {
      this.changes.fire(events);
    }
  }

  async stat(uri: vscode.Uri): Promise<vscode.FileStat> {
    const content = await this.readFile(uri);
    const snapshot = JSON.parse(uri.query);
    const mtime = 'indexStage' in snapshot || 'markerPath' in snapshot ? this.indexMtime : 0;
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
      if ('markerPath' in snapshot) {
        if (typeof snapshot.markerPath !== 'string') {
          throw new Error('Invalid marker snapshot URI.');
        }
        return await this.readMarker(uri, snapshot);
      }
      return snapshot.empty ? new Uint8Array() : await this.git.readFile(snapshot.root, snapshot.commit, snapshot.path);
    } catch (error) {
      throw vscode.FileSystemError.Unavailable(error instanceof Error ? error.message : String(error));
    }
  }

  private workingUri(snapshot: MarkerSnapshot): vscode.Uri {
    return vscode.Uri.joinPath(vscode.Uri.file(snapshot.root), ...snapshot.markerPath.split('/'));
  }

  private async readMarker(uri: vscode.Uri, snapshot: MarkerSnapshot): Promise<Uint8Array> {
    const key = uri.toString();
    let marker = this.markerSnapshots.get(key);
    if (!marker) {
      marker = { uri, snapshot, version: 0 };
      this.markerSnapshots.set(key, marker);
    }
    for (;;) {
      const version = marker.version;
      if (!marker.inputs) {
        marker.inputs = Promise.all([
          snapshot.empty ? Promise.resolve(Buffer.alloc(0)) : this.git.readFile(snapshot.root, snapshot.commit, snapshot.path),
          this.git.readIndexBaseline(snapshot.root, snapshot.markerPath),
        ]).then(([base, index]) => ({ base, index }));
      }
      const inputs = marker.inputs;
      let base: Buffer;
      let index: Buffer | undefined;
      try {
        ({ base, index } = await inputs);
      } catch (error) {
        if (version !== marker.version) {
          continue;
        }
        if (marker.inputs === inputs) {
          marker.inputs = undefined;
        }
        throw error;
      }
      const workingUri = this.workingUri(snapshot);
      const document = vscode.workspace.textDocuments.find((document) => !document.isClosed && document.uri.toString() === workingUri.toString());
      const working = document ? Buffer.from(document.getText()) : Buffer.from(await vscode.workspace.fs.readFile(workingUri));
      // A refresh while Git/disk was being read must not publish an outdated baseline.
      if (version !== marker.version) {
        continue;
      }
      // Historical and binary snapshots remain byte-preserving. Only UTF-8 text is synthesized.
      if ([base, index, working].some((bytes) => bytes && (bytes.includes(0) || !Buffer.from(bytes.toString('utf8')).equals(bytes)))) {
        return base;
      }
      return index ? Buffer.from(createMarkerBaseline(base.toString('utf8'), index.toString('utf8'), working.toString('utf8'))) : working;
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
    this.listeners.forEach((listener) => listener.dispose());
    this.indexSnapshots.clear();
    this.markerSnapshots.clear();
    this.changes.dispose();
  }
}
