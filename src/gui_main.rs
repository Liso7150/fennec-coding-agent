use fennec_client::coding_agent::CodingAgentClient;

use gpui_kit::base::Root;
use gpui_kit::component::{
    ActiveTheme, Disableable, Sizable, WindowExt,
    button::{Button, ButtonVariants},
    input::{Input, InputEvent, InputState},
    label::Label,
    notification::Notification,
    scroll::ScrollableElement,
    Theme, ThemeMode,
};
use gpui_kit::prelude::*;
use gpui_kit::*;
use gpui::hsla;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::cell::{Cell, RefCell};
use std::rc::Rc;
use std::sync::Arc;

#[derive(Clone, Debug)]
struct ThemePreset {
    name: &'static str,
    mode: ThemeMode,
    accent: [f32; 4],
    background: [f32; 4],
    muted: [f32; 4],
    border: [f32; 4],
    theme_id: &'static str,
}

impl ThemePreset {
    fn apply(&self, cx: &mut gpui::App) {
        Theme::update(cx, |theme| {
            theme.mode = self.mode;
            theme.colors.accent = hsla(self.accent[0], self.accent[1], self.accent[2], self.accent[3]);
            theme.colors.primary = hsla(self.accent[0], self.accent[1], self.accent[2], self.accent[3]);
            theme.colors.button_primary = hsla(self.accent[0], self.accent[1], self.accent[2], self.accent[3]);
            theme.colors.link = hsla(self.accent[0], self.accent[1], self.accent[2], self.accent[3]);
            theme.colors.background = hsla(self.background[0], self.background[1], self.background[2], self.background[3]);
            theme.colors.muted = hsla(self.muted[0], self.muted[1], self.muted[2], self.muted[3]);
            theme.colors.border = hsla(self.border[0], self.border[1], self.border[2], self.border[3]);
        });
    }

    fn id(&self) -> &str {
        self.theme_id
    }
}

const WARM_WINDOW: std::time::Duration = std::time::Duration::from_secs(300);

fn theme_presets() -> Vec<ThemePreset> {
    vec![
        // Dark: neutral gray background
        ThemePreset {
            name: "Dark", mode: ThemeMode::Dark,
            accent: [210.0/360.0, 0.5, 0.5, 1.0],
            background: [0.0, 0.0, 0.08, 1.0],
            muted: [0.0, 0.0, 0.12, 1.0],
            border: [0.0, 0.0, 0.18, 1.0],
            theme_id: "dark",
        },
        // Light: white background
        ThemePreset {
            name: "Light", mode: ThemeMode::Light,
            accent: [210.0/360.0, 0.5, 0.5, 1.0],
            background: [0.0, 0.0, 0.98, 1.0],
            muted: [0.0, 0.0, 0.94, 1.0],
            border: [0.0, 0.0, 0.88, 1.0],
            theme_id: "light",
        },
        // Ocean: deep blue background
        ThemePreset {
            name: "Ocean", mode: ThemeMode::Dark,
            accent: [55.0/360.0, 0.7, 0.5, 1.0],
            background: [0.6, 0.4, 0.08, 1.0],
            muted: [0.6, 0.35, 0.12, 1.0],
            border: [0.6, 0.3, 0.2, 1.0],
            theme_id: "ocean",
        },
        // Forest: dark green background
        ThemePreset {
            name: "Forest", mode: ThemeMode::Dark,
            accent: [35.0/360.0, 0.6, 0.45, 1.0],
            background: [0.33, 0.3, 0.06, 1.0],
            muted: [0.33, 0.25, 0.1, 1.0],
            border: [0.33, 0.2, 0.16, 1.0],
            theme_id: "forest",
        },
        // Sunset: warm orange/red background
        ThemePreset {
            name: "Sunset", mode: ThemeMode::Dark,
            accent: [10.0/360.0, 0.75, 0.55, 1.0],
            background: [0.05, 0.5, 0.08, 1.0],
            muted: [0.05, 0.45, 0.12, 1.0],
            border: [0.05, 0.4, 0.2, 1.0],
            theme_id: "sunset",
        },
        // Lavender: purple background
        ThemePreset {
            name: "Lavender", mode: ThemeMode::Dark,
            accent: [75.0/360.0, 0.55, 0.6, 1.0],
            background: [0.75, 0.3, 0.08, 1.0],
            muted: [0.75, 0.25, 0.12, 1.0],
            border: [0.75, 0.2, 0.2, 1.0],
            theme_id: "lavender",
        },
        // Coffee: warm brown background
        ThemePreset {
            name: "Coffee", mode: ThemeMode::Dark,
            accent: [30.0/360.0, 0.6, 0.65, 1.0],
            background: [0.07, 0.5, 0.1, 1.0],
            muted: [0.07, 0.45, 0.15, 1.0],
            border: [0.07, 0.4, 0.22, 1.0],
            theme_id: "coffee",
        },
    ]
}

fn find_preset_index(theme_id: &str) -> usize {
    theme_presets().iter().position(|p| p.id() == theme_id).unwrap_or(0)
}

#[derive(Clone, Serialize, Deserialize, Debug)]
struct Msg {
    id: u64,
    author: String,
    content: String,
    kind: MsgKind,
    time: String,
    collapsed: bool,
    meta: Option<MsgMeta>,
}

#[derive(Clone, Serialize, Deserialize, Debug, PartialEq, Eq)]
enum MsgKind { User, Think, Action, Attach, Edit, Result }

#[derive(Clone, Serialize, Deserialize, Debug)]
struct MsgMeta {
    duration: Option<String>,
    title: Option<String>,
    add: Option<usize>,
    del: Option<usize>,
    path: Option<String>,
    size: Option<String>,
}

#[derive(Clone)]
struct Toast {
    text: String,
    good: bool,
    at: std::time::Instant,
}

#[derive(Clone, Serialize, Deserialize, Debug)]
struct ApprovalRequest {
    id: String,
    action: String,
    risk_level: String,
    command: Option<String>,
    resolved: Option<ApprovalResolution>,
}

#[derive(Clone, Serialize, Deserialize, Debug)]
struct ApprovalResolution {
    choice_id: String,
}

#[derive(Clone, Serialize, Deserialize, Debug)]
struct Task {
    id: u64,
    title: String,
    status: String,
    repo: String,
    msgs: Vec<Msg>,
    #[serde(default)]
    backend_id: Option<String>,
    #[serde(default)]
    started_at: Option<i64>,
    #[serde(default)]
    approvals: Vec<ApprovalRequest>,
    #[serde(default)]
    workspace_id: Option<String>,
}

#[derive(Serialize, Deserialize)]
struct History {
    tasks: Vec<Task>,
    active: Option<u64>,
    #[serde(default)]
    queued: Vec<String>,
}

#[derive(Serialize, Deserialize, Default, Clone)]
struct Settings {
    server_url: Option<String>,
    engine_url: Option<String>,
    api_key: Option<String>,
    model: Option<String>,
    access_mode: Option<String>,
    theme: Option<String>,
    font_size: Option<f32>,
    auto_save: Option<bool>,
    notifications: Option<bool>,
    debug_mode: Option<bool>,
    experimental_features: Option<bool>,
    allow_write: Option<bool>,
    allow_shell: Option<bool>,
    allow_web: Option<bool>,
    ask_each: Option<bool>,
}

#[derive(Clone, Serialize, Deserialize, Debug)]
struct Workspace {
    id: String,
    name: String,
    icon: String,
    color: String,
    source_folders: Vec<String>,
    indexed: bool,
}

impl Workspace {
    fn new(name: String) -> Self {
        Self {
            id: uuid::Uuid::new_v4().to_string(),
            name,
            icon: "folder".to_string(),
            color: "orange".to_string(),
            source_folders: vec![],
            indexed: true,
        }
    }
}

#[derive(Serialize, Deserialize, Default)]
struct WorkspaceStore {
    workspaces: Vec<Workspace>,
    active_id: Option<String>,
}

struct App {
    tasks: Vec<Task>,
    active: Option<u64>,
    queued: Vec<String>,
    inspector: bool,
    attention_only: bool,
    search_open: bool,
    search: Entity<InputState>,
    composer: Entity<InputState>,
    server_url: String,
    engine_url: String,
    api_key: String,
    model: String,
    access_mode: String,
    theme: String,
    font_size: f32,
    auto_save: bool,
    notifications: bool,
    debug_mode: bool,
    experimental_features: bool,
    allow_write: bool,
    allow_shell: bool,
    allow_web: bool,
    ask_each: bool,
    settings_path: PathBuf,
    backend_ok: bool,
    agents: Vec<String>,
    path: PathBuf,
    next_id: u64,
    response_rx: std::sync::mpsc::Receiver<BackendResponse>,
    response_tx: std::sync::mpsc::Sender<BackendResponse>,
    pending_think: Option<(u64, u64)>,
    pending_content: Option<(u64, u64)>,
    tools: std::collections::HashMap<String, (u64, u64)>,
    _task: gpui_kit::Task<()>,
    scroll_handle: ScrollHandle,
    line: String,
    toasts: Vec<Toast>,
    pending_send: Option<(String, std::time::Instant)>,
    workspaces: Vec<Workspace>,
    active_workspace_id: Option<String>,
    workspaces_path: PathBuf,
}

#[derive(Debug)]
enum BackendResponse {
    Offline,
    Error(String),
    TaskCreated { task_id: u64, backend_id: String },
    ThinkDelta(String),
    ContentDelta(String),
    ActionStarted { tool_id: String, title: String },
    ActionDone { tool_id: String, duration: Option<String>, detail: String },
    Complete { task_id: u64, status: String, final_text: String },
    Failed(String),
    BackendInfo { names: Vec<String>, healthy: bool },
}

// ---- Rich markdown rendering ----

#[derive(Clone, PartialEq, Debug)]
enum Block {
    Prose(String),
    Code { lang: String, body: String },
}

fn rich_blocks(text: &str) -> Vec<Block> {
    let mut out = Vec::new();
    let mut rest = text;
    while let Some(open) = rest.find("```") {
        let before = &rest[..open];
        if !before.trim().is_empty() {
            out.push(Block::Prose(before.trim().to_string()));
        }
        let after = &rest[open + 3..];
        let (body, tail) = match after.find("```") {
            Some(end) => (&after[..end], &after[end + 3..]),
            None => (after, ""),
        };
        let body = body.trim();
        let (lang, code) = match body.split_once('\n') {
            Some((first, code)) => match info_string(first) {
                Some(lang) => (lang.to_string(), code.trim().to_string()),
                None => (String::new(), body.to_string()),
            },
            None => (String::new(), body.to_string()),
        };
        out.push(Block::Code { lang, body: code });
        rest = tail;
    }
    if !rest.trim().is_empty() {
        out.push(Block::Prose(rest.trim().to_string()));
    }
    out
}

fn info_string(line: &str) -> Option<&str> {
    let t = line.trim();
    (!t.is_empty()
        && t.len() <= 16
        && t.chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '-' | '_' | '.')))
        .then_some(t)
}

#[derive(Clone, PartialEq, Debug)]
enum Run {
    Text(String),
    Code(String),
    Strong(String),
    Em(String),
    Link { label: String, url: String },
}

#[derive(Clone, PartialEq, Debug)]
struct MdLine {
    head: u8,
    bullet: bool,
    runs: Vec<Run>,
}

fn md_lines(text: &str) -> Vec<MdLine> {
    let mut out = Vec::new();
    for raw in text.lines() {
        let line = raw.trim();
        if line.is_empty() {
            continue;
        }
        let hashes = line.chars().take_while(|c| *c == '#').count();
        let (head, body) = if hashes > 0 && hashes <= 4 && line[hashes..].starts_with(' ') {
            (hashes as u8, line[hashes..].trim_start())
        } else {
            (0u8, line)
        };
        let mut bullet = false;
        let mut rest = body;
        for m in ["- ", "* ", "+ "] {
            if let Some(r) = rest.strip_prefix(m) {
                bullet = true;
                rest = r;
                break;
            }
        }
        out.push(MdLine { head, bullet, runs: md_runs(rest) });
    }
    out
}

fn md_runs(text: &str) -> Vec<Run> {
    let mut runs: Vec<Run> = Vec::new();
    let mut buf = String::new();
    let mut rest = text;
    while !rest.is_empty() {
        let mut best: Option<(usize, usize, u8)> = None;
        for (idx, len, kind) in [
            (rest.find('`'), 1usize, 1u8),
            (rest.find("**"), 2, 2),
            (rest.find('*'), 1, 3),
            (rest.find('['), 1, 4),
        ] {
            let Some(i) = idx else { continue };
            let wins = match best {
                None => true,
                Some((bi, bl, _)) => i < bi || (i == bi && len > bl),
            };
            if wins {
                best = Some((i, len, kind));
            }
        }
        let Some((at, open_len, kind)) = best else {
            buf.push_str(rest);
            break;
        };
        buf.push_str(&rest[..at]);
        rest = &rest[at..];
        if kind == 4 {
            match md_link(rest) {
                Some((label, url, used)) => {
                    if !buf.is_empty() {
                        runs.push(Run::Text(std::mem::take(&mut buf)));
                    }
                    runs.push(Run::Link { label, url });
                    rest = &rest[used..];
                }
                None => {
                    buf.push('[');
                    rest = &rest[1..];
                }
            }
            continue;
        }
        let close_len = open_len;
        let body = &rest[open_len..];
        match body.find(&rest[..close_len]) {
            Some(end) if end > 0 => {
                if !buf.is_empty() {
                    runs.push(Run::Text(std::mem::take(&mut buf)));
                }
                let text = body[..end].to_string();
                runs.push(match kind {
                    1 => Run::Code(text),
                    2 => Run::Strong(text),
                    _ => Run::Em(text),
                });
                rest = &rest[open_len + end + close_len..];
            }
            _ => {
                buf.push_str(&rest[..open_len]);
                rest = &rest[open_len..];
            }
        }
    }
    if !buf.is_empty() {
        runs.push(Run::Text(buf));
    }
    runs
}

