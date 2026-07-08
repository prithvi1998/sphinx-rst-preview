# RST Preview

Live preview for reStructuredText (`.rst`) files in VS Code, rendered with the real Python toolchain — full Sphinx builds when the file belongs to a Sphinx project, plain docutils otherwise.

## Features

- **Faithful Sphinx rendering** — if the previewed file has a `conf.py` in an ancestor directory, the preview runs an actual Sphinx build of the project, so toctrees, cross-references (`:doc:`, `:ref:`), and Sphinx directives all resolve correctly.
- **Uses your project's theme** — the preview picks up whatever `html_theme` the project's `conf.py` configures (sphinxdoc, alabaster, …) and renders with that theme's real stylesheets, in any VS Code color theme.
- **Fast refreshes** — a persistent per-project build cache means only the first preview pays for a full build; subsequent refreshes rebuild incrementally (typically ~1s on a 50-document project).
- **Live updates** — the preview refreshes as you type (debounced), on save, and when you switch between `.rst` editors. Scroll position is preserved per document across refreshes.
- **Images** — relative image references render, including images Sphinx copies into the build output.
- **Docutils fallback** — standalone `.rst` files (no Sphinx project) render via docutils with the classic sphinxdoc look.

## Usage

- Open an `.rst` file and click the preview icon in the editor title bar, or press `Ctrl+Shift+V` (`Cmd+Shift+V` on Mac), or run **RST: Open Preview** from the command palette.
- The preview opens beside the editor and follows whichever `.rst` file is active.

## Requirements

- Python 3 with `docutils` installed; `sphinx` as well if you want full Sphinx-mode rendering:
  ```bash
  python3 -m pip install docutils sphinx
  ```
- Any Sphinx theme or extension a project's `conf.py` uses must be installed in that Python environment, otherwise the preview falls back to docutils rendering.

## Settings

| Setting | Default | Description |
|---|---|---|
| `rstPreview.pythonPath` | `python3` | Python executable used to run docutils/Sphinx. Point this at a project venv if that's where docutils/Sphinx live. |
| `rstPreview.showWarnings` | `false` | Show docutils/Sphinx build warnings above the rendered preview. |

## Notes

- The Sphinx build cache lives under the system temp directory (`rst-preview-cache/`); it is rebuilt automatically if cleaned.
- Links to other documents in the preview (toctree entries, cross-references) are rendered but not yet clickable-navigable.

## Development

```bash
npm install
npm run compile   # or: npm run watch
```

Press `F5` to launch the Extension Development Host.
