"""Exercise only the selected process's real Windows hotkey message callback.

No keyboard input is sent to the desktop. IDs match keyboard-types 0.7's Code
enum, pinned by Cargo.lock: F24=183, F23=182, Escape=114. Function keys use
Control+Alt+Shift so tests do not intercept a user's plain function keys.
"""
import argparse
import ctypes
from ctypes import wintypes as w
import json

p = argparse.ArgumentParser()
p.add_argument('--pid', type=int, required=True)
p.add_argument('--key', choices=['F24', 'F23', 'Escape'])
p.add_argument('--window', choices=['maximize', 'minimize', 'restore', 'close', 'activate'])
p.add_argument('--details', action='store_true')
args = p.parse_args()
user = ctypes.WinDLL('user32', use_last_error=True)
callback_type = ctypes.WINFUNCTYPE(w.BOOL, w.HWND, w.LPARAM)
user.EnumWindows.argtypes = [callback_type, w.LPARAM]
user.GetWindowThreadProcessId.argtypes = [w.HWND, ctypes.POINTER(w.DWORD)]
user.GetClassNameW.argtypes = [w.HWND, w.LPWSTR, ctypes.c_int]
user.GetWindowTextW.argtypes = [w.HWND, w.LPWSTR, ctypes.c_int]
user.PostMessageW.argtypes = [w.HWND, w.UINT, w.WPARAM, w.LPARAM]
user.SendMessageTimeoutW.argtypes = [w.HWND, w.UINT, w.WPARAM, w.LPARAM, w.UINT, w.UINT, ctypes.POINTER(ctypes.c_size_t)]
user.SendMessageTimeoutW.restype = w.LPARAM
user.ShowWindowAsync.argtypes = [w.HWND, ctypes.c_int]
user.SetForegroundWindow.argtypes = [w.HWND]
user.GetForegroundWindow.restype = w.HWND
windows = []

@callback_type
def visit(hwnd, _):
    pid = w.DWORD()
    user.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
    if pid.value == args.pid:
        cls, title = ctypes.create_unicode_buffer(256), ctypes.create_unicode_buffer(256)
        user.GetClassNameW(hwnd, cls, len(cls))
        user.GetWindowTextW(hwnd, title, len(title))
        windows.append((hwnd, cls.value, title.value))
    return True

user.EnumWindows(visit, 0)
hotkey = next((hwnd for hwnd, cls, _ in windows if cls == 'global_hotkey_app'), None)
main = next((hwnd for hwnd, _, title in windows if title == 'Freesia'), None)
result = {'hotkeyWindowFound': hotkey is not None, 'mainWindowFound': main is not None}
if args.window:
    assert main, 'No owned main window'
    if args.window == 'activate':
        result['posted'] = bool(user.ShowWindowAsync(main, 9))
        result['activated'] = bool(user.SetForegroundWindow(main))
    else:
        message, value = (0x10, 0) if args.window == 'close' else (0x112, {'maximize': 0xf030, 'minimize': 0xf020, 'restore': 0xf120}[args.window])
        result['posted'] = bool(user.PostMessageW(main, message, value, 0))
if args.key:
    assert hotkey, 'No owned global hotkey window'
    code, vk = {'F24': (183, 0x87), 'F23': (182, 0x86), 'Escape': (114, 0x1b)}[args.key]
    mods = 0 if args.key == 'Escape' else 0x209
    win_mods = 0 if args.key == 'Escape' else 7
    result['posted'] = bool(user.PostMessageW(hotkey, 0x312, (mods << 16) | code, (vk << 16) | win_mods))
if main:
    foreground_pid = w.DWORD()
    user.GetWindowThreadProcessId(user.GetForegroundWindow(), ctypes.byref(foreground_pid))
    result['foregroundOwned'] = foreground_pid.value == args.pid
    main_pid = w.DWORD()
    result['mainThreadId'] = user.GetWindowThreadProcessId(main, ctypes.byref(main_pid))
    response = ctypes.c_size_t()
    ctypes.set_last_error(0)
    result['responsive'] = bool(user.SendMessageTimeoutW(main, 0, 0, 0, 2, 2000, ctypes.byref(response)))
    result['pingError'] = ctypes.get_last_error()
if args.details:
    result['windows'] = [{'hwnd':int(hwnd),'class':cls,'title':title} for hwnd, cls, title in windows]
print(json.dumps(result))
