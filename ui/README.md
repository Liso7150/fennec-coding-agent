# Colibri Coding Agent

A premium, chat-first local coding workspace for the Colibri desktop app. This demo
implements the "Colibri Night" product direction: a three-pane desktop shell with a task
timeline, tool activity cards, an always-available composer, and a supporting context rail.

## Run

```bash
D:/Colibri/.venv/Scripts/pythonw.exe -m streamlit run app.py --server.port 8140
```

Launch with `pythonw.exe` so Windows does not open a console window for the server.

Open http://127.0.0.1:8140 — no API key or inference engine is needed for the demo.

## Layout

```
app.py                        page composition + session state
components/
  theme.py                    Colibri Night CSS loader + Streamlit frame overrides
  shell.py                    assembles the embedded workspace document
  sidebar.py                  brand, workspace, navigation, recent tasks, repo context
  task_header.py              breadcrumb, task title, status pill, actions
  chat_timeline.py            transcript rendering (messages, plans, code, summaries)
  tool_card.py                expandable tool activity cards
  code_block.py               line-numbered code with syntax highlighting
  composer.py                 persistent composer + model selector + tool controls
  context_panel.py            environment, subagents, artifacts, research links
  artifact_preview.py         artifact preview modal
  views.py                    My Attention, Search, New Task views
  ui/app.css                  the full Colibri Night stylesheet
  ui/app.js                   view swapping, composer flow, drawers, modal, toasts
data/
  mock_tasks.py               five believable coding tasks with full transcripts
  mock_messages.py            event builders + canned agent reply sequences
  mock_environment.py         environment, subagents, artifacts, sites, models
assets/logo.svg               Colibri mark
```

## Demo behavior

- Selecting a recent task swaps the header, transcript, and active state.
- Sending a message appends a mock user message and a believable agent reply sequence
  (assistant text, tool cards, completion summary) chosen by keywords.
- Tool cards expand and collapse with their output and diffs.
- Artifacts open a preview modal with highlighted source.
- New Task clears the transcript and offers starter prompts.
- My Attention lists warnings/blocked tasks; Search filters the local mock index.
- The model selector, web toggle, and local-tools chip change state in the UI.
- All activity is simulated; no shell execution happens in the demo.

The data layer is intentionally isolated, so wiring the real Colibri agent runtime later
only requires replacing the reply sequences with streamed `AgentEvent` objects.
