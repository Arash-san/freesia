use crate::{
    engines::{Error, Result},
    state::Shared,
};
use base64::{engine::general_purpose::STANDARD as B64, Engine};
use futures_util::StreamExt;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    path::PathBuf,
    time::{Duration, Instant},
};
use tauri::AppHandle;
use tokio::io::AsyncWriteExt;
#[derive(Default)]
pub struct Updater {
    pub manifest: Option<Value>,
    pub downloaded: Option<(Value, PathBuf)>,
    last_check: Option<Instant>,
}
fn emit(s: &Shared, app: &AppHandle, status: &str, extra: Value) -> Value {
    let mut state = s.update_view.lock().unwrap();
    for (k, v) in extra.as_object().unwrap() {
        state[k] = v.clone();
    }
    state["status"] = json!(status);
    let next = state.clone();
    drop(state);
    s.emit(app, "update-status", next.clone());
    next
}
fn error(s: &Shared, app: &AppHandle, u: &Updater, e: &Error) -> Value {
    if let Some((manifest, _)) = &u.downloaded {
        emit(
            s,
            app,
            "downloaded",
            json!({"message":format!("Version {} is ready. Latest check failed; try again when online.",manifest["version"].as_str().unwrap_or("")),"updateInfo":manifest,"progress":{"percent":100}}),
        )
    } else {
        emit(s, app, "error", json!({"message":e.message}))
    }
}
pub fn verify(v: &Value) -> Result<()> {
    let version = v["version"]
        .as_str()
        .ok_or_else(|| Error::new("server", "Update version is missing"))?;
    semver::Version::parse(version).map_err(|_| Error::new("server", "Invalid update version"))?;
    let url = v["url"].as_str().unwrap_or("");
    let parsed =
        url::Url::parse(url).map_err(|_| Error::new("server", "Invalid update address"))?;
    if parsed.scheme() != "https"
        || parsed.host_str() != Some("github.com")
        || !parsed
            .path()
            .to_lowercase()
            .starts_with("/arash-san/freesia/releases/download/rust-v")
        || !parsed.path().ends_with(".exe")
    {
        return Err(Error::new("server", "Untrusted update address"));
    }
    let hash = v["sha256"].as_str().unwrap_or("");
    if hash.len() != 64 || !hash.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(Error::new("server", "Invalid update checksum"));
    }
    let key = B64
        .decode(include_str!("update-public-key.txt").trim())
        .map_err(|_| Error::new("server", "Invalid update verification key"))?;
    let key = ed25519_dalek::VerifyingKey::from_bytes(
        &key.try_into()
            .map_err(|_| Error::new("server", "Invalid verification key"))?,
    )
    .map_err(|_| Error::new("server", "Invalid verification key"))?;
    let signature = B64
        .decode(v["signature"].as_str().unwrap_or(""))
        .map_err(|_| Error::new("server", "The update signature is missing"))?;
    let signature = ed25519_dalek::Signature::from_slice(&signature)
        .map_err(|_| Error::new("server", "Invalid update signature"))?;
    key.verify_strict(format!("{version}\n{url}\n{hash}\n").as_bytes(), &signature)
        .map_err(|_| Error::new("server", "Update signature verification failed"))
}
async fn find_update(s: &Shared) -> Result<Option<Value>> {
    let releases = s
        .client
        .get("https://api.github.com/repos/arash-san/freesia/releases?per_page=30")
        .header("Accept", "application/vnd.github+json")
        .timeout(Duration::from_secs(15))
        .send()
        .await?
        .error_for_status()?
        .json::<Value>()
        .await?;
    let current = semver::Version::parse(env!("CARGO_PKG_VERSION")).unwrap();
    let allow_pre = !current.pre.is_empty();
    let mut candidates = releases
        .as_array()
        .ok_or_else(|| Error::new("server", "Invalid release response"))?
        .iter()
        .filter(|r| r["draft"] != true && (allow_pre || r["prerelease"] != true))
        .filter_map(|r| {
            let tag = r["tag_name"].as_str()?.strip_prefix("rust-v")?;
            let version = semver::Version::parse(tag).ok()?;
            if version <= current {
                return None;
            }
            let asset = r["assets"]
                .as_array()?
                .iter()
                .find(|a| a["name"] == "freesia-rust-update.json")?;
            Some((version, asset["browser_download_url"].as_str()?.to_owned()))
        })
        .collect::<Vec<_>>();
    candidates.sort_by(|a, b| b.0.cmp(&a.0));
    if let Some((version, url)) = candidates.first() {
        let response = s
            .client
            .get(url)
            .timeout(Duration::from_secs(15))
            .send()
            .await?
            .error_for_status()?;
        if response.content_length().is_some_and(|len| len > 100000) {
            return Err(Error::new("server", "Update manifest is too large"));
        }
        let v = response.json::<Value>().await?;
        verify(&v)?;
        if v["version"] != version.to_string() {
            return Err(Error::new("server", "Update manifest version mismatch"));
        }
        Ok(Some(v))
    } else {
        Ok(None)
    }
}
pub async fn check(s: &Shared, app: &AppHandle, force: bool) -> Value {
    if cfg!(debug_assertions) {
        return emit(
            s,
            app,
            "disabled",
            json!({"message":"Updates are enabled in installed builds."}),
        );
    }
    let Ok(mut u) = s.update.try_lock() else {
        return s.update_view.lock().unwrap().clone();
    };
    if !force
        && u.last_check
            .is_some_and(|t| t.elapsed() < Duration::from_secs(60))
    {
        return s.update_view.lock().unwrap().clone();
    }
    u.last_check = Some(Instant::now());
    emit(
        s,
        app,
        "checking",
        json!({"message":"Checking for updates."}),
    );
    match find_update(s).await {
        Ok(Some(v)) => {
            let ready = u
                .downloaded
                .as_ref()
                .is_some_and(|(m, _)| m["version"] == v["version"]);
            if !ready {
                u.downloaded = None;
            }
            u.manifest = Some(v.clone());
            emit(
                s,
                app,
                if ready { "downloaded" } else { "available" },
                json!({"updateInfo":v,"progress":if ready{json!({"percent":100})}else{Value::Null},"message":if ready{"Update is ready. Restart to install."}else{"A new version of Freesia is available."}}),
            )
        }
        Ok(None) => {
            if u.downloaded.is_some() {
                error(
                    s,
                    app,
                    &u,
                    &Error::new("network", "Release check returned no newer release"),
                )
            } else {
                u.manifest = None;
                emit(
                    s,
                    app,
                    "current",
                    json!({"message":"Freesia is up to date.","updateInfo":null,"progress":null}),
                )
            }
        }
        Err(e) => error(s, app, &u, &e),
    }
}
pub async fn download(s: &Shared, app: &AppHandle) -> Value {
    let Ok(mut u) = s.update.try_lock() else {
        return s.update_view.lock().unwrap().clone();
    };
    let Some(v) = u.manifest.clone() else {
        return s.update_view.lock().unwrap().clone();
    };
    let result:Result<PathBuf>=async{verify(&v)?;emit(s,app,"downloading",json!({"progress":{"percent":0},"message":"Downloading update."}));let folder=s.root.join("updates");std::fs::create_dir_all(&folder).map_err(|e|Error::new("config",e.to_string()))?;
        let dest=folder.join(format!("Freesia-Rust-Setup-{}.exe",v["version"].as_str().unwrap()));let part=dest.with_extension("exe.part");
        let response=s.client.get(v["url"].as_str().unwrap()).timeout(Duration::from_secs(900)).send().await?.error_for_status()?;let total=response.content_length().unwrap_or(0);let mut stream=response.bytes_stream();let mut hash=Sha256::new();let mut file=tokio::fs::File::create(&part).await.map_err(|e|Error::new("config",e.to_string()))?;let mut got=0u64;let mut last=Instant::now();
        while let Some(chunk)=stream.next().await{let chunk=chunk?;got+=chunk.len() as u64;if got>512*1024*1024{return Err(Error::new("server","Update download is too large"))}hash.update(&chunk);file.write_all(&chunk).await.map_err(|e|Error::new("config",e.to_string()))?;if last.elapsed()>Duration::from_millis(250){let percent=if total>0{got*100/total}else{0};emit(s,app,"downloading",json!({"message":format!("Downloading update ({percent}%)."),"progress":{"percent":percent}}));last=Instant::now();}}
        file.flush().await.map_err(|e|Error::new("config",e.to_string()))?;drop(file);if format!("{:x}",hash.finalize())!=v["sha256"].as_str().unwrap(){let _=std::fs::remove_file(&part);return Err(Error::new("server","Update checksum verification failed"))}std::fs::rename(part,&dest).map_err(|e|Error::new("config",e.to_string()))?;Ok(dest)
    }.await;
    match result {
        Ok(path) => {
            u.downloaded = Some((v.clone(), path));
            emit(
                s,
                app,
                "downloaded",
                json!({"updateInfo":v,"progress":{"percent":100},"message":"Update is ready. Restart to install."}),
            )
        }
        Err(e) => error(s, app, &u, &e),
    }
}
pub async fn install(s: &Shared, app: &AppHandle) -> Value {
    {
        let a = s.activity.lock().unwrap();
        if a.recording || a.processing {
            return emit(
                s,
                app,
                "downloaded",
                json!({"message":"Finish dictation before restarting to update."}),
            );
        }
    }
    let confirmed = s.update_view.lock().unwrap()["updateInfo"]["version"].clone();
    check(s, app, true).await;
    let Ok(u) = s.update.try_lock() else {
        return s.update_view.lock().unwrap().clone();
    };
    let Some((manifest, path)) = &u.downloaded else {
        return s.update_view.lock().unwrap().clone();
    };
    if manifest["version"] != confirmed {
        return s.update_view.lock().unwrap().clone();
    }
    {
        let a = s.activity.lock().unwrap();
        if a.recording || a.processing {
            return emit(
                s,
                app,
                "downloaded",
                json!({"message":"Finish dictation before restarting to update."}),
            );
        }
    }
    let result: Result<()> = async {
        verify(manifest)?;
        let data = tokio::fs::read(path)
            .await
            .map_err(|e| Error::new("config", e.to_string()))?;
        if format!("{:x}", Sha256::digest(data)) != manifest["sha256"].as_str().unwrap() {
            return Err(Error::new(
                "server",
                "The installer checksum changed. Download it again.",
            ));
        }
        std::process::Command::new(path)
            .arg("/S")
            .arg("/R")
            .spawn()
            .map_err(|e| Error::new("server", e.to_string()))?;
        Ok(())
    }
    .await;
    match result {
        Ok(()) => {
            let v = emit(
                s,
                app,
                "installing",
                json!({"message":"Installing update. Freesia will reopen shortly."}),
            );
            s.quitting.store(true, std::sync::atomic::Ordering::Relaxed);
            app.exit(0);
            v
        }
        Err(e) => error(s, app, &u, &e),
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn refuses_unsigned_and_foreign_installers() {
        assert!(verify(&json!({"version":"4.0.1","url":"https://evil.example/installer.exe","sha256":"0".repeat(64),"signature":""})).is_err());
        assert!(verify(&json!({"version":"4.0.1","url":"https://github.com/arash-san/freesia/releases/download/rust-v4.0.1/Freesia.exe","sha256":"0".repeat(64),"signature":""})).is_err());
    }
}
