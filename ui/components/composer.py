"""Persistent chat composer with model selector and local-tools controls."""
from __future__ import annotations

from . import esc
from .icons import svg


def render_composer(models: list[dict], active: str) -> str:
    items = "".join(
        f'<button data-model="{esc(model["id"])}" data-model-name="{esc(model["name"])}"'
        f'{" class=\"selected\"" if model["name"] == active else ""}>'
        f'<span class="mm-name">{esc(model["name"])}</span>'
        f'<span class="mm-meta">{esc(model["meta"])}</span></button>'
        for model in models
    )
    return (
        '<div class="composer-wrap"><div class="composer">'
        '<textarea id="composerInput" rows="2" '
        'placeholder="Press and hold the mouse to dictate text" '
        'aria-label="Message Colibri"></textarea>'
        '<div class="composer-help">Ask Colibri to inspect, edit, test, or explain your code.</div>'
        '<div class="composer-bar">'
        '<div class="left-controls">'
        f'<button class="chip-btn" data-toast="Attachments are simulated in this demo." title="Attach file">{svg("paperclip")}</button>'
        f'<button class="chip-btn" data-toast="Context picker is simulated in this demo." title="Add context">{svg("layers")}</button>'
        f'<button class="chip-btn" data-toast="Dictation is simulated in this demo." title="Dictate">{svg("mic")}</button>'
        "</div>"
        '<div class="right-controls">'
        f'<button class="model-btn" id="modelBtn"><span id="modelLabel">{esc(active)}</span>{svg("chevron-down")}</button>'
        f'<button class="chip-btn" id="webBtn" data-action="web" title="Search the web">{svg("globe")}</button>'
        f'<button class="chip on" id="toolsBtn" data-action="toggle-tools" title="Local tools">{svg("terminal")}Local tools</button>'
        f'<button class="send-btn" id="sendBtn" data-action="send" disabled title="Send" aria-label="Send">{svg("arrow-up")}</button>'
        "</div>"
        "</div>"
        f'<div class="model-menu" id="modelMenu"><div class="mm-label">Local models</div>{items}</div>'
        "</div></div>"
    )
