//! The right panel's Files and Browser tabs.
//!
//! Files browses the same jail the agent loop works in — `fennec-workspace-tools`
//! gives both surfaces one traversal-safe, credential-denied view of one folder,
//! so nothing the pane can open is something the run could not already read.
//! Browser is a plain reader: it fetches one http(s) URL and hands the page
//! back twice — the original markup for the pane's sandboxed frame, and
//! stripped text for surfaces that paint no HTML. No webview, no Node.

use axum::extract::Query;
use axum::http::{HeaderMap, HeaderName, HeaderValue, Method, StatusCode};
use axum::response::{Html, IntoResponse, Response};
use axum::Json;
use base64::Engine as _;
use fennec_workspace_tools::WorkspaceTools;
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::{LazyLock, Mutex};

/// The folder the pane defaults to: the server's own workspace, the same two
/// sources the agent loop reads (`FENNEC_WORKSPACE`, then `workspace` in
/// `~/.fennec/config.json`).
pub fn default_root() -> Option<PathBuf> {
    if let Some(env) = std::env::var_os("FENNEC_WORKSPACE") {
        let candidate = PathBuf::from(env);
        if candidate.is_dir() {
            return Some(candidate);
        }
    }
    let home = dirs::home_dir()?;
    let text = std::fs::read_to_string(home.join(".fennec").join("config.json")).ok()?;
    let value: Value = serde_json::from_str(&text).ok()?;
    let root = PathBuf::from(value.get("workspace")?.as_str()?);
    root.is_dir().then_some(root)
}

/// Resolve the `workspace` parameter to a jail. Empty means the default root;
/// a relative name resolves inside it; an absolute one must be a real folder.
/// `WorkspaceTools::new` canonicalises, and every later path goes through its
/// traversal and credential checks, so a caller cannot walk out of what it names.
fn jail_for(workspace: &str) -> Result<WorkspaceTools, Response> {
    let wanted = workspace.trim();
    let unavailable = || {
        (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({"ok": false, "error": "no workspace root: start fennec-agent with FENNEC_WORKSPACE, or set \"workspace\" in ~/.fennec/config.json"})),
        )
            .into_response()
    };
    let root = if wanted.is_empty() {
        default_root().ok_or_else(unavailable)?
    } else if Path::new(wanted).is_absolute() {
        PathBuf::from(wanted)
    } else {
        default_root().ok_or_else(unavailable)?.join(wanted)
    };
    WorkspaceTools::new(&root).map_err(|error| {
        (
            StatusCode::NOT_FOUND,
            Json(json!({"ok": false, "error": error.to_string()})),
        )
            .into_response()
    })
}

#[derive(Deserialize)]
pub struct FilesQuery {
    #[serde(default)]
    path: String,
    #[serde(default)]
    workspace: String,
}

/// `GET /api/work/files` — one directory listing for the Files tab.
/// The shape matches what the core's `/api/files` gives the PWA (entries with
/// `name`, `path`, `is_dir`) plus `size`, so the pane's rows can say how big
/// a file is without a second request per row.
pub async fn files(Query(request): Query<FilesQuery>) -> Response {
    let jail = match jail_for(&request.workspace) {
        Ok(jail) => jail,
        Err(response) => return response.into_response(),
    };
    let path = if request.path.trim().is_empty() { "." } else { request.path.as_str() }.to_string();
    // `WorkspaceTools::new` canonicalises, which on Windows returns a verbatim
    // path (`\\?\D:\…`). That is right for traversal checks and wrong to show a
    // person, so the display root drops the prefix; the jail keeps its own path.
    let root = jail
        .root()
        .to_string_lossy()
        .trim_start_matches("\\\\?\\")
        .to_string();
    match tokio::task::spawn_blocking(move || jail.list_dir(&path)).await {
        Ok(Ok(value)) if value["ok"] == true => {
            let entries = value["entries"]
                .as_array()
                .cloned()
                .unwrap_or_default()
                .into_iter()
                .map(|entry| {
                    let name = entry["name"].as_str().unwrap_or("").to_string();
                    let is_dir = name.ends_with('/');
                    json!({
                        "name": name.trim_end_matches('/'),
                        "path": name.trim_end_matches('/'),
                        "is_dir": is_dir,
                        "size": entry["size"],
                    })
                })
                .collect::<Vec<_>>();
            Json(json!({
                "ok": true,
                "path": value["path"],
                "root": root,
                "entries": entries,
            }))
            .into_response()
        }
        Ok(Ok(value)) => (
            StatusCode::NOT_FOUND,
            Json(json!({"ok": false, "error": value["error"]})),
        )
            .into_response(),
        _ => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({"ok": false, "error": "directory listing failed"})),
        )
            .into_response(),
    }
}

#[derive(Deserialize)]
pub struct FileQuery {
    path: String,
    #[serde(default)]
    workspace: String,
}

/// The most a preview may pull: 4 MiB, the same ceiling the Browser tab puts on
/// one page. Both surfaces hold the whole answer at once — the browser as a
/// decoded image, gpui as one texture — and it travels as base64, so without a
/// cap one stray checkpoint in the workspace would cost the server a quarter of
/// its size in RAM and a third again on the wire.
const MAX_PREVIEW_BYTES: u64 = 4 * 1024 * 1024;

/// The formats both panes can paint. Each is a name in the native decoder's
/// `ImageFormat` and renders in a browser; anything outside this list is
/// refused rather than lossy-decoded into a wall of replacement characters.
const IMAGE_MIMES: &[(&str, &str)] = &[
    ("png", "image/png"),
    ("jpg", "image/jpeg"),
    ("jpeg", "image/jpeg"),
    ("gif", "image/gif"),
    ("webp", "image/webp"),
    ("bmp", "image/bmp"),
];

/// The mime type of a path whose extension names a paintable image. Case does
/// not matter on either surface, and a dot inside a folder name does not make
/// an extension (`a.png/b` is a file called `b`).
fn image_mime(path: &str) -> Option<&'static str> {
    let (_, tail) = path.rsplit_once('.')?;
    if tail.contains(['/', '\\']) {
        return None;
    }
    let extension = tail.to_ascii_lowercase();
    IMAGE_MIMES
        .iter()
        .find(|(name, _)| *name == extension.as_str())
        .map(|(_, mime)| *mime)
}

/// A refusal whose reason both panes can quote.
fn refused(status: StatusCode, error: &str) -> Response {
    (status, Json(json!({ "ok": false, "error": error }))).into_response()
}

/// `GET /api/work/file` — one file for the Files tab, as text or as the bytes
/// of an image. A text answer carries `content`/`lines`/`bytes` like the core's
/// `/api/file` so the viewer is one shape, not two; an image answer carries
/// `mime` and `data` instead. `kind` says which, and the bytes never become
/// text: `read_file` lossy-decodes, which is what the loop's context needs and
/// what turns a PNG into garbage.
pub async fn file(Query(request): Query<FileQuery>) -> Response {
    let jail = match jail_for(&request.workspace) {
        Ok(jail) => jail,
        Err(response) => return response.into_response(),
    };
    let path = request.path.clone();
    match image_mime(&path) {
        Some(mime) => preview_image(jail, path, mime).await,
        None => preview_text(jail, path).await,
    }
}

