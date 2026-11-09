"""Mock environment, subagents, artifacts, and research links for the demo."""
from __future__ import annotations

ENVIRONMENT = [
    ("code", "Runtime", "Python 3.12.4", "mono"),
    ("layers", "Environment", ".venv / active", "mono"),
    ("folder", "Repository", "colibri-desktop", "mono"),
    ("git-branch", "Branch", "feat/agent-shell", "mono"),
    ("edit", "Working tree", "4 changed files", ""),
    ("check-circle", "Test suite", "Passing", "ok"),
    ("spark", "Local model", "Colibri Qwen3.6-35B-A3B", ""),
    ("clock", "Context window", "8k tokens", "mono"),
]

SUBAGENTS = [
    {"name": "Planner", "state": "complete", "detail": "Mapped packaging and runtime boundaries", "progress": None},
    {"name": "Implementation", "state": "working", "detail": "Updating task event pipeline", "progress": 64},
    {"name": "Verifier", "state": "waiting", "detail": "Ready to run startup checks", "progress": None},
]

ARTIFACTS = [
    {"name": "app.py", "action": "Modified", "kind": "py"},
    {"name": "agent_runner.py", "action": "Modified", "kind": "py"},
    {"name": "components/task_timeline.py", "action": "Added", "kind": "py"},
    {"name": "requirements.txt", "action": "Modified", "kind": "txt"},
    {"name": "README.md", "action": "Added", "kind": "md"},
]

SITES = [
    {"title": "Python Packaging User Guide", "domain": "packaging.python.org", "href": "https://packaging.python.org/"},
    {"title": "Streamlit Components API", "domain": "docs.streamlit.io",
     "href": "https://docs.streamlit.io/develop/api-reference/custom-components"},
    {"title": "PyInstaller documentation", "domain": "pyinstaller.org", "href": "https://pyinstaller.org/en/stable/"},
    {"title": "Local model runtime notes", "domain": "internal note", "href": "#local-runtime"},
]

MODELS = [
    {"id": "qwen36", "name": "Colibri Qwen3.6-35B-A3B", "meta": "MoE · int4 gs64 · local"},
    {"id": "qwen3coder30b", "name": "Colibri Qwen3-Coder 30B", "meta": "MoE · 30B · local"},
    {"id": "qwen38", "name": "Colibri Qwen3.8-Flash-Next", "meta": "GGUF Q4_K_XL · SSD stream"},
    {"id": "qwen25", "name": "Colibri Qwen2.5 1.5B", "meta": "dense · fast draft"},
]

PREVIEWS = {
    "app.py": ("python", '''import streamlit as st

from components.context_panel import render_context
from components.task_header import render_header
from components.chat_timeline import render_timeline
from data.mock_tasks import TASKS, DEFAULT_TASK_ID


st.set_page_config(page_title="Colibri Coding Agent", layout="wide")

state = st.session_state
state.setdefault("task_id", DEFAULT_TASK_ID)

task = next(t for t in TASKS if t["id"] == state["task_id"])
render_header(task)
render_timeline(task["events"])
render_context(task)
'''),
    "agent_runner.py": ("python", '''from __future__ import annotations

import asyncio
from dataclasses import dataclass, field


@dataclass
class AgentEvent:
    kind: str
    name: str
    status: str
    payload: dict = field(default_factory=dict)


async def run_task(task_id: str, sink) -> None:
    """Stream agent events to the task timeline as they happen."""
    async for event in executor.stream(task_id):
        normalized = AgentEvent(
            kind=event.kind,
            name=event.tool,
            status=event.status,
            payload=event.payload,
        )
        await sink.push(normalized)
'''),
    "components/task_timeline.py": ("python", '''from __future__ import annotations


def render_timeline(events: list[dict]) -> str:
    rows = []
    for event in events:
        if event["type"] == "tool":
            rows.append(tool_card(event))
        elif event["type"] == "message":
            rows.append(message_block(event))
    return '<div class="timeline">' + "".join(rows) + "</div>"
'''),
    "requirements.txt": ("text", '''streamlit>=1.67
fastapi>=0.115
uvicorn[standard]>=0.32
httpx>=0.27
'''),
    "README.md": ("markdown", '''# Colibri Coding Agent

A chat-first autonomous coding workspace for local Colibri models.

## Run

```bash
python -m streamlit run app.py
```

## Layout

- `app.py` — page composition and session state
- `components/` — sidebar, task header, chat timeline, composer, context panel
- `data/` — mock tasks, messages, and environment details
- `assets/` — logo and icons

The demo uses simulated agent activity. Point `AgentEvent` at the real
Colibri runtime to stream live tool events.
'''),
}
