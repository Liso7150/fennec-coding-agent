"""Secondary center-pane views: My Attention, Search, and New Task."""
from __future__ import annotations

from . import esc
from .icons import svg


def attention_html(tasks: list[dict]) -> str:
    cards = []
    for task in tasks:
        if not task.get("attention_note"):
            continue
        chip_class = "danger" if task["status"] == "attention" else "warn"
        cards.append(
            '<div class="attention-card">'
            f'<div class="att-top"><span class="status-dot {esc(task["status"])}"></span>'
            f'<span class="att-title">{esc(task["title"])}</span>'
            f'<span class="chip {chip_class}">{esc(task.get("attention_label", "Warning"))}</span></div>'
            f'<p class="att-note">{esc(task["attention_note"])}</p>'
            '<div class="att-actions">'
            f'<button class="btn small" data-task="{esc(task["id"])}">Open task</button>'
            '<button class="btn ghost small" data-toast="Snoozed for 1 hour (demo).">Snooze</button>'
            "</div></div>"
        )
    count = len(cards)
    return (
        '<div class="view"><div class="view-head"><h2>My Attention</h2>'
        f"<p>{count} items need your review before the agent can continue.</p></div>"
        f'<div class="attention-list">{"".join(cards)}</div></div>'
    )


SEARCH_RESULTS = [
    ("agent_runner.py", "components/agent_runner.py · modified 12m ago", "File",
     {"action": "artifact", "artifact": "agent_runner.py"}),
    ("components/task_timeline.py", "components/task_timeline.py · added 2h ago", "File",
     {"action": "artifact", "artifact": "components/task_timeline.py"}),
    ("README.md", "README.md · added 3h ago", "File",
     {"action": "artifact", "artifact": "README.md"}),
    ("Optimize local Colibri model", "Running · 2m ago · colibri-desktop", "Task",
     {"task": "optimize"}),
    ("Fix streaming response state", "Needs attention · 3h ago", "Task",
     {"task": "streaming"}),
]


def search_html() -> str:
    rows = []
    for title, meta, kind, attrs in SEARCH_RESULTS:
        action = ""
        if "task" in attrs:
            action = f'data-task="{attrs["task"]}"'
        else:
            action = f'data-action="artifact" data-artifact="{esc(attrs["artifact"])}"'
        rows.append(
            f'<button class="search-result" {action} data-search="{esc(title + " " + meta)}">'
            f'{svg("file" if kind == "File" else "code")}'
            f'<span><span class="sr-title">{esc(title)}</span>'
            f'<span class="sr-meta">{esc(meta)}</span></span>'
            f'<span class="sr-kind">{kind}</span></button>'
        )
    rows.append(
        '<a class="search-result" href="https://pyinstaller.org/en/stable/" target="_blank" '
        'rel="noopener" data-search="PyInstaller documentation desktop packaging doc">'
        f'{svg("book")}<span><span class="sr-title">PyInstaller documentation</span>'
        '<span class="sr-meta">pyinstaller.org · desktop packaging</span></span>'
        f'<span class="sr-kind">Doc</span></a>'
    )
    return (
        '<div class="view search-view"><div class="view-head"><h2>Search</h2>'
        "<p>Search across files, tasks, and runtime notes in the local workspace.</p></div>"
        f'<div class="search-box">{svg("search")}'
        '<input id="searchInput" placeholder="Search code, tasks, and docs" autocomplete="off"></div>'
        '<div class="search-hint">Local index · 1,284 files</div>'
        f'<div class="search-results" id="searchResults">{"".join(rows)}</div>'
        '<div class="empty-note" id="searchEmpty" style="display:none">'
        "No matches in the local index.</div></div>"
    )


STARTERS = [
    ("code", "Map the runtime",
     "Inspect this repository and summarize the runtime architecture."),
    ("check-circle", "Fix failing tests",
     "Find failing tests and fix the root cause without changing behavior."),
    ("search", "Add code search",
     "Add a repository indexer for natural-language code search."),
]


def new_task_html() -> str:
    cards = "".join(
        f'<button class="starter" data-starter="{esc(prompt)}">{svg(icon)}'
        f"<b>{esc(title)}</b><span>{esc(prompt)}</span></button>"
        for icon, title, prompt in STARTERS
    )
    return (
        '<div class="view new-view"><div class="new-orb">C</div>'
        "<h2>Start a coding task</h2>"
        "<p>Describe a change, a bug, or a verification goal. Colibri will plan, edit, "
        "run tests, and report back in this timeline.</p>"
        f'<div class="starter-grid">{cards}</div></div>'
    )