async fn preview_text(jail: WorkspaceTools, path: String) -> Response {
    match tokio::task::spawn_blocking(move || jail.read_file(&path, false)).await {
        Ok(Ok(value)) if value["ok"] == true => {
            let text = value["content"].as_str().unwrap_or("").to_string();
            if text.contains('\u{FFFD}') {
                // The decoder only produces that character by replacing bytes
                // that were never text, so the pane has nothing to show.
                return refused(
                    StatusCode::UNSUPPORTED_MEDIA_TYPE,
                    "This is a binary file, not text or an image a pane can show.",
                );
            }
            Json(json!({
                "ok": true,
                "kind": "text",
                "path": value["path"],
                "content": text,
                "lines": value["lines"],
                "bytes": value["bytes"],
            }))
            .into_response()
        }
        Ok(Ok(value)) => (
            StatusCode::NOT_FOUND,
            Json(json!({"ok": false, "error": value["error"]})),
        )
            .into_response(),
        Ok(Err(error)) => refused(StatusCode::BAD_REQUEST, &error.to_string()),
        Err(_) => refused(StatusCode::INTERNAL_SERVER_ERROR, "file read failed"),
    }
}

async fn preview_image(jail: WorkspaceTools, path: String, mime: &'static str) -> Response {
    let wanted = path.clone();
    let read =
        tokio::task::spawn_blocking(move || jail.read_bytes(&wanted, MAX_PREVIEW_BYTES)).await;
    let (bytes, total) = match read {
        Ok(Ok(pair)) => pair,
        Ok(Err(error)) => return refused(StatusCode::BAD_REQUEST, &error.to_string()),
        Err(_) => return refused(StatusCode::INTERNAL_SERVER_ERROR, "file read failed"),
    };
    if total > MAX_PREVIEW_BYTES {
        return refused(
            StatusCode::PAYLOAD_TOO_LARGE,
            &format!(
                "This image is {} MB; a pane loads up to {} MB.",
                (total as f64 / (1024.0 * 1024.0) * 10.0).round() / 10.0,
                MAX_PREVIEW_BYTES / (1024 * 1024),
            ),
        );
    }
    Json(json!({
        "ok": true,
        "kind": "image",
        "path": path,
        "mime": mime,
        "data": base64::engine::general_purpose::STANDARD.encode(&bytes),
        "bytes": total,
    }))
    .into_response()
}

#[derive(Deserialize)]
pub struct BrowseRequest {
    url: String,
}

const MAX_BROWSE_BYTES: usize = 4 * 1024 * 1024;
const MAX_BROWSE_CHARS: usize = 20_000;
/// What a text body may occupy inside the frame's document before the rest is
/// dropped. The pane strips HTML to `MAX_BROWSE_CHARS` for the text surface;
/// the frame shows the raw text, so it gets a wider but still bounded slice.
const MAX_DOC_TEXT_CHARS: usize = 400_000;

/// One fetched page, before the surface decides how to show it.
struct Page {
    url: String,
    status: u16,
    html: Option<String>,
    plain: Option<String>,
    truncated: bool,
}

/// The reader answers with the cookies a site gave it, so a page the pane read
/// once stays read (consent banners and locale gates stop re-firing on every
/// navigation). Keyed by host, held for the process, never written to disk and
/// never sent to a host other than the one that set it.
static COOKIES: LazyLock<Mutex<BTreeMap<String, BTreeMap<String, String>>>> = LazyLock::new(Default::default);

fn host_key(url: &reqwest::Url) -> String {
    url.host_str().unwrap_or_default().to_ascii_lowercase()
}

/// The stored `name=value; name=value` pair for one host, if it has any.
fn cookie_for(host: &str) -> Option<String> {
    let jar = COOKIES.lock().ok()?;
    let jar = jar.get(host)?;
    let joined = jar
        .iter()
        .map(|(name, value)| format!("{name}={value}"))
        .collect::<Vec<_>>()
        .join("; ");
    (!joined.is_empty()).then_some(joined)
}

/// Fold every `Set-Cookie` of one response into the host's jar. Only the
/// `name=value` head of each cookie is kept: attributes (path, domain, expiry,
/// SameSite) describe a browser this reader is not, and honouring `domain=`
/// would let one host plant a cookie the reader then sends to another.
fn remember_cookies(host: &str, headers: &reqwest::header::HeaderMap) {
    if host.is_empty() {
        return;
    }
    let mut fresh: Vec<(String, String)> = Vec::new();
    for value in headers.get_all(reqwest::header::SET_COOKIE) {
        let Ok(text) = value.to_str() else { continue };
        let Some(pair) = text.split(';').next() else { continue };
        let Some((name, cookie)) = pair.split_once('=') else { continue };
        let name = name.trim();
        if name.is_empty() {
            continue;
        }
        fresh.push((name.to_string(), cookie.trim().to_string()));
    }
    if fresh.is_empty() {
        return;
    }
    let Ok(mut jar) = COOKIES.lock() else { return };
    let host_jar = jar.entry(host.to_string()).or_default();
    for (name, cookie) in fresh {
        if cookie.is_empty() {
            host_jar.remove(&name);
        } else {
            host_jar.insert(name, cookie);
        }
    }
}

const READER_UA: &str = "Mozilla/5.0 (compatible; Fennec/1.0; local reader)";

/// Reads the address the user named. Redirects are followed freely: a local
/// dev server that bounces `/` to `/login` is a page the user asked for.
static READER: LazyLock<reqwest::Client> = LazyLock::new(|| {
    reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(20))
        .redirect(reqwest::redirect::Policy::limited(5))
        .user_agent(READER_UA)
        .build()
        .expect("the reader client only needs a default TLS provider")
});

/// Reads on behalf of a page's own scripts, which is a different trust level:
/// a hop into a private address would let a public site walk this reader into
/// the machine, so this client stops at the first hop that names one.
static PUBLIC_READER: LazyLock<reqwest::Client> = LazyLock::new(|| {
    reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(20))
        .redirect(reqwest::redirect::Policy::custom(|attempt| {
            if private_host(attempt.url().host_str().unwrap_or_default()) {
                attempt.stop()
            } else {
                attempt.follow()
            }
        }))
        .user_agent(READER_UA)
        .build()
        .expect("the reader client only needs a default TLS provider")
});

/// Hosts that belong to the machine or its network rather than to the open
/// web: loopback, the private ranges, link-local (and so the cloud metadata
/// address), the reserved ranges, plus the names that resolve to a host.
fn private_host(host: &str) -> bool {
    let host = host.trim_end_matches('.').to_ascii_lowercase();
    let host = host.trim_start_matches('[').trim_end_matches(']');
    if host.is_empty()
        || host == "localhost"
        || host.ends_with(".localhost")
        || host.ends_with(".local")
        || host.ends_with(".internal")
        || host.ends_with(".home.arpa")
    {
        return true;
    }
    if let Ok(v4) = host.parse::<std::net::Ipv4Addr>() {
        let o = v4.octets();
        return v4.is_loopback()
            || v4.is_private()
            || v4.is_link_local()
            || v4.is_unspecified()
            || v4.is_broadcast()
            || o[0] == 100 && o[1] == 127
            || o[0] >= 240;
    }
    if let Ok(v6) = host.parse::<std::net::Ipv6Addr>() {
        if v6.is_loopback() || v6.is_unspecified() || v6.is_unicast_link_local() {
            return true;
        }
        if let Some(v4) = v6.to_ipv4_mapped() {
            return private_host(&v4.to_string());
        }
        return v6.segments()[0] & 0xfe00 == 0xfc00;
    }
    false
}

