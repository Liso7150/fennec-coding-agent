use serde::{Deserialize, Serialize};
use std::process::Stdio;
use tokio::process::Command;

#[derive(Clone, Debug, Serialize)]
pub struct GithubAccount {
    pub login: String,
    pub display_name: Option<String>,
    pub avatar_url: Option<String>,
    pub html_url: String,
}

#[derive(Clone, Debug, Serialize)]
pub struct GithubRepository {
    pub name: String,
    pub full_name: String,
    pub private: bool,
    pub html_url: String,
    pub default_branch: Option<String>,
    pub owner_login: String,
}

#[derive(Clone, Debug, Serialize)]
pub struct GithubAccountStatus {
    pub authenticated: bool,
    pub account: Option<GithubAccount>,
    pub error: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
pub struct GithubRepositoryStatus {
    pub authenticated: bool,
    pub repositories: Vec<GithubRepository>,
    pub error: Option<String>,
}

#[derive(Debug, Deserialize)]
struct GithubAccountPayload {
    login: String,
    name: Option<String>,
    avatar_url: Option<String>,
    html_url: String,
}

#[derive(Debug, Deserialize)]
struct GithubRepositoryPayload {
    name: String,
    full_name: String,
    private: bool,
    html_url: String,
    default_branch: Option<String>,
    owner: GithubOwnerPayload,
}

#[derive(Debug, Deserialize)]
struct GithubOwnerPayload {
    login: String,
}

pub async fn account_status() -> GithubAccountStatus {
    match api("user").await {
        Ok(body) => match serde_json::from_slice::<GithubAccountPayload>(&body) {
            Ok(account) => GithubAccountStatus {
                authenticated: true,
                account: Some(GithubAccount {
                    login: account.login,
                    display_name: account.name,
                    avatar_url: account.avatar_url,
                    html_url: account.html_url,
                }),
                error: None,
            },
            Err(_) => unavailable("GitHub returned an invalid account response"),
        },
        Err(error) => unavailable(&error),
    }
}

pub async fn repository_status() -> GithubRepositoryStatus {
    match api("user/repos?per_page=100&sort=updated").await {
        Ok(body) => match serde_json::from_slice::<Vec<GithubRepositoryPayload>>(&body) {
            Ok(repositories) => GithubRepositoryStatus {
                authenticated: true,
                repositories: repositories
                    .into_iter()
                    .map(|repository| GithubRepository {
                        name: repository.name,
                        full_name: repository.full_name,
                        private: repository.private,
                        html_url: repository.html_url,
                        default_branch: repository.default_branch,
                        owner_login: repository.owner.login,
                    })
                    .collect(),
                error: None,
            },
            Err(_) => GithubRepositoryStatus {
                authenticated: true,
                repositories: Vec::new(),
                error: Some("GitHub returned an invalid repository response".to_string()),
            },
        },
        Err(error) => GithubRepositoryStatus {
            authenticated: false,
            repositories: Vec::new(),
            error: Some(error),
        },
    }
}

pub async fn create_repository(name: &str, private: bool) -> Result<GithubRepository, String> {
    let name = name.trim();
    if name.is_empty()
        || name.len() > 100
        || !name.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
    {
        return Err("Repository names may contain only letters, numbers, hyphens, underscores, and periods".to_string());
    }
    let name_arg = format!("name={name}");
    let private_arg = format!("private={private}");
    let output = Command::new("gh")
        .args(["api", "--hostname", "github.com", "--method", "POST", "user/repos", "-f"])
        .arg(&name_arg)
        .arg("-F")
        .arg(&private_arg)
        .stdin(Stdio::null())
        .output()
        .await
        .map_err(|_| "GitHub CLI is not installed".to_string())?;
    if !output.status.success() {
        return Err("GitHub could not create the repository".to_string());
    }
    serde_json::from_slice::<GithubRepositoryPayload>(&output.stdout)
        .map(|repository| GithubRepository {
            name: repository.name,
            full_name: repository.full_name,
            private: repository.private,
            html_url: repository.html_url,
            default_branch: repository.default_branch,
            owner_login: repository.owner.login,
        })
        .map_err(|_| "GitHub returned an invalid repository response".to_string())
}

async fn api(endpoint: &str) -> Result<Vec<u8>, String> {
    let output = Command::new("gh")
        .args(["api", "--hostname", "github.com", endpoint])
        .stdin(Stdio::null())
        .output()
        .await
        .map_err(|_| "GitHub CLI is not installed".to_string())?;

    if output.status.success() {
        Ok(output.stdout)
    } else {
        Err("GitHub is not authenticated".to_string())
    }
}

fn unavailable(error: &str) -> GithubAccountStatus {
    GithubAccountStatus {
        authenticated: false,
        account: None,
        error: Some(error.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn account_payload_maps_to_safe_public_fields() {
        let body = br#"{
            "login":"foxen",
            "name":"Foxen",
            "avatar_url":"https://avatars.example/foxen.png",
            "html_url":"https://github.com/foxen"
        }"#;
        let payload: GithubAccountPayload = serde_json::from_slice(body).unwrap();
        assert_eq!(payload.login, "foxen");
        assert_eq!(payload.name.as_deref(), Some("Foxen"));
    }

    #[test]
    fn repository_payload_keeps_owner_and_visibility() {
        let body = br#"{
            "name":"fennec",
            "full_name":"foxen/fennec",
            "private":true,
            "html_url":"https://github.com/foxen/fennec",
            "default_branch":"main",
            "owner":{"login":"foxen"}
        }"#;
        let payload: GithubRepositoryPayload = serde_json::from_slice(body).unwrap();
        assert_eq!(payload.full_name, "foxen/fennec");
        assert!(payload.private);
        assert_eq!(payload.owner.login, "foxen");
    }
}
