const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createMarkerBaseline } = require('../dist/markerBaseline');

const cases = [
  {
    name: 'keeps a local addition after a committed edit out of the branch replacement hunk',
    base: 'first\nbefore\nlast\n', index: 'first\nafter\nlast\n', working: 'first\nafter\nlocal addition\nlast\n',
    expected: 'first\nbefore\nlocal addition\nlast\n',
  },
  {
    name: 'maps a branch marker past a local insertion before it',
    base: 'first\nbefore\nlast\n', index: 'first\nafter\nlast\n', working: 'new first\nfirst\nafter\nlast\n',
    expected: 'new first\nfirst\nbefore\nlast\n',
  },
  {
    name: 'neutralizes adjacent local modifications',
    base: 'before\nsecond\nlast\n', index: 'after\nsecond\nlast\n', working: 'after\nlocal second\nlast\n',
    expected: 'before\nlocal second\nlast\n',
  },
  {
    name: 'retains the branch comparison at a following local deletion anchor (case 4)',
    base: 'before\nsecond\nlast\n', index: 'after\nsecond\nlast\n', working: 'after\nlast\n',
    expected: 'before\nlast\n',
  },
  {
    name: 'retains the branch comparison at a local deletion anchor at BOF (case 5)',
    base: 'first\nbefore\nlast\n', index: 'first\nafter\nlast\n', working: 'after\nlast\n', expected: 'before\nlast\n',
  },
  {
    name: 'preserves a branch edit away from a local deletion anchor',
    base: 'before\nseparator\ndeleted\nlast\n', index: 'after\nseparator\ndeleted\nlast\n',
    working: 'after\nseparator\nlast\n', expected: 'before\nseparator\nlast\n',
  },
  {
    name: 'lets local edits win on overlapping lines but retains other branch edits',
    base: 'old one\nold two\nseparator\nold four\n', index: 'new one\nnew two\nseparator\nnew four\n',
    working: 'new one\nlocal two\nseparator\nnew four\n', expected: 'old one\nlocal two\nseparator\nold four\n',
  },
  {
    name: 'preserves a multi-line branch replacement beside an insertion',
    base: 'one\ntwo\nthree\nlast\n', index: 'replacement\nlast\n', working: 'replacement\nlocal\nlast\n',
    expected: 'one\ntwo\nthree\nlocal\nlast\n',
  },
  {
    name: 'preserves branch additions while neutralizing a local edit within them',
    base: 'first\nlast\n', index: 'first\nbranch addition\nlast\n', working: 'first\nlocal replacement\nlast\n',
    expected: 'first\nlocal replacement\nlast\n',
  },
  {
    name: 'keeps a local addition in a branch-added file, including its newline',
    base: '', index: 'branch addition\n', working: 'branch addition\nlocal addition\n', expected: 'local addition\n',
  },
  {
    name: 'keeps a branch addition when appending after a committed line without a final newline (case 9)',
    base: '', index: 'branch addition', working: 'branch addition\nlocal addition', expected: 'local addition',
  },
  {
    name: 'keeps a branch addition when appending newline-terminated local lines to an unterminated file',
    base: '', index: 'branch addition', working: 'branch addition\nlocal one\nlocal two\n', expected: 'local one\nlocal two\n',
  },
  {
    name: 'separates an unterminated branch original from an appended local line',
    base: 'before', index: 'after', working: 'after\nlocal', expected: 'before\nlocal',
  },
  {
    name: 'maps an unterminated branch line past a local prefix and suffix',
    base: 'before', index: 'after', working: 'prefix\nafter\nlocal', expected: 'prefix\nbefore\nlocal',
  },
  {
    name: 'retains every committed line when appending to an unterminated branch-added file',
    base: '', index: 'first\nlast', working: 'first\nlast\nlocal', expected: 'local',
  },
  {
    name: 'retains an unchanged unterminated EOF when other lines are locally edited',
    base: 'before\nlast', index: 'after\nlast', working: 'local\nlast', expected: 'local\nlast',
  },
  {
    name: 'lets a local replacement still win on an unterminated committed addition',
    base: '', index: 'branch addition', working: 'local replacement\nlocal addition', expected: 'local replacement\nlocal addition',
  },
  {
    name: 'handles CRLF and Unicode when appending to an unterminated branch-added file',
    base: '', index: 'committed', working: 'committed\r\n你好\r\n', expected: '你好\n',
  },
  {
    name: 'preserves independent committed deletions',
    base: 'first\nbranch deletion\nmiddle\nlast\n', index: 'first\nmiddle\nlast\n',
    working: 'first\nmiddle\nlocal last\n', expected: 'first\nbranch deletion\nmiddle\nlocal last\n',
  },
  {
    name: 'lets a local insertion own a shared branch-deletion anchor',
    base: 'first\ndeleted\nlast\n', index: 'first\nlast\n', working: 'first\nlocal\nlast\n', expected: 'first\nlocal\nlast\n',
  },
  {
    name: 'leaves clean files unchanged',
    base: 'before\n', index: 'after\n', working: 'after\n', expected: 'before\n',
  },
  {
    name: 'leaves entirely local changes to native Git',
    base: 'before\n', index: 'before\n', working: 'local\n', expected: 'local\n',
  },
  {
    name: 'handles empty working files',
    base: 'before\n', index: 'after\n', working: '', expected: '',
  },
  {
    name: 'handles a removed final newline as a local edit',
    base: 'before\n', index: 'after\n', working: 'after', expected: 'after',
  },
  {
    name: 'does not mistake CRLF conversion for local edits',
    base: 'before\nlast\n', index: 'after\nlast\n', working: 'after\r\nlast\r\n', expected: 'before\nlast\n',
  },
  {
    name: 'maps CRLF text and Unicode local additions',
    base: 'before\r\nlast\r\n', index: 'after\nlast\n', working: 'after\r\n你好\r\nlast\r\n', expected: 'before\n你好\nlast\n',
  },
  {
    name: 'ignores UTF-8 BOM differences exposed by the editor model',
    base: '\uFEFFbefore\nlast\n', index: '\uFEFFafter\nlast\n', working: 'after\nlocal\nlast\n', expected: 'before\nlocal\nlast\n',
  },
];