/// The address a browse route may read: what the caller typed, with `https://`
/// assumed and http(s) enforced. Both lanes go through this, so a scheme the
/// process could reach without the user naming a web address (`file:`,
/// `ftp:`, a UNC path) is refused in one place.
fn page_url(raw: &str) -> Result<reqwest::Url, String> {
    let raw = raw.trim();
    let candidate = if raw.is_empty() {
        return Err("Type a web address first.".to_string());
    } else if raw.contains("://") {
        raw.to_string()
    } else {
        format!("https://{raw}")
    };
    match reqwest::Url::parse(&candidate) {
        Ok(url) if matches!(url.scheme(), "http" | "https") => Ok(url),
        Ok(_) => Err("Only http and https addresses can be read.".to_string()),
        Err(_) => Err("That is not a readable address.".to_string()),
    }
}

/// Fetch one http(s) address for either browse surface. Failures come back as
/// the sentence the pane should show: the JSON route renders them as a 400
/// body, the document route renders them inside the frame. http(s) only, so
/// neither route can be pointed at `file://` or anything else the process
/// could reach without the user naming a web address.
async fn fetch_page(raw: &str) -> Result<Page, String> {
    let url = page_url(raw)?;
    let host = host_key(&url);
    let mut request = READER.get(url.clone());
    if let Some(cookies) = cookie_for(&host) {
        request = request.header(reqwest::header::COOKIE, cookies);
    }
    let response = match request.send().await {
        Ok(response) => response,
        Err(error) => return Err(format!("The page did not answer: {error}")),
    };
    let status = response.status().as_u16();
    // A redirect can land on another host; the cookies belong to the host that
    // actually answered, which is also the one the pane now shows.
    let final_url = response.url().to_string();
    remember_cookies(&host_key(response.url()), response.headers());
    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_ascii_lowercase();
    let mut bytes = Vec::new();
    let mut truncated = false;
    let stream_error = match response.bytes().await {
        Ok(body) => {
            if body.len() > MAX_BROWSE_BYTES {
                bytes.extend_from_slice(&body[..MAX_BROWSE_BYTES]);
                truncated = true;
            } else {
                bytes = body.to_vec();
            }
            None
        }
        Err(error) => Some(error.to_string()),
    };
    if let Some(error) = stream_error {
        return Err(format!("The page stopped mid-sending: {error}"));
    }
    let text = String::from_utf8_lossy(&bytes).into_owned();
    let is_html = content_type.contains("html")
        || (content_type.is_empty() && text.trim_start().starts_with('<'));
    if is_html {
        return Ok(Page {
            url: final_url,
            status,
            html: Some(text),
            plain: None,
            truncated,
        });
    }
    if content_type.starts_with("text")
        || content_type.contains("json")
        || content_type.contains("xml")
        || content_type.is_empty()
    {
        Ok(Page {
            url: final_url,
            status,
            html: None,
            plain: Some(text),
            truncated,
        })
    } else {
        Err(format!(
            "That is a {content_type} file, not text a pane can show."
        ))
    }
}

/// `POST /api/browse` — one web page as text, for surfaces that paint no HTML
/// (the native inspector reads through this). The PWA's Browser tab renders
/// the markup itself in a sandboxed frame via `GET /browse/doc` instead.
pub async fn browse(Json(request): Json<BrowseRequest>) -> Response {
    let page = match fetch_page(&request.url).await {
        Ok(page) => page,
        Err(message) => return bad_request(&message),
    };
    let (title, text) = match (&page.html, &page.plain) {
        (Some(html), _) => extract_readable(html),
        (None, Some(plain)) => (String::new(), plain.clone()),
        _ => (String::new(), String::new()),
    };
    let text = clean_whitespace(&text);
    let chars = text.chars().count();
    let shown: String = text.chars().take(MAX_BROWSE_CHARS).collect();
    Json(json!({
        "ok": true,
        "url": page.url,
        "status": page.status,
        "title": title,
        "text": shown,
        "truncated": page.truncated || chars > MAX_BROWSE_CHARS,
    }))
    .into_response()
}

#[derive(Deserialize)]
pub struct DocQuery {
    /// The address to read. Named `u` because it lands in an iframe `src` the
    /// user can see; the value is not secret and not a path on this machine.
    u: String,
}

/// `GET /browse/doc` — the Browser tab's own document. The PWA loads it into
/// a frame sandboxed to `allow-scripts allow-forms`, so the page's markup, CSS
/// and images paint for real while its scripts run in a storage-less context
/// that cannot reach the app. Two scripts are injected ahead of the page's own:
/// the shim, which replaces the tools that context denies, and the router,
/// which posts link and form targets back to the pane for a fresh read through
/// this same Rust fetch. Deliberately outside `/api/`: an iframe navigation
/// cannot carry the client header, and this route serves only content fetched
/// from an address the caller named.
pub async fn browse_doc(Query(request): Query<DocQuery>) -> Response {
    let doc = match fetch_page(&request.u).await {
        Ok(page) => match page.html {
            Some(html) => {
                let html = drop_declaration_metas(&html);
                let title = extract_tag_text(&html, "title");
                prepare_readable(&html, &page.url, page.status, &title, page.truncated)
            }
            None => {
                let text = clean_whitespace(&page.plain.unwrap_or_default());
                let shown: String = text.chars().take(MAX_DOC_TEXT_CHARS).collect();
                text_document(&page.url, page.status, &shown, page.truncated)
            }
        },
        Err(message) => error_document(&message),
    };
    // What this lane returns is another site's page — possibly one the user is
    // signed in to — read through this machine. `no-cache` would still let the
    // browser write that body to disk under a loopback URL, so storing it is
    // refused outright rather than only revalidated.
    let mut res = Html(doc).into_response();
    res.headers_mut().insert(
        axum::http::header::CACHE_CONTROL,
        HeaderValue::from_static("no-store"),
    );
    res
}

#[derive(Deserialize)]
pub struct RawQuery {
    /// The address the page's own script asked for.
    u: String,
}

/// The headers that make a relayed response readable by the frame that asked
/// for it. `*` rather than an echo because the caller has no origin worth
/// matching — an opaque-origin frame reports `null` — and nothing sensitive
/// crosses this lane: see `private_host`.
fn cors_headers() -> HeaderMap {
    let mut out = HeaderMap::new();
    for (name, value) in [
        ("access-control-allow-origin", "*"),
        ("access-control-allow-headers", "*"),
        ("access-control-allow-methods", "GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS"),
        ("access-control-expose-headers", "*"),
        ("access-control-max-age", "600"),
        ("cache-control", "no-store"),
    ] {
        if let (Ok(name), Ok(value)) = (name.parse::<HeaderName>(), HeaderValue::from_str(value)) {
            out.insert(name, value);
        }
    }
    out
}

fn raw_refused(status: StatusCode, message: String) -> Response {
    let mut headers = cors_headers();
    headers.insert(
        axum::http::header::CONTENT_TYPE,
        HeaderValue::from_static("text/plain; charset=utf-8"),
    );
    (status, headers, message).into_response()
}

/// The relay answers `Access-Control-Allow-Origin: *`, so what decides who may
/// read it is the caller's own `Origin`. A frame sandboxed to `allow-scripts`
/// has no origin and reports `null`; a plain `<img>` or an address-bar
/// navigation sends no `Origin` at all. Anything else is a document with an
/// origin of its own, and this lane is not for it.
fn relay_allowed(origin: Option<&HeaderValue>) -> bool {
    match origin {
        None => true,
        Some(value) => value.to_str().map(|text| text == "null").unwrap_or(false),
    }
}

