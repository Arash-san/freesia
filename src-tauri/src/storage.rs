use crate::{
    engines::{Error, Result},
    state::Shared,
};
use serde_json::{json, Value};
use std::fs;
pub fn directory(s: &Shared, name: &str) -> Result<std::path::PathBuf> {
    let path = s.root.join(name);
    fs::create_dir_all(&path).map_err(|e| Error::new("config", e.to_string()))?;
    Ok(path)
}
pub fn valid_base(base: &str) -> bool {
    base.starts_with("recording-")
        && base.len() > 10
        && base.len() < 150
        && base
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}
pub fn save(s: &Shared, audio: &Value, metadata: &Value, existing: &str) -> Result<Value> {
    let dir = directory(s, "failed-recordings")?;
    let base = if existing.is_empty() {
        format!(
            "recording-{}-{}",
            chrono::Utc::now().timestamp_millis(),
            uuid::Uuid::new_v4()
        )
    } else {
        existing.to_owned()
    };
    if !valid_base(&base) {
        return Err(Error::new("config", "Invalid recording id"));
    }
    if !audio.is_null() {
        let data = crate::engines::bytes(audio)?;
        fs::write(dir.join(format!("{base}.webm")), data)
            .map_err(|e| Error::new("config", e.to_string()))?;
    }
    crate::config::atomic_json(&dir.join(format!("{base}.json")), metadata)?;
    Ok(json!(base))
}
pub fn recordings(s: &Shared) -> Result<Value> {
    let dir = directory(s, "failed-recordings")?;
    let mut entries = vec![];
    for file in fs::read_dir(&dir)
        .map_err(|e| Error::new("config", e.to_string()))?
        .flatten()
    {
        let path = file.path();
        if path.extension().is_none_or(|e| e != "webm") {
            continue;
        }
        let Some(base) = path.file_stem().and_then(|s| s.to_str()) else {
            continue;
        };
        if !valid_base(base) {
            continue;
        }
        let mut meta: Value = fs::read_to_string(dir.join(format!("{base}.json")))
            .ok()
            .and_then(|t| serde_json::from_str(&t).ok())
            .filter(Value::is_object)
            .unwrap_or(json!({}));
        if let Ok(stat) = file.metadata() {
            meta["filename"] = json!(format!("{base}.webm"));
            meta["baseName"] = json!(base);
            meta["sizeMB"] = json!(format!("{:.1}", stat.len() as f64 / 1024. / 1024.));
            entries.push(meta);
        }
    }
    entries.sort_by(|a, b| {
        b["timestamp"]
            .as_str()
            .unwrap_or("")
            .cmp(a["timestamp"].as_str().unwrap_or(""))
    });
    Ok(json!(entries))
}
pub fn styles(text: &str) -> Vec<Value> {
    let Ok(data) = serde_json::from_str::<Value>(text.trim_start_matches('\u{feff}')) else {
        return vec![];
    };
    let list = if let Some(a) = data.as_array() {
        a.clone()
    } else if let Some(a) = data["styles"].as_array() {
        a.clone()
    } else {
        vec![data]
    };
    list.iter().filter_map(style).collect()
}
fn style(raw: &Value) -> Option<Value> {
    let name = raw["name"].as_str()?.trim();
    let prompt = raw["prompt"].as_str()?.trim();
    if name.is_empty() || prompt.is_empty() {
        return None;
    }
    let slug = regex::Regex::new("[^a-z0-9]+")
        .unwrap()
        .replace_all(&name.to_lowercase(), "-")
        .trim_matches('-')
        .chars()
        .take(32)
        .collect::<String>();
    let slug = if slug.is_empty() { "style" } else { &slug };
    let id = raw["id"]
        .as_str()
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
        .unwrap_or(format!("custom-{slug}"));
    let color = raw["color"].as_str().unwrap_or("");
    let color = if regex::Regex::new("^#[0-9a-fA-F]{6}$")
        .unwrap()
        .is_match(color)
    {
        color
    } else {
        "#B69CFF"
    };
    Some(
        json!({"id":id,"name":name.chars().take(40).collect::<String>(),"prompt":prompt.chars().take(4000).collect::<String>(),"icon":raw["icon"].as_str().unwrap_or("✨").chars().take(2).collect::<String>(),"color":color,"description":raw["description"].as_str().unwrap_or("").chars().take(120).collect::<String>(),"custom":true}),
    )
}
pub fn import_folder(s: &Shared) -> Result<Value> {
    let dir = directory(s, "styles")?;
    let mut out = vec![];
    for entry in fs::read_dir(dir)
        .map_err(|e| Error::new("config", e.to_string()))?
        .flatten()
    {
        if entry
            .path()
            .extension()
            .is_some_and(|e| e.to_string_lossy().eq_ignore_ascii_case("json"))
        {
            if let Ok(text) = fs::read_to_string(entry.path()) {
                out.extend(styles(&text));
            }
        }
    }
    Ok(json!(out))
}
pub async fn report(s: &Shared, p: &Value) -> bool {
    if !s.boolean("errorReporting") {
        return false;
    }
    let limit = |key: &str, max| {
        crate::state::redact(p[key].as_str().unwrap_or(""))
            .chars()
            .take(max)
            .collect::<String>()
    };
    let payload = json!({"installId":s.string("installId"),"appVersion":env!("CARGO_PKG_VERSION"),"platform":"win32 x64","osRelease":"Windows","engine":s.get("engine"),"level":limit("level",16),"context":limit("context",120),"message":limit("message",2000),"stack":limit("stack",6000),"ts":chrono::Utc::now().to_rfc3339()});
    s.client
        .post("https://freesia.arash-ahmadi.com/report")
        .json(&payload)
        .timeout(std::time::Duration::from_secs(8))
        .send()
        .await
        .is_ok_and(|r| r.status().is_success())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn paths_and_styles() {
        assert!(!valid_base("recording-../secret"));
        assert!(!valid_base("../config"));
        assert!(valid_base("recording-123-uuid"));
        let parsed = styles(r#"{"name":" Test ","prompt":"Rewrite","color":"bad"}"#);
        assert_eq!(parsed[0]["id"], "custom-test");
        assert_eq!(parsed[0]["color"], "#B69CFF");
    }
}