fn md_link(s: &str) -> Option<(String, String, usize)> {
    let after = s.strip_prefix('[')?;
    let split = after.find("](")?;
    let label = &after[..split];
    let tail = &after[split + 2..];
    let end = tail.find(')')?;
    Some((label.to_string(), tail[..end].to_string(), 1 + split + 2 + end + 1))
}

fn rich_div(t: &Theme, text: &str, dim: bool) -> Div {
    let base = if dim { 12.0 } else { 13.5 };
    let mut col = div().flex().flex_col().gap_2().max_w(px(680.0));
    for (bi, b) in rich_blocks(text).into_iter().enumerate() {
        col = col.child(div().id(ElementId::NamedInteger("blk".into(), bi as u64)).child(match b {
            Block::Prose(p) => md_div(t, &p, base, dim),
            Block::Code { lang, body } => code_block(t, &lang, &body),
        }));
    }
    col
}

fn md_div(t: &Theme, text: &str, base: f32, dim: bool) -> Div {
    let mut col = div().flex().flex_col().gap_1();
    for (li, line) in md_lines(text).into_iter().enumerate() {
        if line.runs.is_empty() {
            continue;
        }
        let size = base + match line.head { 1 => 6.0, 2 => 3.5, 3 => 1.5, _ => 0.0 };
        let body = if line.head > 0 { t.foreground } else if dim { t.muted_foreground } else { t.foreground };
        let mut row = div().id(ElementId::NamedInteger("mdl".into(), li as u64)).flex().flex_row().flex_wrap().items_center();
        if line.bullet {
            row = row.child(div().flex_shrink_0().child(Label::new("•").text_size(px(size)).text_color(body)));
        }
        for (ri, run) in line.runs.iter().enumerate() {
            row = row.child(run_div(t, run, size, body, line.head > 0, ri));
        }
        col = col.child(row);
    }
    col
}

fn run_div(t: &Theme, run: &Run, size: f32, body: Hsla, heading: bool, idx: usize) -> impl IntoElement {
    let id = ElementId::NamedInteger("mdr".into(), idx as u64);
    match run {
        Run::Text(s) => {
            let mut l = Label::new(s.clone()).text_size(px(size)).text_color(body);
            if heading {
                l = l.font_weight(FontWeight::SEMIBOLD);
            }
            div().id(id).child(l)
        }
        Run::Strong(s) => div().id(id).child(
            Label::new(s.clone()).text_size(px(size)).text_color(t.foreground).font_weight(FontWeight::SEMIBOLD)
        ),
        Run::Em(s) => div().id(id).italic().child(Label::new(s.clone()).text_size(px(size)).text_color(body)),
        Run::Code(s) => div().id(id).rounded_md().bg(t.muted).px_1().font_family("monospace").child(
            Label::new(s.clone()).text_size(px((size - 1.0).max(9.0))).text_color(t.foreground)
        ),
        Run::Link { label, url } => div().id(id).flex().flex_row().flex_wrap().items_center()
            .child(Label::new(label.clone()).text_size(px(size)).text_color(t.primary))
            .child(Label::new(format!(" ({url})")).font_family("monospace")
                .text_size(px((size - 1.5).max(9.0))).text_color(t.muted_foreground)),
    }
}

fn code_block(t: &Theme, lang: &str, code: &str) -> Div {
    let mut col = div().flex().flex_col().gap_1().max_w(px(680.0))
        .rounded_md().border_1().border_color(t.border).bg(t.muted).px_3().py_2();
    if !lang.is_empty() {
        col = col.child(div().font_family("monospace")
            .child(Label::new(lang.to_string()).text_size(px(10.0)).text_color(t.muted_foreground)));
    }
    col = col.child(div().font_family("monospace").max_h(px(240.0)).overflow_y_scrollbar()
        .child(Label::new(code.to_string()).text_size(px(12.0)).text_color(t.foreground)));
    col
}

impl App {
    fn new(
        path: PathBuf,
        settings_path: PathBuf,
        composer: Entity<InputState>,
        search: Entity<InputState>,
        window: &Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let (tx, rx) = std::sync::mpsc::channel();

        let _task = cx.spawn(async move |weak, cx: &mut AsyncApp| {
            let mut last_tick = std::time::Instant::now();
            loop {
                cx.background_executor().timer(std::time::Duration::from_millis(50)).await;
                if weak.update(cx, |a, cx| {
                    a.poll_responses(cx);
                    a.toasts.retain(|t| t.at.elapsed() < std::time::Duration::from_secs(6));
                    if a.working() && last_tick.elapsed() >= std::time::Duration::from_secs(1) {
                        last_tick = std::time::Instant::now();
                        cx.notify();
                    }
                }).is_err() {
                    break;
                }
            }
        });

        cx.observe(&search, |_, _, cx| cx.notify()).detach();
        cx.subscribe_in(&composer, window, |this, _, event: &InputEvent, window, cx| {
            match event {
                InputEvent::Change => cx.notify(),
                InputEvent::PressEnter { .. } => this.send(window, cx),
                _ => {}
            }
        }).detach();

        let settings = load_settings(&settings_path);
        let server_url = settings.server_url
            .or_else(|| std::env::var("FENNEC_AGENT_URL").ok())
            .unwrap_or_else(|| "http://127.0.0.1:8787".into());
        let engine_url = settings.engine_url
            .or_else(|| std::env::var("FENNEC_ENGINE_URL").ok())
            .unwrap_or_else(|| "http://127.0.0.1:8184".into());
        let api_key = settings.api_key
            .or_else(|| std::env::var("FENNEC_API_KEY").ok())
            .or_else(|| std::env::var("COLI_API_KEY").ok())
            .unwrap_or_else(|| "local".into());
        let model = settings.model.unwrap_or_else(|| "qwen3_5_moe".into());
        let access_mode = settings.access_mode.unwrap_or_else(|| "ask".into());
        let theme = settings.theme.unwrap_or_else(|| "dark".into());
        let font_size = settings.font_size.unwrap_or(14.0);
        let auto_save = settings.auto_save.unwrap_or(true);
        let notifications = settings.notifications.unwrap_or(true);
        let debug_mode = settings.debug_mode.unwrap_or(false);
        let experimental_features = settings.experimental_features.unwrap_or(false);
        let allow_write = settings.allow_write.unwrap_or(false);
        let allow_shell = settings.allow_shell.unwrap_or(false);
        let allow_web = settings.allow_web.unwrap_or(false);
        let ask_each = settings.ask_each.unwrap_or(false);

        let mut app = Self {
            tasks: vec![], active: None, queued: vec![], inspector: true,
            attention_only: false, search_open: false, search, composer,
            server_url, engine_url, api_key, model, access_mode, theme, font_size, auto_save,
            notifications, debug_mode, experimental_features,
            allow_write, allow_shell, allow_web, ask_each,
            settings_path: settings_path.clone(), backend_ok: false, agents: vec![],
            path, next_id: 1, response_rx: rx, response_tx: tx,
            pending_think: None, pending_content: None, tools: std::collections::HashMap::new(),
            _task, scroll_handle: ScrollHandle::new(), line: String::new(), toasts: Vec::new(), pending_send: None,
            workspaces: vec![], active_workspace_id: None,
            workspaces_path: settings_path.parent().unwrap_or(&settings_path).join("workspaces.json"),
        };
        app.load_workspaces();
        app.fetch_backend_info();
        app
    }

    fn load(&mut self) {
        if let Ok(s) = std::fs::read_to_string(&self.path) {
            if let Ok(h) = serde_json::from_str::<History>(&s) {
                self.queued = h.queued;
                self.tasks = h.tasks;
                self.active = h.active;
                // Files written before ids were seeded correctly can hold
                // duplicates; identical ids render as identical a11y node ids
                // (panic in debug builds) and toggle(id) would hit every row.
                let mut next = self
                    .tasks
                    .iter()
                    .map(|t| t.id)
                    .chain(self.tasks.iter().flat_map(|t| t.msgs.iter().map(|m| m.id)))
                    .max()
                    .unwrap_or(0)
                    + 1;
                let mut seen_tasks = std::collections::HashSet::new();
                let mut seen_msgs = std::collections::HashSet::new();
                for t in self.tasks.iter_mut() {
                    let old = t.id;
                    if !seen_tasks.insert(old) {
                        t.id = next;
                        next += 1;
                        if self.active == Some(old) {
                            self.active = Some(t.id);
                        }
                    }
                    for m in t.msgs.iter_mut() {
                        if !seen_msgs.insert(m.id) {
                            m.id = next;
                            next += 1;
                        }
                    }
                }
                self.next_id = next;
            }
        }
        if let Some(t) = self.task_mut() {
            if t.status == "Running" {
                t.status = "Failed".into();
                if let Some(m) = t.msgs.iter_mut().find(|m| m.kind == MsgKind::Think) {
                    m.content = "Interrupted by restart.".into();
                    m.kind = MsgKind::Result;
                }
            }
        }
        self.pending_think = None;
        self.pending_content = None;
        self.tools.clear();
    }

    fn save(&self) {
        let h = History { tasks: self.tasks.clone(), active: self.active, queued: self.queued.clone() };
        if let Ok(s) = serde_json::to_string_pretty(&h) {
            let _ = std::fs::write(&self.path, s);
        }
    }

    fn save_settings(&self) {
        let s = Settings {
            server_url: Some(self.server_url.clone()),
            engine_url: Some(self.engine_url.clone()),
            api_key: Some(self.api_key.clone()),
            model: Some(self.model.clone()),
            access_mode: Some(self.access_mode.clone()),
            theme: Some(self.theme.clone()),
            font_size: Some(self.font_size),
            auto_save: Some(self.auto_save),
            notifications: Some(self.notifications),
            debug_mode: Some(self.debug_mode),
            experimental_features: Some(self.experimental_features),
            allow_write: Some(self.allow_write),
            allow_shell: Some(self.allow_shell),
            allow_web: Some(self.allow_web),
            ask_each: Some(self.ask_each),
        };
        if let Ok(s) = serde_json::to_string_pretty(&s) {
            let _ = std::fs::write(&self.settings_path, s);
        }
    }

    fn load_workspaces(&mut self) {
        if let Ok(s) = std::fs::read_to_string(&self.workspaces_path) {
            if let Ok(store) = serde_json::from_str::<WorkspaceStore>(&s) {
                self.workspaces = store.workspaces;
                self.active_workspace_id = store.active_id;
            }
        }
        if self.workspaces.is_empty() {
            let default = Workspace::new("Liso7150/fennec".to_string());
            self.workspaces.push(default);
            self.active_workspace_id = Some(self.workspaces[0].id.clone());
            self.save_workspaces();
        }
    }

    fn save_workspaces(&self) {
        let store = WorkspaceStore {
            workspaces: self.workspaces.clone(),
            active_id: self.active_workspace_id.clone(),
        };
        if let Ok(s) = serde_json::to_string_pretty(&store) {
            let _ = std::fs::write(&self.workspaces_path, s);
        }
    }

    fn active_workspace(&self) -> Option<&Workspace> {
        self.active_workspace_id.as_ref()
            .and_then(|id| self.workspaces.iter().find(|w| &w.id == id))
    }

    fn add_workspace(&mut self, name: String, source_folders: Vec<String>, icon: String, color: String, indexed: bool) {
        let mut ws = Workspace::new(name);
        ws.source_folders = source_folders;
        ws.icon = icon;
        ws.color = color;
        ws.indexed = indexed;
        let id = ws.id.clone();
        self.workspaces.push(ws);
        self.active_workspace_id = Some(id);
        self.save_workspaces();
    }

    fn delete_workspace(&mut self, id: &str) {
        self.workspaces.retain(|w| w.id != id);
        if self.active_workspace_id.as_deref() == Some(id) {
            self.active_workspace_id = self.workspaces.first().map(|w| w.id.clone());
        }
        self.save_workspaces();
    }

    fn select_workspace(&mut self, id: &str) {
        self.active_workspace_id = Some(id.to_string());
        self.save_workspaces();
    }

    fn fetch_backend_info(&self) {
        let url = self.server_url.clone();
        let tx = self.response_tx.clone();
        std::thread::spawn(move || {
            let client = CodingAgentClient::with_base(url);
            let healthy = client.health().is_some();
            let names = if healthy {
                client.list_agents().iter()
                    .filter_map(|v| v.get("name").and_then(|n| n.as_str()).map(|s| s.to_string()))
                    .collect()
            } else {
                vec![]
            };
            let _ = tx.send(BackendResponse::BackendInfo { names, healthy });
        });
    }