for (const { name, base, index, working, expected } of cases) {
  test(name, () => assert.equal(createMarkerBaseline(base, index, working), expected));
}

test('bounds work on wholesale rewrites and yields to local Git rather than blocking the editor', () => {
  const base = Array.from({ length: 2000 }, (_, line) => `base ${line}\n`).join('');
  const index = Array.from({ length: 2000 }, (_, line) => `index ${line}\n`).join('');
  const working = `${index}local\n`;
  assert.equal(createMarkerBaseline(base, index, working), working);
});

test('handles distant edits in a large file without giving up unrelated branch markers', () => {
  const base = Array.from({ length: 20000 }, (_, line) => `${line}\n`);
  const index = [...base];
  index[10] = 'branch first\n';
  index[19000] = 'branch last\n';
  const working = [...index];
  working.splice(11, 0, 'local\n');
  const expected = [...base];
  expected.splice(11, 0, 'local\n');
  assert.equal(createMarkerBaseline(base.join(''), index.join(''), working.join('')), expected.join(''));
});

test('maps combinations of insertions, edits, and deletions against independently generated expectations', () => {
  let seed = 42;
  const random = (max) => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed % max;
  };
  for (let iteration = 0; iteration < 300; iteration++) {
    const base = Array.from({ length: 8 + random(30) }, (_, line) => `original ${line}\n`);
    const index = base.map((line, n) => random(3) ? line : `branch ${n}\n`);
    const working = [];
    const expected = [];
    for (let line = 0; line <= index.length; line++) {
      if (random(5) === 0) {
        working.push(`insertion ${line}\n`);
        expected.push(`insertion ${line}\n`);
      }
      if (line === index.length) {
        break;
      }
      const action = random(5);
      if (action === 0) {
        working.push(`local ${line}\n`);
        expected.push(`local ${line}\n`);
      } else if (action !== 1) {
        working.push(index[line]);
        expected.push(base[line]);
      }
    }
    // Unique line identities provide an independent mapping, without another diff algorithm.
    assert.equal(createMarkerBaseline(base.join(''), index.join(''), working.join('')), expected.join(''), `case ${iteration}`);
  }
});
