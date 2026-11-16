"""Render the matched desktop measurements. No profiles or credentials are copied."""
import json
from pathlib import Path
from statistics import mean
import shutil
import sys
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np

root = Path(__file__).resolve().parents[1]
out = Path(sys.argv[1]) if len(sys.argv) > 1 else root.parent / "artifacts" / "freesia-rust-20261116"
out.mkdir(parents=True, exist_ok=True)
source = root / ".tmp/rust-benchmark-final/results.json"
raw = json.loads(source.read_text(encoding="utf-8"))
assert len(raw["data"]) == 4 and all(r["resumed"] for r in raw["data"])
phases = [("visible", "Visible"), ("tray", "Tray"), ("recording", "Recording"),
          ("micReady", "Mic ready"), ("processing", "Processing"), ("cooledTray", "Mic closed")]
metrics = ["meanWorkingMiB", "meanPrivateMiB", "meanCpuPercent"]
summary = {}
for app in ["electron", "rust"]:
    trials = [r for r in raw["data"] if r["kind"] == app]
    assert len(trials) == 2
    summary[app] = {p: {m: mean(r["phases"][p][m] for r in trials) for m in metrics} for p, _ in phases}

plt.rcParams.update({"font.family": "DejaVu Sans", "font.size": 10, "axes.spines.top": False,
                     "axes.spines.right": False, "axes.edgecolor": "#D2D5DC", "text.color": "#222735",
                     "axes.labelcolor": "#333A49", "xtick.color": "#485064", "ytick.color": "#485064"})
fig, axes = plt.subplots(1, 2, figsize=(13, 4.7), layout="constrained")
x = np.arange(len(phases))
for ax, metric, title, ylabel in [(axes[0], "meanWorkingMiB", "Complete process tree memory", "Summed working set (MiB)"),
                                 (axes[1], "meanCpuPercent", "Complete process tree CPU", "CPU (% of 48 logical processors)")]:
    for app, color, offset, label in [("electron", "#8390A2", -.19, "Electron"), ("rust", "#7058CE", .19, "Rust / WebView2")]:
        values = [summary[app][p][metric] for p, _ in phases]
        trials = [r for r in raw["data"] if r["kind"] == app]
        lo = [v - min(r["phases"][p][metric] for r in trials) for (p, _), v in zip(phases, values)]
        hi = [max(r["phases"][p][metric] for r in trials) - v for (p, _), v in zip(phases, values)]
        bars = ax.bar(x + offset, values, .35, label=label, color=color,
                      yerr=np.array([lo, hi]), capsize=3, error_kw={"elinewidth": 1, "ecolor": "#3F4755"})
        labels = [f"{v:.0f}" if metric.endswith("MiB") else (f"{v:.3f}" if v < .1 else f"{v:.2f}") for v in values]
        ax.bar_label(bars, labels=labels, padding=4, fontsize=8, rotation=0)
    ax.set_title(title, loc="left", fontsize=13, fontweight="bold", pad=14)
    ax.set_ylabel(ylabel)
    ax.set_xticks(x, [label for _, label in phases], rotation=24, ha="right")
    ax.set_axisbelow(True)
    ax.grid(axis="y", color="#E9EBEF", linewidth=.8)
    ax.set_ylim(0, 1100 if metric.endswith("MiB") else 1.65)
    ax.legend(loc="upper right", frameon=False, fontsize=9)
axes[0].axhline(100, color="#C47735", linestyle=(0, (4, 4)), linewidth=1)
axes[0].text(5.5, 105, "100 MiB target", ha="right", va="bottom", color="#9C5B24", fontsize=8)
fig.savefig(out / "resource-comparison.png", dpi=160, facecolor="white")
fig.savefig(out / "resource-comparison.svg", facecolor="white")
plt.close(fig)

lines = []
for p, label in phases:
    old, new = summary["electron"][p], summary["rust"][p]
    lines.append(f"| {label} | {old['meanWorkingMiB']:.1f} | {new['meanWorkingMiB']:.1f} | {old['meanPrivateMiB']:.1f} | {new['meanPrivateMiB']:.1f} | {old['meanCpuPercent']:.3f}% | {new['meanCpuPercent']:.3f}% |")
