//! Win32 keyboard and clipboard services. No resident scripting process.
use std::{
    ffi::c_void,
    mem::size_of,
    path::Path,
    sync::Mutex,
    thread::sleep,
    time::{Duration, Instant},
};
use winreg::{enums::*, RegKey};
static CLIPBOARD_JOB: Mutex<()> = Mutex::new(());
#[repr(C)]
#[derive(Clone, Copy, Default)]
struct Point {
    x: i32,
    y: i32,
}
#[repr(C)]
#[derive(Clone, Copy, Default)]
struct Rect {
    left: i32,
    top: i32,
    right: i32,
    bottom: i32,
}
#[repr(C)]
struct MonitorInfo {
    size: u32,
    monitor: Rect,
    work: Rect,
    flags: u32,
}
#[repr(C)]
#[derive(Clone, Copy, Default)]
struct Keyboard {
    vk: u16,
    scan: u16,
    flags: u32,
    time: u32,
    extra: usize,
}
#[repr(C)]
#[derive(Clone, Copy)]
union InputData {
    keyboard: Keyboard,
    mouse: [usize; 4],
}
#[repr(C)]
#[derive(Clone, Copy)]
struct Input {
    kind: u32,
    data: InputData,
}
#[link(name = "user32")]
extern "system" {
    fn SendInput(count: u32, inputs: *const Input, size: i32) -> u32;
    fn GetAsyncKeyState(key: i32) -> i16;
    fn OpenClipboard(window: isize) -> i32;
    fn CloseClipboard() -> i32;
    fn EmptyClipboard() -> i32;
    fn EnumClipboardFormats(format: u32) -> u32;
    fn GetClipboardData(format: u32) -> isize;
    fn SetClipboardData(format: u32, data: isize) -> isize;
    fn GetClipboardSequenceNumber() -> u32;
    fn GetForegroundWindow() -> isize;
    fn GetWindowThreadProcessId(window: isize, pid: *mut u32) -> u32;
    fn GetCursorPos(point: *mut Point) -> i32;
    fn MonitorFromPoint(point: Point, flags: u32) -> isize;
    fn GetMonitorInfoW(monitor: isize, info: *mut MonitorInfo) -> i32;
    fn CopyImage(image: isize, kind: u32, x: i32, y: i32, flags: u32) -> isize;
    fn SetWindowPos(
        window: isize,
        after: isize,
        x: i32,
        y: i32,
        cx: i32,
        cy: i32,
        flags: u32,
    ) -> i32;
}
#[link(name = "kernel32")]
extern "system" {
    fn GlobalSize(memory: isize) -> usize;
    fn GlobalLock(memory: isize) -> *mut c_void;
    fn GlobalUnlock(memory: isize) -> i32;
    fn GlobalAlloc(flags: u32, size: usize) -> isize;
    fn GlobalFree(memory: isize) -> isize;
    fn OpenProcess(access: u32, inherit: i32, pid: u32) -> isize;
    fn QueryFullProcessImageNameW(
        process: isize,
        flags: u32,
        buffer: *mut u16,
        size: *mut u32,
    ) -> i32;
    fn CloseHandle(handle: isize) -> i32;
}
#[link(name = "gdi32")]
extern "system" {
    fn DeleteObject(object: isize) -> i32;
    fn CopyEnhMetaFileW(file: isize, name: *const u16) -> isize;
    fn DeleteEnhMetaFile(file: isize) -> i32;
}
#[link(name = "shell32")]
extern "system" {
    fn ShellExecuteW(
        window: isize,
        operation: *const u16,
        file: *const u16,
        args: *const u16,
        dir: *const u16,
        show: i32,
    ) -> isize;
}
fn wide(t: &str) -> Vec<u16> {
    t.encode_utf16().chain(Some(0)).collect()
}
struct Clipboard;
impl Clipboard {
    fn open() -> Result<Self, String> {
        for _ in 0..20 {
            if unsafe { OpenClipboard(0) } != 0 {
                return Ok(Self);
            }
            sleep(Duration::from_millis(10));
        }
        Err("The clipboard is busy. Try again.".into())
    }
}
impl Drop for Clipboard {
    fn drop(&mut self) {
        unsafe {
            CloseClipboard();
        }
    }
}
enum ClipValue {
    Bytes(u32, Vec<u8>),
    Bitmap(isize),
    Metafile(isize),
}
struct Snapshot(Vec<ClipValue>);
unsafe impl Send for Snapshot {}
impl Drop for Snapshot {
    fn drop(&mut self) {
        for value in &self.0 {
            unsafe {
                match value {
                    ClipValue::Bitmap(h) if *h != 0 => {
                        DeleteObject(*h);
                    }
                    ClipValue::Metafile(h) if *h != 0 => {
                        DeleteEnhMetaFile(*h);
                    }
                    _ => {}
                }
            }
        }
    }
}
fn snapshot() -> Result<Snapshot, String> {
    let _clip = Clipboard::open()?;
    let mut result = vec![];
    let mut format = 0;
    loop {
        format = unsafe { EnumClipboardFormats(format) };
        if format == 0 {
            break;
        }
        let handle = unsafe { GetClipboardData(format) };
        if handle == 0 {
            continue;
        }
        if format == 2 {
            let copy = unsafe { CopyImage(handle, 0, 0, 0, 0x2000) };
            if copy != 0 {
                result.push(ClipValue::Bitmap(copy));
            }
            continue;
        }
        if format == 14 {
            let copy = unsafe { CopyEnhMetaFileW(handle, std::ptr::null()) };
            if copy != 0 {
                result.push(ClipValue::Metafile(copy));
            }
            continue;
        }
        // Display-owner formats and palettes use object handles, not HGLOBAL.
        if matches!(format, 3 | 9 | 0x80..=0x8e) {
            continue;
        }
        let len = unsafe { GlobalSize(handle) };
        if len == 0 {
            continue;
        }
        let data = unsafe { GlobalLock(handle) };
        if data.is_null() {
            continue;
        }
        let bytes = unsafe { std::slice::from_raw_parts(data as *const u8, len).to_vec() };
        unsafe {
            GlobalUnlock(handle);
        }
        result.push(ClipValue::Bytes(format, bytes));
    }
    Ok(Snapshot(result))
}
fn put_bytes(format: u32, bytes: &[u8]) -> bool {
    let h = unsafe { GlobalAlloc(2, bytes.len()) };
    if h == 0 {
        return false;
    }
    let p = unsafe { GlobalLock(h) };
    if p.is_null() {
        unsafe {
            GlobalFree(h);
        }
        return false;
    }
    unsafe {
        std::ptr::copy_nonoverlapping(bytes.as_ptr(), p as *mut u8, bytes.len());
        GlobalUnlock(h);
        if SetClipboardData(format, h) == 0 {
            GlobalFree(h);
            return false;
        }
    }
    true
}
fn restore(mut snap: Snapshot) -> Result<(), String> {
    let _clip = Clipboard::open()?;
    unsafe {
        EmptyClipboard();
    }
    for value in &mut snap.0 {
        match value {
            ClipValue::Bytes(f, b) => {
                put_bytes(*f, b);
            }
            ClipValue::Bitmap(h) => {
                if unsafe { SetClipboardData(2, *h) } != 0 {
                    *h = 0;
                }
            }
            ClipValue::Metafile(h) => {
                if unsafe { SetClipboardData(14, *h) } != 0 {
                    *h = 0;
                }
            }
        }
    }
    Ok(())
}
pub fn copy(text: &str) -> Result<(), String> {
    let _clip = Clipboard::open()?;
    let words = wide(text);
    let bytes: Vec<u8> = words.into_iter().flat_map(u16::to_le_bytes).collect();
    unsafe {
        EmptyClipboard();
    }
    if !put_bytes(13, &bytes) {
        return Err("Could not write to the clipboard.".into());
    }
    Ok(())
}
fn read() -> String {
    let Ok(_clip) = Clipboard::open() else {
        return String::new();
    };
    let h = unsafe { GetClipboardData(13) };
    if h == 0 {
        return String::new();
    }
    let size = unsafe { GlobalSize(h) } / 2;
    let p = unsafe { GlobalLock(h) } as *const u16;
    if p.is_null() {
        return String::new();
    }
    let words = unsafe { std::slice::from_raw_parts(p, size) };
    let end = words.iter().position(|c| *c == 0).unwrap_or(size);
    let text = String::from_utf16_lossy(&words[..end]);
    unsafe {
        GlobalUnlock(h);
    }
    text
}
fn chord(key: u16, scan: bool) -> bool {
    let until = Instant::now() + Duration::from_millis(1500);
    while Instant::now() < until {
        if ![0x10, 0x11, 0x12, 0x5b, 0x5c]
            .iter()
            .any(|k| unsafe { GetAsyncKeyState(*k) } < 0)
        {
            break;
        }
        sleep(Duration::from_millis(15));
    }
    let k = |key, up| Input {
        kind: 1,
        data: InputData {
            keyboard: Keyboard {
                vk: if scan { 0 } else { key },
                scan: if scan { key } else { 0 },
                flags: if scan { 8 } else { 0 } | if up { 2 } else { 0 },
                ..Default::default()
            },
        },
    };
    let ctrl = if scan { 0x1d } else { 0x11 };
    let inputs = [k(ctrl, false), k(key, false), k(key, true), k(ctrl, true)];
    let count = unsafe { SendInput(4, inputs.as_ptr(), size_of::<Input>() as i32) };
    if count != 4 {
        let release = [k(key, true), k(ctrl, true)];
        unsafe {
            SendInput(2, release.as_ptr(), size_of::<Input>() as i32);
        }
    }
    count == 4
}
pub fn inject(text: String) -> Result<bool, String> {
    let _job = CLIPBOARD_JOB.lock().unwrap();
    let saved = snapshot()?;
    copy(&text)?;
    sleep(Duration::from_millis(120));
    if !chord(0x2f, true) && !chord(0x56, false) {
        return Ok(false);
    }
    let sequence = unsafe { GetClipboardSequenceNumber() };
    std::thread::spawn(move || {
        sleep(Duration::from_millis(900));
        let _job = CLIPBOARD_JOB.lock().unwrap();
        if unsafe { GetClipboardSequenceNumber() } == sequence && read() == text {
            let _ = restore(saved);
        }
    });
    Ok(true)
}
pub fn selection() -> Result<String, String> {
    let _job = CLIPBOARD_JOB.lock().unwrap();
    let saved = snapshot()?;
    let sentinel = format!("\u{2063}freesia-{}", uuid::Uuid::new_v4());
    copy(&sentinel)?;
    let mut text = String::new();
    if chord(0x2e, true) {
        for _ in 0..8 {
            sleep(Duration::from_millis(40));
            let now = read();
            if now != sentinel {
                text = now;
                break;
            }
        }
    }
    restore(saved)?;
    Ok(text.chars().take(20000).collect())
}
pub fn foreground() -> String {
    let window = unsafe { GetForegroundWindow() };
    let mut pid = 0;
    unsafe {
        GetWindowThreadProcessId(window, &mut pid);
    }
    let process = unsafe { OpenProcess(0x1000, 0, pid) };
    if process == 0 {
        return String::new();
    }
    let mut buffer = vec![0u16; 32768];
    let mut len = buffer.len() as u32;
    let ok = unsafe { QueryFullProcessImageNameW(process, 0, buffer.as_mut_ptr(), &mut len) };
    unsafe {
        CloseHandle(process);
    }
    if ok == 0 {
        return String::new();
    }
    Path::new(&String::from_utf16_lossy(&buffer[..len as usize]))
        .file_stem()
        .unwrap_or_default()
        .to_string_lossy()
        .to_lowercase()
}
pub fn open(path: &str, reveal: bool) -> Result<bool, String> {
    let file = wide(if reveal { "explorer.exe" } else { path });
    let args = if reveal {
        wide(&format!("/select,\"{path}\""))
    } else {
        vec![0]
    };
    let code = unsafe {
        ShellExecuteW(
            0,
            wide("open").as_ptr(),
            file.as_ptr(),
            args.as_ptr(),
            std::ptr::null(),
            1,
        )
    };
    if code > 32 {
        Ok(true)
    } else {
        Err(format!("Windows could not open this item ({code})."))
    }
}
pub fn autostart(enabled: bool) -> Result<(), String> {
    let key = RegKey::predef(HKEY_CURRENT_USER)
        .create_subkey("Software\\Microsoft\\Windows\\CurrentVersion\\Run")
        .map_err(|e| e.to_string())?
        .0;
    if enabled {
        let exe = std::env::current_exe().map_err(|e| e.to_string())?;
        key.set_value("Freesia", &format!("\"{}\" --background", exe.display()))
            .map_err(|e| e.to_string())?;
    } else {
        let _ = key.delete_value("Freesia");
    }
    Ok(())
}
pub fn system_dark() -> bool {
    RegKey::predef(HKEY_CURRENT_USER)
        .open_subkey("Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize")
        .and_then(|k| k.get_value::<u32, _>("AppsUseLightTheme"))
        .unwrap_or(1)
        == 0
}
pub fn overlay_position(saved: &serde_json::Value, scale: f64) -> (i32, i32) {
    let mut point = Point::default();
    unsafe {
        GetCursorPos(&mut point);
    }
    let monitor = unsafe { MonitorFromPoint(point, 2) };
    let mut info = MonitorInfo {
        size: size_of::<MonitorInfo>() as u32,
        monitor: Rect::default(),
        work: Rect::default(),
        flags: 0,
    };
    unsafe {
        GetMonitorInfoW(monitor, &mut info);
    }
    let w = (340. * scale) as i32;
    let h = (104. * scale) as i32;
    let mut x = info.work.left + (info.work.right - info.work.left - w) / 2;
    let mut y = info.work.bottom - h - (28. * scale) as i32;
    if let (Some(sx), Some(sy)) = (saved["x"].as_i64(), saved["y"].as_i64()) {
        if sx >= 0 && sy >= 0 {
            let p = Point {
                x: sx as i32,
                y: sy as i32,
            };
            if unsafe { MonitorFromPoint(p, 0) } != 0 {
                x = sx as i32;
                y = sy as i32;
            }
        }
    }
    (x, y)
}
pub fn topmost(hwnd: isize) {
    unsafe {
        SetWindowPos(hwnd, -1, 0, 0, 0, 0, 0x0010 | 0x0001 | 0x0002);
    }
}

