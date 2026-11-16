use fennec_client::coding_agent::CodingAgentClient;

use gpui_kit::component::{
    ActiveTheme, Sizable,
    button::{Button, ButtonVariants},
    input::{Input, InputState},
    label::Label,
    scroll::ScrollableElement,
};
use gpui_kit::prelude::*;
use gpui_kit::*;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

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

#[derive(Clone, Serialize, Deserialize, Debug)]
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
struct History { tasks: Vec<Task>, active: Option<u64> }

struct App {
    tasks: Vec<Task>,
    active: Option<u64>,
    queued: Vec<String>,
    inspector: bool,
    composer: Entity<InputState>,
    path: PathBuf,
    next_id: u64,
    response_rx: std::sync::mpsc::Receiver<BackendResponse>,
    response_tx: std::sync::mpsc::Sender<BackendResponse>,
    pending_think_id: Option<u64>,
    pending_backend_id: Option<String>,
    _task: gpui_kit::Task<()>,
}

#[derive(Debug)]
enum BackendResponse {
    Offline,
    Error(String),
    TaskCreated { backend_id: String },
    Messages(Vec<(String, String)>),
    Complete(String),
    Failed(String),
}
impl App {
    fn new(path: PathBuf, composer: Entity<InputState>, cx: &mut Context<Self>) -> Self {
        let (tx, rx) = std::sync::mpsc::channel();

        let weak = cx.entity().downgrade();
        let _task = cx.spawn(async move |_, cx: &mut AsyncApp| {
            loop {
                cx.background_executor().timer(std::time::Duration::from_millis(50)).await;
                if weak.update(cx, |a, cx| { a.poll_responses(cx); }).is_err() {
                    break;
                }
            }
        });

        Self { tasks: vec![], active: None, queued: vec![], inspector: true, composer, path, next_id: 1, response_rx: rx, response_tx: tx, pending_think_id: None, pending_backend_id: None, _task }
    }

    fn load(&mut self) {
        if let Ok(s) = std::fs::read_to_string(&self.path) {
            if let Ok(h) = serde_json::from_str::<History>(&s) {
                self.tasks = h.tasks;
                self.active = h.active;
                self.next_id = self.tasks.iter().map(|t| t.id).max().unwrap_or(0) + 1;
            }
        }
    }

    fn save(&self) {
        let h = History { tasks: self.tasks.clone(), active: self.active };
        if let Ok(s) = serde_json::to_string_pretty(&h) {
            let _ = std::fs::write(&self.path, s);
        }
    }

