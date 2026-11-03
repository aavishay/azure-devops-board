//! Secrets (PAT, Entra refresh token) live in the OS credential store:
//! Windows Credential Manager, macOS Keychain, or the Secret Service on Linux.
//!
//! Long values are split into chunks because Windows limits one credential to 2,560 bytes.
//! If no credential store is available (e.g. a minimal Linux desktop without a keyring),
//! secrets fall back to a file readable only by the current user.

use std::collections::HashMap;
use std::path::PathBuf;

const SERVICE: &str = "com.au10tix.devopsboard";
const CHUNK: usize = 1000;

pub struct Secrets {
    fallback_file: PathBuf,
}

impl Secrets {
    pub fn new(fallback_file: PathBuf) -> Self {
        Self { fallback_file }
    }

    pub fn get(&self, key: &str) -> Option<String> {
        match keyring_get(key) {
            Ok(Some(v)) => Some(v),
            Ok(None) => self.file_map().remove(key),
            Err(_) => self.file_map().remove(key),
        }
    }

    pub fn set(&self, key: &str, value: &str) -> Result<(), String> {
        match keyring_set(key, value) {
            Ok(()) => {
                // Make sure no stale copy is left in the fallback file.
                let mut m = self.file_map();
                if m.remove(key).is_some() {
                    let _ = self.write_file_map(&m);
                }
                Ok(())
            }
            Err(e) => {
                log::warn(&format!("OS credential store unavailable ({e}); using protected file"));
                let mut m = self.file_map();
                m.insert(key.to_string(), value.to_string());
                self.write_file_map(&m)
            }
        }
    }

    pub fn delete(&self, key: &str) {
        let _ = keyring_delete(key);
        let mut m = self.file_map();
        if m.remove(key).is_some() {
            let _ = self.write_file_map(&m);
        }
    }

    fn file_map(&self) -> HashMap<String, String> {
        std::fs::read_to_string(&self.fallback_file)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default()
    }

    fn write_file_map(&self, m: &HashMap<String, String>) -> Result<(), String> {
        if let Some(dir) = self.fallback_file.parent() {
            std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        }
        let json = serde_json::to_string(m).map_err(|e| e.to_string())?;
        std::fs::write(&self.fallback_file, json).map_err(|e| e.to_string())?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&self.fallback_file, std::fs::Permissions::from_mode(0o600));
        }
        Ok(())
    }
}

fn entry(name: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(SERVICE, name).map_err(|e| e.to_string())
}

fn keyring_get(key: &str) -> Result<Option<String>, String> {
    let head = match entry(key)?.get_password() {
        Ok(v) => v,
        Err(keyring::Error::NoEntry) => return Ok(None),
        Err(e) => return Err(e.to_string()),
    };
    if let Some(n) = head.strip_prefix("chunks:").and_then(|n| n.parse::<usize>().ok()) {
        let mut out = String::new();
        for i in 0..n {
            match entry(&format!("{key}.{i}"))?.get_password() {
                Ok(part) => out.push_str(&part),
                Err(keyring::Error::NoEntry) => return Ok(None),
                Err(e) => return Err(e.to_string()),
            }
        }
        Ok(Some(out))
    } else {
        Ok(Some(head))
    }
}

fn keyring_set(key: &str, value: &str) -> Result<(), String> {
    keyring_delete(key)?;
    if value.len() <= CHUNK && !value.starts_with("chunks:") {
        return entry(key)?.set_password(value).map_err(|e| e.to_string());
    }
    let chars: Vec<char> = value.chars().collect();
    let parts: Vec<String> = chars.chunks(CHUNK).map(|c| c.iter().collect()).collect();
    for (i, part) in parts.iter().enumerate() {
        entry(&format!("{key}.{i}"))?.set_password(part).map_err(|e| e.to_string())?;
    }
    entry(key)?.set_password(&format!("chunks:{}", parts.len())).map_err(|e| e.to_string())
}

fn keyring_delete(key: &str) -> Result<(), String> {
    let e = entry(key)?;
    let head = match e.get_password() {
        Ok(v) => v,
        Err(keyring::Error::NoEntry) => return Ok(()),
        Err(err) => return Err(err.to_string()),
    };
    if let Some(n) = head.strip_prefix("chunks:").and_then(|n| n.parse::<usize>().ok()) {
        for i in 0..n {
            if let Ok(p) = entry(&format!("{key}.{i}")) {
                let _ = p.delete_credential();
            }
        }
    }
    match e.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(err) => Err(err.to_string()),
    }
}

pub mod log {
    pub fn warn(msg: &str) {
        eprintln!("[devops-board] {msg}");
    }
}
