"""Event constructors plus canned agent replies used by the demo composer."""
from __future__ import annotations


def user(text: str, time: str = "14:32") -> dict:
    return {"type": "user", "text": text, "time": time}


def assistant(text: str, bullets: list[str] | None = None, time: str = "14:32") -> dict:
    return {"type": "assistant", "text": text, "bullets": bullets or [], "time": time}


def plan(items: list[tuple[str, str]], time: str = "14:33") -> dict:
    return {"type": "plan", "items": [{"text": t, "state": s} for t, s in items], "time": time}


def tool(kind: str, label: str, title: str, status: str, time: str, duration: str,
         preview: str, output_html: str) -> dict:
    return {"type": "tool", "kind": kind, "label": label, "title": title, "status": status,
            "time": time, "duration": duration, "preview": preview, "output_html": output_html}


def code(filename: str, source: str, line: int = 1, time: str = "14:35") -> dict:
    return {"type": "code", "filename": filename, "source": source, "line": line, "time": time}


def done(items: list[str], footer: str, time: str = "14:36") -> dict:
    return {"type": "done", "items": items, "footer": footer, "time": time}


# Pre-rendered reply sequences. The composer picks one by keyword and the UI
# swaps {{now}} for the current clock time when it appends them.
REPLY_SEQUENCES = {
    "test": [
        assistant("I'll run the focused test suite first, then widen to the full suite "
                  "so we know whether this change is isolated.", time="{{now}}"),
        tool("run", "Run tests", "Run pytest tests/", "running", "{{now}}", "…",
             "pytest tests/ -q", '<span class="dim">collecting 24 items…</span>'),
        tool("test", "Run tests", "Run pytest tests/", "complete", "{{now}}", "3.84s",
             "pytest tests/ -q", '<span class="ok">24 passed</span> in 3.84s'),
        assistant("The suite is green. I also re-ran the startup smoke check to make sure "
                  "the event pipeline still boots cleanly.", time="{{now}}"),
        done(["Executed focused and full test suites",
              "Confirmed startup smoke check",
              "No regressions in tool-event rendering"],
             "Test result: 24 passed", time="{{now}}"),
    ],
    "package": [
        assistant("I'll build the bundle, then inspect the installer output for warnings "
                  "before suggesting the smallest packaging path.", time="{{now}}"),
        tool("run", "Run command", "Build desktop bundle", "running", "{{now}}", "…",
             "python -m build", '<span class="dim">building sdist and wheel…</span>'),
        tool("run", "Run command", "Build desktop bundle", "warning", "{{now}}", "7.6s",
             "python -m build", 'Successfully built colibri_desktop-1.0.0.tar.gz\n'
             'Successfully built colibri_desktop-1.0.0-py3-none-any.whl\n'
             '<span class="warn">warning:</span> optional dependency "pywin32" not installed'),
        assistant("The bundle builds. The only warning is an optional Windows dependency; "
                  "it does not block the installer, but I'd pin it before shipping.", time="{{now}}",
                  ),
        done(["Built sdist and wheel artifacts",
              "Captured optional dependency warning",
              "Installer path verified against local runtime"],
             "Build result: 2 artifacts, 1 warning", time="{{now}}"),
    ],
    "index": [
        assistant("I'll inspect the current indexer boundaries, then add a repository scan "
                  "that runs incrementally so it never blocks the chat loop.", time="{{now}}"),
        tool("inspect", "Inspect repository", "Inspect indexer entry points", "complete", "{{now}}", "1.1s",
             "grep -rn \"index\" components/", 'components/\n'
             '  task_timeline.py\n  context_panel.py\nagent_runner.py:42  <span class="dim"># stream loop</span>\n'
             'data/mock_tasks.py'),
        tool("edit", "Edit file", "Update agent_runner.py", "complete", "{{now}}", "0.9s",
             "agent_runner.py", "Added incremental repository scan with debounce and "
             "per-file content hashing.\n<span class=\"dim\">+ 64 lines, - 9 lines</span>"),
        assistant("The indexer now updates in the background and only re-embeds changed files. "
                  "Search results stay warm between sessions.", time="{{now}}"),
        done(["Added incremental repository scanner",
              "Hashed file contents to skip unchanged paths",
              "Kept the chat loop non-blocking"],
             "Index result: 1,284 files tracked", time="{{now}}"),
    ],
    "stream": [
        assistant("I'll reproduce the streaming state issue with the focused test, "
                  "then normalize the event ordering before touching the UI.", time="{{now}}"),
        tool("run", "Run tests", "Run pytest tests/test_stream.py", "failed", "{{now}}", "1.42s",
             "pytest tests/test_stream.py -q",
             '<span class="bad">FAILED</span> tests/test_stream.py::test_out_of_order_chunks\n'
             'AssertionError: expected status "running" before "complete"\n'
             '<span class="dim">1 failed, 5 passed</span>'),
        assistant("Reproduced. The runner emits a completion event before the last chunk is "
                  "flushed, so the UI closes the stream early. I'll buffer tool events until "
                  "the chunk boundary is acknowledged.", time="{{now}}"),
        done(["Reproduced the failing stream ordering test",
              "Identified premature completion emission",
              "Prepared buffered event fix (awaiting review)"],
             "Status: needs a follow-up run", time="{{now}}"),
    ],
    "default": [
        assistant("I'll inspect the relevant files first, then make the smallest change that "
                  "preserves the local inference loop and the task timeline contract.", time="{{now}}"),
        tool("read", "Read file", "Read app.py", "complete", "{{now}}", "0.3s",
             "app.py", "Streamlit entry point detected. Layout composes sidebar, task header, "
             "timeline, and context panel from isolated component modules."),
        tool("edit", "Edit file", "Update components/task_timeline.py", "complete", "{{now}}", "0.7s",
             "components/task_timeline.py", "Added an event normalization step so tool cards "
             "render consistently regardless of stream order.\n"
             "<span class=\"dim\">+ 28 lines, - 4 lines</span>"),
        assistant("Done. The transcript now normalizes events before rendering, so out-of-order "
                  "stream frames no longer break tool cards. Want me to run the full suite?", time="{{now}}"),
        done(["Inspected the entry point and timeline component",
              "Normalized tool events before render",
              "Kept the local runtime boundary unchanged"],
             "Test result: 18 passed", time="{{now}}"),
    ],
}
