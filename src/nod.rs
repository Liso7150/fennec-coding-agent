use fennec_client::{ChatDelta, Engine};
use fennec_workspace_tools::WorkspaceTools;
use serde_json::{json, Value};
use std::io::{self, BufRead, Write};
use std::sync::atomic::AtomicBool;
use std::sync::mpsc;

const PROTOCOLS: [&str; 2] = ["2025-06-18", "2024-11-05"];

pub async fn run_stdio() -> Result<(), String> {
    let workspace = WorkspaceTools::from_env().map_err(|error| format!("FENNEC_WORKSPACE: {error}"))?;
    let stdin = io::stdin();
    let mut stdout = io::BufWriter::new(io::stdout().lock());
    for line in stdin.lock().lines() {
        let line = line.map_err(|error| error.to_string())?;
        if line.trim().is_empty() {
            continue;
        }
        let request = serde_json::from_str::<Value>(&line)
            .map_err(|error| format!("parse error: {error}"))?;
        if let Some(response) = dispatch(request, &workspace).await {
            serde_json::to_writer(&mut stdout, &response).map_err(|error| error.to_string())?;
            stdout.write_all(b"\n").map_err(|error| error.to_string())?;
            stdout.flush().map_err(|error| error.to_string())?;
        }
    }
    Ok(())
}

async fn dispatch(request: Value, workspace: &WorkspaceTools) -> Option<Value> {
    let id = request.get("id").cloned().unwrap_or(Value::Null);
    if request.get("jsonrpc").and_then(Value::as_str) != Some("2.0") {
        return Some(error_response(id, -32600, "invalid JSON-RPC request"));
    }
    let method = match request.get("method").and_then(Value::as_str) {
        Some(method) => method,
        None => return Some(error_response(id, -32600, "method must be a string")),
    };
    let params = request.get("params").cloned().unwrap_or_else(|| json!({}));
    if !params.is_object() {
        return Some(error_response(id, -32602, "params must be an object"));
    }
    match method {
        "initialize" => Some(json!({
            "jsonrpc": "2.0",
            "id": id,
            "result": {
                "protocolVersion": requested_protocol(&params),
                "capabilities": {"tools": {"listChanged": false}},
                "serverInfo": {"name": "fennec", "version": env!("CARGO_PKG_VERSION")},
                "instructions": "Fennec exposes read-only workspace tools and local-model chat.",
            }
        })),
        "ping" => Some(json!({"jsonrpc": "2.0", "id": id, "result": {}})),
        "notifications/initialized" | "notifications/cancelled" => None,
        "tools/list" => Some(json!({"jsonrpc": "2.0", "id": id, "result": {"tools": tool_definitions()}})),
        "tools/call" => Some(tool_response(id, &params, workspace).await),
        _ if method.starts_with("notifications/") => None,
        _ => Some(error_response(id, -32601, &format!("method not found: {method}"))),
    }
}

async fn tool_response(id: Value, params: &Value, workspace: &WorkspaceTools) -> Value {
    let Some(name) = params.get("name").and_then(Value::as_str) else {
        return error_response(id, -32602, "tools/call needs a tool name and object arguments");
    };
    let args = params.get("arguments").cloned().unwrap_or_else(|| json!({}));
    if !args.is_object() {
        return error_response(id, -32602, "tools/call arguments must be an object");
    }
    let (value, failed) = match name {
        "fennec_status" => (status(), false),
        "fennec_chat" => (chat(&args).await, false),
        "fennec_list_dir" | "fennec_read_file" | "fennec_grep" => {
            match workspace.call(name, &args) {
                Ok(value) => (value, false),
                Err(error) => (json!({"ok": false, "error": redact(&error.to_string())}), true),
            }
        }
        _ => (json!({"ok": false, "error": format!("unknown tool: {name}")}), true),
    };
    let failed = failed || value.get("ok").and_then(Value::as_bool) == Some(false);
    let text = redact(&value.to_string());
    let safe_value = serde_json::from_str::<Value>(&text).unwrap_or_else(|_| json!({"ok": false, "error": "tool result could not be encoded safely"}));
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "result": {
            "content": [{"type": "text", "text": text}],
            "structuredContent": safe_value,
            "isError": failed,
        }
    })
}

fn status() -> Value {
    let engine = Engine::new();
    let health = engine.health();
    json!({
        "ok": true,
        "engine_running": health.is_some(),
        "engine": health.unwrap_or_else(|| json!({"error": "Fennec engine is not running"})),
    })
}

