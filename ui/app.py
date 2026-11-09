"""Colibri Coding Agent — chat-first coding workspace (demo shell).

Run with (pythonw keeps the console hidden):
    D:/Colibri/.venv/Scripts/pythonw.exe -m streamlit run app.py --server.port 8140

The demo renders from local mock data; no API key or engine is required.
"""
from __future__ import annotations

import json
from pathlib import Path

import streamlit as st
import streamlit.components.v1 as components

from components import theme
from components.artifact_preview import preview_states, render_modal
from components.chat_timeline import render_event, timeline_body
from components.composer import render_composer
from components.context_panel import render_context
from components.shell import render_document
from components.sidebar import render_sidebar
from components.task_header import render_header
from components.views import attention_html, new_task_html, search_html
from data.mock_environment import ARTIFACTS, ENVIRONMENT, MODELS, PREVIEWS, SITES, SUBAGENTS
from data.mock_messages import REPLY_SEQUENCES
from data.mock_tasks import DEFAULT_TASK_ID, TASKS

ROOT = Path(__file__).parent
ACTIVE_MODEL = MODELS[0]["name"]

st.set_page_config(
    page_title="Colibri Coding Agent",
    layout="wide",
    initial_sidebar_state="collapsed",
)
st.markdown(f"<style>{theme.PARENT_CSS}</style>", unsafe_allow_html=True)


def build_state() -> dict:
    headers: dict[str, str] = {}
    timelines: dict[str, str] = {}
    for task in TASKS:
        headers[task["id"]] = render_header(
            task["title"], task["status_line"], task["status"], task["status_label"],
            task["repo"], task["branch"],
        )
        timelines[task["id"]] = timeline_body(task["events"])

    headers["attention"] = render_header(
        "My Attention", "2 items need your review before the agent can continue.",
        "attention", "2 open",
    )
    headers["search"] = render_header(
        "Search", "Search across files, tasks, and runtime notes in the local workspace.",
        "idle", "Local index",
    )
    headers["new"] = render_header(
        "New coding task", "Describe a task to start a new agent session.", "idle", "Idle",
    )

    return {
        "activeTask": DEFAULT_TASK_ID,
        "tasks": [
            {"id": task["id"], "title": task["title"], "status": task["status"],
             "html": timelines[task["id"]]}
            for task in TASKS
        ],
        "headers": headers,
        "views": {
            "attention": attention_html(TASKS),
            "search": search_html(),
            "new": new_task_html(),
        },
        "replies": {
            key: [render_event(event) for event in events]
            for key, events in REPLY_SEQUENCES.items()
        },
        "previews": preview_states(PREVIEWS),
        "models": MODELS,
    }


state = build_state()
default_task = next(task for task in TASKS if task["id"] == DEFAULT_TASK_ID)

document = render_document(
    css=theme.app_css(),
    sidebar=render_sidebar(TASKS, DEFAULT_TASK_ID),
    header=state["headers"][DEFAULT_TASK_ID],
    stage=timeline_body(default_task["events"]),
    composer=render_composer(MODELS, ACTIVE_MODEL),
    context=render_context(ENVIRONMENT, SUBAGENTS, ARTIFACTS, SITES),
    modal=render_modal(),
    state_json=json.dumps(state, ensure_ascii=False).replace("</", "<\\/"),
    js=theme.app_js(),
)

components.html(document, height=900, scrolling=False)
