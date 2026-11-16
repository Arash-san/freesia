use crate::{
    config::private_key,
    desktop,
    engines::{self, Error, Result},
    local, native,
    state::Shared,
    storage, updates,
};
use serde_json::{json, Value};
use std::{
    sync::atomic::Ordering,
    time::{Duration, Instant},
};
use tauri::{AppHandle, Emitter, Manager, State, WebviewWindow};
use tauri_plugin_global_shortcut::GlobalShortcutExt;
fn str_arg(args: &[Value], i: usize) -> &str {
    args.get(i).and_then(Value::as_str).unwrap_or("")
}
fn arg(args: &[Value], i: usize) -> Value {
    args.get(i).cloned().unwrap_or(Value::Null)
}
fn yes(v: bool) -> Value {
    json!(v)
}
#[tauri::command]
pub async fn ipc(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, Shared>,
    channel: String,
    args: Vec<Value>,
) -> std::result::Result<Value, String> {
    let s = state.inner().clone();
    if window.label() != "main" && channel != "native:ready" {
        return Err("This window cannot call desktop services.".into());
    }
    let result = route(&s, &app, &window, &channel, &args).await;
    match result {
        Ok(v) => Ok(v),
        Err(e) => {
            s.log("WARN", &channel, &format!("{} {}", e.code, e.message));
            if channel.starts_with("engine:")
                || channel.starts_with("cloud:")
                || channel.starts_with("gemini:")
                || channel.starts_with("local:")
            {
                Ok(e.value())
            } else {
                Err(e.message)
            }
        }
    }
}
async fn route(
    s: &Shared,
    app: &AppHandle,
    window: &WebviewWindow,
    ch: &str,
    a: &[Value],
) -> Result<Value> {
    let main = || {
        app.get_webview_window("main")
            .ok_or_else(|| Error::new("server", "The main window is unavailable"))
    };
    match ch {
        "native:ready" => {
            if window.label() == "overlay" {
                let v = s.overlay.lock().unwrap().clone();
                let _ = window.emit("overlay-state", v);
            } else {
                let _ = window.emit("theme-updated", desktop::theme(s));
                let visible =
                    window.is_visible().unwrap_or(false) && !window.is_minimized().unwrap_or(false);
                let _ = window.emit("native-visibility", json!(visible));
            }
            Ok(Value::Null)
        }
        "native:test" if s.no_shortcuts => {
            match str_arg(a, 0) {
                "show" => desktop::show_main(s, app),
                "dictate" => desktop::handle_shortcut(s, app, "dictate"),
                "command" => desktop::handle_shortcut(s, app, "command"),
                "cancel" => desktop::cancel(s, app),
                "quit" => {
                    s.quitting.store(true, Ordering::Relaxed);
                    app.exit(0);
                }
                _ => {}
            }
            Ok(Value::Null)
        }
        "native:suspend" => {
            let busy = {
                let activity = s.activity.lock().unwrap();
                activity.recording || activity.processing
            };
            if !busy
                && (!window.is_visible().unwrap_or(true) || window.is_minimized().unwrap_or(false))
            {
                desktop::memory(window, true, true);
            }
            Ok(Value::Null)
        }
        "get-settings" => Ok(s.config.lock().unwrap().public()),
        "get-setting" => Ok(if private_key(str_arg(a, 0)) {
            Value::Null
        } else {
            s.get(str_arg(a, 0))
        }),
        "set-setting" => {
            let key = str_arg(a, 0);
            if key.is_empty()
                || private_key(key)
                || key
                    .split('.')
                    .any(|k| matches!(k, "__proto__" | "constructor" | "prototype"))
            {
                return Ok(yes(false));
            }
            s.set(key, arg(a, 1))?;
            Ok(yes(true))
        }
        "inject-text" => {
            let text = str_arg(a, 0).to_owned();
            let ok = tauri::async_runtime::spawn_blocking(move || native::inject(text))
                .await
                .map_err(|e| Error::new("server", e.to_string()))??;
            Ok(yes(ok))
        }
        "copy-text" => {
            let text = str_arg(a, 0).to_owned();
            tauri::async_runtime::spawn_blocking(move || native::copy(&text))
                .await
                .map_err(|e| Error::new("server", e.to_string()))??;
            Ok(yes(true))
        }
        "get-foreground-app" => Ok(json!(native::foreground())),
        "minimize-window" => {
            main()?
                .minimize()
                .map_err(|e| Error::new("server", e.to_string()))?;
            Ok(Value::Null)
        }
        "toggle-maximize-window" => {
            let w = main()?;
            if w.is_maximized().unwrap_or(false) {
                w.unmaximize()
            } else {
                w.maximize()
            }
            .map_err(|e| Error::new("server", e.to_string()))?;
            Ok(Value::Null)
        }
        "close-window" => {
            desktop::hide_main(app);
            Ok(Value::Null)
        }
        "recording-state" => {
            let recording = str_arg(a, 0) == "recording";
            let processing = str_arg(a, 0) == "processing";
            if recording || processing {
                desktop::memory(&main()?, false, false);
            }
            {
                let mut activity = s.activity.lock().unwrap();
                activity.recording = recording;
                activity.processing = processing;
                if processing {
                    activity.since = Instant::now();
                }
            }
            desktop::escape(s, app, recording);
            if processing {
                desktop::set_overlay(s, app, "processing", json!({}), 0);
            }
            Ok(Value::Null)
        }
        "recording-live" => {
            let info = {
                let activity = s.activity.lock().unwrap();
                if !activity.recording {
                    return Ok(Value::Null);
                }
                let mut info = json!({"mode":activity.mode});
                if let Some(hint) = s.overlay.lock().unwrap()["hint"].as_str() {
                    info["hint"] = json!(hint);
                }
                info
            };
            desktop::set_overlay(s, app, "listening", info, 0);
            Ok(Value::Null)
        }
        "recording-failed" => {
            {
                let mut activity = s.activity.lock().unwrap();
                activity.recording = false;
                activity.processing = false;
            }
            desktop::escape(s, app, false);
            desktop::set_overlay(s, app, "error", json!({"message":str_arg(a,0)}), 2600);
            Ok(Value::Null)
        }
        "overlay-done" | "overlay-error" | "overlay-hide" => {
            s.activity.lock().unwrap().processing = false;
            match ch {
                "overlay-done" => desktop::set_overlay(s, app, "done", arg(a, 0), 1700),
                "overlay-error" => {
                    desktop::set_overlay(s, app, "error", json!({"message":str_arg(a,0)}), 3200)
                }
                _ => desktop::hide_overlay(s, app),
            }
            Ok(Value::Null)
        }
        "overlay-progress" => {
            desktop::set_overlay(s, app, "processing", arg(a, 0), 0);
            Ok(Value::Null)
        }
        "overlay-kept" => {
            let busy = {
                let activity = s.activity.lock().unwrap();
                activity.recording || activity.processing
            };
            if !busy {
                desktop::show_overlay(s, app, "kept", json!({}));
                desktop::set_overlay(s, app, "kept", json!({}), 2600);
            }
            Ok(Value::Null)
        }
        "overlay-timer" => {
            desktop::overlay_event(app, "overlay-timer", arg(a, 0));
            Ok(Value::Null)
        }
        "overlay-audio-level" => {
            desktop::overlay_event(
                app,
                "overlay-audio-level",
                json!(arg(a, 0).as_f64().unwrap_or(0.).clamp(0., 1.)),
            );
            Ok(Value::Null)
        }
        "open-external" => {
            let url = str_arg(a, 0);
            if url::Url::parse(url).is_ok_and(|u| u.scheme() == "https") {
                Ok(yes(native::open(url, false)?))
            } else {
                Ok(yes(false))
            }
        }
        "register-shortcuts" => Ok(desktop::register(s, app)),
        "suspend-shortcuts" => {
            let _ = app.global_shortcut().unregister_all();
            Ok(yes(true))
        }
        "set-shortcut" => {
            let key = str_arg(a, 0);
            if !["dictationShortcut", "commandShortcut"].contains(&key) {
                return Ok(json!({"ok":false}));
            }
            let previous = s.get(key);
            s.set(key, arg(a, 1))?;
            let result = desktop::register(s, app);
            if result[key] != true {
                s.set(key, previous)?;
                desktop::register(s, app);
                return Ok(
                    json!({"ok":false,"message":format!("{} is already used by another app or Windows.",str_arg(a,1))}),
                );
            }
            Ok(json!({"ok":true}))
        }
        "get-theme-info" => Ok(desktop::theme(s)),
        "set-app-theme" => {
            let source = str_arg(a, 0);
            let source = if ["system", "light", "dark"].contains(&source) {
                source
            } else {
                "system"
            };
            s.set("theme", json!(source))?;
            let theme = match source {
                "dark" => Some(tauri::Theme::Dark),
                "light" => Some(tauri::Theme::Light),
                _ => None,
            };
            let _ = main()?.set_theme(theme);
            let v = desktop::theme(s);
            s.emit(app, "theme-updated", v.clone());
            Ok(v)
        }
        "get-app-version" => Ok(json!(env!("CARGO_PKG_VERSION"))),
        "get-update-status" => Ok(s.update_view.lock().unwrap().clone()),
        "check-for-updates" => Ok(updates::check(s, app, true).await),
        "download-update" => Ok(updates::download(s, app).await),
        "install-update" => Ok(updates::install(s, app).await),
        "set-auto-launch" => {
            let enabled = arg(a, 0) == true;
            native::autostart(enabled)?;
            s.set("autoLaunch", yes(enabled))?;
            Ok(Value::Null)
        }
        "open-log" => {
            let path = s.root.join("freesia.log");
            if !path.exists() {
                std::fs::write(&path, "").map_err(|e| Error::new("config", e.to_string()))?;
            }
            native::open(&path.to_string_lossy(), false)?;
            Ok(json!(path.to_string_lossy()))
        }
        "log-to-file" => {
            let message = format!(
                "{}{}",
                str_arg(a, 2),
                if str_arg(a, 3).is_empty() {
                    String::new()
                } else {
                    format!("\n  Stack: {}", str_arg(a, 3))
                }
            );
            s.log(str_arg(a, 0), str_arg(a, 1), &message);
            Ok(yes(true))
        }
        "engine:status" => Ok(engines::status(s)),
        "engine:set" => {
            let key = str_arg(a, 0);
            let val = str_arg(a, 1);
            if (key == "engine" && ["cloud", "local", "gemini"].contains(&val))
                || (key == "formatter" && ["auto", "cloud", "gemini", "off"].contains(&val))
            {
                s.set(key, json!(val))?;
                if key == "engine" && val == "local" {
                    let s = s.clone();
                    let app = app.clone();
                    tauri::async_runtime::spawn(async move {
                        if let Err(e) = local::start(&s, &app).await {
                            s.log("WARN", "local", &e.message);
                        }
                    });
                }
            }
            Ok(engines::status(s))
        }
        "engine:transcribe" => engines::transcribe(s, app, &arg(a, 0)).await,
        "engine:format" => engines::format(s, &arg(a, 0)).await,
        "cloud:login" => engines::login(s, str_arg(a, 0), str_arg(a, 1), str_arg(a, 2)).await,
        "cloud:logout" => {
            let _ = engines::cloud_call(
                s,
                "/api/auth/logout",
                reqwest::Method::POST,
                None,
                None,
                Duration::from_secs(6),
            )
            .await;
            s.set_secret("cloud", "")?;
            s.set(
                "cloud",
                json!({"server":s.string("cloud.server"),"username":""}),
            )?;
            Ok(engines::cloud_status(s))
        }
        "cloud:health" => {
            let start = Instant::now();
            let v = engines::cloud_call(
                s,
                "/api/me",
                reqwest::Method::GET,
                None,
                None,
                Duration::from_secs(8),
            )
            .await?;
            Ok(
                json!({"ok":true,"latencyMs":start.elapsed().as_millis(),"username":v["username"],"model":v["asrModel"],"formattingModel":v["formattingModel"]}),
            )
        }
        "cloud:contrib-get" => {
            match engines::cloud_call(
                s,
                "/api/contribute",
                reqwest::Method::GET,
                None,
                None,
                Duration::from_secs(10),
            )
            .await
            {
                Err(e) if e.status == 404 || e.status == 405 => Ok(json!({"available":false})),
                other => other,
            }
        }
        "cloud:contrib-set" => {
            engines::cloud_call(
                s,
                "/api/contribute",
                reqwest::Method::POST,
                Some(json!({"enabled":arg(a,0)==true,"version":arg(a,1),"client":"desktop"})),
                None,
                Duration::from_secs(10),
            )
            .await
        }
        "cloud:contrib-delete" => {
            engines::cloud_call(
                s,
                "/api/contribute/recordings",
                reqwest::Method::DELETE,
                None,
                None,
                Duration::from_secs(20),
            )
            .await
        }
        "cloud:open-account" => {
            let server = engines::normalize_server(&s.string("cloud.server"))?;
            Ok(yes(native::open(&server, false)?))
        }
        "gemini:set-key" => engines::set_key(s, str_arg(a, 0)).await,
        "gemini:refresh-models" => engines::refresh_models(s).await,
        "local:install" => {
            let id = if str_arg(a, 0).is_empty() {
                s.string("localModel")
            } else {
                str_arg(a, 0).into()
            };
            local::install(s, app, &id).await
        }
        "local:cancel" => {
            s.download_cancel.store(true, Ordering::Relaxed);
            Ok(Value::Null)
        }
        "local:remove" => local::remove(s, app, str_arg(a, 0)).await,
        "local:start" => local::start(s, app).await,
        "local:stop" => Ok(local::stop(s, app).await),
        "local:select" => {
            let id = str_arg(a, 0);
            if !s.local_view.lock().unwrap()["models"][id].is_object() {
                return Err(Error::new("config", "Unknown model"));
            }
            s.set("localModel", json!(id))?;
            Ok(local::stop(s, app).await)
        }
        "local:open-folder" => {
            let p = storage::directory(s, "engines")?;
            Ok(yes(native::open(&p.to_string_lossy(), false)?))
        }
        "save-failed-audio" => storage::save(s, &arg(a, 0), &arg(a, 1), str_arg(a, 2)),
        "get-failed-recordings" => storage::recordings(s),
        "get-failed-recording-data" => {
            let base = str_arg(a, 0);
            if !storage::valid_base(base) {
                return Ok(Value::Null);
            }
            let file = storage::directory(s, "failed-recordings")?.join(format!("{base}.webm"));
            if !file.exists() {
                return Ok(Value::Null);
            }
            let data = std::fs::read(file).map_err(|e| Error::new("config", e.to_string()))?;
            use base64::Engine;
            Ok(json!(base64::engine::general_purpose::STANDARD.encode(data)))
        }
        "delete-failed-recording" => {
            let base = str_arg(a, 0);
            if !storage::valid_base(base) {
                return Ok(yes(false));
            }
            let dir = storage::directory(s, "failed-recordings")?;
            for ext in ["webm", "json"] {
                let path = dir.join(format!("{base}.{ext}"));
                if path.exists() {
                    std::fs::remove_file(path).map_err(|e| Error::new("config", e.to_string()))?;
                }
            }
            Ok(yes(true))
        }
        "show-recording-in-folder" => {
            let base = str_arg(a, 0);
            let dir = storage::directory(s, "failed-recordings")?;
            if storage::valid_base(base) {
                let path = dir.join(format!("{base}.webm"));
                if path.exists() {
                    return Ok(yes(native::open(&path.to_string_lossy(), true)?));
                }
            }
            native::open(&dir.to_string_lossy(), false)?;
            Ok(yes(false))
        }
        "open-recordings-folder" | "open-styles-folder" | "get-styles-dir" => {
            let name = if ch == "open-recordings-folder" {
                "failed-recordings"
            } else {
                "styles"
            };
            let dir = storage::directory(s, name)?;
            if ch != "get-styles-dir" {
                native::open(&dir.to_string_lossy(), false)?;
            }
            Ok(json!(dir.to_string_lossy()))
        }
        "import-styles-from-disk" => storage::import_folder(s),
        "import-style-file" => {
            let files = rfd::AsyncFileDialog::new()
                .set_title("Import Freesia style")
                .add_filter("Freesia style", &["json"])
                .pick_files()
                .await;
            let mut out = vec![];
            if let Some(files) = files {
                for file in files {
                    if let Ok(text) = String::from_utf8(file.read().await) {
                        out.extend(storage::styles(&text));
                    }
                }
            }
            Ok(json!(out))
        }
        "send-error-report" => Ok(yes(storage::report(s, &arg(a, 0)).await)),
        "apps:scan" => {
            let wanted = arg(a, 1).as_array().map(|a| {
                a.iter()
                    .filter_map(Value::as_str)
                    .map(str::to_owned)
                    .collect()
            });
            Ok(crate::apps::scan(s, arg(a, 0) == true, wanted, false).await)
        }
        "apps:running" => Ok(crate::apps::scan(s, false, None, true).await),
        _ => Err(Error::new(
            "config",
            format!("Unknown desktop command: {ch}"),
        )),
    }
}
