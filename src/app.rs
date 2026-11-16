//! Web UI module for Fennec coding agent.
//!
//! Provides server-side rendering of the audit dashboard and static asset serving.
//! The UI displays implementation coverage across all Fennec modules.

use axum::response::Html;
use serde::Serialize;

/// Module coverage data for the audit dashboard.
#[derive(Clone, Serialize)]
pub struct ModuleCoverage {
    pub icon: &'static str,
    pub title: &'static str,
    pub confirmed: usize,
    pub total: usize,
    pub description: &'static str,
    pub tags: Vec<&'static str>,
    pub partial: Vec<&'static str>,
}

/// Strength item for the confirmed strengths section.
#[derive(Clone, Serialize)]
pub struct StrengthItem {
    pub title: &'static str,
    pub description: &'static str,
}

/// Audit metadata displayed in the inspector panel.
#[derive(Clone, Serialize)]
pub struct AuditMetadata {
    pub version: &'static str,
    pub scope: &'static str,
    pub evidence: &'static str,
}

/// Watchlist item for partial implementations.
#[derive(Clone, Serialize)]
pub struct WatchlistItem {
    pub icon: &'static str,
    pub title: &'static str,
    pub description: &'static str,
}

/// Verification context item.
#[derive(Clone, Serialize)]
pub struct VerificationItem {
    pub title: &'static str,
}

/// Complete audit data for the dashboard.
#[derive(Clone, Serialize)]
pub struct AuditData {
    pub overall_percentage: usize,
    pub confirmed: usize,
    pub partial: usize,
    pub missing: usize,
    pub total: usize,
    pub modules: Vec<ModuleCoverage>,
    pub strengths: Vec<StrengthItem>,
    pub metadata: AuditMetadata,
    pub watchlist: Vec<WatchlistItem>,
    pub verification: Vec<VerificationItem>,
}

impl AuditData {
    /// Returns the audit data for the current working tree.
    pub fn current() -> Self {
        Self {
            overall_percentage: 91,
            confirmed: 462,
            partial: 47,
            missing: 0,
            total: 509,
            modules: vec![
                ModuleCoverage {
                    icon: "⚙",
                    title: "fennec · engine & runtime",
                    confirmed: 38,
                    total: 42,
                    description: "Local serve, health, doctor, module discovery, reconnect, updates, workspace jail, STT, vision, TTS, outlets, and finetune are operational.",
                    tags: vec!["loopback-only", "doctor", "health"],
                    partial: vec!["auto-restart", "OS keychain", "profile model", "richer finetune diagnostics"],
                },
                ModuleCoverage {
                    icon: "◈",
                    title: "fennec-core · ACP contracts",
                    confirmed: 72,
                    total: 78,
                    description: "Typed workspace, task, message, agent, approval, artifact, tool-event, and shared event-envelope models are present with SSE streaming.",
                    tags: vec!["ACP v1", "AG-UI", "outlets"],
                    partial: vec!["native PR model", "citations", "agent profiles"],
                },
                ModuleCoverage {
                    icon: "▣",
                    title: "fennec-desktop · workspace",
                    confirmed: 87,
                    total: 95,
                    description: "Native Rust shell, persistent panels, timeline, task queue, composer, approval cards, artifacts, diffs, images, and contextual inspector are confirmed.",
                    tags: vec!["egui / eframe", "task queue", "artifacts"],
                    partial: vec!["OS-global shortcuts", "split diff", "richer agent profile selector"],
                },
                ModuleCoverage {
                    icon: "⌨",
                    title: "coding agent · orchestration",
                    confirmed: 62,
                    total: 68,
                    description: "Repository-aware task planning, edits, commands, validation, streamed events, completion summaries, and per-call approvals are confirmed.",
                    tags: vec!["tools.py", "SSE", "approval path"],
                    partial: vec!["true pause", "full native GitHub model"],
                },
            ],
            strengths: vec![
                StrengthItem {
                    title: "Safety-first execution",
                    description: "Risk, reason, files, and explicit approval accompany destructive file, command, Git, PR, and release work.",
                },
                StrengthItem {
                    title: "Real delegated outlets",
                    description: "Jev and OpenBot return structured progress, findings, artifacts, and parent-task linked results.",
                },
                StrengthItem {
                    title: "Shared local context",
                    description: "Desktop, PWA, CLI, and JetBrains share repository, branch, tasks, tools, artifacts, and attention state.",
                },
            ],
            metadata: AuditMetadata {
                version: "2.0.0 working tree",
                scope: "11 module areas",
                evidence: "repository paths",
            },
            watchlist: vec![
                WatchlistItem {
                    icon: "🔗",
                    title: "GitHub depth",
                    description: "PR state relies on gh; native data model remains bounded.",
                },
                WatchlistItem {
                    icon: "🎤",
                    title: "Voice controls",
                    description: "STT is operational; push-to-talk and language selection are incomplete.",
                },
                WatchlistItem {
                    icon: "📊",
                    title: "Finetune estimates",
                    description: "Job control works; time, storage, and sensitive-data safeguards need refinement.",
                },
            ],
            verification: vec![
                VerificationItem { title: "ACP v1 and streaming event envelope" },
                VerificationItem { title: "Approval route and outlet status" },
                VerificationItem { title: "Desktop and JetBrains sync" },
            ],
        }
    }