    fn poll_responses(&mut self, cx: &mut Context<Self>) {
        while let Ok(resp) = self.response_rx.try_recv() {
            match resp {
                BackendResponse::Offline => {
                    let tid = self.pending_think_id;
                    if let Some(t) = self.task_mut() {
                        if let Some(tid) = tid {
                            if let Some(m) = t.msgs.iter_mut().find(|m| m.id == tid) {
                                m.content = "Backend offline — start `fennec-agent` on :8787.".into();
                                m.kind = MsgKind::Result;
                            }
                        }
                        t.status = "Failed".into();
                    }
                    self.pending_think_id = None;
                }
                BackendResponse::Error(e) => {
                    let tid = self.pending_think_id;
                    if let Some(t) = self.task_mut() {
                        if let Some(tid) = tid {
                            if let Some(m) = t.msgs.iter_mut().find(|m| m.id == tid) {
                                m.content = format!("Backend error: {e}");
                                m.kind = MsgKind::Result;
                            }
                        }
                        t.status = "Failed".into();
                    }
                    self.pending_think_id = None;
                }
                BackendResponse::TaskCreated { backend_id } => {
                    self.pending_backend_id = Some(backend_id);
                }
                BackendResponse::Messages(msgs) => {
                    let tid = self.pending_think_id;
                    let mut new_msgs = Vec::new();
                    for (_role, content) in msgs {
                        let id = self.next_id;
                        self.next_id += 1;
                        new_msgs.push(Msg {
                            id, author: "Fennec".into(), content,
                            kind: MsgKind::Result, time: now(),
                            collapsed: false, meta: None,
                        });
                    }
                    if let Some(t) = self.task_mut() {
                        if let Some(tid) = tid {
                            t.msgs.retain(|m| m.id != tid);
                        }
                        t.msgs.extend(new_msgs);
                    }
                }
                BackendResponse::Complete(status) => {
                    if let Some(t) = self.task_mut() {
                        t.status = status;
                    }
                    self.pending_think_id = None;
                    self.pending_backend_id = None;
                }
                BackendResponse::Failed(e) => {
                    let tid = self.pending_think_id;
                    if let Some(t) = self.task_mut() {
                        if let Some(tid) = tid {
                            if let Some(m) = t.msgs.iter_mut().find(|m| m.id == tid) {
                                m.content = format!("Send failed: {e}");
                                m.kind = MsgKind::Result;
                            }
                        }
                        t.status = "Failed".into();
                    }
                    self.pending_think_id = None;
                    self.pending_backend_id = None;
                }
            }
            self.save();
            cx.notify();
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

    fn add_msg(&mut self, m: Msg) {
        self.ensure_task();
        if let Some(t) = self.task_mut() { t.msgs.push(m); }
        self.save();
    }

    fn toggle(&mut self, id: u64) {
        if let Some(t) = self.task_mut() {
            if let Some(m) = t.msgs.iter_mut().find(|m| m.id == id) { m.collapsed = !m.collapsed; }
        }
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

    fn queue_count(&self) -> usize { self.queued.len() }

    fn remove_from_queue(&mut self, idx: usize) {
        if idx < self.queued.len() {
            self.queued.remove(idx);
            self.save();
        }
    }

    fn send(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let text = self.composer.read(cx).value().trim().to_string();
        if text.is_empty() { return; }
        self.composer.update(cx, |i, cx| i.set_value("", window, cx));

        if self.working() {
            self.queued.push(text);
            self.save();
            return;
        }

        self.queued.clear();
        self.ensure_task();
        if let Some(t) = self.task_mut() {
            t.title = text.clone();
            t.status = "Running".into();
            t.started_at = Some(chrono::Utc::now().timestamp());
        }

        let id = self.next_id; self.next_id += 1;
        self.add_msg(Msg { id, author: "Liso7150".into(), content: text.clone(), kind: MsgKind::User, time: now(), collapsed: false, meta: None });

        // Add a thinking indicator
        let think_id = self.next_id; self.next_id += 1;
        self.add_msg(Msg { id: think_id, author: "Fennec".into(), content: "Connecting to engine…".into(), kind: MsgKind::Think, time: now(), collapsed: true, meta: None });

        self.pending_think_id = Some(think_id);
        self.save();
        cx.notify();

        // Spawn a background thread to handle the backend communication
        let prompt = text.clone();
        let tx = self.response_tx.clone();
        std::thread::spawn(move || {
            let client = CodingAgentClient::new();

            // Check backend health
            if client.health().is_none() {
                let _ = tx.send(BackendResponse::Offline);
                return;
            }

            // Create task on backend
            let agent_task = match client.create_task(&prompt, Some(&prompt), "local", None) {
                Ok(t) => t,
                Err(e) => {
                    let _ = tx.send(BackendResponse::Error(e));
                    return;
                }
            };

            let bt_id = agent_task.id.clone();
            let _ = tx.send(BackendResponse::TaskCreated { backend_id: bt_id.clone() });

            // Start the task
            if let Err(e) = client.start_task(&bt_id) {
                let _ = tx.send(BackendResponse::Error(e));
                return;
            }

            // Send the message
            match client.send_message(&bt_id, &prompt) {
                Ok(_msg) => {
                    // Poll task for completion
                    let mut attempts = 0;
                    loop {
                        if let Some(task) = client.get_task(&bt_id) {
                            if task.status == "Complete" || task.status == "Failed" || attempts > 60 {
                                // Collect messages
                                let messages: Vec<(String, String)> = task.messages.iter()
                                    .filter(|bm| bm.role == "Fennec" || bm.role == "fennec")
                                    .filter_map(|bm| {
                                        let content = bm.content.as_text();
                                        if !content.is_empty() { Some((bm.role.clone(), content)) } else { None }
                                    })
                                    .collect();

                                let _ = tx.send(BackendResponse::Messages(messages));
                                let _ = tx.send(BackendResponse::Complete(task.status));
                                break;
                            }
                        }
                        std::thread::sleep(std::time::Duration::from_millis(500));
                        attempts += 1;
                    }
                }
                Err(e) => {
                    let _ = tx.send(BackendResponse::Failed(e));
                }
            }
        });
    }
}

fn now() -> String { chrono::Local::now().format("%H:%M").to_string() }

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
        div().flex().items_center().justify_between().px_4().py_2().bg(t.background).border_b_1().border_color(t.border)
            .child(div().flex().items_center().gap_3()
                .child(Label::new("Fennec").text_size(px(16.0)).font_weight(FontWeight::BOLD))
                .child(Label::new("Liso7150 / local-first workspace").text_size(px(13.0)).text_color(t.muted_foreground)))
            .child(div().flex().items_center().gap_3()
                .child(div().flex().items_center().gap_1()
                    .child(div().w(px(7.0)).h(px(7.0)).rounded_full().bg(t.green))
                    .child(Label::new("Backend connected").text_size(px(12.0)).text_color(t.green)))
                .child(Button::new("settings").label("⚙").ghost().xsmall())
                .child(Button::new("inspector").label(if self.inspector { "◧" } else { "◨" }).ghost().xsmall()
                    .on_click(cx.listener(|a, _, _, cx| { a.inspector = !a.inspector; cx.notify(); }))))
    }

    fn left(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let t = cx.theme().clone();
        div().w(px(250.0)).flex_shrink_0().bg(t.background).border_r_1().border_color(t.border).flex().flex_col().p_3().gap_3()
            .child(div().p_3().rounded_md().border_1().border_color(t.border)
                .child(Label::new("ACTIVE WORKSPACE").text_size(px(10.0)).text_color(t.muted_foreground))
                .child(Label::new("Liso7150/fennec").text_size(px(14.0)).font_weight(FontWeight::SEMIBOLD))
                .child(Label::new("⌥ main · Local mode").text_size(px(11.0)).text_color(t.muted_foreground)))
            .child(div().flex().flex_col().gap_1()
                .child(self.nav("Coding", true, cx))
                .child(self.nav("New Task", false, cx))
                .child(self.nav("My Attention", false, cx))
                .child(self.nav("Search", false, cx)))
            .child(div().flex().flex_col().gap_1()
                .child(Label::new("RECENT TASKS").text_size(px(10.0)).text_color(t.muted_foreground))
                .children(self.tasks.iter().take(5).map(|tk| {
                    let t = t.clone();
                    div().p_2().rounded_md()
                        .child(Label::new(&tk.title).text_size(px(13.0)).font_weight(FontWeight::MEDIUM))
                        .child(div().flex().items_center().gap_1().mt_1()
                            .child(div().w(px(6.0)).h(px(6.0)).rounded_full().bg(if tk.status == "Running" { t.blue } else if tk.status == "Complete" { t.green } else { t.yellow }))
                            .child(Label::new(&tk.status).text_size(px(11.0)).text_color(t.muted_foreground))
                            .child(Label::new("·").text_size(px(11.0)))
                            .child(Label::new(&tk.repo).text_size(px(11.0)).text_color(t.muted_foreground)))
                })))
            .child(div().mt_auto().pt_3().border_t_1().border_color(t.border)
                .child(Label::new("Liso7150").text_size(px(13.0)).font_weight(FontWeight::SEMIBOLD))
                .child(Label::new("Local account").text_size(px(11.0)).text_color(t.muted_foreground)))
    }

    fn nav(&self, label: &str, active: bool, cx: &mut Context<Self>) -> impl IntoElement {
        let t = cx.theme().clone();
        let id = label.to_string();
        Button::new(id).label(label).ghost().small().when(active, |b| b.bg(t.muted))
    }

    fn center(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let t = cx.theme().clone();
        let tk = self.task();
        div().flex().flex_col().flex_1().overflow_hidden()
            .child(div().flex().items_start().justify_between().px_5().pt_4().pb_3().border_b_1().border_color(t.border)
                .child(div().flex().flex_col().gap_1()
                    .child(Label::new("Liso7150/fennec · main").text_size(px(12.0)).text_color(t.muted_foreground))
                    .child(Label::new(tk.map(|t| t.title.as_str()).unwrap_or("No active task")).text_size(px(20.0)).font_weight(FontWeight::BOLD))
                    .child(Label::new("Chronological local-agent activity and verification.").text_size(px(12.0)).text_color(t.muted_foreground)))
                .children(tk.map(|tk| {
                    let t = t.clone();
                    div().flex().items_center().gap_1().px_3().py_1().rounded_full().border_1().border_color(t.border)
                        .child(div().w(px(7.0)).h(px(7.0)).rounded_full().bg(if tk.status == "Running" { t.blue } else { t.green }))
                        .child(Label::new(&tk.status).text_size(px(12.0)))
                })))
            .child(self.timeline(cx))
            .children((!self.queued.is_empty()).then(|| self.queue(cx)))
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
                    MsgKind::User => div().flex().gap_3()
                        .child(self.avatar("L", t.primary))
                        .child(div().flex().flex_col().gap_1()
                            .child(div().flex().items_center().gap_2()
                                .child(Label::new(&m.author).font_weight(FontWeight::SEMIBOLD))
                                .child(Label::new(&m.time).text_size(px(12.0)).text_color(t.muted_foreground)))
                            .child(div().p_3().rounded_md().bg(t.muted).child(Label::new(&m.content)))),

                    MsgKind::Think => {
                        let collapsed = m.collapsed;
                        div().flex().gap_3()
                            .child(self.avatar("F", t.accent))
                            .child(div().flex().flex_col().gap_1()
                                .child(div().flex().items_center().gap_2()
                                    .child(Label::new(&m.author).font_weight(FontWeight::SEMIBOLD))
                                    .child(Label::new(&m.time).text_size(px(12.0)).text_color(t.muted_foreground))
                                    .child(Label::new("Thinking").text_size(px(12.0)).text_color(t.green))
                                    .child(Button::new("tog").label(if collapsed { "▸" } else { "▾" }).ghost().xsmall()
                                        .on_click(cx.listener(move |a, _, _, cx| { a.toggle(id); cx.notify(); }))))
                                .children((!collapsed).then(|| div().text_size(px(13.0)).text_color(t.muted_foreground).child(Label::new(&m.content)))))
                    }

                    MsgKind::Action => {
                        let collapsed = m.collapsed;
                        let title = m.meta.as_ref().and_then(|x| x.title.clone()).unwrap_or_else(|| "Action".into());
                        let dur = m.meta.as_ref().and_then(|x| x.duration.clone()).unwrap_or_default();
                        div().flex().gap_3()
                            .child(self.avatar("A", t.accent))
                            .child(div().flex().flex_col().gap_1().flex_1()
                                .child(div().flex().items_center().justify_between()
                                    .child(div().flex().items_center().gap_2()
                                        .child(Label::new(&m.author).font_weight(FontWeight::SEMIBOLD))
                                        .child(Label::new(&m.time).text_size(px(12.0)).text_color(t.muted_foreground)))
                                    .child(Button::new("tog2").label(if collapsed { "▸" } else { "▾" }).ghost().xsmall()
                                        .on_click(cx.listener(move |a, _, _, cx| { a.toggle(id); cx.notify(); }))))
                                .child(div().rounded_md().border_1().border_color(t.border)
                                    .child(div().flex().items_center().justify_between().px_3().py_2().border_b_1().border_color(t.border)
                                        .child(div().flex().items_center().gap_2().child(Label::new("🔍")).child(Label::new(&title).font_weight(FontWeight::MEDIUM)))
                                        .child(Label::new(format!("Complete · {}", dur)).text_size(px(12.0)).text_color(t.green)))
                                    .children((!collapsed).then(|| div().px_3().py_2().text_size(px(12.0)).font_family("monospace").child(Label::new(&m.content))))))
                    }

                    MsgKind::Attach => {
                        let fn_ = m.meta.as_ref().and_then(|x| x.title.clone()).unwrap_or_else(|| "file".into());
                        let path = m.meta.as_ref().and_then(|x| x.path.clone()).unwrap_or_default();
                        let size = m.meta.as_ref().and_then(|x| x.size.clone()).unwrap_or_default();
                        div().flex().gap_3()
                            .child(self.avatar("F", t.accent))
                            .child(div().flex().flex_col().gap_1().flex_1()
                                .child(div().flex().items_center().gap_2()
                                    .child(Label::new(&m.author).font_weight(FontWeight::SEMIBOLD))
                                    .child(Label::new(&m.time).text_size(px(12.0)).text_color(t.muted_foreground)))
                                .child(div().rounded_md().border_1().border_color(t.border).px_3().py_2()
                                    .child(div().flex().items_center().justify_between()
                                        .child(div().flex().items_center().gap_2().child(Label::new("📄"))
                                            .child(div().flex().flex_col()
                                                .child(Label::new(&fn_).font_weight(FontWeight::MEDIUM))
                                                .child(Label::new(format!("{} · Markdown attachment", path)).text_size(px(11.0)).text_color(t.muted_foreground))))
                                        .child(Label::new(size).text_size(px(12.0))))))
                    }

                    MsgKind::Edit => {
                        let fn_ = m.meta.as_ref().and_then(|x| x.title.clone()).unwrap_or_else(|| "file".into());
                        let add = m.meta.as_ref().and_then(|x| x.add).unwrap_or(0);
                        let del = m.meta.as_ref().and_then(|x| x.del).unwrap_or(0);
                        div().flex().gap_3()
                            .child(self.avatar("F", t.accent))
                            .child(div().flex().flex_col().gap_1().flex_1()
                                .child(div().flex().items_center().gap_2()
                                    .child(Label::new(&m.author).font_weight(FontWeight::SEMIBOLD))
                                    .child(Label::new(&m.time).text_size(px(12.0)).text_color(t.muted_foreground))
                                    .child(Label::new("Edited 1 file").text_size(px(12.0)).text_color(t.muted_foreground))
                                    .child(Button::new("review").label("Review").ghost().small()))
                                .child(div().rounded_md().border_1().border_color(t.border)
                                    .child(div().flex().items_center().justify_between().px_3().py_2()
                                        .child(Label::new(&fn_).text_size(px(12.0)).font_family("monospace"))
                                        .child(div().flex().items_center().gap_2()
                                            .child(Label::new(format!("+{}", add)).text_size(px(12.0)).text_color(t.green))
                                            .child(Label::new(format!("-{}", del)).text_size(px(12.0)).text_color(t.red))))))
                    }

                    MsgKind::Result => div().flex().gap_3()
                        .child(self.avatar("F", t.success))
                        .child(div().flex().flex_col().gap_1()
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
                    .child(Label::new("≡"))
                    .child(Label::new("Task queue").font_weight(FontWeight::SEMIBOLD))
                    .child(Label::new(format!("{} items", self.queued.len())).text_size(px(12.0)).text_color(t.muted_foreground)))
                .child(Button::new("viewall").label("View all").ghost().small()))
            .child(div().flex().flex_col()
                .children(queued.into_iter().map(|(idx, q)| {
                    let t = t.clone();
                    div().flex().items_center().justify_between().py_1()
                        .child(div().flex().items_center().gap_2()
                            .child(div().w(px(6.0)).h(px(6.0)).rounded_full().bg(t.yellow))
                            .child(Label::new(q).text_size(px(13.0))))
                        .child(Button::new(format!("rm{}", idx)).label("✕").ghost().xsmall()
                            .on_click(cx.listener(move |a, _, _, cx| { a.remove_from_queue(idx); cx.notify(); })))
                })))
    }

