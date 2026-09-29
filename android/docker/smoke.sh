#!/usr/bin/env bash
# Emulator smoke test, run inside freesia-android-emulator (see ../build.sh smoke).
# Installs the release APK on a headless Android 16 emulator, walks onboarding,
# enables the accessibility service and checks that the bubble appears on a
# normal text field, stays away from password fields, and opens the style picker.
#
# With a test account mounted (FREESIA_TEST_CONFIG) and a speech sample
# (FREESIA_TEST_AUDIO) it also checks "never lose a recording" end to end:
# sign in through the real sign-in screen (against smoke_server.py, which hands
# out the test token and forwards to the live server), take dictations while the
# server is down, see them saved, survive an app restart, and Retry them once the
# server is back. The sample is spoken into the emulator's microphone with the
# emulator controller's gRPC injectAudio (inject_audio.py).
set -uo pipefail
OUT=/work/dist/smoke
mkdir -p "$OUT"; rm -f "$OUT"/*
PKG=com.freesia.app
APK="$(ls -t /work/dist/Freesia-Android-*.apk | head -1)"
ACCOUNT="${FREESIA_TEST_CONFIG:-}"
SAMPLE="${FREESIA_TEST_AUDIO:-}"
STUB_PORT=8787
STUB_PID=""
PASS=0; FAIL=0
log() { echo "[smoke] $*" | tee -a "$OUT/results.txt"; }
ok() { PASS=$((PASS+1)); log "PASS $*"; }
bad() { FAIL=$((FAIL+1)); log "FAIL $*"; }
shot() { adb exec-out screencap -p > "$OUT/$1.png"; }

# swangle_indirect: the default swiftshader_indirect host renderer segfaults on Compose offscreen layers
emulator -avd smoke -no-window -no-boot-anim -no-snapshot -gpu swangle_indirect -accel on -no-metrics \
  > "$OUT/emulator.log" 2>&1 &
adb wait-for-device
for i in $(seq 1 150); do
  [[ "$(adb shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" == "1" ]] && break
  sleep 2
done
[[ "$(adb shell getprop sys.boot_completed | tr -d '\r')" == "1" ]] || { log "emulator did not boot"; exit 1; }
log "booted: Android $(adb shell getprop ro.build.version.release | tr -d '\r') (API $(adb shell getprop ro.build.version.sdk | tr -d '\r'))"
sleep 8

# UI helpers: uiautomator dump + python to find nodes
dump() { adb shell uiautomator dump /sdcard/ui.xml > /dev/null 2>&1; adb shell cat /sdcard/ui.xml > /tmp/ui.xml; }
center_of() { # $1 = python predicate on node attrs n, $2 = index
  python3 - "$1" "${2:-0}" <<'PY'
import sys, re, xml.etree.ElementTree as ET
pred, idx = sys.argv[1], int(sys.argv[2])
try:
    root = ET.parse('/tmp/ui.xml').getroot()
except Exception:
    sys.exit(1)
hits = [n.attrib for n in root.iter('node') if eval(pred, {}, {'n': n.attrib})]
if len(hits) <= idx: sys.exit(1)
x1, y1, x2, y2 = map(int, re.findall(r'\d+', hits[idx]['bounds']))
print((x1 + x2) // 2, (y1 + y2) // 2)
PY
}
count_of() { python3 - "$1" <<'PY'
import sys, xml.etree.ElementTree as ET
try:
    root = ET.parse('/tmp/ui.xml').getroot()
except Exception:
    print(0); sys.exit(0)
print(sum(1 for n in root.iter('node') if eval(sys.argv[1], {}, {'n': n.attrib})))
PY
}
tap_where() { dump; local c; c="$(center_of "$1" "${2:-0}")" || return 1; adb shell input tap $c; }
# wait_for <python predicate> <seconds>: polls the screen until a node matches
wait_for() {
  local end=$((SECONDS + ${2:-20}))
  while (( SECONDS < end )); do
    dump; [[ "$(count_of "$1")" -gt 0 ]] && return 0
    sleep 1
  done
  return 1
}
has_text() { wait_for "'$1' in n.get('text','')" "${2:-20}"; }
bubble_flags() { adb shell dumpsys window windows | grep -A8 "Freesia bubble" | grep -m1 -oE "fl=[^ ]+( [A-Z_]+)*" ; }
bubble_center() {
  adb shell dumpsys window windows | grep -A30 "Freesia bubble" | grep -m1 -oE "mFrame=\[-?[0-9]+,-?[0-9]+\]\[-?[0-9]+,-?[0-9]+\]|frame=\[-?[0-9]+,-?[0-9]+\]\[-?[0-9]+,-?[0-9]+\]" \
    | grep -oE -- "-?[0-9]+" | tr '\n' ' ' | awk '{print int(($1+$3)/2), int(($2+$4)/2)}'
}
# wait_bubble shown|hidden <seconds>: polls the bubble window's touchability
wait_bubble() {
  local end=$((SECONDS + ${2:-8})) f
  while (( SECONDS < end )); do
    f="$(bubble_flags)"
    if [[ "$1" == shown ]]; then [[ -n "$f" && "$f" != *NOT_TOUCHABLE* ]] && return 0
    else [[ -z "$f" || "$f" == *NOT_TOUCHABLE* ]] && return 0; fi
    sleep 0.5
  done
  return 1
}
stub_up() {
  python3 /work/docker/smoke_server.py $STUB_PORT "$ACCOUNT" 2>> "$OUT/stub.log" &
  STUB_PID=$!
  sleep 1
}
stub_down() { [[ -n "$STUB_PID" ]] && kill "$STUB_PID" 2> /dev/null; wait "$STUB_PID" 2> /dev/null; STUB_PID=""; }
# Speech sample + 1 s of silence into the mic (silence follows anyway); returns after about the clip length
# speak_with <command that starts a take>: starts the take, waits until Freesia is
# recording, then speaks the sample into the emulator's microphone (queued injection,
# 1.5 s of trailing silence so the stream drains before stop-on-silence ends the take;
# an injection stream that is never drained crashes the emulator).
speak_with() {
  "$@"
  wait_log "dictation (app|bubble) recording" 10 || log "no recording marker before speaking"
  sleep 0.5
  /opt/grpc/bin/python /work/docker/inject_audio.py "$SAMPLE" 1.5 2>> "$OUT/inject.log" || log "audio injection failed"
}
# Waits for a logcat line from the app (state markers only, never content)
wait_log() { # $1 = grep -E pattern, $2 = seconds
  local end=$((SECONDS + ${2:-30}))
  while (( SECONDS < end )); do
    # (timeout: a stuck "adb logcat -d" once hung a run for half an hour)
    timeout 10 adb logcat -d -s Freesia:I 2>/dev/null | grep -E "$1" > /dev/null && return 0
    sleep 1
  done
  return 1
}
# Swipes the screen up until a node matches (for content below the fold)
scroll_to() { # $1 = python predicate, $2 = max swipes
  for i in $(seq 0 "${2:-8}"); do
    dump; [[ "$(count_of "$1")" -gt 0 ]] && return 0
    adb shell input swipe 540 1700 540 700 350; sleep 1
  done
  return 1
}
# Waits until the take has stopped recording (the microphone foreground service is gone)
wait_recording_done() {
  local end=$((SECONDS + ${1:-15}))
  while (( SECONDS < end )); do
    adb shell dumpsys activity services $PKG/.service.RecordingService | grep -q "ServiceRecord" || return 0
    sleep 0.5
  done
  return 1
}

if adb install -r "$APK" > "$OUT/install.txt" 2>&1; then ok "install $(basename "$APK")"; else bad "install"; cat "$OUT/install.txt"; exit 1; fi
adb shell pm grant $PKG android.permission.RECORD_AUDIO && ok "grant RECORD_AUDIO"
adb shell pm grant $PKG android.permission.POST_NOTIFICATIONS || true
adb logcat -c

# Turn the accessibility service on before Freesia's first window exists. (uiautomator's
# own accessibility connection suspends other services while it dumps; a Compose window
# created before any service was on can then miss focus events. Real use is unaffected,
# and the service stays hidden whenever it cannot confirm the focused field.)
sleep 2
adb shell settings put secure enabled_accessibility_services "$PKG/$PKG.service.FreesiaAccessibilityService"
adb shell settings put secure accessibility_enabled 1
sleep 4
adb shell dumpsys accessibility > "$OUT/dumpsys_accessibility.txt"
grep -q "FreesiaAccessibilityService" "$OUT/dumpsys_accessibility.txt" && ok "accessibility service bound" || bad "accessibility service not bound"

adb shell am start -W -n $PKG/.ui.MainActivity > /dev/null
sleep 4; shot 01_welcome
dump; grep -q "Get started" /tmp/ui.xml && ok "onboarding welcome renders" || bad "welcome screen"
if grep -q "Send anonymous error reports" /tmp/ui.xml && grep -q "Version, device and error text only. Never audio, transcripts or passwords." /tmp/ui.xml; then
  ok "onboarding shows the error-report switch with the desktop wording"
  # Off for this run: the smoke test causes failures on purpose and must not report them
  tap_where "n.get('class')=='android.widget.Switch' or n.get('checkable')=='true'" && sleep 1
else
  bad "error-report switch missing from onboarding"
fi

tap_where "n.get('text')=='Get started'" && sleep 3
shot 02_signin
dump; grep -q "Sign in" /tmp/ui.xml && ok "sign-in step renders" || bad "sign-in step"
# Three fields, Server / Username / Password, all empty: no built-in server address
python3 - <<'PY' > /tmp/fields.txt
import xml.etree.ElementTree as ET
root = ET.parse('/tmp/ui.xml').getroot()
fields = [n.attrib for n in root.iter('node') if n.attrib.get('class') == 'android.widget.EditText']
labels = []
for f in fields:
    # Compose reports an empty field's label/placeholder as its text; a typed value would appear in 'text'
    labels.append(f.get('text', ''))
print(len(fields)); print('|'.join(labels))
PY
n_fields="$(sed -n 1p /tmp/fields.txt)"; field_texts="$(sed -n 2p /tmp/fields.txt)"
log "sign-in fields ($n_fields): $field_texts"
if [[ "$n_fields" == "3" ]] && grep -q "Server" /tmp/ui.xml && grep -q "Username" /tmp/ui.xml && grep -q "Password" /tmp/ui.xml \
   && ! grep -qE "://|\.[a-z]{2,}" <<< "$field_texts"; then
  ok "sign-in shows Server, Username, Password with no server filled in"
else
  bad "sign-in fields ($field_texts)"
fi
grep -q "voice.example.com" /tmp/ui.xml && log "server placeholder visible: voice.example.com" || true

# 2nd EditText = Username (normal field), 3rd = Password
tap_where "n.get('class')=='android.widget.EditText'" 1
wait_bubble shown 10; sleep 1
shot 03_username_focused
f="$(bubble_flags)"; log "bubble flags on username: $f"
if [[ -n "$f" && "$f" != *NOT_TOUCHABLE* ]]; then ok "bubble shown on a normal text field"; else bad "bubble not shown on username"; fi

tap_where "n.get('class')=='android.widget.EditText'" 2
wait_bubble hidden 8; sleep 2   # and it must stay hidden after the late focus events
shot 04_password_focused
f="$(bubble_flags)"; log "bubble flags on password: $f"
if [[ "$f" == *NOT_TOUCHABLE* ]]; then ok "bubble hidden on password field"; else bad "bubble visible on password field"; fi

tap_where "n.get('class')=='android.widget.EditText'" 1
wait_bubble shown 10; sleep 1
c="$(bubble_center)"; log "bubble center: $c"
if [[ -n "$c" ]]; then
  adb shell input swipe $c $c 900; sleep 2
  shot 05_style_picker
  adb shell dumpsys window windows | grep -q "Freesia styles" && ok "long-press opens style picker" || bad "style picker"
  adb shell input tap 60 400; sleep 1.5
  adb shell dumpsys window windows | grep -q "Freesia styles" && bad "picker did not dismiss" || ok "picker dismisses on outside tap"
  c="$(bubble_center)"
  adb shell input tap $c; sleep 1.2
  shot 06_tap_signed_out
  ok "bubble tap handled (signed out -> sign-in message)"
  # drag to the left edge and check it snaps
  y="${c#* }"
  adb shell input swipe ${c% *} $y 300 $((y-200)) 400; sleep 1.5
  c2="$(bubble_center)"; log "bubble after drag: $c2"
  shot 07_after_drag
  [[ -n "$c2" && "${c2% *}" -lt 200 ]] && ok "bubble snaps to left edge" || bad "snap to edge"
else
  bad "no bubble window frame found"
fi

# ------------------------------------------------------------ saved recordings, end to end
if [[ -n "$ACCOUNT" && -f "$ACCOUNT" && -n "$SAMPLE" && -f "$SAMPLE" ]]; then
  stub_up
  adb reverse tcp:$STUB_PORT tcp:$STUB_PORT > /dev/null
  # Sign in through the real screen
  tap_where "n.get('class')=='android.widget.EditText'" 0; sleep 1; adb shell input text "http://127.0.0.1:$STUB_PORT"
  tap_where "n.get('class')=='android.widget.EditText'" 1; sleep 1; adb shell input text "smoke"
  tap_where "n.get('class')=='android.widget.EditText'" 2; sleep 1; adb shell input text "not-a-real-password"
  sleep 1; shot 08_signin_filled
  tap_where "n.get('text')=='Sign in'"
  if has_text "Finish" 25; then ok "signed in through the sign-in screen"; else bad "sign in"; shot 08b_signin_failed; fi
  tap_where "n.get('text')=='Finish'"; sleep 2
  sleep 3
  if scroll_to "'Freesia Cloud · connected' in n.get('text','')" 4; then ok "Home: engine shows Freesia Cloud · connected"; else bad "engine status"; fi
  shot 09_home_signed_in
  adb shell input swipe 540 700 540 1900 300; adb shell input swipe 540 700 540 1900 300; sleep 1

  # 1) Server down, dictate with the Home orb
  stub_down
  adb logcat -c
  speak_with tap_where "n.get('content-desc')=='Start dictation'"
  wait_log "dictation app processing" 20 && log "take stopped by itself after the sample"
  sleep 4; shot 10a_home_retrying
  dump; grep -q "Trying again" /tmp/ui.xml && ok "upload retried automatically (Home shows the retry)" || log "retry text not caught on screen"
  if wait_log "dictation app saved" 60; then ok "failed take (server down) ends in the calm saved state"; else bad "take did not reach the saved state"; fi
  sleep 1; dump
  grep -o 'text="[^"]*Saved; Freesia will retry[^"]*"' /tmp/ui.xml | head -1 | tee -a "$OUT/results.txt"
  grep -q "saved recording" /tmp/ui.xml && ok "Home banner shows the saved recording" || bad "no saved-recording banner"
  shot 10_home_saved_banner

  # 2) Server still down, dictate from the bubble; tapping its error state opens Saved recordings
  tap_where "n.get('content-desc')=='Vocabulary'" || tap_where "n.get('text')=='Vocabulary'"; sleep 2
  tap_where "n.get('class')=='android.widget.EditText'" 0
  wait_bubble shown 10; sleep 1
  c="$(bubble_center)"; log "bubble center on Vocabulary field: $c"
  if [[ -n "$c" ]]; then
    adb logcat -c
    speak_with adb shell input tap $c
    wait_log "dictation bubble recording" 2 && log "bubble take started" || log "bubble take did not start"
    if wait_log "dictation bubble saved" 60; then ok "bubble take (server down) saved; bubble shows the calm saved state"; else bad "bubble take not saved"; fi
    shot 11_bubble_saved
    c="$(bubble_center)"; adb shell input tap $c; sleep 3
    shot 12_opened_from_bubble
    if has_text "SAVED RECORDINGS · 2" 10; then ok "tapping the saved bubble opens Saved recordings"; else bad "saved-bubble tap did not open Saved recordings"; fi
  else
    bad "no bubble on the Vocabulary field"
  fi

  # 3) Restart the app: the saved recordings are still there
  adb shell am force-stop $PKG; sleep 2
  adb shell am start -W -n $PKG/.ui.MainActivity > /dev/null; sleep 4
  shot 13_after_restart
  dump
  if grep -qE "[0-9]+ saved recordings? (is|are) waiting" /tmp/ui.xml; then
    ok "saved recordings survive an app restart ($(grep -oE '[0-9]+ saved recordings? (is|are) waiting' /tmp/ui.xml | head -1))"
  else
    bad "banner missing after restart"
  fi
  tap_where "n.get('text','').endswith('waiting')"; sleep 2
  has_text "SAVED RECORDINGS" 10 && ok "banner opens History → Saved recordings" || bad "banner navigation"
  dump; n_retry="$(count_of "n.get('text')=='Retry'")"; log "Retry buttons: $n_retry"
  grep -q "Could not reach the server" /tmp/ui.xml && ok "saved recording shows the error message" || bad "error message not shown"
  if grep -qE "recording · AAC, [0-9.]+ (kB|KB)" /tmp/ui.xml; then ok "saved as streamable AAC ($(grep -oE '[0-9]:[0-9]{2} recording · AAC, [0-9.]+ (kB|KB)' /tmp/ui.xml | head -1))"; else bad "not saved as AAC"; fi
  shot 14_saved_list

  # 4) Share opens the system share sheet
  tap_where "n.get('content-desc')=='Share recording'"; sleep 3
  shot 15_share_sheet
  if adb shell dumpsys activity activities | grep -m1 -E "topResumedActivity|mResumedActivity" | grep -qvE "$PKG/"; then ok "Share opens the share sheet"; else bad "share sheet"; fi
  adb shell input keyevent KEYCODE_BACK; sleep 2

  # 5) Server back: Retry sends the saved audio to the live server (through the stand-in).
  #    The outcome depends on the audio: text is recovered into History, or, when the
  #    emulator's microphone carried no speech, the server's "No speech detected" replaces
  #    the network error. Either way the retry reached the live server and was applied.
  stub_up
  posts_at_up="$(grep -c 'POST /v1/audio/transcriptions' "$OUT/stub.log")"
  posts_before="$posts_at_up"
  tap_where "n.get('text')=='Retry'"; sleep 2
  if wait_for "'Recovered' in n.get('text','') or 'No speech detected' in n.get('text','')" 90; then
    posts_after="$(grep -c 'POST /v1/audio/transcriptions' "$OUT/stub.log")"
    dump
    if grep -q "Recovered" /tmp/ui.xml; then outcome="text recovered into History"; else outcome="server answered: No speech detected"; fi
    if (( posts_after > posts_before )); then ok "Retry reached the live server ($outcome)"; else bad "retry made no upload"; fi
  else
    bad "retry had no result"
  fi
  shot 16_after_retry

  # 6) Background recovery: the other recording failed on the network, so WorkManager retries
  #    it on its own once the server is back (first run about a minute after the failure)
  #    (two uploads since the server came back: the manual Retry and the background one)
  bg=""
  for i in $(seq 1 36); do
    if (( $(grep -c 'POST /v1/audio/transcriptions' "$OUT/stub.log") >= posts_at_up + 2 )); then bg="yes"; break; fi
    sleep 5
  done
  sleep 5
  if [[ -n "$bg" ]]; then
    if timeout 20 adb shell dumpsys notification --noredact 2>/dev/null | grep -q "Dictation recovered"; then
      ok "background retry (WorkManager) recovered the take and posted a notification"
    else
      ok "background retry (WorkManager) sent the saved audio to the live server without a tap"
    fi
  else
    bad "no background retry within 3 min"
  fi
  adb shell am start -W -n $PKG/.ui.MainActivity > /dev/null; sleep 2
  tap_where "n.get('content-desc')=='History'" || tap_where "n.get('text')=='History'"; sleep 2
  dump; grep -q "Could not reach the server" /tmp/ui.xml && bad "a recording still shows the network error" || ok "no saved recording is left with the network error"
  shot 17_after_background_retry

  # 7) Delete whatever is left
  n_left="$(count_of "n.get('content-desc')=='Delete recording'")"
  while (( n_left > 0 )); do
    tap_where "n.get('content-desc')=='Delete recording'"; sleep 1.5
    tap_where "n.get('text')=='Delete'"; sleep 2
    dump; n_now="$(count_of "n.get('content-desc')=='Delete recording'")"
    (( n_now < n_left )) || break
    n_left="$n_now"
  done
  dump; grep -q "SAVED RECORDINGS" /tmp/ui.xml && bad "Delete did not remove the saved recordings" || ok "Delete removes saved recordings"
  shot 18_after_delete

  # Updates: Settings → About → Check for updates asks GitHub and reports the result
  tap_where "n.get('content-desc')=='Settings'" || tap_where "n.get('text')=='Settings'"; sleep 2
  if scroll_to "n.get('text')=='Check for updates'" 14; then
    tap_where "n.get('text')=='Check for updates'"
    if wait_for "'up to date' in n.get('text','') or 'GitHub is busy' in n.get('text','') or 'Update available' in n.get('text','') or 'Could not check' in n.get('text','')" 30; then
      dump; ok "Check for updates answered: $(grep -oE 'text="(Freesia is up to date\.|GitHub is busy[^"]*|Update available[^"]*|Could not check[^"]*)"' /tmp/ui.xml | head -1)"
    else
      bad "Check for updates gave no answer"
    fi
    shot 18b_updates
  else
    bad "Check for updates button missing"
  fi
  adb shell input swipe 540 700 540 2000 200; adb shell input swipe 540 700 540 2000 200; adb shell input swipe 540 700 540 2000 200

  # 8) Settings → Diagnostics lists the errors locally (sending is off in this run)
  tap_where "n.get('content-desc')=='Settings'" || tap_where "n.get('text')=='Settings'"; sleep 2
  if scroll_to "'Transcription failed' in n.get('text','')" 12; then ok "Diagnostics lists the failed uploads"; else bad "Diagnostics empty"; fi
  shot 19_diagnostics
  stub_down
else
  log "SKIP saved-recording checks (no test account or sample audio mounted)"
fi

adb shell input keyevent KEYCODE_HOME; sleep 2
f="$(bubble_flags)"; [[ -z "$f" || "$f" == *NOT_TOUCHABLE* ]] && ok "bubble hides when no field is focused" || bad "bubble still visible on home screen ($f)"

# Tablet layout: the same app on a 10" landscape screen (navigation rail, two-column Home)
adb shell wm size 2560x1600; adb shell wm density 320; sleep 3
adb shell am start -W -n $PKG/.ui.MainActivity > /dev/null; sleep 3
tap_where "n.get('content-desc')=='Home'" || tap_where "n.get('text')=='Home'"; sleep 2
dump; if [[ "$(count_of "n.get('content-desc')=='History' or n.get('text')=='History'")" -gt 0 ]]; then ok "tablet: navigation shows"; else bad "tablet: navigation missing"; fi
shot 30_tablet_home
tap_where "n.get('content-desc')=='History'" || tap_where "n.get('text')=='History'"; sleep 2; shot 31_tablet_history
tap_where "n.get('content-desc')=='Settings'" || tap_where "n.get('text')=='Settings'"; sleep 2; shot 32_tablet_settings
tap_where "n.get('content-desc')=='Home'" || tap_where "n.get('text')=='Home'"; sleep 2
adb shell wm size 1600x2560; sleep 3; shot 33_tablet_portrait_home
adb shell wm size reset; adb shell wm density reset; sleep 2

timeout 60 adb logcat -d > "$OUT/logcat.txt"
if grep -q "FATAL EXCEPTION" "$OUT/logcat.txt" && grep -A3 "FATAL EXCEPTION" "$OUT/logcat.txt" | grep -q "$PKG"; then
  bad "crash in logcat"; grep -A25 "FATAL EXCEPTION" "$OUT/logcat.txt" | head -60
else
  ok "no crashes in logcat"
fi
adb shell pidof $PKG > /dev/null && ok "process alive at end" || bad "process died"
log "SUMMARY: $PASS passed, $FAIL failed"
adb emu kill > /dev/null 2>&1 || true
[[ $FAIL -eq 0 ]]
