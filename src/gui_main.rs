use fennec_client::coding_agent::CodingAgentClient;
use fennec_client::Core;

use fennec_ui::attention::{
    ApprovalCard, ApprovedCommand, CardState, approval_card, approved_commands_panel,
    attention_badge, needs_attention, write_of_title,
};
use fennec_ui::markdown::{artifact_badge, attachment_subtitle, diff_counts, rich_div};
use fennec_ui::theme::{find_preset_index, theme_presets};
use fennec_ui::timeline::{CallShape, GroupRow, actions_title, is_open, reveal_text, short_text, unique_actions};
use fennec_ui::widgets::{action_card, ai_header, attachment_card, composer_dock, composer_toolbar, queue_strip, show_output, speak_tts, tool_group, user_bubble};
use fennec_ui::workspace_dialog::open_workspace_dialog;
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
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::cell::{Cell, RefCell};
use std::rc::Rc;
use std::sync::Arc;

const WARM_WINDOW: std::time::Duration = std::time::Duration::from_secs(300);

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
    /// What a delivered file's call did to it: `created` or `updated`. Only
    /// files the run itself wrote carry one — a file the user attached has no
    /// verb, so the chip can tell the two apart.
    #[serde(default)]
    verb: Option<String>,
    /// The absolute directory the run was jailed to, recorded when a file was
    /// delivered. `path` is relative to it, so this is what turns a delivered
    /// path back into a real file.
    #[serde(default)]
    root: Option<String>,
}

/// The one block a run of calls folded into, and the messages it absorbed.
struct FoldBlocks {
    /// The anchor message's id: the block keys its element id and its open state
    /// off it, so no two runs in one task can collide.
    id: u64,
    rows: Vec<GroupRow>,
    /// What each row prints on click, in row order: the whole call and what it
    /// returned.
    acts: Vec<(String, String)>,
}

/// Every run of calls in a timeline, as the block to draw and the messages to
/// leave out. The stream here interleaves the calls with the answers between
/// them, so a run is one maximal stretch of calls and its block lands where the
/// calls happened — the same stretch the desktop anchors its block to.
struct Folds {
    hidden: std::collections::HashSet<usize>,
    at: std::collections::HashMap<usize, FoldBlocks>,
}

/// Whether a message is a call the blocks can absorb. A call that is still
/// running is the one row the user watches, and a file the user attached
/// themselves is not the run's work, so neither folds.
fn folds_up(m: &Msg) -> bool {
    let meta = m.meta.as_ref();
    match m.kind {
        MsgKind::Action => meta.and_then(|x| x.duration.as_ref()).is_some(),
        MsgKind::Attach => meta.and_then(|x| x.verb.as_ref()).is_some(),
        MsgKind::Edit => true,
        _ => false,
    }
}

fn call_failed(m: &Msg) -> bool {
    m.meta.as_ref().and_then(|x| x.duration.as_ref()).map(|d| d == "failed").unwrap_or(false)
}

/// The call's own title, which `describe_call` spells `EDIT · Write file x.py`.
fn call_title(m: &Msg) -> String {
    m.meta.as_ref().and_then(|x| x.title.clone()).unwrap_or_else(|| "Action".into())
}

/// Whether the call put a file on disk. A failed write wrote nothing, so it
/// folds with the calls that merely ran.
fn is_write(m: &Msg) -> bool {
    match m.kind {
        MsgKind::Attach | MsgKind::Edit => true,
        MsgKind::Action => !call_failed(m) && write_of_title(&call_title(m)).is_some(),
        _ => false,
    }
}

fn base_name(path: &str) -> String {
    Path::new(path).file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| path.to_string())
}

/// The file a row leads to, as the OS needs it. A delivered path is relative to
/// the directory the loop ran in; `root` is that directory when the message
/// knows it and the current workspace when it does not.
fn absolute(root: &str, path: &str) -> String {
    if path.is_empty() {
        String::new()
    } else if Path::new(path).is_absolute() {
        path.to_string()
    } else {
        Path::new(root).join(path).to_string_lossy().into_owned()
    }
}

/// The file a write is about, as the call named it. A delivery card carries the
/// path in its own field; a call only says it inside its title.
fn write_target(m: &Msg) -> String {
    let meta = m.meta.as_ref();
    meta.and_then(|x| x.path.clone())
        // A write whose delivered card this window never saw: the call's own
        // title still says which file it was.
        .or_else(|| write_of_title(&call_title(m)).map(|(_, p)| p))
        .unwrap_or_default()
}

fn written_row(m: &Msg) -> (GroupRow, (String, String)) {
    let meta = m.meta.as_ref();
    let path = write_target(m);
    let verb = meta.and_then(|x| x.verb.clone())
        .or_else(|| write_of_title(&call_title(m)).map(|(v, _)| v.to_string()))
        .unwrap_or_else(|| "changed".into());
    let (adds, dels) = if m.kind == MsgKind::Edit {
        (meta.and_then(|x| x.add).unwrap_or(0), meta.and_then(|x| x.del).unwrap_or(0))
    } else {
        diff_counts(&m.content)
    };
    let label = short_text(&path, &call_title(m));
    // The row reveals the whole call it stands for, the same way the PWA row and
    // the desktop's diff dialog do; opening the file itself stays the delivered
    // card's job, because a row inside a block is about the call, not the disk.
    let act = (call_title(m), m.content.clone());
    (GroupRow::new(artifact_badge(&base_name(&label)), label, verb).change(adds, dels), act)
}

fn ran_row(m: &Msg) -> (GroupRow, (String, String)) {
    let title = call_title(m);
    // The badge the call was filed under is the first half of its own title, so
    // the row cannot drift from what the standalone card said.
    let (icon, body) = match title.split_once(" · ") {
        Some((c, rest)) => (c.to_string(), rest.to_string()),
        None => ("⚙".to_string(), title.clone()),
    };
    // The row says the file's name or the command's first words; the whole call
    // is what the row's click prints.
    let path = m.meta.as_ref().and_then(|x| x.path.clone()).unwrap_or_default();
    let label = short_text(&path, &body);
    let failed = call_failed(m);
    let row = GroupRow::new(icon, label, if failed { "Failed".into() } else { "Complete".into() });
    (if failed { row.failed() } else { row }, (title, m.content.clone()))
}

fn fold_run(run: &[Msg], id: u64) -> FoldBlocks {
    // A delivered file is a card of its own below the block, so the block lists
    // only the calls that made the files.
    let calls: Vec<usize> = run.iter().enumerate()
        .filter(|(_, m)| m.kind != MsgKind::Attach)
        .map(|(ri, _)| ri).collect();
    let shapes: Vec<CallShape> = calls.iter()
        .map(|&ri| CallShape { wrote: is_write(&run[ri]), running: false })
        .collect();
    // One row per file, the last write of it winning, and every command on its
    // own line: a run that rewrote one file six times delivered one file, and a
    // block that counted six would be counting its own repetition.
    let called: Vec<String> = calls.iter().map(|&ri| write_target(&run[ri])).collect();
    let refs: Vec<&str> = called.iter().map(String::as_str).collect();
    let mut blocks = FoldBlocks { id, rows: Vec::new(), acts: Vec::new() };
    for &j in &unique_actions(&shapes, &refs) {
        let m = &run[calls[j]];
        let (row, act) = if shapes[j].wrote { written_row(m) } else { ran_row(m) };
        blocks.rows.push(row);
        blocks.acts.push(act);
    }
    blocks
}

fn fold_calls(msgs: &[Msg]) -> Folds {
    let mut folds = Folds { hidden: std::collections::HashSet::new(), at: std::collections::HashMap::new() };
    let mut i = 0usize;
    while i < msgs.len() {
        if !folds_up(&msgs[i]) {
            i += 1;
            continue;
        }
        let start = i;
        let mut end = i;
        while end < msgs.len() && folds_up(&msgs[end]) {
            end += 1;
        }
        let blocks = fold_run(&msgs[start..end], msgs[start].id);
        // A delivered file stays a card of its own, so it is not hidden by the
        // block that absorbed the call that wrote it.
        folds.hidden.extend((start..end).filter(|&k| msgs[k].kind != MsgKind::Attach));
        if !blocks.rows.is_empty() {
            folds.at.insert(start, blocks);
        }
        i = end;
    }
    folds
}

