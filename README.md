# Branch Diff

A VS Code sidebar for files changed between your checked-out branch and another branch, defaulting to `main`.

## Use

1. Open a Git repository and select **Branch Diff** in the left Activity Bar.
2. Use the **Select Comparison Branch** (branch) button to choose a local or remote-tracking branch.
3. The view has collapsible **Committed changes** and **Unstaged changes** sections. Files show native, theme-aware Git-style badges: **A** added, **M** modified, **D** deleted, **R** renamed, **C** copied, **T** type changed, **U** untracked, or **!** conflicted. The unstaged section is hidden when empty.
4. Click a file to open it. Committed deletions open a read-only version from the comparison branch; unstaged deletions open the index (staged) version. Committed files missing from your working directory open the committed version instead; unexpectedly missing working files report an error.
5. Hover a file and select **Open Diff**. In **Committed changes**, this compares the two committed versions. In **Unstaged changes**, it compares the index (including staged edits) against the live working file, including unsaved editor contents. New/untracked files have an empty left side; deleted files have an empty right side.

The view refreshes when Git reports repository changes, when it becomes visible, or when you select **Refresh**. Workspaces with multiple repositories also get a **Select Repository** button. The selected comparison branch is remembered separately for each repository in the workspace.

### Native editor markers

Opening Branch Diff enables native, theme-aware gutter markers for the selected repository: green for added lines, blue for modified lines, and red for deleted lines. Click a marker to see VS Code's inline change preview. Renamed files compare against their original path on the comparison branch.

Branch markers show changes from the selected branch to the **index**, mapped into the live editor. Unstaged and unsaved edits are incorporated into a synthetic, read-only branch baseline so the built-in Git provider can mark those edits normally. For example, a committed modification followed by an unstaged added line keeps a blue branch marker on the modification and Git's green marker on the addition. Local edits take precedence on overlapping lines; an independent branch edit sharing a local deletion's gutter anchor remains accessible through the inline preview's comparison dropdown. Staged changes remain part of the branch comparison. This does not modify files, commits, or the index.

The branch marker's inline preview uses this **adjusted baseline**, not necessarily the exact comparison-branch contents. The **Committed changes** section and its **Open Diff** action remain committed-only and unadjusted; the separate **Unstaged changes** section shows local changes relative to the index. Entirely deleted files are still viewed through the sidebar or **Open Diff**, since they have no working-copy editor to mark. Very large or expensive text comparisons yield to native Git markers for that file; binary baselines remain byte-preserving.

The view-title button shows an **open eye when markers are on** and a **crossed-out eye when off**. Hover it to see the current state and whether clicking will enable or disable markers. The Command Palette likewise shows **Branch Diff: Disable Branch Markers (Currently On)** or **Branch Diff: Enable Branch Markers (Currently Off)**. Markers are on by default; the toggle is remembered for this workspace. Switching branches or repositories updates the baseline automatically. The `branchDiff.toggleMarkers` command remains available for custom keybindings.

While branch markers are enabled, files in the selected repository's **Committed changes** section also use the sidebar's theme-aware status colors in Explorer: added/copied, modified/type-changed, deleted, and renamed files each use their corresponding Git color. Turning markers off removes this branch coloring without changing the sidebar's status badges or native Git decorations. Local-only changes and files belonging to nested repositories are not branch-colored.

Native integration adds a separate **Branch Diff (branch-name)** provider in Source Control, with its commit input hidden. It does not replace the built-in Git provider, change Git settings, or inflate the Source Control change count. If a change preview offers multiple baselines, choose **Branch Diff (branch-name)** for the branch comparison. Markers follow VS Code's `scm.diffDecorations` setting; use `all` or `gutter` to show them beside line numbers. VS Code may suppress gutter marks for entirely new untracked files with empty baselines.

### What is compared?

The **Committed changes** section compares the comparison branch's committed tree to `HEAD` (`git diff <comparison-branch> HEAD`), not the merge base. Changes exclusive to either branch therefore appear. Uncommitted and staged changes to tracked files are **not** included in that section or its **Open Diff** action. Clicking an existing file opens your working copy, which can include local edits.

The **Unstaged changes** section works like Source Control's **Changes** list: saved modifications and deletions of tracked files, untracked files, and further edits to files that already have staged changes. Staged-only changes are excluded. Staging all changes to a file removes it from this section; editing it again brings it back. The list reflects saved on-disk changes, but an open diff also follows unsaved editor contents. Unresolved conflicts are shown with **!** and use the merge's “ours” version as their diff baseline.

Untracked files respect `.gitignore`, repository-local excludes, and global Git ignore rules. The unstaged section excludes files belonging to nested repositories and is independent of the marker toggle. A file can appear in both sections with different comparisons; these are distinct entries. The view badge counts entries across both sections. No staging, unstaging, or discard actions are provided: the extension keeps Git operations read-only.

Remote branches use already-fetched local references; the extension never fetches, checks out branches, or changes your repository. If `main` does not exist, use the branch picker. Detached HEAD, binary files, filenames containing spaces, and Git worktrees are supported.

### Settings

```json
{
  "branchDiff.defaultBaseBranch": "main"
}
```

This controls the initial branch for repositories without a remembered selection. Use the branch picker to change an existing selection.

## Develop

Requires Node.js 22+, Git, and VS Code 1.95+. The built-in VS Code Git extension must be enabled and the workspace trusted. Works with local folders and remote extension hosts (for example WSL, SSH, and Dev Containers), but not virtual workspaces or VS Code for the Web.

```sh
npm install
npm test
```

Open this folder in VS Code and press **F5** to start an Extension Development Host, then open a Git repository there.

`npm run test:vscode` also runs a smoke test in an isolated VS Code window. It downloads VS Code 1.95.3 by default; set `VSCODE_EXECUTABLE_PATH` to use an existing VS Code executable instead. Unit/integration tests in `npm test` use real temporary Git repositories and a mocked VS Code UI.

## Install locally

```sh
npm run package
code --install-extension branch-diff-0.1.0.vsix
```

Alternatively use **Extensions: Install from VSIX…** in VS Code. Packaging does not publish the extension.
