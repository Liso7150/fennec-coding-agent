"""Artifact preview modal. Preview bodies are pre-rendered and swapped by the UI."""
from __future__ import annotations

from . import esc
from .code_block import render_code
from .icons import svg


def preview_states(previews: dict[str, tuple[str, str]]) -> dict[str, str]:
    return {
        name: render_code(name, source, 1, head=False)
        for name, (_language, source) in previews.items()
    }


def render_modal() -> str:
    return (
        '<div class="modal-backdrop" id="modalBackdrop">'
        '<div class="modal" role="dialog" aria-modal="true">'
        '<div class="modal-head">'
        f'{svg("file")}<span class="modal-file" id="modalFile">preview</span>'
        f'<button class="icon-btn modal-close" data-action="close-modal" aria-label="Close">{svg("x")}</button>'
        "</div>"
        '<div class="modal-body" id="modalBody"></div>'
        '<div class="modal-foot"><span class="status-dot complete"></span>'
        "Modified by agent · demo preview</div>"
        "</div></div>"
        + f'<div class="toast" id="toast">{svg("spark")}<span id="toastText"></span></div>'
    )
