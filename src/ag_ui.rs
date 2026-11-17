//! AG-UI protocol endpoint — CopilotKit's agent-to-UI protocol over SSE.
//!
//! Accepts `POST /api/copilotkit/agent/:agentId/run`, forwards the chat to
//! the Fennec engine on port 8184 (OpenAI-compatible API), and converts the
//! engine's SSE stream into AG-UI events streamed back to the client.
//!
//! This is a pure Rust implementation — no Node.js, no React, no CopilotKit runtime.

use axum::{
    extract::{Path, State},
    response::{
        sse::{Event, Sse},
        IntoResponse,
    },
};
use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::convert::Infallible;
use tokio_stream::StreamExt;
use uuid::Uuid;

use super::AppState;

const ENGINE_URL: &str = "http://127.0.0.1:8184";
const ENGINE_API_KEY: &str = "local";

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunAgentInput {
    pub thread_id: String,
    pub run_id: String,
    pub messages: Vec<AgUiMessage>,
    #[serde(default)]
    pub tools: Vec<ToolDefinition>,
    #[serde(default)]
    pub context: Vec<Value>,
    pub forwarded_props: Option<Value>,
}

#[derive(Debug, Deserialize)]
pub struct AgUiMessage {
    pub id: String,
    pub role: String,
    pub content: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolDefinition {
    pub name: String,
    pub description: Option<String>,
    pub parameters: Option<Value>,
}

#[derive(Debug, Serialize)]
#[serde(tag = "type", rename_all = "SCREAMING_SNAKE_CASE")]
enum AgUiEvent {
    RunStarted {
        #[serde(rename = "threadId")]
        thread_id: String,
        #[serde(rename = "runId")]
        run_id: String,
    },
    RunFinished {
        #[serde(rename = "threadId")]
        thread_id: String,
        #[serde(rename = "runId")]
        run_id: String,
    },
    RunError {
        code: String,
        message: String,
    },
    TextMessageStart {
        #[serde(rename = "messageId")]
        message_id: String,
        role: String,
    },
    TextMessageContent {
        #[serde(rename = "messageId")]
        message_id: String,
        delta: String,
    },
    TextMessageEnd {
        #[serde(rename = "messageId")]
        message_id: String,
    },
    ReasoningMessageStart {
        #[serde(rename = "messageId")]
        message_id: String,
    },
    ReasoningMessageContent {
        #[serde(rename = "messageId")]
        message_id: String,
        delta: String,
    },
    ReasoningMessageEnd {
        #[serde(rename = "messageId")]
        message_id: String,
    },
}

pub async fn copilotkit_run(
    Path(agent_id): Path<String>,
    State(_state): State<AppState>,
    axum::Json(input): axum::Json<RunAgentInput>,
) -> impl IntoResponse {
    tracing::info!(
        "AG-UI run request for agent={}, thread={}, run={}",
        agent_id,
        input.thread_id,
        input.run_id
    );

    let engine_messages: Vec<Value> = input
        .messages
        .iter()
        .map(|m| {
            json!({
                "role": m.role,
                "content": m.content,
            })
        })
        .collect();

    let stream = async_stream::stream! {
        let thread_id = input.thread_id.clone();
        let run_id = input.run_id.clone();

        yield Ok::<Event, Infallible>(Event::default().data(
            serde_json::to_string(&AgUiEvent::RunStarted {
                thread_id: thread_id.clone(),
                run_id: run_id.clone(),
            }).unwrap()
        ));

        let message_id = Uuid::new_v4().to_string();
        yield Ok(Event::default().data(
            serde_json::to_string(&AgUiEvent::TextMessageStart {
                message_id: message_id.clone(),
                role: "assistant".to_string(),
            }).unwrap()
        ));

        let client = Client::new();
        let body = json!({
            "messages": engine_messages,
            "stream": true,
            "max_tokens": 2048,
            "temperature": 0.7,
        });

        let engine_url = std::env::var("FENNEC_ENGINE_URL")
            .unwrap_or_else(|_| ENGINE_URL.to_string());
        let api_key = std::env::var("FENNEC_API_KEY")
            .or_else(|_| std::env::var("COLI_API_KEY"))
            .unwrap_or_else(|_| ENGINE_API_KEY.to_string());

        let resp = client
            .post(format!("{}/v1/chat/completions", engine_url))
            .header("Authorization", format!("Bearer {}", api_key))
            .header("Content-Type", "application/json")
            .json(&body)
            .send()
            .await;

        match resp {
            Ok(response) => {
                if !response.status().is_success() {
                    let status = response.status();
                    let error_text = response.text().await.unwrap_or_default();
                    yield Ok(Event::default().data(
                        serde_json::to_string(&AgUiEvent::RunError {
                            code: format!("ENGINE_{}", status.as_u16()),
                            message: format!("Engine returned {}: {}", status, error_text),
                        }).unwrap()
                    ));
                    yield Ok(Event::default().data(
                        serde_json::to_string(&AgUiEvent::RunFinished {
                            thread_id: thread_id.clone(),
                            run_id: run_id.clone(),
                        }).unwrap()
                    ));
                    return;
                }

                let mut buffer = String::new();
                let mut stream = response.bytes_stream();

                while let Some(chunk) = stream.next().await {
                    match chunk {
                        Ok(bytes) => {
                            buffer.push_str(&String::from_utf8_lossy(&bytes));

                            while let Some(newline_pos) = buffer.find('\n') {
                                let line = buffer[..newline_pos].trim().to_string();
                                buffer = buffer[newline_pos + 1..].to_string();

                                if line.is_empty() || line.starts_with(':') {
                                    continue;
                                }

                                if !line.starts_with("data: ") {
                                    continue;
                                }

                                let data = &line[6..];
                                if data == "[DONE]" {
                                    break;
                                }

                                if let Ok(parsed) = serde_json::from_str::<Value>(data) {
                                    if let Some(choices) = parsed.get("choices").and_then(|c| c.as_array()) {
                                        if let Some(choice) = choices.first() {
                                            if let Some(delta) = choice.get("delta") {
                                                if let Some(content) = delta.get("content").and_then(|c| c.as_str()) {
                                                    if !content.is_empty() {
                                                        yield Ok(Event::default().data(
                                                            serde_json::to_string(&AgUiEvent::TextMessageContent {
                                                                message_id: message_id.clone(),
                                                                delta: content.to_string(),
                                                            }).unwrap()
                                                        ));
                                                    }
                                                }

                                                if let Some(reasoning) = delta.get("reasoning_content").and_then(|r| r.as_str()) {
                                                    if !reasoning.is_empty() {
                                                        yield Ok(Event::default().data(
                                                            serde_json::to_string(&AgUiEvent::ReasoningMessageContent {
                                                                message_id: message_id.clone(),
                                                                delta: reasoning.to_string(),
                                                            }).unwrap()
                                                        ));
                                                    }
                                                }
                                            }
                                        }
                                    }
                                }
                            }

                            if buffer.contains("[DONE]") {
                                break;
                            }
                        }
                        Err(e) => {
                            yield Ok(Event::default().data(
                                serde_json::to_string(&AgUiEvent::RunError {
                                    code: "STREAM_ERROR".to_string(),
                                    message: format!("Failed to read engine stream: {}", e),
                                }).unwrap()
                            ));
                            break;
                        }
                    }
                }

                yield Ok(Event::default().data(
                    serde_json::to_string(&AgUiEvent::TextMessageEnd {
                        message_id: message_id.clone(),
                    }).unwrap()
                ));

                yield Ok(Event::default().data(
                    serde_json::to_string(&AgUiEvent::RunFinished {
                        thread_id: thread_id.clone(),
                        run_id: run_id.clone(),
                    }).unwrap()
                ));
            }
            Err(e) => {
                yield Ok(Event::default().data(
                    serde_json::to_string(&AgUiEvent::RunError {
                        code: "ENGINE_UNREACHABLE".to_string(),
                        message: format!("Cannot connect to Fennec engine: {}", e),
                    }).unwrap()
                ));
                yield Ok(Event::default().data(
                    serde_json::to_string(&AgUiEvent::RunFinished {
                        thread_id: thread_id.clone(),
                        run_id: run_id.clone(),
                    }).unwrap()
                ));
            }
        }
    };

    Sse::new(stream)
}
