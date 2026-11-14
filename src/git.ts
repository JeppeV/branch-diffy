import { execFile } from 'node:child_process';

export type ChangeStatus = 'A' | 'M' | 'D' | 'R' | 'C' | 'T';

export interface Change {
  readonly status: ChangeStatus;
  readonly path: string;
  readonly originalPath?: string;
}

export interface UnstagedChange {
  readonly status: ChangeStatus | 'U' | '!';
  readonly path: string;
  readonly originalPath?: string;
}

export interface Branch {
  readonly ref: string;
  readonly name: string;
  readonly remote: boolean;
}

export interface Comparison {
  readonly baseCommit: string;
  readonly headCommit: string;
  readonly changes: readonly Change[];
}

export class MissingReferenceError extends Error {
  constructor(readonly reference: string) {
    super(`Branch or commit "${reference}" was not found.`);
    this.name = 'MissingReferenceError';
  }
}

class GitCommandError extends Error {
  constructor(message: string, readonly exitCode: string | number | undefined, readonly stderr: string) {
    super(message);
    this.name = 'GitCommandError';
  }
}

/** Git's NUL-delimited format preserves spaces, tabs, newlines, and Unicode in paths. */
export function parseNameStatus(output: string): Change[] {
  const fields = output.split('\0');
  if (fields.at(-1) === '') {
    fields.pop();
  }
  const changes: Change[] = [];
  for (let index = 0; index < fields.length;) {
    const code = fields[index++];
    const status = code[0] as ChangeStatus;
    if (!['A', 'M', 'D', 'R', 'C', 'T'].includes(status)) {
      throw new Error(`Unexpected Git change status: ${code}`);
    }
    const firstPath = fields[index++];
    const renamed = status === 'R' || status === 'C';
    const filePath = renamed ? fields[index++] : firstPath;
    if (!firstPath || !filePath) {
      throw new Error('Incomplete file list returned by Git.');
    }
    changes.push({ status, path: filePath, ...(renamed ? { originalPath: firstPath } : {}) });
  }
  return changes.sort((a, b) => a.path.localeCompare(b.path));
}

/** Porcelain's second column describes index-to-working-tree changes; the first is staged. */
export function parseUnstagedStatus(output: string): UnstagedChange[] {
  const fields = output.split('\0');
  if (fields.at(-1) === '') {
    fields.pop();
  }
  const changes: UnstagedChange[] = [];
  for (let index = 0; index < fields.length;) {
    const entry = fields[index++];
    const code = entry.slice(0, 2);
    const filePath = entry.slice(3);
    if (entry[2] !== ' ' || !filePath) {
      throw new Error('Incomplete file status returned by Git.');
    }
    // In porcelain -z, a rename/copy's destination comes first, then its original path.
    const renamed = /[RC]/.test(code);
    const originalPath = renamed ? fields[index++] : undefined;
    if (renamed && !originalPath) {
      throw new Error('Incomplete renamed file returned by Git.');
    }
    if (['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU'].includes(code)) {
      changes.push({ status: '!', path: filePath });
    } else if (code === '??') {
      // Nested repositories may be reported as directories, not individual files.
      if (!filePath.endsWith('/')) {
        changes.push({ status: 'U', path: filePath });
      }
    } else if (code !== '!!' && code[1] !== ' ') {
      const status = code[1] as ChangeStatus;
      if (!['A', 'M', 'D', 'R', 'C', 'T'].includes(status)) {
        throw new Error(`Unexpected Git working-tree status: ${code}`);
      }
      changes.push({ status, path: filePath, ...(status === 'R' || status === 'C' ? { originalPath } : {}) });
    }
  }
  return changes.sort((a, b) => a.path.localeCompare(b.path));
}

export function branchLabel(reference: string): string {
  return reference.replace(/^refs\/(heads|remotes)\//, '');
}

export class Git {
  constructor(private readonly executable: string) {}

  private run(root: string, args: readonly string[]): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      execFile(this.executable, [...args], {
        cwd: root,
        encoding: 'buffer',
        maxBuffer: 64 * 1024 * 1024,
        windowsHide: true,
        env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' },
      }, (error, stdout, stderr) => {
        if (error) {
          const details = stderr.toString('utf8').trim();
          reject(new GitCommandError(details || error.message, error.code ?? undefined, details));
        } else {
          resolve(stdout);
        }
      });
    });
  }

  async resolveCommit(root: string, reference: string): Promise<string> {
    try {
      return (await this.run(root, ['rev-parse', '--verify', '--quiet', '--end-of-options', `${reference}^{commit}`]))
        .toString('utf8').trim();
    } catch (error) {
      if (error instanceof GitCommandError && error.exitCode === 1 && !error.stderr) {
        throw new MissingReferenceError(reference);
      }
      throw error;
    }
  }

  async compare(root: string, base: string): Promise<Comparison> {
    const [baseCommit, headCommit] = await Promise.all([
      this.resolveCommit(root, base),
      this.resolveCommit(root, 'HEAD'),
    ]);
    // Compare the two committed trees, not the index or working directory.
    const output = await this.run(root, [
      'diff', '--no-ext-diff', '--no-textconv', '--ignore-submodules=none',
      '--name-status', '-z', '--find-renames', baseCommit, headCommit, '--',
    ]);
    return { baseCommit, headCommit, changes: parseNameStatus(output.toString('utf8')) };
  }

  async unstagedChanges(root: string): Promise<UnstagedChange[]> {
    const output = await this.run(root, [
      'status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignore-submodules=none', '--',
    ]);
    return parseUnstagedStatus(output.toString('utf8'));
  }

  async branches(root: string): Promise<Branch[]> {
    const output = await this.run(root, [
      'for-each-ref', '--sort=refname', '--format=%(refname)%00%(symref)', 'refs/heads', 'refs/remotes',
    ]);
    return output.toString('utf8').split(/\r?\n/).filter(Boolean).flatMap((line) => {
      const [ref, symbolicTarget] = line.split('\0');
      return symbolicTarget ? [] : [{
        ref,
        name: branchLabel(ref),
        remote: ref.startsWith('refs/remotes/'),
      }];
    });
  }

  async fileType(root: string, commit: string, filePath: string): Promise<'blob' | 'tree' | 'commit' | undefined> {
    const output = (await this.run(root, ['--literal-pathspecs', 'ls-tree', '-z', commit, '--', filePath])).toString('utf8');
    if (!output) {
      return undefined;
    }
    const type = output.split(' ', 2)[1];
    if (type !== 'blob' && type !== 'tree' && type !== 'commit') {
      throw new Error(`Unexpected Git object type: ${type}`);
    }
    return type;
  }

  async isIgnored(root: string, filePath: string): Promise<boolean> {
    try {
      await this.run(root, ['check-ignore', '--quiet', '--no-index', '--', filePath]);
      return true;
    } catch (error) {
      if (error instanceof GitCommandError && error.exitCode === 1) {
        return false;
      }
      throw error;
    }
  }

  readFile(root: string, commit: string, filePath: string): Promise<Buffer> {
    if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(commit)) {
      return Promise.reject(new Error('Invalid snapshot commit.'));
    }
    // A full object ID and a single argv entry keep file paths out of option parsing.
    return this.run(root, ['show', '--no-ext-diff', '--no-textconv', `${commit}:${filePath}`]);
  }

  readIndexFile(root: string, filePath: string, stage: 0 | 2 = 0): Promise<Buffer> {
    return this.run(root, ['show', '--no-ext-diff', '--no-textconv', `:${stage}:${filePath}`]);
  }
}
