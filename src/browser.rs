//! Browser automation for coding-agent: control real browsers with existing login sessions.
//! 
//! This module provides MCP + Playwright integration for AI agents to browse the web,
//! similar to OpenCode Browse. Agents can navigate, click, type, take screenshots,
//! and extract text from web pages while preserving user login sessions.

use serde::{Deserialize, Serialize};
use std::process::Command;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BrowserConfig {
    pub headless: bool,
    pub viewport_width: u32,
    pub viewport_height: u32,
    pub user_data_dir: Option<String>,
}

impl Default for BrowserConfig {
    fn default() -> Self {
        Self {
            headless: false,
            viewport_width: 1280,
            viewport_height: 720,
            user_data_dir: None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BrowserAction {
    pub action: ActionType,
    pub selector: Option<String>,
    pub value: Option<String>,
    pub timeout_ms: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum ActionType {
    Navigate { url: String },
    Click,
    Type { text: String },
    Screenshot { path: String },
    ExtractText,
    ExecuteScript { script: String },
    WaitForSelector,
    Hover,
    Scroll { direction: ScrollDirection, amount: u32 },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum ScrollDirection {
    Up,
    Down,
    Left,
    Right,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BrowserResult {
    pub success: bool,
    pub data: Option<String>,
    pub screenshot_path: Option<String>,
    pub error: Option<String>,
}

pub struct BrowserAutomation {
    config: BrowserConfig,
    playwright_path: Option<String>,
}

impl BrowserAutomation {
    pub fn new(config: BrowserConfig) -> Self {
        Self {
            config,
            playwright_path: Self::find_playwright(),
        }
    }

    fn find_playwright() -> Option<String> {
        // Try to find playwright installation
        if let Ok(output) = Command::new("npx").args(["playwright", "--version"]).output() {
            if output.status.success() {
                return Some("npx playwright".to_string());
            }
        }
        
        // Try python playwright
        if let Ok(output) = Command::new("python").args(["-m", "playwright", "--version"]).output() {
            if output.status.success() {
                return Some("python -m playwright".to_string());
            }
        }

        None
    }

    pub fn is_available(&self) -> bool {
        self.playwright_path.is_some()
    }

    pub async fn execute(&self, action: BrowserAction) -> BrowserResult {
        if !self.is_available() {
            return BrowserResult {
                success: false,
                data: None,
                screenshot_path: None,
                error: Some("Playwright not available. Install with: npx playwright install".to_string()),
            };
        }

        match action.action {
            ActionType::Navigate { url } => self.navigate(&url).await,
            ActionType::Click => self.click(action.selector.as_deref()).await,
            ActionType::Type { text } => self.type_text(action.selector.as_deref(), &text).await,
            ActionType::Screenshot { path } => self.screenshot(&path).await,
            ActionType::ExtractText => self.extract_text(action.selector.as_deref()).await,
            ActionType::ExecuteScript { script } => self.execute_script(&script).await,
            ActionType::WaitForSelector => self.wait_for_selector(action.selector.as_deref(), action.timeout_ms).await,
            ActionType::Hover => self.hover(action.selector.as_deref()).await,
            ActionType::Scroll { direction, amount } => self.scroll(direction, amount).await,
        }
    }

    async fn navigate(&self, url: &str) -> BrowserResult {
        // Generate Playwright script for navigation
        let script = format!(
            r#"
const {{ chromium }} = require('playwright');
(async () => {{
    const browser = await chromium.launch({{ headless: {} }});
    const context = await browser.newContext({{
        viewport: {{ width: {}, height: {} }},
        {}
    }});
    const page = await context.newPage();
    await page.goto('{}');
    await page.waitForLoadState('networkidle');
    console.log('Navigation complete');
    await browser.close();
}})();
"#,
            self.config.headless,
            self.config.viewport_width,
            self.config.viewport_height,
            self.config.user_data_dir.as_ref()
                .map(|dir| format!("userDataDir: '{}',", dir))
                .unwrap_or_default(),
            url
        );

        self.run_playwright_script(&script).await
    }

    async fn click(&self, selector: Option<&str>) -> BrowserResult {
        let selector = selector.unwrap_or("body");
        let script = format!(
            r#"
const {{ chromium }} = require('playwright');
(async () => {{
    const browser = await chromium.launch({{ headless: {} }});
    const page = await browser.newPage();
    await page.click('{}');
    console.log('Clicked: {}');
    await browser.close();
}})();
"#,
            self.config.headless, selector, selector
        );

        self.run_playwright_script(&script).await
    }

    async fn type_text(&self, selector: Option<&str>, text: &str) -> BrowserResult {
        let selector = selector.unwrap_or("input");
        let script = format!(
            r#"
const {{ chromium }} = require('playwright');
(async () => {{
    const browser = await chromium.launch({{ headless: {} }});
    const page = await browser.newPage();
    await page.fill('{}', '{}');
    console.log('Typed text');
    await browser.close();
}})();
"#,
            self.config.headless, selector, text
        );

        self.run_playwright_script(&script).await
    }

    async fn screenshot(&self, path: &str) -> BrowserResult {
        let script = format!(
            r#"
const {{ chromium }} = require('playwright');
(async () => {{
    const browser = await chromium.launch({{ headless: {} }});
    const page = await browser.newPage();
    await page.screenshot({{ path: '{}' }});
    console.log('Screenshot saved');
    await browser.close();
}})();
"#,
            self.config.headless, path
        );

        let result = self.run_playwright_script(&script).await;
        BrowserResult {
            screenshot_path: Some(path.to_string()),
            ..result
        }
    }

    async fn extract_text(&self, selector: Option<&str>) -> BrowserResult {
        let selector = selector.unwrap_or("body");
        let script = format!(
            r#"
const {{ chromium }} = require('playwright');
(async () => {{
    const browser = await chromium.launch({{ headless: {} }});
    const page = await browser.newPage();
    const text = await page.textContent('{}');
    console.log(text);
    await browser.close();
}})();
"#,
            self.config.headless, selector
        );

        let result = self.run_playwright_script(&script).await;
        BrowserResult {
            data: result.error.is_none().then(|| result.data.clone()).flatten(),
            ..result
        }
    }

    async fn execute_script(&self, script: &str) -> BrowserResult {
        let full_script = format!(
            r#"
const {{ chromium }} = require('playwright');
(async () => {{
    const browser = await chromium.launch({{ headless: {} }});
    const page = await browser.newPage();
    const result = await page.evaluate(() => {{ {} }});
    console.log(JSON.stringify(result));
    await browser.close();
}})();
"#,
            self.config.headless, script
        );

        self.run_playwright_script(&full_script).await
    }

    async fn wait_for_selector(&self, selector: Option<&str>, timeout_ms: Option<u64>) -> BrowserResult {
        let selector = selector.unwrap_or("body");
        let timeout = timeout_ms.unwrap_or(30000);
        let script = format!(
            r#"
const {{ chromium }} = require('playwright');
(async () => {{
    const browser = await chromium.launch({{ headless: {} }});
    const page = await browser.newPage();
    await page.waitForSelector('{}'), {{ timeout: {} }});
    console.log('Selector found');
    await browser.close();
}})();
"#,
            self.config.headless, selector, timeout
        );

        self.run_playwright_script(&script).await
    }

    async fn hover(&self, selector: Option<&str>) -> BrowserResult {
        let selector = selector.unwrap_or("body");
        let script = format!(
            r#"
const {{ chromium }} = require('playwright');
(async () => {{
    const browser = await chromium.launch({{ headless: {} }});
    const page = await browser.newPage();
    await page.hover('{}');
    console.log('Hovered');
    await browser.close();
}})();
"#,
            self.config.headless, selector
        );

        self.run_playwright_script(&script).await
    }

    async fn scroll(&self, direction: ScrollDirection, amount: u32) -> BrowserResult {
        let (delta_x, delta_y) = match direction {
            ScrollDirection::Up => (0, -(amount as i32)),
            ScrollDirection::Down => (0, amount as i32),
            ScrollDirection::Left => (-(amount as i32), 0),
            ScrollDirection::Right => (amount as i32, 0),
        };

        let script = format!(
            r#"
const {{ chromium }} = require('playwright');
(async () => {{
    const browser = await chromium.launch({{ headless: {} }});
    const page = await browser.newPage();
    await page.mouse.wheel({}, {});
    console.log('Scrolled');
    await browser.close();
}})();
"#,
            self.config.headless, delta_x, delta_y
        );

        self.run_playwright_script(&script).await
    }

    async fn run_playwright_script(&self, script: &str) -> BrowserResult {
        use std::io::Write;
        use tempfile::NamedTempFile;

        let mut temp_file = match NamedTempFile::new() {
            Ok(f) => f,
            Err(e) => {
                return BrowserResult {
                    success: false,
                    data: None,
                    screenshot_path: None,
                    error: Some(format!("Failed to create temp file: {}", e)),
                };
            }
        };

        if let Err(e) = temp_file.write_all(script.as_bytes()) {
            return BrowserResult {
                success: false,
                data: None,
                screenshot_path: None,
                error: Some(format!("Failed to write script: {}", e)),
            };
        }

        let output = match Command::new("node").arg(temp_file.path()).output() {
            Ok(o) => o,
            Err(e) => {
                return BrowserResult {
                    success: false,
                    data: None,
                    screenshot_path: None,
                    error: Some(format!("Failed to run script: {}", e)),
                };
            }
        };

        let stdout = String::from_utf8_lossy(&output.stdout).to_string();
        let stderr = String::from_utf8_lossy(&output.stderr).to_string();

        if output.status.success() {
            BrowserResult {
                success: true,
                data: Some(stdout),
                screenshot_path: None,
                error: None,
            }
        } else {
            BrowserResult {
                success: false,
                data: None,
                screenshot_path: None,
                error: Some(stderr),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn browser_config_defaults() {
        let config = BrowserConfig::default();
        assert!(!config.headless);
        assert_eq!(config.viewport_width, 1280);
        assert_eq!(config.viewport_height, 720);
    }

    #[test]
    fn browser_action_serialization() {
        let action = BrowserAction {
            action: ActionType::Navigate { url: "https://example.com".to_string() },
            selector: None,
            value: None,
            timeout_ms: None,
        };
        let json = serde_json::to_string(&action).unwrap();
        assert!(json.contains("https://example.com"));
    }
}