pub fn legacy_running() -> bool {
    #[repr(C)]
    struct Entry {
        size: u32,
        usage: u32,
        pid: u32,
        heap: usize,
        module: u32,
        threads: u32,
        parent: u32,
        priority: i32,
        flags: u32,
        exe: [u16; 260],
    }
    #[link(name = "kernel32")]
    extern "system" {
        fn CreateToolhelp32Snapshot(flags: u32, pid: u32) -> isize;
        fn Process32FirstW(snapshot: isize, entry: *mut Entry) -> i32;
        fn Process32NextW(snapshot: isize, entry: *mut Entry) -> i32;
    }
    unsafe {
        let snapshot = CreateToolhelp32Snapshot(2, 0);
        if snapshot == -1 {
            return false;
        }
        let mut entry: Entry = std::mem::zeroed();
        entry.size = size_of::<Entry>() as u32;
        let mut found = false;
        let mut ok = Process32FirstW(snapshot, &mut entry);
        while ok != 0 {
            let end = entry.exe.iter().position(|c| *c == 0).unwrap_or(260);
            if String::from_utf16_lossy(&entry.exe[..end]).eq_ignore_ascii_case("Freesia.exe") {
                found = true;
                break;
            }
            ok = Process32NextW(snapshot, &mut entry);
        }
        CloseHandle(snapshot);
        found
    }
}

