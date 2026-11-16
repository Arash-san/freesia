use crate::state::Shared;
use serde_json::{json, Value};
use std::{
    collections::BTreeMap,
    time::{Duration, Instant},
};
use tokio::io::AsyncWriteExt;
const SCAN: &str = r#"
$ErrorActionPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$rows = [Collections.Generic.List[object]]::new()
$shell = New-Object -ComObject WScript.Shell
$roots = @((Join-Path $env:ProgramData 'Microsoft\Windows\Start Menu\Programs'),(Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs'))
foreach ($root in $roots) {
 Get-ChildItem -LiteralPath $root -Filter *.lnk -Recurse -Depth 4 | ForEach-Object {
  $target = $shell.CreateShortcut($_.FullName).TargetPath
  if ($target -like '*.exe' -and (Test-Path -LiteralPath $target)) { $rows.Add(@{exe=$target;name=$_.BaseName;source='installed'}) }
 }
}
Get-ChildItem 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths','HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths' | ForEach-Object {
 $target = ([string]$_.GetValue('')).Trim('"')
 if ($target -and (Test-Path -LiteralPath $target)) { $rows.Add(@{exe=$target;name=[IO.Path]::GetFileNameWithoutExtension($target);source='installed'}) }
}
Get-Process | Where-Object {$_.MainWindowHandle -ne 0 -and $_.Path} | ForEach-Object {$rows.Add(@{exe=$_.Path;name=$_.Description;title=$_.MainWindowTitle;source='running'})}
ConvertTo-Json -InputObject @($rows.ToArray()) -Depth 4 -Compress
"#;
const RUNNING: &str = r#"[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); ConvertTo-Json -InputObject @(Get-Process | Where-Object {$_.MainWindowHandle -ne 0 -and $_.Path} | ForEach-Object {@{exe=$_.Path;name=$_.Description;title=$_.MainWindowTitle;source='running'}}) -Depth 4 -Compress"#;
async fn ps(script: &str, input: Option<String>) -> String {
    let encoded = base64::Engine::encode(
        &base64::engine::general_purpose::STANDARD,
        script
            .encode_utf16()
            .flat_map(u16::to_le_bytes)
            .collect::<Vec<_>>(),
    );
    let child = tokio::process::Command::new("powershell.exe")
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-EncodedCommand",
            &encoded,
        ])
        .creation_flags(0x08000000)
        .kill_on_drop(true)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .spawn();
    let Ok(mut child) = child else {
        return String::new();
    };
    if let Some(mut stdin) = child.stdin.take() {
        if let Some(text) = input {
            let _ = stdin.write_all(text.as_bytes()).await;
        }
        drop(stdin);
    }
    match tokio::time::timeout(Duration::from_secs(30), child.wait_with_output()).await {
        Ok(Ok(out)) => String::from_utf8_lossy(&out.stdout)
            .trim_start_matches('\u{feff}')
            .to_owned(),
        _ => String::new(),
    }
}
pub async fn scan(s: &Shared, force: bool, wanted: Option<Vec<String>>, running: bool) -> Value {
    let cached = if !running && !force {
        s.app_cache
            .lock()
            .unwrap()
            .as_ref()
            .filter(|(at, _)| at.elapsed() < Duration::from_secs(300))
            .map(|(_, list)| list.clone())
    } else {
        None
    };
    let mut list = if let Some(v) = cached {
        v
    } else {
        let text = ps(if running { RUNNING } else { SCAN }, None).await;
        let rows = serde_json::from_str::<Value>(&text).unwrap_or(json!([]));
        let mut map = BTreeMap::new();
        for row in rows.as_array().unwrap_or(&vec![]) {
            let exe = row["exe"].as_str().unwrap_or("");
            let path = std::path::Path::new(exe);
            if path
                .extension()
                .unwrap_or_default()
                .to_string_lossy()
                .to_lowercase()
                != "exe"
            {
                continue;
            }
            let key = path
                .file_stem()
                .unwrap_or_default()
                .to_string_lossy()
                .to_lowercase();
            if regex::Regex::new("^(uninst|unins\\d+|setup|update|updater|helper|crashpad|elevate)")
                .unwrap()
                .is_match(&key)
                || (running && (key == "freesia" || key == "freesia-desktop"))
            {
                continue;
            }
            map.entry(key.clone()).or_insert_with(||json!({"key":key,"name":row["name"].as_str().filter(|s|!s.is_empty()).unwrap_or(&key),"exe":exe,"source":row["source"],"title":row["title"].as_str().unwrap_or("")}));
        }
        let list = map.into_values().collect::<Vec<_>>();
        if !running {
            *s.app_cache.lock().unwrap() = Some((Instant::now(), list.clone()));
        }
        list
    };
    let todo: Vec<_> = list
        .iter()
        .filter(|a| {
            wanted
                .as_ref()
                .is_none_or(|w| w.iter().any(|k| a["key"] == *k))
        })
        .filter(|a| {
            !s.icon_cache
                .lock()
                .unwrap()
                .contains_key(a["exe"].as_str().unwrap_or(""))
        })
        .cloned()
        .collect();
    if !todo.is_empty() {
        let script = include_str!("../../src/main/app-icons.ps1");
        let input = todo
            .iter()
            .map(|a| {
                format!(
                    "{}|{}",
                    a["key"].as_str().unwrap_or(""),
                    a["exe"].as_str().unwrap_or("")
                )
            })
            .collect::<Vec<_>>()
            .join("\n");
        let out = ps(script, Some(input)).await;
        let mut icons = s.icon_cache.lock().unwrap();
        for line in out.lines() {
            if let Some((key, b64)) = line.split_once('|') {
                if let Some(a) = todo.iter().find(|a| a["key"] == key) {
                    icons.insert(
                        a["exe"].as_str().unwrap().to_owned(),
                        format!("data:image/png;base64,{}", b64.trim()),
                    );
                }
            }
        }
    }
    for a in &mut list {
        if let Some(icon) = s
            .icon_cache
            .lock()
            .unwrap()
            .get(a["exe"].as_str().unwrap_or(""))
        {
            a["icon"] = json!(icon);
        }
        if running {
            a.as_object_mut().unwrap().remove("exe");
        }
    }
    json!(list)
}
