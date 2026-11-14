# Community-directory submission

The repository owner submits the plugin; publication of a GitHub release alone does not add it to the Obsidian directory.

## First beta

- Repository: `committed-sins/obsidian-plugin-revision-marks`
- Plugin ID: `revision-marks`
- Version/tag: `0.1.7`
- License: MIT
- Release assets: `main.js`, `manifest.json`, `styles.css`
- Beta identification: README, plugin description, settings introduction and release notes.

The manifest uses a plain `x.y.z` version for Obsidian compatibility. The Community publisher requires a regular GitHub release matching that version; do not mark it as a prerelease. Beta status stays explicit in the text rather than the version or GitHub release flag. The build embeds the MIT license in `main.js` so installed copies retain the notice.

## Submit

1. Sign in at [Obsidian Community](https://community.obsidian.md/) and link the GitHub account that can manage this repository.
2. Use the portal's add-plugin flow and select the repository. The directory reads the root `manifest.json` from the default branch.
3. Verify the displayed name, description, minimum Obsidian version and release assets, then submit/publish from the portal yourself.
4. Address any automated review feedback before availability in the directory. Report the beta/live-test limitations accurately.

See Obsidian's [current submission guide](https://docs.obsidian.md/plugins/releasing/submit-plugin). Until accepted, the GitHub release supports manual installation; modern BRAT can also install prereleases.

## Later releases

Update `manifest.json`, `package.json`, `package-lock.json`, `versions.json` and the changelog. Run `npm run check`, commit with a verified signature and push a matching version tag. Wait for **Build and attest** to succeed, then download that run's `revision-marks-<commit>` artifact and attach its three files to the regular GitHub release. Do not substitute a separate local build: its bytes may differ and therefore lack the CI attestation. Never include settings, recovery data or vault notes.

The workflow also runs on `main` and can be started manually. It checks out its own source commit, installs the locked dependencies, runs formatting/build/tests, then uses GitHub's artifact attestation action for all three generated files. No release or existing asset is overwritten automatically. Actions are pinned to commit IDs; the job has read-only repository access plus only the OIDC/attestation permissions needed for provenance.

Git attributes make source and copied-asset line endings consistent on Windows and Linux, retaining the existing CRLF assets and LF license banner. An older release can gain a verifiable rebuild without replacing assets only when its downloaded files have exactly the same digests as the attested build. The attestation identifies the rebuild's workflow commit; it does not rewrite the original tag or the historical upload event.

Verify downloads, not just the local build:

```sh
gh release download 0.1.7 -R committed-sins/obsidian-plugin-revision-marks
gh attestation verify main.js -R committed-sins/obsidian-plugin-revision-marks
gh attestation verify manifest.json -R committed-sins/obsidian-plugin-revision-marks
gh attestation verify styles.css -R committed-sins/obsidian-plugin-revision-marks
```

See GitHub's [artifact attestation documentation](https://docs.github.com/en/actions/how-tos/secure-your-work/use-artifact-attestations/use-artifact-attestations). Provenance is evidence of a source build, not a guarantee of functional correctness. Keep future release notes focused on changes, fixes and relevant known issues. Omit the generic notice that Android has not yet been tested; do not claim live validation unless it has actually been performed.
