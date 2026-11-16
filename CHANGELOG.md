# Changelog

## 0.1.0

Initial release.

- Browse committed changes between a selected local or remote-tracking branch and `HEAD`.
- Open working files and byte-preserving committed diffs, including additions, deletions, and renames.
- Browse unstaged and untracked files separately, with live index-to-working-copy diffs.
- Show native branch gutter markers alongside built-in Git markers, keeping local edits separate.
- Toggle branch markers and Explorer status decorations from the sidebar, status bar, or Command Palette.
- Remember comparison branches per repository and marker enablement per workspace.

### Known limitations

- On VS Code 1.95.3, native gutter markers classify committed new files as modified rather than added. Sidebar and Explorer status badges and committed diffs remain correct.
- Expensive text comparisons yield to native Git markers. Virtual workspaces and VS Code for the Web are not supported.
