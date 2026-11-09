"""Renders the chronological task timeline (messages, plans, tools, code)."""
from __future__ import annotations

import re

from . import esc
from .code_block import render_code
from .icons import svg
from .tool_card import render_tool


def inline(text: str) -> str:
    out = esc(text)
    out = re.sub(r"\*\*(.+?)\*\*", r"<em>\1</em>", out)
    out = re.sub(r"`([^`]+)`", r'<code class="inline">\1</code>', out)
    return out


def _user(event: dict) -> str:
    return (
        '<div class="msg user fade-in"><div class="msg-user-card">'
        f'<div class="msg-meta"><span class="who">You</span><span>{esc(event["time"])}</span></div>'
        f"<p>{inline(event['text'])}</p></div></div>"
    )


def _assistant(event: dict) -> str:
    bullets = ""
    if event.get("bullets"):
        items = "".join(f"<li>{inline(b)}</li>" for b in event["bullets"])
        bullets = f'<ul class="bullets">{items}</ul>'
    return (
        '<div class="msg assistant fade-in"><div class="msg-head">'
        '<span class="agent-mark">C</span><span class="who">Colibri</span>'
        f'<span class="time">{esc(event["time"])}</span></div>'
        f'<p class="msg-body">{inline(event["text"])}</p>{bullets}</div>'
    )


def _plan(event: dict) -> str:
    items = event["items"]
    finished = sum(1 for item in items if item["state"] == "done")
    rows = []
    for item in items:
        state = item["state"]
        check = svg("check") if state == "done" else ""
        tag = '<span class="step-tag">In progress</span>' if state == "active" else ""
        rows.append(
            f'<li class="{state}"><span class="step-dot">{check}</span>'
            f'<span>{esc(item["text"])}</span>{tag}</li>'
        )
    return (
        '<div class="plan-card fade-in"><div class="plan-head">'
        f'{svg("layers")}<span>Plan</span>'
        f'<span class="plan-count">{finished}/{len(items)}</span></div>'
        f'<ul class="plan-list">{"".join(rows)}</ul></div>'
    )


def _done(event: dict) -> str:
    items = "".join(f"<li>{inline(item)}</li>" for item in event["items"])
    return (
        '<div class="done-card fade-in"><div class="done-head">'
        f'{svg("check-circle")}<span>Completed</span></div>'
        f'<ul class="done-list">{items}</ul>'
        f'<div class="done-foot">{svg("check")}{esc(event["footer"])}</div></div>'
    )


def _code(event: dict) -> str:
    return (
        f'<div class="fade-in">{render_code(event["filename"], event["source"], event.get("line", 1))}</div>'
    )


RENDERERS = {
    "user": _user,
    "assistant": _assistant,
    "plan": _plan,
    "tool": render_tool,
    "code": _code,
    "done": _done,
}


def render_event(event: dict) -> str:
    return RENDERERS[event["type"]](event)


def render_events(events: list[dict]) -> str:
    return "".join(render_event(event) for event in events)


def timeline_body(events: list[dict]) -> str:
    return f'<div class="timeline fade-in">{render_events(events)}</div>'