    /// Renders the module cards HTML.
    pub fn render_module_cards(&self) -> String {
        self.modules.iter().map(|m| {
            let tags_html = m.tags.iter().map(|t| format!("<span class=\"module-tag\">{}</span>", t)).collect::<Vec<_>>().join("");
            let partial_html = if m.partial.is_empty() {
                String::new()
            } else {
                let items = m.partial.join(" · ");
                format!("<div class=\"module-partial\"><strong>Partial:</strong> {}</div>", items)
            };
            format!(
                r#"<div class="module-card">
  <div class="module-card-header">
    <span class="module-icon">{}</span>
    <span class="module-title">{}</span>
    <span class="module-count">{} / {}</span>
  </div>
  <div class="module-desc">{}</div>
  <div class="module-tags">{}</div>
  {}
</div>"#,
                m.icon, m.title, m.confirmed, m.total, m.description, tags_html, partial_html
            )
        }).collect::<Vec<_>>().join("\n")
    }

    /// Renders the strengths section HTML.
    pub fn render_strengths(&self) -> String {
        let items = self.strengths.iter().map(|s| {
            format!(
                r#"<div class="strength-item">
  <div class="strength-item-title">{}</div>
  <div class="strength-item-desc">{}</div>
</div>"#,
                s.title, s.description
            )
        }).collect::<Vec<_>>().join("\n");

        format!(
            r#"<div class="strengths-section">
  <div class="strengths-header">
    <div>
      <div class="strengths-title">Confirmed strengths</div>
      <div class="strengths-subtitle">Cross-module capabilities verified in the audit.</div>
    </div>
    <span class="strengths-check">✓</span>
  </div>
  <div class="strengths-grid">
    {}
  </div>
</div>"#,
            items
        )
    }

    /// Renders the module status list for the inspector panel.
    pub fn render_module_status(&self) -> String {
        self.modules.iter().map(|m| {
            format!(
                r#"<div class="module-row">
  <span class="module-name">{}</span>
  <span class="module-count">{} / {}</span>
</div>"#,
                m.title.split("·").last().unwrap_or(m.title).trim(),
                m.confirmed, m.total
            )
        }).collect::<Vec<_>>().join("\n")
    }
}

