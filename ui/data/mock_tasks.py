"""Mock coding tasks and their transcripts."""
from __future__ import annotations

from .mock_messages import assistant, code, done, plan, tool, user

CODE_SNIPPET = '''class TaskEvent(BaseModel):
    kind: Literal["tool", "message", "artifact"]
    name: str
    status: str
    started_at: float
    duration_ms: int | None = None

async def emit(events: list[TaskEvent], sink: EventSink) -> None:
    for event in events:
        await sink.push(event.model_dump())'''

OPTIMIZE = [
    user("Turn Colibri into a packaged desktop coding-agent application. Keep local-model "
         "support, add a project-aware workspace, and make terminal execution visible "
         "without overwhelming the chat."),
    assistant("Got it. I'll first inspect the repository structure and current runtime "
              "boundaries, then I'll propose the smallest packaging path that preserves "
              "local inference."),
    plan([
        ("Inspect project layout and entry points", "done"),
        ("Review local model runtime configuration", "done"),
        ("Add desktop application shell", "active"),
        ("Surface terminal actions in the task timeline", "todo"),
        ("Run unit tests and verify startup flow", "todo"),
    ]),
    tool("read", "Read file", "Read pyproject.toml", "complete", "14:33", "0.4s",
         "pyproject.toml",
         'Detected <span class="ok">Python 3.12</span>, <span class="ok">Streamlit runtime</span>, '
         "and local packaging configuration.\n"
         '<span class="dim">dependencies: fastapi, uvicorn, streamlit, httpx</span>'),
    tool("inspect", "Inspect repository", "Inspect application entry points", "complete", "14:33", "1.2s",
         "find . -maxdepth 2 -type f",
         '.\n'
         '├── app.py                     <span class="dim">entry point</span>\n'
         '├── agent_runner.py            <span class="dim">async event loop</span>\n'
         '├── components/\n'
         '│   ├── task_timeline.py\n'
         '│   ├── tool_card.py\n'
         '│   └── context_panel.py\n'
         '├── data/\n'
         '│   ├── mock_tasks.py\n'
         '│   └── mock_messages.py\n'
         '└── requirements.txt'),
    tool("edit", "Edit file", "Update agent_runner.py", "complete", "14:34", "0.8s",
         "agent_runner.py",
         "Added streaming event normalization and structured tool event emission.\n"
         '<span class="dim">+ 42 lines, - 7 lines</span>'),
    code("agent_runner.py", CODE_SNIPPET, line=18),
    assistant("Repository inspection is complete. The current runtime already separates task "
              "execution from UI rendering, so the desktop shell can be added without changing "
              "the local inference loop."),
    tool("run", "Run command", "Run pytest", "complete", "14:35", "4.21s",
         "pytest tests/ -q", '<span class="ok">18 passed</span> in 4.21s'),
    tool("run", "Run command", "Build desktop bundle", "warning", "14:36", "7.6s",
         "python -m build",
         "Successfully built colibri_desktop-1.0.0.tar.gz\n"
         "Successfully built colibri_desktop-1.0.0-py3-none-any.whl\n"
         '<span class="warn">warning:</span> Build completed with one optional dependency warning.'),
    done([
        "Added task timeline event model",
        "Created artifact tracking for changed files",
        "Normalized command output for compact rendering",
        "Verified local startup path",
    ], "Test result: 18 passed"),
]

PACKAGE = [
    user("Package the desktop shell so the agent can be started without the terminal."),
    assistant("I'll wrap the existing runtime in an NSIS installer and keep the venv "
              "dependencies external so the bundle stays small."),
    tool("run", "Run command", "Build NSIS installer", "complete", "11:20", "48.2s",
         "electron-builder --win nsis",
         'built release/Colibri-Setup-1.0.0.exe\n'
         '<span class="dim">installer size: 84.6 MB</span>'),
    tool("run", "Run command", "Smoke test packaged app", "complete", "11:22", "6.1s",
         "release/Colibri-Setup-1.0.0.exe --smoke",
         '<span class="ok">startup ok</span> · agent server responded on 127.0.0.1:8137'),
    assistant("Installer and startup smoke test both pass. The reviewer approved the build; "
              "one optional dependency warning remains for a later cleanup pass.", time="11:23"),
    done(["Built NSIS installer", "Verified packaged startup flow", "Reviewer approved the build"],
         "Build result: 1 installer, 1 warning", time="11:23"),
]

