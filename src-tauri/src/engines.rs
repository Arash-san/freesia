use crate::state::Shared;
use base64::{engine::general_purpose::STANDARD as B64, Engine};
use serde_json::{json, Value};
use std::time::{Duration, Instant};
use tauri::AppHandle;

#[derive(Debug)]
pub struct Error {
    pub code: String,
    pub message: String,
    pub status: u16,
}
impl Error {
    pub fn new(code: &str, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
            status: 0,
        }
    }
    pub fn value(&self) -> Value {
        json!({"error":{"code":self.code,"message":self.message}})
    }
}
impl From<String> for Error {
    fn from(s: String) -> Self {
        Self::new("config", s)
    }
}
impl From<reqwest::Error> for Error {
    fn from(e: reqwest::Error) -> Self {
        if e.is_timeout() {
            Self::new(
                "timeout",
                "The server took too long to answer. Please try again.",
            )
        } else {
            Self::new(
                "network",
                "Could not reach the server. Check your connection.",
            )
        }
    }
}
pub type Result<T> = std::result::Result<T, Error>;
pub fn deadline(engine: &str, duration: f64) -> Duration {
    let (base, scale, cap) = match engine {
        "gemini" => (30000., 600., 300000.),
        "local" => (30000., 400., 600000.),
        _ => (20000., 250., 300000.),
    };
    Duration::from_millis((base + duration.max(0.) * scale).min(cap) as u64)
}
pub fn normalize_server(raw: &str) -> Result<String> {
    if raw.trim().is_empty() {
        return Err(Error::new(
            "config",
            "Enter your server address, for example https://voice.example.com",
        ));
    }
    let raw = raw.trim();
    let full = if raw.starts_with("http://") || raw.starts_with("https://") {
        raw.to_owned()
    } else {
        format!("https://{raw}")
    };
    let u = url::Url::parse(&full)
        .map_err(|_| Error::new("config", "That server address is not a valid URL."))?;
    if u.host_str().is_none()
        || (u.scheme() != "https"
            && !(u.scheme() == "http"
                && matches!(u.host_str(), Some("localhost" | "127.0.0.1" | "[::1]"))))
        || !u.username().is_empty()
        || u.password().is_some()
    {
        return Err(Error::new("config", "The server must use https://"));
    }
    Ok(u.origin().ascii_serialization())
}
pub fn cloud_status(s: &Shared) -> Value {
    json!({"configured":!s.secret("cloud").is_empty()&&!s.string("cloud.server").is_empty(),"server":s.string("cloud.server"),"username":s.string("cloud.username"),"signedOut":s.boolean("cloud.signedOut")})
}
pub fn gemini_status(s: &Shared) -> Value {
    let key = s.secret("gemini");
    let preview = if key.is_empty() {
        String::new()
    } else {
        format!(
            "{}••••{}",
            key.chars().take(6).collect::<String>(),
            key.chars()
                .rev()
                .take(3)
                .collect::<String>()
                .chars()
                .rev()
                .collect::<String>()
        )
    };
    json!({"configured":!key.is_empty(),"keyPreview":preview,"model":model(s),"models":s.models.lock().unwrap().clone()})
}
pub fn status(s: &Shared) -> Value {
    json!({"engine":s.get("engine"),"formatter":s.get("formatter"),"cloud":cloud_status(s),"gemini":gemini_status(s),"local":s.local_view.lock().unwrap().clone()})
}
pub async fn cloud_call(
    s: &Shared,
    path: &str,
    method: reqwest::Method,
    body: Option<Value>,
    form: Option<reqwest::multipart::Form>,
    timeout: Duration,
) -> Result<Value> {
    let server = s.string("cloud.server");
    let token = s.secret("cloud");
    if server.is_empty() || token.is_empty() {
        return Err(Error::new("config", "Sign in to Freesia Cloud first."));
    }
    let server = normalize_server(&server)?;
    let mut r = s
        .client
        .request(method, format!("{server}{path}"))
        .bearer_auth(token)
        .timeout(timeout);
    if let Some(v) = body {
        r = r.json(&v);
    }
    if let Some(f) = form {
        r = r.multipart(f);
    }
    let res = r.send().await?;
    let code = res.status().as_u16();
    let data = res.json::<Value>().await.unwrap_or(json!({}));
    if (200..300).contains(&code) {
        return Ok(data);
    }
    let message = data["error"]["message"]
        .as_str()
        .unwrap_or("The server returned an error.");
    if code == 401 {
        s.set_secret("cloud", "")?;
        let mut acct = s.get("cloud");
        acct["signedOut"] = json!(true);
        s.set("cloud", acct)?;
        return Err(Error::new(
            "auth",
            "Your Freesia Cloud session ended. Sign in again.",
        ));
    }
    Err(Error {
        code: match code {
            429 => "busy",
            400 | 413 => "audio",
            _ => "server",
        }
        .into(),
        message: message.into(),
        status: code,
    })
}
pub async fn login(s: &Shared, server: &str, username: &str, password: &str) -> Result<Value> {
    let server = normalize_server(server)?;
    let res=s.client.post(format!("{server}/api/auth/login")).json(&json!({"username":username,"password":password,"device":format!("Freesia on {}",std::env::var("COMPUTERNAME").unwrap_or_default())})).timeout(Duration::from_secs(20)).send().await?;
    let code = res.status().as_u16();
    let data = res.json::<Value>().await.unwrap_or(json!({}));
    let token = data["token"].as_str().unwrap_or("");
    if !(200..300).contains(&code) || token.is_empty() {
        return Err(Error::new(
            if code == 429 { "busy" } else { "auth" },
            data["error"]["message"]
                .as_str()
                .unwrap_or("Sign-in failed."),
        ));
    }
    s.set_secret("cloud", token)?;
    s.set(
        "cloud",
        json!({"server":server,"username":data["username"].as_str().unwrap_or(username)}),
    )?;
    Ok(cloud_status(s))
}
fn audio_form(audio: Vec<u8>, mime: &str, p: &Value) -> Result<reqwest::multipart::Form> {
    let ext = if mime.contains("wav") { "wav" } else { "webm" };
    let part = reqwest::multipart::Part::bytes(audio)
        .file_name(format!("dictation.{ext}"))
        .mime_str(mime)
        .map_err(|_| Error::new("audio", "Unsupported audio type"))?;
    let mut f = reqwest::multipart::Form::new().part("file", part);
    if let Some(lang) = p["language"]
        .as_str()
        .filter(|l| !l.is_empty() && *l != "auto")
    {
        f = f.text("language", lang.to_owned());
    }
    if let Some(prompt) = p["prompt"].as_str().filter(|s| !s.is_empty()) {
        f = f.text("prompt", prompt.chars().take(800).collect::<String>());
    }
    Ok(f)
}
pub fn bytes(v: &Value) -> Result<Vec<u8>> {
    if v.is_null() {
        return Ok(vec![]);
    }
    if let Some(t) = v.as_str() {
        B64.decode(t)
            .map_err(|_| Error::new("audio", "Invalid audio encoding"))
    } else {
        Err(Error::new("audio", "Invalid audio payload"))
    }
}
pub async fn transcribe(s: &Shared, app: &AppHandle, p: &Value) -> Result<Value> {
    let engine = p["engine"].as_str().unwrap_or("");
    let duration = p["durationSec"].as_f64().unwrap_or(0.);
    let mime = p["mime"].as_str().unwrap_or("audio/webm");
    let audio = bytes(&p["audio"])?;
    let mut out = match engine {
        "cloud" => {
            let translating = p["task"] == "translate";
            let mut data = None;
            if translating {
                match cloud_call(
                    s,
                    "/v1/audio/translations",
                    reqwest::Method::POST,
                    None,
                    Some(audio_form(audio.clone(), mime, p)?),
                    deadline("cloud", duration) * 2,
                )
                .await
                {
                    Ok(v) => data = Some(v),
                    Err(e) if e.status == 404 || e.status == 405 => {}
                    Err(e) => return Err(e),
                }
            }
            if let Some(v) = data {
                json!({"text":v["text"].as_str().unwrap_or("").trim(),"sourceText":v["source_text"].as_str().unwrap_or(""),"model":v["model"].as_str().unwrap_or(""),"translated":v["translated"]!=false})
            } else {
                let v = cloud_call(
                    s,
                    "/v1/audio/transcriptions",
                    reqwest::Method::POST,
                    None,
                    Some(audio_form(audio, mime, p)?),
                    deadline("cloud", duration),
                )
                .await?;
                json!({"text":v["text"].as_str().unwrap_or("").trim(),"model":v["model"].as_str().unwrap_or("Qwen3-ASR-1.7B")})
            }
        }
        "gemini" => {
            let parts = json!([{"inlineData":{"mimeType":mime.split(';').next().unwrap_or(mime),"data":B64.encode(audio)}},{"text":p["instruction"].as_str().unwrap_or("")}]);
            let models = transcribe_models(s);
            let mut result = None;
            let mut last = Error::new("model", "No Gemini model is available.");
            for (i, m) in models.iter().enumerate() {
                if i > 0 {
                    s.emit(app, "engine-retry", json!({"engine":"gemini","model":m}));
                }
                match generate(s, m, parts.clone(), deadline("gemini", duration), None).await {
                    Ok(text) => {
                        s.cooldowns.lock().unwrap().remove(m);
                        result = Some(json!({"text":text,"model":m}));
                        break;
                    }
                    Err(e) => {
                        let retry =
                            matches!(e.code.as_str(), "model" | "busy" | "server" | "timeout");
                        s.log("WARN", "gemini", &format!("{m}: {} {}", e.code, e.message));
                        if retry {
                            s.cooldowns.lock().unwrap().insert(
                                m.clone(),
                                Instant::now()
                                    + Duration::from_secs(if e.code == "model" {
                                        3600
                                    } else {
                                        120
                                    }),
                            );
                            last = e;
                        } else {
                            return Err(e);
                        }
                    }
                }
            }
            result.ok_or(last)?
        }
        "local" => crate::local::transcribe(s, app, bytes(&p["wav"])?, p).await?,
        _ => return Err(Error::new("config", "Unknown engine")),
    };
    out["engine"] = json!(engine);
    Ok(out)
}
pub async fn format(s: &Shared, p: &Value) -> Result<Value> {
    let prompt = p["prompt"].as_str().unwrap_or("");
    let temperature = p["temperature"].as_f64().unwrap_or(0.3);
    let timeout = Duration::from_millis((25000 + prompt.len() as u64 * 4).min(180000));
    let text = match p["engine"].as_str().unwrap_or("") {
        "cloud" => {
            let v=cloud_call(s,"/v1/chat/completions",reqwest::Method::POST,Some(json!({"messages":[{"role":"user","content":prompt}],"temperature":temperature})),None,timeout).await?;
            v["choices"][0]["message"]["content"]
                .as_str()
                .unwrap_or("")
                .trim()
                .to_owned()
        }
        "gemini" => {
            generate(
                s,
                &model(s),
                json!([{"text":prompt}]),
                timeout,
                Some(json!({"temperature":temperature})),
            )
            .await?
        }
        _ => return Err(Error::new("config", "No formatter")),
    };
    Ok(json!({"text":text}))
}
const BASE: &str = "https://generativelanguage.googleapis.com/v1beta";
const PREFERRED: [&str; 4] = [
    "gemini-3.5-flash-lite",
    "gemini-3.1-flash-lite",
    "gemini-3.6-flash",
    "gemini-3.7-flash",
];
fn model(s: &Shared) -> String {
    let v = s.string("geminiModel");
    if v.is_empty() {
        PREFERRED[0].into()
    } else {
        v
    }
}
fn blocked(t: &str) -> bool {
    regex::Regex::new(
        "(?i)embedding|aqa|imagen|veo|image|tts|live|computer|learnlm|nano.?banana|robotics",
    )
    .unwrap()
    .is_match(t)
}
fn classify(code: u16, msg: &str) -> Error {
    let m = msg.to_lowercase();
    let (kind, message) = if [
        "credits are depleted",
        "billing",
        "quota",
        "exceeded your current",
    ]
    .iter()
    .any(|s| m.contains(s))
    {
        (
            "quota",
            "Your Gemini credits or quota are used up. Switch engines or check Google AI Studio.",
        )
    } else if code == 401 || code == 403 || (code == 400 && m.contains("api key")) {
        ("auth", "Gemini rejected the API key.")
    } else if code == 404 || m.contains("not found") || m.contains("no longer available") {
        ("model", msg)
    } else if code == 429 || code == 503 || m.contains("high demand") || m.contains("overloaded") {
        ("busy", "Gemini is overloaded right now.")
    } else {
        ("server", msg)
    };
    Error {
        code: kind.into(),
        message: message.into(),
        status: code,
    }
}
async fn generate(
    s: &Shared,
    model: &str,
    parts: Value,
    timeout: Duration,
    generation: Option<Value>,
) -> Result<String> {
    if !model
        .bytes()
        .all(|c| c.is_ascii_alphanumeric() || b"._-".contains(&c))
    {
        return Err(Error::new("model", "Invalid Gemini model"));
    }
    let key = s.secret("gemini");
    if key.is_empty() {
        return Err(Error::new("config", "Add a Gemini API key first."));
    }
    let mut body = json!({"contents":[{"parts":parts}]});
    if let Some(g) = generation {
        body["generationConfig"] = g;
    }
    let res = s
        .client
        .post(format!("{BASE}/models/{model}:generateContent"))
        .header("x-goog-api-key", key)
        .json(&body)
        .timeout(timeout)
        .send()
        .await?;
    let code = res.status().as_u16();
    let v = res.json::<Value>().await.unwrap_or(json!({}));
    if !(200..300).contains(&code) {
        return Err(classify(
            code,
            v["error"]["message"]
                .as_str()
                .unwrap_or("Gemini returned an error."),
        ));
    }
    Ok(v["candidates"][0]["content"]["parts"]
        .as_array()
        .unwrap_or(&vec![])
        .iter()
        .filter(|p| p["thought"] != true)
        .filter_map(|p| p["text"].as_str())
        .collect::<String>()
        .trim()
        .to_owned())
}
async fn discover(s: &Shared, key: &str) -> Result<Vec<Value>> {
    let res = s
        .client
        .get(format!("{BASE}/models?pageSize=100"))
        .header("x-goog-api-key", key)
        .timeout(Duration::from_secs(12))
        .send()
        .await?;
    let code = res.status().as_u16();
    let v = res.json::<Value>().await.unwrap_or(json!({}));
    if !(200..300).contains(&code) {
        return Err(classify(
            code,
            v["error"]["message"].as_str().unwrap_or("Invalid API key"),
        ));
    }
    let mut models: Vec<_> = v["models"]
        .as_array()
        .unwrap_or(&vec![])
        .iter()
        .filter(|m| {
            m["supportedGenerationMethods"]
                .as_array()
                .is_some_and(|methods| methods.iter().any(|t| t == "generateContent"))
        })
        .filter_map(|m| {
            let id = m["name"]
                .as_str()?
                .trim_start_matches("models/")
                .to_lowercase();
            let name = m["displayName"].as_str().unwrap_or(&id);
            let description = m["description"].as_str().unwrap_or("");
            if !id.starts_with("gemini") || blocked(&format!("{id} {name} {description}")) {
                return None;
            }
            Some(json!({"id":id,"name":name,"description":description}))
        })
        .collect();
    models.sort_by(|a, b| {
        let rank = |v: &Value| PREFERRED.iter().position(|id| v["id"] == *id).unwrap_or(99);
        rank(a)
            .cmp(&rank(b))
            .then_with(|| b["id"].as_str().cmp(&a["id"].as_str()))
    });
    Ok(models)
}
pub async fn set_key(s: &Shared, key: &str) -> Result<Value> {
    let key = key.trim();
    if key.is_empty() {
        s.set_secret("gemini", "")?;
        s.models.lock().unwrap().clear();
        return Ok(gemini_status(s));
    }
    let models = discover(s, key).await?;
    s.set_secret("gemini", key)?;
    let current = model(s);
    if !models.iter().any(|m| m["id"] == current) {
        s.set(
            "geminiModel",
            models
                .first()
                .map(|m| m["id"].clone())
                .unwrap_or(json!(PREFERRED[0])),
        )?;
    }
    *s.models.lock().unwrap() = models;
    Ok(gemini_status(s))
}
pub async fn refresh_models(s: &Shared) -> Result<Value> {
    let key = s.secret("gemini");
    if key.is_empty() {
        return Ok(json!([]));
    }
    let models = discover(s, &key).await?;
    *s.models.lock().unwrap() = models.clone();
    Ok(json!(models))
}
fn transcribe_models(s: &Shared) -> Vec<String> {
    let mut list = vec![model(s).trim_start_matches("models/").to_lowercase()];
    let models = s.models.lock().unwrap();
    let found: Vec<String> = if models.is_empty() {
        vec![
            "gemini-3.6-flash".into(),
            "gemini-3.5-flash-lite".into(),
            "gemini-3.1-flash-lite".into(),
        ]
    } else {
        models
            .iter()
            .filter_map(|m| m["id"].as_str())
            .filter(|id| {
                id.starts_with("gemini-3")
                    && id.contains("flash")
                    && !["preview", "experimental", "latest"]
                        .iter()
                        .any(|t| id.contains(t))
                    && !blocked(id)
            })
            .map(str::to_owned)
            .collect()
    };
    for m in found {
        if !list.contains(&m) {
            list.push(m)
        }
    }
    let cooldown = s.cooldowns.lock().unwrap();
    let healthy: Vec<_> = list
        .iter()
        .filter(|m| !cooldown.get(*m).is_some_and(|t| *t > Instant::now()))
        .cloned()
        .collect();
    if !healthy.is_empty() {
        list = healthy;
    }
    list.truncate(3);
    list
}