/// `ANY /browse/raw` — the relay a page's own `fetch` and `XMLHttpRequest`
/// calls land on. The frame the document lives in is an opaque origin, so
/// every request the site makes to itself is cross-origin from here and dies
/// on CORS; the injected shim rewrites those to this route, which reads the
/// bytes with the same Rust client as the document lane and answers them with
/// `Access-Control-Allow-Origin: *`.
///
/// Two things make this safe to open. The response is readable by any script
/// that reaches it, so the lane serves **public addresses only**: loopback,
/// private and link-local targets — the engine on 8184, the STT sidecar, the
/// router, the cloud metadata address — are refused. And it answers only a
/// caller with no origin of its own (see `relay_allowed`), so a site in the
/// user's real browser cannot borrow the pane's reader. What is left is what
/// the pane is for: a page reading across the public web, whichever host answers
/// it, with the same reader and the same refusal.
pub async fn browse_raw(
    Query(request): Query<RawQuery>,
    method: Method,
    headers: HeaderMap,
    body: axum::body::Bytes,
) -> Response {
    if !relay_allowed(headers.get(axum::http::header::ORIGIN)) {
        return raw_refused(
            StatusCode::FORBIDDEN,
            "The relay answers the pane's own frames.".to_string(),
        );
    }
    if method == Method::OPTIONS {
        return (StatusCode::NO_CONTENT, cors_headers()).into_response();
    }
    let url = match page_url(&request.u) {
        Ok(url) => url,
        Err(message) => return raw_refused(StatusCode::BAD_REQUEST, message),
    };
    let host = host_key(&url);
    if private_host(&host) {
        return raw_refused(
            StatusCode::FORBIDDEN,
            "A page's own requests are relayed only across the public web.".to_string(),
        );
    }
    let mut builder = PUBLIC_READER.request(method.clone(), url.clone());
    if let Some(cookies) = cookie_for(&host) {
        builder = builder.header(reqwest::header::COOKIE, cookies);
    }
    for (name, value) in relay_headers(&headers) {
        builder = builder.header(name, value);
    }
    if !body.is_empty() {
        builder = builder.body(body.to_vec());
    }
    let response = match builder.send().await {
        Ok(response) => response,
        Err(error) => {
            return raw_refused(
                StatusCode::BAD_GATEWAY,
                format!("The site did not answer the page: {error}"),
            )
        }
    };
    remember_cookies(&host_key(response.url()), response.headers());
    let status = StatusCode::from_u16(response.status().as_u16()).unwrap_or(StatusCode::BAD_GATEWAY);
    let mut out = cors_headers();
    if let Some(content_type) = response.headers().get(reqwest::header::CONTENT_TYPE).cloned() {
        if let Some(value) = content_type.to_str().ok().and_then(|v| HeaderValue::from_str(v).ok()) {
            out.insert(axum::http::header::CONTENT_TYPE, value);
        }
    }
    let bytes = match response.bytes().await {
        Ok(bytes) => bytes,
        Err(error) => {
            return raw_refused(
                StatusCode::BAD_GATEWAY,
                format!("The site stopped mid-sending: {error}"),
            )
        }
    };
    let shown = if bytes.len() > MAX_BROWSE_BYTES {
        &bytes[..MAX_BROWSE_BYTES]
    } else {
        &bytes[..]
    };
    (status, out, shown.to_vec()).into_response()
}

/// The request headers a page may have the reader carry. Everything else
/// belongs to a connection the page does not own: `Host`, `Origin` and
/// `Referer` describe this loopback server, `Cookie` is the jar's business,
/// and `X-Fennec-Client` is the pane's own gate — relaying it would let a
/// frame inside the reader call the API the reader is guarding.
fn relay_headers(headers: &HeaderMap) -> Vec<(HeaderName, HeaderValue)> {
    let mut out = Vec::new();
    for (name, value) in headers.iter() {
        let key = name.as_str();
        let wanted = matches!(
            key,
            "accept" | "accept-language" | "content-language" | "content-type" | "range"
        ) || (key.starts_with("x-") && !key.starts_with("x-fennec"));
        if !wanted {
            continue;
        }
        if let Ok(parsed) = HeaderName::from_bytes(key.as_bytes()) {
            out.push((parsed, value.clone()));
        }
    }
    out
}

/// The fetch outcome the pane's strip shows, handed to the frame's document
/// so the parent can title the read without crossing the sandbox boundary.
fn read_meta(url: &str, status: u16, title: &str, truncated: bool) -> String {
    serde_json::json!({
        "url": url,
        "status": status,
        "title": title,
        "truncated": truncated,
    })
    .to_string()
}

/// Posts the meta to the parent frame; the router script does this itself,
/// the plain-text and error documents use only this.
const POST_META: &str = "try{parent.postMessage({fennecBrowseRead:window.__FENNEC_READ},\"*\")}catch(e){}";

/// The page's own scripts are the reason a pane reads sites at all, and the
/// sandbox those scripts run in takes their tools away. Measured inside the pane:
/// web storage, `document.cookie` and `navigator.serviceWorker` throw
/// `SecurityError` on first touch and `indexedDB.open` throws when the page asks
/// for a store, which stops a site's boot script before it paints; and the frame
/// has no origin of its own, so every request the page makes — to the site that
/// served this markup or to another — dies on CORS before the site can answer.
/// (`history.pushState`, `WebSocket`, `crypto`, `MutationObserver` and blob
/// workers were probed too and already work, so nothing here shadows a working
/// native.)
/// This replaces the rest with what the pane can supply: in-memory equivalents
/// for the life of the read, and `/browse/raw` as the page's server.
const BROWSE_SHIM: &str = r##"(function(D){var H="";try{H=new URL(D.url).host}catch(e){}
function bag(){var m={};function own(k){return Object.prototype.hasOwnProperty.call(m,k)}
return{getItem:function(k){k=""+k;return own(k)?m[k]:null},setItem:function(k,v){m[""+k]=""+v},removeItem:function(k){delete m[""+k]},clear:function(){m={}},key:function(i){var n=Object.keys(m);return i<n.length?n[i]:null},get length(){return Object.keys(m).length}}}
function fix(n){var real=false;try{real=!!window[n]}catch(e){}
if(real)return;try{Object.defineProperty(window,n,{value:bag(),configurable:true})}catch(e){}}
fix("localStorage");fix("sessionStorage");
try{document.cookie}catch(e){var CK={};try{Object.defineProperty(document,"cookie",{configurable:true,
get:function(){var n=[];for(var k in CK)n.push(k+"="+CK[k]);return n.join("; ")},
set:function(v){v=String(v);var p=v.split(";")[0],i=p.indexOf("=");if(i<0)return;
var k=p.slice(0,i).replace(/^\s+|\s+$/g,"");if(!k)return;
var val=p.slice(i+1);if(!val||/;\s*max-age=0\b/.test(v))delete CK[k];else CK[k]=val}})}catch(e){}}
function fcall(){}function freq(){var r={onerror:fcall,onupgradeneeded:fcall,onsuccess:fcall,
onblocked:fcall,result:null,error:null,transaction:null,
addEventListener:function(t,f){if(t==="error"&&typeof f==="function")r.onerror=f},removeEventListener:fcall,
dispatchEvent:fcall,abort:function(){}};
setTimeout(function(){try{r.onerror({target:r,type:"error"})}catch(e){}},0);return r}
// IndexedDB answers through the getter and throws only when the page reaches for
// a store, and a sandboxed frame still reports the origin of the URL it was read
// from, so neither the property nor `location` says which case this is. So ask the
// native on the page's own call: hand back its request when it answers, and the
// failing one when it refuses. Nothing is probed ahead of the page.
var NIDB=null;try{NIDB=window.indexedDB}catch(e){}
if(NIDB&&NIDB.open){try{var IO=NIDB.open,IDM=NIDB.deleteDatabase,IDP=NIDB.databases;
Object.defineProperty(window,"indexedDB",{configurable:true,value:{
open:function(){try{return IO.apply(NIDB,arguments)}catch(e){return freq()}},
deleteDatabase:function(){try{return IDM.apply(NIDB,arguments)}catch(e){return freq()}},
databases:function(){try{if(!IDP)return Promise.resolve([]);
return IDP.apply(NIDB,arguments).catch(function(){return[]})}catch(e){return Promise.resolve([])}},
cmp:function(a,b){try{return NIDB.cmp(a,b)}catch(e){return a<b?-1:a>b?1:0}}}})}catch(e){}}
try{navigator.serviceWorker}catch(e){try{Object.defineProperty(navigator,"serviceWorker",{configurable:true,
value:{register:function(){return Promise.reject(new Error("fennec: no service workers in the reader"))},
unregister:function(){return Promise.resolve(false)},
getRegistration:function(){return Promise.resolve(undefined)},
getRegistrations:function(){return Promise.resolve([])},
controller:null,ready:new Promise(function(){})}})}catch(e){}}
if(!H)return;
// Measured in the pane: a fetch or XHR to another host dies as `TypeError: Failed
// to fetch` / `status=0`, because an opaque origin has no origin a site can allow.
// That is every request the page makes, to its own server or to another one, so
// every http(s) target lands on the relay, which reads it with the same Rust
// client and answers `Access-Control-Allow-Origin: *`. The relay's own address
// stays as it is: rewriting it asks the reader for its own port, which the
// private-address gate below refuses, and a `data:` or `blob:` target is the
// browser's to answer.
function via(u){try{var t=new URL(u,D.url);
if(t.protocol!=="http:"&&t.protocol!=="https:")return u;
if(t.host===H&&t.pathname.indexOf("/browse/")===0)return u;
return "/browse/raw?u="+encodeURIComponent(t.href)}catch(e){return u}}
var F=window.fetch;
if(F)window.fetch=function(a,b){try{if(typeof a==="string")a=via(a);else if(a&&a.url)a=new Request(via(a.url),a)}catch(e){}
return F.call(this,a,b)};
var X=window.XMLHttpRequest;
if(X){var O=X.prototype.open;X.prototype.open=function(){var a=[].slice.call(arguments);
try{if(typeof a[1]==="string")a[1]=via(a[1])}catch(e){}return O.apply(this,a)}}
})(window.__FENNEC_READ||{});
"##;

