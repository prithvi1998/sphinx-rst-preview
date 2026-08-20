#!/usr/bin/env python3
from __future__ import annotations

import hashlib
import io
import json
import os
import re
import shutil
import sys
import tempfile
import traceback
from pathlib import Path

CACHE_ROOT = Path(tempfile.gettempdir()) / "rst-preview-cache"
SYNC_IGNORE = {"_build", ".venv", "node_modules", ".git"}

BODY_RE = re.compile(r"(?is)<body[^>]*>(.*)</body>")
ANSI_RE = re.compile(r"\x1b\[[0-9;]*m")
STYLESHEET_LINK_RE = re.compile(r'(?i)<link[^>]+rel="stylesheet"[^>]*>')
HREF_RE = re.compile(r'(?i)href="([^"]+)"')
CSS_IMPORT_RE = re.compile(r'@import\s+url\(["\']?([^"\')]+)["\']?\)\s*;')
SYSTEM_MESSAGE_RE = re.compile(r'(?is)<(div|aside)\b[^>]*\bclass="[^"]*\bsystem-message\b[^"]*"[^>]*>.*?</\1>\s*')


def strip_system_messages(html: str) -> str:
    """Docutils/Sphinx embed warning/error nodes inline in the document
    regardless of report_level; the extension surfaces the same messages
    through its own showWarnings-gated list, so drop the inline copies."""
    return SYSTEM_MESSAGE_RE.sub("", html)


def collect_theme_css(html: str, html_path: Path) -> str:
    """Inline the stylesheets the built page links, in link order, so the
    preview uses whatever theme the project's conf.py configures."""
    chunks = []
    for link in STYLESHEET_LINK_RE.findall(html):
        href_match = HREF_RE.search(link)
        if not href_match:
            continue
        href = href_match.group(1).split("?")[0]
        if href.startswith(("http:", "https:", "//")):
            continue
        css_path = (html_path.parent / href).resolve()
        if not css_path.is_file():
            continue
        text = css_path.read_text(encoding="utf-8", errors="replace")

        def inline_import(match: re.Match, base: Path = css_path.parent) -> str:
            imported = (base / match.group(1).split("?")[0]).resolve()
            if imported.is_file():
                return imported.read_text(encoding="utf-8", errors="replace")
            return ""

        chunks.append(CSS_IMPORT_RE.sub(inline_import, text))
    return "\n".join(chunks)


def clean_warnings(raw: str) -> list[str]:
    lines = [ANSI_RE.sub("", line) for line in raw.splitlines()]
    warnings = [line for line in lines if line.strip()]
    # Sphinx sometimes logs the same docutils warning twice; keep one.
    seen: set[str] = set()
    return [w for w in warnings if not (w in seen or seen.add(w))]


def find_sphinx_project(source_path: Path) -> Path | None:
    for parent in [source_path.parent, *source_path.parents]:
        if (parent / "conf.py").is_file():
            return parent
    return None


def render_with_docutils(source: str, source_path: Path | None) -> dict:
    from docutils.core import publish_parts

    warning_stream = io.StringIO()
    parts = publish_parts(
        source=source,
        source_path=str(source_path) if source_path else None,
        writer_name="html5",
        settings_overrides={
            "report_level": 1,
            "halt_level": 5,
            "warning_stream": warning_stream,
            "doctitle_xform": True,
            "initial_header_level": 1,
            "output_encoding": "unicode",
            "embed_stylesheet": False,
            "stylesheet_path": None,
        },
    )

    warnings = clean_warnings(warning_stream.getvalue())
    base = str(source_path.parent) if source_path else ""
    html = strip_system_messages(parts.get("body", ""))
    return {"html": html, "warnings": warnings, "mode": "docutils", "base": base, "root": base}


def sync_project(src_root: Path, dst_root: Path) -> None:
    """Mirror src_root into dst_root, copying only new or changed files and
    pruning files that no longer exist, so refreshes skip the full copy."""
    seen: set[Path] = set()

    for dirpath, dirnames, filenames in os.walk(src_root):
        dirnames[:] = [d for d in dirnames if d not in SYNC_IGNORE]
        rel = Path(dirpath).relative_to(src_root)
        (dst_root / rel).mkdir(parents=True, exist_ok=True)
        for name in filenames:
            src = Path(dirpath) / name
            dst = dst_root / rel / name
            seen.add(rel / name)
            try:
                src_stat = src.stat()
            except OSError:
                continue
            try:
                dst_stat = dst.stat()
                if (dst_stat.st_mtime_ns, dst_stat.st_size) == (src_stat.st_mtime_ns, src_stat.st_size):
                    continue
            except OSError:
                pass
            shutil.copy2(src, dst)

    for dirpath, dirnames, filenames in os.walk(dst_root, topdown=False):
        rel = Path(dirpath).relative_to(dst_root)
        for name in filenames:
            if (rel / name) not in seen:
                (Path(dirpath) / name).unlink(missing_ok=True)
        for name in dirnames:
            try:
                (Path(dirpath) / name).rmdir()  # only removes now-empty dirs
            except OSError:
                pass


