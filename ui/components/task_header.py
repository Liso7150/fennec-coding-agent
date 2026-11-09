"""Task header: breadcrumb, title, status line, and actions."""
from __future__ import annotations

from . import esc
from .icons import svg


def render_header(title: str, status_line: str, status: str, status_label: str,
                  repo: str = "colibri-desktop", branch: str = "feat/agent-shell") -> str:
    return (
        f'<div class="crumbs"><span>{esc(repo)}</span><span>/</span>'
        f'<span class="branch">{svg("git-branch")}{esc(branch)}</span></div>'
        '<div class="title-row"><div class="title-left">'
        f'<h1 class="task-title-main">{esc(title)}</h1>'
        f'<p class="task-status-line">{esc(status_line)}</p>'
        "</div>"
        '<div class="header-actions">'
        f'<span class="pill {esc(status)}"><span class="pulse"></span>{esc(status_label)}</span>'
        f'<button class="icon-btn" data-action="share" title="Share" aria-label="Share">{svg("share")}</button>'
        f'<button class="icon-btn" data-action="more" title="More" aria-label="More actions">{svg("more")}</button>'
        f'<button class="icon-btn ctx-toggle" data-action="ctx-toggle" title="Context" aria-label="Open context">{svg("panel")}</button>'
        f'<button class="icon-btn menu-toggle" data-action="menu-toggle" title="Menu" aria-label="Open menu">{svg("menu")}</button>'
        '<div class="menu" id="moreMenu">'
        f'<button data-action="rename">{svg("edit")}Rename task</button>'
        f'<button data-action="duplicate">{svg("copy")}Duplicate task</button>'
        f'<button data-action="export">{svg("external")}Export session log</button>'
        '<div class="sep"></div>'
        f'<button class="danger" data-action="clear">{svg("x")}Clear transcript</button>'
        "</div>"
        "</div></div>"
    )