idle = summary["rust"]["tray"]
prior = summary["electron"]["tray"]
memory_drop = 100 * (1 - idle["meanWorkingMiB"] / prior["meanWorkingMiB"])
cpu_drop = 100 * (1 - idle["meanCpuPercent"] / prior["meanCpuPercent"])
visible_delta = 100 * (summary["rust"]["visible"]["meanCpuPercent"] / summary["electron"]["visible"]["meanCpuPercent"] - 1)
text = f"""# Freesia Rust desktop evaluation

The Rust beta keeps the existing interface and animations and all 78 preload APIs. In two matched trials per app, mean memory in the tray fell from {prior['meanWorkingMiB']:.1f} to {idle['meanWorkingMiB']:.1f} MiB ({memory_drop:.1f} percent). Mean CPU in the tray fell from {prior['meanCpuPercent']:.3f} to {idle['meanCpuPercent']:.3f} percent ({cpu_drop:.1f} percent).

The 100 MiB target remains unmet. The visible animated window averaged {visible_delta:.1f} percent more CPU in this sample. The visible CPU ranges overlap, and two runs do not establish a reliable general result for that state. Memory fell in every measured state.

![Resource comparison](resource-comparison.png)

## Measurements

| State | Electron working MiB | Rust working MiB | Electron private MiB | Rust private MiB | Electron CPU | Rust CPU |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
{chr(10).join(lines)}

Working set is the sum for the entire process tree. Shared pages can appear in more than one process. Private memory is committed private bytes. CPU is normalized by all 48 logical processors. The chart whiskers show the range of the two run means. They are not confidence intervals.

## Workload and limits

The baseline is desktop source 3.1.1 at `7a97aaa`, executed with Electron 33.4.11. The candidate is the optimized Rust 4.0.0 beta with Tauri 2.12.5 and system WebView2. Both used equivalent isolated Cloud profiles, dark theme, sounds off, microphone readiness on, the same viewport and audio fixtures, and a localhost backend with a fixed recognition delay of one second and a formatting delay of half a second. The machine is a Windows 11 workstation with an AMD Ryzen Threadripper PRO 7965WX and 48 logical processors.

Each run measured a settled visible window for 20 seconds, idle in the tray for 20 seconds, hidden recording for 20 seconds, microphone readiness for 15 seconds, processing for 10 seconds and the tray after closing the microphone for 15 seconds. Both apps were run twice, in alternating order. Saved outputs were checked in the measured profile. Every Rust and Electron descendant was included, including WebView2, audio helpers and the Electron keyboard helper.

Recording used the built in test control. Overlay states and live levels were checked separately. These measurements describe desktop cost with a controlled backend. They do not measure faster server inference or general recognition accuracy. Active local model weights require more memory. The laptop still needs its own measurements, and actual keyboard injection needs an unlocked interactive desktop.

The earlier exploratory build used more CPU with the visible window and continued browser work after hiding. The delivered runtime explicitly updates controller visibility, pauses hidden animations and suspends the idle main view. Recording and processing wake the browser controller. Microphone readiness prevents suspension. Native resume followed by a fresh hidden recording passed a dedicated integration check. The implementation follows the [WebView2 suspension API](https://learn.microsoft.com/en-us/microsoft-edge/webview2/reference/win32/icorewebview2_3).

## Verification

| Check | Result |
| --- | --- |
| Existing JavaScript suite | 71 passed |
| Rust unit suite | 9 passed; one interactive clipboard test is excluded from automatic runs |
| Real WebView2 integration | 14 groups passed, including all 78 bridge entries, audio upload, formatting, translation, old server fallback, styles, recordings, live hidden recording, cancellation, history, deep idle and native resume |
| Credentials | Three saved credential types were decrypted and rewritten by Rust; Electron read them back unchanged |
| Local model | Existing pinned Qwen model ran on an RTX 5090, matched one reference clip with zero word errors and stopped cleanly; this is a small functional test |
| Native scan code paste and selected text | Implemented; verification remains pending because Windows did not provide a usable foreground window |
| Installer | Windows NSIS beta builds successfully |

The clipboard round trip passed earlier in the session. A later run could not open the clipboard, so it now requires an explicit interactive test invocation. No user clipboard content was changed by that failed attempt. Source compatibility also covers the complete F1 through F24 shortcut range and the diagnostic consent defaults of older profiles.

## Use and rollback

Quit the existing Freesia through its tray icon before opening the Rust version. Install `Freesia-Rust-Setup-4.0.0-beta.1.exe`, or use `freesia-desktop.exe` on a machine with WebView2 installed. Settings, credentials, history, styles, recordings and local models use the existing Freesia data directory. The first migration saves `config.before-rust.json`. WebView2 has its own browser data subdirectory and keeps the original credential key intact.

To return to Electron, quit Rust and open the previous installation. See `RUST_DESKTOP.md` for build commands and further migration details. The Rust update channel requires signed manifests; its GitHub Actions signing secret has been configured. This delivery does not publish a public release or replace the running Electron installation.
"""
(out / "REPORT.md").write_text(text, encoding="utf-8")
shutil.copyfile(source, out / "benchmark-results.json")
(out / "benchmark-summary.json").write_text(json.dumps(summary, indent=2), encoding="utf-8")
def bars(old, new, maximum, unit, precision=1):
    return ''.join(f'<div class="row"><span>{name}</span><div class="track"><i class="{kind}" style="width:{value/maximum*100:.3f}%"></i></div><b>{value:.{precision}f}{unit}</b></div>'
                   for name,kind,value in [("Electron","old",old),("Rust","new",new)])
