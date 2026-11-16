use crate::{
    config::Config,
    engines::{deadline, Error, Result},
    state::Shared,
    wav,
};
use futures_util::StreamExt;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::Read,
    path::{Path, PathBuf},
    sync::atomic::Ordering,
    time::{Duration, Instant},
};
use tauri::AppHandle;
use tokio::io::AsyncWriteExt;

fn specs() -> Value {
    let v: Value = serde_json::from_str(include_str!("local-models.json")).unwrap();
    json!({"RUNTIME":v["runtime"],"MODELS":v["models"]})
}
pub struct Local {
    root: PathBuf,
    pub child: Option<tokio::process::Child>,
    port: u16,
    model: String,
    device: String,
    pub last_used: Option<Instant>,
    pub starting: bool,
    pub error: String,
    pub downloading: Value,
}
impl Local {
    pub fn new(root: &Path) -> Self {
        Self {
            root: root.join("engines"),
            child: None,
            port: 0,
            model: String::new(),
            device: String::new(),
            last_used: None,
            starting: false,
            error: String::new(),
            downloading: Value::Null,
        }
    }
    fn runtime(&self) -> PathBuf {
        self.root.join(format!(
            "llama-{}",
            specs()["RUNTIME"]["version"].as_str().unwrap()
        ))
    }
    fn exe(&self) -> PathBuf {
        self.runtime().join("llama-server.exe")
    }
    fn model_dir(&self, id: &str) -> PathBuf {
        self.root.join("models").join(id)
    }
    fn installed(&self, id: &str) -> bool {
        specs()["MODELS"][id]["files"]
            .as_array()
            .is_some_and(|files| {
                files.iter().all(|f| {
                    self.model_dir(id)
                        .join(f["name"].as_str().unwrap())
                        .metadata()
                        .is_ok_and(|m| m.len() == f["size"].as_u64().unwrap_or(0))
                })
            })
    }
    fn selected(c: &Config) -> String {
        let id = c.string("localModel");
        if specs()["MODELS"][&id].is_object() {
            id
        } else {
            "qwen3-asr-1.7b".into()
        }
    }
    pub fn status(&self, c: &Config) -> Value {
        let all = specs();
        let mut models = json!({});
        for (id, m) in all["MODELS"].as_object().unwrap() {
            models[id] = json!({"id":id,"label":m["label"],"blurb":m["blurb"],"vramGB":m["vramGB"],"sizeBytes":m["files"].as_array().unwrap().iter().map(|f|f["size"].as_u64().unwrap_or(0)).sum::<u64>(),"installed":self.installed(id)});
        }
        let selected = Self::selected(c);
        json!({"runtimeInstalled":self.exe().is_file(),"models":models,"configured":self.exe().is_file()&&self.installed(&selected),"selected":selected,"running":self.child.is_some()&&self.port>0,"starting":self.starting,"device":self.device,"downloading":self.downloading,"error":self.error})
    }
    pub fn emit(&self, s: &Shared, app: &AppHandle) {
        let v = self.status(&s.config.lock().unwrap());
        *s.local_view.lock().unwrap() = v.clone();
        s.emit(app, "local-status", v);
    }
    pub fn stop(&mut self) {
        if let Some(mut child) = self.child.take() {
            let _ = child.start_kill();
            tauri::async_runtime::spawn(async move {
                let _ = child.wait().await;
            });
        }
        self.port = 0;
        self.model.clear();
        self.device.clear();
        self.last_used = None;
    }
}
impl Drop for Local {
    fn drop(&mut self) {
        if let Some(child) = &mut self.child {
            let _ = child.start_kill();
        }
    }
}
fn io(e: std::io::Error) -> Error {
    Error::new("config", e.to_string())
}
async fn fetch_file(
    s: &Shared,
    app: &AppHandle,
    l: &mut Local,
    spec: &Value,
    dest: &Path,
    base: u64,
) -> Result<()> {
    let part = dest.with_extension(format!(
        "{}.part",
        dest.extension().and_then(|e| e.to_str()).unwrap_or("")
    ));
    let size = spec["size"].as_u64().unwrap_or(0);
    let mut have = part.metadata().map(|m| m.len()).unwrap_or(0);
    if have > size {
        fs::remove_file(&part).map_err(io)?;
        have = 0;
    }
    if have < size {
        let mut r = s
            .client
            .get(spec["url"].as_str().unwrap())
            .timeout(Duration::from_secs(7200));
        if have > 0 {
            r = r.header("Range", format!("bytes={have}-"));
        }
        let res = r.send().await?;
        if !res.status().is_success() {
            return Err(Error::new(
                "network",
                format!("Download failed ({})", res.status()),
            ));
        }
        if have > 0 && res.status() != 206 {
            have = 0;
        }
        let mut file = tokio::fs::OpenOptions::new()
            .create(true)
            .write(true)
            .append(have > 0)
            .truncate(have == 0)
            .open(&part)
            .await
            .map_err(io)?;
        let mut stream = res.bytes_stream();
        let mut got = have;
        let mut last = Instant::now();
        loop {
            let chunk = tokio::select! {v=stream.next()=>v,_=tokio::time::sleep(Duration::from_millis(250))=>{if s.download_cancel.load(Ordering::Relaxed){return Err(Error::new("config","Download cancelled"))}continue;}};
            let Some(chunk) = chunk else { break };
            if s.download_cancel.load(Ordering::Relaxed) {
                return Err(Error::new("config", "Download cancelled"));
            }
            let chunk = chunk?;
            got += chunk.len() as u64;
            if got > size {
                return Err(Error::new(
                    "network",
                    "The download exceeded its expected size.",
                ));
            }
            file.write_all(&chunk).await.map_err(io)?;
            l.downloading["received"] = json!(base + got);
            if last.elapsed() > Duration::from_millis(250) {
                l.emit(s, app);
                last = Instant::now();
            }
        }
        file.flush().await.map_err(io)?;
    }
    let check = part.clone();
    let hash =
        tauri::async_runtime::spawn_blocking(move || -> std::result::Result<String, String> {
            let mut f = fs::File::open(check).map_err(|e| e.to_string())?;
            let mut hash = Sha256::new();
            let mut buffer = vec![0u8; 1024 * 1024];
            loop {
                let n = f.read(&mut buffer).map_err(|e| e.to_string())?;
                if n == 0 {
                    break;
                }
                hash.update(&buffer[..n]);
            }
            Ok(format!("{:x}", hash.finalize()))
        })
        .await
        .map_err(|e| Error::new("server", e.to_string()))?
        .map_err(Error::from)?;
    if hash != spec["sha256"].as_str().unwrap_or("") {
        let _ = fs::remove_file(&part);
        return Err(Error::new(
            "network",
            format!(
                "{} failed its checksum. Try the download again.",
                spec["name"].as_str().unwrap_or("Download")
            ),
        ));
    }
    fs::rename(part, dest).map_err(io)?;
    Ok(())
}
pub async fn install(s: &Shared, app: &AppHandle, id: &str) -> Result<Value> {
    let spec = specs();
    if !spec["MODELS"][id].is_object() {
        return Err(Error::new("config", "Unknown model"));
    }
    let mut l = s
        .local
        .try_lock()
        .map_err(|_| Error::new("busy", "The local engine is busy."))?;
    s.download_cancel.store(false, Ordering::Relaxed);
    let mut needed = vec![];
    if !l.exe().exists() {
        let mut r = spec["RUNTIME"].clone();
        r["name"] = json!(format!("llama-{}.zip", r["version"].as_str().unwrap()));
        r["runtime"] = json!(true);
        needed.push(r);
    }
    for f in spec["MODELS"][id]["files"].as_array().unwrap() {
        if !l
            .model_dir(id)
            .join(f["name"].as_str().unwrap())
            .metadata()
            .is_ok_and(|m| m.len() == f["size"].as_u64().unwrap_or(0))
        {
            needed.push(f.clone());
        }
    }
    let total = needed
        .iter()
        .map(|f| f["size"].as_u64().unwrap_or(0))
        .sum::<u64>();
    l.downloading = json!({"modelId":id,"received":0,"total":total});
    l.error.clear();
    l.emit(s, app);
    let result: Result<()> = async {
        fs::create_dir_all(l.model_dir(id)).map_err(io)?;
        let mut base = 0;
        for f in needed {
            let name = f["name"].as_str().unwrap();
            let dest = if f["runtime"] == true {
                l.root.join(name)
            } else {
                l.model_dir(id).join(name)
            };
            fetch_file(s, app, &mut l, &f, &dest, base).await?;
            base += f["size"].as_u64().unwrap_or(0);
            if f["runtime"] == true {
                fs::create_dir_all(l.runtime()).map_err(io)?;
                let status = tokio::time::timeout(
                    Duration::from_secs(120),
                    tokio::process::Command::new("tar.exe")
                        .args(["-xf"])
                        .arg(&dest)
                        .arg("-C")
                        .arg(l.runtime())
                        .creation_flags(0x08000000)
                        .kill_on_drop(true)
                        .status(),
                )
                .await
                .map_err(|_| Error::new("timeout", "Runtime extraction timed out"))?
                .map_err(io)?;
                if !status.success() {
                    return Err(Error::new("config", "Could not unpack the runtime."));
                }
                fs::remove_file(dest).map_err(io)?;
            }
        }
        s.set("localModel", json!(id))?;
        Ok(())
    }
    .await;
    l.downloading = Value::Null;
    if let Err(e) = &result {
        if !s.download_cancel.load(Ordering::Relaxed) {
            l.error = e.message.clone();
        }
    }
    l.emit(s, app);
    result?;
    Ok(l.status(&s.config.lock().unwrap()))
}
pub async fn remove(s: &Shared, app: &AppHandle, id: &str) -> Result<Value> {
    if !specs()["MODELS"][id].is_object() {
        return Err(Error::new("config", "Unknown model"));
    }
    let mut l = s.local.lock().await;
    if l.model == id {
        l.stop()
    }
    let dir = l.model_dir(id);
    if dir.exists() {
        fs::remove_dir_all(dir).map_err(io)?;
    }
    l.emit(s, app);
    Ok(l.status(&s.config.lock().unwrap()))
}
pub async fn start_locked(s: &Shared, app: &AppHandle, l: &mut Local) -> Result<u16> {
    let id = Local::selected(&s.config.lock().unwrap());
    if let Some(child) = &mut l.child {
        if child.try_wait().map_err(io)?.is_none() && l.model == id {
            return Ok(l.port);
        }
    }
    l.stop();
    if !l.exe().is_file() || !l.installed(&id) {
        return Err(Error::new("config", "Download the on-device model first."));
    }
    l.starting = true;
    l.emit(s, app);
    let result: Result<u16> = async {
        let output = tokio::time::timeout(
            Duration::from_secs(20),
            tokio::process::Command::new(l.exe())
                .arg("--list-devices")
                .current_dir(l.runtime())
                .creation_flags(0x08000000)
                .kill_on_drop(true)
                .output(),
        )
        .await;
        let text = output
            .ok()
            .and_then(|o| o.ok())
            .map(|o| {
                format!(
                    "{}\n{}",
                    String::from_utf8_lossy(&o.stdout),
                    String::from_utf8_lossy(&o.stderr)
                )
            })
            .unwrap_or_default();
        let device = if s.get("localUseGpu") != false {
            pick_device(&text)
        } else {
            None
        };
        let mut key = s.secret("localServer");
        if key.is_empty() {
            use rand::RngCore;
            let mut bytes = [0u8; 24];
            rand::thread_rng().fill_bytes(&mut bytes);
            key = bytes.iter().map(|b| format!("{b:02x}")).collect();
            s.set_secret("localServer", &key)?;
        }
        let listener = std::net::TcpListener::bind("127.0.0.1:0").map_err(io)?;
        let port = listener.local_addr().map_err(io)?.port();
        drop(listener);
        fs::create_dir_all(&l.root).map_err(io)?;
        let log = fs::File::create(l.root.join("llama-server.log")).map_err(io)?;
        let spec = specs();
        let files = spec["MODELS"][&id]["files"].as_array().unwrap();
        let mut command = tokio::process::Command::new(l.exe());
        command
            .arg("-m")
            .arg(l.model_dir(&id).join(files[0]["name"].as_str().unwrap()))
            .arg("--mmproj")
            .arg(l.model_dir(&id).join(files[1]["name"].as_str().unwrap()))
            .args([
                "-c",
                "12288",
                "-np",
                "1",
                "--no-webui",
                "--host",
                "127.0.0.1",
                "--port",
            ])
            .arg(port.to_string())
            .args(["--api-key", &key]);
        if let Some((id, name)) = device {
            command.args(["--device", &id, "-ngl", "99"]);
            l.device = name;
        } else {
            command.args(["--device", "none", "-ngl", "0"]);
            l.device = "CPU".into();
        }
        let mut child = command
            .current_dir(l.runtime())
            .creation_flags(0x08000000)
            .kill_on_drop(true)
            .stdin(std::process::Stdio::null())
            .stdout(log.try_clone().map_err(io)?)
            .stderr(log)
            .spawn()
            .map_err(io)?;
        if let Some(pid) = child.id() {
            if let Err(error) = crate::native::track_child(pid) {
                let _ = child.start_kill();
                let _ = child.wait().await;
                return Err(Error::new("config", error));
            }
        }
        l.child = Some(child);
        l.model = id;
        l.port = port;
        let until = Instant::now() + Duration::from_secs(120);
        while Instant::now() < until {
            if l.child.as_mut().unwrap().try_wait().map_err(io)?.is_some() {
                l.stop();
                return Err(Error::new(
                    "server",
                    "The on-device engine stopped while loading. See Settings → Logs.",
                ));
            }
            if s.client
                .get(format!("http://127.0.0.1:{port}/health"))
                .timeout(Duration::from_secs(2))
                .send()
                .await
                .is_ok_and(|r| r.status().is_success())
            {
                l.last_used = Some(Instant::now());
                return Ok(port);
            }
            tokio::time::sleep(Duration::from_millis(400)).await;
        }
        l.stop();
        Err(Error::new(
            "timeout",
            "The on-device engine took too long to load.",
        ))
    }
    .await;
    l.starting = false;
    if let Err(e) = &result {
        l.error = e.message.clone();
    } else {
        l.error.clear();
    }
    l.emit(s, app);
    result
}
pub async fn start(s: &Shared, app: &AppHandle) -> Result<Value> {
    let mut l = s.local.lock().await;
    start_locked(s, app, &mut l).await?;
    Ok(l.status(&s.config.lock().unwrap()))
}
pub async fn stop(s: &Shared, app: &AppHandle) -> Value {
    let mut l = s.local.lock().await;
    l.stop();
    l.emit(s, app);
    l.status(&s.config.lock().unwrap())
}
pub async fn transcribe(s: &Shared, app: &AppHandle, bytes: Vec<u8>, p: &Value) -> Result<Value> {
    let (rate, samples) = wav::parse(&bytes)?;
    let mut l = s.local.lock().await;
    let port = start_locked(s, app, &mut l).await?;
    let key = s.secret("localServer");
    let mut texts = vec![];
    for chunk in wav::split(&samples, rate) {
        let mut form = reqwest::multipart::Form::new().part(
            "file",
            reqwest::multipart::Part::bytes(wav::encode(chunk, rate))
                .file_name("audio.wav")
                .mime_str("audio/wav")
                .unwrap(),
        );
        if let Some(lang) = p["language"]
            .as_str()
            .filter(|l| *l != "auto" && !l.is_empty())
        {
            form = form.text("language", lang.to_owned());
        }
        if let Some(prompt) = p["prompt"].as_str() {
            form = form.text("prompt", prompt.chars().take(800).collect::<String>());
        }
        let res = s
            .client
            .post(format!("http://127.0.0.1:{port}/v1/audio/transcriptions"))
            .bearer_auth(&key)
            .multipart(form)
            .timeout(deadline("local", chunk.len() as f64 / rate as f64))
            .send()
            .await?;
        let ok = res.status().is_success();
        let data = res.json::<Value>().await.unwrap_or(json!({}));
        if !ok {
            return Err(Error::new(
                "server",
                data["error"]["message"]
                    .as_str()
                    .unwrap_or("On-device engine error"),
            ));
        }
        texts.push(clean(data["text"].as_str().unwrap_or("")));
    }
    l.last_used = Some(Instant::now());
    let model = specs()["MODELS"][&l.model]["label"].clone();
    Ok(
        json!({"text":texts.into_iter().filter(|t|!t.is_empty()).collect::<Vec<_>>().join(" ").trim(),"model":model}),
    )
}
pub fn clean(t: &str) -> String {
    regex::Regex::new(r"(?i)^\s*language\s+[A-Za-z_-]+\s*<asr_text>\s*")
        .unwrap()
        .replace(t, "")
        .trim()
        .into()
}
pub fn pick_device(t: &str) -> Option<(String, String)> {
    let re = regex::Regex::new(r"(?m)^\s*(Vulkan\d+):\s*(.+?)\s*\((\d+)\s*MiB").unwrap();
    let integrated =
        regex::Regex::new(r"(?i)Intel\(R\) (UHD|Iris|HD)|Radeon\(TM\) Graphics|Microsoft Basic")
            .unwrap();
    re.captures_iter(t)
        .filter_map(|c| {
            let mem = c[3].parse::<u64>().ok()?;
            if mem < 3000 || integrated.is_match(&c[2]) {
                None
            } else {
                Some((mem, c[1].to_owned(), c[2].to_owned()))
            }
        })
        .reduce(|best, d| if d.0 > best.0 { d } else { best })
        .map(|(_, id, name)| (id, name))
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn device_and_prefix() {
        assert_eq!(pick_device("Vulkan0: Intel(R) UHD (4000 MiB)\nVulkan1: RTX 4060 (8192 MiB)\nVulkan2: RTX 5090 (32768 MiB)").unwrap().0,"Vulkan2");
        assert_eq!(clean("language English<asr_text> hello"), "hello");
    }
}
