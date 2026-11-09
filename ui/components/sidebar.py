"""Left sidebar: brand, workspace, navigation, recent tasks, repo context."""
from __future__ import annotations

from . import esc
from .icons import svg

NAV = [
    ("coding", "code", "Coding", ""),
    ("new", "plus", "New Task", ""),
    ("attention", "attention", "My Attention", '<span class="nav-badge">2</span>'),
    ("search", "search", "Search", '<span class="kbd">⌘K</span>'),
]


def render_sidebar(tasks: list[dict], active_id: str) -> str:
    nav = "".join(
        f'<button class="nav-item{" active" if key == "coding" else ""}" data-view="{key}">'
        f"{svg(icon)}<span>{label}</span>{badge}</button>"
        for key, icon, label, badge in NAV
    )
    rows = "".join(
        f'<button class="task-row{" active" if task["id"] == active_id else ""}" '
        f'data-task="{esc(task["id"])}">'
        f'<span class="status-dot {esc(task["status"])}"></span>'
        '<span class="task-text">'
        f'<span class="task-title">{esc(task["title"])}</span>'
        f'<span class="task-meta">{esc(task["meta"])}</span>'
        "</span></button>"
        for task in tasks
    )
    return (
        '<aside class="left" id="leftPane">'
        '<div class="brand">'
        f'<div class="logo">{svg("logo")}</div>'
        '<div><div class="brand-name">Colibri</div><div class="brand-sub">Coding Agent</div></div>'
        "</div>"
        f'<button class="ws-select" data-toast="Workspace switching is simulated in this demo.">'
        '<span class="ws-dot"></span><span class="ws-name">Local workspace</span>'
        '<span class="ws-repo">colibri-desktop</span>'
        f'{svg("chevron-down")}</button>'
        f'<nav class="nav">{nav}</nav>'
        '<div class="section-label"><span>Recent tasks</span></div>'
        f'<div class="task-list">{rows}</div>'
        '<div class="sidebar-bottom">'
        '<div class="repo-card">'
        f'<div class="repo-row">{svg("folder")}<span>colibri-desktop</span></div>'
        f'<div class="repo-meta">{svg("git-branch")}<span>feat/agent-shell</span></div>'
        '<div class="repo-meta"><span class="wt-dot"></span><span>4 files changed</span></div>'
        "</div>"
        '<div class="profile" data-toast="Profile settings are simulated in this demo.">'
        '<div class="avatar">AM</div>'
        '<div><div class="p-name">Alex Morgan</div><div class="p-mode">Local mode</div></div>'
        f'{svg("chevron-right")}</div>'
        "</div>"
        "</aside>"
    )
