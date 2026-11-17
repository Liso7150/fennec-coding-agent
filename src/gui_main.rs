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
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

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
}

#[derive(Serialize, Deserialize)]
struct History {
    tasks: Vec<Task>,
    active: Option<u64>,
    #[serde(default)]
    queued: Vec<String>,
}

#[derive(Serialize, Deserialize, Default)]
struct Settings { server_url: Option<String> }

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

        let server_url = load_settings(&settings_path);

        let app = Self {
            tasks: vec![], active: None, queued: vec![], inspector: true,
            attention_only: false, search_open: false, search, composer,
            server_url, settings_path, backend_ok: false, agents: vec![],
            path, next_id: 1, response_rx: rx, response_tx: tx,
            pending_think: None, pending_content: None, tools: std::collections::HashMap::new(),
            _task,
        };
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
        let s = Settings { server_url: Some(self.server_url.clone()) };
        if let Ok(s) = serde_json::to_string_pretty(&s) {
            let _ = std::fs::write(&self.settings_path, s);
        }
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
                            (tid, mid)
                        }
                    };
                    if let Some(m) = self.msg_mut(tid, mid) {
                        m.content.push_str(&text);
                    }
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
            self.tasks.push(Task { id, title: "New task".into(), status: "Running".into(), repo: "Liso7150/fennec".into(), msgs: vec![], backend_id: None, started_at: None });
            self.active = Some(id);
        }
    }

    fn add_msg(&mut self, m: Msg, cx: &mut Context<Self>) {
        self.ensure_task();
        if let Some(t) = self.task_mut() { t.msgs.push(m); }
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
        self.tasks.push(Task { id, title: "New task".into(), status: "Idle".into(), repo: "Liso7150/fennec".into(), msgs: vec![], backend_id: None, started_at: None });
        self.active = Some(id);
        self.attention_only = false;
        self.save();
    }

    fn select_task(&mut self, id: u64) {
        self.active = Some(id);
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

    fn filtered_tasks(&self, query: &str) -> Vec<&Task> {
        let q = query.to_lowercase();
        self.tasks.iter()
            .filter(|t| !self.attention_only || t.status == "Running" || t.status == "Failed")
            .filter(|t| q.is_empty() || t.title.to_lowercase().contains(&q) || t.repo.to_lowercase().contains(&q))
            .rev()
            .collect()
    }

    fn clear_queue(&mut self) {
        self.queued.clear();
        self.save();
    }

    fn remove_from_queue(&mut self, idx: usize) {
        if idx < self.queued.len() {
            self.queued.remove(idx);
            self.save();
        }
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

fn load_settings(settings_path: &Path) -> String {
    std::fs::read_to_string(settings_path).ok()
        .and_then(|s| serde_json::from_str::<Settings>(&s).ok())
        .and_then(|s| s.server_url)
        .unwrap_or_else(|| {
            std::env::var("FENNEC_AGENT_URL").unwrap_or_else(|_| "http://127.0.0.1:8787".into())
        })
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
                .child(Label::new("Fennec").text_size(px(16.0)).font_weight(FontWeight::BOLD))
                .child(Label::new("Liso7150 / local-first workspace").text_size(px(13.0)).text_color(t.muted_foreground)))
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
        let attention = self.attention_count();
        div().w(px(250.0)).flex_shrink_0().bg(t.background).border_r_1().border_color(t.border).flex().flex_col().p_3().gap_3()
            .child(div().p_3().rounded_md().border_1().border_color(t.border)
                .child(Label::new("ACTIVE WORKSPACE").text_size(px(10.0)).text_color(t.muted_foreground))
                .child(Label::new("Liso7150/fennec").text_size(px(14.0)).font_weight(FontWeight::SEMIBOLD))
                .child(Label::new("main · Local mode").text_size(px(11.0)).text_color(t.muted_foreground)))
            .child(div().flex().flex_col().gap_1()
                .child(self.nav("Coding", true, cx))
                .child(self.nav("New Task", false, cx))
                .child(Button::new("nav-attention").label(format!("My Attention{}", if attention > 0 { format!(" · {attention}") } else { String::new() })).ghost().small()
                    .when(self.attention_only, |b| b.bg(t.muted))
                    .on_click(cx.listener(|a, _, _, cx| { a.attention_only = !a.attention_only; cx.notify(); })))
                .child(Button::new("nav-search").label("Search").ghost().small()
                    .when(self.search_open, |b| b.bg(t.muted))
                    .on_click(cx.listener(|a, _, _, cx| { a.search_open = !a.search_open; cx.notify(); }))))
            .children(self.search_open.then(|| {
                let t = t.clone();
                div().id("search-dock").child(Input::new(&self.search).h(px(28.0)).text_size(px(12.0)))
                    .child(Label::new(if query.is_empty() { String::new() } else { format!("{} tasks", tasks.len()) }).text_size(px(10.0)).text_color(t.muted_foreground))
            }))
            .child(div().flex().flex_col().gap_1().overflow_y_scrollbar()
                .child(Label::new("RECENT TASKS").text_size(px(10.0)).text_color(t.muted_foreground))
                .children(tasks.iter().take(8).map(|tk| {
                    let t = t.clone();
                    let id = tk.id;
                    let title = tk.title.clone();
                    let status = tk.status.clone();
                    let repo = tk.repo.clone();
                    let is_active = self.active == Some(id);
                    div().id(ElementId::NamedInteger("task-item".into(), id))
                        .p_2().rounded_md().cursor_pointer()
                        .when(is_active, |d| d.bg(t.muted))
                        .hover(|d| d.bg(t.muted))
                        .on_click(cx.listener(move |a, _, _, cx| { a.select_task(id); cx.notify(); }))
                        .child(Label::new(title).text_size(px(13.0)).font_weight(FontWeight::MEDIUM).truncate())
                        .child(div().flex().items_center().gap_1().mt_1()
                            .child(div().w(px(6.0)).h(px(6.0)).rounded_full().bg(dot_color(&status, t.green, t.blue, t.red, t.yellow)))
                            .child(Label::new(status).text_size(px(11.0)).text_color(t.muted_foreground))
                            .child(Label::new("·").text_size(px(11.0)))
                            .child(Label::new(repo).text_size(px(11.0)).text_color(t.muted_foreground).truncate()))
                })))
            .child(div().mt_auto().pt_3().border_t_1().border_color(t.border)
                .child(Label::new("Liso7150").text_size(px(13.0)).font_weight(FontWeight::SEMIBOLD))
                .child(Label::new("Local account").text_size(px(11.0)).text_color(t.muted_foreground)))
    }

    fn nav(&self, label: &str, active: bool, cx: &mut Context<Self>) -> impl IntoElement {
        let t = cx.theme().clone();
        let id = label.to_string();
        let listener_label = label.to_string();
        Button::new(id).label(label).ghost().small().when(active, |b| b.bg(t.muted))
            .on_click(cx.listener(move |a, _, _, cx| {
                match listener_label.as_str() {
                    "Coding" => { a.attention_only = false; a.search_open = false; }
                    "New Task" => { a.new_task(); }
                    _ => {}
                }
                cx.notify();
            }))
    }

    fn center(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let t = cx.theme().clone();
        let tk = self.task();
        let show_queue = self.working() && !self.queued.is_empty();
        div().flex().flex_col().flex_1().overflow_hidden()
            .child(div().flex().items_start().justify_between().px_5().pt_4().pb_3().border_b_1().border_color(t.border)
                .child(div().flex().flex_col().gap_1()
                    .child(Label::new("Liso7150/fennec · main").text_size(px(12.0)).text_color(t.muted_foreground))
                    .child(Label::new(tk.map(|t| t.title.as_str()).unwrap_or("No active task")).text_size(px(20.0)).font_weight(FontWeight::BOLD))
                    .child(Label::new("Chronological local-agent activity and verification.").text_size(px(12.0)).text_color(t.muted_foreground)))
                .children(tk.map(|tk| {
                    let t = t.clone();
                    let status = tk.status.clone();
                    div().flex().items_center().gap_1().px_3().py_1().rounded_full().border_1().border_color(t.border)
                        .child(div().w(px(7.0)).h(px(7.0)).rounded_full().bg(dot_color(&status, t.green, t.blue, t.red, t.yellow)))
                        .child(Label::new(status).text_size(px(12.0)))
                })))
            .child(self.timeline(cx))
            .children(show_queue.then(|| self.queue(cx)))
            .child(self.composer(cx))
    }

    fn timeline(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let t = cx.theme().clone();
        let msgs = self.task().map(|t| t.msgs.clone()).unwrap_or_default();
        div().flex_1().overflow_y_scrollbar().px_5().py_3().flex().flex_col().gap_4()
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
                            .child(Label::new(&m.content).text_size(px(13.0))))
                }
            }))
    }

    fn avatar(&self, letter: &str, bg: Hsla) -> impl IntoElement {
        div().w(px(28.0)).h(px(28.0)).rounded_full().bg(bg).flex().items_center().justify_center().flex_shrink_0()
            .child(Label::new(letter).text_size(px(12.0)).text_color(Hsla::white()))
    }

    fn queue(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let t = cx.theme().clone();
        let queued: Vec<(usize, String)> = self.queued.iter().enumerate().map(|(i, q)| (i, q.clone())).collect();
        div().border_t_1().border_color(t.border).bg(t.background).px_5().py_2()
            .child(div().flex().items_center().justify_between()
                .child(div().flex().items_center().gap_2()
                    .child(Label::new("Task queue").font_weight(FontWeight::SEMIBOLD))
                    .child(Label::new(format!("{} items", self.queued.len())).text_size(px(12.0)).text_color(t.muted_foreground)))
                .child(Button::new("clearq").label("Clear").ghost().small()
                    .on_click(cx.listener(|a, _, _, cx| { a.clear_queue(); cx.notify(); }))))
            .child(div().flex().flex_col()
                .children(queued.into_iter().map(|(idx, q)| {
                    div().id(ElementId::NamedInteger("queue-item".into(), idx as u64)).flex().items_center().justify_between().py_1()
                        .child(div().flex().items_center().gap_2()
                            .child(div().w(px(6.0)).h(px(6.0)).rounded_full().bg(t.yellow))
                            .child(Label::new(q).text_size(px(13.0)).truncate()))
                        .child(Button::new(ElementId::NamedInteger("rm".into(), idx as u64)).label("×").ghost().xsmall()
                            .on_click(cx.listener(move |a, _, _, cx| { a.remove_from_queue(idx); cx.notify(); })))
                })))
    }

    fn composer(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let t = cx.theme().clone();
        let send_enabled = !self.composer.read(cx).value().trim().is_empty();
        div().border_t_1().border_color(t.border).bg(t.background).px_5().py_3().flex().flex_col().gap_2()
            // gpui-base inputs all render element id "input-state"; this id-bearing
            // parent keeps their a11y node ids distinct when a UIA client connects.
        .child(div().id("composer-dock").rounded_md().border_1().border_color(t.border).p_3().child(Input::new(&self.composer)))
            .child(div().flex().items_center().justify_between()
                .child(div().flex().items_center().gap_2()
                    .child(Button::new("add").label("+").ghost().small()
                        .on_click(cx.listener(|a, _, _, cx| { a.new_task(); cx.notify(); })))
                    .child(Button::new("attach").label("📎").ghost().small()
                        .on_click(cx.listener(|a, _, _, cx| { a.attach_file(cx); })))
                    .child(Button::new("mic").label("🎤").ghost().small()
                        .on_click(cx.listener(|_, _, window, cx| {
                            window.push_notification(Notification::info("Dictation needs audio capture, which is not wired up in this build. Type or paste text instead."), cx);
                        })))
                    .child(Label::new("Hold to dictate").text_size(px(12.0)).text_color(t.muted_foreground)))
                .child(Button::new("send").label("Send").primary()
                    .when(!send_enabled, |b| b.disabled(true))
                    .on_click(cx.listener(|a, _, window, cx| { a.send(window, cx); }))))
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
        let url_input = cx.new(|cx| {
            let mut s = InputState::new(window, cx);
            s.set_value(self.server_url.clone(), window, cx);
            s
        });
        let weak = cx.entity().downgrade();
        window.open_dialog(cx, move |dialog, _, _| {
            let url_input = url_input.clone();
            let weak = weak.clone();
            dialog
                .title("Settings")
                .content({
                    let url_input = url_input.clone();
                    move |content, _, cx| {
                        content
                            .child(Label::new("Server URL").font_weight(FontWeight::MEDIUM))
                            .child(div().id("settings-url-dock").mt_1().child(Input::new(&url_input)))
                            .child(Label::new("Backend for tasks, streaming events and agents. Default: http://127.0.0.1:8787").text_size(px(11.0)).text_color(cx.theme().muted_foreground).mt_1())
                    }
                })
                .footer(div().flex().justify_end().gap_2().p_3()
                    .child(Button::new("settings-cancel").label("Cancel").ghost()
                        .on_click(|_, window, cx| { window.close_dialog(cx); }))
                    .child(Button::new("settings-connect").label("Connect").primary()
                        .on_click({
                            let url_input = url_input.clone();
                            let weak = weak.clone();
                            move |_, window, cx| {
                                let url = url_input.read(cx).value().trim().to_string();
                                let _ = weak.update(cx, |a, cx| {
                                    if !url.is_empty() {
                                        a.server_url = url;
                                        a.save_settings();
                                        a.fetch_backend_info();
                                    }
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
                .child(Label::new("Workspace context").font_weight(FontWeight::SEMIBOLD))
                .child(Label::new("Inspector").text_size(px(12.0)).text_color(t.muted_foreground)))
            .child(div().px_4().py_3().border_b_1().border_color(t.border)
                .child(div().flex().items_center().justify_between()
                    .child(Label::new("ACTIVE AGENTS").text_size(px(10.0)).text_color(t.muted_foreground))
                    .child(Label::new(if working { "1 online" } else { "0 online" }).text_size(px(10.0)).text_color(t.muted_foreground)))
                .children(working.then(|| {
                    let t = t.clone();
                    div().mt_2().p_2().rounded_md().border_1().border_color(t.border)
                        .child(div().flex().items_center().gap_2()
                            .child(Label::new("🤖"))
                            .child(div().flex().flex_col().overflow_hidden()
                                .child(Label::new("Fennec").font_weight(FontWeight::MEDIUM))
                                .child(Label::new(task_title).text_size(px(11.0)).text_color(t.muted_foreground).truncate())
                                .child(Label::new(format!("Running · {elapsed}")).text_size(px(11.0)).text_color(t.green))))
                })))
            .child(div().px_4().py_3().border_b_1().border_color(t.border)
                .child(Label::new("WORKSPACE CONTEXT").text_size(px(10.0)).text_color(t.muted_foreground))
                .child(self.ctx_row("👥", "Subagents", if subagents > 0 { format!("{subagents} delegated agents") } else { "No delegated agents".into() }, cx))
                .child(self.ctx_row("📡", "Processes", format!("{msg_count} messages · stream {}", if working { "active" } else { "idle" }), cx))
                .child(self.ctx_row("⚡", "Skills", skills_value, cx))
                .child(self.ctx_row("📦", "Artifacts", if artifacts > 0 { format!("{artifacts} task artifacts") } else { "No task artifacts".into() }, cx))
                .child(self.ctx_row("🌐", "Web Readings", if readings > 0 { format!("{readings} linked readings") } else { "No linked readings".into() }, cx))
                .child(self.ctx_row("🔗", "Sources", sources_value, cx)))
            .child(div().px_4().py_3().border_b_1().border_color(t.border)
                .child(Label::new("ENVIRONMENT").text_size(px(10.0)).text_color(t.muted_foreground))
                .child(self.row("Repository", "fennec", cx))
                .child(self.row("Branch", "main", cx))
                .child(self.row("Backend", if self.backend_ok { "Connected" } else { "Offline" }, cx)))
    }

    fn ctx_row(&self, icon: &str, label: &str, value: String, cx: &mut Context<Self>) -> impl IntoElement {
        let t = cx.theme().clone();
        div().id(ElementId::Name(label.to_string().into())).flex().items_center().gap_2().mt_2()
            .child(Label::new(icon))
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

    application().with_assets(assets::Assets).run(|cx| {
        init(cx);
        Theme::change(ThemeMode::Dark, None, cx);
        let bounds = Bounds::centered(None, size(px(1400.0), px(900.0)), cx);
        cx.open_window(WindowOptions { window_bounds: Some(WindowBounds::Windowed(bounds)), ..Default::default() }, |window, cx| {
            let composer = cx.new(|cx| InputState::new(window, cx));
            let search = cx.new(|cx| InputState::new(window, cx));
            let view = cx.new(|cx| {
                let mut app = App::new(path, settings_path, composer, search, window, cx);
                app.load();
                app
            });
            cx.new(|cx| Root::new(view, window, cx))
        }).expect("Failed to open window");
    });
}
