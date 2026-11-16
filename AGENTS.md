# Repository instructions

## Development and verification

- Tooling requires Node.js 22+ and Git on `PATH`. On Windows PowerShell, use `npm.cmd`. `npm.cmd run check` is typecheck-only; `npm.cmd test` compiles before running Node tests. There are no lint or formatter scripts.
- Tests import generated `dist/` modules, not `src/`. For one test, run `npm.cmd run compile`, then `node --test --test-name-pattern="toggles branch markers" test/extension.test.cjs`. Do not edit `dist/` directly.
- `npm.cmd test` uses real temporary Git repositories but mocks VS Code. When adding a module that imports `vscode`, update `loadWithVscode` in `test/extension.test.cjs` if the mock loader must intercept that module too. Fixtures isolate Git identity/configuration; no existing Git workspace is required.
- `npm.cmd run test:vscode` opens a real GUI test host using an isolated profile and fixture repository. It downloads/caches VS Code 1.95.3 in `.vscode-test/` unless `VSCODE_EXECUTABLE_PATH` selects another executable. If installed Code is update-locked, clear that override (`$env:VSCODE_EXECUTABLE_PATH = $null`) rather than modifying the user's installation. Use this suite for native SCM/editor behavior that mocks cannot prove.
- F5 runs **Run Branch Diffy** and compiles automatically; open a Git repository in the development host and trust it. Branch Diffy activates after startup, so its marker status bar toggle is available without opening the sidebar. Restart the development session after changing manifest contributions. No VSIX installation is needed.

## Comparison semantics

- The sidebar's **Committed changes** section and its **Open Diff** compare the selected branch's committed tree directly with `HEAD`, not a merge base; staged, unstaged, and unsaved edits are excluded. File clicks open the working copy, falling back to a committed snapshot for deleted/missing committed files.
- **Unstaged changes** is a separate collapsible section, hidden when empty. Parse the working-tree column of `git status --porcelain=v1 -z --untracked-files=all`, consuming both paths for staged renames/copies without treating staged-only changes as unstaged. Include tracked edits/deletions and untracked files; exclude nested repositories. Its **Open Diff** compares a live index snapshot with the live working file, with empty sides for additions/deletions (index stage 2 for conflicted baselines). Notify open index snapshots after repository refreshes. Read index bytes with external diff/textconv disabled; the built-in Git filesystem enables textconv, so do not use it for these baselines. Keep these rows out of marker baseline changes and give them distinct IDs from committed rows at the same path.
- Gutter markers use a synthetic selected-branch baseline: preserve branch-to-index changes, but incorporate index-to-live-editor edits so native Git owns unstaged/unsaved markers. Local edits win on overlapping lines and shared deletion anchors; staged changes remain branch changes. The native inline preview uses the adjusted baseline, not necessarily the exact branch file. Only marker snapshots are synthesized; historical/sidebar snapshots remain exact and byte-preserving. Markers apply only to the selected repository; do not merge this behavior into the sidebar's committed comparison.
- `src/extension.ts` obtains repositories and the Git executable from the built-in `vscode.git` API, then supplies resolved commit IDs to the view and markers. Branch selections live in `workspaceState` per repository; a remembered selection overrides `branchDiffy.defaultBaseBranch`. Marker enablement is remembered per workspace.
- `src/snapshots.ts` is a read-only filesystem, not a text-content provider: preserve raw bytes for historical and index binary files. Committed snapshot URIs pin commit IDs; index snapshot URIs remain live. Renames use the original path and additions/deletions use empty diff sides. `branch-diffy-status` URIs scope sidebar decorations away from normal Explorer/Git decorations.

## Regression traps

- Keep Git operations read-only. Preserve argv-based execution without a shell, NUL-delimited filename parsing, literal pathspecs, and disabled external diff/textconv. Do not add implicit fetches or checkouts.
- Native markers use an additional `SourceControl.quickDiffProvider`, not a replacement for built-in Git. Keep its commit input hidden and `count = 0`; exclude nested repositories, ignored untracked files, and Git metadata from branch markers.
- Preserve generation/cancellation guards in view refreshes and marker lookups. A branch/repository switch or disabling markers must invalidate pending results. Baseline identity includes the commit ID: advancing the same branch name must refresh already-open editors without recreating providers on every unchanged refresh.
- Marker snapshots are live: notify them on editor changes and repository/index refreshes, invalidate cached Git inputs after refresh, and discard stale in-flight reads. Reuse Git inputs while typing. Bound synthetic line-diff work and yield expensive text files to native Git; do not synthesize binary/non-UTF-8 bytes.
- VS Code ignores `toggled` in contributed command metadata. Marker state is shown through separate enable/disable commands with opposite `when` conditions on `branchDiffy.markersEnabled` and distinct eye icons. Keep these actions idempotent and retain `branchDiffy.toggleMarkers` for existing keybindings.
- VS Code compatibility starts at 1.95 and `@types/vscode` is pinned to 1.95.0. Keep API types aligned with the minimum version. Typechecking alone does not establish runtime compatibility; the default editor smoke test targets 1.95.3.

## Packaging

- `npm.cmd run package` recompiles via `vscode:prepublish` and creates a local VSIX; it does not install or publish it. `.vscodeignore` is the packaging exclusion list: keep source, tests, dependencies, source maps, and the downloaded `.vscode-test/` runtime out of the archive.
