import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';
import * as vscode from 'vscode';

type RenderResult = {
  html?: string;
  warnings?: string[];
  error?: string;
  traceback?: string;
  mode?: 'sphinx' | 'docutils';
  css?: string;
  base?: string;
  root?: string;
};

let previewPanel: vscode.WebviewPanel | undefined;
let currentSourceUri: vscode.Uri | undefined;
let refreshTimer: NodeJS.Timeout | undefined;
let themeCss = '';
let renderInFlight = false;
let renderQueued = false;

export function activate(context: vscode.ExtensionContext): void {
  const scriptPath = context.asAbsolutePath(path.join('python', 'render_rst.py'));
  themeCss = loadThemeCss(context);

  const openPreviewCommand = vscode.commands.registerCommand('rstPreview.openPreview', async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      vscode.window.showInformationMessage('Open an .rst file first.');
      return;
    }

    if (!isRstFile(editor.document)) {
      vscode.window.showWarningMessage('RST Preview is intended for .rst files.');
    }

    currentSourceUri = editor.document.uri;

    if (!previewPanel) {
      previewPanel = vscode.window.createWebviewPanel(
        'rstPreview',
        makePreviewTitle(editor.document.uri),
        vscode.ViewColumn.Beside,
        {
          enableScripts: true,
          retainContextWhenHidden: true,
        },
      );

      previewPanel.onDidDispose(() => {
        previewPanel = undefined;
        currentSourceUri = undefined;
      });
    } else {
      previewPanel.title = makePreviewTitle(editor.document.uri);
      previewPanel.reveal(vscode.ViewColumn.Beside);
    }

    await refreshPreview(previewPanel, scriptPath);
  });

  const saveListener = vscode.workspace.onDidSaveTextDocument(async (document) => {
    if (!previewPanel || !currentSourceUri) {
      return;
    }

    if (document.uri.toString() !== currentSourceUri.toString()) {
      return;
    }

    await refreshPreview(previewPanel, scriptPath);
  });

  const editorListener = vscode.window.onDidChangeActiveTextEditor(async (editor) => {
    if (!editor || !previewPanel) {
      return;
    }

    if (!isRstFile(editor.document)) {
      return;
    }

    currentSourceUri = editor.document.uri;
    previewPanel.title = makePreviewTitle(editor.document.uri);
    await refreshPreview(previewPanel, scriptPath);
  });

  const changeListener = vscode.workspace.onDidChangeTextDocument((event) => {
    if (!previewPanel || !currentSourceUri) {
      return;
    }

    if (event.document.uri.toString() !== currentSourceUri.toString()) {
      return;
    }

    if (!isRstFile(event.document)) {
      return;
    }

    scheduleRefresh(scriptPath);
  });

  context.subscriptions.push(openPreviewCommand, saveListener, editorListener, changeListener);
}

export function deactivate(): void {
  previewPanel?.dispose();
  previewPanel = undefined;
  currentSourceUri = undefined;
}

function loadThemeCss(context: vscode.ExtensionContext): string {
  // Order matters: basic.css first, then the theme, then Pygments —
  // the same cascade a built Sphinx page uses.
  const files = ['basic.css', 'sphinxdoc.css', 'graphviz.css', 'pygments.css'];
  const chunks: string[] = [];

  for (const file of files) {
    const cssPath = context.asAbsolutePath(path.join('media', file));
    try {
      chunks.push(fs.readFileSync(cssPath, 'utf8'));
    } catch {
      // Missing stylesheet: render unstyled rather than fail the preview.
    }
  }

  return chunks.join('\n');
}

function isRstFile(document: vscode.TextDocument): boolean {
  return document.fileName.toLowerCase().endsWith('.rst');
}

function makePreviewTitle(uri: vscode.Uri): string {
  return `RST Preview: ${path.basename(uri.fsPath)}`;
}

function scheduleRefresh(scriptPath: string): void {
  if (refreshTimer) {
    clearTimeout(refreshTimer);
  }

  refreshTimer = setTimeout(() => {
    if (previewPanel) {
      void refreshPreview(previewPanel, scriptPath);
    }
  }, 250);
}

