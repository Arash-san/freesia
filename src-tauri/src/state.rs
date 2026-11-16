use crate::{config::Config, local::Local};
use serde_json::{json, Value};
use std::{
    fs::{self, OpenOptions},
    io::Write,
    path::PathBuf,
    sync::{Arc, Mutex},
    time::Instant,
};
use tauri::{AppHandle, Emitter};

pub type Shared = Arc<Services>;
pub struct Services {
    pub config: Mutex<Config>,
    pub root: PathBuf,
    pub client: reqwest::Client,
    pub activity: Mutex<Activity>,
    pub local: tokio::sync::Mutex<Local>,
    pub local_view: Mutex<Value>,
    pub download_cancel: std::sync::atomic::AtomicBool,
    pub models: Mutex<Vec<Value>>,
    pub cooldowns: Mutex<std::collections::HashMap<String, Instant>>,
    pub update: tokio::sync::Mutex<crate::updates::Updater>,
    pub update_view: Mutex<Value>,
    pub overlay: Mutex<Value>,
    pub overlay_generation: std::sync::atomic::AtomicU64,
    pub quitting: std::sync::atomic::AtomicBool,
    pub no_shortcuts: bool,
    pub main_suspended: std::sync::atomic::AtomicBool,
    pub log_lock: Mutex<()>,
    pub app_cache: Mutex<Option<(Instant, Vec<Value>)>>,
    pub icon_cache: Mutex<std::collections::HashMap<String, String>>,
}
pub struct Activity {
    pub recording: bool,
    pub processing: bool,
    pub since: Instant,
    pub last_shortcut: Option<Instant>,
    pub mode: String,
}
impl Services {
    pub fn new(root: PathBuf, no_shortcuts: bool) -> Result<Shared, String> {
        let config = Config::load(root.clone())?;
        let local = Local::new(&root);
        let local_view = local.status(&config);
        Ok(Arc::new(Self {
            config: Mutex::new(config),
            root,
            client: reqwest::Client::builder()
                .user_agent("Freesia/4 Rust")
                .connect_timeout(std::time::Duration::from_secs(15))
                .build()
                .map_err(|e| e.to_string())?,
            activity: Mutex::new(Activity {
                recording: false,
                processing: false,
                since: Instant::now(),
                last_shortcut: None,
                mode: "dictate".into(),
            }),
            local: tokio::sync::Mutex::new(local),
            local_view: Mutex::new(local_view),
            download_cancel: false.into(),
            models: Mutex::new(vec![]),
            cooldowns: Mutex::new(Default::default()),
            update: tokio::sync::Mutex::new(crate::updates::Updater::default()),
            update_view: Mutex::new(
                json!({"status":"idle","version":env!("CARGO_PKG_VERSION"),"isPackaged":!cfg!(debug_assertions),"message":"Update checks are ready."}),
            ),
            overlay: Mutex::new(json!({"state":"hidden"})),
            overlay_generation: 0.into(),
            quitting: false.into(),
            no_shortcuts,
            main_suspended: false.into(),
            log_lock: Mutex::new(()),
            app_cache: Mutex::new(None),
            icon_cache: Mutex::new(Default::default()),
        }))
    }
    pub fn get(&self, key: &str) -> Value {
        self.config.lock().unwrap().get(key)
    }
    pub fn string(&self, key: &str) -> String {
        self.config.lock().unwrap().string(key)
    }
    pub fn boolean(&self, key: &str) -> bool {
        self.config.lock().unwrap().boolean(key)
    }
    pub fn set(&self, key: &str, value: Value) -> Result<(), String> {
        self.config.lock().unwrap().set(key, value)
    }
    pub fn secret(&self, key: &str) -> String {
        self.config.lock().unwrap().secret(key)
    }
    pub fn set_secret(&self, key: &str, value: &str) -> Result<(), String> {
        self.config.lock().unwrap().set_secret(key, value)
    }
    pub fn emit(&self, app: &AppHandle, name: &str, payload: Value) {
        let _ = app.emit(name, payload);
    }
    pub fn log(&self, level: &str, context: &str, message: &str) {
        let _guard = self.log_lock.lock().unwrap();
        let file = self.root.join("freesia.log");
        if file.metadata().is_ok_and(|m| m.len() > 5 * 1024 * 1024) {
            let old = self.root.join("freesia.log.old");
            let _ = fs::remove_file(&old);
            let _ = fs::rename(&file, old);
        }
        if let Ok(mut f) = OpenOptions::new().create(true).append(true).open(file) {
            let _ = writeln!(
                f,
                "[{}] [{}] [{}] {}",
                chrono::Utc::now().to_rfc3339(),
                redact(level),
                redact(context),
                redact(message)
            );
        }
    }
}
pub fn redact(text: &str) -> String {
    static RE: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    RE.get_or_init(|| {
        regex::Regex::new(
            r"(?i)(AIza[0-9A-Za-z_-]{10,}|fv_[0-9A-Za-z_-]{10,}|Bearer\s+[0-9A-Za-z._-]{10,})",
        )
        .unwrap()
    })
    .replace_all(text, "[redacted]")
    .into_owned()
}