    fn poll_responses(&mut self, cx: &mut Context<Self>) {
        while let Ok(resp) = self.response_rx.try_recv() {
            match resp {
                BackendResponse::BackendInfo { names, healthy } => {
                    self.agents = names;
                    self.backend_ok = healthy;
                    self.flush_warm_queue();
                }
                BackendResponse::Offline => {
                    self.finish_think("Backend offline — start `fennec-agent` or set the server URL in Settings.");
                    if let Some((tid, _)) = self.pending_think { self.set_task_status(tid, "Failed"); }
                    self.pending_think = None;
                    self.pending_content = None;
                }
                BackendResponse::Error(e) => {
                    self.finish_think(&format!("Backend error: {e}"));
                    if let Some((tid, _)) = self.pending_think { self.set_task_status(tid, "Failed"); }
                    self.pending_think = None;
                    self.pending_content = None;
                }
                BackendResponse::TaskCreated { task_id, backend_id } => {
                    if let Some(t) = self.tasks.iter_mut().find(|t| t.id == task_id) {
                        t.backend_id = Some(backend_id);
                    }
                }
                BackendResponse::ThinkDelta(text) => {
                    if let Some((tid, mid)) = self.pending_think {
                        if let Some(m) = self.msg_mut(tid, mid) {
                            if m.content == "Thinking…" { m.content = text; }
                            else { m.content.push_str(&text); }
                        }
                    }
                }
                BackendResponse::ContentDelta(text) => {
                    let (tid, mid) = match self.pending_content {
                        Some(pair) => pair,
                        None => {
                            let Some((tid, _)) = self.pending_think else { continue };
                            let mid = self.next_id;
                            self.next_id += 1;
                            if let Some(t) = self.tasks.iter_mut().find(|t| t.id == tid) {
                                t.msgs.push(Msg {
                                    id: mid, author: "Fennec".into(), content: String::new(),
                                    kind: MsgKind::Result, time: now(), collapsed: false, meta: None,
                                });
                            }
                            self.pending_content = Some((tid, mid));
                            self.scroll_handle.scroll_to_bottom();
                            (tid, mid)
                        }
                    };
                    if let Some(m) = self.msg_mut(tid, mid) {
                        m.content.push_str(&text);
                    }
                    self.scroll_handle.scroll_to_bottom();
                }
                BackendResponse::ActionStarted { tool_id, title } => {
                    let Some((tid, _)) = self.pending_think else { continue };
                    let mid = self.next_id;
                    self.next_id += 1;
                    if let Some(t) = self.tasks.iter_mut().find(|t| t.id == tid) {
                        t.msgs.push(Msg {
                            id: mid, author: "Fennec".into(), content: String::new(),
                            kind: MsgKind::Action, time: now(), collapsed: true,
                            meta: Some(MsgMeta {
                                duration: None, title: Some(title),
                                add: None, del: None, path: None, size: None,
                            }),
                        });
                    }
                    self.tools.insert(tool_id, (tid, mid));
                }
                BackendResponse::ActionDone { tool_id, duration, detail } => {
                    if let Some(&(tid, mid)) = self.tools.get(&tool_id) {
                        if let Some(m) = self.msg_mut(tid, mid) {
                            if let Some(meta) = m.meta.as_mut() { meta.duration = duration; }
                            m.content = detail;
                        }
                    }
                    self.tools.remove(&tool_id);
                }
                BackendResponse::Complete { task_id, status, final_text } => {
                    let (think, content) = (self.pending_think, self.pending_content);
                    if let Some((tid, mid)) = think {
                        if status == "Failed" && content.is_none() && final_text.is_empty() {
                            // A failed send with nothing streamed keeps an error
                            // row in the timeline instead of vanishing.
                            self.finish_think("The engine did not respond to this task.");
                        } else {
                            // Thoughts stay in the timeline after completion; drop
                            // the row only when no thought text ever streamed in.
                            if let Some(t) = self.tasks.iter_mut().find(|t| t.id == tid) {
                                if t.msgs.iter().any(|m| m.id == mid && m.content == "Thinking…") {
                                    t.msgs.retain(|m| m.id != mid);
                                }
                            }
                        }
                    }
                    match content {
                        Some((tid, mid)) => {
                            if !final_text.is_empty() {
                                if let Some(m) = self.msg_mut(tid, mid) { m.content = final_text; }
                            }
                        }
                        None => {
                            if !final_text.is_empty() {
                                let mid = self.next_id;
                                self.next_id += 1;
                                if let Some(t) = self.tasks.iter_mut().find(|t| t.id == task_id) {
                                    t.msgs.push(Msg {
                                        id: mid, author: "Fennec".into(), content: final_text,
                                        kind: MsgKind::Result, time: now(), collapsed: false, meta: None,
                                    });
                                }
                            }
                        }
                    }
                    self.set_task_status(task_id, &status);
                    self.pending_think = None;
                    self.pending_content = None;
                    self.fetch_backend_info();
                    if !self.queued.is_empty() {
                        let next = self.queued.remove(0);
                        self.save();
                        self.dispatch(next, cx);
                    }
                }
                BackendResponse::Failed(e) => {
                    self.finish_think(&format!("Send failed: {e}"));
                    if let Some((tid, _)) = self.pending_think { self.set_task_status(tid, "Failed"); }
                    self.pending_think = None;
                    self.pending_content = None;
                }
            }
            self.save();
            cx.notify();
        }
    }

    fn msg_mut(&mut self, task_id: u64, msg_id: u64) -> Option<&mut Msg> {
        self.tasks.iter_mut().find(|t| t.id == task_id)
            .and_then(|t| t.msgs.iter_mut().find(|m| m.id == msg_id))
    }

    fn finish_think(&mut self, text: &str) {
        let Some((tid, mid)) = self.pending_think else { return };
        if let Some(m) = self.msg_mut(tid, mid) {
            m.content = text.into();
            m.kind = MsgKind::Result;
            m.collapsed = false;
        }
    }

    fn set_task_status(&mut self, task_id: u64, status: &str) {
        if let Some(t) = self.tasks.iter_mut().find(|t| t.id == task_id) {
            t.status = status.into();
        }
    }

    fn task_mut(&mut self) -> Option<&mut Task> {
        self.active.and_then(|id| self.tasks.iter_mut().find(|t| t.id == id))
    }

    fn task(&self) -> Option<&Task> {
        self.active.and_then(|id| self.tasks.iter().find(|t| t.id == id))
    }

    fn ensure_task(&mut self) {
        if self.active.is_none() {
            let id = self.next_id;
            self.next_id += 1;
            self.tasks.push(Task { id, title: "New task".into(), status: "Running".into(), repo: "Liso7150/fennec".into(), msgs: vec![], backend_id: None, started_at: None, approvals: vec![], workspace_id: self.active_workspace_id.clone() });
            self.active = Some(id);
        }
    }

    fn add_msg(&mut self, m: Msg, cx: &mut Context<Self>) {
        self.ensure_task();
        if let Some(t) = self.task_mut() { t.msgs.push(m); }
        self.scroll_handle.scroll_to_bottom();
        self.save();
        cx.notify();
    }

    fn toggle(&mut self, id: u64) {
        if let Some(t) = self.task_mut() {
            if let Some(m) = t.msgs.iter_mut().find(|m| m.id == id) { m.collapsed = !m.collapsed; }
        }
        self.save();
    }

    fn new_task(&mut self) {
        let id = self.next_id;
        self.next_id += 1;
        self.tasks.push(Task { id, title: "New task".into(), status: "Idle".into(), repo: "Liso7150/fennec".into(), msgs: vec![], backend_id: None, started_at: None, approvals: vec![], workspace_id: self.active_workspace_id.clone() });
        self.active = Some(id);
        self.attention_only = false;
        self.save();
    }

    fn new_task_in_workspace(&mut self, workspace_id: &str) {
        let id = self.next_id;
        self.next_id += 1;
        self.tasks.push(Task { id, title: "New task".into(), status: "Idle".into(), repo: "Liso7150/fennec".into(), msgs: vec![], backend_id: None, started_at: None, approvals: vec![], workspace_id: Some(workspace_id.to_string()) });
        self.active = Some(id);
        self.attention_only = false;
        self.save();
    }

    fn select_task(&mut self, id: u64) {
        self.active = Some(id);
        self.scroll_handle.scroll_to_bottom();
        self.save();
    }

    fn working(&self) -> bool { self.task().map(|t| t.status == "Running").unwrap_or(false) }

    fn elapsed(&self) -> String {
        self.task().and_then(|t| t.started_at).map(|start| {
            let secs = chrono::Utc::now().timestamp() - start;
            let m = secs / 60;
            let s = secs % 60;
            format!("{:02}:{:02}", m, s)
        }).unwrap_or_else(|| "00:00".into())
    }

    fn msg_count(&self) -> usize {
        self.task().map(|t| t.msgs.len()).unwrap_or(0)
    }

    fn artifacts_count(&self) -> usize {
        self.task().map(|t| t.msgs.iter().filter(|m| matches!(m.kind, MsgKind::Attach | MsgKind::Edit)).count()).unwrap_or(0)
    }

    fn skills(&self) -> Vec<String> {
        let mut out: Vec<String> = vec![];
        if let Some(t) = self.task() {
            for m in &t.msgs {
                if m.kind == MsgKind::Action {
                    if let Some(meta) = &m.meta {
                        if let Some(title) = &meta.title {
                            if !out.contains(title) { out.push(title.clone()); }
                        }
                    }
                }
            }
        }
        out
    }

    fn web_readings(&self) -> usize {
        self.task().map(|t| t.msgs.iter().filter(|m| {
            if m.kind != MsgKind::Action { return false; }
            let hay = format!("{} {}", m.meta.as_ref().and_then(|x| x.title.clone()).unwrap_or_default(), m.content).to_lowercase();
            ["search", "fetch", "browse", "http", "web", "url"].iter().any(|k| hay.contains(k))
        }).count()).unwrap_or(0)
    }

    fn sources(&self) -> Vec<String> {
        let mut out: Vec<String> = vec![];
        if let Some(t) = self.task() {
            for m in &t.msgs {
                let p = match &m.kind {
                    MsgKind::Edit => m.meta.as_ref().and_then(|x| x.path.clone()),
                    MsgKind::Attach => m.meta.as_ref().and_then(|x| x.path.clone()),
                    _ => None,
                };
                if let Some(p) = p {
                    if !out.contains(&p) { out.push(p); }
                }
            }
        }
        out
    }

    fn attention_count(&self) -> usize {
        self.tasks.iter().filter(|t| t.status == "Running" || t.status == "Failed").count()
    }

    fn approved_commands(&self) -> Vec<(&Task, &ApprovalRequest)> {
        self.tasks.iter()
            .flat_map(|t| t.approvals.iter().filter(|a| a.resolved.is_some()).map(move |a| (t, a)))
            .collect()
    }

    fn filtered_tasks(&self, query: &str) -> Vec<&Task> {
        let q = query.to_lowercase();
        self.tasks.iter()
            .filter(|t| q.is_empty() || t.title.to_lowercase().contains(&q) || t.repo.to_lowercase().contains(&q))
            .rev()
            .collect()
    }

    fn clear_queue(&mut self) {
        self.queued.clear();
        self.save();
    }

    fn clear_history(&mut self, cx: &mut Context<Self>) {
        self.tasks.clear();
        self.active = None;
        self.queued.clear();
        self.next_id = 1;
        self.pending_think = None;
        self.pending_content = None;
        self.tools.clear();
        self.save();
        cx.notify();
    }

    fn cycle_access_mode(&mut self) {
        let modes = ["ask", "auto", "full"];
        let current = modes.iter().position(|m| m == &self.access_mode.as_str()).unwrap_or(0);
        let next = modes[(current + 1) % modes.len()];
        self.access_mode = next.to_string();
        self.save_settings();
    }

    fn cycle_model(&mut self) {
        let models = ["qwen3_5_moe", "edge0_145b", "qwen36_35b"];
        let current = models.iter().position(|m| m == &self.model.as_str()).unwrap_or(0);
        let next = models[(current + 1) % models.len()];
        self.model = next.to_string();
        self.save_settings();
    }

    fn remove_from_queue(&mut self, idx: usize) {
        if idx < self.queued.len() {
            self.queued.remove(idx);
            self.save();
        }
    }

    fn delete_task(&mut self, id: u64) {
        self.tasks.retain(|t| t.id != id);
        if self.active == Some(id) {
            self.active = self.tasks.last().map(|t| t.id);
        }
        self.save();
    }

    fn rename_task(&mut self, id: u64, new_title: String) {
        if let Some(task) = self.tasks.iter_mut().find(|t| t.id == id) {
            task.title = new_title;
            self.save();
        }
    }

    fn compact_active(&mut self) {
        let Some(task) = self.tasks.iter().find(|t| Some(t.id) == self.active) else { return };
        let msgs: Vec<serde_json::Value> = task.msgs.iter()
            .filter(|m| matches!(m.kind, MsgKind::User | MsgKind::Result))
            .map(|m| serde_json::json!({"role": if m.kind == MsgKind::User { "user" } else { "assistant" }, "content": m.content.clone()}))
            .collect();
        let opts = fennec_economy::Options::sized(fennec_economy::DEFAULT_BUDGET_CHARS, fennec_economy::DEFAULT_RESULT_CHARS);
        let (_payload, stats) = fennec_economy::compact(&msgs, &opts, &mut std::collections::HashMap::new());
        self.line = format!("Compacted {} → {} chars ({} elided, {} deduped).",
            stats.chars_before, stats.chars_after, stats.elided, stats.deduped);
    }

    fn toast(&mut self, text: impl Into<String>, good: bool) {
        self.toasts.push(Toast { text: text.into(), good, at: std::time::Instant::now() });
        if self.toasts.len() > 4 {
            let extra = self.toasts.len() - 4;
            self.toasts.drain(..extra);
        }
    }

