//! News & patch notes.
//!
//! The launcher always ships a curated local feed (`src/data/news.ts`) so the
//! page works offline. When `integrations.newsFeedUrl` is set, this module
//! fetches the same item shape from a remote endpoint and the frontend merges
//! both. The endpoint is a placeholder — point it at your own CMS/API.

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::error::{LauncherError, Result};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum NewsCategory {
    Patch,
    Update,
    Info,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewsItem {
    pub id: String,
    pub title: String,
    pub category: NewsCategory,
    #[serde(default)]
    pub version: String,
    #[serde(default)]
    pub date: String,
    #[serde(default)]
    pub summary: String,
    #[serde(default)]
    pub body: Vec<String>,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub url: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NewsFeed {
    /// `remote` when the fetch succeeded, `unavailable` otherwise.
    pub source: String,
    pub items: Vec<NewsItem>,
    pub message: Option<String>,
}

/// Fetches a remote feed. Accepts either a bare array or `{ "items": [...] }`.
pub async fn fetch_remote(http: &reqwest::Client, url: &str) -> Result<NewsFeed> {
    let trimmed = url.trim();
    if !(trimmed.starts_with("https://")
        || trimmed.starts_with("http://127.0.0.1")
        || trimmed.starts_with("http://localhost"))
    {
        return Err(LauncherError::Invalid(
            "Die News-URL muss HTTPS verwenden.".into(),
        ));
    }

    let response = http.get(trimmed).send().await?;
    let status = response.status();
    if !status.is_success() {
        return Err(LauncherError::Message(format!(
            "News-Feed antwortete mit HTTP {}.",
            status.as_u16()
        )));
    }

    let payload: Value = response.json().await?;
    let array = payload
        .as_array()
        .cloned()
        .or_else(|| payload.get("items").and_then(Value::as_array).cloned())
        .ok_or_else(|| {
            LauncherError::Message("News-Feed hat kein gültiges Format (Array oder { items }).".into())
        })?;

    let items = array
        .into_iter()
        .filter_map(|value| serde_json::from_value::<NewsItem>(value).ok())
        .collect::<Vec<_>>();

    Ok(NewsFeed {
        source: "remote".into(),
        items,
        message: None,
    })
}
