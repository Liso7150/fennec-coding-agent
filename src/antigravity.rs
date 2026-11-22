use fennec_workspace_tools::{WorkspaceTools, MAX_RESULT_CHARS};
use reqwest::header::{HeaderMap, HeaderValue, AUTHORIZATION};
use serde_json::{json, Value};
use std::time::Duration;

const MAX_TURNS: usize = 8;
const DEFAULT_MODEL: &str = "gemini-2.5-flash";

#[derive(Clone, Debug)]
pub struct AntigravityConfig {
    pub workspace: Option<String>,
    pub model: String,
    credential: Credential,
}

#[derive(Clone, Debug)]
enum Credential {
    Gemini(String),
    Vertex { project: String, location: String, token: String },
    Missing,
}

impl AntigravityConfig {
    pub fn from_env() -> Self {
        let workspace = std::env::var("FENNEC_WORKSPACE")
            .ok()
            .and_then(|path| WorkspaceTools::new(&path).ok().map(|_| path));
        let model = std::env::var("ANTIGRAVITY_MODEL")
            .or_else(|_| std::env::var("GEMINI_MODEL"))
            .unwrap_or_else(|_| DEFAULT_MODEL.to_string());
        let credential = std::env::var("GEMINI_API_KEY")
            .or_else(|_| std::env::var("GOOGLE_API_KEY"))
            .ok()
            .filter(|key| !key.is_empty())
            .map(Credential::Gemini)
            .or_else(|| {
                let vertex = std::env::var("GOOGLE_GENAI_USE_VERTEXAI")
                    .map(|value| matches!(value.to_ascii_lowercase().as_str(), "1" | "true" | "yes"))
                    .unwrap_or(false);
                if !vertex {
                    return None;
                }
                Some(Credential::Vertex {
                    project: std::env::var("GOOGLE_CLOUD_PROJECT").unwrap_or_default(),
                    location: std::env::var("GOOGLE_CLOUD_LOCATION").unwrap_or_default(),
                    token: std::env::var("GOOGLE_OAUTH_ACCESS_TOKEN").unwrap_or_default(),
                })
            })
            .unwrap_or(Credential::Missing);
        Self { workspace, model, credential }
    }

    pub fn status(&self) -> Value {
        let installed = true;
        let configured = match &self.credential {
            Credential::Gemini(key) => !key.is_empty(),
            Credential::Vertex { project, location, token } => !project.is_empty() && !location.is_empty() && !token.is_empty(),
            Credential::Missing => false,
        };
        let workspace = self.workspace.is_some();
        let present = installed && configured && workspace;
        let mut status = json!({
            "present": present,
            "installed": installed,
            "configured": configured,
            "workspace": workspace,
            "model": self.model,
            "tools": ["list_dir", "read_file", "grep"],
        });
        if !configured {
            status["error"] = json!("set GEMINI_API_KEY or configure Vertex AI with an OAuth access token");
        } else if !workspace {
            status["error"] = json!("set FENNEC_WORKSPACE to an existing directory");
        } else {
            status["note"] = json!("native read-only workspace tools; provider built-ins are disabled");
        }
        status
    }

