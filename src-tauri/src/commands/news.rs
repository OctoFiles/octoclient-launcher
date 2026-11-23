//! News feed command. The bundled feed lives in the frontend; this command
//! only loads an optional remote feed (placeholder endpoint).

use tauri::State;

use crate::error::Result;
use crate::news::{self, NewsFeed};
use crate::state::AppState;

#[tauri::command]
pub async fn fetch_news(state: State<'_, AppState>, url: Option<String>) -> Result<NewsFeed> {
    let feed_url = url
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .or_else(|| state.config().integrations.news_feed_url);

    match feed_url {
        Some(url) => news::fetch_remote(&state.http, &url).await,
        None => Ok(NewsFeed {
            source: "unavailable".into(),
            items: Vec::new(),
            message: Some("Kein Remote-Feed konfiguriert.".into()),
        }),
    }
}