/// Runs inside the fetched page, in its sandboxed frame. Every `a[href]`
/// click and every form submit is stopped and posted to the parent pane as
/// an absolute URL, so navigation continues through the Rust reader instead
/// of escaping into a live frame the pane cannot see or reload on demand.
///
/// Only interaction the user performed is forwarded as their ask. A page that
/// fires its own click is not the user asking for a page, and forwarding one
/// loops: measured on a Google results page, whose boot script submits a
/// consent form, the pane re-read the form's address seven times in twelve
/// seconds because a read cannot carry that form's data and Google answered
/// the data-less read with a page that submitted itself again.
///
/// A scripted `form.submit()`, though, cannot just be ignored: it fires no
/// submit event, so the browser carries it out against the frame's own
/// address — which is the pane's read address, where the reader looks only at
/// `u` and every field the site sent is dropped. Measured on that same
/// results page: nine reads in nine seconds, each one the page asking for
/// itself back without its data. So a scripted submit is resolved against the
/// address the page was read from and handed to the pane like any other, and
/// the pane stops following after three in a row nobody asked for.
const BROWSE_ROUTER: &str = r##"(function(){var M=window.__FENNEC_READ||{};
function post(m){try{parent.postMessage(m,"*")}catch(e){}}
post({fennecBrowseRead:M});
// A site whose boot script dies paints its markup and then does nothing, which
// from the pane looks like a page that ignores the user. The first uncaught
// error is what actually stopped it, so say it once in the strip. Resource
// failures carry no message and are not the page's script dying.
var er=false;
window.addEventListener("error",function(e){if(er)return;var m=e&&e.message?String(e.message):"";if(!m)return;er=true;
var f=String(e.filename||"").split("/").pop();
post({fennecBrowseErr:"Script stopped: "+m.slice(0,110)+(f?" ("+f.slice(0,40)+")":"")})});
document.addEventListener("click",function(e){
if(!e.isTrusted)return;
var a=e.target&&e.target.closest?e.target.closest("a[href]"):null;
if(!a)return;
var h=a.getAttribute("href")||"";
if(h.charAt(0)==="#")return;
e.preventDefault();
if(/^javascript:/i.test(h))return;
if(a.href)post({fennecBrowseGo:a.href});
},true);
function brf(f,auto){try{
var t=(f.getAttribute("target")||"").toLowerCase();
if(t&&t!=="_self")return false;
var b=M.url||location.href,u=new URL(f.getAttribute("action")||b,b);
if((f.getAttribute("method")||"get").toLowerCase()!=="get"){
// The pane asks for an address and reads what answers; it has no way to send
// this form's fields with that ask, and pretending otherwise re-reads the
// action without its data. Say what stopped instead.
post({fennecBrowseErr:"This form sends data, which the pane cannot carry."});
return true}
new FormData(f).forEach(function(v,k){if(typeof v==="string")u.searchParams.append(k,v)});
if(auto)post({fennecBrowseGo:u.href,fennecBrowseAuto:1});else post({fennecBrowseGo:u.href});
return true}catch(e){return false}}
document.addEventListener("submit",function(e){
if(!e.isTrusted)return;
var f=e.target;
if(!f)return;
e.preventDefault();
brf(f);
},true);
var FP=window.HTMLFormElement&&HTMLFormElement.prototype;
if(FP)["submit","requestSubmit"].forEach(function(n){try{
var O=FP[n];if(typeof O!=="function")return;
FP[n]=function(){if(!brf(this,true))return O.apply(this,arguments)};}catch(e){}});
})();
"##;

fn bootstrap(meta_json: &str, router: bool) -> String {
    // JSON leaves `<` and `/` alone, so a URL or page title ending a fetched
    // tag could close this very script element and reappear as live markup in
    // a document this server signs with its own origin. Escaped as unicode
    // turns it stays one string the parser cannot leave.
    let meta = meta_json.replace('<', "\\u003c").replace('>', "\\u003e");
    if router {
        format!("<script>window.__FENNEC_READ={meta};{BROWSE_SHIM}{BROWSE_ROUTER}</script>")
    } else {
        format!("<script>window.__FENNEC_READ={meta};{POST_META}</script>")
    }
}

/// The fetched markup with two injections right after its opening tag: a
/// `<base>` so the page's own relative assets resolve against its real
/// address, and the click router. First `<head>`, else first `<html>`, else
/// the very top — a `<header>` element must never take the injection.
pub fn prepare_readable(html: &str, url: &str, status: u16, title: &str, truncated: bool) -> String {
    let head = format!(
        "<base href=\"{}\">{}",
        escape_attr(url),
        bootstrap(&read_meta(url, status, title, truncated), true)
    );
    let lower = html.to_ascii_lowercase();
    let at = open_tag_end(html, &lower, "<head").or_else(|| open_tag_end(html, &lower, "<html"));
    match at {
        Some(at) => format!("{}{}{}", &html[..at], head, &html[at..]),
        None => format!("{head}{html}"),
    }
}

