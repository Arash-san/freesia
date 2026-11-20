#!/usr/bin/env bash
# CI check for the macOS disk images in dist/: each one mounts, holds a signed
# Freesia.app for the right processor, and that app starts and stays up.
# Run on a Mac after `npm run package:mac`.
set -euo pipefail
shopt -s nullglob

fail() { echo "::error::$*"; exit 1; }

dmgs=(dist/*.dmg)
[ "${#dmgs[@]}" -ge 2 ] || fail "Expected an arm64 and an x64 disk image in dist/, found ${#dmgs[@]}"

support="$HOME/Library/Application Support"
host="$(uname -m)"

# Start the app from a copy, wait until it has started, then read its own log
launch() {
  local app="$1" prefix="$2" work pid log
  work="$(mktemp -d)"
  ditto "$app" "$work/Freesia.app"
  # A fresh profile with error reports off: this run must not report to the collector
  for dir in "$support/freesia" "$support/Freesia"; do
    rm -rf "$dir"; mkdir -p "$dir"
    echo '{"errorReporting": false}' > "$dir/config.json"
  done
  $prefix "$work/Freesia.app/Contents/MacOS/Freesia" > "$work/stdout.log" 2>&1 &
  pid=$!
  # Wait for the app's own "starting" log line. The Intel build is slow the first
  # time, because Rosetta translates it, so allow two minutes.
  log=""
  for _ in $(seq 60); do
    sleep 2
    kill -0 "$pid" 2>/dev/null || break
    log="$(find "$support/freesia" "$support/Freesia" -maxdepth 1 -name freesia.log 2>/dev/null | head -1)"
    [ -n "$log" ] && grep -q "\[app\] Freesia .* starting" "$log" && break
  done
  # Then it has to stay up
  sleep 10
  if ! kill -0 "$pid" 2>/dev/null; then
    cat "$work/stdout.log"; [ -n "$log" ] && cat "$log"
    fail "Freesia exited soon after starting"
  fi
  kill "$pid" 2>/dev/null || true
  wait "$pid" 2>/dev/null || true
  [ -n "$log" ] || { cat "$work/stdout.log"; fail "Freesia wrote no log file"; }
  grep -q "\[app\] Freesia .* starting" "$log" || { cat "$log"; fail "Freesia did not finish starting"; }
  if grep -q "\[FATAL\]" "$log"; then cat "$log"; fail "Freesia logged a fatal error while starting"; fi
  echo "  started and stayed up: $(grep -m1 "starting" "$log")"
}

for dmg in "${dmgs[@]}"; do
  echo "$dmg"
  case "$dmg" in *arm64*) want=arm64 ;; *) want=x86_64 ;; esac
  mount="$(mktemp -d)"
  hdiutil attach "$dmg" -nobrowse -readonly -mountpoint "$mount" > /dev/null
  app="$mount/Freesia.app"
  [ -d "$app" ] || fail "$dmg has no Freesia.app"
  # Apple silicon refuses to open an app whose signature does not verify
  codesign --verify --deep --strict "$app" || fail "$dmg: the app signature does not verify"
  archs="$(lipo -archs "$app/Contents/MacOS/Freesia")"
  [ "$archs" = "$want" ] || fail "$dmg: built for '$archs', expected '$want'"
  /usr/libexec/PlistBuddy -c 'Print :NSMicrophoneUsageDescription' "$app/Contents/Info.plist" > /dev/null \
    || fail "$dmg: no microphone usage text, so macOS would block recording"
  echo "  signed, $archs"
  if [ "$want" = "$host" ]; then
    launch "$app" ""
  elif [ "$host" = arm64 ] && arch -x86_64 /usr/bin/true 2> /dev/null; then
    launch "$app" "arch -x86_64"   # the Intel build, under Rosetta
  else
    echo "  not started: this machine cannot run $want"
  fi
  hdiutil detach "$mount" > /dev/null
done
echo "macOS disk images OK"
