//! Shared error type for all launcher commands.
//!
//! Every command returns `Result<T, LauncherError>`; the error is serialized as
//! `{ code, message }` so the frontend can react to specific failures
//! (e.g. `version_missing`, `not_signed_in`, `java_missing`).

use serde::ser::SerializeStruct;

pub type Result<T> = std::result::Result<T, LauncherError>;

#[derive(Debug, thiserror::Error)]
pub enum LauncherError {
    #[error("{0}")]
    Message(String),

    #[error("Netzwerkfehler: {0}")]
    Network(#[from] reqwest::Error),

    #[error("Dateisystemfehler: {0}")]
    Io(#[from] std::io::Error),

    #[error("Ungültige Daten: {0}")]
    Json(#[from] serde_json::Error),

    #[error("Archivfehler: {0}")]
    Zip(#[from] zip::result::ZipError),

    #[error("Microsoft-Anmeldung: {0}")]
    Auth(String),

    /// Microsoft rejected the refresh token; the user has to sign in again.
    #[error("Die Microsoft-Sitzung ist abgelaufen. Bitte melde dich erneut an.")]
    SessionExpired,

    #[error("Bitte melde dich zuerst mit einem Microsoft-Konto an.")]
    NotSignedIn,

    #[error("Java wurde nicht gefunden. Bitte in den Einstellungen einen Pfad angeben.")]
    JavaMissing,

    #[error("Die Version „{0}“ ist nicht installiert. Installiere sie im Spielverzeichnis, um sie zu starten.")]
    VersionMissing(String),

    #[error("Eingabe ungültig: {0}")]
    Invalid(String),
}

impl LauncherError {
    /// Stable machine-readable code consumed by the frontend.
    pub fn code(&self) -> &'static str {
        match self {
            LauncherError::Message(_) => "message",
            LauncherError::Network(_) => "network",
            LauncherError::Io(_) => "io",
            LauncherError::Json(_) => "json",
            LauncherError::Zip(_) => "zip",
            LauncherError::Auth(_) => "auth",
            LauncherError::SessionExpired => "session_expired",
            LauncherError::NotSignedIn => "not_signed_in",
            LauncherError::JavaMissing => "java_missing",
            LauncherError::VersionMissing(_) => "version_missing",
            LauncherError::Invalid(_) => "invalid",
        }
    }
}

impl serde::Serialize for LauncherError {
    fn serialize<S>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        let mut state = serializer.serialize_struct("CommandError", 2)?;
        state.serialize_field("code", self.code())?;
        state.serialize_field("message", &self.to_string())?;
        state.end()
    }
}

impl From<tauri::Error> for LauncherError {
    fn from(value: tauri::Error) -> Self {
        LauncherError::Message(value.to_string())
    }
}

impl From<String> for LauncherError {
    fn from(value: String) -> Self {
        LauncherError::Message(value)
    }
}
