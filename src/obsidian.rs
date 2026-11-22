use serde::{Deserialize, Serialize};
use std::env;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Component, Path, PathBuf};

const MAX_TITLE_CHARS: usize = 160;
const MAX_FOLDER_CHARS: usize = 240;
const MAX_CONTENT_CHARS: usize = 200_000;

#[derive(Clone, Debug, Serialize)]
pub struct ObsidianStatus {
    pub configured: bool,
    pub vault: Option<String>,
    pub message: String,
}

#[derive(Debug, Deserialize)]
pub struct WriteNoteRequest {
    pub title: String,
    pub content: String,
    #[serde(default)]
    pub folder: Option<String>,
    #[serde(default)]
    pub overwrite: bool,
}

#[derive(Debug, Serialize)]
pub struct WriteNoteResponse {
    pub path: String,
    pub created: bool,
    pub bytes: usize,
}

pub fn status() -> ObsidianStatus {
    match configured_vault() {
        Ok(vault) => ObsidianStatus {
            configured: true,
            vault: Some(vault.display().to_string()),
            message: "Fennec writes to this local vault; Obsidian handles account login and Sync.".to_string(),
        },
        Err(error) => ObsidianStatus {
            configured: false,
            vault: None,
            message: error,
        },
    }
}

pub fn write_note(request: WriteNoteRequest) -> Result<WriteNoteResponse, String> {
    let vault = configured_vault()?;
    let title = clean_title(&request.title)?;
    let folder = clean_folder(request.folder.as_deref().unwrap_or(""))?;
    if request.content.chars().count() > MAX_CONTENT_CHARS {
        return Err(format!("content must be at most {MAX_CONTENT_CHARS} characters"));
    }

    let parent = vault.join(&folder);
    fs::create_dir_all(&parent).map_err(|error| format!("could not create note folder: {error}"))?;
    let parent = fs::canonicalize(&parent).map_err(|error| format!("could not resolve note folder: {error}"))?;
    ensure_inside(&vault, &parent)?;

    let file_name = if title.to_ascii_lowercase().ends_with(".md") {
        title
    } else {
        format!("{title}.md")
    };
    let target = parent.join(file_name);
    let existed = target.exists();
    if existed && !request.overwrite {
        return Err(format!("note already exists: {}", display_path(&vault, &target)));
    }
    if existed {
        let resolved = fs::canonicalize(&target).map_err(|error| format!("could not resolve existing note: {error}"))?;
        ensure_inside(&vault, &resolved)?;
    }

    let mut options = OpenOptions::new();
    options.write(true).create(true);
    if request.overwrite {
        options.truncate(true);
    } else {
        options.create_new(true);
    }
    let mut file = options.open(&target).map_err(|error| format!("could not open note: {error}"))?;
    file.write_all(request.content.as_bytes())
        .map_err(|error| format!("could not write note: {error}"))?;

    Ok(WriteNoteResponse {
        path: display_path(&vault, &target),
        created: !existed,
        bytes: request.content.len(),
    })
}

fn configured_vault() -> Result<PathBuf, String> {
    let raw = env::var_os("FENNEC_OBSIDIAN_VAULT")
        .or_else(|| env::var_os("OBSIDIAN_VAULT"))
        .ok_or_else(|| "set FENNEC_OBSIDIAN_VAULT to an Obsidian vault folder".to_string())?;
    let vault = fs::canonicalize(raw).map_err(|error| format!("could not open Obsidian vault: {error}"))?;
    if !vault.is_dir() {
        return Err("configured Obsidian vault is not a directory".to_string());
    }
    Ok(vault)
}

fn clean_title(value: &str) -> Result<String, String> {
    let title = value.trim();
    if title.is_empty() || title == "." || title == ".." {
        return Err("title must not be empty".to_string());
    }
    if title.chars().count() > MAX_TITLE_CHARS {
        return Err(format!("title must be at most {MAX_TITLE_CHARS} characters"));
    }
    if title.contains(['/', '\\', '\0', ':', '*', '?', '"', '<', '>', '|']) {
        return Err("title contains a forbidden filename character".to_string());
    }
    let title = title.trim_end_matches([' ', '.']);
    if title.is_empty() {
        return Err("title must contain a filename".to_string());
    }
    Ok(title.to_string())
}

fn clean_folder(value: &str) -> Result<String, String> {
    if value.chars().count() > MAX_FOLDER_CHARS {
        return Err(format!("folder must be at most {MAX_FOLDER_CHARS} characters"));
    }
    let path = Path::new(value);
    for component in path.components() {
        match component {
            Component::Normal(_) | Component::CurDir => {}
            Component::ParentDir | Component::RootDir | Component::Prefix(_) => {
                return Err("folder must stay inside the Obsidian vault".to_string());
            }
        }
    }
    if value.contains('\0') {
        return Err("folder contains an invalid character".to_string());
    }
    Ok(value.to_string())
}

fn ensure_inside(root: &Path, path: &Path) -> Result<(), String> {
    if path.starts_with(root) {
        Ok(())
    } else {
        Err("path escapes the configured Obsidian vault".to_string())
    }
}

fn display_path(root: &Path, path: &Path) -> String {
    path.strip_prefix(root)
        .unwrap_or(path)
        .to_string_lossy()
        .replace('\\', "/")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Mutex, OnceLock};

    fn env_lock() -> &'static Mutex<()> {
        static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
        LOCK.get_or_init(|| Mutex::new(()))
    }

    #[test]
    fn writes_a_markdown_note_without_overwriting() {
        let _guard = env_lock().lock().unwrap();
        let temp = tempfile::tempdir().unwrap();
        unsafe { env::set_var("FENNEC_OBSIDIAN_VAULT", temp.path()); }

        let result = write_note(WriteNoteRequest {
            title: "Daily note".to_string(),
            content: "hello".to_string(),
            folder: Some("Fennec".to_string()),
            overwrite: false,
        }).unwrap();

        assert_eq!(result.path, "Fennec/Daily note.md");
        assert_eq!(fs::read_to_string(temp.path().join("Fennec/Daily note.md")).unwrap(), "hello");
        assert!(write_note(WriteNoteRequest {
            title: "Daily note".to_string(),
            content: "changed".to_string(),
            folder: Some("Fennec".to_string()),
            overwrite: false,
        }).is_err());
        unsafe { env::remove_var("FENNEC_OBSIDIAN_VAULT"); }
    }

    #[test]
    fn rejects_escape_and_filename_injection() {
        assert!(clean_folder("../outside").is_err());
        assert!(clean_title("../outside").is_err());
        assert!(clean_title("note:secret").is_err());
    }
}
