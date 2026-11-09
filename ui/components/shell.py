"""Assembles the standalone UI document embedded in the Streamlit page."""
from __future__ import annotations

_DOC = """<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Colibri Coding Agent</title>
<style>
@@CSS@@
</style>
</head>
<body>
<div class="app">
@@SIDEBAR@@
<main class="center">
  <header class="task-header"><div class="header-inner" id="headerInner">@@HEADER@@</div></header>
  <div class="scroll-area" id="scrollArea"><div id="stage">@@STAGE@@</div></div>
  @@COMPOSER@@
</main>
@@CONTEXT@@
</div>
<div class="backdrop" id="backdrop"></div>
@@MODAL@@
<script id="app-state" type="application/json">@@STATE@@</script>
<script>
@@JS@@
</script>
</body>
</html>
"""


def render_document(*, css: str, sidebar: str, header: str, stage: str,
                    composer: str, context: str, modal: str,
                    state_json: str, js: str) -> str:
    return (_DOC
            .replace("@@CSS@@", css)
            .replace("@@SIDEBAR@@", sidebar)
            .replace("@@HEADER@@", header)
            .replace("@@STAGE@@", stage)
            .replace("@@COMPOSER@@", composer)
            .replace("@@CONTEXT@@", context)
            .replace("@@MODAL@@", modal)
            .replace("@@STATE@@", state_json)
            .replace("@@JS@@", js))
