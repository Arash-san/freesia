#!/usr/bin/env bash
# Freesia Android build, entirely inside Docker (no Android SDK on the host).
#
#   ./build.sh            build image, run unit tests + lint, assemble the signed release APK
#   ./build.sh test       unit tests only (live API tests too, if ../.tmp/android-test.json exists)
#   ./build.sh keystore   create the release keystore in ~/.freesia-android (once)
#   ./build.sh smoke      install the APK on a headless Android 16 emulator and run smoke checks
#   ./build.sh shell      open a shell in the build container
#
# Output: dist/Freesia-Android-<version>.apk
# Secrets: ~/.freesia-android/{release.jks,keystore.properties} are mounted read-only
# and never copied into the repository or the image.
set -euo pipefail

IMAGE="freesia-android-build:1"
GRADLE_VOLUME="freesia-gradle-cache"
WORK_VOLUME="freesia-android-work"

# ---------------------------------------------------------------- inside the container
if [[ "${FREESIA_IN_CONTAINER:-}" == "1" ]]; then
  mode="${1:-build}"
  if [[ "$mode" == "keystore" ]]; then
    out=/keys
    if [[ -f "$out/release.jks" ]]; then echo "Keystore already exists, leaving it alone."; exit 0; fi
    pass="$(head -c 48 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 32)"
    keytool -genkeypair -v -keystore "$out/release.jks" -storetype PKCS12 -alias freesia \
      -keyalg RSA -keysize 4096 -validity 10000 -storepass "$pass" -keypass "$pass" \
      -dname "CN=Freesia, O=Freesia, C=US" > /dev/null 2>&1
    printf 'storeFile=release.jks\nstorePassword=%s\nkeyAlias=freesia\nkeyPassword=%s\n' "$pass" "$pass" > "$out/keystore.properties"
    echo "Created $out/release.jks and keystore.properties"
    exit 0
  fi

  # Build from a copy on a Docker volume: much faster than a Windows bind mount.
  mkdir -p /build/app
  # Mirror the sources (so deleted files disappear) but keep Gradle's build outputs and caches.
  find /build -mindepth 1 -maxdepth 1 ! -name .gradle ! -name .kotlin ! -name build ! -name app -exec rm -rf {} +
  find /build/app -mindepth 1 -maxdepth 1 ! -name build -exec rm -rf {} +
  tar -C /work --exclude=./dist --exclude=./.gradle --exclude=./app/build --exclude=./build --exclude=./.kotlin -cf - . | tar -C /build -xf -
  cd /build
  chmod +x gradlew
  version="$(grep -oE 'versionName = "[^"]+"' app/build.gradle.kts | cut -d'"' -f2)"

  if [[ ! -f /keys/keystore.properties ]]; then
    echo "Missing release keystore. Run ./build.sh keystore first." >&2
    exit 2
  fi
  export FREESIA_KEYSTORE_PROPS=/keys/keystore.properties

  tasks=(testDebugUnitTest --rerun lintRelease assembleRelease)
  [[ "$mode" == "apk" ]] && tasks=(assembleRelease)
  [[ "$mode" == "test" ]] && tasks=(testDebugUnitTest --rerun)
  ./gradlew --no-daemon --stacktrace "${tasks[@]}"
  if [[ "$mode" == "test" ]]; then
    rm -rf /work/dist/reports/tests && mkdir -p /work/dist/reports && cp -r app/build/reports/tests /work/dist/reports/ 2>/dev/null || true
    exit 0
  fi

  apk="app/build/outputs/apk/release/app-release.apk"
  apksigner verify --print-certs "$apk" | head -3
  mkdir -p /work/dist
  cp "$apk" "/work/dist/Freesia-Android-${version}.apk"
  # Keep the reports next to the APK for inspection
  rm -rf /work/dist/reports && mkdir -p /work/dist/reports
  cp -r app/build/reports/lint-results-release.html /work/dist/reports/ 2>/dev/null || true
  cp -r app/build/reports/tests /work/dist/reports/ 2>/dev/null || true
  ls -la /work/dist
  sha256sum "/work/dist/Freesia-Android-${version}.apk"
  exit 0
fi

# ---------------------------------------------------------------- on the host
here="$(cd "$(dirname "$0")" && pwd)"
keys="${FREESIA_KEYS_DIR:-$HOME/.freesia-android}"
testdata="$here/../.tmp"
export MSYS_NO_PATHCONV=1   # Git Bash on Windows: keep /work style paths intact

winpath() { if command -v cygpath > /dev/null 2>&1; then cygpath -m "$1"; else echo "$1"; fi; }

docker build -q -t "$IMAGE" "$(winpath "$here/docker")" > /dev/null

mode="${1:-build}"
mounts=(-v "$(winpath "$here"):/work" -v "$GRADLE_VOLUME:/root/.gradle" -v "$WORK_VOLUME:/build")
envs=(-e FREESIA_IN_CONTAINER=1)
# FREESIA_SEND_SELFTEST_REPORT=1 ./build.sh test  posts one "android:selftest" error report
[[ -n "${FREESIA_SEND_SELFTEST_REPORT:-}" ]] && envs+=(-e FREESIA_SEND_SELFTEST_REPORT=1)

if [[ "$mode" == "keystore" ]]; then
  mkdir -p "$keys"
  docker run --rm -e FREESIA_IN_CONTAINER=1 -v "$(winpath "$here"):/work:ro" -v "$(winpath "$keys"):/keys" \
    "$IMAGE" bash /work/build.sh keystore
  exit 0
fi

# Temporary test account ({"server", "token"}) + sample audio, mounted read-only if present.
# They stay outside the repository and the image.
testmounts=(); testenvs=()
if [[ -f "$testdata/android-test.json" ]]; then
  testmounts+=(-v "$(winpath "$testdata/android-test.json"):/testdata/account.json:ro")
  testenvs+=(-e FREESIA_TEST_CONFIG=/testdata/account.json)
fi
if [[ -f "$testdata/localasr/audio/l1.wav" ]]; then
  testmounts+=(-v "$(winpath "$testdata/localasr/audio/l1.wav"):/testdata/l1.wav:ro")
  testenvs+=(-e FREESIA_TEST_AUDIO=/testdata/l1.wav)
fi

if [[ "$mode" == "smoke" ]]; then
  # Headless Android 16 emulator; needs /dev/kvm inside the Docker VM
  docker build -q -t freesia-android-emulator:2 -f "$(winpath "$here/docker/Dockerfile.emulator")" "$(winpath "$here/docker")" > /dev/null
  docker run --rm --name freesia-android-smoke --device /dev/kvm -v "$(winpath "$here"):/work" \
    "${testmounts[@]}" "${testenvs[@]}" freesia-android-emulator:2 bash /work/docker/smoke.sh
  exit $?
fi

mounts+=(-v "$(winpath "$keys"):/keys:ro")
if [[ "$mode" == "shell" ]]; then
  docker run --rm -it "${mounts[@]}" "${testmounts[@]}" "${envs[@]}" "${testenvs[@]}" "$IMAGE" bash
else
  docker run --rm "${mounts[@]}" "${testmounts[@]}" "${envs[@]}" "${testenvs[@]}" "$IMAGE" bash /work/build.sh "$mode"
fi
