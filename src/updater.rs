//! Auto-update system: silent background updates from GitHub releases,
//! plus `fennec-agent update --experimental` for devs to pull from main branch.
//!
//! Normal mode checks tagged releases and updates silently in the background.
//! Experimental mode pulls the latest commit from main/origin for developers.
//! Every download is verified against a SHA-256 checksum before applying.

use std::path::PathBuf;
use std::time::Duration;

use serde::{Deserialize, Serialize};

/// GitHub repository for releases
const GITHUB_REPO: &str = "Liso7150/fennec-coding-agent";

/// Update channel
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[allow(dead_code)]
pub enum Channel {
    /// Stable releases from GitHub tags
    Stable,
    /// Latest commits from main branch
    Experimental,
}

/// Platform triple for binary selection
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Platform {
    pub os: String,
    pub arch: String,
    pub ext: String,
}

impl Platform {
    /// Detect the current platform
    pub fn current() -> Self {
        let os = if cfg!(target_os = "windows") {
            "windows"
        } else if cfg!(target_os = "macos") {
            "macos"
        } else {
            "linux"
        }
        .to_string();

        let arch = if cfg!(target_arch = "x86_64") {
            "x86_64"
        } else if cfg!(target_arch = "aarch64") {
            "aarch64"
        } else {
            "unknown"
        }
        .to_string();

        let ext = if cfg!(target_os = "windows") {
            "exe"
        } else {
            "bin"
        }
        .to_string();

        Platform { os, arch, ext }
    }

    /// Asset name for this platform (e.g., "fennec-agent-windows-x86_64.exe")
    pub fn asset_name(&self, base: &str) -> String {
        if self.ext == "exe" {
            format!("{}-{}-{}.{}", base, self.os, self.arch, self.ext)
        } else {
            format!("{}-{}-{}", base, self.os, self.arch)
        }
    }
}

/// Release information from GitHub
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Release {
    pub version: String,
    pub tag: String,
    pub published_at: String,
    pub assets: Vec<Asset>,
    pub checksums_url: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Asset {
    pub name: String,
    pub download_url: String,
    pub size: u64,
}

/// Update status
#[derive(Debug, Clone, Serialize, Deserialize)]
#[allow(dead_code)]
pub enum UpdateStatus {
    /// No update available
    UpToDate,
    /// Update downloaded and ready to apply
    UpdateReady { version: String, path: PathBuf },
    /// Update applied, restart required
    Applied { version: String },
    /// Error during update
    Error(String),
}

/// `Some(true)` when `candidate` is a strictly newer dotted version than
/// `current`, `Some(false)` when it is the same or older, and `None` when
/// either side is not three plain numbers (a `dev-<sha>` tag, say) so the
/// caller refuses to guess.
///
/// This exists because the published releases run *behind* a working tree: a
/// 1.0.0 install must not pull the 0.9.0 assets just because the tag differs.
pub fn is_newer(candidate: &str, current: &str) -> Option<bool> {
    fn parts(version: &str) -> Option<[u64; 3]> {
        let version = version.trim().trim_start_matches('v');
        let mut numbers = [0u64; 3];
        for (field, slot) in version.split('.').zip(numbers.iter_mut()) {
            *slot = field.parse().ok()?;
        }
        Some(numbers)
    }
    let (candidate, current) = (parts(candidate)?, parts(current)?);
    Some(candidate > current)
}

/// Release asset that carries the SHA-256 digests of the other assets.
pub const CHECKSUMS_ASSET: &str = "SHA256SUMS";

/// Check for updates from GitHub releases
pub async fn check_stable(current_version: &str) -> Result<Option<Release>, String> {
    let url = format!(
        "https://api.github.com/repos/{}/releases/latest",
        GITHUB_REPO
    );
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .user_agent("fennec-updater")
        .build()
        .map_err(|e| format!("HTTP client: {e}"))?;

    let resp = client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("GitHub API: {e}"))?;

    if !resp.status().is_success() {
        return Err(format!("GitHub API returned {}", resp.status()));
    }

    let release: GitHubRelease = resp
        .json()
        .await
        .map_err(|e| format!("Parse release: {e}"))?;

    // Only a release newer than the running binary is an update. The published
    // ladder runs behind a working tree, so an unequal tag is not enough.
    let version = release.tag_name.trim_start_matches('v').to_string();
    if is_newer(&version, current_version) != Some(true) {
        return Ok(None);
    }

    let assets: Vec<Asset> = release
        .assets
        .into_iter()
        .map(|a| Asset {
            name: a.name,
            download_url: a.browser_download_url,
            size: a.size,
        })
        .collect();
    // The publisher's digest list. A binary cannot be installed unless this
    // asset exists and carries a valid entry for that exact binary.
    let checksums_url = assets
        .iter()
        .find(|a| a.name == CHECKSUMS_ASSET)
        .map(|a| a.download_url.clone());

    Ok(Some(Release {
        version,
        tag: release.tag_name,
        published_at: release.published_at,
        assets,
        checksums_url,
    }))
}