/// Renders the complete audit dashboard HTML.
pub fn render_audit_dashboard() -> Html<String> {
    let data = AuditData::current();
    let module_cards = data.render_module_cards();
    let strengths = data.render_strengths();
    let module_status = data.render_module_status();

    let html = format!(
        r##"<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <meta name="theme-color" content="#15120F">
  <meta name="description" content="Fennec coding workspace. Chat, run supervised agent tasks, and inspect your server workspace.">
  <meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; worker-src 'self'; manifest-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'">
  <meta name="referrer" content="no-referrer">
  <meta name="apple-mobile-web-app-capable" content="yes">
  <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
  <title>Fennec Workspace</title>
  <link rel="icon" href="./icons/icon.svg?v=1" type="image/svg+xml">
  <link rel="apple-touch-icon" href="./icons/apple-touch-icon.png?v=1">
  <link rel="manifest" href="./manifest.webmanifest?v=1">
  <link rel="stylesheet" href="./styles.css?v=4">
</head>
<body>
  <a class="skip-link" href="#composer-input">Skip to composer</a>

  <!-- Top bar -->
  <header class="topbar">
    <div class="topbar-brand">
      <svg class="brand-shield" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
      </svg>
      <span class="brand-name">Fennec</span>
      <span class="brand-subtitle">Liso7150 / ecosystem feature audit</span>
    </div>
    <div class="topbar-status">
      <span class="status-dot" data-state="online"></span>
      <span class="status-text">Audit recorded · 2026-11-16</span>
      <button class="icon-button" type="button" aria-label="Settings">⚙</button>
      <button class="icon-button" type="button" aria-label="Collapse">⊟</button>
    </div>
  </header>

  <!-- Main three-pane layout -->
  <div class="app-layout">

    <!-- Left panel: Navigation -->
    <aside class="left-panel" aria-label="Navigation">
      <div class="workspace-section">
        <div class="section-label">ACTIVE WORKSPACE</div>
        <div class="workspace-name">Liso7150/fennec</div>
        <div class="workspace-meta">
          <span class="branch-name">main</span>
          <span class="version-badge">v2.0.0</span>
        </div>
      </div>

      <nav class="nav-section">
        <button class="nav-item active" type="button">
          <span class="nav-icon">⊞</span>
          <span class="nav-label">Coding</span>
        </button>
        <button class="nav-item" type="button">
          <span class="nav-icon">⊕</span>
          <span class="nav-label">New Task</span>
        </button>
        <button class="nav-item" type="button">
          <span class="nav-icon">◷</span>
          <span class="nav-label">My Attention</span>
          <span class="nav-badge">0</span>
        </button>
        <button class="nav-item" type="button">
          <span class="nav-icon">⌕</span>
          <span class="nav-label">Search</span>
        </button>
      </nav>

      <div class="tasks-section">
        <div class="section-header">
          <span class="section-label">RECENT TASKS</span>
          <span class="task-count">3</span>
        </div>
        <ul class="task-list">
          <li class="task-item active">
            <div class="task-item-title">Audit ecosystem feature coverage</div>
            <div class="task-item-meta">
              <span class="task-status-dot complete"></span>
              <span>Complete</span>
              <span>·</span>
              <span>509 features</span>
            </div>
          </li>
          <li class="task-item">
            <div class="task-item-title">Verify ACP event contracts</div>
            <div class="task-item-meta">
              <span class="task-status-dot complete"></span>
              <span>Complete</span>
              <span>·</span>
              <span>fennec-core</span>
            </div>
          </li>
          <li class="task-item">
            <div class="task-item-title">Review 2.0.0 release integrity</div>
            <div class="task-item-meta">
              <span class="task-status-dot queued"></span>
              <span>Queued</span>
              <span>·</span>
              <span>all repositories</span>
            </div>
          </li>
        </ul>
      </div>

      <div class="user-section">
        <div class="user-name">Liso7150</div>
        <div class="user-account">Local account · loopback runtime</div>
      </div>
    </aside>

    <!-- Center panel: Timeline and composer -->
    <main class="center-panel">
      <!-- Breadcrumb header -->
      <div class="center-breadcrumb">
        <span>FEATURE AUDIT</span>
        <span class="breadcrumb-sep">·</span>
        <span>2026-11-16</span>
        <span class="breadcrumb-sep">·</span>
        <span>WORKING TREE</span>
      </div>

      <!-- Title section with coverage card -->
      <div class="center-title-section">
        <div class="title-content">
          <h1>Fennec ecosystem implementation coverage</h1>
          <p class="task-subtitle">Evidence-led audit across engine, core, desktop, coding agent, finetune, and JetBrains integration.</p>
        </div>
        <div class="coverage-card">
          <div class="coverage-label">OVERALL COVERAGE</div>
          <div class="coverage-value">{}%</div>
          <div class="coverage-detail">{} / {} confirmed</div>
        </div>
      </div>

      <!-- Stat cards -->
      <div class="stat-cards">
        <div class="stat-card confirmed">
          <div class="stat-label">CONFIRMED</div>
          <div class="stat-value">{} <span class="stat-unit">operational features</span></div>
        </div>
        <div class="stat-card partial">
          <div class="stat-label">PARTIAL</div>
          <div class="stat-value">{} <span class="stat-unit">bounded follow-ups</span></div>
        </div>
        <div class="stat-card missing">
          <div class="stat-label">MISSING</div>
          <div class="stat-value">{} <span class="stat-unit">unsupported features</span></div>
        </div>
      </div>

      <!-- Module cards -->
      <div class="module-grid">
        {}
      </div>

      <!-- Confirmed strengths -->
      {}

      <!-- Timeline -->
      <div class="timeline">
        <div class="message">
          <div class="message-header">
            <div class="message-avatar user">👤</div>
            <span class="message-author user">Liso7150</span>
            <span class="message-time">10:16</span>
          </div>
          <div class="message-body">Map the consolidated feature list to actual implementation state and keep every claim tied to repository evidence.</div>
        </div>
        <div class="message">
          <div class="message-header">
            <div class="message-avatar agent">🤖</div>
            <span class="message-author agent">Fennec</span>
            <span class="message-time">10:18</span>
            <span class="message-status">Audit complete</span>
          </div>
          <div class="message-body">The core workflow is operational: local runtime, ACP streaming, approvals, repository tools, delegated outlets, desktop context, and JetBrains sync are confirmed. The remaining work is enhancement, not an unbuilt product surface.</div>
        </div>
      </div>

      <!-- Task queue -->
      <div class="task-queue">
        <div class="task-queue-header">
          <span class="task-queue-icon">☰</span>
          <span class="task-queue-title">Task queue</span>
          <span class="task-queue-count">3 audit follow-ups</span>
          <button class="task-queue-view-all" type="button">View all</button>
        </div>
        <ul class="task-queue-list">
          <li class="task-queue-item">
            <span class="queue-dot"></span>
            <span class="queue-title">Document native GitHub integration boundary beyond gh</span>
            <span class="queue-status">Partial</span>
          </li>
          <li class="task-queue-item">
            <span class="queue-dot"></span>
            <span class="queue-title">Add push-to-talk, language selection, and long-response TTS summaries</span>
            <span class="queue-status">Partial</span>
          </li>
          <li class="task-queue-item">
            <span class="queue-dot"></span>
            <span class="queue-title">Improve finetune estimates and sensitive-data scanning</span>
            <span class="queue-status">Partial</span>
          </li>
        </ul>
      </div>

      <!-- Composer -->
      <div class="composer">
        <textarea id="composer-input" rows="2" placeholder="Ask Fennec to inspect, edit, test, or explain your code" maxlength="32000"></textarea>
        <div class="composer-toolbar">
          <div class="composer-tools">
            <button class="tool-button" type="button" aria-label="Add">+</button>
            <button class="tool-button" type="button" aria-label="Attach">📎</button>
            <button class="tool-button" type="button" aria-label="Dictate">🎤</button>
            <span class="composer-hint">Dictation available</span>
          </div>
          <button class="send-button" type="button" disabled>
            <span>↑</span>
          </button>
        </div>
      </div>
    </main>

    <!-- Right panel: Inspector -->
    <aside class="right-panel" aria-label="Inspector">
      <div class="inspector-header">
        <div>
          <div class="inspector-title">Audit context</div>
          <div class="inspector-subtitle">Implementation evidence</div>
        </div>
        <button class="icon-button" type="button" aria-label="Collapse inspector">⊟</button>
      </div>

      <!-- Audit Metadata -->
      <div class="inspector-section">
        <div class="inspector-section-header">
          <span>AUDIT METADATA</span>
          <span class="section-status complete">Complete</span>
        </div>
        <div class="metadata-grid">
          <div class="metadata-row">
            <span class="metadata-key">Version</span>
            <span class="metadata-value">{}</span>
          </div>
          <div class="metadata-row">
            <span class="metadata-key">Scope</span>
            <span class="metadata-value">{}</span>
          </div>
          <div class="metadata-row">
            <span class="metadata-key">Evidence</span>
            <span class="metadata-value">{}</span>
          </div>
        </div>
      </div>

      <!-- Module Status -->
      <div class="inspector-section">
        <div class="inspector-section-label">MODULE STATUS</div>
        <div class="module-list">
          {}
        </div>
      </div>

      <!-- Partial Watchlist -->
      <div class="inspector-section">
        <div class="inspector-section-label">PARTIAL WATCHLIST</div>
        <div class="watchlist-item">
          <span class="watchlist-icon">🔗</span>
          <div class="watchlist-content">
            <div class="watchlist-title">GitHub depth</div>
            <div class="watchlist-desc">PR state relies on gh; native data model remains bounded.</div>
          </div>
        </div>
        <div class="watchlist-item">
          <span class="watchlist-icon">🎤</span>
          <div class="watchlist-content">
            <div class="watchlist-title">Voice controls</div>
            <div class="watchlist-desc">STT is operational; push-to-talk and language selection are incomplete.</div>
          </div>
        </div>
        <div class="watchlist-item">
          <span class="watchlist-icon">📊</span>
          <div class="watchlist-content">
            <div class="watchlist-title">Finetune estimates</div>
            <div class="watchlist-desc">Job control works; time, storage, and sensitive-data safeguards need refinement.</div>
          </div>
        </div>
      </div>

      <!-- Verification Context -->
      <div class="inspector-section">
        <div class="inspector-section-label">VERIFICATION CONTEXT</div>
        <div class="verification-list">
          <div class="verification-item">
            <span class="check-icon">✓</span>
            <span>ACP v1 and streaming event envelope</span>
          </div>
          <div class="verification-item">
            <span class="check-icon">✓</span>
            <span>Approval route and outlet status</span>
          </div>
          <div class="verification-item">
            <span class="check-icon">✓</span>
            <span>Desktop and JetBrains sync</span>
          </div>
        </div>
      </div>
    </aside>

  </div>
</body>
</html>"##,
        data.overall_percentage, data.confirmed, data.total,
        data.confirmed, data.partial, data.missing,
        module_cards, strengths,
        data.metadata.version, data.metadata.scope, data.metadata.evidence,
        module_status
    );

    Html(html)
}
