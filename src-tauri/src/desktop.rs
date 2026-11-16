use crate::{native, state::Shared};
use serde_json::{json, Value};
use std::{
    sync::atomic::Ordering,
    time::{Duration, Instant},
};
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Shortcut, ShortcutState};
use webview2_com::{
    Microsoft::Web::WebView2::Win32::*, PermissionRequestedEventHandler, ProcessFailedEventHandler,
    TrySuspendCompletedHandler,
};
use windows::core::Interface;

pub fn theme(s: &Shared) -> Value {
    let source = s.string("theme");
    json!({"source":source,"shouldUseDarkColors":if source=="dark"{true}else if source=="light"{false}else{native::system_dark()}})
}
pub fn memory(win: &WebviewWindow, low: bool, suspend: bool) {
    let state = win.app_handle().state::<Shared>().inner().clone();
    let is_main = win.label() == "main";
    if is_main && !suspend {
        state.main_suspended.store(false, Ordering::Relaxed);
    }
    let _ = win.with_webview(move |view| unsafe {
        if !low && !suspend {
            // WebView2 defers a new getUserMedia request while its controller
            // is hidden. Keep the HWND in the tray; only wake the browser view.
            let _ = view.controller().SetIsVisible(true);
        }
        if let Ok(core) = view.controller().CoreWebView2() {
            if let Ok(v) = core.cast::<ICoreWebView2_19>() {
                let _ = v.SetMemoryUsageTargetLevel(if low {
                    COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_LOW
                } else {
                    COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_NORMAL
                });
            }
            if let Ok(v) = core.cast::<ICoreWebView2_3>() {
                if suspend {
                    // Hiding the HWND alone does not always update the controller.
                    // WebView2 refuses suspension while its IsVisible flag is true.
                    let _ = view.controller().SetIsVisible(false);
                    let _ = v.TrySuspend(&TrySuspendCompletedHandler::create(Box::new(
                        move |result, suspended| {
                            if is_main && result.is_ok() && suspended {
                                state.main_suspended.store(true, Ordering::Relaxed);
                                state.log("INFO", "webview", "Idle main view suspended");
                            }
                            Ok(())
                        },
                    )));
                } else {
                    let _ = v.Resume();
                }
            }
        }
    });
}
fn visible(win: &WebviewWindow, show: bool) {
    let _ = win.emit("native-visibility", json!(show));
    let _=win.eval(&format!("window.__freesiaVisible={show};document.documentElement.toggleAttribute('data-native-hidden',!{show});window.dispatchEvent(new Event('freesia-visibility'));"));
    let needed = if win.label() == "main" {
        let s = win.app_handle().state::<Shared>();
        let a = s.activity.lock().unwrap();
        a.recording || a.processing
    } else {
        false
    };
    let _ = win.with_webview(move |view| unsafe {
        let _ = view.controller().SetIsVisible(show || needed);
    });
}
pub fn show_main(s: &Shared, app: &AppHandle) {
    if let Some(win) = app.get_webview_window("main") {
        memory(&win, false, false);
        let _ = win.unminimize();
        let _ = win.show();
        visible(&win, true);
        let _ = win.set_focus();
        let state = s.clone();
        let handle = app.clone();
        tauri::async_runtime::spawn(async move {
            crate::updates::check(&state, &handle, false).await;
        });
    }
}
pub fn hide_main(app: &AppHandle) {
    if let Some(win) = app.get_webview_window("main") {
        visible(&win, false);
        let _ = win.hide();
        memory(&win, true, false);
    }
}
pub fn browser_options(s: &Shared) -> String {
    let mut args="--autoplay-policy=no-user-gesture-required --disable-background-timer-throttling --disable-renderer-backgrounding".to_owned();
    if s.boolean("softwareRendering") {
        // A browser-only fallback for Windows graphics driver hangs. Local
        // speech inference has its own, independent GPU setting.
        args.push_str(" --disable-gpu");
    }
    if let Ok(port) = std::env::var("FREESIA_DEBUG_PORT") {
        if port.parse::<u16>().is_ok() {
            args.push_str(&format!(
                " --remote-debugging-port={port} --remote-debugging-address=127.0.0.1"
            ));
        }
    }
    if std::env::var("FREESIA_TEST_AUDIO").is_ok_and(|p| !p.is_empty()) {
        if let Ok(path) = std::env::var("FREESIA_TEST_AUDIO") {
            if !path.contains('"') {
                args.push_str(&format!(" --use-fake-ui-for-media-stream --use-fake-device-for-media-stream --use-file-for-fake-audio-capture=\"{path}\""));
            }
        }
    }
    args
}
fn secure_builder<'a>(
    builder: WebviewWindowBuilder<'a, tauri::Wry, AppHandle>,
) -> WebviewWindowBuilder<'a, tauri::Wry, AppHandle> {
    builder
        .on_navigation(|url| {
            url.host_str() == Some("tauri.localhost")
                || (url.scheme() == "tauri" && url.host_str() == Some("localhost"))
        })
        .on_new_window(|url, _| {
            if url.scheme() == "https" {
                let _ = native::open(url.as_str(), false);
            }
            tauri::webview::NewWindowResponse::Deny
        })
}
pub fn main_window(s: &Shared, app: &AppHandle, background: bool) -> tauri::Result<WebviewWindow> {
    let dark = theme(s)["shouldUseDarkColors"] == true;
    let builder = WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
        .title("Freesia")
        .inner_size(1140., 780.)
        .min_inner_size(820., 600.)
        .decorations(false)
        .visible(!background)
        .background_color(if dark {
            tauri::window::Color(11, 11, 13, 255)
        } else {
            tauri::window::Color(239, 238, 234, 255)
        })
        .data_directory(s.root.join("webview2"))
        .additional_browser_args(&browser_options(s));
    let win = secure_builder(builder).build()?;
    if let Some(icon) = app.default_window_icon() {
        let _ = win.set_icon(icon.clone());
    }
    let w = win.clone();
    let state = s.clone();
    let handle = app.clone();
    win.on_window_event(move |event| match event {
        tauri::WindowEvent::CloseRequested { api, .. } => {
            if !state.quitting.load(Ordering::Relaxed) {
                api.prevent_close();
                hide_main(&handle);
            }
        }
        tauri::WindowEvent::Resized(_) => {
            let minimized = w.is_minimized().unwrap_or(false);
            visible(&w, !minimized && w.is_visible().unwrap_or(false));
            let _ = w.emit(
                "window-state",
                json!({"maximized":w.is_maximized().unwrap_or(false)}),
            );
        }
        tauri::WindowEvent::ThemeChanged(_) => {
            let _ = w.emit("theme-updated", theme(&state));
        }
        _ => {}
    });
    let recovered = s.clone();
    let recovery_app = app.clone();
    let _ = win.with_webview(move |view| unsafe {
        if let Ok(core) = view.controller().CoreWebView2() {
            let mut token = 0;
            let _ = core.add_PermissionRequested(
                &PermissionRequestedEventHandler::create(Box::new(|_, args| {
                    if let Some(args) = args {
                        let mut kind = COREWEBVIEW2_PERMISSION_KIND::default();
                        args.PermissionKind(&mut kind)?;
                        // The renderer is local and cannot navigate. Requesting the microphone
                        // still happens only through the existing recording controls.
                        if kind == COREWEBVIEW2_PERMISSION_KIND_MICROPHONE {
                            args.SetState(COREWEBVIEW2_PERMISSION_STATE_ALLOW)?;
                        }
                    }
                    Ok(())
                })),
                &mut token,
            );
            let _ = core.add_ProcessFailed(
                &ProcessFailedEventHandler::create(Box::new(move |_, _| {
                    recovered.log(
                        "ERROR",
                        "webview",
                        "The main renderer stopped; reloading the interface.",
                    );
                    {
                        let mut activity = recovered.activity.lock().unwrap();
                        activity.recording = false;
                        activity.processing = false;
                    }
                    escape(&recovered, &recovery_app, false);
                    hide_overlay(&recovered, &recovery_app);
                    if let Some(window) = recovery_app.get_webview_window("main") {
                        let _ = window.reload();
                    }
                    Ok(())
                })),
                &mut token,
            );
        }
    });
    if background {
        visible(&win, false);
        memory(&win, true, false);
    }
    Ok(win)
}
fn ensure_overlay(s: &Shared, app: &AppHandle) -> Option<WebviewWindow> {
    if let Some(w) = app.get_webview_window("overlay") {
        return Some(w);
    }
    let w = secure_builder(
        WebviewWindowBuilder::new(app, "overlay", WebviewUrl::App("overlay.html".into()))
            .title("Freesia dictation")
            .inner_size(340., 104.)
            .decorations(false)
            .transparent(true)
            .background_color(tauri::window::Color(0, 0, 0, 0))
            .always_on_top(true)
            .skip_taskbar(true)
            .resizable(false)
            .focusable(false)
            .shadow(false)
            .visible(false)
            .data_directory(s.root.join("webview2"))
            .additional_browser_args(&browser_options(s)),
    )
    .build()
    .ok()?;
    let _ = w.set_ignore_cursor_events(true);
    Some(w)
}
pub fn show_overlay(s: &Shared, app: &AppHandle, state: &str, info: Value) {
    if !s.boolean("showOverlay") {
        return;
    }
    s.overlay_generation.fetch_add(1, Ordering::Relaxed);
    let mut msg = if info.is_object() { info } else { json!({}) };
    msg["state"] = json!(state);
    *s.overlay.lock().unwrap() = msg.clone();
    if let Some(w) = ensure_overlay(s, app) {
        memory(&w, false, false);
        let scale = w.scale_factor().unwrap_or(1.);
        let (x, y) = native::overlay_position(&s.get("overlayPosition"), scale);
        let _ = w.set_position(tauri::PhysicalPosition::new(x, y));
        if let Ok(hwnd) = w.hwnd() {
            native::topmost(hwnd.0 as isize);
        }
        let _ = w.show();
        visible(&w, true);
        let _ = w.emit("overlay-state", msg);
    }
}
pub fn set_overlay(s: &Shared, app: &AppHandle, state: &str, info: Value, hide_after: u64) {
    let generation = s.overlay_generation.fetch_add(1, Ordering::Relaxed) + 1;
    let mut msg = if info.is_object() { info } else { json!({}) };
    msg["state"] = json!(state);
    *s.overlay.lock().unwrap() = msg.clone();
    if let Some(w) = app.get_webview_window("overlay") {
        let _ = w.emit("overlay-state", msg);
    }
    if hide_after > 0 {
        let s = s.clone();
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(Duration::from_millis(hide_after)).await;
            if s.overlay_generation.load(Ordering::Relaxed) == generation {
                hide_overlay(&s, &app);
            }
        });
    }
}
pub fn hide_overlay(s: &Shared, app: &AppHandle) {
    set_overlay(s, app, "hidden", json!({}), 0);
    let generation = s.overlay_generation.load(Ordering::Relaxed);
    let s = s.clone();
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_millis(260)).await;
        if s.overlay_generation.load(Ordering::Relaxed) != generation {
            return;
        }
        let busy = {
            let a = s.activity.lock().unwrap();
            a.recording || a.processing
        };
        if !busy {
            if let Some(w) = app.get_webview_window("overlay") {
                let _ = w.destroy();
            }
        }
    });
}
pub fn overlay_event(app: &AppHandle, channel: &str, payload: Value) {
    if let Some(w) = app.get_webview_window("overlay") {
        let _ = w.emit(channel, payload);
    }
}
pub fn escape(s: &Shared, app: &AppHandle, enabled: bool) {
    if s.no_shortcuts {
        return;
    }
    if enabled {
        if app.global_shortcut().is_registered("Escape") {
            return;
        }
        let state = s.clone();
        let _ = app
            .global_shortcut()
            .on_shortcut("Escape", move |app, _, event| {
                if event.state == ShortcutState::Pressed {
                    cancel(&state, app);
                }
            });
    } else {
        let _ = app.global_shortcut().unregister("Escape");
    }
}
fn parse_shortcut(text: &str) -> Result<Shortcut, String> {
    if let Ok(shortcut) = text.parse::<Shortcut>() {
        return Ok(shortcut);
    }
    // Electron's recorder exposes F1 through F24. The dependency's string
    // parser stops at F12, although its Windows backend supports all of them.
    let (prefix, last) = text.rsplit_once('+').unwrap_or(("", text));
    let number = last
        .strip_prefix('F')
        .and_then(|s| s.parse::<usize>().ok())
        .filter(|n| (13..=24).contains(n))
        .ok_or("Invalid shortcut")?;
    let template = if prefix.is_empty() {
        "F12".to_owned()
    } else {
        format!("{prefix}+F12")
    };
    let base = template.parse::<Shortcut>().map_err(|e| e.to_string())?;
    let keys = [
        Code::F13,
        Code::F14,
        Code::F15,
        Code::F16,
        Code::F17,
        Code::F18,
        Code::F19,
        Code::F20,
        Code::F21,
        Code::F22,
        Code::F23,
        Code::F24,
    ];
    Ok(Shortcut::new(Some(base.mods), keys[number - 13]))
}
pub fn register(s: &Shared, app: &AppHandle) -> Value {
    let _ = app.global_shortcut().unregister_all();
    let mut result = json!({});
    for (key, mode) in [
        ("dictationShortcut", "dictate"),
        ("commandShortcut", "command"),
    ] {
        let shortcut = s.string(key).replace("Ctrl", "Control");
        let state = s.clone();
        let ok = match parse_shortcut(&shortcut) {
            Ok(_) if s.no_shortcuts => true,
            Ok(shortcut) => app
                .global_shortcut()
                .on_shortcut(shortcut, move |app, _, event| {
                    if event.state == ShortcutState::Pressed {
                        handle_shortcut(&state, app, mode);
                    }
                })
                .is_ok(),
            Err(_) => false,
        };
        result[key] = json!(ok);
    }
    if s.activity.lock().unwrap().recording {
        escape(s, app, true);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn preserves_renderer_shortcut_choices() {
        for key in [
            "Space", "Enter", "Tab", "`", "-", "=", "[", "]", "\\", ";", "'", ",", ".", "/", "Up",
            "Down", "Left", "Right", "Insert", "Delete", "Home", "End", "PageUp", "PageDown",
        ] {
            assert!(
                parse_shortcut(&format!("Ctrl+Shift+{key}")).is_ok(),
                "{key}"
            );
        }
        for n in 1..=24 {
            assert!(parse_shortcut(&format!("Ctrl+Alt+F{n}")).is_ok());
        }
        for n in 0..=9 {
            assert!(parse_shortcut(&format!("Ctrl+num{n}")).is_ok());
        }
        assert!(parse_shortcut("Ctrl+UnknownKey").is_err());
    }
}
pub fn cancel(s: &Shared, app: &AppHandle) {
    {
        let mut a = s.activity.lock().unwrap();
        if !a.recording {
            return;
        }
        a.recording = false;
        a.processing = false;
    }
    escape(s, app, false);
    s.emit(app, "dictation-cancel", Value::Null);
    hide_overlay(s, app);
}
pub fn handle_shortcut(s: &Shared, app: &AppHandle, mode: &str) {
    let stop = {
        let mut a = s.activity.lock().unwrap();
        if a.last_shortcut
            .is_some_and(|t| t.elapsed() < Duration::from_millis(350))
        {
            return;
        }
        a.last_shortcut = Some(Instant::now());
        if a.processing && a.since.elapsed() > Duration::from_secs(600) {
            a.processing = false;
            s.log("WARN", "shortcut", "Clearing stuck processing state");
        }
        if a.processing {
            return;
        }
        if a.recording {
            a.recording = false;
            a.processing = true;
            a.since = Instant::now();
            true
        } else {
            a.recording = true;
            a.mode = mode.into();
            false
        }
    };
    if let Some(w) = app.get_webview_window("main") {
        memory(&w, false, false);
    }
    if stop {
        escape(s, app, false);
        s.emit(app, "dictation-stop", json!(mode));
        set_overlay(s, app, "processing", json!({}), 0);
        return;
    }
    escape(s, app, true);
    show_overlay(s, app, "starting", json!({"mode":mode}));
    if mode == "command" {
        let s = s.clone();
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            let text = tauri::async_runtime::spawn_blocking(native::selection)
                .await
                .ok()
                .and_then(|r| r.ok())
                .unwrap_or_default();
            if !s.activity.lock().unwrap().recording {
                return;
            }
            if text.is_empty() {
                *s.overlay.lock().unwrap() = json!({"state":"starting","mode":"command","hint":"No selection: will write new text"});
            }
            s.emit(&app, "command-start", json!({"selection":text}));
        });
    } else {
        s.emit(app, "dictation-start", Value::Null);
    }
}
pub fn tray(s: &Shared, app: &AppHandle) -> tauri::Result<()> {
    use tauri::{
        menu::{Menu, MenuItem, PredefinedMenuItem},
        tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    };
    let open = MenuItem::with_id(app, "open", "Open Freesia", true, None::<&str>)?;
    let dictate = MenuItem::with_id(app, "dictate", "Start dictation", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
    let menu = Menu::with_items(
        app,
        &[
            &open,
            &PredefinedMenuItem::separator(app)?,
            &dictate,
            &PredefinedMenuItem::separator(app)?,
            &quit,
        ],
    )?;
    let state = s.clone();
    let clicked = s.clone();
    let mut tray = TrayIconBuilder::with_id("freesia")
        .tooltip("Freesia")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(move |app, event| match event.id.as_ref() {
            "open" => show_main(&state, app),
            "dictate" => handle_shortcut(&state, app, "dictate"),
            "quit" => {
                state.quitting.store(true, Ordering::Relaxed);
                app.exit(0);
            }
            _ => {}
        })
        .on_tray_icon_event(move |tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_main(&clicked, tray.app_handle());
            }
        });
    if let Ok(icon) = tauri::image::Image::from_bytes(include_bytes!("../../assets/tray.png")) {
        tray = tray.icon(icon);
    } else if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }
    tray.build(app)?;
    Ok(())
}
pub fn background_tasks(s: Shared, app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_secs(10)).await;
        crate::updates::check(&s, &app, false).await;
        let mut ticks = 0;
        loop {
            tokio::time::sleep(Duration::from_secs(15)).await;
            if s.quitting.load(Ordering::Relaxed) {
                break;
            }
            ticks += 1;
            if let Some(w) = app.get_webview_window("main") {
                let busy = {
                    let a = s.activity.lock().unwrap();
                    a.recording || a.processing
                };
                if !busy
                    && !s.main_suspended.load(Ordering::Relaxed)
                    && (!w.is_visible().unwrap_or(true) || w.is_minimized().unwrap_or(false))
                {
                    let _=w.eval("if(window.__freesiaTest?.canSuspend?.())window.__TAURI__.core.invoke('ipc',{channel:'native:suspend',args:[]});");
                }
            }
            if let Ok(mut l) = s.local.try_lock() {
                let mins = s.get("localUnloadMinutes").as_u64().unwrap_or(0);
                let exited = l
                    .child
                    .as_mut()
                    .is_some_and(|c| c.try_wait().ok().flatten().is_some());
                if exited
                    || (mins > 0
                        && l.last_used
                            .is_some_and(|t| t.elapsed() > Duration::from_secs(mins * 60)))
                {
                    l.stop();
                    l.emit(&s, &app);
                }
            }
            if ticks % 20 == 0 {
                crate::updates::check(&s, &app, false).await;
            }
        }
    });
}