async function refreshPreview(panel: vscode.WebviewPanel, scriptPath: string): Promise<void> {
  // Renders share a per-project build cache, so run one at a time; a refresh
  // requested mid-render coalesces into a single follow-up run.
  if (renderInFlight) {
    renderQueued = true;
    return;
  }

  if (!currentSourceUri) {
    panel.webview.html = renderErrorHtml('No file selected.');
    return;
  }

  const document = await vscode.workspace.openTextDocument(currentSourceUri);
  const pythonPath = vscode.workspace.getConfiguration('rstPreview').get<string>('pythonPath', 'python3');
  const source = document.getText();

  renderInFlight = true;
  try {
    const result = await renderWithDocutils(pythonPath, scriptPath, source, document.uri.fsPath);

    const resourceRoots = [vscode.Uri.file(result.root || path.dirname(document.uri.fsPath))];
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      resourceRoots.push(folder.uri);
    }
    panel.webview.options = { enableScripts: true, localResourceRoots: resourceRoots };

    panel.webview.html = buildWebviewHtml(panel.webview, document.uri, result);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    panel.webview.html = renderErrorHtml(message);
  } finally {
    renderInFlight = false;
    if (renderQueued) {
      renderQueued = false;
      if (previewPanel) {
        void refreshPreview(previewPanel, scriptPath);
      }
    }
  }
}

function renderWithDocutils(
  pythonPath: string,
  scriptPath: string,
  source: string,
  sourcePath: string,
): Promise<RenderResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(pythonPath, [scriptPath, sourcePath], {
      cwd: path.dirname(sourcePath),
      env: {
        ...process.env,
      },
    });

    let stdout = '';
    let stderr = '';

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');

    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });

    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });

    child.on('error', reject);

    child.on('close', (code) => {
      if (code !== 0 && !stdout.trim()) {
        reject(new Error(stderr.trim() || `docutils exited with code ${code}`));
        return;
      }

      try {
        const parsed = JSON.parse(stdout) as RenderResult;
        if (parsed.error) {
          reject(new Error(parsed.error));
          return;
        }
        resolve(parsed);
      } catch (error) {
        reject(new Error(`Could not parse docutils output: ${stdout || stderr}`));
      }
    });

    child.stdin.end(source, 'utf8');
  });
}

function makeNonce(): string {
  let nonce = '';
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) {
    nonce += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return nonce;
}

function rewriteImageSources(html: string, webview: vscode.Webview, baseDir: string): string {
  return html.replace(/(<img\b[^>]*?\bsrc=")([^"]+)(")/gi, (match, prefix, src, suffix) => {
    if (/^(https?:|data:|vscode-webview-resource:|file:|\/\/)/i.test(src)) {
      return match;
    }
    const resolved = path.resolve(baseDir, decodeURIComponent(src));
    return prefix + webview.asWebviewUri(vscode.Uri.file(resolved)).toString() + suffix;
  });
}