#[derive(Clone)]
struct Toast {
    text: String,
    good: bool,
    at: std::time::Instant,
}

/// One gated call the agent loop stopped on. Written from the core's
/// `approval_required` step, so every field is a word the loop itself chose.
#[derive(Clone, Serialize, Deserialize, Debug)]
struct ApprovalRequest {
    id: String,
    action: String,
    risk_level: String,
    command: Option<String>,
    resolved: Option<ApprovalResolution>,
    /// The tool table's own badge (`CMD`, `EDIT`, `READ`, …).
    #[serde(default)]
    category: String,
    /// Why the gate stopped the run, in the loop's words.
    #[serde(default)]
    reason: String,
    #[serde(default)]
    path: Option<String>,
    /// The question is no longer live: the run ended, or the loop's own timeout
    /// refused the call while nobody answered. That is not the same as the user
    /// not having answered, and the card has to say which it is.
    #[serde(default)]
    expired: bool,
    #[serde(default)]
    note: String,
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
    /// The supervised session this run belongs to on the agent loop
    /// (`/api/agent/*`). Only a run with one can be answered or cancelled.
    #[serde(default)]
    core_sid: Option<String>,
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
    /// The action blocks the user clicked open, keyed on their anchor message id.
    open_blocks: std::collections::HashSet<u64>,
    /// The ones the user clicked shut. Without these, closing the newest block
    /// would just reopen it at the next repaint, because it is still the newest.
    closed_blocks: std::collections::HashSet<u64>,
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
    perm_dropdown_open: bool,
    model_dropdown_open: bool,
    stt_recording: bool,
    stt_stop: Arc<AtomicBool>,
    stt_buffer: Arc<std::sync::Mutex<Vec<f32>>>,
    stt_rate: Arc<std::sync::atomic::AtomicU32>,
    stt_stream: Option<cpal::Stream>,
    composer_restore: Option<String>,
    allow_write: bool,
    allow_shell: bool,
    allow_web: bool,
    ask_each: bool,
    settings_path: PathBuf,
    backend_ok: bool,
    /// The Python agent loop (`fennec-agent serve`) on the same URL. It is the
    /// only backend that gates a tool call, so the approval rail and the answer
    /// buttons exist solely on this lane.
    core: Core,
    core_up: bool,
    /// The directory the loop will accept a task for; anything else is a 403.
    core_root: String,
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
    BackendInfo { names: Vec<String> },
    /// Which service answers on `server_url`, re-probed every couple of seconds
    /// and reported only when it changed.
    ServeState { core_up: bool, core_root: String, axum: bool },
    Core(CoreEvent),
    Stt(String),
}

/// One thing a supervised core run did, translated off the UI thread.
#[derive(Debug)]
enum CoreEvent {
    /// `/api/agent/start` answered with the session id this run is polled by.
    Started { task_id: u64, sid: String },
    /// The loop's own reasoning, and its answer to the user.
    Reasoning { task_id: u64, text: String },
    Answer { task_id: u64, text: String },
    /// A tool call: opened by `tool_start`, closed by the `tool` step that
    /// carries the result. `ok` is `None` while it is still running.
    Tool { task_id: u64, id: String, title: String, detail: String, ok: Option<bool>, output: String },
    /// A file the run put on disk, delivered to the user as its own card. Only
    /// `write_file` and `edit_file` produce one; a read names a path without
    /// changing it.
    Deliver { task_id: u64, name: String, path: String, verb: &'static str, root: String },
    /// A question the loop stopped on.
    Approval { task_id: u64, approval: ApprovalRequest },
    /// What happened to an answer this window sent: `error` is the loop's own
    /// refusal, which means the question was no longer live.
    Answered { task_id: u64, approval_id: String, decision: String, error: Option<String> },
    /// The approval ids the loop still holds; anything else can no longer be
    /// answered, which is not the same as unanswered.
    Pending { task_id: u64, ids: Vec<String> },
    Status { task_id: u64, status: String },
    /// The run could not be started, or stopped being pollable.
    Refused { task_id: u64, error: String },
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
        // Both backends listen on the same port, so the core lane shares this URL.
        let core_base = server_url.clone();

        let mut app = Self {
            tasks: vec![], active: None, queued: vec![], inspector: true,
            attention_only: false, open_blocks: Default::default(), closed_blocks: Default::default(), search_open: false, search, composer,
            server_url, engine_url, api_key, model, access_mode, theme, font_size, auto_save,
            notifications, debug_mode, experimental_features,
            perm_dropdown_open: false, model_dropdown_open: false,
            stt_recording: false,
            stt_stop: Arc::new(AtomicBool::new(false)),
            stt_buffer: Arc::new(std::sync::Mutex::new(Vec::new())),
            stt_rate: Arc::new(std::sync::atomic::AtomicU32::new(16000)),
            stt_stream: None,
            composer_restore: None,
            allow_write, allow_shell, allow_web, ask_each,
            settings_path: settings_path.clone(), backend_ok: false,
            core: Core { base: core_base }, core_up: false, core_root: String::new(),
            agents: vec![],
            path, next_id: 1, response_rx: rx, response_tx: tx,
            pending_think: None, pending_content: None, tools: std::collections::HashMap::new(),
            _task, scroll_handle: ScrollHandle::new(), line: String::new(), toasts: Vec::new(), pending_send: None,
            workspaces: vec![], active_workspace_id: None,
            workspaces_path: settings_path.parent().unwrap_or(&settings_path).join("workspaces.json"),
        };
        app.load_workspaces();
        app.fetch_backend_info();
        app.watch_service();
        app
    }