/// A page's own `<meta http-equiv>` declarations cannot survive being served
/// from here: a policy meta would forbid the router script the pane needs to
/// keep navigation inside it, and a refresh meta would move the frame to an
/// address nobody asked for. Both tags are removed; the frame's sandbox stays
/// the boundary that actually holds.
fn drop_declaration_metas(html: &str) -> String {
    let lower = html.to_ascii_lowercase();
    let mut out = String::with_capacity(html.len());
    let mut from = 0usize;
    while let Some(rel) = lower[from..].find("<meta") {
        let start = from + rel;
        let end = find_byte(html, start, b'>').map_or(html.len(), |gt| gt + 1);
        let tag = &lower[start..end];
        let declared = tag.contains("content-security-policy")
            || (tag.contains("http-equiv") && tag.contains("refresh"));
        out.push_str(&html[from..start]);
        if !declared {
            out.push_str(&html[start..end]);
        }
        from = end;
    }
    out.push_str(&html[from..]);
    out
}

/// End offset just past the `>` of the first bare `<name>` opening tag.
fn open_tag_end(html: &str, lower: &str, name: &str) -> Option<usize> {
    let mut from = 0usize;
    while let Some(rel) = lower[from..].find(name) {
        let start = from + rel;
        let after = start + name.len();
        match html.as_bytes().get(after) {
            None | Some(b'>') | Some(b' ') | Some(b'\t') | Some(b'\n') | Some(b'\r') => {
                return find_byte(html, after, b'>').map(|gt| gt + 1)
            }
            Some(_) => from = after,
        }
    }
    None
}

/// A non-HTML body (plain text, JSON) wrapped for the same frame, escaped so
/// markup-shaped text cannot paint elements.
pub fn text_document(url: &str, status: u16, text: &str, truncated: bool) -> String {
    format!(
        "<!doctype html><html><head><meta charset=\"utf-8\">{}</head>\
         <body><pre style=\"font:12px/1.55 ui-monospace,Consolas,monospace;\
         white-space:pre-wrap;overflow-wrap:anywhere;word-break:normal\">{}</pre></body></html>",
        bootstrap(&read_meta(url, status, "", truncated), false),
        escape_html(text),
    )
}

/// What the frame shows when the read itself failed: the sentence, and the
/// same meta posted so the pane's strip can repeat it.
fn error_document(message: &str) -> String {
    let meta = serde_json::json!({"e": message}).to_string();
    format!(
        "<!doctype html><html><head><meta charset=\"utf-8\">{}</head>\
         <body style=\"font:13px system-ui,sans-serif;padding:14px;color:#666\">{}</body></html>",
        bootstrap(&meta, false),
        escape_html(message),
    )
}

fn escape_html(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for ch in text.chars() {
        match ch {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            c => out.push(c),
        }
    }
    out
}

fn escape_attr(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for ch in text.chars() {
        match ch {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            c => out.push(c),
        }
    }
    out
}

fn bad_request(message: &str) -> Response {
    (
        StatusCode::BAD_REQUEST,
        Json(json!({"ok": false, "error": message})),
    )
        .into_response()
}

/// Pull the title and the prose out of an HTML document without a parser
/// crate: skip the non-prose elements, break at block edges, decode the
/// entities that carry meaning, drop the rest of the tags.
pub fn extract_readable(html: &str) -> (String, String) {
    let title = extract_tag_text(html, "title");
    let mut out = String::with_capacity(html.len() / 4 + 16);
    let lower = html.to_ascii_lowercase();
    let bytes = html.as_bytes();
    let mut index = 0usize;
    while index < bytes.len() {
        if bytes[index] == b'<' {
            let Some(end) = find_byte(html, index, b'>') else { break };
            let tag = &lower[index + 1..end];
            let name: String = tag
                .trim_start_matches('/')
                .chars()
                .take_while(|c| c.is_ascii_alphanumeric())
                .collect();
            match name.as_str() {
                "script" | "style" | "noscript" | "svg" | "template" | "head" => {
                    let close = format!("</{name}");
                    index = lower[end..]
                        .find(&close)
                        .map(|offset| end + offset + close.len())
                        .unwrap_or(html.len());
                    // Skip past the closing tag's own '>'.
                    if let Some(gt) = find_byte(html, index.saturating_sub(1), b'>') {
                        index = gt + 1;
                    }
                    continue;
                }
                "br" | "hr" => out.push('\n'),
                "p" | "div" | "li" | "ul" | "ol" | "tr" | "table" | "section" | "article"
                | "blockquote" | "pre" | "h1" | "h2" | "h3" | "h4" | "h5" | "h6"
                | "header" | "footer" | "nav" | "aside" | "figure" => {
                    if !tag.starts_with('/') {
                        // Closing block tags break the line; opening ones only
                        // matter for the skip list above, except list items,
                        // where the bullet is the only thing that survives.
                        if name == "li" {
                            out.push_str("\n- ");
                        }
                    } else {
                        out.push('\n');
                    }
                }
                _ => {}
            }
            index = end + 1;
            continue;
        }
        let next = find_byte(html, index, b'<').unwrap_or(html.len());
        out.push_str(&decode_entities(&html[index..next]));
        index = next;
    }
    (title, out)
}

fn find_byte(haystack: &str, from: usize, needle: u8) -> Option<usize> {
    haystack.as_bytes()[from..].iter().position(|b| *b == needle).map(|p| p + from)
}

/// The text inside the first `<name>…</name>` element, tags stripped.
fn extract_tag_text(html: &str, name: &str) -> String {
    let lower = html.to_ascii_lowercase();
    let open = match lower.find(&format!("<{name}")).and_then(|start| {
        lower[start..]
            .find('>')
            .map(|gt| start + gt + 1)
    }) {
        Some(start) => start,
        None => return String::new(),
    };
    let end = lower[open..]
        .find(&format!("</{name}"))
        .map(|offset| open + offset)
        .unwrap_or(html.len());
    let inner = &html[open..end];
    let stripped: String = {
        let mut out = String::with_capacity(inner.len());
        let mut inside_tag = false;
        for ch in inner.chars() {
            match (ch, inside_tag) {
                ('<', false) => inside_tag = true,
                ('>', true) => inside_tag = false,
                (_, true) => {}
                (c, false) => out.push(c),
            }
        }
        out
    };
    clean_whitespace(&decode_entities(&stripped))
        .lines()
        .find(|line| !line.trim().is_empty())
        .unwrap_or("")
        .trim()
        .to_string()
}

