//! Minimal Discord Rich Presence over the local IPC pipe.
//!
//! Discord exposes a small framed JSON protocol on `discord-ipc-0..9` (named
//! pipes on Windows, unix sockets elsewhere). We reconnect for every update, so
//! a restarted Discord client is picked up automatically. No SDK dependency and
//! no network access are required.

use std::io::{Read, Write};

use serde_json::{json, Value};

#[derive(Debug, Clone)]
pub struct Activity {
    pub details: String,
    pub state: String,
    pub started_at: i64,
}

trait ReadWrite: Read + Write {}
impl<T: Read + Write> ReadWrite for T {}

#[cfg(windows)]
fn connect() -> Option<Box<dyn ReadWrite>> {
    for index in 0..10 {
        let path = format!(r"\.\pipe\discord-ipc-{index}");
        if let Ok(file) = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .open(path)
        {
            return Some(Box::new(file));
        }
    }
    None
}

#[cfg(not(windows))]
fn connect() -> Option<Box<dyn ReadWrite>> {
    use std::os::unix::net::UnixStream;
    let base = std::env::var("XDG_RUNTIME_DIR").unwrap_or_else(|_| "/tmp".into());
    for index in 0..10 {
        let path = format!("{base}/discord-ipc-{index}");
        if let Ok(stream) = UnixStream::connect(path) {
            return Some(Box::new(stream));
        }
    }
    None
}

fn frame(stream: &mut dyn ReadWrite, op: u32, payload: &Value) -> std::io::Result<()> {
    let data = serde_json::to_vec(payload)
        .map_err(|error| std::io::Error::new(std::io::ErrorKind::InvalidData, error))?;
    stream.write_all(&op.to_le_bytes())?;
    stream.write_all(&(data.len() as u32).to_le_bytes())?;
    stream.write_all(&data)?;
    stream.flush()
}

fn read_frame(stream: &mut dyn ReadWrite) -> std::io::Result<()> {
    let mut header = [0u8; 8];
    stream.read_exact(&mut header)?;
    let length = u32::from_le_bytes([header[4], header[5], header[6], header[7]]) as usize;
    if length > 65_536 {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "Discord frame too large",
        ));
    }
    let mut body = vec![0u8; length];
    stream.read_exact(&mut body)?;
    Ok(())
}

/// Sends one SET_ACTIVITY frame. Returns `false` when Discord is not running.
pub fn set_activity(client_id: &str, activity: &Activity) -> bool {
    let Some(mut stream) = connect() else {
        return false;
    };

    if frame(&mut stream, 0, &json!({ "v": 1, "client_id": client_id })).is_err() {
        return false;
    }
    // Handshake acknowledgement; failure is not fatal for the update below.
    let _ = read_frame(&mut stream);

    let nonce = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|value| value.as_millis().to_string())
        .unwrap_or_else(|_| "0".into());
    let payload = json!({
        "cmd": "SET_ACTIVITY",
        "nonce": nonce,
        "args": {
            "pid": std::process::id(),
            "activity": {
                "details": activity.details,
                "state": activity.state,
                "timestamps": { "start": activity.started_at },
                "assets": {
                    "large_image": "octo",
                    "large_text": "OctoClient"
                }
            }
        }
    });
    if frame(&mut stream, 1, &payload).is_err() {
        return false;
    }
    let _ = read_frame(&mut stream);
    true
}