    fn flush_warm_queue(&mut self) {
        let Some((text, queued)) = self.pending_send.take() else { return };
        if self.backend_ok {
            self.send_text(text);
        } else if queued.elapsed() < WARM_WINDOW {
            self.pending_send = Some((text, queued));
        } else {
            self.line = "The backend did not answer within the warm-up window. \
                The queued prompt has been discarded."
                .to_string();
        }
    }

    fn send_text(&mut self, text: String) {
        if text.is_empty() { return; }
        let task_id = self.next_id;
        self.next_id += 1;
        self.tasks.push(Task {
            id: task_id,
            title: text.chars().take(40).collect(),
            status: "Running".into(),
            repo: "Liso7150/fennec".into(),
            msgs: vec![Msg {
                id: 1,
                author: "You".into(),
                content: text.clone(),
                kind: MsgKind::User,
                time: now(),
                collapsed: false,
                meta: None,
            }],
            backend_id: None,
            started_at: Some(chrono::Utc::now().timestamp()),
            approvals: vec![],
            workspace_id: self.active_workspace_id.clone(),
        });
        self.active = Some(task_id);
        self.save();
    }

    fn open_rename_task_dialog(&mut self, task_id: u64, window: &mut Window, cx: &mut Context<Self>) {
        let title = self.tasks.iter().find(|t| t.id == task_id).map(|t| t.title.clone()).unwrap_or_default();
        let name_input = cx.new(|cx| {
            let mut s = InputState::new(window, cx);
            s.set_value(title, window, cx);
            s
        });
        let weak = cx.entity().downgrade();

        window.open_dialog(cx, move |dialog, _, _| {
            let name_input = name_input.clone();
            let weak = weak.clone();
            dialog
                .title("Rename Task")
                .content({
                    let name_input = name_input.clone();
                    let weak = weak.clone();
                    move |content, window, cx| {
                        content
                            .flex().flex_col().gap_4()
                            .child(div().flex().flex_col().gap_1()
                                .child(Label::new("Task name").font_weight(FontWeight::SEMIBOLD).text_size(px(12.0)))
                                .child(Input::new(&name_input).h(px(32.0))))
                            .child(div().flex().items_center().justify_end().gap_2()
                                .child(Button::new("rename-cancel").label("Cancel").ghost().small()
                                    .on_click({
                                        move |_, window, cx| {
                                            window.close_dialog(cx);
                                        }
                                    }))
                                .child(Button::new("rename-save").label("Save").small()
                                    .on_click({
                                        let name_input = name_input.clone();
                                        let weak = weak.clone();
                                        move |_, window, cx| {
                                            if let Some(app) = weak.upgrade() {
                                                let new_title = name_input.read(cx).value().trim().to_string();
                                                if !new_title.is_empty() {
                                                    app.update(cx, |a, cx| {
                                                        a.rename_task(task_id, new_title);
                                                        cx.notify();
                                                    });
                                                }
                                            }
                                            window.close_dialog(cx);
                                        }
                                    }))
                            )
                    }
                })
                .on_close(move |_, window, cx| {
                    window.close_dialog(cx);
                })
        });
    }

    fn add_attachment(&mut self, path: PathBuf, cx: &mut Context<Self>) {
        let name = path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_else(|| "file".into());
        let size = std::fs::metadata(&path).ok().map(|m| human_size(m.len())).unwrap_or_default();
        let id = self.next_id;
        self.next_id += 1;
        self.add_msg(Msg {
            id, author: "Fennec".into(), content: String::new(),
            kind: MsgKind::Attach, time: now(), collapsed: false,
            meta: Some(MsgMeta {
                duration: None, title: Some(name), add: None, del: None,
                path: Some(path.to_string_lossy().to_string()), size: Some(size),
            }),
        }, cx);
    }

    fn send(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let text = self.composer.read(cx).value().trim().to_string();
        if text.is_empty() { return; }
        self.composer.update(cx, |state, cx| state.set_value("", window, cx));
        if self.working() {
            self.queued.push(text);
            self.save();
            cx.notify();
            return;
        }
        if !self.backend_ok {
            if self.pending_send.is_some() {
                self.line = "The backend is still warming and it already holds a prompt. \
                    This one stays in the composer until that one sends."
                    .to_string();
                self.composer.update(cx, |state, cx| state.set_value(&text, window, cx));
                return;
            }
            self.pending_send = Some((text, std::time::Instant::now()));
            self.line = "Backend is offline - prompt queued. It will send once the backend answers.".to_string();
            cx.notify();
            return;
        }
        self.dispatch(text, cx);
    }

    fn dispatch(&mut self, text: String, cx: &mut Context<Self>) {
        self.ensure_task();
        let backend_id = self.task().and_then(|t| t.backend_id.clone());
        let task_id = self.active.unwrap_or(0);
        let first_prompt = self.task().map(|t| t.title == "New task").unwrap_or(true);

        let uid = self.next_id; self.next_id += 1;
        self.add_msg(Msg { id: uid, author: "Liso7150".into(), content: text.clone(), kind: MsgKind::User, time: now(), collapsed: false, meta: None }, cx);

        if first_prompt {
            if let Some(t) = self.task_mut() { t.title = text.clone(); }
        }
        if let Some(t) = self.task_mut() {
            t.status = "Running".into();
            t.started_at = Some(chrono::Utc::now().timestamp());
        }

        let think_id = self.next_id; self.next_id += 1;
        self.add_msg(Msg { id: think_id, author: "Fennec".into(), content: "Thinking…".into(), kind: MsgKind::Think, time: now(), collapsed: true, meta: None }, cx);

        self.pending_think = Some((task_id, think_id));
        self.pending_content = None;
        self.save();
        cx.notify();

        let url = self.server_url.clone();
        let tx = self.response_tx.clone();
        std::thread::spawn(move || {
            let client = CodingAgentClient::with_base(url);

            if client.health().is_none() {
                let _ = tx.send(BackendResponse::Offline);
                return;
            }

            let bt = match backend_id {
                Some(id) if client.send_message(&id, &text).is_ok() => id,
                _ => {
                    let task = match client.create_task(&text, Some(&text), "local", None) {
                        Ok(t) => t,
                        Err(e) => { let _ = tx.send(BackendResponse::Error(e)); return; }
                    };
                    let id = task.id.clone();
                    let _ = tx.send(BackendResponse::TaskCreated { task_id, backend_id: id.clone() });
                    if let Err(e) = client.start_task(&id) {
                        let _ = tx.send(BackendResponse::Error(e));
                        return;
                    }
                    if let Err(e) = client.send_message(&id, &text) {
                        let _ = tx.send(BackendResponse::Failed(e));
                        return;
                    }
                    id
                }
            };

            // SSE reader: live reasoning/content/tool deltas for this task.
            let cancel = Arc::new(AtomicBool::new(false));
            {
                let cancel = cancel.clone();
                let bt = bt.clone();
                let tx = tx.clone();
                let sse_client = client.clone();
                std::thread::spawn(move || {
                    let _ = sse_client.subscribe_events(&cancel, move |ev| {
                        if ev.task_id.as_deref() != Some(bt.as_str()) { return; }
                        match ev.event_type.as_str() {
                            "MessageStreamed" => {
                                let Some(payload) = &ev.payload else { return };
                                let text = payload.get("text").and_then(|v| v.as_str()).unwrap_or("");
                                if text.is_empty() { return; }
                                match payload.get("kind").and_then(|k| k.as_str()) {
                                    Some("reasoning") => { let _ = tx.send(BackendResponse::ThinkDelta(text.to_string())); }
                                    Some("content") => { let _ = tx.send(BackendResponse::ContentDelta(text.to_string())); }
                                    _ => {}
                                }
                            }
                            "ToolStarted" => {
                                let title = ev.payload.as_ref()
                                    .and_then(|p| p.get("name").and_then(|n| n.as_str()))
                                    .unwrap_or("Working").to_string();
                                let tool_id = ev.payload.as_ref()
                                    .and_then(|p| p.get("id").and_then(|n| n.as_str()))
                                    .map(|s| s.to_string())
                                    .unwrap_or_else(|| ev.event_id.clone());
                                let _ = tx.send(BackendResponse::ActionStarted { tool_id, title });
                            }
                            "ToolCompleted" | "ToolProgressUpdated" => {
                                let Some(payload) = &ev.payload else { return };
                                let tool_id = payload.get("id").and_then(|n| n.as_str())
                                    .map(|s| s.to_string())
                                    .unwrap_or_else(|| ev.event_id.clone());
                                let detail = payload.get("result").and_then(|v| v.as_str())
                                    .or_else(|| payload.get("detail").and_then(|v| v.as_str()))
                                    .unwrap_or("").to_string();
                                let duration = payload.get("duration_ms").and_then(|v| v.as_u64())
                                    .map(|ms| format!("{ms} ms"));
                                let _ = tx.send(BackendResponse::ActionDone { tool_id, duration, detail });
                            }
                            _ => {}
                        }
                    });
                });
            }

            // Terminal watcher: authoritative status + final message.
            let mut attempts = 0usize;
            loop {
                std::thread::sleep(std::time::Duration::from_millis(500));
                attempts += 1;
                if let Some(task) = client.get_task(&bt) {
                    if task.status == "Complete" || task.status == "Failed" {
                        cancel.store(true, Ordering::Relaxed);
                        let final_text = task.messages.iter().rev()
                            .find(|m| m.role == "Fennec")
                            .map(|m| m.content.as_text())
                            .unwrap_or_default();
                        let _ = tx.send(BackendResponse::Complete { task_id, status: task.status, final_text });
                        return;
                    }
                }
                if attempts > 900 {
                    cancel.store(true, Ordering::Relaxed);
                    let _ = tx.send(BackendResponse::Complete {
                        task_id, status: "Failed".into(),
                        final_text: "Timed out waiting for the backend to finish.".into(),
                    });
                    return;
                }
            }
        });
    }
}

fn now() -> String { chrono::Local::now().format("%H:%M").to_string() }

fn load_settings(settings_path: &Path) -> Settings {
    std::fs::read_to_string(settings_path).ok()
        .and_then(|s| serde_json::from_str::<Settings>(&s).ok())
        .unwrap_or_default()
}

fn human_size(bytes: u64) -> String {
    const KB: f64 = 1024.0;
    const MB: f64 = KB * 1024.0;
    let b = bytes as f64;
    if b >= MB { format!("{:.1} MB", b / MB) }
    else if b >= KB { format!("{:.1} KB", b / KB) }
    else { format!("{bytes} B") }
}

fn dot_color(status: &str, green: Hsla, blue: Hsla, red: Hsla, yellow: Hsla) -> Hsla {
    match status {
        "Running" => blue,
        "Complete" => green,
        "Failed" => red,
        _ => yellow,
    }
}

impl Render for App {
    fn render(&mut self, _w: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let t = cx.theme().clone();
        div().flex().flex_col().size_full().bg(t.background).text_color(t.foreground)
            .child(self.topbar(cx))
            .child(div().flex().flex_1().overflow_hidden()
                .child(self.left(cx))
                .child(self.center(cx))
                .children(self.inspector.then(|| self.right(cx))))
    }
}

impl App {
    fn topbar(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let t = cx.theme().clone();
        let status_text = if self.backend_ok { "Backend connected" } else { "Backend offline" };
        let status_color = if self.backend_ok { t.green } else { t.red };
        div().flex().items_center().justify_between().px_4().py_2().bg(t.background).border_b_1().border_color(t.border)
            .child(div().flex().items_center().gap_3()
                .child(Label::new("Fennec").text_size(px(16.0)).font_weight(FontWeight::BOLD).text_color(t.accent))
                .child(Label::new("Liso7150/fennec").text_size(px(13.0)).text_color(t.muted_foreground)))
            .child(div().flex().items_center().gap_3()
                .child(div().flex().items_center().gap_1()
                    .child(div().w(px(7.0)).h(px(7.0)).rounded_full().bg(status_color))
                    .child(Label::new(status_text).text_size(px(12.0)).text_color(status_color)))
                .child(Button::new("settings").label("⚙").ghost().xsmall()
                    .on_click(cx.listener(|a, _, window, cx| { a.open_settings(window, cx); })))
                .child(Button::new("inspector").label(if self.inspector { "»" } else { "«" }).ghost().xsmall()
                    .on_click(cx.listener(|a, _, _, cx| { a.inspector = !a.inspector; cx.notify(); }))))
    }

