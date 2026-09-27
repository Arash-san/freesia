"""Speaks a WAV file into the running emulator's microphone through the emulator
controller's gRPC injectAudio call. Used by smoke.sh (run with /opt/grpc/bin/python).

usage: inject_audio.py sample.wav [trailing_silence_s] [leading_silence_s]

Start it only while an app is recording: the emulator pulls queued packets as the
app reads the microphone. Keep the trailing silence shorter than the app's
stop-on-silence, so the stream drains completely; a stream that is never drained
ends in a deadline, and that has crashed the emulator.
"""
import glob
import sys
import time
import wave

sys.path.insert(0, "/opt/emu-grpc")
import os  # noqa: E402
import grpc  # noqa: E402
import emulator_controller_pb2 as pb  # noqa: E402
import emulator_controller_pb2_grpc as pbg  # noqa: E402


def discovery():
    """Port and token from the emulator's discovery file (the gRPC endpoint needs the token)."""
    for path in glob.glob("/root/.android/avd/running/pid_*.ini"):
        conf = dict(line.strip().split("=", 1) for line in open(path) if "=" in line)
        if "grpc.port" in conf:
            return conf["grpc.port"], conf.get("grpc.token", "")
    raise SystemExit("no running emulator with a gRPC endpoint")


# Queued (default): the emulator pulls packets as the app reads the mic, so the
# stream may be opened before the take starts. INJECT_REALTIME=1 paces them instead.
REAL_TIME = os.environ.get("INJECT_REALTIME") == "1"


def packets(path, silence_s, lead_s=0.0):
    w = wave.open(path)
    assert w.getsampwidth() == 2, "16-bit PCM expected"
    rate, channels = w.getframerate(), w.getnchannels()
    fmt = pb.AudioFormat(
        samplingRate=rate,
        channels=pb.AudioFormat.Mono if channels == 1 else pb.AudioFormat.Stereo,
        format=pb.AudioFormat.AUD_FMT_S16,
        mode=pb.AudioFormat.MODE_REAL_TIME if REAL_TIME else pb.AudioFormat.MODE_UNSPECIFIED,
    )
    frames = rate // 10  # 100 ms per packet, well under the ~300 ms buffer
    data = (b"\0" * (int(rate * lead_s) * 2 * channels) + w.readframes(w.getnframes())
            + b"\0" * (int(rate * silence_s) * 2 * channels))
    step = frames * 2 * channels
    # Real-time delivery, paced here: one 100 ms packet every 100 ms, so the microphone
    # gets the speech at its natural speed and the call lasts as long as the clip.
    start = time.monotonic()
    for n, i in enumerate(range(0, len(data), step)):
        wait = start + n * 0.1 - time.monotonic()
        if REAL_TIME and wait > 0:
            time.sleep(wait)
        yield pb.AudioPacket(format=fmt, timestamp=int(time.time() * 1e6), audio=data[i:i + step])


if __name__ == "__main__":
    wav = sys.argv[1]
    silence = float(sys.argv[2]) if len(sys.argv) > 2 else 1.0
    lead = float(sys.argv[3]) if len(sys.argv) > 3 else 0.0
    port, token = discovery()
    channel = grpc.insecure_channel(f"127.0.0.1:{port}")
    stub = pbg.EmulatorControllerStub(channel)
    meta = [("authorization", f"Bearer {token}")] if token else []
    w = wave.open(wav)
    seconds = w.getnframes() / w.getframerate() + silence + lead
    stub.injectAudio(packets(wav, silence, lead), metadata=meta, timeout=seconds + 15)