/// The expected digest of `asset_name`, read from the release's checksums
/// asset. A missing checksums asset or an unreadable manifest is an error;
/// `None` means the manifest has no entry for that exact basename.
async fn checksum_for(release: &Release, asset_name: &str) -> Result<Option<String>, String> {
    let url = release
        .checksums_url
        .as_deref()
        .ok_or_else(|| format!("Release is missing {CHECKSUMS_ASSET}"))?;
    let text = fetch_text(url).await?;
    parse_checksum(&text, asset_name)
}

fn parse_checksum(text: &str, asset_name: &str) -> Result<Option<String>, String> {
    let mut found = None;
    for (index, line) in text.lines().enumerate() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let mut fields = line.split_whitespace();
        let digest = fields
            .next()
            .ok_or_else(|| format!("Parse {CHECKSUMS_ASSET} line {}", index + 1))?;
        let file = fields
            .next()
            .ok_or_else(|| format!("Parse {CHECKSUMS_ASSET} line {}", index + 1))?;
        if fields.next().is_some() {
            return Err(format!(
                "Parse {CHECKSUMS_ASSET} line {}: expected two fields",
                index + 1
            ));
        }
        let file = file.strip_prefix('*').unwrap_or(file);
        let digest = normalize_checksum(digest)
            .map_err(|e| format!("Parse {CHECKSUMS_ASSET} line {}: {e}", index + 1))?;
        if file == asset_name {
            if found.is_some() {
                return Err(format!(
                    "Duplicate {CHECKSUMS_ASSET} entry for {asset_name}"
                ));
            }
            found = Some(digest);
        }
    }
    Ok(found)
}

fn normalize_checksum(checksum: &str) -> Result<String, String> {
    if checksum.len() != 64 || !checksum.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err("Checksum must be exactly 64 hexadecimal characters".to_string());
    }
    Ok(checksum.to_ascii_lowercase())
}

/// Download a release binary only after its exact manifest entry and digest
/// have been verified. Staging and replacement happen only after this succeeds.
async fn download_release_asset(release: &Release, asset_name: &str) -> Result<Vec<u8>, String> {
    let asset = release
        .assets
        .iter()
        .find(|asset| asset.name == asset_name)
        .ok_or_else(|| format!("No asset for platform: {asset_name}"))?;
    let checksum = checksum_for(release, asset_name)
        .await?
        .ok_or_else(|| format!("{CHECKSUMS_ASSET} has no entry for {asset_name}"))?;
    download_asset(&asset.download_url, Some(&checksum)).await
}

async fn fetch_text(url: &str) -> Result<String, String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .user_agent("fennec-updater")
        .build()
        .map_err(|e| format!("HTTP client: {e}"))?;
    let resp = client
        .get(url)
        .send()
        .await
        .map_err(|e| format!("Download checksums: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!(
            "Download {CHECKSUMS_ASSET} returned {}",
            resp.status()
        ));
    }
    let bytes = resp
        .bytes()
        .await
        .map_err(|e| format!("Read checksums: {e}"))?;
    String::from_utf8(bytes.to_vec()).map_err(|e| format!("Parse {CHECKSUMS_ASSET}: {e}"))
}