def render_with_sphinx(source: str, source_path: Path, project_root: Path) -> dict:
    from sphinx.application import Sphinx

    # Persistent per-project cache: mirror the project once, then let Sphinx
    # rebuild incrementally instead of copying + rebuilding everything per
    # refresh.
    cache_key = hashlib.sha1(str(project_root).encode("utf-8")).hexdigest()[:16]
    cache_dir = CACHE_ROOT / cache_key
    cache_dir.mkdir(parents=True, exist_ok=True)

    lock_file = open(cache_dir / "lock", "w")
    try:
        try:
            import fcntl

            fcntl.flock(lock_file, fcntl.LOCK_EX)  # serialize concurrent refreshes
        except ImportError:
            pass

        def build() -> io.StringIO:
            src_dir = cache_dir / "src"
            outdir = cache_dir / "html"
            doctreedir = cache_dir / "doctrees"
            sync_project(project_root, src_dir)
            temp_source_path = src_dir / source_path.relative_to(project_root)
            temp_source_path.parent.mkdir(parents=True, exist_ok=True)
            temp_source_path.write_text(source, encoding="utf-8")
            outdir.mkdir(parents=True, exist_ok=True)
            doctreedir.mkdir(parents=True, exist_ok=True)

            warning_stream = io.StringIO()
            app = Sphinx(
                srcdir=str(src_dir),
                confdir=str(src_dir),
                outdir=str(outdir),
                doctreedir=str(doctreedir),
                buildername="html",
                confoverrides={},
                status=io.StringIO(),
                warning=warning_stream,
                freshenv=False,
            )
            app.build()
            return warning_stream

        try:
            warning_stream = build()
        except Exception:
            # A stale or corrupted cache can wedge incremental builds;
            # retry once from scratch before giving up.
            shutil.rmtree(cache_dir, ignore_errors=True)
            cache_dir.mkdir(parents=True, exist_ok=True)
            warning_stream = build()

        relative_html = source_path.relative_to(project_root).with_suffix(".html")
        html_path = cache_dir / "html" / relative_html
        if not html_path.exists():
            # Sphinx sometimes places files at the root for top-level docs.
            html_path = cache_dir / "html" / (source_path.stem + ".html")
        html = html_path.read_text(encoding="utf-8")
        css = collect_theme_css(html, html_path)
    finally:
        lock_file.close()

    body_match = BODY_RE.search(html)
    body = body_match.group(1).strip() if body_match else html
    body = strip_system_messages(body)
    warnings = clean_warnings(warning_stream.getvalue())
    return {
        "html": body,
        "warnings": warnings,
        "mode": "sphinx",
        "css": css,
        # Image srcs in the page are relative to the built page's directory;
        # the html root bounds what the webview may load.
        "base": str(html_path.parent),
        "root": str(cache_dir / "html"),
    }


def main() -> int:
    # The extension pipes the document in as UTF-8 and parses stdout as
    # UTF-8 JSON. Never trust the locale default (cp1252 on Windows), which
    # mangles em dashes, box-drawing characters, and other non-ASCII text.
    sys.stdin.reconfigure(encoding="utf-8", errors="replace")
    sys.stdout.reconfigure(encoding="utf-8")

    source_path = Path(sys.argv[1]).resolve() if len(sys.argv) > 1 and sys.argv[1] else None
    source = sys.stdin.read()

    try:
        if source_path is not None:
            project_root = find_sphinx_project(source_path)
            if project_root is not None:
                try:
                    import sphinx  # noqa: F401
                    result = render_with_sphinx(source, source_path, project_root)
                    print(json.dumps(result))
                    return 0
                except Exception:
                    # Fall back to docutils if Sphinx rendering fails for any reason.
                    pass

        result = render_with_docutils(source, source_path)
        print(json.dumps(result))
        return 0
    except Exception as exc:
        print(json.dumps({"error": f"{exc.__class__.__name__}: {exc}", "traceback": traceback.format_exc()}))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