    fn left(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let t = cx.theme().clone();
        let query = self.search.read(cx).value().trim().to_string();
        let tasks = self.filtered_tasks(&query);
        div().w(px(260.0)).flex_shrink_0().bg(t.background).border_r_1().border_color(t.border).flex().flex_col().p_4().gap_3()
            // Navigation
            .child(div().flex().flex_col().gap_2()
                .child(Button::new("nav-new-task").label("⟳ New Task").w_full().h(px(36.0)).rounded_md()
                    .border_1().border_color(t.border)
                    .on_click(cx.listener(|a, _, _, cx| { a.new_task(); cx.notify(); })))
                .child(Button::new("nav-attention").label("▷ My Attention").w_full().h(px(36.0)).rounded_md()
                    .border_1().border_color(t.border)
                    .when(self.attention_only, |b| b.bg(t.yellow.opacity(0.15)).border_color(t.yellow))
                    .on_click(cx.listener(|a, _, _, cx| { a.attention_only = !a.attention_only; a.search_open = false; cx.notify(); })))
                .child(Button::new("nav-search").label("⌕ Search").w_full().h(px(36.0)).rounded_md()
                    .border_1().border_color(t.border)
                    .when(self.search_open, |b| b.bg(t.blue.opacity(0.15)).border_color(t.blue))
                    .on_click(cx.listener(|a, _, _, cx| { a.search_open = !a.search_open; a.attention_only = false; cx.notify(); })))
            )
            // Workspaces Header
            .child(div().flex().items_center().justify_between().mt_2()
                .child(div().flex().items_center().gap_2()
                    .child(Label::new("Workspaces").text_size(px(12.0)).text_color(t.muted_foreground))
                    .child(Label::new("∨").text_size(px(10.0)).text_color(t.muted_foreground))
                    .child(Label::new("ⓘ").text_size(px(10.0)).text_color(t.muted_foreground)))
                .child(Button::new("new-workspace-header").label("+").w(px(24.0)).h(px(24.0)).rounded_md()
                    .border_1().border_color(t.border)
                    .on_click(cx.listener(|a, _, window, cx| {
                        a.open_new_workspace_dialog(window, cx);
                    })))
            )
            // Workspace List with Tasks
            .child(div().flex().flex_col().gap_3().flex_1().overflow_y_scrollbar()
                .children(self.workspaces.iter().map(|ws| {
                    let t = t.clone();
                    let ws_id = ws.id.clone();
                    let ws_id2 = ws_id.clone();
                    let ws_id3 = ws_id.clone();
                    let ws_name = ws.name.clone();
                    let ws_icon = ws.icon.clone();
                    let is_active = self.active_workspace_id.as_deref() == Some(&ws.id);
                    let ws_tasks: Vec<&Task> = self.tasks.iter()
                        .filter(|task| task.workspace_id.as_deref() == Some(&ws.id))
                        .collect();

                    div().flex().flex_col().gap_1()
                        .child(div().flex().items_center().justify_between()
                            .child(Button::new(format!("ws-select-{}", ws.id)).w_full()
                                .on_click(cx.listener(move |a, _, _, cx| {
                                    a.select_workspace(&ws_id);
                                    cx.notify();
                                }))
                                .child(div().flex().items_center().gap_2()
                                    .child(Label::new(ws_icon.as_str()).text_size(px(14.0)))
                                    .child(Label::new(ws_name.as_str()).text_size(px(13.0)).font_weight(FontWeight::MEDIUM)
                                        .text_color(if is_active { t.accent } else { t.foreground }))))
                            .child(div().flex().items_center().gap_1()
                                .child(Button::new(format!("ws-new-task-{}", ws.id)).label("+").w(px(20.0)).h(px(20.0)).rounded_md()
                                    .border_1().border_color(t.border)
                                    .on_click(cx.listener(move |a, _, _, cx| {
                                        a.new_task_in_workspace(&ws_id2);
                                        cx.notify();
                                    })))
                                .child(Button::new(format!("ws-delete-{}", ws.id)).label("×").w(px(20.0)).h(px(20.0)).rounded_md()
                                    .border_1().border_color(t.border)
                                    .on_click(cx.listener(move |a, _, _, cx| {
                                        a.delete_workspace(&ws_id3);
                                        cx.notify();
                                    })))))
                        .children(ws_tasks.iter().map(|task| {
                            let t = t.clone();
                            let id = task.id;
                            let title = task.title.clone();
                            let status = task.status.clone();
                            let is_active = self.active == Some(id);
                            let has_warning = status == "Failed" || status == "Warning";

                            div().id(ElementId::NamedInteger("ws-task-".into(), id))
                                .pl_4().pr_3().py_2().rounded_md().cursor_pointer()
                                .when(is_active, |d| d.bg(t.muted))
                                .hover(|d| d.bg(t.muted))
                                .on_click(cx.listener(move |a, _, _, cx| { a.select_task(id); cx.notify(); }))
                                .child(div().flex().items_center().justify_between()
                                    .child(Label::new(title.as_str()).text_size(px(12.0)).truncate())
                                    .child(div().flex().items_center().gap_1()
                                        .when(has_warning, |d| d
                                            .child(Label::new("⚠").text_size(px(11.0)).text_color(t.red)))
                                        .child(Button::new(format!("task-rename-{}", id)).label("✎").w(px(16.0)).h(px(16.0)).rounded_sm()
                                            .on_click(cx.listener(move |a, _, window, cx| {
                                                a.open_rename_task_dialog(id, window, cx);
                                            })))
                                        .child(Button::new(format!("task-delete-{}", id)).label("×").w(px(16.0)).h(px(16.0)).rounded_sm()
                                            .on_click(cx.listener(move |a, _, _, cx| {
                                                a.delete_task(id);
                                                cx.notify();
                                            }))))
                                )
                        }))
                }))
            )
            // Search dock
            .children(self.search_open.then(|| {
                let t = t.clone();
                div().flex().flex_col().gap_1()
                    .child(Input::new(&self.search).h(px(32.0)).text_size(px(12.0)))
                    .child(Label::new(if query.is_empty() { String::new() } else { format!("{} tasks", tasks.len()) }).text_size(px(10.0)).text_color(t.muted_foreground))
            }))
            // Approved Commands (when attention_only is active)
            .children(self.attention_only.then(|| {
                let t = t.clone();
                let approved = self.approved_commands();
                div().flex().flex_col().gap_2().flex_1().overflow_y_scrollbar()
                    .child(Label::new("APPROVED COMMANDS").text_size(px(10.0)).text_color(t.muted_foreground).font_weight(FontWeight::MEDIUM))
                    .children(approved.iter().map(|(task, approval)| {
                        let t = t.clone();
                        let command = approval.command.clone().unwrap_or_else(|| approval.action.clone());
                        let risk_color = match approval.risk_level.as_str() {
                            "high" => t.red,
                            "medium" => t.yellow,
                            _ => t.green,
                        };
                        div().p_3().rounded_md().bg(t.muted).border_1().border_color(t.border)
                            .child(Label::new(command).text_size(px(12.0)).font_weight(FontWeight::MEDIUM).truncate())
                            .child(div().flex().items_center().gap_1().mt_1()
                                .child(Label::new(task.title.as_str()).text_size(px(10.0)).text_color(t.accent).truncate())
                                .child(Label::new("·").text_size(px(10.0)))
                                .child(div().w(px(5.0)).h(px(5.0)).rounded_full().bg(risk_color))
                                .child(Label::new(approval.risk_level.as_str()).text_size(px(10.0)).text_color(risk_color)))
                    }))
            }))
    }

    fn center(&mut self, cx: &mut Context<Self>) -> impl IntoElement {
        let t = cx.theme().clone();
        let tk = self.task();
        let show_queue = !self.queued.is_empty();
        let ws = self.active_workspace();
        let ws_name = ws.map(|w| w.name.as_str()).unwrap_or("No workspace");
        let is_working = self.working();
        div().flex().flex_col().flex_1().overflow_hidden()
            .child(div().flex().items_start().justify_between().px_5().pt_4().pb_3().border_b_1().border_color(t.border)
                .child(div().flex().flex_col().gap_1()
                    .child(Label::new(ws_name).text_size(px(12.0)).text_color(t.muted_foreground))
                    .child(Label::new(tk.map(|t| t.title.as_str()).unwrap_or("No active task")).text_size(px(20.0)).font_weight(FontWeight::BOLD).text_color(t.accent))
                    .child(Label::new("Chronological local-agent activity and verification.").text_size(px(12.0)).text_color(t.muted_foreground)))
                .child(div().flex().items_center().gap_2()
                    .child(Button::new("stop").label("Stop").ghost().small()
                        .when(!is_working, |b| b.disabled(true))
                        .on_click(cx.listener(|a, _, _, cx| {
                            if let Some(task) = a.task_mut() {
                                task.status = "Failed".to_string();
                            }
                            cx.notify();
                        })))
                    .child(Button::new("compact").label("⊟").ghost().small()
                        .on_click(cx.listener(|a, _, _, cx| {
                            a.compact_active();
                            cx.notify();
                        })))
                    .children(tk.map(|tk| {
                        let t = t.clone();
                        let status = tk.status.clone();
                        let status_color = match status.as_str() {
                            "Running" | "Planning" => t.green,
                            "Complete" => t.blue,
                            "Failed" | "Warning" => t.red,
                            "WaitingForApproval" | "NeedsAttention" => t.yellow,
                            _ => t.muted_foreground,
                        };
                        div().flex().items_center().gap_1().px_3().py_1().rounded_full().border_1().border_color(t.border)
                            .child(div().w(px(7.0)).h(px(7.0)).rounded_full().bg(dot_color(&status, t.green, t.blue, t.red, t.yellow)))
                            .child(Label::new(status).text_size(px(12.0)).text_color(status_color).font_weight(FontWeight::MEDIUM))
                    }))))
            .child(self.timeline(cx))
            .children(show_queue.then(|| self.queue(cx)))
            .child(self.composer(cx))
    }

    fn timeline(&mut self, cx: &mut Context<Self>) -> impl IntoElement {
        let t = cx.theme().clone();
        let msgs = self.task().map(|t| t.msgs.clone()).unwrap_or_default();
        div().id("timeline-scroll").flex_1().track_scroll(&self.scroll_handle).overflow_y_scrollbar().px_5().py_3().flex().flex_col().gap_4()
            .children(msgs.into_iter().map(|m| {
                let t = t.clone();
                let id = m.id;
                match m.kind {
                    MsgKind::User => div().id(ElementId::NamedInteger("msg".into(), id)).flex().gap_3()
                        .child(self.avatar("L", t.primary))
                        .child(div().flex().flex_col().gap_1().max_w(px(680.0))
                            .child(div().flex().items_center().gap_2()
                                .child(Label::new(&m.author).font_weight(FontWeight::SEMIBOLD))
                                .child(Label::new(&m.time).text_size(px(12.0)).text_color(t.muted_foreground)))
                            .child(div().p_3().rounded_md().bg(t.muted).child(Label::new(&m.content)))),

                    MsgKind::Think => {
                        let collapsed = m.collapsed;
                        div().id(ElementId::NamedInteger("msg".into(), id)).flex().gap_3()
                            .child(self.avatar("F", t.accent))
                            .child(div().flex().flex_col().gap_1().flex_1()
                                .child(div().flex().items_center().gap_2()
                                    .child(Label::new(&m.author).font_weight(FontWeight::SEMIBOLD))
                                    .child(Label::new(&m.time).text_size(px(12.0)).text_color(t.muted_foreground))
                                    .child(Label::new("Thinking").text_size(px(12.0)).text_color(t.green))
                                    .child(Button::new(ElementId::NamedInteger("tog".into(), id))
                                        .label(if collapsed { "+" } else { "-" }).ghost().xsmall()
                                        .on_click(cx.listener(move |a, _, _, cx| { a.toggle(id); cx.notify(); }))))
                                .children((!collapsed).then(|| div().text_size(px(13.0)).text_color(t.muted_foreground).child(Label::new(&m.content)))))
                    }

                    MsgKind::Action => {
                        let collapsed = m.collapsed;
                        let title = m.meta.as_ref().and_then(|x| x.title.clone()).unwrap_or_else(|| "Action".into());
                        let dur = m.meta.as_ref().and_then(|x| x.duration.clone()).unwrap_or_default();
                        let running = dur.is_empty();
                        div().id(ElementId::NamedInteger("msg".into(), id)).flex().gap_3()
                            .child(self.avatar("A", t.accent))
                            .child(div().flex().flex_col().gap_1().flex_1()
                                .child(div().flex().items_center().justify_between()
                                    .child(div().flex().items_center().gap_2()
                                        .child(Label::new(&m.author).font_weight(FontWeight::SEMIBOLD))
                                        .child(Label::new(&m.time).text_size(px(12.0)).text_color(t.muted_foreground)))
                                    .child(Button::new(ElementId::NamedInteger("tog".into(), id))
                                        .label(if collapsed { "+" } else { "-" }).ghost().xsmall()
                                        .on_click(cx.listener(move |a, _, _, cx| { a.toggle(id); cx.notify(); }))))
                                .child(div().rounded_md().border_1().border_color(t.border)
                                    .child(div().flex().items_center().justify_between().px_3().py_2().border_b_1().border_color(t.border)
                                        .child(div().flex().items_center().gap_2().child(Label::new("🔍")).child(Label::new(title).font_weight(FontWeight::MEDIUM)))
                                        .child(Label::new(if running { "Running…".into() } else { format!("Complete · {dur}") }).text_size(px(12.0)).text_color(if running { t.yellow } else { t.green })))
                                    .children((!collapsed && !m.content.is_empty()).then(|| div().px_3().py_2().text_size(px(12.0)).font_family("monospace").child(Label::new(&m.content))))))
                    }

                    MsgKind::Attach => {
                        let fn_ = m.meta.as_ref().and_then(|x| x.title.clone()).unwrap_or_else(|| "file".into());
                        let path = m.meta.as_ref().and_then(|x| x.path.clone()).unwrap_or_default();
                        let size = m.meta.as_ref().and_then(|x| x.size.clone()).unwrap_or_default();
                        div().id(ElementId::NamedInteger("msg".into(), id)).flex().gap_3()
                            .child(self.avatar("F", t.accent))
                            .child(div().flex().flex_col().gap_1().flex_1()
                                .child(div().flex().items_center().gap_2()
                                    .child(Label::new(&m.author).font_weight(FontWeight::SEMIBOLD))
                                    .child(Label::new(&m.time).text_size(px(12.0)).text_color(t.muted_foreground)))
                                .child(div().rounded_md().border_1().border_color(t.border).px_3().py_2()
                                    .child(div().flex().items_center().justify_between()
                                        .child(div().flex().items_center().gap_2().child(Label::new("📄"))
                                            .child(div().flex().flex_col()
                                                .child(Label::new(fn_).font_weight(FontWeight::MEDIUM))
                                                .child(Label::new(format!("{} · Attached file", path)).text_size(px(11.0)).text_color(t.muted_foreground))))
                                        .child(Label::new(size).text_size(px(12.0))))))
                    }

                    MsgKind::Edit => {
                        let fn_ = m.meta.as_ref().and_then(|x| x.title.clone()).unwrap_or_else(|| "file".into());
                        let add = m.meta.as_ref().and_then(|x| x.add).unwrap_or(0);
                        let del = m.meta.as_ref().and_then(|x| x.del).unwrap_or(0);
                        let m2 = m.clone();
                        div().id(ElementId::NamedInteger("msg".into(), id)).flex().gap_3()
                            .child(self.avatar("F", t.accent))
                            .child(div().flex().flex_col().gap_1().flex_1()
                                .child(div().flex().items_center().gap_2()
                                    .child(Label::new(&m.author).font_weight(FontWeight::SEMIBOLD))
                                    .child(Label::new(&m.time).text_size(px(12.0)).text_color(t.muted_foreground))
                                    .child(Label::new("Edited 1 file").text_size(px(12.0)).text_color(t.muted_foreground))
                                    .child(Button::new(ElementId::NamedInteger("review".into(), id))
                                        .label("Review").ghost().small()
                                        .on_click(cx.listener(move |_, _, window, cx| {
                                            let m = m2.clone();
                                            window.open_dialog(cx, move |dialog, _, _| {
                                                let m = m.clone();
                                                dialog.title("Review diff").content(move |content, _, _| {
                                                    let m = m.clone();
                                                    content.child(div().max_h(px(480.0)).overflow_y_scrollbar()
                                                        .child(div().font_family("monospace").text_size(px(12.0)).child(Label::new(m.content))))
                                                })
                                            });
                                        }))))
                                .child(div().rounded_md().border_1().border_color(t.border)
                                    .child(div().flex().items_center().justify_between().px_3().py_2()
                                        .child(Label::new(fn_).text_size(px(12.0)).font_family("monospace"))
                                        .child(div().flex().items_center().gap_2()
                                            .child(Label::new(format!("+{add}")).text_size(px(12.0)).text_color(t.green))
                                            .child(Label::new(format!("-{del}")).text_size(px(12.0)).text_color(t.red))))))
                    }

                    MsgKind::Result => div().id(ElementId::NamedInteger("msg".into(), id)).flex().gap_3()
                        .child(self.avatar("F", t.success))
                        .child(div().flex().flex_col().gap_1().max_w(px(680.0))
                            .child(div().flex().items_center().gap_2()
                                .child(Label::new(&m.author).font_weight(FontWeight::SEMIBOLD))
                                .child(Label::new(&m.time).text_size(px(12.0)).text_color(t.muted_foreground)))
                            .child(rich_div(&t, &m.content, false)))
                }
            }))
    }