    fn composer(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let t = cx.theme().clone();
        div().border_t_1().border_color(t.border).bg(t.background).px_5().py_3().flex().flex_col().gap_2()
            .child(div().rounded_md().border_1().border_color(t.border).p_3().child(Input::new(&self.composer)))
            .child(div().flex().items_center().justify_between()
                .child(div().flex().items_center().gap_2()
                    .child(Button::new("add").label("+").ghost().small())
                    .child(Button::new("attach").label("📎").ghost().small())
                    .child(Button::new("mic").label("🎤").ghost().small())
                    .child(Label::new("Hold to dictate").text_size(px(12.0)).text_color(t.muted_foreground)))
                .child(Button::new("send").label("↑").primary()
                    .on_click(cx.listener(|a, _, w, cx| a.send(w, cx)))))
    }

    fn right(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let t = cx.theme().clone();
        let working = self.working();
        let elapsed = self.elapsed();
        let msg_count = self.msg_count();
        let queue_count = self.queue_count();
        let task_title = self.task().map(|tk| tk.title.clone()).unwrap_or_else(|| "No active task".into());
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
                            .child(div().flex().flex_col()
                                .child(Label::new("Fennec").font_weight(FontWeight::MEDIUM))
                                .child(Label::new(&task_title).text_size(px(11.0)).text_color(t.muted_foreground))
                                .child(Label::new(format!("Running · {}", elapsed)).text_size(px(11.0)).text_color(t.green))))
                })))
            .child(self.section("Subagents", "👥", "0 delegated agents", cx))
            .child(self.section("Processes", "📡", &format!("{} messages · stream {}", msg_count, if working { "active" } else { "idle" }), cx))
            .child(self.section("Skills", "⚡", "Repository inspection", cx))
            .child(self.section("Artifacts", "📁", &format!("{} task artifacts", msg_count), cx))
            .child(self.section("Web Readings", "🌐", "No linked readings", cx))
            .child(self.section("Sources", "🔗", "No task sources", cx))
            .child(div().px_4().py_3().border_b_1().border_color(t.border)
                .child(Label::new("QUEUE").text_size(px(10.0)).text_color(t.muted_foreground))
                .child(div().flex().items_center().justify_between().mt_1()
                    .child(Label::new(format!("{} pending", queue_count)).text_size(px(12.0)))
                    .children((queue_count > 0).then(|| {
                        let t = t.clone();
                        Button::new("clearq").label("Clear").ghost().xsmall().text_color(t.red)
                    }))))
            .child(div().px_4().py_3().border_b_1().border_color(t.border)
                .child(Label::new("ENVIRONMENT").text_size(px(10.0)).text_color(t.muted_foreground))
                .child(self.row("Repository", "fennec", cx))
                .child(self.row("Branch", "main", cx))
                .child(self.row("Backend", if working { "Connected" } else { "Idle" }, cx)))
    }

    fn section(&self, title: &str, icon: &str, value: &str, cx: &mut Context<Self>) -> impl IntoElement {
        let t = cx.theme().clone();
        div().px_4().py_3().border_b_1().border_color(t.border)
            .child(Label::new(title).text_size(px(10.0)).text_color(t.muted_foreground))
            .child(div().flex().items_center().gap_2().mt_1()
                .child(Label::new(icon))
                .child(div().flex().flex_col()
                    .child(Label::new(title).font_weight(FontWeight::MEDIUM))
                    .child(Label::new(value).text_size(px(11.0)).text_color(t.muted_foreground))))
    }

    fn row(&self, label: &str, value: &str, cx: &mut Context<Self>) -> impl IntoElement {
        let t = cx.theme().clone();
        div().flex().items_center().justify_between().py_1()
            .child(Label::new(label).text_size(px(12.0)))
            .child(Label::new(value).text_size(px(12.0)).text_color(t.muted_foreground))
    }
}

fn main() {
    let path = dirs::data_local_dir().unwrap_or_else(|| PathBuf::from(".")).join("fennec-coding-agent").join("history.json");
    std::fs::create_dir_all(path.parent().unwrap()).ok();

    application().with_assets(assets::Assets).run(|cx| {
        init(cx);
        let bounds = Bounds::centered(None, size(px(1400.0), px(900.0)), cx);
        cx.open_window(WindowOptions { window_bounds: Some(WindowBounds::Windowed(bounds)), ..Default::default() }, |window, cx| {
            let composer = cx.new(|cx| InputState::new(window, cx));
            cx.new(|cx| { let mut a = App::new(path, composer, cx); a.load(); a })
        }).expect("Failed to open window");
    });
}
