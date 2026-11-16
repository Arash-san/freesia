# Freesia Rust desktop beta

Version 4.0.0 beta 2 adds a saved software rendering option for Windows graphics driver hangs. It affects the interface; local speech recognition keeps its own GPU setting.

Selection capture waits for delayed clipboard text instead of accepting a temporary empty read.

The Windows app now runs on Rust and the system WebView2 runtime. It keeps the Freesia interface, animations, speech engines, vocabulary, styles, history, recordings and keyboard controls.

Hidden animations stop when you close the window to the tray. The idle interface can suspend, and the recording overlay closes after its exit animation. Microphone readiness stays available between recordings.

The app keeps your existing settings and encrypted credentials. It also saves a copy of your original settings during migration. Quit the previous Freesia from its tray icon before opening this version. See RUST_DESKTOP.md for installation, measured resource use and rollback instructions.

This is a beta build for evaluation.