    fn avatar(&self, letter: &str, bg: Hsla) -> impl IntoElement {
        div().w(px(28.0)).h(px(28.0)).rounded_full().bg(bg).flex().items_center().justify_center().flex_shrink_0()
            .child(Label::new(letter).text_size(px(12.0)).text_color(Hsla::white()))
    }

    fn queue(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let t = cx.theme().clone();
        let len = self.queued.len();
        if len == 0 {
            return div().into_any_element();
        }

        let header = div().flex().items_center().justify_between().px_4().py_2()
            .child(div().flex().items_center().gap_2()
                .child(Label::new("☰").text_size(px(14.0)).text_color(t.muted_foreground))
                .child(Label::new("Task queue").font_weight(FontWeight::SEMIBOLD).text_size(px(12.0)))
                .child(Label::new(format!("{len} item{}", if len == 1 { "" } else { "s" })).text_size(px(11.0)).text_color(t.muted_foreground)))
            .child(Button::new("queue-view-all").label("View all").ghost().xsmall()
                .on_click(cx.listener(|a, _, window, cx| {
                    window.push_notification(gpui_kit::component::notification::Notification::info(
                        format!("{} tasks in queue", a.queued.len())
                    ), cx);
                    cx.notify();
                })));

        let items = div().flex().flex_col().gap_0().overflow_y_scrollbar().max_h(px(120.0))
            .children(self.queued.iter().enumerate().map(|(i, task)| {
                let is_next = i == 0;
                div().id(ElementId::NamedInteger("queue-item".into(), i as u64))
                    .flex().items_center().justify_between().px_4().py_1_5()
                    .child(div().flex().items_center().gap_2()
                        .child(div().w(px(6.0)).h(px(6.0)).rounded_full().bg(if is_next { t.success } else { t.muted_foreground }))
                        .child(Label::new(task.clone()).text_size(px(12.0)).truncate()))
                    .child(Label::new(if is_next { "Next" } else { "Queued" }).font_weight(FontWeight::SEMIBOLD).text_size(px(10.5))
                        .text_color(if is_next { t.success } else { t.muted_foreground }))
            }));

        div().border_t_1().border_color(t.border).bg(t.background).flex().flex_col()
            .child(header)
            .child(items)
            .into_any_element()
    }

    fn composer(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let t = cx.theme().clone();
        let send_enabled = !self.composer.read(cx).value().trim().is_empty();
        let mut col = div().border_t_1().border_color(t.border).bg(t.background).px_5().py_3().flex().flex_col().gap_2();
        for (ti, toast) in self.toasts.iter().enumerate() {
            col = col.child(div().id(ElementId::NamedInteger("toast".into(), ti as u64)).flex().items_center().gap_2()
                .child(div().w(px(6.0)).h(px(6.0)).rounded_full().bg(if toast.good { t.success } else { t.yellow }))
                .child(Label::new(toast.text.clone()).text_size(px(12.0)).text_color(t.foreground)));
        }
        if !self.line.is_empty() {
            col = col.child(Label::new(self.line.clone()).text_size(px(12.0)).text_color(t.yellow));
        }
        col
            // gpui-base inputs all render element id "input-state"; this id-bearing
            // parent keeps their a11y node ids distinct when a UIA client connects.
        .child(div().id("composer-dock").rounded_md().border_1().border_color(t.border).p_3()
            .child(Label::new("Ask Fennec to inspect, edit, test, or explain your code").text_size(px(13.0)).text_color(t.muted_foreground))
            .child(div().mt_2().child(Input::new(&self.composer))))
            .child(div().flex().items_center().justify_between()
                .child(div().flex().items_center().gap_2()
                    .child(Button::new("add").label("+").ghost().small()
                        .on_click(cx.listener(|a, _, _, cx| { a.new_task(); cx.notify(); })))
                    .child(Button::new("attach").label("⊞").ghost().small()
                        .on_click(cx.listener(|a, _, _, cx| { a.attach_file(cx); })))
                    .child(Button::new("perm-edits").label("edits").ghost().small()
                        .when(self.allow_write, |b| b.bg(t.green.opacity(0.2)).border_1().border_color(t.green))
                        .on_click(cx.listener(|a, _, _, cx| { a.allow_write = !a.allow_write; a.save_settings(); cx.notify(); })))
                    .child(Button::new("perm-commands").label("commands").ghost().small()
                        .when(self.allow_shell, |b| b.bg(t.blue.opacity(0.2)).border_1().border_color(t.blue))
                        .on_click(cx.listener(|a, _, _, cx| { a.allow_shell = !a.allow_shell; a.save_settings(); cx.notify(); })))
                    .child(Button::new("perm-web").label("web").ghost().small()
                        .when(self.allow_web, |b| b.bg(t.yellow.opacity(0.2)).border_1().border_color(t.yellow))
                        .on_click(cx.listener(|a, _, _, cx| { a.allow_web = !a.allow_web; a.save_settings(); cx.notify(); })))
                    .child(Button::new("perm-ask").label("ask each").ghost().small()
                        .when(self.ask_each, |b| b.bg(t.red.opacity(0.2)).border_1().border_color(t.red))
                        .on_click(cx.listener(|a, _, _, cx| { a.ask_each = !a.ask_each; a.save_settings(); cx.notify(); }))))
                .child(div().flex().items_center().gap_2()
                    .child(Button::new("model-select").label(format!("⚡ {}", self.model)).ghost().small()
                        .on_click(cx.listener(|a, _, _, cx| { a.cycle_model(); cx.notify(); })))
                    .child(Button::new("mic").label("◎").ghost().small()
                        .on_click(cx.listener(|_, _, window, cx| {
                            window.push_notification(Notification::info("Dictation needs audio capture, which is not wired up in this build. Type or paste text instead."), cx);
                        })))
                    .child(Button::new("send").label("↑").primary()
                        .when(!send_enabled, |b| b.disabled(true))
                        .on_click(cx.listener(|a, _, window, cx| { a.send(window, cx); })))))
    }

    fn attach_file(&mut self, cx: &mut Context<Self>) {
        let rx = cx.prompt_for_paths(PathPromptOptions {
            files: true, directories: false, multiple: false, prompt: None,
        });
        cx.spawn(async move |weak, cx: &mut AsyncApp| {
            if let Ok(Ok(Some(paths))) = rx.await {
                for p in paths {
                    let _ = weak.update(cx, |a, cx| { a.add_attachment(p, cx); });
                }
            }
        }).detach();
    }