/// Check for experimental updates from main branch
pub async fn check_experimental() -> Result<Option<Release>, String> {
    let url = format!("https://api.github.com/repos/{}/commits/main", GITHUB_REPO);
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .user_agent("fennec-updater")
        .build()
        .map_err(|e| format!("HTTP client: {e}"))?;

    let resp = client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("GitHub API: {e}"))?;

    if !resp.status().is_success() {
        return Err(format!("GitHub API returned {}", resp.status()));
    }

    let commit: GitHubCommit = resp
        .json()
        .await
        .map_err(|e| format!("Parse commit: {e}"))?;

    // For experimental, we always "update" to the latest commit
    let short_sha = &commit.sha[..7];

    Ok(Some(Release {
        version: format!("dev-{}", short_sha),
        tag: commit.sha.clone(),
        published_at: commit.commit.author.date,
        assets: vec![],
        checksums_url: None,
    }))
}

/// Download an asset, requiring a valid digest whenever one is supplied.
/// `None` is only for metadata such as the checksums manifest itself.
pub async fn download_asset(url: &str, expected_checksum: Option<&str>) -> Result<Vec<u8>, String> {
    let expected_checksum = expected_checksum.map(normalize_checksum).transpose()?;
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(300))
        .user_agent("fennec-updater")
        .build()
        .map_err(|e| format!("HTTP client: {e}"))?;

    let resp = client
        .get(url)
        .send()
        .await
        .map_err(|e| format!("Download: {e}"))?;

    if !resp.status().is_success() {
        return Err(format!("Download returned {}", resp.status()));
    }

    let bytes = resp
        .bytes()
        .await
        .map_err(|e| format!("Read bytes: {e}"))?
        .to_vec();

    if let Some(expected) = expected_checksum {
        let actual = sha256_hex(&bytes);
        if actual != expected {
            return Err(format!(
                "Checksum mismatch: expected {}, got {}",
                expected, actual
            ));
        }
    }

    Ok(bytes)
}

/// Compute SHA-256 checksum of bytes
fn sha256_hex(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    let result = hasher.finalize();
    hex::encode(result)
}

/// Pre-start update check: runs once before the app starts, only applies if a
/// newer release exists *and* publishes a binary for this platform.
pub async fn pre_start_update(current_version: &str) -> Option<String> {
    match check_stable(current_version).await {
        Ok(Some(release)) => {
            let asset_name = Platform::current().asset_name("fennec-agent");
            if !release.assets.iter().any(|a| a.name == asset_name) {
                // Releases carry no per-platform binary; `fennec update`, which
                // fast-forwards the checkout, is what moves this build. Saying
                // so is an advisory, not a failed update.
                eprintln!(
                    "[updater] v{} is newer than {}, but publishes no {asset_name}; \
                     run `fennec update` to fast-forward the checkout.",
                    release.version, current_version
                );
                return None;
            }
            eprintln!(
                "[updater] New version available: {} (current: {})",
                release.version, current_version
            );
            match apply_update(&release, &asset_name).await {
                Ok(()) => {
                    eprintln!(
                        "[updater] Updated to {} - restart required",
                        release.version
                    );
                    Some(release.version)
                }
                Err(e) => {
                    eprintln!("[updater] Failed to apply update: {}", e);
                    None
                }
            }
        }
        Ok(None) => {
            // Up to date, no output
            None
        }
        Err(e) => {
            eprintln!("[updater] Check failed: {}", e);
            None
        }
    }
}

async fn apply_update(release: &Release, asset_name: &str) -> Result<(), String> {
    if !release.assets.iter().any(|asset| asset.name == asset_name) {
        return Err(format!("No asset for platform: {asset_name}"));
    }

    let bytes = download_release_asset(release, asset_name).await?;

    // Write to temporary location only after verification.
    let temp_path = std::env::temp_dir().join(&asset_name);
    std::fs::write(&temp_path, &bytes).map_err(|e| format!("Write temp: {e}"))?;

    // Apply (platform-specific)
    replace_binary(&temp_path).await?;

    Ok(())
}

