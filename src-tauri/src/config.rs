use aes_gcm::{aead::Aead, Aes256Gcm, KeyInit, Nonce};
use base64::{engine::general_purpose::STANDARD as B64, Engine};
use rand::RngCore;
use serde_json::{json, Value};
use std::{
    fs,
    path::{Path, PathBuf},
};

#[repr(C)]
struct Blob {
    len: u32,
    data: *mut u8,
}
#[link(name = "crypt32")]
extern "system" {
    fn CryptProtectData(
        input: *const Blob,
        description: *const u16,
        entropy: *const Blob,
        reserved: *mut u8,
        prompt: *mut u8,
        flags: u32,
        output: *mut Blob,
    ) -> i32;
    fn CryptUnprotectData(
        input: *const Blob,
        description: *mut *mut u16,
        entropy: *const Blob,
        reserved: *mut u8,
        prompt: *mut u8,
        flags: u32,
        output: *mut Blob,
    ) -> i32;
}
#[link(name = "kernel32")]
extern "system" {
    fn LocalFree(value: *mut u8) -> *mut u8;
}

fn dpapi(data: &[u8], encrypt: bool) -> Result<Vec<u8>, String> {
    let input = Blob {
        len: data.len() as u32,
        data: data.as_ptr() as *mut u8,
    };
    let mut out = Blob {
        len: 0,
        data: std::ptr::null_mut(),
    };
    let ok = unsafe {
        if encrypt {
            CryptProtectData(
                &input,
                std::ptr::null(),
                std::ptr::null(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                1,
                &mut out,
            )
        } else {
            CryptUnprotectData(
                &input,
                std::ptr::null_mut(),
                std::ptr::null(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                1,
                &mut out,
            )
        }
    };
    if ok == 0 {
        return Err("Windows could not unlock the saved credentials for this account.".into());
    }
    let result = unsafe { std::slice::from_raw_parts(out.data, out.len as usize).to_vec() };
    unsafe {
        LocalFree(out.data);
    }
    Ok(result)
}

pub fn atomic_json(path: &Path, value: &Value) -> Result<(), String> {
    fs::create_dir_all(path.parent().ok_or("Invalid settings path")?).map_err(|e| e.to_string())?;
    let temp = path.with_extension("json.tmp");
    let bytes = serde_json::to_vec_pretty(value).map_err(|e| e.to_string())?;
    fs::write(&temp, bytes).map_err(|e| e.to_string())?;
    fs::rename(&temp, path).map_err(|e| e.to_string())
}

pub struct Config {
    pub root: PathBuf,
    pub data: Value,
    key: Option<Vec<u8>>,
}
impl Config {
    pub fn load(root: PathBuf) -> Result<Self, String> {
        fs::create_dir_all(&root).map_err(|e| e.to_string())?;
        let file = root.join("config.json");
        // Only migrate the legacy install into the real default profile.
        // Explicit test/portable profiles must never import a user's data.
        let default_root = std::env::var_os("APPDATA").map(|p| PathBuf::from(p).join("freesia"));
        if !file.exists() && default_root.as_ref().is_some_and(|p| p == &root) {
            if let Some(parent) = root.parent() {
                let old = parent.join("Dictaloom");
                if old.join("config.json").is_file() {
                    fs::copy(old.join("config.json"), &file).map_err(|e| e.to_string())?;
                    if old.join("Local State").is_file() {
                        fs::copy(old.join("Local State"), root.join("Local State"))
                            .map_err(|e| e.to_string())?;
                    }
                    for folder in ["failed-recordings", "styles"] {
                        let from = old.join(folder);
                        if from.is_dir() {
                            let to = root.join(folder);
                            fs::create_dir_all(&to).map_err(|e| e.to_string())?;
                            for entry in fs::read_dir(from).map_err(|e| e.to_string())?.flatten() {
                                if entry.path().is_file() {
                                    fs::copy(entry.path(), to.join(entry.file_name()))
                                        .map_err(|e| e.to_string())?;
                                }
                            }
                        }
                    }
                }
            }
        }
        let mut value: Value = serde_json::from_str(include_str!("defaults.json")).unwrap();
        if file.exists() {
            // Electron used different defaults for profiles created before
            // Cloud and optional diagnostics were introduced.
            value["engine"] = json!("gemini");
            value["errorReporting"] = json!(false);
            let text = fs::read_to_string(&file).map_err(|e| e.to_string())?;
            let saved: Value = serde_json::from_str(text.trim_start_matches('\u{feff}'))
                .map_err(|e| format!("Could not read existing settings: {e}"))?;
            if !saved.is_object() {
                return Err("The existing settings file is not an object.".into());
            }
            value
                .as_object_mut()
                .unwrap()
                .extend(saved.as_object().unwrap().clone());
            let backup = root.join("config.before-rust.json");
            if !backup.exists() {
                fs::copy(&file, backup).map_err(|e| e.to_string())?;
            }
        }
        if value["installId"].as_str().unwrap_or("").is_empty() {
            value["installId"] = json!(uuid::Uuid::new_v4().to_string());
        }
        let mut config = Self {
            root,
            data: value,
            key: None,
        };
        if config.data["secrets"].as_object().is_some_and(|o| {
            o.values()
                .any(|v| v.as_str().is_some_and(|t| t.starts_with("enc:")))
        }) {
            config.encryption_key()?;
        }
        // Keep Electron's v10/AES-GCM envelope so going back to Electron does
        // not sign the user out. The AES key is protected by Windows DPAPI.
        if let Some(legacy) = config.data["apiKey"]
            .as_str()
            .filter(|s| !s.is_empty())
            .map(str::to_owned)
        {
            if config.secret("gemini").is_empty() {
                config.set_secret("gemini", &legacy)?;
            }
            config.data.as_object_mut().unwrap().remove("apiKey");
        }
        for name in ["gemini", "cloud", "localServer"] {
            let raw = config.string(&format!("secrets.{name}"));
            if let Some(plain) = raw.strip_prefix("plain:") {
                config.set_secret(name, plain)?;
            }
        }
        config.save()?;
        Ok(config)
    }
    pub fn get(&self, key: &str) -> Value {
        let mut current = &self.data;
        for part in key.split('.') {
            current = match current.get(part) {
                Some(v) => v,
                None => return Value::Null,
            };
        }
        current.clone()
    }
    pub fn string(&self, key: &str) -> String {
        self.get(key).as_str().unwrap_or("").to_owned()
    }
    pub fn boolean(&self, key: &str) -> bool {
        self.get(key).as_bool().unwrap_or(false)
    }
    pub fn set(&mut self, key: &str, value: Value) -> Result<(), String> {
        let parts: Vec<_> = key.split('.').collect();
        let mut target = &mut self.data;
        for part in &parts[..parts.len() - 1] {
            if !target.get(part).is_some_and(Value::is_object) {
                target[*part] = json!({});
            }
            target = &mut target[*part];
        }
        if value.is_null() {
            if let Some(o) = target.as_object_mut() {
                o.remove(parts[parts.len() - 1]);
            }
        } else {
            target[parts[parts.len() - 1]] = value;
        }
        self.save()
    }
    pub fn save(&self) -> Result<(), String> {
        atomic_json(&self.root.join("config.json"), &self.data)
    }
    pub fn public(&self) -> Value {
        let mut data = self.data.clone();
        for key in ["secrets", "cloud", "apiKey", "installId"] {
            data.as_object_mut().unwrap().remove(key);
        }
        data
    }
    fn encryption_key(&mut self) -> Result<Vec<u8>, String> {
        if let Some(key) = &self.key {
            return Ok(key.clone());
        }
        let file = self.root.join("Local State");
        let mut state: Value = fs::read_to_string(&file)
            .ok()
            .and_then(|t| serde_json::from_str(&t).ok())
            .unwrap_or(json!({}));
        let key = if let Some(encoded) = state["os_crypt"]["encrypted_key"].as_str() {
            let packed = B64
                .decode(encoded)
                .map_err(|_| "Invalid credential key envelope")?;
            if !packed.starts_with(b"DPAPI") {
                return Err("Unsupported credential encryption envelope".into());
            }
            dpapi(&packed[5..], false)?
        } else {
            // An existing encrypted token must never be overwritten with a
            // newly generated key if its original Local State was lost.
            if self.data["secrets"].as_object().is_some_and(|o| {
                o.values()
                    .any(|v| v.as_str().is_some_and(|s| s.starts_with("enc:")))
            }) {
                return Err("The original Windows credential key is missing. Restore Local State before migrating.".into());
            }
            let mut key = vec![0u8; 32];
            rand::thread_rng().fill_bytes(&mut key);
            let mut packed = b"DPAPI".to_vec();
            packed.extend(dpapi(&key, true)?);
            state["os_crypt"]["encrypted_key"] = json!(B64.encode(packed));
            atomic_json(&file, &state)?;
            key
        };
        if key.len() != 32 {
            return Err("Invalid Windows credential key".into());
        }
        self.key = Some(key.clone());
        Ok(key)
    }
    pub fn secret(&mut self, name: &str) -> String {
        let raw = self.string(&format!("secrets.{name}"));
        if let Some(plain) = raw.strip_prefix("plain:") {
            return plain.to_owned();
        }
        let mut unpack = || -> Result<String, String> {
            let packed = B64
                .decode(raw.strip_prefix("enc:").ok_or("No credential")?)
                .map_err(|_| "Invalid credential")?;
            if !packed.starts_with(b"v10") || packed.len() < 31 {
                return Err("Unsupported credential".into());
            }
            let key = self.encryption_key()?;
            let cipher = Aes256Gcm::new_from_slice(&key).map_err(|_| "Invalid credential key")?;
            let bytes = cipher
                .decrypt(Nonce::from_slice(&packed[3..15]), &packed[15..])
                .map_err(|_| "Credential authentication failed")?;
            String::from_utf8(bytes).map_err(|_| "Invalid credential text".into())
        };
        unpack().unwrap_or_default()
    }
    pub fn set_secret(&mut self, name: &str, text: &str) -> Result<(), String> {
        if text.is_empty() {
            return self.set(&format!("secrets.{name}"), Value::Null);
        }
        let key = self.encryption_key()?;
        let cipher = Aes256Gcm::new_from_slice(&key).map_err(|_| "Invalid credential key")?;
        let mut nonce = [0u8; 12];
        rand::thread_rng().fill_bytes(&mut nonce);
        let encrypted = cipher
            .encrypt(Nonce::from_slice(&nonce), text.as_bytes())
            .map_err(|_| "Could not encrypt credential")?;
        let mut packed = b"v10".to_vec();
        packed.extend(nonce);
        packed.extend(encrypted);
        self.set(
            &format!("secrets.{name}"),
            json!(format!("enc:{}", B64.encode(packed))),
        )
    }
}

pub fn private_key(key: &str) -> bool {
    ["secrets", "cloud", "apiKey", "installId"].contains(&key.split('.').next().unwrap_or(""))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn encrypted_settings_roundtrip_and_public_boundary() {
        let dir =
            std::env::temp_dir().join(format!("freesia-credentials-{}", uuid::Uuid::new_v4()));
        let mut c = Config::load(dir.clone()).unwrap();
        c.set_secret("cloud", "test-value-not-a-live-token")
            .unwrap();
        assert!(c.string("secrets.cloud").starts_with("enc:"));
        assert!(!fs::read_to_string(dir.join("config.json"))
            .unwrap()
            .contains("test-value-not-a-live-token"));
        let mut restored = Config::load(dir.clone()).unwrap();
        assert_eq!(restored.secret("cloud"), "test-value-not-a-live-token");
        assert!(restored.public().get("secrets").is_none());
        assert!(private_key("cloud.server"));
        assert!(dir.starts_with(std::env::temp_dir()));
        fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn old_profiles_keep_their_engine_default_and_diagnostics_consent() {
        let dir = std::env::temp_dir().join(format!("freesia-legacy-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        let original = json!({"apiKey":"test-legacy-key-not-a-live-secret","history":[{"text":"Keep this history"}],"keepMicReady":false});
        fs::write(
            dir.join("config.json"),
            serde_json::to_vec(&original).unwrap(),
        )
        .unwrap();
        let mut c = Config::load(dir.clone()).unwrap();
        assert_eq!(c.string("engine"), "gemini");
        assert!(!c.boolean("errorReporting"));
        assert!(!c.boolean("keepMicReady"));
        assert_eq!(c.secret("gemini"), "test-legacy-key-not-a-live-secret");
        assert!(c.get("apiKey").is_null());
        assert_eq!(c.get("history"), original["history"]);
        let backup: Value =
            serde_json::from_str(&fs::read_to_string(dir.join("config.before-rust.json")).unwrap())
                .unwrap();
        assert_eq!(backup, original);
        assert!(dir.starts_with(std::env::temp_dir()));
        fs::remove_dir_all(dir).unwrap();
    }
}
