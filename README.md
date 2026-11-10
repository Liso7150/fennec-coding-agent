# Fennec Coding Agent

Installable, chat-first coding workspace for the Fennec engine, whose base idea is
[Colibri](https://github.com/JustVugg/colibri). The browser app (`web/`)
talks to the shared local core
([`fennec-core`](https://github.com/Liso7150/fennec-core)), which starts the
local engine only when you send a message.

## Features

- **Chat and Agent modes** — plain conversation, or a bounded tool loop that
  reads files, greps, edits and runs commands inside a configured workspace.
- **Read-only by default** — each agent run needs your explicit approval for
  writes or shell commands; every tool result stays visible.
- **Engine on demand** — if the engine is offline, the first message asks the
  core to start it on this device; nothing listens in the background.
- **Installable PWA** — Works in desktop browsers, Android Chrome ("Add to Home
  screen") and iOS Safari; the same UI works on a phone running the core in
  Termux or reaching a trusted host.
- **Local-only data** — conversations stay in the tab, files stay in the
  workspace, and nothing is uploaded by the app.
- **Server files view** — browse and preview the core's workspace from the app.
- **Reasoning control and display** — choose the server default, off, or high
  reasoning effort; streamed reasoning appears in a collapsible block.
- **Vision and attachments** — attach one PNG/JPEG/WebP/GIF (or paste it) for
  the engine's vision tower, and up to three text files as bounded context.
- **Speech** — dictate through the local faster-whisper sidecar
  (`POST /api/stt`) and read answers aloud with the browser's offline voices.

## Run

Install the core (editable) and start its server, which also serves this PWA:

```bash
python -m pip install -e fennec-core
fennec-agent serve --host 127.0.0.1 --port 8787
# open http://127.0.0.1:8787
```

The core reads `~/.fennec/config.json` (or `FENNEC_CONFIG` / `FENNEC_*`
variables) for the engine URL, model and workspace. A non-loopback bind requires
`FENNEC_APP_TOKEN` and TLS in front of the core; plain LAN HTTP is refused.

Android: see [`fennec-installer/android`](https://github.com/Liso7150/fennec-installer/tree/main/android)
for the Termux path (core + PWA on the phone) and the WebView scaffold.

## Tests

```bash
node --test web/tests/
```

## Credits

Engine base idea: [JustVugg/colibri](https://github.com/JustVugg/colibri) —
device-tiered MoE inference. Fine-tuning:
[AirLLM](https://github.com/lyogavin/airllm). Part of the
[Fennec suite](https://github.com/Liso7150/fennec-environment-setup).
