//! Microsoft authentication orchestration.
//!
//! Flow: device code → MSA tokens → Xbox Live → XSTS → Minecraft Services →
//! profile + skin. The refresh token is stored securely and used for silent
//! re-login, so the device code is only needed once.

pub mod account;
pub mod microsoft;
pub mod store;
pub mod xbox;

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{RwLock, RwLockReadGuard, RwLockWriteGuard};

use serde::Serialize;

use crate::error::{LauncherError, Result};

use account::Account;
use microsoft::TokenSet;
use store::{StoredSession, StoredSessions, TokenStore};

fn read_lock<T>(lock: &RwLock<T>) -> RwLockReadGuard<'_, T> {
    lock.read().unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn write_lock<T>(lock: &RwLock<T>) -> RwLockWriteGuard<'_, T> {
    lock.write().unwrap_or_else(|poisoned| poisoned.into_inner())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum PendingStatus {
    Pending,
    Complete,
    Expired,
    Error,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingLogin {
    pub user_code: String,
    pub verification_uri: String,
    pub message: String,
    pub expires_at: i64,
    pub interval_secs: u64,
    pub status: PendingStatus,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthSnapshot {
    pub account: Option<Account>,
    pub pending: Option<PendingLogin>,
    /// All saved accounts, so the UI can switch without a new login.
    pub accounts: Vec<Account>,
}

pub struct AuthManager {
    http: reqwest::Client,
    store: TokenStore,
    cache_dir: PathBuf,
    account: RwLock<Option<Account>>,
    sessions: RwLock<Vec<StoredSession>>,
    active: RwLock<Option<String>>,
    pending: RwLock<Option<PendingLogin>>,
    device_code: RwLock<Option<String>>,
    pending_client: RwLock<Option<String>>,
    /// Guards against two refresh calls racing and rotating the refresh token twice.
    refreshing: AtomicBool,
}

impl AuthManager {
    pub fn new(http: reqwest::Client, cache_dir: PathBuf, fallback_file: PathBuf) -> Self {
        Self {
            http,
            store: TokenStore::new(fallback_file),
            cache_dir,
            account: RwLock::new(None),
            sessions: RwLock::new(Vec::new()),
            active: RwLock::new(None),
            pending: RwLock::new(None),
            device_code: RwLock::new(None),
            pending_client: RwLock::new(None),
            refreshing: AtomicBool::new(false),
        }
    }

    /// Loads every stored account and activates the last used one.
    pub fn restore(&self) {
        let stored = self.store.load();
        if stored.accounts.is_empty() {
            return;
        }
        let active = stored.active.clone().or_else(|| {
            stored
                .accounts
                .first()
                .map(|session| session.account.uuid.clone())
        });
        let account = active
            .as_deref()
            .and_then(|uuid| stored.accounts.iter().find(|entry| entry.account.uuid == uuid))
            .map(|session| session.account.clone());
        *write_lock(&self.sessions) = stored.accounts;
        *write_lock(&self.active) = active;
        *write_lock(&self.account) = account;
    }

    /// The session belonging to the active account.
    fn active_session(&self) -> Option<StoredSession> {
        let active = read_lock(&self.active).clone();
        let sessions = read_lock(&self.sessions);
        active
            .as_deref()
            .and_then(|uuid| sessions.iter().find(|entry| entry.account.uuid == uuid))
            .cloned()
            .or_else(|| sessions.first().cloned())
    }

    /// Every saved account, active first.
    pub fn accounts(&self) -> Vec<Account> {
        let active = read_lock(&self.active).clone();
        let mut accounts: Vec<Account> = read_lock(&self.sessions)
            .iter()
            .map(|session| session.account.clone())
            .collect();
        if let Some(uuid) = active {
            accounts.sort_by_key(|account| account.uuid != uuid);
        }
        accounts
    }

    fn persist(&self) -> Result<()> {
        self.store.save(&StoredSessions {
            accounts: read_lock(&self.sessions).clone(),
            active: read_lock(&self.active).clone(),
        })
    }

    pub fn snapshot(&self) -> AuthSnapshot {
        AuthSnapshot {
            account: read_lock(&self.account).clone(),
            pending: read_lock(&self.pending).clone(),
            accounts: self.accounts(),
        }
    }

    pub fn current(&self) -> Option<Account> {
        read_lock(&self.account).clone()
    }

    pub fn is_signed_in(&self) -> bool {
        read_lock(&self.account).is_some()
    }

    /// Unix timestamp at which the stored Minecraft access token expires.
    pub fn session_expires_at(&self) -> Option<i64> {
        self.active_session()
            .map(|session| session.access_token_expires_at)
    }

    pub fn access_token(&self) -> Option<String> {
        self.active_session().map(|session| session.access_token)
    }

    pub fn pending(&self) -> Option<PendingLogin> {
        read_lock(&self.pending).clone()
    }

    /// `(client_id, device_code, poll_interval_secs)` for the active login.
    pub fn pending_target(&self) -> Option<(String, String, u64)> {
        let pending = self.pending();
        let client = read_lock(&self.pending_client).clone();
        let device = read_lock(&self.device_code).clone();
        match (pending, client, device) {
            (Some(pending), Some(client), Some(device))
                if pending.status == PendingStatus::Pending =>
            {
                Some((client, device, pending.interval_secs.max(1)))
            }
            _ => None,
        }
    }

    pub fn pending_expired(&self) -> bool {
        self.pending()
            .is_some_and(|pending| chrono::Utc::now().timestamp() >= pending.expires_at)
    }

    pub fn set_pending_status(&self, status: PendingStatus, error: Option<String>) {
        if let Some(pending) = write_lock(&self.pending).as_mut() {
            pending.status = status;
            pending.error = error;
        }
    }

    pub fn bump_interval(&self) {
        if let Some(pending) = write_lock(&self.pending).as_mut() {
            pending.interval_secs = (pending.interval_secs + 5).min(30);
        }
    }

    pub fn cancel(&self) {
        *write_lock(&self.pending) = None;
        *write_lock(&self.device_code) = None;
        *write_lock(&self.pending_client) = None;
    }

    /// Requests a device code and exposes the pending login to the UI.
    pub async fn begin(&self, client_id: String) -> Result<PendingLogin> {
        self.cancel();

        let device = microsoft::request_device_code(&self.http, &client_id).await?;
        let expires_at = chrono::Utc::now().timestamp() + device.expires_in as i64;
        let message = if device.message.trim().is_empty() {
            format!(
                "Öffne {} und gib den angezeigten Code ein.",
                device.verification_uri
            )
        } else {
            device.message.clone()
        };

        let pending = PendingLogin {
            user_code: device.user_code.clone(),
            verification_uri: device.verification_uri.clone(),
            message,
            expires_at,
            interval_secs: device.interval.clamp(1, 30),
            status: PendingStatus::Pending,
            error: None,
        };

        *write_lock(&self.device_code) = Some(device.device_code);
        *write_lock(&self.pending_client) = Some(client_id);
        *write_lock(&self.pending) = Some(pending.clone());

        Ok(pending)
    }

    /// Completes the Xbox/Minecraft handshake and persists the session.
    pub async fn complete_login(&self, tokens: TokenSet) -> Result<Account> {
        self.finish_login(tokens, None).await
    }

    /// Shared tail of device-code login and silent refresh. `signed_in_at` keeps
    /// the original login date when a refresh replaces the tokens.
    async fn finish_login(&self, tokens: TokenSet, signed_in_at: Option<String>) -> Result<Account> {
        let ticket = xbox::authenticate(&self.http, &tokens.access_token).await?;
        let minecraft = xbox::login_with_xbox(&self.http, &ticket).await?;
        let profile = xbox::fetch_profile(&self.http, &minecraft.access_token).await?;

        let skin = account::skin_data_url(
            &self.http,
            &profile.id,
            profile.skin_url(),
            &self.cache_dir,
        )
        .await;

        let now = chrono::Utc::now();
        let signed_in_at = signed_in_at
            .or_else(|| {
                read_lock(&self.sessions)
                    .iter()
                    .find(|session| session.account.uuid == profile.id)
                    .map(|session| session.account.signed_in_at.clone())
            })
            .unwrap_or_else(|| now.to_rfc3339());
        let account = Account {
            username: profile.name,
            uuid: profile.id,
            skin_data_url: skin,
            signed_in_at,
            expires_at: now.timestamp() + minecraft.expires_in as i64,
        };

        let refresh_token = tokens
            .refresh_token
            .clone()
            .or_else(|| self.active_session().map(|session| session.refresh_token))
            .ok_or_else(|| {
                LauncherError::Auth(
                    "Microsoft hat kein Refresh-Token geliefert. Bitte erneut anmelden.".into(),
                )
            })?;

        let session = StoredSession {
            account: account.clone(),
            refresh_token,
            access_token: minecraft.access_token,
            access_token_expires_at: account.expires_at,
        };
        {
            let mut sessions = write_lock(&self.sessions);
            match sessions
                .iter_mut()
                .find(|entry| entry.account.uuid == session.account.uuid)
            {
                Some(existing) => *existing = session.clone(),
                None => sessions.push(session.clone()),
            }
        }
        *write_lock(&self.active) = Some(session.account.uuid.clone());
        self.persist()?;
        *write_lock(&self.account) = Some(account.clone());
        self.set_pending_status(PendingStatus::Complete, None);

        Ok(account)
    }

    /// Silent re-authentication using the stored refresh token.
    ///
    /// Safe to call concurrently: if another refresh is already running the
    /// current account is returned instead of rotating the token twice.
    pub async fn refresh(&self, client_id: String) -> Result<Account> {
        if self.refreshing.swap(true, Ordering::AcqRel) {
            return self.current().ok_or(LauncherError::NotSignedIn);
        }
        let result = self.refresh_locked(client_id).await;
        self.refreshing.store(false, Ordering::Release);
        result
    }

    async fn refresh_locked(&self, client_id: String) -> Result<Account> {
        let session = self.active_session().ok_or(LauncherError::NotSignedIn)?;
        let (refresh_token, signed_in_at) =
            (session.refresh_token, session.account.signed_in_at);

        let tokens =
            microsoft::refresh_access_token(&self.http, &client_id, &refresh_token).await?;
        self.finish_login(tokens, Some(signed_in_at)).await
    }

    /// Refreshes only when the access token is expired or expires within
    /// `leeway_secs`. Returns the fresh account, or `None` when nothing was due.
    pub async fn refresh_if_needed(
        &self,
        client_id: &str,
        leeway_secs: i64,
    ) -> Result<Option<Account>> {
        if !self.is_signed_in() || self.refreshing.load(Ordering::Acquire) {
            return Ok(None);
        }
        let Some(expires_at) = self.session_expires_at() else {
            return Ok(None);
        };
        if !needs_refresh(expires_at, chrono::Utc::now().timestamp(), leeway_secs) {
            return Ok(None);
        }
        self.refresh(client_id.to_string()).await.map(Some)
    }

    /// Signs out the active account and falls back to the next saved one.
    pub fn sign_out(&self) {
        let active = read_lock(&self.active).clone();
        {
            let mut sessions = write_lock(&self.sessions);
            match active {
                Some(uuid) => sessions.retain(|session| session.account.uuid != uuid),
                None => sessions.clear(),
            }
        }
        if read_lock(&self.sessions).is_empty() {
            *write_lock(&self.active) = None;
            *write_lock(&self.account) = None;
            self.store.clear();
        } else {
            let next = read_lock(&self.sessions).first().map(|session| {
                (session.account.uuid.clone(), session.account.clone())
            });
            *write_lock(&self.active) = next.as_ref().map(|(uuid, _)| uuid.clone());
            *write_lock(&self.account) = next.map(|(_, account)| account);
            let _ = self.persist();
        }
        self.cancel();
    }

    /// Activates an already saved account without a new Microsoft login.
    pub fn switch_account(&self, uuid: &str) -> Result<Account> {
        let account = read_lock(&self.sessions)
            .iter()
            .find(|session| session.account.uuid == uuid)
            .map(|session| session.account.clone())
            .ok_or_else(|| LauncherError::Invalid("Konto nicht gefunden.".into()))?;
        *write_lock(&self.active) = Some(account.uuid.clone());
        *write_lock(&self.account) = Some(account.clone());
        self.persist()?;
        Ok(account)
    }

    /// Removes one saved account (and its tokens) from the store.
    pub fn remove_account(&self, uuid: &str) -> Result<()> {
        {
            let mut sessions = write_lock(&self.sessions);
            sessions.retain(|session| session.account.uuid != uuid);
        }
        if read_lock(&self.sessions).is_empty() {
            *write_lock(&self.active) = None;
            *write_lock(&self.account) = None;
            self.store.clear();
            return Ok(());
        }
        if read_lock(&self.active).as_deref() == Some(uuid) {
            let next = read_lock(&self.sessions).first().map(|session| {
                (session.account.uuid.clone(), session.account.clone())
            });
            *write_lock(&self.active) = next.as_ref().map(|(id, _)| id.clone());
            *write_lock(&self.account) = next.map(|(_, account)| account);
        }
        self.persist()
    }
}

/// True when the access token is expired or expires within `leeway_secs`.
pub fn needs_refresh(expires_at: i64, now: i64, leeway_secs: i64) -> bool {
    expires_at - now <= leeway_secs
}

#[cfg(test)]
mod tests {
    use super::needs_refresh;

    #[test]
    fn refreshes_expired_tokens() {
        assert!(needs_refresh(1_000, 2_000, 3_600));
    }

    #[test]
    fn refreshes_inside_the_leeway() {
        assert!(needs_refresh(4_000, 3_000, 3_600));
    }

    #[test]
    fn keeps_fresh_tokens() {
        assert!(!needs_refresh(40_000, 3_000, 3_600));
    }
}