fn decode_entities(text: &str) -> String {
    if !text.contains('&') {
        return text.to_string();
    }
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(start) = rest.find('&') {
        out.push_str(&rest[..start]);
        let after = &rest[start..];
        let Some(end) = after.find(';') else {
            out.push('&');
            rest = &after[1..];
            continue;
        };
        if end > 12 {
            out.push('&');
            rest = &after[1..];
            continue;
        }
        let entity = &after[1..end];
        let decoded = match entity {
            "amp" => Some("&".to_string()),
            "lt" => Some("<".to_string()),
            "gt" => Some(">".to_string()),
            "quot" => Some("\"".to_string()),
            "apos" => Some("'".to_string()),
            "nbsp" => Some(" ".to_string()),
            "copy" => Some("\u{00a9}".to_string()),
            "reg" => Some("\u{00ae}".to_string()),
            "trade" => Some("\u{2122}".to_string()),
            "times" => Some("\u{00d7}".to_string()),
            "divide" => Some("\u{00f7}".to_string()),
            "middot" => Some("\u{00b7}".to_string()),
            "bull" => Some("\u{2022}".to_string()),
            "deg" => Some("\u{00b0}".to_string()),
            "laquo" => Some("\u{00ab}".to_string()),
            "raquo" => Some("\u{00bb}".to_string()),
            "ldquo" => Some("\u{201c}".to_string()),
            "rdquo" => Some("\u{201d}".to_string()),
            "lsquo" => Some("\u{2018}".to_string()),
            "rsquo" => Some("\u{2019}".to_string()),
            "euro" => Some("\u{20ac}".to_string()),
            "pound" => Some("\u{00a3}".to_string()),
            "yen" => Some("\u{00a5}".to_string()),
            "cent" => Some("\u{00a2}".to_string()),
            "sect" => Some("\u{00a7}".to_string()),
            "para" => Some("\u{00b6}".to_string()),
            "iexcl" => Some("\u{00a1}".to_string()),
            "iquest" => Some("\u{00bf}".to_string()),
            "larr" => Some("\u{2190}".to_string()),
            "rarr" => Some("\u{2192}".to_string()),
            "mdash" | "ndash" => Some("-".to_string()),
            "hellip" => Some("...".to_string()),
            _ => {
                if let Some(code) = entity.strip_prefix("#x").or(entity.strip_prefix("#X")) {
                    u32::from_str_radix(code, 16).ok().and_then(char::from_u32)
                        .map(|c| c.to_string())
                } else if let Some(code) = entity.strip_prefix('#') {
                    code.parse::<u32>().ok().and_then(char::from_u32)
                        .map(|c| c.to_string())
                } else {
                    None
                }
            }
        };
        match decoded {
            Some(value) => {
                out.push_str(&value);
                rest = &after[end + 1..];
            }
            None => {
                out.push('&');
                rest = &after[1..];
            }
        }
    }
    out.push_str(rest);
    out
}