async fn replace_binary(new_path: &std::path::Path) -> Result<(), String> {
    let current_exe = std::env::current_exe().map_err(|e| format!("Current exe: {e}"))?;

    // On Windows, we can't replace a running binary directly.
    // Rename the current binary, then move the new one into place.
    if cfg!(target_os = "windows") {
        let backup = current_exe.with_extension("exe.old");
        if backup.exists() {
            std::fs::remove_file(&backup).map_err(|e| format!("Remove backup: {e}"))?;
        }
        std::fs::rename(&current_exe, &backup).map_err(|e| format!("Backup current: {e}"))?;
        std::fs::copy(new_path, &current_exe).map_err(|e| format!("Install new: {e}"))?;
    } else {
        // On Unix, we can replace directly
        std::fs::copy(new_path, &current_exe).map_err(|e| format!("Replace: {e}"))?;
        // Make executable
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let perms = std::fs::Permissions::from_mode(0o755);
            std::fs::set_permissions(&current_exe, perms).map_err(|e| format!("Chmod: {e}"))?;
        }
    }

    Ok(())
}

// GitHub API response types
#[derive(Deserialize)]
struct GitHubRelease {
    tag_name: String,
    published_at: String,
    assets: Vec<GitHubAsset>,
}

#[derive(Deserialize)]
struct GitHubAsset {
    name: String,
    browser_download_url: String,
    size: u64,
}

#[derive(Deserialize)]
struct GitHubCommit {
    sha: String,
    commit: GitHubCommitDetail,
}

#[derive(Deserialize)]
struct GitHubCommitDetail {
    author: GitHubAuthor,
}

#[derive(Deserialize)]
struct GitHubAuthor {
    date: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn platform_current_detects_os() {
        let platform = Platform::current();
        assert!(!platform.os.is_empty());
        assert!(!platform.arch.is_empty());
        assert!(!platform.ext.is_empty());

        if cfg!(target_os = "windows") {
            assert_eq!(platform.os, "windows");
            assert_eq!(platform.ext, "exe");
        } else if cfg!(target_os = "macos") {
            assert_eq!(platform.os, "macos");
            assert_eq!(platform.ext, "bin");
        } else if cfg!(target_os = "linux") {
            assert_eq!(platform.os, "linux");
            assert_eq!(platform.ext, "bin");
        }
    }

    #[test]
    fn a_higher_release_is_an_update_and_an_older_one_is_not() {
        assert_eq!(is_newer("1.1.0", "1.0.0"), Some(true));
        assert_eq!(is_newer("1.10.0", "1.9.0"), Some(true));
        assert_eq!(is_newer("v1.1.0", "1.0.0"), Some(true));
        assert_eq!(is_newer("1.0.0", "1.0.0"), Some(false));
        assert_eq!(is_newer("0.9.0", "1.0.0"), Some(false));
        assert_eq!(is_newer("1.0", "1.0.0"), Some(false));
    }

    #[test]
    fn a_tag_the_comparator_does_not_understand_offers_nothing() {
        assert_eq!(is_newer("dev-abc1234", "1.0.0"), None);
        assert_eq!(is_newer("1.0.0", "1.0.0-rc1"), None);
    }

    #[test]
    fn platform_asset_name_windows() {
        let platform = Platform {
            os: "windows".to_string(),
            arch: "x86_64".to_string(),
            ext: "exe".to_string(),
        };
        assert_eq!(
            platform.asset_name("fennec-agent"),
            "fennec-agent-windows-x86_64.exe"
        );
    }

    #[test]
    fn platform_asset_name_unix() {
        let platform = Platform {
            os: "linux".to_string(),
            arch: "x86_64".to_string(),
            ext: "bin".to_string(),
        };
        assert_eq!(
            platform.asset_name("fennec-agent"),
            "fennec-agent-linux-x86_64"
        );
    }

    #[test]
    fn sha256_hex_computes_correct_hash() {
        let empty_hash = sha256_hex(b"");
        assert_eq!(
            empty_hash,
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );

        let hello_hash = sha256_hex(b"hello");
        assert_eq!(
            hello_hash,
            "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"
        );
    }