// Windows closes this non-inherited handle if Freesia exits or crashes, so
// an interrupted local request cannot leave a model consuming GPU memory.
pub fn track_child(pid: u32) -> Result<(), String> {
    #[repr(C)]
    #[derive(Default)]
    struct Limits {
        process_time: i64,
        job_time: i64,
        flags: u32,
        minimum: usize,
        maximum: usize,
        active: u32,
        affinity: usize,
        priority: u32,
        scheduling: u32,
    }
    #[repr(C)]
    #[derive(Default)]
    struct Extended {
        basic: Limits,
        io: [u64; 6],
        process_memory: usize,
        job_memory: usize,
        peak_process: usize,
        peak_job: usize,
    }
    #[link(name = "kernel32")]
    extern "system" {
        fn CreateJobObjectW(attributes: *const c_void, name: *const u16) -> isize;
        fn SetInformationJobObject(job: isize, class: i32, info: *const c_void, size: u32) -> i32;
        fn AssignProcessToJobObject(job: isize, process: isize) -> i32;
    }
    static JOB: Mutex<isize> = Mutex::new(0);
    let mut job = JOB.lock().unwrap();
    unsafe {
        if *job == 0 {
            let created = CreateJobObjectW(std::ptr::null(), std::ptr::null());
            if created == 0 {
                return Err("Could not create the local-engine process group.".into());
            }
            let mut limits = Extended::default();
            limits.basic.flags = 0x2000;
            if SetInformationJobObject(
                created,
                9,
                &limits as *const _ as *const c_void,
                size_of::<Extended>() as u32,
            ) == 0
            {
                CloseHandle(created);
                return Err("Could not protect the local-engine process lifetime.".into());
            }
            *job = created;
        }
        let process = OpenProcess(0x0101, 0, pid);
        if process == 0 {
            return Err("Could not open the local-engine process.".into());
        }
        let ok = AssignProcessToJobObject(*job, process);
        CloseHandle(process);
        if ok == 0 {
            return Err("Could not attach the local engine to Freesia's process group.".into());
        }
    }
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn input_layout() {
        assert_eq!(size_of::<Input>(), 40);
    }
    #[test]
    #[ignore = "requires an unlocked desktop and exclusive clipboard access"]
    fn clipboard_roundtrip_preserves_previous_formats() {
        let _job = CLIPBOARD_JOB.lock().unwrap();
        let saved = snapshot().unwrap();
        let result = copy("Freesia native clipboard roundtrip");
        let readback = read();
        restore(saved).unwrap();
        result.unwrap();
        assert_eq!(readback, "Freesia native clipboard roundtrip");
    }
}
