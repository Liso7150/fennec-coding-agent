"""Expandable tool activity card."""
from __future__ import annotations

from . import esc
from .icons import svg

KIND_ICON = {
    "read": "file",
    "inspect": "folder-search",
    "edit": "edit",
    "run": "terminal",
    "test": "check-circle",
    "doc": "book",
    "search": "search",
}

STATUS_LABEL = {
    "complete": "Complete",
    "running": "Running",
    "warning": "Warning",
    "failed": "Failed",
}


def render_tool(event: dict) -> str:
    status = event["status"]
    icon = svg(KIND_ICON.get(event["kind"], "terminal"))
    label = STATUS_LABEL.get(status, status.title())
    return (
        f'<details class="tool-card {esc(status)}">'
        "<summary>"
        f'<span class="tool-ico">{icon}</span>'
        '<span class="tool-main">'
        f'<span class="tool-kicker">{esc(event["label"])} · {esc(event["time"])}</span>'
        f'<span class="tool-title">{esc(event["title"])}</span>'
        f'<span class="tool-preview">{esc(event["preview"])}</span>'
        "</span>"
        '<span class="tool-side">'
        f'<span class="tool-status {esc(status)}"><span class="dot"></span>{esc(label)}</span>'
        f'<span class="tool-dur">{esc(event["duration"])}</span>'
        f'{svg("chevron-down", "chev")}'
        "</span>"
        "</summary>"
        f'<div class="tool-body"><pre class="tool-output">{event["output_html"]}</pre></div>'
        "</details>"
    )
