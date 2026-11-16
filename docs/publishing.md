# Publishing checklist

The packaging script and CI build and verify without publishing. The manually triggered **Release** workflow can create a GitHub release with a VSIX attached; it does not install the extension or publish it to the VS Code Marketplace.

## Create a GitHub release

1. Commit the desired version in `package.json` and `package-lock.json`, and add its notes under `## <version>` (optionally followed by ` - YYYY-MM-DD`) in `CHANGELOG.md`. For a version bump, use `npm version <version> --no-git-tag-version` and commit both updated manifests with the changelog. Do not create the tag yourself.
2. Push the workflow to the repository's default branch so GitHub can offer **Run workflow**. Push the commit you want to release as well.
3. On GitHub, open **Actions → Release → Run workflow**, choose the branch containing that commit, and run it. **Create a draft release** is enabled by default; clear it to publish immediately. **Prerelease** only controls the GitHub release label.
4. The workflow validates the version and changelog, runs typechecking, tests, and the VS Code 1.95.3 smoke test, builds the VSIX, and creates `v<version>` targeting the exact commit captured when the workflow was started. Release notes come only from that version's changelog section. Existing tags or releases are not overwritten.
5. Open the draft under **Releases**, download and verify its VSIX, then select **Publish release** when ready. The build is also available as the workflow's `github-release` artifact.

The workflow uses GitHub's automatic `GITHUB_TOKEN` with write access limited to the release job; no PAT or Marketplace credentials are needed. Repository or organization policies must allow Actions to create releases. It does not bump versions, commit files, or publish on push. To release again, prepare and commit a new version first.

## Before the first Marketplace release

- Confirm that `package.json`'s `publisher` is the Marketplace publisher ID you control, not just its display name. The publisher and extension name together form the installed extension ID; choose them before distributing a release.
- Add the actual public `repository`, `homepage`, and `bugs` URLs to `package.json`. No repository URL is assumed while this project has no remote configured.
- Add a Marketplace PNG icon (at least 128 × 128) and set `package.json`'s `icon`. The Activity Bar SVG is separate and is not a Marketplace icon.
- Review the README, add a screenshot of the sidebar and markers, and confirm the documented native marker-color limitation is acceptable for release.
- Once repository metadata is in place, remove `--allow-missing-repository` from the packaging script so missing metadata becomes an error.

## Verify a release

Use Node.js 22+ and Git on `PATH`. On Windows PowerShell, use `npm.cmd` in these commands.

```sh
npm ci
npm run check
npm test
npm run test:vscode
npm audit
npm run package
```

The editor smoke test defaults to VS Code 1.95.3, the minimum supported release line. Also run it against the latest stable VS Code by setting `VSCODE_EXECUTABLE_PATH` to that executable. On headless Linux, run the editor test under `xvfb-run -a`.

`npm test` checks the VSIX file list as well as behavior. Packaging recompiles the extension and scans the package for secrets; it must contain only compiled JavaScript, extension assets, the manifest, README, changelog, and license. Do not edit generated `dist/` files. Internal docs, tests, dependencies, source maps, and downloaded editor runtimes must stay out of the archive.

Before distributing the VSIX:

1. Review the final Git diff, version, and changelog. Keep `package.json` and `package-lock.json` versions in sync; `npm version <version> --no-git-tag-version` updates both without creating a commit or tag.
2. Install the generated `branch-diff-<version>.vsix` in an isolated VS Code profile and confirm the sidebar, branch selection, diffs, and marker toggle work. Development-host tests do not prove installation of the archive.
3. Confirm the correct publisher and version are embedded in the archive. Publishing the wrong extension ID cannot be fixed by changing a display name.
4. Publish only after explicit release approval, using the verified VSIX and Marketplace credentials kept outside this repository.
