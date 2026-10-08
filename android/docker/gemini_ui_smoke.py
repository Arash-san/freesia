"""UI checks on a rooted disposable emulator, with no account or real API key.

Start the emulator, then run this inside freesia-android-emulator:2:
    python3 /work/docker/gemini_ui_smoke.py
Screenshots and UI dumps go to dist/gemini-ui. Uses the signed release APK.
"""
import json
import re
import subprocess
import time
from pathlib import Path
import xml.etree.ElementTree as ET

OUT = Path('/work/dist/gemini-ui')
OUT.mkdir(parents=True, exist_ok=True)
PKG = 'com.freesia.app'


def adb(*args):
    return subprocess.check_output(['adb', *args])


def nodes():
    adb('shell', 'uiautomator', 'dump', '/sdcard/ui.xml')
    data = adb('shell', 'cat', '/sdcard/ui.xml')
    (OUT / 'latest.xml').write_bytes(data)
    return [n.attrib for n in ET.fromstring(data).iter('node')]


def find(text, exact=True):
    return next((n for n in nodes() if (n.get('text') == text if exact else text in n.get('text', ''))), None)


def tap_node(node):
    assert node is not None, 'Missing target'
    x1, y1, x2, y2 = map(int, re.findall(r'\d+', node['bounds']))
    adb('shell', 'input', 'tap', str((x1 + x2) // 2), str((y1 + y2) // 2))
    time.sleep(1)


def tap(text):
    tap_node(find(text))


def check(condition, label):
    assert condition, label
    print('PASS', label, flush=True)


def shot(name):
    (OUT / (name + '.png')).write_bytes(adb('exec-out', 'screencap', '-p'))
    (OUT / (name + '.xml')).write_bytes(adb('shell', 'cat', '/sdcard/ui.xml'))


def swipe():
    adb('shell', 'input', 'swipe', '540', '1800', '540', '750', '350')
    time.sleep(0.7)


adb('wait-for-device')
for _ in range(120):
    if adb('shell', 'getprop', 'sys.boot_completed').strip() == b'1':
        break
    time.sleep(1)
else:
    raise RuntimeError('Emulator did not boot')
adb('root'); adb('wait-for-device')
apk = max(Path('/work/dist').glob('Freesia-Android-*.apk'), key=lambda p: p.stat().st_mtime)
adb('install', '-r', str(apk))
adb('shell', 'pm', 'clear', PKG)
adb('shell', 'am', 'start', '-n', PKG + '/.ui.MainActivity')
time.sleep(3)
tap('Get started')
check(find('Freesia Cloud') and find('Gemini'), 'Both engines offered before login')
tap('Gemini')
check(find('API key') is not None, 'Gemini setup available without Cloud account')
check(find('Username') is None, 'Gemini does not request Cloud login')
tap('Continue')
check(find('API key') is not None, 'Continue cannot advance until Gemini key saved')
shot('gemini-onboarding')

# Seed a large local dictionary and log to verify bounded panels. Never seed credentials.
adb('shell', 'am', 'force-stop', PKG)
prefs = '/data/user/0/' + PKG + '/shared_prefs/freesia_settings.xml'
uid = adb('shell', 'stat', '-c', '%u', prefs).decode().strip()
root = ET.fromstring(adb('shell', 'cat', prefs))
values = {
    'onboarded': ('boolean', 'true'), 'errorReporting': ('boolean', 'false'),
    'theme': ('string', 'dark'), 'engine': ('string', 'gemini'),
    'dictionary': ('string', json.dumps(['Word' + str(i) for i in range(30)])),
    'corrections': ('string', json.dumps([{'from': 'wrong' + str(i), 'to': 'right' + str(i)} for i in range(12)])),
}
for name, (tag, value) in values.items():
    for old in list(root):
        if old.get('name') == name:
            root.remove(old)
    node = ET.SubElement(root, tag, {'name': name})
    if tag == 'string': node.text = value
    else: node.set('value', value)
Path('/tmp/freesia_settings.xml').write_bytes(ET.tostring(root))
adb('push', '/tmp/freesia_settings.xml', prefs)
adb('shell', 'chown', uid + ':' + uid, prefs)
diag = '/data/user/0/' + PKG + '/files/diagnostics/diagnostics.json'
Path('/tmp/diagnostics.json').write_text(json.dumps([
    {'ts': int(time.time() * 1000), 'level': 'ERROR', 'context': 'android:smoke', 'message': 'Example error ' + str(i)} for i in range(50)
]))
adb('shell', 'mkdir', '-p', str(Path(diag).parent))
adb('push', '/tmp/diagnostics.json', diag)
adb('shell', 'chown', '-R', uid + ':' + uid, str(Path(diag).parent))
adb('shell', 'restorecon', '-R', '/data/user/0/' + PKG)
adb('shell', 'am', 'start', '-n', PKG + '/.ui.MainActivity')
time.sleep(3)
tap('Vocabulary')
check(find('Word5 ', exact=False) is not None and find('Word6 ', exact=False) is None, 'Vocabulary defaults to six words')
check(find('wrong1') is not None and find('wrong2') is None, 'Corrections default to two rows')
shot('vocabulary-compact')
tap('Show all')
check(find('Search words') is not None, 'Expanded vocabulary supports search')
shot('vocabulary-expanded')
tap('Show less')
tap('Settings')
check(find('Configure') is not None and find('API key') is None, 'Engine starts compact')
shot('settings-compact')
tap('Configure')
check(find('API key') is not None and find('Gemini') is not None, 'Engine configuration expands')
shot('engine-expanded')
tap('Close')
for _ in range(8):
    if find('View log'): break
    swipe()
check(find('View log') is not None and find('Example error 0') is None, 'Log starts collapsed')
tap('View log')
check(find('Example error 0') is not None, 'Local log expands')
check(find('Example error 49') is None, 'Large log uses bounded viewport')
shot('log-expanded')
tap('Hide log')
check(find('Example error 0') is None, 'Log collapses again')
adb('shell', 'am', 'force-stop', PKG)
adb('shell', 'am', 'start', '-n', PKG + '/.ui.MainActivity')
time.sleep(2)
tap('Settings')
tap('Configure')
check(find('API key') is not None, 'Gemini selection survives app restart')
crashes = adb('logcat', '-d', '-b', 'crash').decode()
check('FATAL EXCEPTION' not in crashes, 'No app crashes during UI checks')
print('Android Gemini UI smoke passed', flush=True)
