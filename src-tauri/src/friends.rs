//! Local friends identity.
//!
//! The friend list lives on the shared OctoClient friends server; this store only
//! keeps the per-player identity (`uuid` + the secret `/v1/friends/register`
//! handed out) so every launcher start reconnects silently. Nothing here talks to
//! the network — see `friends_api.rs`.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::error::Result;

pub const STORE_FILE: &str = "friends.json";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct Identity {
    /// Canonical dashed, lower-case Minecraft UUID.
    pub uuid: String,
    /// Name registered on the friends server.
    pub name: String,
    /// Secret returned by `/v1/friends/register`; never leaves the machine.
    pub secret: String,
    /// Base URL the identity belongs to.
    pub server: String,
    /// Chosen availability: `online`, `away` or `offline`.
    pub presence: String,
}

impl Default for Identity {
    fn default() -> Self {
        Self {
            uuid: String::new(),
            name: String::new(),
            secret: String::new(),
            server: String::new(),
            presence: "online".into(),
        }
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct FriendsStore {
    pub version: u32,
    /// Last used identity (kept for compatibility with older builds).
    pub identity: Option<Identity>,
    /// Every identity seen so far, one per account and server.
    pub identities: Vec<Identity>,
}

impl FriendsStore {
    fn find(&self, uuid: &str, server: &str) -> Option<Identity> {
        self.identities
            .iter()
            .find(|entry| entry.uuid.eq_ignore_ascii_case(uuid) && entry.server == server)
            .cloned()
            .or_else(|| {
                self.identity
                    .clone()
                    .filter(|entry| entry.uuid.eq_ignore_ascii_case(uuid) && entry.server == server)
            })
    }
}

pub struct FriendsDb {
    path: PathBuf,
}

impl FriendsDb {
    pub fn new(data_dir: &Path) -> Self {
        Self {
            path: data_dir.join(STORE_FILE),
        }
    }

    fn load(&self) -> FriendsStore {
        crate::storage::read_json::<FriendsStore>(&self.path)
            .ok()
            .flatten()
            .unwrap_or_default()
    }

    pub fn identity(&self, uuid: &str, server: &str) -> Option<Identity> {
        self.load().find(uuid, server)
    }

    /// Stores the availability picked in the friends tab.
    pub fn set_presence(&self, uuid: &str, server: &str, presence: &str) -> Result<()> {
        let mut store = self.load();
        let mut found = false;
        for entry in store.identities.iter_mut() {
            if entry.uuid.eq_ignore_ascii_case(uuid) && entry.server == server {
                entry.presence = presence.to_string();
                found = true;
            }
        }
        if let Some(entry) = store.identity.as_mut() {
            if entry.uuid.eq_ignore_ascii_case(uuid) && entry.server == server {
                entry.presence = presence.to_string();
                found = true;
            }
        }
        if !found {
            return Ok(());
        }
        crate::storage::write_json(&self.path, &store)
    }

    pub fn remember(&self, identity: &Identity) -> Result<()> {
        let mut store = self.load();
        store.version = 2;
        store
            .identities
            .retain(|entry| !(entry.uuid.eq_ignore_ascii_case(&identity.uuid) && entry.server == identity.server));
        store.identities.push(identity.clone());
        store.identity = Some(identity.clone());
        crate::storage::write_json(&self.path, &store)
    }
}