    /// One URL can hold either Fennec backend, and they offer different things:
    /// the Rust one streams chat and gates nothing, the Python agent loop gates
    /// every write and asks. `/api/health` says which is answering — only the
    /// loop's payload carries `app` — and the answer is re-checked because a
    /// service started after this window still has to light up the rail.
    fn watch_service(&self) {
        let tx = self.response_tx.clone();
        let base = self.core.base.clone();
        std::thread::spawn(move || {
            let core = Core { base };
            let mut last: Option<(bool, String, bool)> = None;
            loop {
                let health = core.health();
                let state = match &health {
                    Some(h) if h["app"].is_string() =>
                        (true, h["workspace"].as_str().unwrap_or("").to_string(), false),
                    Some(_) => (false, String::new(), true),
                    None => (false, String::new(), false),
                };
                if last.as_ref() != Some(&state) {
                    let _ = tx.send(BackendResponse::ServeState {
                        core_up: state.0, core_root: state.1.clone(), axum: state.2,
                    });
                    last = Some(state);
                }
                std::thread::sleep(std::time::Duration::from_millis(2000));
            }
        });
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
                // One delivered file, one card. History written while a delivery
                // was pushed per call holds several cards for a file the run
                // rewrote, and only the last matches what is on disk now.
                for t in self.tasks.iter_mut() {
                    let mut last_of: std::collections::HashMap<String, u64> = std::collections::HashMap::new();
                    for m in t.msgs.iter() {
                        let (Some(path), Some(verb)) = (
                            m.meta.as_ref().and_then(|x| x.path.clone()),
                            m.meta.as_ref().and_then(|x| x.verb.clone()),
                        ) else { continue };
                        if m.kind == MsgKind::Attach && !verb.is_empty() && !path.is_empty() {
                            last_of.insert(path, m.id);
                        }
                    }
                    t.msgs.retain(|m| {
                        if m.kind != MsgKind::Attach { return true; }
                        let path = m.meta.as_ref().and_then(|x| x.path.clone()).unwrap_or_default();
                        let verb = m.meta.as_ref().and_then(|x| x.verb.clone()).unwrap_or_default();
                        if path.is_empty() || verb.is_empty() { return true; }
                        last_of.get(&path).is_none_or(|id| *id == m.id)
                    });
                    // The chip is the delivery report, so the "Delivered N
                    // files" paragraph older history saved inside the answer is
                    // trimmed here rather than shown a second time.
                    let mut hollow: Vec<usize> = Vec::new();
                    for (ri, m) in t.msgs.iter_mut().enumerate() {
                        if m.kind == MsgKind::Attach || m.kind == MsgKind::User { continue; }
                        if fennec_ui::attention::strip_delivery_prose(&mut m.content) {
                            hollow.push(ri);
                        }
                    }
                    for ri in hollow.into_iter().rev() { t.msgs.remove(ri); }
                }
                // Drop empty drafts so a fresh install shows an empty history.
                self.tasks.retain(|t| !t.msgs.is_empty());
                if let Some(a) = self.active {
                    if !self.tasks.iter().any(|t| t.id == a) {
                        self.active = self.tasks.last().map(|t| t.id);
                    }
                }
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
        // Empty drafts are not history: first run stays empty, real
        // conversations persist across restarts.
        let tasks: Vec<Task> = self.tasks.iter().filter(|t| !t.msgs.is_empty()).cloned().collect();
        let active = self.active.filter(|id| tasks.iter().any(|t| t.id == *id));
        let h = History { tasks, active, queued: self.queued.clone() };
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
            let names = client.list_agents().iter()
                .filter_map(|v| v.get("name").and_then(|n| n.as_str()).map(|s| s.to_string()))
                .collect();
            let _ = tx.send(BackendResponse::BackendInfo { names });
        });
    }

    fn poll_responses(&mut self, cx: &mut Context<Self>) {
        while let Ok(resp) = self.response_rx.try_recv() {
            match resp {
                BackendResponse::Stt(text) => {
                    self.stt_recording = false;
                    self.line = String::new();
                    if !text.is_empty() { self.composer_restore = Some(text); }
                }
                BackendResponse::BackendInfo { names } => {
                    self.agents = names;
                }
                BackendResponse::ServeState { core_up, core_root, axum } => {
                    self.core_up = core_up;
                    self.core_root = core_root;
                    // Either service answering means the composer can send;
                    // which one decides where the prompt goes.
                    self.backend_ok = axum || core_up;
                    if axum { self.fetch_backend_info(); }
                    self.flush_warm_queue();
                }
                BackendResponse::Core(ev) => self.apply_core(ev, cx),
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
                                add: None, del: None, path: None, size: None, verb: None, root: None,
                            }),
                        });
                    }
                    self.tools.insert(tool_id, (tid, mid));
                }
                BackendResponse::ActionDone { tool_id, duration, detail } => {
                    if let Some(&(tid, mid)) = self.tools.get(&tool_id) {
                        if let Some(m) = self.msg_mut(tid, mid) {
                            // `duration` doubles as the row's done-flag: `None` is
                            // what makes it read "Running…", so a finished tool
                            // with no timing still has to be marked Some.
                            if let Some(meta) = m.meta.as_mut() { meta.duration = Some(duration.unwrap_or_default()); }
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
            self.tasks.push(Task { id, title: "New task".into(), status: "Running".into(), repo: "Liso7150/fennec".into(), msgs: vec![], backend_id: None, started_at: None, approvals: vec![], core_sid: None, workspace_id: self.active_workspace_id.clone() });
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

    /// What the user clicked on an action block. The click wins in both
    /// directions, so it is recorded as an open or a close, not as a flip of
    /// whatever the block would have done on its own. A block presents several
    /// messages and owns none of them, so its state is keyed on the id of the
    /// first one it absorbed rather than stored in a message.
    fn toggle_block(&mut self, id: u64, was_open: bool) {
        if was_open {
            self.open_blocks.remove(&id);
            self.closed_blocks.insert(id);
        } else {
            self.closed_blocks.remove(&id);
            self.open_blocks.insert(id);
        }
    }

    fn new_task(&mut self) {
        let id = self.next_id;
        self.next_id += 1;
        self.tasks.push(Task { id, title: "New task".into(), status: "Idle".into(), repo: "Liso7150/fennec".into(), msgs: vec![], backend_id: None, started_at: None, approvals: vec![], core_sid: None, workspace_id: self.active_workspace_id.clone() });
        self.active = Some(id);
        self.attention_only = false;
        self.save();
    }

    fn new_task_in_workspace(&mut self, workspace_id: &str) {
        let id = self.next_id;
        self.next_id += 1;
        self.tasks.push(Task { id, title: "New task".into(), status: "Idle".into(), repo: "Liso7150/fennec".into(), msgs: vec![], backend_id: None, started_at: None, approvals: vec![], core_sid: None, workspace_id: Some(workspace_id.to_string()) });
        self.active = Some(id);
        self.attention_only = false;
        self.save();
    }

    fn select_task(&mut self, id: u64) {
        self.active = Some(id);
        self.scroll_handle.scroll_to_bottom();
        self.save();
    }

    /// A run stopped on an approval is still this task's turn: the next prompt
    /// belongs behind it in the warm queue, not in a second concurrent run.
    fn working(&self) -> bool {
        self.task().map(|t| matches!(t.status.as_str(), "Running" | "AwaitingApproval")).unwrap_or(false)
    }

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

    /// A task is the user's business while it has a question they can still
    /// answer, or a status that says it stopped to wait for one. An expired
    /// question is not attention — there is nothing left to do with it.
    fn task_needs_attention(&self, t: &Task) -> bool {
        let pending = t.approvals.iter().filter(|a| a.resolved.is_none() && !a.expired).count();
        needs_attention(&t.status, pending)
    }

    fn attention_count(&self) -> usize {
        self.tasks.iter().filter(|t| self.task_needs_attention(t)).count()
    }

    fn approved_commands(&self) -> Vec<ApprovedCommand> {
        self.tasks.iter()
            .flat_map(|t| t.approvals.iter().filter_map(move |a| {
                a.resolved.as_ref().map(|r| (t, a, r.choice_id.clone()))
            }))
            .map(|(t, a, decision)| ApprovedCommand {
                task_id: t.id.to_string(),
                task_title: t.title.clone(),
                command: a.command.clone().unwrap_or_else(|| a.action.clone()),
                risk: a.risk_level.clone(),
                decision,
            })
            .collect()
    }

    /// What the rail lists right now. `query_lower` is the search text already
    /// downcased; My Attention and Search each narrow the list their own way.
    fn task_shown(&self, t: &Task, query_lower: &str) -> bool {
        (!self.attention_only || self.task_needs_attention(t))
            && (query_lower.is_empty()
                || t.title.to_lowercase().contains(query_lower)
                || t.repo.to_lowercase().contains(query_lower))
    }

    fn filtered_tasks(&self, query: &str) -> Vec<&Task> {
        let q = query.to_lowercase();
        self.tasks.iter()
            .filter(|t| self.task_shown(t, &q))
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

    fn set_access_mode(&mut self, mode: &str) {
        self.access_mode = mode.to_string();
        match mode {
            "auto" => { self.allow_write = true; self.allow_shell = true; self.allow_web = true; self.ask_each = false; }
            "full" => { self.allow_write = true; self.allow_shell = true; self.allow_web = true; self.ask_each = false; }
            _ => { self.allow_write = false; self.allow_shell = false; self.allow_web = false; self.ask_each = true; }
        }
        self.save_settings();
    }

    fn access_label(&self) -> &'static str {
        fennec_ui::controls::access_label(&self.access_mode)
    }

    fn access_icon(&self) -> &'static str {
        fennec_ui::controls::access_icon(&self.access_mode)
    }

    fn access_color(&self, t: &gpui_kit::component::Theme) -> gpui::Hsla {
        fennec_ui::controls::access_color(&self.access_mode, t)
    }

    fn model_display_name(&self) -> String {
        fennec_ui::controls::model_display_name(&self.model)
    }

    fn toggle_stt(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.stt_recording {
            self.stt_stop.store(true, Ordering::Relaxed);
            self.stt_stream = None;
            self.stt_recording = false;
            self.line = "Transcribing…".to_string();
            cx.notify();
            return;
        }
        use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
        let host = cpal::default_host();
        let device = match host.default_input_device() {
            Some(d) => d,
            None => { window.push_notification(Notification::info("No microphone found."), cx); return; }
        };
        let config = match device.default_input_config() {
            Ok(c) => c,
            Err(e) => { window.push_notification(Notification::info(format!("Mic config error: {e}")), cx); return; }
        };
        let rate = config.sample_rate().0;
        self.stt_rate.store(rate, Ordering::Relaxed);
        self.stt_buffer.lock().unwrap().clear();
        self.stt_stop.store(false, Ordering::Relaxed);
        let channels = config.channels() as usize;
        let buffer = self.stt_buffer.clone();
        let stream = match config.sample_format() {
            cpal::SampleFormat::F32 => device.build_input_stream(&config.into(), move |data: &[f32], _| {
                let mut b = buffer.lock().unwrap();
                for frame in data.chunks(channels) { b.push(frame[0]); }
            }, |e| eprintln!("stt error: {e}"), None),
            cpal::SampleFormat::I16 => {
                let buffer = self.stt_buffer.clone();
                device.build_input_stream(&config.into(), move |data: &[i16], _| {
                    let mut b = buffer.lock().unwrap();
                    for frame in data.chunks(channels) { b.push(frame[0] as f32 / 32768.0); }
                }, |e| eprintln!("stt error: {e}"), None)
            },
            _ => { window.push_notification(Notification::info("Unsupported mic format."), cx); return; }
        };
        let stream = match stream { Ok(s) => s, Err(e) => { window.push_notification(Notification::info(format!("Mic open error: {e}")), cx); return; } };
        if stream.play().is_err() { window.push_notification(Notification::info("Could not start mic."), cx); return; }
        self.stt_recording = true;
        self.stt_stream = Some(stream);
        self.line = "Recording… click the mic again to stop and transcribe.".to_string();
        cx.notify();
        let stop = self.stt_stop.clone();
        let buffer = self.stt_buffer.clone();
        let rate_arc = self.stt_rate.clone();
        let tx = self.response_tx.clone();
        std::thread::spawn(move || {
            while !stop.load(Ordering::Relaxed) { std::thread::sleep(std::time::Duration::from_millis(50)); }
            let samples = buffer.lock().unwrap().clone();
            let rate = rate_arc.load(Ordering::Relaxed);
            let text = fennec_ui::controls::transcribe_samples(&samples, rate);
            let _ = tx.send(BackendResponse::Stt(text));
        });
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
            core_sid: None,
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
                path: Some(path.to_string_lossy().to_string()), size: Some(size), verb: None, root: None,
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

        // Fold attachments into the prompt: text files inline, images noted for
        // vision-capable backends.
        let mut text = text;
        if let Some(t) = self.task() {
            for m in &t.msgs {
                if m.kind != MsgKind::Attach { continue; }
                let Some(p) = m.meta.as_ref().and_then(|x| x.path.clone()) else { continue };
                let path = Path::new(&p);
                let name = m.meta.as_ref().and_then(|x| x.title.clone()).unwrap_or_else(|| "file".into());
                let ext = path.extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default();
                if matches!(ext.as_str(), "png" | "jpg" | "jpeg" | "gif" | "webp") {
                    if let Ok(bytes) = std::fs::read(path) {
                        use base64::Engine as _;
                        let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
                        text.push_str(&format!("\n[attached image {} data:image/{};base64,{}]", name, ext, b64));
                    }
                } else if let Ok(content) = std::fs::read_to_string(path) {
                    text.push_str(&format!("\n\n[{}]\n{}", name, content));
                }
            }
        }

        // The loop is the only backend that gates a call. When it answers on
        // this URL the prompt goes there, so the cards and the badge have a real
        // question behind them; the Rust service stays the chat lane.
        if self.core_up {
            self.dispatch_core(text, task_id);
            return;
        }

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

    /// The directory to hand the loop for the active task. The loop refuses
    /// (403) anything outside the root it was started with, so a workspace
    /// folder it cannot reach is not offered — its own root is, which says where
    /// the run can actually work instead of where a rail shows a picture.
    fn core_workspace(&self) -> String {
        let root = self.core_root.trim_end_matches(['\\', '/']).to_string();
        let folder = self.active_workspace_id.as_ref()
            .and_then(|id| self.workspaces.iter().find(|w| &w.id == id))
            .and_then(|w| w.source_folders.first())
            .map(|s| s.trim_end_matches(['\\', '/']).to_string())
            .unwrap_or_default();
        let reachable = !root.is_empty()
            && folder.to_lowercase().starts_with(&root.to_lowercase());
        if reachable || root.is_empty() { folder } else { root }
    }

    /// Start a supervised run on the agent loop and follow it. This is the lane
    /// that gates: `loop.py` lifts the `allow_*` switches and stops before every
    /// write, so what admits a call is the answer on the card, not a box ticked
    /// when the run started.
    fn dispatch_core(&self, text: String, task_id: u64) {
        let (core, tx) = (self.core.clone(), self.response_tx.clone());
        let workspace = self.core_workspace();
        let (allow_write, allow_shell, allow_web) = (self.allow_write, self.allow_shell, self.allow_web);
        let ask = self.ask_each || self.access_mode == "ask";
        std::thread::spawn(move || {
            let sid = match core.start(&text, &workspace, allow_write, allow_shell, allow_web, ask) {
                Ok(sid) => sid,
                Err(e) => {
                    let _ = tx.send(BackendResponse::Core(CoreEvent::Refused { task_id, error: e }));
                    return;
                }
            };
            let _ = tx.send(BackendResponse::Core(CoreEvent::Started { task_id, sid: sid.clone() }));
            let mut after = 0usize;
            loop {
                std::thread::sleep(std::time::Duration::from_millis(350));
                let v = match core.poll(&sid, after) {
                    Ok(v) => v,
                    Err(e) => {
                        let _ = tx.send(BackendResponse::Core(CoreEvent::Refused { task_id, error: e }));
                        return;
                    }
                };
                let steps = v["steps"].as_array().cloned().unwrap_or_default();
                // Steps first: a card this round sent has to exist before the
                // pending list says which cards are live.
                for s in &steps {
                    translate_step(&tx, task_id, s, &workspace);
                }
                if !steps.is_empty() {
                    after += steps.len();
                }
                // `pending` is what the loop still holds. A service that reports
                // no list is not the same as an empty one — except once the run
                // is over, when it cannot be waiting on anyone.
                let finished = v["status"].as_str().map(|s| s != "running").unwrap_or(true);
                match (v["pending"].as_array(), finished) {
                    (Some(list), _) => {
                        let ids = list.iter().filter_map(serde_json::Value::as_str)
                            .map(str::to_string).collect::<Vec<String>>();
                        let _ = tx.send(BackendResponse::Core(CoreEvent::Pending { task_id, ids }));
                    }
                    (None, true) => {
                        let _ = tx.send(BackendResponse::Core(CoreEvent::Pending { task_id, ids: vec![] }));
                    }
                    (None, false) => {}
                }
                if finished {
                    let status = v["status"].as_str().unwrap_or("done").to_string();
                    let _ = tx.send(BackendResponse::Core(CoreEvent::Status { task_id, status }));
                    return;
                }
            }
        });
    }

    /// Send one answer to the loop, off-thread so a slow service cannot freeze
    /// the window. The outcome comes back as an `Answered` event: the loop only
    /// accepts a question it still holds, and a 404 is not the same as a yes.
    fn answer(&mut self, task_id: u64, approval_id: String, decision: String) {
        let Some(sid) = self.core_sid_of(task_id) else {
            self.line = "This run has no supervised session on the agent loop, so there is nothing to answer."
                .to_string();
            return;
        };
        let (core, tx) = (self.core.clone(), self.response_tx.clone());
        std::thread::spawn(move || {
            let error = core.approve(&sid, &approval_id, &decision).err();
            let _ = tx.send(BackendResponse::Core(CoreEvent::Answered {
                task_id, approval_id, decision, error,
            }));
        });
    }

    /// Stop a supervised run. The loop's `cancel` ends the turn; the cards it was
    /// holding go expired with it, which `Pending` reports on the next poll.
    fn stop_run(&mut self, task_id: u64) {
        let Some(sid) = self.core_sid_of(task_id) else {
            self.set_task_status(task_id, "Idle");
            return;
        };
        let core = self.core.clone();
        std::thread::spawn(move || { let _ = core.cancel(&sid); });
    }

    /// The supervised session a task is running under, when it has one. Only
    /// such a run can be answered or cancelled — the Rust service has no
    /// question to answer.
    fn core_sid_of(&self, task_id: u64) -> Option<String> {
        self.tasks.iter().find(|t| t.id == task_id).and_then(|t| t.core_sid.clone())
    }

    /// The loop's `assistant` and `error` steps are the only answers it gives;
    /// until one arrives the placeholder is the only thing saying the run is
    /// alive, so the first real event has to retire it.
    fn clear_think_placeholder(&mut self, task_id: u64) {
        let Some((tid, mid)) = self.pending_think else { return };
        if tid != task_id { return; }
        if let Some(t) = self.tasks.iter_mut().find(|t| t.id == tid) {
            if t.msgs.iter().any(|m| m.id == mid && m.content == "Thinking…") {
                t.msgs.retain(|m| m.id != mid);
            }
        }
        self.pending_think = None;
        self.pending_content = None;
    }

    fn push_core_msg(&mut self, task_id: u64, kind: MsgKind, content: String, title: Option<String>) -> u64 {
        let mid = self.next_id;
        self.next_id += 1;
        if let Some(t) = self.tasks.iter_mut().find(|t| t.id == task_id) {
            t.msgs.push(Msg {
                id: mid, author: "Fennec".into(), content, kind, time: now(),
                collapsed: true,
                meta: title.map(|title| MsgMeta {
                    duration: None, title: Some(title), add: None, del: None, path: None, size: None, verb: None, root: None,
                }),
            });
        }
        self.scroll_handle.scroll_to_bottom();
        mid
    }

    /// Fold one translated loop event into the task model. Every arm is keyed by
    /// the event's own task id: a run keeps reporting after the user clicks to
    /// another row, and its answer must land in the task it came from.
    fn apply_core(&mut self, ev: CoreEvent, cx: &mut Context<Self>) {
        match ev {
            CoreEvent::Started { task_id, sid } => {
                if let Some(t) = self.tasks.iter_mut().find(|t| t.id == task_id) {
                    t.core_sid = Some(sid);
                }
            }
            CoreEvent::Reasoning { task_id, text } => {
                self.clear_think_placeholder(task_id);
                self.push_core_msg(task_id, MsgKind::Think, text, None);
            }
            CoreEvent::Answer { task_id, text } => {
                self.clear_think_placeholder(task_id);
                self.push_core_msg(task_id, MsgKind::Result, text, None);
            }
            CoreEvent::Tool { task_id, id, title, detail, ok, output } => {
                self.clear_think_placeholder(task_id);
                match (ok, self.tools.get(&id).copied()) {
                    (None, _) => {
                        let mid = self.push_core_msg(task_id, MsgKind::Action, detail, Some(title));
                        self.tools.insert(id, (task_id, mid));
                    }
                    (Some(ok), Some((_, mid))) => {
                        self.tools.remove(&id);
                        if let Some(m) = self.msg_mut(task_id, mid) {
                            m.collapsed = true;
                            if !output.is_empty() { m.content = output; }
                            if let Some(meta) = m.meta.as_mut() {
                                meta.duration = Some(if ok { String::new() } else { "failed".into() });
                            }
                        }
                    }
                    // A result whose `tool_start` this window never saw (a run
                    // selected after a restart): show it closed, not running.
                    (Some(ok), None) => {
                        let mid = self.push_core_msg(task_id, MsgKind::Action, output, Some(title));
                        if let Some(m) = self.msg_mut(task_id, mid) {
                            if let Some(meta) = m.meta.as_mut() {
                                meta.duration = Some(if ok { String::new() } else { "failed".into() });
                            }
                        }
                    }
                }
            }
            CoreEvent::Deliver { task_id, name, path, verb, root } => {
                self.clear_think_placeholder(task_id);
                // One card per file: a run that rewrote the same file several
                // times delivered one file, and the card carries the last write's
                // words. Keyed on the path, because that is what the user opens.
                let existing = self.tasks.iter().find(|t| t.id == task_id)
                    .and_then(|t| t.msgs.iter().find(|m| {
                        m.kind == MsgKind::Attach
                            && m.meta.as_ref().is_some_and(|x| x.path.as_deref() == Some(path.as_str()))
                    }).map(|m| m.id));
                let mid = match existing {
                    Some(id) => id,
                    None => self.push_core_msg(task_id, MsgKind::Attach, String::new(), Some(name)),
                };
                if let Some(m) = self.msg_mut(task_id, mid) {
                    let meta = m.meta.get_or_insert(MsgMeta {
                        duration: None, title: None, add: None, del: None,
                        path: None, size: None, verb: None, root: None,
                    });
                    meta.verb = Some(verb.to_string());
                    meta.path = Some(path);
                    meta.root = Some(root);
                }
            }
            CoreEvent::Approval { task_id, approval } => {
                self.clear_think_placeholder(task_id);
                if let Some(t) = self.tasks.iter_mut().find(|t| t.id == task_id) {
                    match t.approvals.iter_mut().find(|a| a.id == approval.id) {
                        // One question, one card: a step that repeats an id
                        // updates the card rather than opening a second way to
                        // answer the same call.
                        Some(open) => { if open.resolved.is_none() && !open.expired { *open = approval; } }
                        None => t.approvals.push(approval),
                    }
                }
            }
            CoreEvent::Answered { task_id, approval_id, decision, error } => {
                // The loop no longer holds the question (a 404), so the answer
                // cannot land. Say which happened, not that an answer was sent.
                let said = match &error {
                    Some(e) => format!("Answer did not land: {e}"),
                    None => format!("Answer sent: {}", fennec_ui::attention::decision_label(&decision)),
                };
                let good = error.is_none();
                if let Some(t) = self.tasks.iter_mut().find(|t| t.id == task_id) {
                    if let Some(a) = t.approvals.iter_mut().find(|a| a.id == approval_id) {
                        match error {
                            Some(e) => { a.expired = true; a.note = e; }
                            None => a.resolved = Some(ApprovalResolution { choice_id: decision }),
                        }
                    }
                }
                self.toasts.push(Toast { text: said, good, at: std::time::Instant::now() });
            }
            CoreEvent::Pending { task_id, ids } => {
                let Some(t) = self.tasks.iter_mut().find(|t| t.id == task_id) else { return };
                for a in t.approvals.iter_mut() {
                    if a.resolved.is_none() && !a.expired && !ids.contains(&a.id) {
                        a.expired = true;
                        a.note = "the loop no longer holds this question".into();
                    }
                }
                // A run stopped on a question waits on the user, not on the
                // model. That is what the rail, the badge and the filter read.
                if matches!(t.status.as_str(), "Running" | "AwaitingApproval") {
                    t.status = if ids.is_empty() { "Running".into() } else { "AwaitingApproval".into() };
                }
            }
            CoreEvent::Status { task_id, status } => {
                self.clear_think_placeholder(task_id);
                let word = match status.as_str() {
                    "done" => "Complete",
                    "error" => "Failed",
                    "cancelled" => "Idle",
                    _ => "Running",
                };
                self.set_task_status(task_id, word);
                if word != "Running" {
                    if let Some(t) = self.tasks.iter_mut().find(|t| t.id == task_id) {
                        for a in t.approvals.iter_mut() {
                            if a.resolved.is_none() && !a.expired {
                                a.expired = true;
                                a.note = "the run ended before an answer arrived".into();
                            }
                        }
                    }
                    if !self.queued.is_empty() {
                        let next = self.queued.remove(0);
                        self.save();
                        self.dispatch(next, cx);
                    }
                }
            }
            CoreEvent::Refused { task_id, error } => {
                self.clear_think_placeholder(task_id);
                self.push_core_msg(task_id, MsgKind::Result,
                    format!("The agent loop refused this run: {error}"), None);
                self.set_task_status(task_id, "Failed");
            }
        }
        self.save();
        cx.notify();
    }
}

/// One loop step → what this shell shows. The words come from the table in
/// `fennec-ui`, so both gpui shells and the PWA name the same `run_shell` the
/// same way; only the envelope is this app's.
fn translate_step(tx: &std::sync::mpsc::Sender<BackendResponse>, task_id: u64, step: &serde_json::Value, root: &str) {
    use fennec_ui::attention::{args_line, clip, describe_call, path_of, risk_word};
    let args = step["args"].clone();
    let name = step["name"].as_str().unwrap_or("tool");
    let (category, title) = describe_call(name, &args);
    let call_id = step["call_id"].as_str().unwrap_or(name).to_string();
    match step["type"].as_str().unwrap_or("") {
        "assistant" => {
            let reasoning = step["reasoning"].as_str().unwrap_or("").trim();
            if !reasoning.is_empty() {
                let _ = tx.send(BackendResponse::Core(CoreEvent::Reasoning {
                    task_id, text: reasoning.to_string(),
                }));
            }
            let content = step["content"].as_str().unwrap_or("").trim();
            if !content.is_empty() {
                let _ = tx.send(BackendResponse::Core(CoreEvent::Answer {
                    task_id, text: content.to_string(),
                }));
            }
        }
        "tool_start" => {
            let _ = tx.send(BackendResponse::Core(CoreEvent::Tool {
                task_id, id: call_id, title: format!("{category} · {title}"),
                detail: args_line(&args), ok: None, output: String::new(),
            }));
        }
        "tool" => {
            let ok = step["ok"].as_bool().unwrap_or(false);
            let output = fennec_ui::attention::clip(&step["result"].to_string(), 4000);
            let _ = tx.send(BackendResponse::Core(CoreEvent::Tool {
                task_id, id: call_id, title: format!("{category} · {title}"),
                detail: args_line(&args), ok: Some(ok), output,
            }));
            // A write that succeeded put a file on disk: deliver it as its own
            // card, so the user gets the artifact and not just a tool row.
            if ok {
                if let (Some(verb), Some(path)) = (fennec_ui::attention::delivery_verb(name), path_of(&args)) {
                    let name = std::path::Path::new(&path).file_name()
                        .map(|n| n.to_string_lossy().to_string())
                        .unwrap_or_else(|| path.clone());
                    let _ = tx.send(BackendResponse::Core(CoreEvent::Deliver {
                        task_id, name, path, verb, root: root.to_string(),
                    }));
                }
            }
        }
        "approval_required" => {
            let id = step["approval_id"].as_str().unwrap_or("");
            // Same rule the desktop and the PWA apply: a question with no id
            // cannot be answered and one with no name cannot be acted on, so
            // neither becomes a card.
            if id.is_empty() || name.is_empty() { return; }
            let _ = tx.send(BackendResponse::Core(CoreEvent::Approval {
                task_id,
                approval: ApprovalRequest {
                    id: clip(id, 64),
                    action: name.to_string(),
                    risk_level: risk_word(step["risk"].as_str()),
                    command: Some(title.clone()),
                    resolved: None,
                    category,
                    reason: clip(step["reason"].as_str().unwrap_or(""), 400),
                    path: path_of(&args),
                    expired: false,
                    note: String::new(),
                },
            }));
        }
        _ => {}
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
        if let Some(text) = self.composer_restore.take() {
            self.composer.update(cx, |state, cx| state.set_value(text, _w, cx));
        }
        let t = cx.theme().clone();
        div().flex().flex_col().size_full().bg(t.background).text_color(t.foreground)
            .child(self.topbar(cx))
            .child(div().flex().flex_1().overflow_hidden()
                .child(self.left(cx))
                .child(self.center(cx))
                .children(self.inspector.then(|| self.right(cx))))
            .child(self.dropdowns(cx))
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
        let q_lower = query.to_lowercase();
        let attention = self.attention_count();
        let tasks = self.filtered_tasks(&query);
        div().w(px(260.0)).flex_shrink_0().bg(t.background).border_r_1().border_color(t.border).flex().flex_col().p_4().gap_3()
            // Navigation
            .child(div().flex().flex_col().gap_2()
                .child(Button::new("nav-new-task").label("⟳ New Task").w_full().h(px(36.0)).rounded_md()
                    .border_1().border_color(t.border)
                    .on_click(cx.listener(|a, _, _, cx| { a.new_task(); cx.notify(); })))
                .child(Button::new("nav-attention").w_full().h(px(36.0)).rounded_md()
                    .border_1().border_color(t.border)
                    .child(div().flex().items_center().gap_2()
                        .child(Label::new("▷ My Attention").text_size(px(13.0)))
                        .children(attention_badge(&t, attention)))
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
                    .on_click(cx.listener(|_a, _, window, cx| {
                        let weak = cx.entity().downgrade();
                        open_workspace_dialog(window, cx, move |name, folders, icon, color, indexed, cx| {
                            let _ = weak.update(cx, |a, cx| {
                                a.add_workspace(name, folders, icon, color, indexed);
                                cx.notify();
                            });
                        });
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
                        .filter(|task| self.task_shown(task, &q_lower))
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
                                .child(div().flex().items_center().justify_between().gap_1()
                                    .child(div().flex_1().overflow_hidden()
                                        .child(Label::new(title.as_str()).text_size(px(12.0)).truncate()))
                                    .child(div().flex().items_center().gap_1().flex_shrink_0()
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
            // My Attention: the commands the user already answered, click to jump.
            .children(self.attention_only.then(|| {
                let weak = cx.entity().downgrade();
                approved_commands_panel(&t, &self.approved_commands(), move |task_id, _window, cx| {
                    let Ok(id) = task_id.parse::<u64>() else { return };
                    let _ = weak.update(cx, |a, cx| {
                        a.select_task(id);
                        a.attention_only = false;
                        cx.notify();
                    });
                })
            }))
    }

    fn center(&mut self, cx: &mut Context<Self>) -> impl IntoElement {
        let t = cx.theme().clone();
        let tk = self.task();
        let is_working = self.working();
        let show_queue = is_working && !self.queued.is_empty();
        let ws = self.active_workspace();
        let ws_name = ws.map(|w| w.name.as_str()).unwrap_or("No workspace");
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
                            // Cancel means asking the loop to stop, not relabeling
                            // the row. A run this window never supervised only has
                            // its own status to change.
                            let task_id = a.active.unwrap_or(0);
                            a.stop_run(task_id);
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
        let weak = cx.entity().downgrade();
        let mut list = div().id("timeline-scroll").flex_1().track_scroll(&self.scroll_handle).overflow_y_scrollbar().px_5().py_3().flex().flex_col().gap_4();
        // Reasoning that precedes an answer is attached to that answer and
        // revealed by clicking the summary/header over the AI message.
        let mut thoughts_for: std::collections::HashMap<usize, (Vec<usize>, Vec<String>, bool)> = std::collections::HashMap::new();
        {
            let mut i = 0usize;
            while i < msgs.len() {
                if msgs[i].kind == MsgKind::Think {
                    let s = i;
                    let mut e = i;
                    while e < msgs.len() && msgs[e].kind == MsgKind::Think { e += 1; }
                    if e < msgs.len() && msgs[e].kind == MsgKind::Result {
                        let idxs: Vec<usize> = (s..e).collect();
                        let open = !msgs[s].collapsed;
                        let chunks: Vec<String> = msgs[s..e].iter().map(|p| p.content.clone()).collect();
                        thoughts_for.insert(e, (idxs, chunks, open));
                    }
                    i = e;
                } else {
                    i += 1;
                }
            }
        }
        // The calls folded into one block per run, drawn where the run happened.
        let folds = fold_calls(&msgs);
        // The newest run is the one the loop may still be inside, so it is the
        // block that opens on its own; once an answer lands, the next run is.
        let newest = folds.at.keys().max().copied();
        for (mi, m) in msgs.into_iter().enumerate() {
            let id = m.id;
            // A settled call renders as a row inside its run's block, not as a
            // card of its own. The call the run is still inside is not folded:
            // it stays a card the user can expand and watch.
            if let Some(b) = folds.at.get(&mi) {
                let key = b.id;
                let open = is_open(self.open_blocks.contains(&key), self.closed_blocks.contains(&key), newest == Some(mi));
                let wt = weak.clone();
                let on_toggle = move |_: &mut Window, cx: &mut gpui::App| {
                    let _ = wt.update(cx, |a, cx| {
                        a.toggle_block(key, open);
                        cx.notify();
                    });
                };
                // A hidden call still has to be readable, so every row prints
                // the whole call it stands for plus what it returned.
                let acts = b.acts.clone();
                let on_row = move |i: usize, window: &mut Window, cx: &mut gpui::App| {
                    if let Some((tt, tx)) = acts.get(i) {
                        show_output(tt, tx, window, cx);
                    }
                };
                let title = actions_title(b.rows.len());
                list = list.child(tool_group(&t, key, "⚙", &title, &b.rows, open, on_toggle, Some(on_row)));
            }
            if folds.hidden.contains(&mi) {
                continue;
            }
            match m.kind {
                MsgKind::User => {
                    // The user's own words sit on the right in a bubble: no
                    // avatar, no header, just the message.
                    list = list.child(user_bubble(&t, &m.content, id as usize));
                }
                MsgKind::Think => {
                    // If these thoughts belong to a following answer, render
                    // them there behind its summary toggle instead.
                    if thoughts_for.values().any(|(idxs, _, _)| idxs.contains(&mi)) {
                        continue;
                    }
                    let collapsed = m.collapsed;
                    let weak2 = weak.clone();
                    let header = ai_header(&t, id, &m.time, None::<fn(&mut Window, &mut gpui::App)>)
                        .child(Label::new("Thinking").text_size(px(10.5)).text_color(t.green))
                        .child(Label::new(if collapsed { "▸" } else { "▾" }).text_size(px(11.0)).text_color(t.muted_foreground))
                        .id(ElementId::NamedInteger("think-h".into(), id))
                        .cursor_pointer()
                        .on_click(move |_, _, cx| {
                            let _ = weak2.update(cx, |a, cx| { a.toggle(id); cx.notify(); });
                        });
                    let mut block = div().id(ElementId::NamedInteger("msg".into(), id))
                        .flex().flex_col().gap_1()
                        .child(header);
                    if !collapsed {
                        block = block.child(rich_div(&t, &m.content, true, id as usize));
                    }
                    list = list.child(block);
                }
                MsgKind::Action => {
                    let title = m.meta.as_ref().and_then(|x| x.title.clone()).unwrap_or_else(|| "Action".into());
                    let dur = m.meta.as_ref().and_then(|x| x.duration.clone());
                    let running = dur.is_none();
                    let dur = dur.unwrap_or_default();
                    let failed = dur == "failed";
                    let status_text = if running { "Running…".to_string() }
                        else if failed { "Failed".to_string() }
                        else if dur.is_empty() { "Complete".to_string() }
                        else { format!("Complete · {dur}") };
                    let status_color = if running { t.yellow } else if failed { t.red } else { t.green };
                    let collapsed = m.collapsed;
                    let weak2 = weak.clone();
                    // The running call keeps its short words in the header and
                    // prints the whole call in its body once opened.
                    let path = m.meta.as_ref().and_then(|x| x.path.clone()).unwrap_or_default();
                    let short = short_text(&path, &title);
                    let shown = reveal_text(&short, &title, &m.content);
                    list = list.child(action_card(&t, id, "🔍", &short, &shown, &status_text, status_color, !collapsed,
                        move |_, cx| {
                            let _ = weak2.update(cx, |a, cx| { a.toggle(id); cx.notify(); });
                        }));
                }
                MsgKind::Attach => {
                    // The delivered file's own card, next to the block holding
                    // the call that wrote it: the chip says which verb the run
                    // used, and a file the user attached has none to say.
                    let name = m.meta.as_ref().and_then(|x| x.title.clone()).unwrap_or_else(|| "file".into());
                    let path = m.meta.as_ref().and_then(|x| x.path.clone()).unwrap_or_default();
                    let verb = m.meta.as_ref().and_then(|x| x.verb.clone()).unwrap_or_default();
                    let subtitle = attachment_subtitle(&path, &name);
                    let open_path = absolute(&self.core_workspace(), &path);
                    let trailing = if verb.is_empty() { "…".to_string() } else { verb };
                    list = list.child(attachment_card(&t, id, &name, &subtitle, &trailing,
                        Some(move |_: &mut Window, _: &mut gpui::App| {
                            if !open_path.is_empty() {
                                fennec_ui::inspector::open_url(&open_path);
                            }
                        })));
                }
                MsgKind::Edit => {
                    // A write from a history file: folded into its action block
                    // above, so nothing renders here.
                }
                MsgKind::Result => {
                    let speak = m.content.clone();
                    let mut header = ai_header(&t, id, &m.time, Some(move |window: &mut Window, cx: &mut gpui::App| {
                        speak_tts(&speak, window, cx);
                    }));
                    let attached = thoughts_for.get(&mi).cloned();
                    let topen = attached.as_ref().map(|(_, _, o)| *o).unwrap_or(false);
                    if let Some((idxs, chunks, _)) = &attached {
                        let n = chunks.len();
                        let idxs = idxs.clone();
                        let weak_t = weak.clone();
                        header = header.child(
                            Button::new(ElementId::Name(format!("sum-tog-{id}").into()))
                                .ghost().xsmall()
                                .on_click(move |_, _, cx| {
                                    let _ = weak_t.update(cx, |a, cx| {
                                        if let Some(tk) = a.task_mut() {
                                            for ix in &idxs {
                                                if let Some(mm) = tk.msgs.get_mut(*ix) {
                                                    mm.collapsed = !mm.collapsed;
                                                }
                                            }
                                        }
                                        cx.notify();
                                    });
                                })
                                .child(Label::new(format!("{} Thoughts ({})", if topen { "▾" } else { "▸" }, n))
                                    .text_size(px(10.5)).text_color(t.green)),
                        );
                    }
                    let mut block = div().id(ElementId::NamedInteger("msg".into(), id))
                        .flex().flex_col().gap_1()
                        .child(header);
                    if topen {
                        if let Some((_, chunks, _)) = &attached {
                            let mut body = div().flex().flex_col().gap_1();
                            for (i, r) in chunks.iter().enumerate() {
                                body = body.child(rich_div(&t, r, true, id as usize * 100 + i));
                            }
                            block = block.child(body);
                        }
                    }
                    block = block.child(rich_div(&t, &m.content, false, id as usize));
                    list = list.child(block);
                }
            }
        }
        // A gated call the loop is stopped on, last in the timeline because it is
        // the one thing here that cannot move until the user does. The card comes
        // from `fennec-ui`, so the same question reads and answers identically in
        // the desktop shell and here.
        let task_id = self.active.unwrap_or(0);
        let approvals = self.task().map(|t| t.approvals.clone()).unwrap_or_default();
        for a in &approvals {
            let detail = a.command.clone().unwrap_or_else(|| a.action.clone());
            let state = match (&a.resolved, a.expired) {
                (Some(_), _) => CardState::Answered,
                (None, true) => CardState::Expired,
                (None, false) => CardState::Pending,
            };
            let shared = ApprovalCard {
                id: &a.id,
                category: &a.category,
                title: a.command.as_deref().unwrap_or(&a.action),
                risk: &a.risk_level,
                reason: &a.reason,
                path: a.path.as_deref(),
                detail: &detail,
                state,
                decision: a.resolved.as_ref().map(|r| r.choice_id.as_str()).unwrap_or(""),
                note: &a.note,
            };
            let weak2 = weak.clone();
            let approval_id = a.id.clone();
            list = list.child(approval_card(&t, &shared, move |decision, _window, cx| {
                let decision = decision.to_string();
                let _ = weak2.update(cx, |a, cx| {
                    a.answer(task_id, approval_id.clone(), decision);
                    cx.notify();
                });
            }));
        }
        list
    }

    fn queue(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let t = cx.theme().clone();
        if self.queued.is_empty() {
            return div().into_any_element();
        }
        let items = self.queued.clone();
        let weak = cx.entity().downgrade();
        queue_strip(&t, &items, move |window, cx| {
            if let Some(app) = weak.upgrade() {
                let n = app.read(cx).queued.len();
                window.push_notification(Notification::info(format!("{n} tasks in queue")), cx);
            }
        }).into_any_element()
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
        let weak = cx.entity().downgrade();
        let w_attach = weak.clone();
        let w_perm = weak.clone();
        let w_model = weak.clone();
        let w_mic = weak.clone();
        let w_send = weak;
        col
            .child(composer_dock(&t, &self.composer, "Ask Fennec to inspect, edit, test, or explain your code"))
            .child(composer_toolbar(
                &t,
                &fennec_ui::plugin::default_plugins(),
                self.access_icon(), self.access_label(), self.access_color(&t),
                &self.model_display_name(),
                self.stt_recording,
                send_enabled,
                move |_window, cx| { let _ = w_attach.update(cx, |a, cx| a.attach_file(cx)); },
                move |_window, cx| { let _ = w_perm.update(cx, |a, cx| {
                    a.perm_dropdown_open = !a.perm_dropdown_open;
                    a.model_dropdown_open = false;
                    cx.notify();
                }); },
                move |_window, cx| { let _ = w_model.update(cx, |a, cx| {
                    a.model_dropdown_open = !a.model_dropdown_open;
                    a.perm_dropdown_open = false;
                    cx.notify();
                }); },
                move |window, cx| { let _ = w_mic.update(cx, |a, cx| a.toggle_stt(window, cx)); },
                move |window, cx| { let _ = w_send.update(cx, |a, cx| a.send(window, cx)); },
            ))
    }

    /// Permission + model dropdowns rendered at the window root so they are not
    /// clipped by the centre pane's overflow_hidden.
    fn dropdowns(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let t = cx.theme().clone();
        let weak = cx.entity().downgrade();
        let mut overlay = div();
        if self.perm_dropdown_open {
            let w = weak.clone();
            overlay = overlay.child(fennec_ui::controls::permission_dropdown(
                &t,
                &self.access_mode,
                move |mode, _window, cx| {
                    let _ = w.update(cx, |a, cx| {
                        a.set_access_mode(&mode);
                        a.perm_dropdown_open = false;
                        cx.notify();
                    });
                },
            ));
        }
        if self.model_dropdown_open {
            let w_sel = weak.clone();
            let w_dl = weak;
            overlay = overlay.child(fennec_ui::controls::model_dropdown(
                &t,
                &self.model,
                move |model, _window, cx| {
                    let _ = w_sel.update(cx, |a, cx| {
                        a.model = model;
                        a.model_dropdown_open = false;
                        a.save_settings();
                        cx.notify();
                    });
                },
                move |window, cx| {
                    window.push_notification(Notification::info("Model download coming soon."), cx);
                    let _ = w_dl.update(cx, |a, cx| {
                        a.model_dropdown_open = false;
                        cx.notify();
                    });
                },
            ));
        }
        overlay
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

        // Inspectable items for the right panel, collected from the task msgs.
        use fennec_ui::inspector::{InspectItem, InspectSection, inspect_section};
        let msgs = self.task().map(|tk| tk.msgs.clone()).unwrap_or_default();
        let mut links: Vec<String> = Vec::new();
        for m in &msgs {
            for l in fennec_ui::inspector::extract_links(&m.content) {
                if !links.contains(&l) { links.push(l); }
            }
        }
        let sub_items: Vec<InspectItem> = self.agents.iter().skip(1).enumerate().map(|(i, a)| InspectItem { id: format!("{i}"), title: a.clone(), subtitle: "delegated agent".into(), detail: String::new(), url: None }).collect();
        let proc_items: Vec<InspectItem> = msgs.iter().filter(|m| m.kind == MsgKind::Action).enumerate().map(|(i, m)| InspectItem { id: format!("{i}"), title: m.meta.as_ref().and_then(|x| x.title.clone()).unwrap_or_else(|| "Action".into()), subtitle: m.meta.as_ref().and_then(|x| x.duration.clone()).map(|d| if d.is_empty() { "complete".into() } else { d }).unwrap_or_else(|| "running".into()), detail: m.content.clone(), url: None }).collect();
        let skill_items: Vec<InspectItem> = skills.iter().enumerate().map(|(i, s)| InspectItem { id: format!("{i}"), title: s.clone(), subtitle: "tool kind".into(), detail: String::new(), url: None }).collect();
        let art_items: Vec<InspectItem> = msgs.iter().filter(|m| m.kind == MsgKind::Attach || m.kind == MsgKind::Edit).enumerate().map(|(i, m)| InspectItem { id: format!("{i}"), title: m.meta.as_ref().and_then(|x| x.title.clone()).unwrap_or_else(|| "file".into()), subtitle: m.meta.as_ref().and_then(|x| x.path.clone()).unwrap_or_default(), detail: m.content.clone(), url: None }).collect();
        let web_items: Vec<InspectItem> = links.iter().enumerate().map(|(i, l)| InspectItem { id: format!("{i}"), title: l.clone(), subtitle: "linked reading".into(), detail: String::new(), url: Some(l.clone()) }).collect();
        let src_items: Vec<InspectItem> = sources.iter().enumerate().map(|(i, s)| InspectItem { id: format!("{i}"), title: s.clone(), subtitle: "file inspected".into(), detail: String::new(), url: None }).collect();

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
            .child(inspect_section(&t, InspectSection { id: "subagents", icon: "👥", label: "Subagents", empty: "No delegated agents", items: sub_items }))
            .child(inspect_section(&t, InspectSection { id: "processes", icon: "📡", label: "Processes", empty: "No commands run", items: proc_items }))
            .child(inspect_section(&t, InspectSection { id: "skills", icon: "⚡", label: "Skills", empty: "Repository inspection", items: skill_items }))
            .child(inspect_section(&t, InspectSection { id: "artifacts", icon: "📦", label: "Artifacts", empty: "No task artifacts", items: art_items }))
            .child(inspect_section(&t, InspectSection { id: "web", icon: "🌐", label: "Web Readings", empty: "No linked readings", items: web_items }))
            .child(inspect_section(&t, InspectSection { id: "sources", icon: "🔗", label: "Sources", empty: "No task sources", items: src_items }))
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