    #[test]
    fn channel_round_trips() {
        let stable = Channel::Stable;
        let json = serde_json::to_string(&stable).unwrap();
        let decoded: Channel = serde_json::from_str(&json).unwrap();
        assert_eq!(stable, decoded);

        let experimental = Channel::Experimental;
        let json = serde_json::to_string(&experimental).unwrap();
        let decoded: Channel = serde_json::from_str(&json).unwrap();
        assert_eq!(experimental, decoded);
    }

    #[test]
    fn release_serialization() {
        let release = Release {
            version: "1.0.0".to_string(),
            tag: "v1.0.0".to_string(),
            published_at: "2026-11-17T00:00:00Z".to_string(),
            assets: vec![Asset {
                name: "fennec-agent-windows-x86_64.exe".to_string(),
                download_url: "https://example.com/download".to_string(),
                size: 1024,
            }],
            checksums_url: Some("https://example.com/checksums".to_string()),
        };
        let json = serde_json::to_string(&release).unwrap();
        let decoded: Release = serde_json::from_str(&json).unwrap();
        assert_eq!(decoded.version, "1.0.0");
        assert_eq!(decoded.tag, "v1.0.0");
        assert_eq!(decoded.assets.len(), 1);
        assert_eq!(decoded.assets[0].size, 1024);
    }

    const BINARY: &str = "fennec-agent-windows-x86_64.exe";

    fn test_release(server_url: Option<String>) -> Release {
        let server_url = server_url.unwrap_or_else(|| "http://127.0.0.1".to_string());
        Release {
            version: "1.0.1".to_string(),
            tag: "v1.0.1".to_string(),
            published_at: "2026-11-24T00:00:00Z".to_string(),
            assets: vec![Asset {
                name: BINARY.to_string(),
                download_url: format!("{server_url}/binary"),
                size: 5,
            }],
            checksums_url: Some(format!("{server_url}/SHA256SUMS")),
        }
    }

    fn serve(
        responses: Vec<(&'static str, &'static str, Vec<u8>)>,
    ) -> (
        String,
        std::thread::JoinHandle<()>,
        std::sync::Arc<std::sync::Mutex<Vec<String>>>,
    ) {
        use std::io::{BufRead, BufReader, Write};
        use std::net::TcpListener;
        use std::sync::{Arc, Mutex};

        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let paths = Arc::new(Mutex::new(Vec::new()));
        let requested = paths.clone();
        let handle = std::thread::spawn(move || {
            for (expected_path, status, body) in responses {
                let (mut stream, _) = listener.accept().unwrap();
                let mut reader = BufReader::new(stream.try_clone().unwrap());
                let mut request = String::new();
                loop {
                    let mut line = String::new();
                    if reader.read_line(&mut line).unwrap() == 0 || line == "\r\n" {
                        break;
                    }
                    request.push_str(&line);
                }
                let path = request
                    .lines()
                    .next()
                    .and_then(|line| line.split_whitespace().nth(1))
                    .unwrap_or_default();
                requested.lock().unwrap().push(path.to_string());
                assert_eq!(path, expected_path);
                write!(
                    stream,
                    "HTTP/1.1 {status}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    body.len()
                )
                .unwrap();
                stream.write_all(&body).unwrap();
                stream.flush().unwrap();
            }
        });
        (format!("http://{address}"), handle, paths)
    }

    #[test]
    fn checksum_manifest_requires_an_exact_basename_and_normalizes_case() {
        let digest = "2CF24DBA5FB0A30E26E83B2AC5B9E29E1B161E5C1FA7425E73043362938B9824";
        let text = format!("{}  other.exe\n{} *{BINARY}\n", "a".repeat(64), digest);
        assert_eq!(
            parse_checksum(&text, BINARY).unwrap(),
            Some(digest.to_ascii_lowercase())
        );
        for file in [
            format!("./{BINARY}"),
            format!("dir/{BINARY}"),
            format!("{BINARY}.bak"),
            format!("prefix-{BINARY}"),
        ] {
            let text = format!("{digest}  {file}\n");
            assert_eq!(parse_checksum(&text, BINARY).unwrap(), None);
        }
    }