async fn chat(args: &Value) -> Value {
    let prompt = match args.get("prompt").and_then(Value::as_str) {
        Some(prompt) if !prompt.trim().is_empty() && prompt.chars().count() <= 8_000 => prompt.trim().to_string(),
        _ => return json!({"ok": false, "error": "prompt must be 1-8000 characters"}),
    };
    let max_tokens = match args.get("max_tokens").and_then(Value::as_u64).unwrap_or(1_024) {
        value @ 1..=4_096 => value as u32,
        _ => return json!({"ok": false, "error": "max_tokens must be an integer from 1 to 4096"}),
    };
    let engine = Engine::new();
    if engine.health().is_none() {
        return json!({"ok": false, "error": "Fennec engine is not running"});
    }
    let (tx, rx) = mpsc::channel();
    let cancel = AtomicBool::new(false);
    let messages = json!([{"role": "user", "content": prompt}]);
    let result = tokio::task::spawn_blocking(move || {
        engine.chat_stream(&messages, max_tokens, &tx, &cancel);
        rx.into_iter().collect::<Vec<_>>()
    }).await;
    let deltas = match result {
        Ok(deltas) => deltas,
        Err(error) => return json!({"ok": false, "error": redact(&error.to_string())}),
    };
    let mut answer = String::new();
    for delta in deltas {
        if let ChatDelta::Content(text) = delta {
            answer.push_str(&text);
        }
    }
    json!({"ok": true, "answer": redact(&answer), "usage": {}})
}

fn requested_protocol(params: &Value) -> &'static str {
    match params.get("protocolVersion").and_then(Value::as_str) {
        Some(version) if version == PROTOCOLS[0] => PROTOCOLS[0],
        _ => PROTOCOLS[1],
    }
}

fn tool_definitions() -> Value {
    json!([
        {"name": "fennec_status", "description": "Read Fennec engine status without starting or changing anything.", "inputSchema": {"type": "object", "properties": {}, "additionalProperties": false}},
        {"name": "fennec_chat", "description": "Ask Fennec's configured local model a text-only question.", "inputSchema": {"type": "object", "properties": {"prompt": {"type": "string"}, "max_tokens": {"type": "integer", "minimum": 1, "maximum": 4096}}, "required": ["prompt"], "additionalProperties": false}},
        {"name": "fennec_list_dir", "description": "List a directory inside Fennec's configured workspace jail.", "inputSchema": {"type": "object", "properties": {"path": {"type": "string"}}, "additionalProperties": false}},
        {"name": "fennec_read_file", "description": "Read a text file inside Fennec's configured workspace jail.", "inputSchema": {"type": "object", "properties": {"path": {"type": "string"}}, "required": ["path"], "additionalProperties": false}},
        {"name": "fennec_grep", "description": "Search text files inside Fennec's configured workspace jail.", "inputSchema": {"type": "object", "properties": {"pattern": {"type": "string"}, "path": {"type": "string"}}, "required": ["pattern"], "additionalProperties": false}},
    ])
}

fn error_response(id: Value, code: i64, message: &str) -> Value {
    json!({"jsonrpc": "2.0", "id": id, "error": {"code": code, "message": message}})
}

fn redact(value: &str) -> String {
    let mut output = value.to_string();
    for key in ["FENNEC_API_KEY", "COLI_API_KEY", "FENNEC_APP_TOKEN", "LIQUID_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY", "GOOGLE_OAUTH_ACCESS_TOKEN"] {
        if let Ok(secret) = std::env::var(key) {
            if !secret.is_empty() {
                output = output.replace(&secret, "[REDACTED]");
            }
        }
    }
    output
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[tokio::test]
    async fn initialize_and_tools_list_are_native_json_rpc() {
        let temp = tempfile::tempdir().unwrap();
        fs::write(temp.path().join("hello.txt"), "hello").unwrap();
        let tools = WorkspaceTools::new(temp.path()).unwrap();
        let response = dispatch(json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18"}}), &tools).await.unwrap();
        assert_eq!(response["result"]["protocolVersion"], "2025-06-18");
        let response = dispatch(json!({"jsonrpc":"2.0","id":2,"method":"tools/list"}), &tools).await.unwrap();
        assert_eq!(response["result"]["tools"].as_array().unwrap().len(), 5);
    }

    #[tokio::test]
    async fn workspace_tools_are_directly_callable_without_http() {
        let temp = tempfile::tempdir().unwrap();
        fs::write(temp.path().join("hello.txt"), "hello").unwrap();
        let tools = WorkspaceTools::new(temp.path()).unwrap();
        let response = dispatch(json!({"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"fennec_read_file","arguments":{"path":"hello.txt"}}}), &tools).await.unwrap();
        assert_eq!(response["result"]["structuredContent"]["content"], "1\thello");
    }
}
