//! Session persistence for every saved Microsoft account.
//!
//! Primary storage is the OS credential store (Windows Credential Manager,
//! macOS Keychain, Linux Secret Service) via the `keyring` crate. If no
//! keychain is available the accounts are written to a JSON file in the app
//! data dir. The file fallback keeps the launcher usable; ship a keyring-backed
//! build for production.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use crate::auth::account::Account;
use crate::error::Result;

const SERVICE: &str = "frost-client-launcher";
const ENTRY: &str = "microsoft-accounts";
/// Single-session entry written by older launcher versions.
const LEGACY_ENTRY: &str = "microsoft-account";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredSession {
    pub account: Account,
    pub refresh_token: String,
    pub access_token: String,
    pub access_token_expires_at: i64,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct SessionFile {
    accounts: Vec<StoredSession>,
    active: Option<String>,
}

/// Everything the launcher keeps on disk for account switching.
#[derive(Debug, Clone, Default)]
pub struct StoredSessions {
    pub accounts: Vec<StoredSession>,
    pub active: Option<String>,
}

pub struct TokenStore {
    fallback_file: PathBuf,
}

impl TokenStore {
    pub fn new(fallback_file: PathBuf) -> Self {
        Self { fallback_file }
    }

    pub fn load(&self) -> StoredSessions {
        // The file is always written by `save`, so a keyring that silently keeps
        // nothing (or truncates an oversized session) can no longer lose the login.
        let from_file = self.load_file();
        if let Ok(entry) = keyring::Entry::new(SERVICE, ENTRY) {
            if let Ok(secret) = entry.get_password() {
                if let Ok(file) = serde_json::from_str::<SessionFile>(&secret) {
                    if let Some(sessions) = normalize(file) {
                        return sessions;
                    }
                }
                if let Ok(single) = serde_json::from_str::<StoredSession>(&secret) {
                    return StoredSessions {
                        active: Some(single.account.uuid.clone()),
                        accounts: vec![single],
                    };
                }
            }
        }

        if !from_file.accounts.is_empty() {
            return from_file;
        }

        if let Ok(entry) = keyring::Entry::new(SERVICE, LEGACY_ENTRY) {
            if let Ok(secret) = entry.get_password() {
                if let Ok(single) = serde_json::from_str::<StoredSession>(&secret) {
                    return StoredSessions {
                        active: Some(single.account.uuid.clone()),
                        accounts: vec![single],
                    };
                }
            }
        }

        StoredSessions::default()
    }

    fn load_file(&self) -> StoredSessions {
        let Ok(raw) = std::fs::read_to_string(&self.fallback_file) else {
            return StoredSessions::default();
        };
        if let Ok(file) = serde_json::from_str::<SessionFile>(&raw) {
            if let Some(sessions) = normalize(file) {
                return sessions;
            }
        }
        if let Ok(single) = serde_json::from_str::<StoredSession>(&raw) {
            return StoredSessions {
                active: Some(single.account.uuid.clone()),
                accounts: vec![single],
            };
        }
        StoredSessions::default()
    }

    pub fn save(&self, sessions: &StoredSessions) -> Result<()> {
        let file = SessionFile {
            accounts: sessions.accounts.clone(),
            active: sessions.active.clone(),
        };
        let payload = serde_json::to_string(&file)?;

        let stored_in_keyring = keyring::Entry::new(SERVICE, ENTRY)
            .and_then(|entry| entry.set_password(&payload))
            .is_ok();

        if stored_in_keyring {
            if let Ok(entry) = keyring::Entry::new(SERVICE, LEGACY_ENTRY) {
                let _ = entry.delete_credential();
            }
        } else {
            eprintln!(
                "[octoclient] Kein OS-Schlüsselspeicher verfügbar — Sitzungen werden in {} gespeichert.",
                self.fallback_file.display()
            );
        }

        // Always mirror the sessions to disk: the credential store rejects large
        // blobs (Windows: 2560 bytes, easily exceeded by tokens plus skin PNGs)
        // and some backends keep nothing at all, which signed the user out on
        // every restart.
        if let Some(parent) = self.fallback_file.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::write(&self.fallback_file, payload)?;
        Ok(())
    }

    pub fn clear(&self) {
        for name in [ENTRY, LEGACY_ENTRY] {
            if let Ok(entry) = keyring::Entry::new(SERVICE, name) {
                let _ = entry.delete_credential();
            }
        }
        let _ = std::fs::remove_file(&self.fallback_file);
    }
}

fn normalize(file: SessionFile) -> Option<StoredSessions> {
    if file.accounts.is_empty() {
        return None;
    }
    let active = file
        .active
        .filter(|uuid| file.accounts.iter().any(|entry| &entry.account.uuid == uuid))
        .or_else(|| file.accounts.first().map(|entry| entry.account.uuid.clone()));
    Some(StoredSessions {
        accounts: file.accounts,
        active,
    })
}
