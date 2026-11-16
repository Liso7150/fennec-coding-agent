# Fennec Coding Agent

The coding agent is now a **native Rust desktop application** (fennec-desktop).

The previous JavaScript PWA has been replaced with a native implementation using egui/eframe. No Node.js, no browser, no web view — just a fast, local-first desktop app.

## Get the Coding Agent

The coding agent lives in the [`fennec-desktop`](https://github.com/Liso7150/fennec-desktop) repository:

```bash
# Clone the desktop app
git clone https://github.com/Liso7150/fennec-desktop
cd fennec-desktop

# Build from source
cargo build --release --offline

# Run
./target/release/fennec-desktop
```

## What Changed

**Before (PWA):**
- JavaScript/HTML/CSS in `web/` directory
- Ran in browser or as installable PWA
- Required Node.js tooling for tests
- Service worker for offline support

**Now (Native Rust):**
- Pure Rust implementation using egui/eframe
- Native window, no browser needed
- 33 tests, all in Rust
- Faster startup, lower memory usage
- Same features: chat, agent mode, file browsing, vision, attachments, speech

## Features

All features from the PWA are preserved in the native app:

- **Chat and Agent modes** — plain conversation, or a bounded tool loop that reads files, greps, edits and runs commands inside a configured workspace
- **Read-only by default** — each agent run needs your explicit approval for writes or shell commands
- **Engine on demand** — if the engine is offline, the first message asks the core to start it
- **Local-only data** — conversations stay local, files stay in the workspace, nothing is uploaded
- **Server files view** — browse and preview the core's workspace from the app
- **Reasoning control and display** — choose the server default, off, or high reasoning effort
- **Vision and attachments** — attach images for the engine's vision tower, and text files as bounded context
- **Speech** — dictation and read-aloud support (when backends expose it)

## Architecture

```
fennec-desktop (Rust/egui)
  ↓ talks to
fennec-core (agent server on 127.0.0.1:8787)
  ↓ talks to
Fennec engine (inference on 127.0.0.1:8184)
```

The desktop app uses `fennec-client` (from fennec-core) for all backend communication. No protocol logic is duplicated.

## Platform Support

- Windows (x86_64)
- macOS (aarch64, x86_64)
- Linux (x86_64)

Pre-built binaries are available on the [releases page](https://github.com/Liso7150/fennec-desktop/releases).

## Why Native Rust?

The PWA was rewritten to eliminate the JavaScript toolchain and browser dependency:

1. **Performance** — native window rendering is faster than Chromium
2. **Simplicity** — no Node.js, no npm, no service workers
3. **Reliability** — Rust's type system catches bugs at compile time
4. **Distribution** — single binary, no installation needed
5. **Maintainability** — one codebase, not HTML + CSS + JS + tests

## Migration from PWA

If you were using the PWA:

1. Download the native desktop app from [fennec-desktop releases](https://github.com/Liso7150/fennec-desktop/releases)
2. Run it — it connects to the same local services (fennec-core and Fennec engine)
3. Your conversations and workspace settings are preserved (they're stored by fennec-core, not the app)

## Credits

Engine base idea: [JustVugg/colibri](https://github.com/JustVugg/colibri) — device-tiered MoE inference. Fine-tuning: [AirLLM](https://github.com/lyogavin/airllm). Part of the [Fennec suite](https://github.com/Liso7150/fennec-environment-setup).
