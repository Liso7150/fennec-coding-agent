"""Theme loading: in-app CSS plus the Streamlit page overrides that frame it."""
from __future__ import annotations

from pathlib import Path

UI_DIR = Path(__file__).parent / "ui"

PARENT_CSS = """
html, body, .stApp { background: #15120F !important; }
header[data-testid="stHeader"],
div[data-testid="stToolbar"],
div[data-testid="stDecoration"],
#MainMenu, footer, .stDeployButton { display: none !important; }
.stApp, div[data-testid="stAppViewContainer"], section.main, .stMain {
  overflow: hidden !important; height: 100vh !important;
}
.stMainBlockContainer, .block-container {
  padding: 0 !important; margin: 0 !important; max-width: 100% !important;
}
div[data-testid="stVerticalBlock"] { gap: 0 !important; }
div[data-testid="stElementContainer"]:has(iframe) { height: 100vh !important; }
.stMainBlockContainer iframe {
  height: 100vh !important; width: 100% !important;
  border: none !important; display: block !important; background: #15120F;
}
"""


def app_css() -> str:
    return (UI_DIR / "app.css").read_text(encoding="utf-8")


def app_js() -> str:
    return (UI_DIR / "app.js").read_text(encoding="utf-8")
