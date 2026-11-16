#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
mod apps;
mod config;
mod desktop;
mod engines;
mod ipc;
mod local;
mod native;
mod state;
mod storage;
mod updates;
mod wav;
use tauri::Manager;
fn main() {
    let args = std::env::args().collect::<Vec<_>>();
    let profile = args
        .windows(2)
        .find(|p| p[0] == "--profile")
        .map(|p| std::path::PathBuf::from(&p[1]));
    let isolated = profile.is_some();
    if !isolated && native::legacy_running() {
        rfd::MessageDialog::new().set_title("Freesia is already running")
            .set_description("Choose Quit from the existing Freesia tray icon, then open this version. Your settings and recordings will be kept.")
            .set_level(rfd::MessageLevel::Info).show();
        return;
    }
    let root = profile.unwrap_or_else(|| {
        std::path::PathBuf::from(
            std::env::var_os("APPDATA").expect("Windows application data directory"),
        )
        .join("freesia")
    });
    let no_shortcuts = args.iter().any(|a| a == "--no-shortcuts");
    let background = args.iter().any(|a| a == "--background");
    let services = match state::Services::new(root, no_shortcuts) {
        Ok(s) => s,
        Err(e) => {
            rfd::MessageDialog::new()
                .set_title("Freesia settings")
                .set_description(&e)
                .set_level(rfd::MessageLevel::Error)
                .show();
            return;
        }
    };
    if isolated && args.iter().any(|a| a == "--verify-migration") {
        let mut config = services.config.lock().unwrap();
        let mut result = serde_json::json!({});
        for name in ["cloud", "gemini", "localServer"] {
            let present = !config.string(&format!("secrets.{name}")).is_empty();
            let value = config.secret(name);
            let ok = !present || !value.is_empty();
            result[name] = serde_json::json!({"present":present,"unlocked":ok});
            if !ok {
                eprintln!("Could not unlock {name}");
                std::process::exit(1);
            }
            if present {
                config
                    .set_secret(name, &value)
                    .expect("credential roundtrip");
            }
        }
        println!("{}", result);
        return;
    }
    let setup = services.clone();
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            let state = app.state::<state::Shared>();
            desktop::show_main(&state, app);
        }))
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .manage(services.clone())
        .invoke_handler(tauri::generate_handler![ipc::ipc])
        .setup(move |app| {
            let handle = app.handle().clone();
            setup.log(
                "INFO",
                "app",
                &format!(
                    "Freesia {} starting (Rust, engine: {})",
                    env!("CARGO_PKG_VERSION"),
                    setup.string("engine")
                ),
            );
            if setup.boolean("softwareRendering") {
                setup.log(
                    "INFO",
                    "webview",
                    "Software rendering enabled for the interface",
                );
            }
            desktop::main_window(&setup, &handle, background)?;
            desktop::tray(&setup, &handle)?;
            desktop::register(&setup, &handle);
            if !isolated && setup.boolean("autoLaunch") {
                let _ = native::autostart(true);
            }
            let warm = setup.clone();
            let h = handle.clone();
            tauri::async_runtime::spawn(async move {
                if !warm.secret("gemini").is_empty() {
                    let _ = engines::refresh_models(&warm).await;
                }
                if warm.string("engine") == "local"
                    && warm.local_view.lock().unwrap()["configured"] == true
                {
                    let _ = local::start(&warm, &h).await;
                }
            });
            desktop::background_tasks(setup.clone(), handle);
            Ok(())
        });
    let app = builder
        .build(tauri::generate_context!())
        .expect("Freesia runtime");
    app.run(move |app, event| match event {
        tauri::RunEvent::ExitRequested { api, .. } => {
            if !services.quitting.load(std::sync::atomic::Ordering::Relaxed) {
                api.prevent_exit();
            }
        }
        tauri::RunEvent::Exit => {
            use tauri_plugin_global_shortcut::GlobalShortcutExt;
            let _ = app.global_shortcut().unregister_all();
            services
                .download_cancel
                .store(true, std::sync::atomic::Ordering::Relaxed);
            if let Ok(mut l) = services.local.try_lock() {
                l.stop();
            }
        }
        _ => {}
    });
}
