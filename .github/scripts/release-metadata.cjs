const fs = require('node:fs');
const path = require('node:path');

function releaseMetadata(manifest, lock, changelog) {
  const { name, displayName, version } = manifest;
  if (typeof version !== 'string' || version.trim() !== version
    || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) {
    throw new Error('The release version must be a numeric major.minor.patch version.');
  }
  if (lock.version !== version || lock.packages?.['']?.version !== version) {
    throw new Error('package.json and package-lock.json release versions must match.');
  }
  if (typeof name !== 'string' || name.trim() !== name || !/^[a-z0-9][a-z0-9-]*$/.test(name)
    || typeof displayName !== 'string' || !displayName.trim() || /[\r\n]/.test(displayName)) {
    throw new Error('Invalid extension name or display name.');
  }

  const lines = changelog.split(/\r?\n/);
  const start = lines.findIndex((line) => line === `## ${version}` || line.startsWith(`## ${version} - `));
  if (start < 0) {
    throw new Error(`Missing changelog entry for ${version}.`);
  }
  const next = lines.findIndex((line, index) => index > start && line.startsWith('## '));
  const notes = lines.slice(start + 1, next < 0 ? undefined : next).join('\n').trim();
  if (!notes) {
    throw new Error(`The changelog entry for ${version} is empty.`);
  }
  return { tag: `v${version}`, title: `${displayName} ${version}`, asset: `${name}-${version}.vsix`, notes };
}

if (require.main === module) {
  const directory = process.argv[2];
  if (!directory || !process.env.GITHUB_OUTPUT) {
    throw new Error('Provide an output directory and GITHUB_OUTPUT file.');
  }
  const root = path.resolve(__dirname, '../..');
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
  const changelog = fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8');
  const { tag, title, asset, notes } = releaseMetadata(manifest, lock, changelog);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'release-notes.md'), `${notes}\n`);
  fs.appendFileSync(process.env.GITHUB_OUTPUT, `tag=${tag}\ntitle=${title}\nasset=${asset}\n`);
}

module.exports = { releaseMetadata };