    fn open_new_workspace_dialog(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let name_input = cx.new(|cx| {
            let mut s = InputState::new(window, cx);
            s
        });
        let weak = cx.entity().downgrade();

        let icons = ["📁", "💻", "🔬", "🧪", "🎨", "🤖", "⚙️", "🔧", "📦", "🚀"];
        let colors: [(f32, f32, f32); 8] = [
            (0.08, 0.7, 0.5),   // orange
            (0.33, 0.6, 0.45),  // green
            (0.6, 0.5, 0.5),    // blue
            (0.12, 0.8, 0.5),   // yellow
            (0.0, 0.7, 0.5),    // red
            (0.83, 0.6, 0.6),   // pink
            (0.75, 0.5, 0.5),   // purple
            (0.5, 0.6, 0.5),    // teal
        ];

        window.open_dialog(cx, move |dialog, _, _| {
            let name_input = name_input.clone();
            let weak = weak.clone();
            let selected_icon: Rc<Cell<usize>> = Rc::new(Cell::new(0));
            let selected_color: Rc<Cell<usize>> = Rc::new(Cell::new(0));
            let indexed: Rc<Cell<bool>> = Rc::new(Cell::new(true));
            let source_folders: Rc<RefCell<Vec<String>>> = Rc::new(RefCell::new(vec![]));

            dialog
                .title("New Workspace")
                .content({
                    let name_input = name_input.clone();
                    let weak = weak.clone();
                    let selected_icon = selected_icon.clone();
                    let selected_color = selected_color.clone();
                    let indexed = indexed.clone();
                    let source_folders = source_folders.clone();
                    let icons = icons.to_vec();
                    let colors = colors.to_vec();
                    move |content, _window, cx| {
                        let t = cx.theme().clone();
                        content
                            .flex().flex_col().gap_4()
                            // Workspace name
                            .child(div().flex().flex_col().gap_2()
                                .child(Label::new("Workspace name").font_weight(FontWeight::SEMIBOLD).text_size(px(12.0)))
                                .child(Input::new(&name_input).h(px(32.0)))
                            )
                            // Source folders
                            .child(div().flex().flex_col().gap_2()
                                .child(Label::new("Source folders").font_weight(FontWeight::SEMIBOLD).text_size(px(12.0)))
                                .child(Button::new("add-folder-btn").w_full().justify_start()
                                    .border_1().border_color(t.border).border_dashed()
                                    .on_click({
                                        let source_folders = source_folders.clone();
                                        move |_, _, cx| {
                                            let rx = cx.prompt_for_paths(PathPromptOptions {
                                                files: false, directories: true, multiple: true, prompt: None,
                                            });
                                            let source_folders = source_folders.clone();
                                            cx.spawn(async move |_weak| {
                                                if let Ok(Ok(Some(paths))) = rx.await {
                                                    let folder_paths: Vec<String> = paths.iter()
                                                        .map(|p| p.to_string_lossy().to_string())
                                                        .collect();
                                                    source_folders.borrow_mut().extend(folder_paths);
                                                }
                                            }).detach();
                                        }
                                    })
                                    .child(div().p_4().flex().items_center().justify_center()
                                        .child(Label::new("+ Click to add a readable and editable folder")
                                            .text_size(px(12.0)).text_color(t.muted_foreground))))
                                .child({
                                    let folders = source_folders.borrow().clone();
                                    div().flex().flex_col().gap_1().mt_1()
                                        .children(folders.iter().map(|f| {
                                            let t = t.clone();
                                            div().p_2().rounded_sm().bg(t.muted)
                                                .child(Label::new(f.as_str()).text_size(px(11.0)).font_family("monospace").truncate())
                                        }))
                                })
                            )
                            // Workspace icon
                            .child(div().flex().flex_col().gap_2()
                                .child(Label::new("Workspace icon").font_weight(FontWeight::SEMIBOLD).text_size(px(12.0)))
                                .child(div().flex().flex_wrap().gap_2()
                                    .children(icons.iter().enumerate().map(|(i, icon)| {
                                        let t = t.clone();
                                        let selected_icon = selected_icon.clone();
                                        let is_selected = selected_icon.get() == i;
                                        Button::new(format!("icon-{}", i))
                                            .when(is_selected, |b| b.bg(t.accent.opacity(0.2)).border_color(t.accent))
                                            .on_click(move |_, window, cx| {
                                                selected_icon.set(i);
                                                window.refresh();
                                            })
                                            .child(div().w(px(36.0)).h(px(36.0)).rounded_md()
                                                .border_1().border_color(if is_selected { t.accent } else { t.border })
                                                .flex().items_center().justify_center()
                                                .child(Label::new(*icon).text_size(px(18.0))))
                                    })))
                            )
                            // Workspace color
                            .child(div().flex().flex_col().gap_2()
                                .child(Label::new("Workspace color").font_weight(FontWeight::SEMIBOLD).text_size(px(12.0)))
                                .child(div().flex().gap_2()
                                    .children(colors.iter().enumerate().map(|(i, color)| {
                                        let t = t.clone();
                                        let selected_color = selected_color.clone();
                                        let is_selected = selected_color.get() == i;
                                        let color_hsla = hsla(color.0, color.1, color.2, 1.0);
                                        Button::new(format!("color-{}", i))
                                            .on_click(move |_, window, cx| {
                                                selected_color.set(i);
                                                window.refresh();
                                            })
                                            .child(div().w(px(28.0)).h(px(28.0)).rounded_full()
                                                .bg(color_hsla)
                                                .border_2().border_color(if is_selected { t.foreground } else { Hsla::transparent_black() }))
                                    })))
                            )
                            // Workspace index toggle
                            .child(div().flex().items_center().justify_between().p_3().rounded_md().bg(t.muted).border_1().border_color(t.border)
                                .child(div().flex().flex_col()
                                    .child(Label::new("Workspace index").font_weight(FontWeight::SEMIBOLD).text_size(px(12.0)))
                                    .child(Label::new("Building a workspace index gives the agent more context and helps it respond more accurately.")
                                        .text_size(px(11.0)).text_color(t.muted_foreground)))
                                .child({
                                    let indexed = indexed.clone();
                                    let is_on = indexed.get();
                                    Button::new("index-toggle")
                                        .on_click(move |_, window, cx| {
                                            indexed.set(!indexed.get());
                                            window.refresh();
                                        })
                                        .child(div().w(px(40.0)).h(px(22.0)).rounded_full()
                                            .bg(if is_on { t.green } else { t.muted_foreground })
                                            .flex().items_center()
                                            .child(div().w(px(18.0)).h(px(18.0)).rounded_full().bg(Hsla::white())
                                                .ml(if is_on { px(20.0) } else { px(2.0) })))
                                })
                            )
                    }
                })
                .footer(div().flex().justify_end().gap_2().p_3()
                    .child(Button::new("new-ws-cancel").label("Cancel").ghost()
                        .on_click(|_, window, cx| { window.close_dialog(cx); }))
                    .child(Button::new("new-ws-create").label("Create").primary()
                        .on_click({
                            let name_input = name_input.clone();
                            let weak = weak.clone();
                            let selected_icon = selected_icon.clone();
                            let selected_color = selected_color.clone();
                            let indexed = indexed.clone();
                            let source_folders = source_folders.clone();
                            let icons = icons.to_vec();
                            move |_, window, cx| {
                                let name = name_input.read(cx).value().trim().to_string();
                                if name.is_empty() {
                                    window.push_notification(Notification::error("Please enter a workspace name."), cx);
                                    return;
                                }
                                let icon = icons[selected_icon.get()].to_string();
                                let color_idx = selected_color.get();
                                let color = match color_idx {
                                    0 => "orange", 1 => "green", 2 => "blue", 3 => "yellow",
                                    4 => "red", 5 => "pink", 6 => "purple", _ => "teal",
                                }.to_string();
                                let idx = indexed.get();
                                let folders = source_folders.borrow().clone();
                                let _ = weak.update(cx, |a, cx| {
                                    a.add_workspace(name, folders, icon, color, idx);
                                    cx.notify();
                                });
                                window.close_dialog(cx);
                            }
                        })))
        });
    }

    fn open_settings(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let server_input = cx.new(|cx| {
            let mut s = InputState::new(window, cx);
            s.set_value(self.server_url.clone(), window, cx);
            s
        });
        let engine_input = cx.new(|cx| {
            let mut s = InputState::new(window, cx);
            s.set_value(self.engine_url.clone(), window, cx);
            s
        });
        let apikey_input = cx.new(|cx| {
            let mut s = InputState::new(window, cx);
            s.set_value(self.api_key.clone(), window, cx);
            s
        });
        let fontsize_input = cx.new(|cx| {
            let mut s = InputState::new(window, cx);
            s.set_value(self.font_size.to_string(), window, cx);
            s
        });
        let weak = cx.entity().downgrade();
        let current_theme: Rc<RefCell<String>> = Rc::new(RefCell::new(self.theme.clone()));
        let current_autosave = self.auto_save;
        let current_notifications = self.notifications;
        let current_debug = self.debug_mode;
        let current_experimental = self.experimental_features;
        let settings_path_for_theme = self.settings_path.clone();
        let active_tab: Rc<Cell<usize>> = Rc::new(Cell::new(0));

        window.open_dialog(cx, move |dialog, _, _| {
            let server_input = server_input.clone();
            let engine_input = engine_input.clone();
            let apikey_input = apikey_input.clone();
            let fontsize_input = fontsize_input.clone();
            let weak = weak.clone();
            let current_theme = current_theme.clone();
            let settings_path_for_theme = settings_path_for_theme.clone();
            let active_tab = active_tab.clone();

            dialog
                .title("Settings")
                .content({
                    let server_input = server_input.clone();
                    let engine_input = engine_input.clone();
                    let apikey_input = apikey_input.clone();
                    let fontsize_input = fontsize_input.clone();
                    let weak = weak.clone();
                    let current_theme = current_theme.clone();
                    let settings_path_for_theme = settings_path_for_theme.clone();
                    let active_tab = active_tab.clone();
                    move |content, _window, cx| {
                        let tab = active_tab.get();
                        let tab_names = ["Connection", "Appearance", "Behavior", "Advanced"];

                        content
                            .flex()
                            .flex_row()
                            .gap_6()
                            .h(px(480.0))
                            // Vertical tabs on the left
                            .child(
                                div().w(px(150.0)).flex_shrink_0().flex().flex_col().gap_1()
                                    .children(tab_names.iter().enumerate().map(|(i, name)| {
                                        let active_tab = active_tab.clone();
                                        let is_active = tab == i;
                                        let t = cx.theme().clone();
                                        div().w_full()
                                            .child(Button::new(format!("tab-{}", i))
                                                .label(*name)
                                                .ghost()
                                                .small()
                                                .w_full()
                                                .justify_start()
                                                .when(is_active, |b| b.bg(t.muted).border_l_2().border_color(t.accent))
                                                .on_click(move |_, window, _cx| {
                                                    active_tab.set(i);
                                                    window.refresh();
                                                }))
                                    }))
                            )
                            // Content area on the right
                            .child(
                                div().flex_1().h_full().overflow_y_scrollbar().pr_2()
                                    .children(match tab {
                                        0 => vec![
                                            // Connection section
                                            div().flex().flex_col().gap_4()
                                                .child(div().flex().flex_col().gap_1()
                                                    .child(Label::new("Connection").font_weight(FontWeight::BOLD).text_size(px(16.0)))
                                                    .child(div().h(px(1.0)).bg(cx.theme().border).mt_1()))
                                                .child(div().flex().flex_col().gap_2().p_3().rounded_md().bg(cx.theme().muted).border_1().border_color(cx.theme().border)
                                                    .child(Label::new("Backend Server URL").font_weight(FontWeight::SEMIBOLD).text_size(px(12.0)))
                                                    .child(Input::new(&server_input).h(px(32.0)))
                                                    .child(Label::new("Coding agent backend (tasks, events, agents). Default: http://127.0.0.1:8787")
                                                        .text_size(px(11.0)).text_color(cx.theme().muted_foreground))
                                                )
                                                .child(div().flex().flex_col().gap_2().p_3().rounded_md().bg(cx.theme().muted).border_1().border_color(cx.theme().border)
                                                    .child(Label::new("Engine URL").font_weight(FontWeight::SEMIBOLD).text_size(px(12.0)))
                                                    .child(Input::new(&engine_input).h(px(32.0)))
                                                    .child(Label::new("Fennec inference engine. Default: http://127.0.0.1:8184")
                                                        .text_size(px(11.0)).text_color(cx.theme().muted_foreground))
                                                )
                                                .child(div().flex().flex_col().gap_2().p_3().rounded_md().bg(cx.theme().muted).border_1().border_color(cx.theme().border)
                                                    .child(Label::new("API Key").font_weight(FontWeight::SEMIBOLD).text_size(px(12.0)))
                                                    .child(Input::new(&apikey_input).h(px(32.0)))
                                                    .child(Label::new("Authentication key for engine access. Default: local")
                                                        .text_size(px(11.0)).text_color(cx.theme().muted_foreground))
                                                )
                                                .into_any_element(),
                                        ],
                                        1 => vec![
                                            // Appearance section
                                            div().flex().flex_col().gap_4()
                                                .child(div().flex().flex_col().gap_1()
                                                    .child(Label::new("Appearance").font_weight(FontWeight::BOLD).text_size(px(16.0)))
                                                    .child(div().h(px(1.0)).bg(cx.theme().border).mt_1()))
                                                .child(div().flex().flex_col().gap_2().p_3().rounded_md().bg(cx.theme().muted).border_1().border_color(cx.theme().border)
                                                    .child(Label::new("Theme").font_weight(FontWeight::SEMIBOLD).text_size(px(12.0)))
                                                    .child(div().mt_2().gap_1().flex().flex_col()
                                                        .children({
                                                            let presets = theme_presets();
                                                            let current_theme_cell = current_theme.clone();
                                                            let settings_path_clone = settings_path_for_theme.clone();
                                                            let dialog_theme = cx.theme().clone();
                                                            presets.into_iter().enumerate().map(move |(i, preset)| {
                                                                let settings_path_clone = settings_path_clone.clone();
                                                                let current_theme_cell_click = current_theme_cell.clone();
                                                                let current_theme_cell_render = current_theme_cell.clone();
                                                                let preset_id = preset.id().to_string();
                                                                let preset_name = preset.name;
                                                                Button::new(format!("theme-{}", i)).ghost().small().w_full().justify_start()
                                                                    .on_click(move |_, window, cx| {
                                                                        preset.apply(cx);
                                                                        *current_theme_cell_click.borrow_mut() = preset.id().to_string();
                                                                        window.refresh();
                                                                        let theme_id = preset.id().to_string();
                                                                        let path = settings_path_clone.clone();
                                                                        std::thread::spawn(move || {
                                                                            if let Ok(contents) = std::fs::read_to_string(&path) {
                                                                                if let Ok(mut settings) = serde_json::from_str::<Settings>(&contents) {
                                                                                    settings.theme = Some(theme_id);
                                                                                    if let Ok(json) = serde_json::to_string_pretty(&settings) {
                                                                                        let _ = std::fs::write(&path, json);
                                                                                    }
                                                                                }
                                                                            }
                                                                        });
                                                                    })
                                                                    .child({
                                                                        let t = dialog_theme.clone();
                                                                        let is_selected = preset_id == *current_theme_cell_render.borrow();
                                                                        div().flex().items_center().gap_3().w_full()
                                                                            .child(div().w(px(16.0)).h(px(16.0)).rounded_full()
                                                                                .border_2().border_color(if is_selected { t.accent } else { t.border })
                                                                                .when(is_selected, |d| d.bg(t.accent))
                                                                                .child(if is_selected {
                                                                                    div().w_full().h_full().flex().items_center().justify_center()
                                                                                        .child(Label::new("✓").text_size(px(10.0)).text_color(t.background).font_weight(FontWeight::BOLD))
                                                                                } else {
                                                                                    div()
                                                                                }))
                                                                            .child(Label::new(preset_name).text_size(px(13.0)).font_weight(if is_selected { FontWeight::SEMIBOLD } else { FontWeight::NORMAL }))
                                                                            .child(div().flex_1())
                                                                            .when(is_selected, |d| d.child(Label::new("Active").text_size(px(10.0)).text_color(t.accent).font_weight(FontWeight::MEDIUM)))
                                                                    })
                                                            })
                                                        })
                                                    )
                                                    .child(Label::new("Select a color theme. Changes apply immediately.")
                                                        .text_size(px(11.0)).text_color(cx.theme().muted_foreground).mt_1())
                                                )
                                                .child(div().flex().flex_col().gap_2().p_3().rounded_md().bg(cx.theme().muted).border_1().border_color(cx.theme().border)
                                                    .child(Label::new("Font Size").font_weight(FontWeight::SEMIBOLD).text_size(px(12.0)))
                                                    .child(Input::new(&fontsize_input).h(px(32.0)))
                                                    .child(Label::new("UI font size in pixels. Default: 14")
                                                        .text_size(px(11.0)).text_color(cx.theme().muted_foreground))
                                                )
                                                .into_any_element(),
                                        ],
                                        2 => vec![
                                            // Behavior section
                                            div().flex().flex_col().gap_4()
                                                .child(div().flex().flex_col().gap_1()
                                                    .child(Label::new("Behavior").font_weight(FontWeight::BOLD).text_size(px(16.0)))
                                                    .child(div().h(px(1.0)).bg(cx.theme().border).mt_1()))
                                                .child(div().flex().flex_col().gap_2().p_3().rounded_md().bg(cx.theme().muted).border_1().border_color(cx.theme().border)
                                                    .child(div().flex().items_center().justify_between()
                                                        .child(Label::new("Auto-save").font_weight(FontWeight::SEMIBOLD).text_size(px(12.0)))
                                                        .child(Label::new(if current_autosave { "✓ Enabled" } else { "✗ Disabled" })
                                                            .text_size(px(11.0)).text_color(if current_autosave { cx.theme().green } else { cx.theme().muted_foreground })))
                                                    .child(Label::new("Automatically save task history and settings.")
                                                        .text_size(px(11.0)).text_color(cx.theme().muted_foreground))
                                                )
                                                .child(div().flex().flex_col().gap_2().p_3().rounded_md().bg(cx.theme().muted).border_1().border_color(cx.theme().border)
                                                    .child(div().flex().items_center().justify_between()
                                                        .child(Label::new("Notifications").font_weight(FontWeight::SEMIBOLD).text_size(px(12.0)))
                                                        .child(Label::new(if current_notifications { "✓ Enabled" } else { "✗ Disabled" })
                                                            .text_size(px(11.0)).text_color(if current_notifications { cx.theme().green } else { cx.theme().muted_foreground })))
                                                    .child(Label::new("Show desktop notifications for task completion.")
                                                        .text_size(px(11.0)).text_color(cx.theme().muted_foreground))
                                                )
                                                .child(div().flex().flex_col().gap_2().p_3().rounded_md().bg(cx.theme().muted).border_1().border_color(cx.theme().border)
                                                    .child(Label::new("Clear History").font_weight(FontWeight::SEMIBOLD).text_size(px(12.0)))
                                                    .child(Button::new("clear-history-btn").label("Clear all task history").ghost().small().mt_1()
                                                        .on_click({
                                                            let weak = weak.clone();
                                                            move |_, window, cx| {
                                                                let _ = weak.update(cx, |a, cx| {
                                                                    a.clear_history(cx);
                                                                    window.push_notification(Notification::info("History cleared."), cx);
                                                                });
                                                            }
                                                        }))
                                                    .child(Label::new("Remove all tasks and conversations.")
                                                        .text_size(px(11.0)).text_color(cx.theme().muted_foreground))
                                                )
                                                .into_any_element(),
                                        ],
                                        3 => vec![
                                            // Advanced section
                                            div().flex().flex_col().gap_4()
                                                .child(div().flex().flex_col().gap_1()
                                                    .child(Label::new("Advanced").font_weight(FontWeight::BOLD).text_size(px(16.0)))
                                                    .child(div().h(px(1.0)).bg(cx.theme().border).mt_1()))
                                                .child(div().flex().flex_col().gap_2().p_3().rounded_md().bg(cx.theme().muted).border_1().border_color(cx.theme().border)
                                                    .child(div().flex().items_center().justify_between()
                                                        .child(Label::new("Debug Mode").font_weight(FontWeight::SEMIBOLD).text_size(px(12.0)))
                                                        .child(Label::new(if current_debug { "✓ Enabled" } else { "✗ Disabled" })
                                                            .text_size(px(11.0)).text_color(if current_debug { cx.theme().green } else { cx.theme().muted_foreground })))
                                                    .child(Label::new("Enable verbose logging and debug information.")
                                                        .text_size(px(11.0)).text_color(cx.theme().muted_foreground))
                                                )
                                                .child(div().flex().flex_col().gap_2().p_3().rounded_md().bg(cx.theme().muted).border_1().border_color(cx.theme().border)
                                                    .child(div().flex().items_center().justify_between()
                                                        .child(Label::new("Experimental Features").font_weight(FontWeight::SEMIBOLD).text_size(px(12.0)))
                                                        .child(Label::new(if current_experimental { "✓ Enabled" } else { "✗ Disabled" })
                                                            .text_size(px(11.0)).text_color(if current_experimental { cx.theme().green } else { cx.theme().muted_foreground })))
                                                    .child(Label::new("Enable unstable features (AG-UI protocol, new samplers).")
                                                        .text_size(px(11.0)).text_color(cx.theme().muted_foreground))
                                                )
                                                .child(div().flex().flex_col().gap_2().p_3().rounded_md().bg(cx.theme().muted).border_1().border_color(cx.theme().border)
                                                    .child(Label::new("Data Directory").font_weight(FontWeight::SEMIBOLD).text_size(px(12.0)))
                                                    .child(Label::new(format!("{}", settings_path_for_theme.parent().unwrap_or(&settings_path_for_theme).display()))
                                                        .text_size(px(11.0)).text_color(cx.theme().muted_foreground).font_family("monospace"))
                                                )
                                                .child(div().flex().flex_col().gap_2().p_3().rounded_md().bg(cx.theme().muted).border_1().border_color(cx.theme().border)
                                                    .child(Label::new("Export Settings").font_weight(FontWeight::SEMIBOLD).text_size(px(12.0)))
                                                    .child(Button::new("export-settings-btn").label("Export to JSON").ghost().small().mt_1()
                                                        .on_click({
                                                            let weak = weak.clone();
                                                            move |_, window, cx| {
                                                                let _ = weak.update(cx, |a, cx| {
                                                                    a.save_settings();
                                                                    window.push_notification(Notification::info("Settings exported."), cx);
                                                                });
                                                            }
                                                        }))
                                                )
                                                .into_any_element(),
                                        ],
                                        _ => vec![],
                                    })
                            )
                    }
                })
                .footer(div().flex().justify_end().gap_2().p_3()
                    .child(Button::new("settings-cancel").label("Cancel").ghost()
                        .on_click(|_, window, cx| { window.close_dialog(cx); }))
                    .child(Button::new("settings-save").label("Save").primary()
                        .on_click({
                            let server_input = server_input.clone();
                            let engine_input = engine_input.clone();
                            let apikey_input = apikey_input.clone();
                            let fontsize_input = fontsize_input.clone();
                            let weak = weak.clone();
                            move |_, window, cx| {
                                let server_url = server_input.read(cx).value().trim().to_string();
                                let engine_url = engine_input.read(cx).value().trim().to_string();
                                let api_key = apikey_input.read(cx).value().trim().to_string();
                                let font_size_str = fontsize_input.read(cx).value().trim().to_string();
                                let font_size = font_size_str.parse::<f32>().unwrap_or(14.0);

                                let _ = weak.update(cx, |a, cx| {
                                    if !server_url.is_empty() {
                                        a.server_url = server_url;
                                    }
                                    if !engine_url.is_empty() {
                                        a.engine_url = engine_url;
                                    }
                                    if !api_key.is_empty() {
                                        a.api_key = api_key;
                                    }
                                    a.font_size = font_size;
                                    a.save_settings();
                                    a.fetch_backend_info();
                                    cx.notify();
                                });
                                window.close_dialog(cx);
                            }
                        })))
        });
    }