    #[test]
    fn checksum_manifest_rejects_malformed_or_ambiguous_entries() {
        for digest in ["a".repeat(63), "a".repeat(65), "g".repeat(64)] {
            let text = format!("{digest}  {BINARY}\n");
            assert!(parse_checksum(&text, BINARY).is_err());
        }
        for text in [
            "missing-fields\n".to_string(),
            format!("{}  other.exe extra\n", "a".repeat(64)),
            format!(
                "{}  {BINARY}\n{} *{BINARY}\n",
                "a".repeat(64),
                "b".repeat(64)
            ),
        ] {
            assert!(parse_checksum(&text, BINARY).is_err());
        }
    }

    #[tokio::test]
    async fn binary_download_requires_the_checksums_asset() {
        let mut release = test_release(None);
        release.checksums_url = None;
        let error = download_release_asset(&release, BINARY).await.unwrap_err();
        assert!(error.contains("missing SHA256SUMS"), "{error}");
    }

    #[tokio::test]
    async fn a_missing_entry_stops_before_the_binary_download() {
        let body = format!("{}  other.exe\n", "a".repeat(64));
        let (url, server, paths) = serve(vec![("/SHA256SUMS", "200 OK", body.into_bytes())]);
        let error = download_release_asset(&test_release(Some(url)), BINARY)
            .await
            .unwrap_err();
        server.join().unwrap();
        assert!(error.contains("no entry for"), "{error}");
        assert_eq!(*paths.lock().unwrap(), ["/SHA256SUMS"]);
    }

    #[tokio::test]
    async fn malformed_manifest_and_fetch_failures_stop_before_the_binary_download() {
        for (status, body) in [
            ("404 Not Found", b"missing".to_vec()),
            (
                "200 OK",
                b"short  fennec-agent-windows-x86_64.exe\n".to_vec(),
            ),
            ("200 OK", vec![0xff, 0xfe]),
        ] {
            let (url, server, paths) = serve(vec![("/SHA256SUMS", status, body)]);
            let error = download_release_asset(&test_release(Some(url)), BINARY)
                .await
                .unwrap_err();
            server.join().unwrap();
            assert!(error.contains("SHA256SUMS"), "{error}");
            assert_eq!(*paths.lock().unwrap(), ["/SHA256SUMS"]);
        }
    }

    #[tokio::test]
    async fn a_mismatched_binary_is_never_returned_for_replacement() {
        let manifest = format!("{}  {BINARY}\n", sha256_hex(b"expected"));
        let (url, server, paths) = serve(vec![
            ("/SHA256SUMS", "200 OK", manifest.into_bytes()),
            ("/binary", "200 OK", b"tampered".to_vec()),
        ]);
        let error = download_release_asset(&test_release(Some(url)), BINARY)
            .await
            .unwrap_err();
        server.join().unwrap();
        assert!(error.contains("Checksum mismatch"), "{error}");
        assert_eq!(*paths.lock().unwrap(), ["/SHA256SUMS", "/binary"]);
    }

    #[tokio::test]
    async fn a_matching_uppercase_digest_allows_the_binary() {
        let manifest = format!("{} *{BINARY}\n", sha256_hex(b"hello").to_ascii_uppercase());
        let (url, server, paths) = serve(vec![
            ("/SHA256SUMS", "200 OK", manifest.into_bytes()),
            ("/binary", "200 OK", b"hello".to_vec()),
        ]);
        let bytes = download_release_asset(&test_release(Some(url)), BINARY)
            .await
            .unwrap();
        server.join().unwrap();
        assert_eq!(bytes, b"hello");
        assert_eq!(*paths.lock().unwrap(), ["/SHA256SUMS", "/binary"]);
    }

    #[tokio::test]
    async fn a_supplied_digest_must_be_well_formed() {
        let error = download_asset("http://127.0.0.1:0", Some("not-a-digest"))
            .await
            .unwrap_err();
        assert!(error.contains("64 hexadecimal"), "{error}");
    }
}