    pub async fn run(&self, goal: &str) -> Result<String, String> {
        if goal.trim().is_empty() || goal.chars().count() > 8_000 {
            return Err("goal must be 1-8000 characters".into());
        }
        let workspace_path = self.workspace.as_deref()
            .ok_or_else(|| "FENNEC_WORKSPACE is not configured".to_string())?;
        let workspace = WorkspaceTools::new(workspace_path)
            .map_err(|error| error.to_string())?;
        if matches!(self.credential, Credential::Missing) {
            return Err("set GEMINI_API_KEY or configure Vertex AI with GOOGLE_OAUTH_ACCESS_TOKEN".into());
        }
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(120))
            .build()
            .map_err(|error| error.to_string())?;
        let mut contents = vec![json!({"role": "user", "parts": [{"text": goal.trim()}]})];
        for _ in 0..MAX_TURNS {
            let response = self.generate(&client, &contents).await?;
            let content = response.get("candidates").and_then(Value::as_array)
                .and_then(|candidates| candidates.first())
                .and_then(|candidate| candidate.get("content"))
                .cloned()
                .ok_or_else(|| "provider returned no candidate".to_string())?;
            let parts = content.get("parts").and_then(Value::as_array).cloned().unwrap_or_default();
            let calls: Vec<(String, Value)> = parts.iter().filter_map(|part| {
                let call = part.get("functionCall")?;
                Some((call.get("name")?.as_str()?.to_string(), call.get("args").cloned().unwrap_or_else(|| json!({}))))
            }).collect();
            if calls.is_empty() {
                let text = parts.iter().filter_map(|part| part.get("text").and_then(Value::as_str)).collect::<Vec<_>>().join("");
                return Ok(redact(&text));
            }
            contents.push(json!({"role": "model", "parts": parts}));
            let mut responses = Vec::new();
            for (name, args) in calls {
                let result = workspace.call(&name, &args)
                    .map_err(|error| error.to_string())?;
                responses.push(json!({"functionResponse": {"name": name, "response": bound_result(result)}}));
            }
            contents.push(json!({"role": "user", "parts": responses}));
        }
        Err("Antigravity reached its tool-call limit".into())
    }

    async fn generate(&self, client: &reqwest::Client, contents: &[Value]) -> Result<Value, String> {
        let body = json!({
            "contents": contents,
            "tools": [{"functionDeclarations": declarations()}],
            "toolConfig": {"functionCallingConfig": {"mode": "AUTO"}},
            "generationConfig": {"temperature": 0.2, "maxOutputTokens": 4096},
        });
        let request = match &self.credential {
            Credential::Gemini(key) => client
                .post(format!("https://generativelanguage.googleapis.com/v1beta/models/{}:generateContent", self.model))
                .query(&[("key", key)]),
            Credential::Vertex { project, location, token } => {
                if project.is_empty() || location.is_empty() || token.is_empty() {
                    return Err("Vertex AI requires project, location, and GOOGLE_OAUTH_ACCESS_TOKEN".into());
                }
                let mut headers = HeaderMap::new();
                headers.insert(AUTHORIZATION, HeaderValue::from_str(&format!("Bearer {token}")).map_err(|_| "invalid Vertex OAuth token")?);
                client
                    .post(format!("https://{}-aiplatform.googleapis.com/v1/projects/{project}/locations/{location}/publishers/google/models/{}:generateContent", location, self.model))
                    .headers(headers)
            }
            Credential::Missing => return Err("provider credentials are missing".into()),
        };
        let response = request.json(&body).send().await.map_err(|error| error.to_string())?;
        let status = response.status();
        let value = response.json::<Value>().await.map_err(|error| error.to_string())?;
        if !status.is_success() {
            return Err(redact(value.get("error").and_then(|error| error.get("message")).and_then(Value::as_str).unwrap_or("Antigravity provider request failed")));
        }
        Ok(value)
    }
}

fn declarations() -> Value {
    json!([
        {"name": "list_dir", "description": "List a directory inside the configured workspace.", "parameters": {"type": "object", "properties": {"path": {"type": "string"}}}},
        {"name": "read_file", "description": "Read a text file inside the configured workspace.", "parameters": {"type": "object", "properties": {"path": {"type": "string"}, "numbered": {"type": "boolean"}}, "required": ["path"]}},
        {"name": "grep", "description": "Search text files inside the configured workspace.", "parameters": {"type": "object", "properties": {"pattern": {"type": "string"}, "path": {"type": "string"}}, "required": ["pattern"]}},
    ])
}

fn bound_result(mut value: Value) -> Value {
    if let Some(object) = value.as_object_mut() {
        if let Some(content) = object.get_mut("content") {
            if let Some(text) = content.as_str() {
                *content = Value::String(text.chars().take(MAX_RESULT_CHARS).collect());
            }
        }
    }
    value
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

    #[test]
    fn status_is_denied_without_provider_and_workspace() {
        let config = AntigravityConfig { workspace: None, model: DEFAULT_MODEL.into(), credential: Credential::Missing };
        assert!(!config.status()["present"].as_bool().unwrap());
        assert_eq!(config.status()["tools"].as_array().unwrap().len(), 3);
    }
}
