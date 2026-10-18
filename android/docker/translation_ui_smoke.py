"""Upgrade and recording-mode checks on a disposable Android emulator.

Uses only a local mock Cloud server and dummy credentials. Start the emulator,
then: python3 /work/docker/translation_ui_smoke.py
Requires both 3.2.0 and 3.2.1 APKs in dist. Evidence goes to dist/translation-ui.
"""
import json
import re
import subprocess
import threading
import time
import xml.etree.ElementTree as ET
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

OUT = Path('/work/dist/translation-ui')
OUT.mkdir(parents=True, exist_ok=True)
PKG = 'com.freesia.app'


class MockCloud(BaseHTTPRequestHandler):
    def log_message(self, *args): pass
    def reply(self, obj):
        data = json.dumps(obj).encode()
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)
    def do_GET(self):
        if self.path == '/api/contribute': return self.reply({'available': False})
        self.reply({'username': 'probe', 'usage': [], 'asrModel': 'mock', 'formattingModel': 'mock'})
    def do_POST(self):
        self.rfile.read(int(self.headers.get('Content-Length', 0)))
        self.reply({'username': 'probe', 'token': 'dummy-emulator-token', 'expiresInDays': 1})


def adb(*args):
    return subprocess.check_output(['adb', *args])


def nodes():
    adb('shell', 'uiautomator', 'dump', '/sdcard/ui.xml')
    data = adb('shell', 'cat', '/sdcard/ui.xml')
    (OUT / 'latest.xml').write_bytes(data)
    return [n.attrib for n in ET.fromstring(data).iter('node')]


def find(text):
    return next((n for n in nodes() if text in n.get('text', '')), None)


def tap_node(n):
    assert n is not None, 'Missing target'
    a, b, c, d = map(int, re.findall(r'\d+', n['bounds']))
    adb('shell', 'input', 'tap', str((a+c)//2), str((b+d)//2))
    time.sleep(1)


def tap(text): tap_node(find(text))


def wait_text(text, timeout=40):
    end = time.monotonic()+timeout
    while time.monotonic() < end:
        if find(text): return
        time.sleep(1)
    raise AssertionError('Missing text: '+text)


def check(value, label):
    assert value, label
    print('PASS '+label, flush=True)


def shot(name):
    (OUT / (name+'.png')).write_bytes(adb('exec-out', 'screencap', '-p'))


def launch():
    adb('shell', 'am', 'start', '-n', PKG+'/.ui.MainActivity')
    time.sleep(3)


def settings():
    tap('Settings')
    for _ in range(8):
        if find('Translate by default'): return
        adb('shell', 'input', 'swipe', '540', '1700', '540', '750', '350')
        time.sleep(0.5)
    raise AssertionError('Default translation control missing')


def prefs():
    return ET.fromstring(adb('shell', 'cat', '/data/user/0/'+PKG+'/shared_prefs/freesia_settings.xml'))


def value(key):
    n = next(n for n in prefs() if n.get('name') == key)
    return n.text if n.tag == 'string' else n.get('value')


adb('wait-for-device')
for _ in range(900):
    if adb('shell', 'getprop', 'sys.boot_completed').strip() == b'1': break
    time.sleep(1)
else: raise RuntimeError('Emulator did not boot')
adb('root'); adb('wait-for-device')
adb('logcat', '-c')
mock = ThreadingHTTPServer(('127.0.0.1', 8787), MockCloud)
threading.Thread(target=mock.serve_forever, daemon=True).start()
adb('reverse', 'tcp:8787', 'tcp:8787')
adb('install', '-r', '/work/dist/Freesia-Android-3.2.0.apk')
adb('shell', 'pm', 'clear', PKG)
uid = adb('shell', 'stat', '-c', '%u', '/data/user/0/'+PKG).decode().strip()
root = ET.Element('map')
for name, text in {'styleId': 'native', 'plainStyleId': 'casual', 'server': 'http://127.0.0.1:8787', 'theme': 'light', 'language': 'en'}.items():
    ET.SubElement(root, 'string', {'name': name}).text = text
for name, val in {'onboarded': 'true', 'autoStop': 'false', 'errorReporting': 'false'}.items():
    ET.SubElement(root, 'boolean', {'name': name, 'value': val})
Path('/tmp/translation-settings.xml').write_bytes(ET.tostring(root))
target = '/data/user/0/'+PKG+'/shared_prefs'
adb('shell', 'mkdir', '-p', target)
adb('push', '/tmp/translation-settings.xml', target+'/freesia_settings.xml')
adb('shell', 'chown', '-R', uid+':'+uid, target)
adb('shell', 'restorecon', '-R', target)
launch()
wait_text('Native Language')
check(value('styleId') == 'native', 'Old version retains the sticky translation default')
shot('before-upgrade')
adb('shell', 'am', 'force-stop', PKG)
adb('install', '-r', '/work/dist/Freesia-Android-3.2.1.apk')
adb('shell', 'pm', 'grant', PKG, 'android.permission.RECORD_AUDIO')
adb('shell', 'pm', 'grant', PKG, 'android.permission.POST_NOTIFICATIONS')
launch()
wait_text('Casual Chat')
check(value('styleId') == 'casual' and value('translationModeVersion') == '1', 'Upgrade restores the previous ordinary style once')
shot('after-upgrade')
tap('Settings'); tap('Configure'); tap('Sign in')
fields = [n for n in nodes() if n.get('class') == 'android.widget.EditText']
check(len(fields) == 3, 'Cloud sign-in has three fields')
tap_node(fields[1]); adb('shell', 'input', 'text', 'probe')
tap_node(fields[2]); adb('shell', 'input', 'text', 'dummy-password')
adb('shell', 'input', 'keyevent', '4')
buttons = [n for n in nodes() if n.get('text') == 'Sign in']
tap_node(buttons[-1])
wait_text('Signed in as probe')
tap('Home')
tap_node(next(n for n in nodes() if n.get('content-desc') == 'Start dictation'))
wait_text('Translate off')
tap('Translate off'); wait_text('Translate on')
check(value('styleId') == 'casual', 'Microphone translation does not change saved preferences')
shot('one-recording-translation')
tap('Cancel')
tap_node(next(n for n in nodes() if n.get('content-desc') == 'Start dictation'))
wait_text('Translate off')
check(value('styleId') == 'casual', 'Next recording starts with translation off')
tap('Cancel')
settings()
label = find('Translate by default')
_, y1, _, y2 = map(int, re.findall(r'\d+', label['bounds']))
switches = [n for n in nodes() if n.get('checkable') == 'true']
def distance(n):
    _, a, _, b = map(int, re.findall(r'\d+', n['bounds']))
    return abs((a+b)/2-(y1+y2)/2)
tap_node(min(switches, key=distance))
check(value('styleId') == 'native', 'Explicit Translate by default can be enabled')
adb('shell', 'am', 'force-stop', PKG); launch()
wait_text('Native Language')
check(value('styleId') == 'native', 'Explicit translation default survives a restart')
check(b'FATAL EXCEPTION' not in adb('logcat', '-d', '-b', 'crash'), 'No app crashes')
print('Translation UI smoke passed', flush=True)
mock.shutdown()
