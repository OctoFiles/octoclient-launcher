//! Public account model and skin avatar resolution.
//!
//! The skin PNG is cached on disk and returned to the UI as a data URL, so the
//! avatar works offline and the renderer never has to fetch remote textures.

use std::path::Path;
use std::time::{Duration, SystemTime};

use base64::Engine as _;
use serde::{Deserialize, Serialize};

const SKIN_CACHE_TTL: Duration = Duration::from_secs(60 * 60 * 12);

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Account {
    pub username: String,
    /// UUID with dashes, as returned by the Minecraft profile endpoint.
    pub uuid: String,
    /// 64×64 skin PNG as data URL (cached locally).
    pub skin_data_url: Option<String>,
    pub signed_in_at: String,
    /// Unix timestamp when the Minecraft access token expires.
    pub expires_at: i64,
}

pub async fn skin_data_url(
    http: &reqwest::Client,
    uuid: &str,
    skin_url: Option<&str>,
    cache_dir: &Path,
) -> Option<String> {
    let cache_file = cache_dir.join(format!("{}.png", uuid.replace('-', "")));

    let cached = std::fs::read(&cache_file).ok();
    let fresh = cached.as_ref().is_some_and(|_| {
        std::fs::metadata(&cache_file)
            .and_then(|meta| meta.modified())
            .ok()
            .and_then(|modified| SystemTime::now().duration_since(modified).ok())
            .is_some_and(|age| age < SKIN_CACHE_TTL)
    });
    if fresh {
        if let Some(bytes) = cached {
            return Some(to_data_url(&bytes));
        }
    }

    let Some(url) = skin_url else {
        return cached.map(|bytes| to_data_url(&bytes));
    };

    match http.get(url).send().await {
        Ok(response) if response.status().is_success() => match response.bytes().await {
            Ok(bytes) if !bytes.is_empty() => {
                let _ = std::fs::write(&cache_file, &bytes);
                Some(to_data_url(&bytes))
            }
            _ => cached.map(|bytes| to_data_url(&bytes)),
        },
        _ => cached.map(|bytes| to_data_url(&bytes)),
    }
}

fn to_data_url(bytes: &[u8]) -> String {
    format!(
        "data:image/png;base64,{}",
        base64::engine::general_purpose::STANDARD.encode(bytes)
    )
}
