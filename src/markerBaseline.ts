interface LineChange {
  readonly originalStart: number;
  readonly originalEnd: number;
  readonly modifiedStart: number;
  readonly modifiedEnd: number;
}

/** Bounded Myers diff. Expensive files are left entirely to native Git markers. */
function lineChanges(original: readonly string[], modified: readonly string[], allowAddedFinalNewline = false): LineChange[] | undefined {
  // Appending a line terminates the previous EOF line without replacing its text.
  // Keep newline removal significant, and keep the branch-to-index comparison exact.
  const sameLine = (oldLine: number, newLine: number) => original[oldLine] === modified[newLine]
    || (allowAddedFinalNewline && oldLine === original.length - 1 && `${original[oldLine]}\n` === modified[newLine]);
  let start = 0;
  while (start < original.length && start < modified.length && sameLine(start, start)) {
    start++;
  }
  let oldEnd = original.length;
  let newEnd = modified.length;
  while (oldEnd > start && newEnd > start && sameLine(oldEnd - 1, newEnd - 1)) {
    oldEnd--;
    newEnd--;
  }
  if (start === oldEnd || start === newEnd) {
    return start === oldEnd && start === newEnd ? [] : [{
      originalStart: start, originalEnd: oldEnd, modifiedStart: start, modifiedEnd: newEnd,
    }];
  }

  const oldLength = oldEnd - start;
  const newLength = newEnd - start;
  const trace: Int32Array[] = [];
  let work = 0;
  for (let distance = 0; distance <= oldLength + newLength; distance++) {
    // Bounds both CPU and trace memory, including wholesale rewrites with no common lines.
    work += 2 * distance + 1;
    if (work > 1_000_000) {
      return undefined;
    }
    const frontier = new Int32Array(2 * distance + 1);
    const previous = trace[distance - 1];
    for (let diagonal = -distance; diagonal <= distance; diagonal += 2) {
      let x = distance === 0 ? 0
        : diagonal === -distance || (diagonal !== distance && previous[diagonal + distance - 2] < previous[diagonal + distance])
          ? previous[diagonal + distance] : previous[diagonal + distance - 2] + 1;
      let y = x - diagonal;
      while (x < oldLength && y < newLength && sameLine(start + x, start + y)) {
        if (++work > 1_000_000) {
          return undefined;
        }
        x++;
        y++;
      }
      frontier[diagonal + distance] = x;
      if (x < oldLength || y < newLength) {
        continue;
      }

      const matches: [number, number][] = [];
      for (let depth = distance; depth > 0; depth--) {
        const prior = trace[depth - 1];
        const k = x - y;
        const priorK = k === -depth || (k !== depth && prior[k + depth - 2] < prior[k + depth]) ? k + 1 : k - 1;
        const priorX = prior[priorK + depth - 1];
        const priorY = priorX - priorK;
        while (x > priorX && y > priorY) {
          matches.push([start + --x, start + --y]);
        }
        x = priorX;
        y = priorY;
      }
      while (x > 0 && y > 0) {
        matches.push([start + --x, start + --y]);
      }

      const changes: LineChange[] = [];
      let oldCursor = start;
      let newCursor = start;
      for (const [oldLine, newLine] of matches.reverse()) {
        if (oldCursor !== oldLine || newCursor !== newLine) {
          changes.push({ originalStart: oldCursor, originalEnd: oldLine, modifiedStart: newCursor, modifiedEnd: newLine });
        }
        oldCursor = oldLine + 1;
        newCursor = newLine + 1;
      }
      if (oldCursor !== oldEnd || newCursor !== newEnd) {
        changes.push({ originalStart: oldCursor, originalEnd: oldEnd, modifiedStart: newCursor, modifiedEnd: newEnd });
      }
      return changes;
    }
    trace.push(frontier);
  }
  return undefined;
}

function lines(text: string): string[] {
  // Editor models normalize line endings and do not expose the encoding's BOM as text.
  const normalized = text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  return normalized.match(/[^\n]*\n|[^\n]+$/g) ?? [];
}

/**
 * Copy index-to-editor edits into the branch baseline, leaving the other branch differences
 * intact. This keeps adjacent local insertions out of native branch replacement hunks.
 * Replacements pair lines in order; local edits win where the two comparisons overlap.
 * Keep branch edits on surviving lines even at a local deletion's gutter anchor: Git still
 * supplies the deletion, and VS Code needs both providers' changes for its dropdown.
 */
export function createMarkerBaseline(base: string, index: string, working: string): string {
  if (index === working) {
    return base;
  }
  if (base === index) {
    return working;
  }
  if (Math.max(base.length, index.length, working.length) > 4 * 1024 * 1024) {
    return working;
  }
  const baseLines = lines(base);
  const indexLines = lines(index);
  const workingLines = lines(working);
  if (Math.max(baseLines.length, indexLines.length, workingLines.length) > 100_000) {
    return working;
  }
  const localChanges = lineChanges(indexLines, workingLines, true);
  if (!localChanges) {
    return working;
  }
  if (!localChanges.length) {
    return base;
  }
  const branchChanges = lineChanges(baseLines, indexLines);
  if (!branchChanges) {
    return working;
  }

  // Anchor original branch lines to index lines. Branch-only deletions live at boundaries.
  const originals = indexLines.map((line) => [line]);
  const deletions = new Map<number, string[]>();
  for (const change of branchChanges) {
    const oldCount = change.originalEnd - change.originalStart;
    const newCount = change.modifiedEnd - change.modifiedStart;
    if (!newCount) {
      deletions.set(change.modifiedStart, baseLines.slice(change.originalStart, change.originalEnd));
      continue;
    }
    for (let offset = 0; offset < newCount; offset++) {
      const oldStart = change.originalStart + Math.min(offset, oldCount);
      const oldEnd = offset === newCount - 1 ? change.originalEnd : Math.min(oldStart + 1, change.originalEnd);
      originals[change.modifiedStart + offset] = baseLines.slice(oldStart, oldEnd);
    }
  }

  // A branch-only deletion at a local edit's boundary shares its anchor: let local Git own it.
  const localBoundaries = new Set(localChanges.flatMap((change) => [change.originalStart, change.originalEnd]));
  const result: string[] = [];
  const append = (lines: readonly string[]) => {
    for (const line of lines) {
      // An original EOF line can now precede a copied local insertion.
      if (result.length && !result[result.length - 1].endsWith('\n')) {
        result.push('\n');
      }
      result.push(line);
    }
  };
  let cursor = 0;
  const appendOriginals = (end: number) => {
    while (cursor < end) {
      if (!localBoundaries.has(cursor)) {
        append(deletions.get(cursor) ?? []);
      }
      append(originals[cursor++]);
    }
  };
  for (const change of localChanges) {
    appendOriginals(change.originalStart);
    append(workingLines.slice(change.modifiedStart, change.modifiedEnd));
    cursor = change.originalEnd;
  }
  appendOriginals(indexLines.length);
  if (!localBoundaries.has(cursor)) {
    append(deletions.get(cursor) ?? []);
  }
  return result.join('');
}
