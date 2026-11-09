"""Presentation helpers shared by all component modules."""
from __future__ import annotations

import html


def esc(value) -> str:
    return html.escape(str(value), quote=True)


def mono(value) -> str:
    return f'<span class="mono">{esc(value)}</span>'
