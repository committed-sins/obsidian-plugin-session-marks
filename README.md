# Revision Marks

**BETA · Requires Obsidian 1.15.0 or newer.**

Update timestamps and optional revision counts at the end of a meaningful editing session. Revision Marks compares actual content and waits until you leave or explicitly save a note, keeping metadata writes out of your typing flow. Unchanged content and complete undo produce no update.

## Features

- Track editor, Properties, Bases and external changes to Markdown notes.
- Configure the `created`, `updated` and `revision` property names; turn counting off if preferred.
- Fill an absent creation timestamp without replacing an existing value.
- Complete saved sessions on desktop quit; retain pending work for recovery.
- Preserve unrelated frontmatter and manually arranged complete property blocks.

## Install the beta

Manual installation:

1. Download `main.js`, `manifest.json` and `styles.css` from the [latest release](https://github.com/committed-sins/obsidian-plugin-revision-marks/releases/latest).
2. Place them in `<vault>/.obsidian/plugins/revision-marks/`.
3. Reload Obsidian and enable **Revision Marks** in Community plugins.

Disable other automatic writers of these properties first. Existing notes are not bulk-stamped or renamed. Test disposable notes before using a working vault. See the [beta test guide](docs/beta-testing.md).

## Settings

**Revision tracking:** Counter is the default; Off updates timestamps only and leaves existing revision values untouched. Property names are configurable, including `updated_count` for an existing counter. “Count file renames as revisions” is off by default. When enabled, file renames and moves join the current session; folder renames do not create revisions. Save and apply completes pending sessions under the old settings first.

No folders are excluded by default. Add your own vault-relative folders if needed; each entry excludes its subfolders too. Existing saved exclusions are preserved on update. Add your template folder if template source files should not be tracked; unrendered Templater expressions in frontmatter are deferred automatically.

**Complete current session**, **Complete all sessions** and explicit **Save current file / Ctrl+S** finish changed sessions. Autosave alone does not.

## Report a problem

Please [open an issue](https://github.com/committed-sins/obsidian-plugin-revision-marks/issues/new) with your Obsidian/plugin versions, platform and steps to reproduce.

## Development

Node.js 22+: run `npm ci`, then `npm run check` for formatting, build and tests. Use `npm run format` for the configured Allman style.

[Architecture](docs/architecture.md) · [Property rules](docs/properties.md) · [Development and compatibility](docs/development.md)

## License

[MIT](LICENSE) · Copyright © 2026 Michael J. Stallinger