    fn right(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let t = cx.theme().clone();
        let working = self.working();
        let elapsed = self.elapsed();
        let msg_count = self.msg_count();
        let artifacts = self.artifacts_count();
        let skills = self.skills();
        let readings = self.web_readings();
        let sources = self.sources();
        let task_title = self.task().map(|tk| tk.title.clone()).unwrap_or_else(|| "No active task".into());
        let subagents = self.agents.len().saturating_sub(1);
        let skills_value = if skills.is_empty() {
            "Repository inspection".to_string()
        } else {
            let shown: Vec<&str> = skills.iter().take(2).map(|s| s.as_str()).collect();
            let mut v = shown.join(" · ");
            if skills.len() > 2 { v = format!("{v} · {} more", skills.len() - 2); }
            v
        };
        let sources_value = if sources.is_empty() {
            "No task sources".to_string()
        } else {
            let first = sources[0].rsplit(['/', '\\']).next().unwrap_or(&sources[0]).to_string();
            if sources.len() > 1 { format!("{first} · {} files", sources.len() - 1) } else { first }
        };

        div().w(px(300.0)).flex_shrink_0().bg(t.background).border_l_1().border_color(t.border).flex().flex_col().overflow_y_scrollbar()
            .child(div().px_4().py_3().border_b_1().border_color(t.border)
                .child(Label::new("Workspace context").font_weight(FontWeight::SEMIBOLD).text_color(t.accent))
                .child(Label::new("Inspector").text_size(px(12.0)).text_color(t.muted_foreground)))
            .child(div().px_4().py_3().border_b_1().border_color(t.border)
                .child(div().flex().items_center().justify_between()
                    .child(Label::new("ACTIVE AGENTS").text_size(px(10.0)).text_color(t.muted_foreground))
                    .child(Label::new(if working { "1 online" } else { "0 online" }).text_size(px(10.0))
                        .text_color(if working { t.green } else { t.muted_foreground })))
                .children(working.then(|| {
                    let t = t.clone();
                    div().mt_2().p_2().rounded_md().border_1().border_color(t.border)
                        .child(div().flex().items_center().gap_2()
                            .child(Label::new("F").text_color(t.accent).font_weight(FontWeight::BOLD))
                            .child(div().flex().flex_col().overflow_hidden()
                                .child(Label::new("Fennec").font_weight(FontWeight::MEDIUM))
                                .child(Label::new(task_title).text_size(px(11.0)).text_color(t.muted_foreground).truncate())
                                .child(Label::new(format!("Running · {elapsed}")).text_size(px(11.0)).text_color(t.green))))
                })))
            .child(div().px_4().py_3().border_b_1().border_color(t.border)
                .child(Label::new("WORKSPACE CONTEXT").text_size(px(10.0)).text_color(t.muted_foreground))
                .child(self.ctx_row("◉", "Subagents", if subagents > 0 { format!("{subagents} delegated agents") } else { "No delegated agents".into() }, t.accent, cx))
                .child(self.ctx_row("◎", "Processes", format!("{msg_count} messages · stream {}", if working { "active" } else { "idle" }), t.blue, cx))
                .child(self.ctx_row("⚡", "Skills", skills_value, t.yellow, cx))
                .child(self.ctx_row("▣", "Artifacts", if artifacts > 0 { format!("{artifacts} task artifacts") } else { "No task artifacts".into() }, t.green, cx))
                .child(self.ctx_row("◈", "Web Readings", if readings > 0 { format!("{readings} linked readings") } else { "No linked readings".into() }, t.blue, cx))
                .child(self.ctx_row("◌", "Sources", sources_value, t.muted_foreground, cx)))
            .child(div().px_4().py_3().border_b_1().border_color(t.border)
                .child(Label::new("ENVIRONMENT").text_size(px(10.0)).text_color(t.muted_foreground))
                .child(self.row("Repository", "fennec", cx))
                .child(self.row("Branch", "main", cx))
                .child(self.row("Backend", if self.backend_ok { "Connected" } else { "Offline" }, cx)))
    }

    fn ctx_row(&self, icon: &str, label: &str, value: String, icon_color: Hsla, cx: &mut Context<Self>) -> impl IntoElement {
        let t = cx.theme().clone();
        div().id(ElementId::Name(label.to_string().into())).flex().items_center().gap_2().mt_2()
            .child(Label::new(icon).text_color(icon_color))
            .child(div().flex().flex_col().overflow_hidden()
                .child(Label::new(label).font_weight(FontWeight::MEDIUM))
                .child(Label::new(value).text_size(px(11.0)).text_color(t.muted_foreground).truncate()))
    }

    fn row(&self, label: &str, value: &str, cx: &mut Context<Self>) -> impl IntoElement {
        let t = cx.theme().clone();
        div().id(ElementId::Name(label.to_string().into())).flex().items_center().justify_between().py_1()
            .child(Label::new(label).text_size(px(12.0)))
            .child(Label::new(value).text_size(px(12.0)).text_color(t.muted_foreground))
    }
}

fn main() {
    let data_dir = dirs::data_local_dir().unwrap_or_else(|| PathBuf::from(".")).join("fennec-coding-agent");
    std::fs::create_dir_all(&data_dir).ok();
    let path = data_dir.join("history.json");
    let settings_path = data_dir.join("settings.json");

    application().with_assets(assets::Assets).run(move |cx| {
        init(cx);
        Theme::change(ThemeMode::Dark, None, cx);
        let bounds = Bounds::centered(None, size(px(1400.0), px(900.0)), cx);
        
        let settings_path_clone = settings_path.clone();
        cx.open_window(WindowOptions { window_bounds: Some(WindowBounds::Windowed(bounds)), ..Default::default() }, |window, cx| {
            let composer = cx.new(|cx| InputState::new(window, cx));
            let search = cx.new(|cx| InputState::new(window, cx));
            let view = cx.new(|cx| {
                let mut app = App::new(path, settings_path_clone.clone(), composer, search, window, cx);
                app.load();
                app
            });
            cx.new(|cx| Root::new(view, window, cx))
        }).expect("Failed to open window");
        
        let presets = theme_presets();
        if let Ok(contents) = std::fs::read_to_string(&settings_path) {
            if let Ok(settings) = serde_json::from_str::<Settings>(&contents) {
                if let Some(theme_id) = &settings.theme {
                    let idx = find_preset_index(theme_id);
                    if let Some(preset) = presets.get(idx) {
                        preset.apply(cx);
                    }
                }
            }
        }
    });
}