STREAMING = [
    user("Fix the streaming response state — the transcript closes before the last chunk."),
    assistant("I'll reproduce it with the focused test, then buffer tool events until the "
              "chunk boundary is acknowledged."),
    tool("run", "Run tests", "Run pytest tests/test_stream.py", "failed", "09:41", "1.42s",
         "pytest tests/test_stream.py -q",
         '<span class="bad">FAILED</span> tests/test_stream.py::test_out_of_order_chunks\n'
         'AssertionError: expected status "running" before "complete"\n'
         '<span class="dim">1 failed, 5 passed</span>'),
    assistant("Reproduced: the completion event is emitted before the final chunk flush. "
              "The fix is a small buffer in the runner; I need your go-ahead to change the "
              "stream contract."),
]

INDEXER = [
    user("Add a repository indexer so natural-language search works across the codebase."),
    assistant("I'll add an incremental scanner with content hashing and keep it off the "
              "chat loop."),
    tool("edit", "Edit file", "Add components/indexer.py", "complete", "16:08", "1.4s",
         "components/indexer.py", "Added incremental scan, sha1 content hashing, and a "
         "debounced refresh loop.\n<span class=\"dim\">+ 96 lines</span>"),
    tool("run", "Run tests", "Run pytest tests/test_indexer.py", "complete", "16:09", "2.2s",
         "pytest tests/test_indexer.py -q", '<span class="ok">7 passed</span> in 2.20s'),
    done(["Indexer scans 1,284 files incrementally", "Unchanged files skipped by hash",
          "Search latency under 40 ms locally"], "Test result: 7 passed", time="16:10"),
]

TERMINAL = [
    user("Improve terminal output parsing — tool cards should stay compact with long logs."),
    assistant("I'll normalize ANSI sequences, cap previews, and keep full output behind "
              "the expandable card."),
    tool("edit", "Edit file", "Update components/tool_card.py", "complete", "Mon 15:12", "0.9s",
         "components/tool_card.py", "Added ANSI stripping and a 220-character preview cap.\n"
         "<span class=\"dim\">+ 31 lines, - 12 lines</span>"),
    done(["Terminal output stays compact", "Full logs available on expand",
          "No changes to command execution"], "Test result: 18 passed", time="Mon 15:13"),
]

TASKS = [
    {
        "id": "optimize",
        "title": "Optimize local Colibri model",
        "status": "running",
        "status_label": "Running",
        "updated": "2m ago",
        "meta": "Running · 2m ago",
        "status_line": "Agent is reviewing inference throughput and packaging constraints.",
        "repo": "colibri-desktop",
        "branch": "feat/agent-shell",
        "events": OPTIMIZE,
    },
    {
        "id": "package",
        "title": "Package desktop app",
        "status": "reviewed",
        "status_label": "Reviewed",
        "updated": "1h ago",
        "meta": "Reviewed · 1h ago",
        "status_line": "Reviewer approved the installer build and the packaged startup smoke test.",
        "repo": "colibri-desktop",
        "branch": "feat/agent-shell",
        "events": PACKAGE,
        "attention_note": "Build emitted one optional dependency warning.",
        "attention_label": "Warning",
    },
    {
        "id": "streaming",
        "title": "Fix streaming response state",
        "status": "attention",
        "status_label": "Needs attention",
        "updated": "3h ago",
        "meta": "Needs attention · 3h ago",
        "status_line": "A failing stream-ordering test is blocking verification.",
        "repo": "colibri-desktop",
        "branch": "feat/stream-events",
        "events": STREAMING,
        "attention_note": "1 failing test in tests/test_stream.py — verifier is blocked.",
        "attention_label": "Needs attention",
    },
    {
        "id": "indexer",
        "title": "Add repository indexer",
        "status": "complete",
        "status_label": "Complete",
        "updated": "Yesterday",
        "meta": "Complete · Yesterday",
        "status_line": "Incremental indexer landed and search results are warm.",
        "repo": "colibri-desktop",
        "branch": "feat/indexer",
        "events": INDEXER,
    },
    {
        "id": "terminal",
        "title": "Improve terminal output parsing",
        "status": "complete",
        "status_label": "Complete",
        "updated": "2d ago",
        "meta": "Complete · 2d ago",
        "status_line": "Tool cards now cap previews and keep full logs behind expand.",
        "repo": "colibri-desktop",
        "branch": "feat/terminal-output",
        "events": TERMINAL,
    },
]

DEFAULT_TASK_ID = "optimize"
