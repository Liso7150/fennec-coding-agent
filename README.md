# Fennec Coding Agent

Web-based coding agent interface for the Fennec suite. This repository contains the HTML/CSS templates; all logic is provided by **fennec-desktop** (native Rust application).

## Architecture

```
Browser ←→ fennec-desktop (Rust backend + web server)
                ↓
           fennec-core (agent server)
                ↓
           Fennec engine (inference)
```

**fennec-coding-agent** (this repo):
- HTML/CSS templates for the web interface
- PWA manifest and icons
- No JavaScript — all logic is in fennec-desktop

**fennec-desktop**:
- Native Rust application (egui/eframe)
- Serves the web interface on `http://localhost:8787`
- Provides all API endpoints and real-time updates
- Talks to fennec-core and Fennec engine backends

## Usage

### 1. Build fennec-desktop

```bash
git clone https://github.com/Liso7150/fennec-desktop
cd fennec-desktop
cargo build --release --offline
```

### 2. Start the backend services

```bash
# Start the Fennec engine
fennec serve --model qwen36-35b --gpu --auto-tier

# Start the agent server
fennec-agent serve --host 127.0.0.1 --port 8787
```

### 3. Access the web interface

Open `http://localhost:8787` in your browser.

The fennec-desktop binary serves the web interface from this repository's `web/` directory and handles all API requests.

## Features

- **Chat and Agent modes** — plain conversation, or a bounded tool loop with file operations
- **Read-only by default** — explicit approval required for writes and shell commands
- **Engine on demand** — starts the engine automatically when needed
- **Local-only data** — all data stays on your device
- **File browser** — view and preview workspace files
- **Reasoning display** — control and view model reasoning
- **Vision support** — attach images for vision-capable models
- **PWA installable** — works as a progressive web app

## Development

### Web Interface (this repo)

Edit the HTML/CSS in `web/`:
- `index.html` — main interface structure
- `styles.css` — visual styling (Fennec Night theme)
- `manifest.webmanifest` — PWA configuration
- `icons/` — app icons for various platforms

### Backend Logic (fennec-desktop)

All JavaScript logic has been ported to Rust in fennec-desktop:
- API client communication
- Real-time event handling
- State management
- UI interactions

The web interface uses server-sent events (SSE) for real-time updates from the Rust backend.

## Migration from JavaScript PWA

The previous version used JavaScript (app.js, helpers.js, etc.) for all client-side logic. This has been replaced with:

1. **No client-side JavaScript** — the browser just renders HTML/CSS
2. **Rust backend** — fennec-desktop handles all logic
3. **SSE for updates** — real-time data pushed from server to browser
4. **Form submissions** — user actions sent as HTTP requests

This architecture is:
- **Faster** — no JavaScript parsing/execution in the browser
- **More secure** — logic is in compiled Rust, not client-side JS
- **Easier to maintain** — one codebase (Rust) instead of two (JS + Rust)
- **Better performance** — server does the heavy lifting

## Platform Support

The web interface works in any modern browser:
- Chrome/Edge (Chromium)
- Firefox
- Safari
- Mobile browsers (iOS Safari, Android Chrome)

PWA installation is supported on mobile and desktop browsers.

## Testing

Web interface tests are now in fennec-desktop:

```bash
cd fennec-desktop
cargo test --release --offline
```

## Credits

Engine base idea: [JustVugg/colibri](https://github.com/JustVugg/colibri) — device-tiered MoE inference. Fine-tuning: [AirLLM](https://github.com/lyogavin/airllm). Part of the [Fennec suite](https://github.com/Liso7150/fennec-environment-setup).
