import type * as vscode from 'vscode';

// The subset of the built-in Git extension's public API used by this extension.
export interface Repository {
  readonly rootUri: vscode.Uri;
  readonly state: {
    readonly HEAD: { readonly name?: string; readonly commit?: string } | undefined;
    readonly onDidChange: vscode.Event<void>;
  };
}

export interface GitApi {
  readonly git: { readonly path: string };
  readonly repositories: readonly Repository[];
  readonly onDidOpenRepository: vscode.Event<Repository>;
  readonly onDidCloseRepository: vscode.Event<Repository>;
}

export interface GitExtension {
  readonly enabled: boolean;
  getAPI(version: 1): GitApi;
}