private_old=summary['electron']['tray']['meanPrivateMiB']
private_new=summary['rust']['tray']['meanPrivateMiB']
html = f"""<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>
*{{box-sizing:border-box}}body{{margin:0;background:#fff;color:#262c3b;font:14px system-ui,sans-serif}}main{{max-width:1050px;margin:auto;padding:24px}}h1{{font-size:21px;margin:0 0 7px}}p{{color:#616a79;line-height:1.5;margin:6px 0}}.grid{{display:grid;grid-template-columns:1fr 1fr;gap:22px;margin-top:22px}}section{{border:1px solid #e4e6ed;border-radius:12px;padding:20px}}h2{{font-size:15px;margin:0 0 17px}}h3{{font-size:12px;font-weight:600;margin:19px 0 11px;color:#616a79}}.row{{display:grid;grid-template-columns:58px 1fr 89px;gap:10px;align-items:center;margin:12px 0;font-size:12px}}.row b{{text-align:right;white-space:nowrap}}.track{{background:#f1f2f6;height:18px;border-radius:3px;overflow:hidden}}i{{display:block;height:100%;min-width:2px}}.old{{background:#8390a2}}.new{{background:#7058ce}}.note{{font-size:12px;margin-top:17px}}.goal{{color:#9c5b24}}footer{{font-size:12px;margin-top:17px;color:#616a79;line-height:1.6}}@media(max-width:650px){{.grid{{grid-template-columns:1fr}}main{{padding:16px}}}}
</style></head><body><main><h1>Freesia: measured desktop resource use</h1><p>Two matched trials per app, with the complete process tree.</p><div class="grid"><section><h2>Memory while idle in the tray</h2>{bars(prior['meanWorkingMiB'],idle['meanWorkingMiB'],900,' MiB')}<p class="note">Working set fell {memory_drop:.0f}%. Private committed memory: {private_old:.0f} to {private_new:.0f} MiB.</p><p class="note goal">The 100 MiB target remains unmet.</p></section><section><h2>CPU use</h2><h3>Idle in the tray</h3>{bars(prior['meanCpuPercent'],idle['meanCpuPercent'],1,'%',3)}<h3>Visible animated window</h3>{bars(summary['electron']['visible']['meanCpuPercent'],summary['rust']['visible']['meanCpuPercent'],1,'%',3)}<p class="note">Visible animation CPU averaged {visible_delta:.1f}% higher in this small sample.</p></section></div><footer>CPU percentages use all 48 logical processors on this workstation. These trials use a controlled Cloud backend. Laptop performance and interactive keyboard paste still need verification.</footer></main></body></html>"""
(out / "comparison.html").write_text(html, encoding="utf-8")
print(json.dumps({"trayMemoryMiB":idle['meanWorkingMiB'],"trayCpuPercent":idle['meanCpuPercent'],"memoryReductionPercent":memory_drop,"idleCpuReductionPercent":cpu_drop,"visibleCpuChangePercent":visible_delta}, indent=2))