function buildWebviewHtml(webview: vscode.Webview, uri: vscode.Uri, result: RenderResult): string {
  const showWarnings = vscode.workspace.getConfiguration('rstPreview').get<boolean>('showWarnings', false);
  const warnings = showWarnings ? result.warnings ?? [] : [];
  const sourceName = path.basename(uri.fsPath);
  const baseDir = result.base || path.dirname(uri.fsPath);
  const rawContent = result.html ?? '<p><em>The document rendered without body output.</em></p>';
  const content = rewriteImageSources(rawContent, webview, baseDir);
  const nonce = makeNonce();

  // Sphinx mode ships the stylesheets of whatever theme the project's
  // conf.py configures; the bundled sphinxdoc CSS is the fallback for
  // standalone docutils renders.
  const projectCss = result.css?.trim();
  const pageCss = projectCss || themeCss;

  // Reuse the theme's own warning admonition so docutils messages look native.
  const warningHtml = warnings.length
    ? `
      <div class="admonition warning">
        <p class="admonition-title">Warning</p>
        <ul>
          ${warnings.map((warning) => `<li>${escapeHtml(warning)}</li>`).join('')}
        </ul>
      </div>
    `
    : '';

  // Sphinx mode returns the full page body (related bars, sidebar, footer)
  // already wrapped in the theme's layout. Docutils mode returns bare body
  // content, so recreate the skeleton a sphinxdoc page uses.
  const bodyHtml = result.mode === 'sphinx'
    ? `${warningHtml}${content}`
    : `
      <div class="document">
        <div class="documentwrapper">
          <div class="bodywrapper preview-no-sidebar">
            <div class="body" role="main">
              ${warningHtml}${content}
            </div>
          </div>
        </div>
        <div class="clearer"></div>
      </div>
    `;

  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; img-src ${webview.cspSource} data:;" />
    <title>${escapeHtml(sourceName)}</title>
    <style>
${pageCss}
    </style>
    <style>
      /* Preview-only adjustments; everything above is the untouched theme. */

      /* Docutils fallback has no sidebar, so drop the space reserved for it. */
      div.bodywrapper.preview-no-sidebar {
        margin-right: 0;
        border-right: none;
      }

      /* Themes assume a full browser window; relax fixed page gutters when
         the preview column is narrow. */
      @media (max-width: 900px) {
        html body {
          margin: 0 10px;
          min-width: 0;
        }
      }
    </style>
  </head>
  <body>
${bodyHtml}
    <script nonce="${nonce}">
      // VS Code injects a default stylesheet (id "_defaultStyles") AFTER
      // extension styles; in dark editor themes it repaints bare code/
      // blockquote/body elements. Remove it so the Sphinx theme renders
      // exactly as in a browser, and keep removing it if it is re-added.
      (function () {
        var kill = function () {
          var node = document.getElementById('_defaultStyles');
          if (node) { node.remove(); }
        };
        kill();
        new MutationObserver(kill).observe(document.head, { childList: true });
      })();

      // Each refresh replaces the whole document, which resets the scroll
      // position. Webview state survives that, so keep a per-document map
      // of scroll offsets and restore on load.
      (function () {
        if (typeof acquireVsCodeApi !== 'function') { return; }
        var vscodeApi = acquireVsCodeApi();
        var doc = ${JSON.stringify(uri.toString())};
        var state = vscodeApi.getState() || {};
        var positions = state.scrollPositions || {};

        var saved = positions[doc];
        if (typeof saved === 'number' && saved > 0) {
          window.scrollTo(0, saved);
          // Late layout shifts (e.g. images sizing in) can eat the first
          // restore; reapply once everything has loaded.
          window.addEventListener('load', function () { window.scrollTo(0, saved); });
        }

        var saveTimer;
        window.addEventListener('scroll', function () {
          if (saveTimer) { clearTimeout(saveTimer); }
          saveTimer = setTimeout(function () {
            positions[doc] = window.scrollY;
            vscodeApi.setState({ scrollPositions: positions });
          }, 100);
        }, { passive: true });
      })();
    </script>
  </body>
</html>`;
}

function renderErrorHtml(message: string): string {
  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';" />
    <style>
      body {
        margin: 0;
        padding: 24px;
        font-family: var(--vscode-font-family, sans-serif);
        color: var(--vscode-editor-foreground);
        background: var(--vscode-editor-background);
      }

      .error-shell {
        max-width: 900px;
        margin: 0 auto;
        border: 1px solid var(--vscode-inputValidation-errorBorder, #c60f0f);
        background: var(--vscode-inputValidation-errorBackground, transparent);
        padding: 16px 20px;
      }

      h1 {
        margin: 0 0 8px;
        font-size: 18px;
      }

      pre {
        overflow: auto;
        white-space: pre-wrap;
        padding: 12px;
        background: var(--vscode-textCodeBlock-background, rgba(128, 128, 128, 0.1));
        font-family: var(--vscode-editor-font-family, monospace);
      }

      .hint {
        color: var(--vscode-descriptionForeground);
      }
    </style>
  </head>
  <body>
    <div class="error-shell">
      <h1>RST Preview couldn’t render this document</h1>
      <pre>${escapeHtml(message)}</pre>
      <p class="hint">Tip: set <code>rstPreview.pythonPath</code> to your project venv Python if docutils/Sphinx is installed there.</p>
    </div>
  </body>
</html>`;
}

function escapeHtml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
