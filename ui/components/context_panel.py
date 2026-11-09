"""Right sidebar: environment, subagents, artifacts, and research links."""
from __future__ import annotations

from . import esc
from .icons import svg


def _env_rows(environment: list[tuple]) -> str:
    rows = []
    for icon, key, value, variant in environment:
        extra = ""
        if variant == "ok":
            extra = '<span class="status-dot complete"></span>'
            variant = "ok"
        rows.append(
            f'<div class="env-row">{svg(icon)}<span class="k">{esc(key)}</span>'
            f'<span class="v {variant}">{extra}{esc(value)}</span></div>'
        )
    return "".join(rows)


def _subagents(subagents: list[dict]) -> str:
    rows = []
    for agent in subagents:
        progress = ""
        if agent.get("progress") is not None:
            progress = f'<div class="progress"><i style="width:{int(agent["progress"])}%"></i></div>'
        rows.append(
            f'<div class="subagent"><span class="status-dot {esc(agent["state"])}"></span>'
            '<div class="sa-main">'
            f'<div class="sa-name">{esc(agent["name"])}</div>'
            f'<div class="sa-desc">{esc(agent["detail"])}</div>'
            f"{progress}</div>"
            f'<span class="sa-state {esc(agent["state"])}">{esc(agent["state"].title())}</span></div>'
        )
    return f'<div class="subagent-list">{"".join(rows)}</div>'


def _artifacts(artifacts: list[dict]) -> str:
    rows = []
    for artifact in artifacts:
        added = " added" if artifact["action"] == "Added" else ""
        rows.append(
            f'<button class="artifact" data-action="artifact" data-artifact="{esc(artifact["name"])}">'
            f'{svg("file")}<span class="a-name">{esc(artifact["name"])}</span>'
            f'<span class="a-action{added}">{esc(artifact["action"])}</span>'
            '<span class="a-open">Open</span></button>'
        )
    return f'<div class="artifact-list">{"".join(rows)}</div>'


def _sites(sites: list[dict]) -> str:
    rows = []
    for site in sites:
        rows.append(
            f'<a class="site" href="{esc(site["href"])}" target="_blank" rel="noopener">'
            f'{svg("globe")}<span class="s-main"><span class="s-title">{esc(site["title"])}</span>'
            f'<span class="s-domain">{esc(site["domain"])}</span></span>'
            f'{svg("external", "ext")}</a>'
        )
    return f'<div class="site-list">{"".join(rows)}</div>'


def render_context(environment: list[tuple], subagents: list[dict],
                   artifacts: list[dict], sites: list[dict]) -> str:
    return (
        '<aside class="right" id="rightPane">'
        '<div class="panel-title">Environment</div>'
        f'<div class="env-card">{_env_rows(environment)}</div>'
        '<div class="panel-title">Subagents</div>'
        f"{_subagents(subagents)}"
        f'<div class="panel-title">Artifacts <span class="count">{len(artifacts)}</span></div>'
        f"{_artifacts(artifacts)}"
        '<div class="panel-title">Sites</div>'
        f"{_sites(sites)}"
        "</aside>"
    )
