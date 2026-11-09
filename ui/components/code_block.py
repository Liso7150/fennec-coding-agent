"""Lightweight Python/text code rendering with line numbers and copy support."""
from __future__ import annotations

import re

from . import esc
from .icons import svg

_TOKEN_RE = re.compile(
    r"(#[^\n]*)"
    r"|(\"(?:[^\"\\]|\\.)*\"|'(?:[^'\\]|\\.)*')"
    r"|(\b(?:class|def|async|await|for|in|if|elif|else|return|import|from|None|True|False|self|"
    r"lambda|with|as|pass|raise|not|and|or|while|try|except|yield|match|case|Literal)\b)"
    r"|(\b\d+(?:\.\d+)?\b)"
    r"|(\b[A-Za-z_][A-Za-z0-9_]*(?=\())"
)


def _highlight_line(src: str) -> str:
    out, pos = [], 0
    for match in _TOKEN_RE.finditer(src):
        out.append(esc(src[pos:match.start()]))
        token = match.group(0)
        if match.group(1):
            cls = "tok-c"
        elif match.group(2):
            cls = "tok-s"
        elif match.group(3):
            cls = "tok-k"
        elif match.group(4):
            cls = "tok-n"
        else:
            cls = "tok-f"
        out.append(f'<span class="{cls}">{esc(token)}</span>')
        pos = match.end()
    out.append(esc(src[pos:]))
    return "".join(out)


def render_code(filename: str, source: str, start: int = 1, head: bool = True) -> str:
    rows = []
    for number, line in enumerate(source.split("\n"), start):
        rows.append(
            f'<div class="row"><span class="ln">{number}</span>'
            f'<span class="src">{_highlight_line(line) or " "}</span></div>'
        )
    header = (
        f'<div class="code-head">{svg("file")}'
        f'<span class="code-file">{esc(filename)}</span>'
        f'<button class="copy-btn" data-action="copy">{svg("copy")}Copy</button></div>'
        if head else ""
    )
    return (
        f'<div class="code-card">{header}<pre class="code">{"".join(rows)}</pre>'
        f'<textarea class="copy-src" hidden>{esc(source)}</textarea></div>'
    )
