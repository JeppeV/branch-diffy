# Bug Tracker

## BUG-001: Shared deletion anchors hide the branch comparison from the diff dropdown

**Status:** Fixed  
**Manual test cases:** 4 and 5

### Reproduction

- **Case 4:** Commit a branch edit on a line, then locally delete the line immediately after it. Open the gutter marker's inline diff view.
- **Case 5:** Commit a branch edit on the second line of a file, then locally delete the first line. Open the gutter marker's inline diff view.

### Actual

The diff view shows only the local change, without a dropdown to select the branch comparison.

### Expected

Show the diff-provider dropdown so both the branch comparison and the local Git comparison are accessible when both providers have changes, even when the local deletion takes precedence at the shared gutter anchor.

### Resolution

Keep the independent branch edit in the synthetic baseline when only its gutter anchor overlaps a local deletion. Native Git still supplies the deletion marker and remains the default inline comparison; both comparisons are available in the dropdown.

Regression coverage includes both baseline cases and the real VS Code 1.95.3 dropdown, provider switching, and deletion markers with saved and unsaved edits.

## BUG-002: Appending a local line to a committed new file removes its branch marker

**Status:** Fixed  
**Manual test case:** 9

### Reproduction

1. On the checked-out branch, create a new file containing one line. The file must not exist on the comparison branch.
2. Commit the file. Confirm that its branch addition marker appears correctly.
3. Append a new local, unstaged line to the file.

### Actual

The branch marker disappears. Only the local change marker remains.

### Expected

Keep the branch addition marker on the committed line while showing the normal local Git addition marker on the appended line.

### Resolution

When the committed file has no trailing newline, appending a line also terminates its last committed line. Treat that added separator as part of the insertion, not a local replacement of the committed text, and retain separators when assembling the synthetic baseline. The branch-to-index comparison remains exact, and actual overlapping local replacements still take precedence.

Regression coverage includes saved and unsaved appends, staging, multiple lines, CRLF/Unicode, and native change navigation in VS Code 1.95.3 for committed new files with and without a trailing newline.

## BUG-003: Committed new files show modified markers instead of added markers

**Status:** Open — reproduced in VS Code 1.95.3

### Reproduction

1. Create a file that does not exist on the comparison branch.
2. Commit it on the checked-out branch, leaving its working copy clean.
3. Enable Branch Diff markers and open the file.
4. Repeat with and without a trailing newline.

### Actual

The committed lines have blue modified markers instead of green added markers. A temporary native-editor probe confirmed zero added markers in both cases: two modified line decorations for `added\n` and one for `added`.

### Expected

Show green addition markers for the committed new file. Preserve native local-change markers and the inline comparison when subsequent unstaged or unsaved edits are made.

### Investigation

Branch Diff correctly supplies an empty baseline for a committed addition. VS Code 1.95.3's native dirty-diff worker uses `DiffComputer` in `legacyLinesDiffComputer.ts`; its empty-original fast path returns a change with `originalEndLineNumber: 1`. The native gutter renderer consequently classifies that change as a modification, not an addition (which requires `originalEndLineNumber: 0`). Existing tests check the empty baseline and native navigation, but not the clean file's marker type.

No fix applied. The public quick-diff provider API supplies baseline contents, not change classifications. A resolution needs an upstream native-diff fix or a separately designed marker-rendering workaround; changing the sidebar's addition status or returning another empty snapshot does not address the cause.