/// Trim each line, drop the blank ones, and cap the result's line count so a
/// long page cannot fill the pane with hundreds of empty strings.
fn clean_whitespace(text: &str) -> String {
    let mut lines: Vec<String> = Vec::with_capacity(text.lines().count().min(2048));
    for line in text.lines() {
        let trimmed = line.split_whitespace().collect::<Vec<_>>().join(" ");
        if !trimmed.is_empty() {
            lines.push(trimmed);
        }
        if lines.len() >= 2000 {
            break;
        }
    }
    lines.join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn jail_blocks_escape_and_credentials() {
        let temp = tempfile::tempdir().unwrap();
        fs::write(temp.path().join("note.txt"), "hello").unwrap();
        fs::write(temp.path().join(".env"), "SECRET=1").unwrap();
        fs::create_dir(temp.path().join(".git")).unwrap();
        let jail = WorkspaceTools::new(temp.path()).unwrap();
        assert!(jail.read_file("../note.txt", false).is_err());
        assert!(jail.read_file(".env", false).is_err());
        assert!(jail.read_file(".git/config", false).is_err());
        let listing = jail.list_dir(".").unwrap();
        let names: Vec<&str> = listing["entries"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|e| e["name"].as_str())
            .collect();
        assert!(names.contains(&"note.txt"));
        assert!(!names.iter().any(|n| n.contains(".env") || n.contains(".git")));
    }

    #[test]
    fn only_a_real_image_extension_becomes_a_mime() {
        assert_eq!(image_mime("shot.png"), Some("image/png"));
        assert_eq!(image_mime("Shot.PNG"), Some("image/png"));
        assert_eq!(image_mime("dir/photo.jpeg"), Some("image/jpeg"));
        assert_eq!(image_mime("notes.txt"), None);
        assert_eq!(image_mime("archive.tar.gz"), None);
        assert_eq!(image_mime("no-extension"), None);
        // A dot inside a folder name is not an extension of the file.
        assert_eq!(image_mime("a.png/b"), None);
        assert_eq!(image_mime("a.png\\b"), None);
    }

    #[test]
    fn readable_text_keeps_prose_and_drops_chrome() {
        let html = "<html><head><title> A &amp; B </title>\
            <script>var x = '<p>nope</p>';</script><style>p{}</style></head>\
            <body><h1>Welcome</h1><p>First thought.</p><ul><li>one</li><li>two</li>\
            </ul><p>Done &#8212; really &nbsp; yes.</p></body></html>";
        let (title, text) = extract_readable(html);
        assert_eq!(title, "A & B");
        assert!(text.contains("Welcome"));
        assert!(text.contains("First thought."));
        assert!(text.contains("- one"));
        assert!(text.contains("- two"));
        assert!(text.contains("Done \u{2014} really"));
        assert!(text.contains("yes."));
        assert!(!text.contains("nope"));
        assert!(!text.contains("var x"));
    }

    #[test]
    fn entities_decode_only_what_they_know() {
        assert_eq!(decode_entities("a &lt; b &gt; c &zzz; d"), "a < b > c &zzz; d");
        assert_eq!(decode_entities("&#65;&#x42;"), "AB");
        assert_eq!(decode_entities("&copy; &reg; &trade;"), "\u{00a9} \u{00ae} \u{2122}");
    }

    #[test]
    fn readable_document_gets_base_and_router() {
        let doc = prepare_readable(
            "<html><head><title>T</title></head><body><a href=\"/x\">x</a></body></html>",
            "https://example.com/a?b=1",
            200,
            "T",
            false,
        );
        assert!(doc.contains("<head><base href=\"https://example.com/a?b=1\"><script>"));
        assert!(doc.contains("fennecBrowseGo"));
        assert!(doc.contains("\"status\":200"));
    }

    #[test]
    fn readable_document_survives_a_missing_head() {
        let doc = prepare_readable("<div>hi</div>", "https://e.com/", 200, "", false);
        assert!(doc.starts_with("<base href=\"https://e.com/\">"));
        assert!(doc.ends_with("<div>hi</div>"));
    }

    #[test]
    fn header_tag_is_not_mistaken_for_head() {
        let doc = prepare_readable(
            "<html><body><header>h</header></body></html>",
            "https://e.com/",
            200,
            "",
            false,
        );
        assert!(doc.contains("<html><base"));
        assert!(!doc.contains("<header><base"));
    }

    #[test]
    fn base_href_cannot_escape_its_attribute() {
        let doc = prepare_readable(
            "<head></head>",
            "https://e.com/\" onmouseover=\"x",
            200,
            "",
            false,
        );
        assert!(
            doc.contains("<base href=\"https://e.com/&quot; onmouseover=&quot;x\">"),
            "the address must stay inside its own attribute: {doc}"
        );
        assert!(
            !doc.contains("<base href=\"https://e.com/\" "),
            "a quote may not close the base tag"
        );
    }

    #[test]
    fn an_address_cannot_close_the_bootstrap_script() {
        let doc = prepare_readable(
            "<head></head>",
            "https://e.com/</script><img src=x onerror=alert(1)>",
            200,
            "</script><b>hi</b>",
            false,
        );
        assert_eq!(
            doc.matches("<script>").count(),
            1,
            "the address and title must not open a second tag: {doc}"
        );
        assert_eq!(
            doc.matches("</script>").count(),
            1,
            "nothing may close the bootstrap script early"
        );
        assert!(!doc.contains("<img src=x"), "the address leaked as markup");
        assert!(!doc.contains("<b>hi</b>"), "the title leaked as markup");
        assert!(doc.contains("\\u003c/script"), "the string was not escaped");
    }

    #[test]
    fn a_pages_policy_and_refresh_meta_are_dropped() {
        let html = "<head>\
             <meta charset=\"utf-8\">\
             <meta http-equiv=\"Content-Security-Policy\" content=\"script-src 'none'\">\
             <META HTTP-EQUIV='Refresh' CONTENT=\"0; url=https://elsewhere.example\">\
             <meta name=\"description\" content=\"kept prose\">\
             </head><body><p>text</p></body>";
        let kept = drop_declaration_metas(html);
        assert!(!kept.contains("http-equiv"), "declaration meta survived: {kept}");
        assert!(!kept.contains("elsewhere.example"));
        assert!(kept.contains("<meta charset=\"utf-8\">"), "charset is not a policy");
        assert!(kept.contains("kept prose"), "ordinary metadata stays");
        assert!(kept.contains("<p>text</p>"), "the page itself is untouched");
    }

    #[test]
    fn the_frame_gets_storage_and_a_relay_for_the_open_web() {
        let doc = prepare_readable("<head></head>", "https://shop.example/cart", 200, "Cart", false);
        // An opaque-origin frame throws on web storage, and no site can name an
        // origin that lets it read a response, so both are replaced before the
        // page's scripts run.
        assert!(doc.contains("fix(\"localStorage\")"), "storage is not shimmed");
        assert!(doc.contains("fix(\"sessionStorage\")"));
        assert!(
            doc.contains("/browse/raw?u="),
            "fetch and XHR are not routed to the relay"
        );
        // A `data:` or `blob:` target is the browser's to answer, and the relay's
        // own address must not itself be relayed — that asks the reader for its
        // own port, which its private-address gate refuses.
        assert!(doc.contains("if(t.protocol!==\"http:\"&&t.protocol!==\"https:\")return u"));
        assert!(doc.contains("if(t.host===H&&t.pathname.indexOf(\"/browse/\")===0)return u"));
        assert!(
            !doc.contains("if(t.host!==H)return u"),
            "the relay stopped following a page off the host that served it"
        );
        assert!(!doc.contains("127.0.0.1"), "the pane's own origin is not a page host");
    }

    #[test]
    fn a_pages_own_navigation_is_answered_at_its_own_address() {
        let doc = prepare_readable("<head></head>", "https://shop.example/cart?in=1", 200, "Cart", false);
        // Inside the frame `location` is the pane's read address, so a form
        // resolved against it sends the site's fields somewhere the reader has
        // no use for and asks for the same page back without them. The page's
        // real address is the one its form belongs to.
        assert!(
            doc.contains("var b=M.url||location.href,u=new URL(f.getAttribute(\"action\")||b,b)"),
            "a form is being resolved against the pane's address again"
        );
        // A script calling form.submit() fires no submit event, so the prototype
        // is what has to answer it.
        assert!(
            doc.contains("FP[n]=function(){if(!brf(this,true))return O.apply(this,arguments)}"),
            "a scripted form.submit() is left to the browser"
        );
        // The pane follows a page, but it has to know when the page — and not
        // the user — asked, or it cannot bound the following.
        assert!(doc.contains("fennecBrowseAuto:1"), "a page-driven hop is not marked");
        assert!(
            !doc.contains("fennecBrowseGo:a.href,fennecBrowseAuto"),
            "a link the user clicked is being counted against the page"
        );
        // A form aimed at another frame is that frame's to carry, and one whose
        // data the pane cannot send says so instead of vanishing.
        assert!(doc.contains("if(t&&t!==\"_self\")return false"));
        assert!(doc.contains("This form sends data, which the pane cannot carry."));
    }

    #[test]
    fn the_relay_refuses_every_address_on_this_machine_and_network() {
        for blocked in [
            "127.0.0.1",
            "localhost",
            "LOCALHOST.",
            "api.localhost",
            "::1",
            "[::1]",
            "0.0.0.0",
            "10.1.2.3",
            "172.16.0.9",
            "192.168.1.254",
            "169.254.169.254",
            "100.127.0.1",
            "240.0.0.1",
            "fe80::1",
            "fd00::12",
            "[::ffff:127.0.0.1]",
            "printer.local",
            "git.internal",
        ] {
            assert!(private_host(blocked), "{blocked} reached the relay lane");
        }
        for allowed in ["example.com", "8.8.8.8", "2606:4700:4700::1111", "1.1.1.1"] {
            assert!(!private_host(allowed), "{allowed} was refused though it is public");
        }
    }

    #[test]
    fn only_a_caller_without_an_origin_may_read_the_relay() {
        assert!(relay_allowed(None), "a frame navigation has no Origin");
        assert!(
            relay_allowed(Some(&HeaderValue::from_static("null"))),
            "a sandboxed frame reports the null origin"
        );
        for origin in [
            "https://evil.example",
            "http://127.0.0.1:8787",
            "null, null",
        ] {
            assert!(
                !relay_allowed(Some(&HeaderValue::from_str(origin).unwrap())),
                "{origin} is a document with an origin of its own"
            );
        }
    }

    #[test]
    fn the_relay_carries_headers_a_page_owns_and_drops_the_ones_it_does_not() {
        let mut headers = HeaderMap::new();
        headers.insert("accept", HeaderValue::from_static("application/json"));
        headers.insert("content-type", HeaderValue::from_static("application/json"));
        headers.insert("x-csrf-token", HeaderValue::from_static("page-owned"));
        headers.insert("x-fennec-client", HeaderValue::from_static("1"));
        headers.insert("cookie", HeaderValue::from_static("session=stolen"));
        headers.insert("origin", HeaderValue::from_static("null"));
        headers.insert("host", HeaderValue::from_static("127.0.0.1:8787"));
        headers.insert("connection", HeaderValue::from_static("close"));
        let kept = relay_headers(&headers);
        let mut names: Vec<String> = kept.iter().map(|(name, _)| name.as_str().to_string()).collect();
        names.sort();
        assert_eq!(names, ["accept", "content-type", "x-csrf-token"]);
    }

    #[test]
    fn the_jar_keeps_a_hosts_cookies_for_that_host_only() {
        let mut given = HeaderMap::new();
        given.append("set-cookie", HeaderValue::from_static("sess=abc; Path=/; HttpOnly"));
        given.append("set-cookie", HeaderValue::from_static("consent=1"));
        remember_cookies("jar-one.example", &given);
        assert_eq!(
            cookie_for("jar-one.example").as_deref(),
            Some("consent=1; sess=abc"),
            "attributes belong to a browser, not to a reader"
        );
        assert_eq!(
            cookie_for("jar-two.example"),
            None,
            "one host may not read another's session"
        );
        // An empty value with an expiry is the usual way a site deletes a
        // cookie; keeping it would send a session back after it was ended.
        let mut ended = HeaderMap::new();
        ended.append("set-cookie", HeaderValue::from_static("sess=; Max-Age=0"));
        remember_cookies("jar-one.example", &ended);
        assert_eq!(cookie_for("jar-one.example").as_deref(), Some("consent=1"));
    }

    #[test]
    fn plain_documents_are_escaped_and_carry_meta() {
        let doc = text_document("https://e.com/d.json", 200, "{\"a\": \"<b>\"}", false);
        assert!(doc.contains("&lt;b&gt;"));
        assert!(doc.contains("fennecBrowseRead"));
        assert!(!doc.contains("fennecBrowseGo"));
    }

    #[test]
    fn clean_folds_lines_and_bounds_them() {
        let text = "  hello   world \n\n\n\tsecond line\n";
        assert_eq!(clean_whitespace(text), "hello world\nsecond line");
        let many = "x\n".repeat(5000);
        assert!(clean_whitespace(&many).lines().count() <= 2000);
    }
}
