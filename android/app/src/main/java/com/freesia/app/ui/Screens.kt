package com.freesia.app.ui

import com.freesia.app.BuildConfig
import com.freesia.app.Graph
import com.freesia.app.core.FreesiaApi
import com.freesia.app.core.LanguageOption
import com.freesia.app.core.PromptBuilder
import com.freesia.app.core.Styles
import com.freesia.app.data.HistoryItem
import com.freesia.app.data.RecordingStore
import com.freesia.app.data.SavedRecording
import com.freesia.app.service.FreesiaAccessibilityService
import com.freesia.app.ui.theme.LocalFreesia
import com.freesia.app.ui.theme.Type
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.text.format.DateUtils
import android.widget.Toast
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.animation.animateContentSize
import androidx.compose.animation.core.spring
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.core.content.FileProvider
import androidx.lifecycle.compose.LifecycleResumeEffect
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlin.math.roundToInt

@Composable
private fun ScreenHeader(eyebrow: String, title: String, trailing: @Composable () -> Unit = {}) {
    Row(Modifier.fillMaxWidth().padding(top = 18.dp, bottom = 14.dp), verticalAlignment = Alignment.Bottom) {
        Column(Modifier.weight(1f)) {
            Eyebrow(eyebrow)
            Heading(title)
        }
        trailing()
    }
}

// ------------------------------------------------------------------ History

@Composable
fun HistoryScreen() {
    val t = LocalFreesia.current
    val ctx = LocalContext.current
    val scope = rememberCoroutineScope()
    val items by Graph.history.items.collectAsState()
    val recordings by Graph.recordings.items.collectAsState()
    val retrying by Graph.dictation.retrying.collectAsState()
    var query by rememberSaveable { mutableStateOf("") }
    var confirmClear by remember { mutableStateOf(false) }
    var fixItem by remember { mutableStateOf<HistoryItem?>(null) }
    var confirmDelete by remember { mutableStateOf<SavedRecording?>(null) }
    var exporting by remember { mutableStateOf<SavedRecording?>(null) }
    val filtered = remember(items, query) {
        if (query.isBlank()) items else items.filter { it.text.contains(query, true) || it.raw.contains(query, true) }
    }
    fun export(uri: android.net.Uri?) {
        val rec = exporting ?: return
        exporting = null
        if (uri == null) return
        scope.launch {
            val ok = withContext(Dispatchers.IO) {
                try {
                    ctx.contentResolver.openOutputStream(uri)?.use { out -> Graph.recordings.file(rec).inputStream().use { it.copyTo(out) } } != null
                } catch (e: Exception) { false }
            }
            Toast.makeText(ctx, if (ok) "Recording saved" else "Could not save the recording", Toast.LENGTH_SHORT).show()
        }
    }
    val exportM4a = rememberLauncherForActivityResult(ActivityResultContracts.CreateDocument("audio/mp4")) { export(it) }
    val exportWav = rememberLauncherForActivityResult(ActivityResultContracts.CreateDocument("audio/wav")) { export(it) }

    Column(Modifier.fillMaxSize().statusBarsPadding().padding(horizontal = 20.dp)) {
        ScreenHeader("Local only · last ${items.size} of 200", "Your *history*.") {
            if (items.isNotEmpty()) IconAction(FIcons.trash, "Clear history", { confirmClear = true })
        }
        FTextField(query, { query = it }, "Search", placeholder = "Find a phrase…")
        Spacer(Modifier.height(12.dp))
        LazyColumn(verticalArrangement = Arrangement.spacedBy(10.dp), contentPadding = PaddingValues(bottom = 24.dp)) {
            if (recordings.isNotEmpty()) {
                item(key = "saved-header") {
                    Column {
                        Eyebrow("Saved recordings · ${recordings.size}")
                        Spacer(Modifier.height(4.dp))
                        Text(
                            "Audio kept on this phone because it was not transcribed yet (or because Keep recordings is on). " +
                                "Retry uses your current style and copies the text to the clipboard.",
                            style = Type.bodySmall.copy(color = t.ink3),
                        )
                    }
                }
                items(recordings, key = { "rec-" + it.id }) { rec ->
                    SavedRecordingCard(
                        rec, busy = rec.id in retrying,
                        onRetry = { Graph.dictation.retry(rec.id) },
                        onShare = { shareRecording(ctx, rec) },
                        onExport = {
                            exporting = rec
                            val name = "Freesia recording " +
                                java.text.SimpleDateFormat("yyyy-MM-dd HH.mm.ss", java.util.Locale.US).format(java.util.Date(rec.createdAt)) +
                                "." + RecordingStore.extensionFor(rec.mime)
                            if (rec.mime.contains("wav")) exportWav.launch(name) else exportM4a.launch(name)
                        },
                        onDelete = { confirmDelete = rec },
                    )
                }
                item(key = "history-header") { Spacer(Modifier.height(6.dp)); Eyebrow("Dictations") }
            }
            if (filtered.isEmpty()) {
                item(key = "empty") {
                    Text(
                        if (items.isEmpty()) "Nothing yet. Every dictation is kept here, on this phone only." else "No matches.",
                        style = Type.body.copy(color = t.ink3), modifier = Modifier.padding(top = 12.dp),
                    )
                }
            }
            items(filtered, key = { it.id }) { item ->
                HistoryCard(item, onCopy = {
                    ctx.getSystemService(ClipboardManager::class.java)?.setPrimaryClip(ClipData.newPlainText("Freesia", item.text))
                    Toast.makeText(ctx, "Copied", Toast.LENGTH_SHORT).show()
                }, onFix = { fixItem = item }, onDelete = { Graph.history.delete(item.id) })
            }
        }
    }
    if (confirmClear) {
        AlertDialog(
            onDismissRequest = { confirmClear = false },
            title = { Text("Clear history?", style = Type.heading) },
            text = { Text("This removes all ${items.size} dictations from this phone. Saved recordings are kept.", style = Type.body) },
            confirmButton = { TextButton({ Graph.history.clear(); confirmClear = false }) { Text("Clear", color = t.bad) } },
            dismissButton = { TextButton({ confirmClear = false }) { Text("Cancel", color = t.ink2) } },
            containerColor = t.sheet,
        )
    }
    confirmDelete?.let { rec ->
        AlertDialog(
            onDismissRequest = { confirmDelete = null },
            title = { Text("Delete this recording?", style = Type.heading) },
            text = {
                Text(
                    if (rec.needsRetry) "It was never transcribed, so its words will be gone for good." else "The audio file is removed from this phone.",
                    style = Type.body,
                )
            },
            confirmButton = { TextButton({ Graph.dictation.deleteRecording(rec.id); confirmDelete = null }) { Text("Delete", color = t.bad) } },
            dismissButton = { TextButton({ confirmDelete = null }) { Text("Cancel", color = t.ink2) } },
            containerColor = t.sheet,
        )
    }
    fixItem?.let { item -> TeachDialog(historyId = item.id, onDismiss = { fixItem = null }) }
}

private fun shareRecording(ctx: Context, rec: SavedRecording) {
    try {
        val uri = FileProvider.getUriForFile(ctx, ctx.packageName + ".files", Graph.recordings.file(rec))
        val send = Intent(Intent.ACTION_SEND)
            .setType(rec.mime)
            .putExtra(Intent.EXTRA_STREAM, uri)
            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        ctx.startActivity(Intent.createChooser(send, "Share recording"))
    } catch (e: Exception) {
        Toast.makeText(ctx, "Could not share the recording", Toast.LENGTH_SHORT).show()
    }
}

/** 0:05, 1:12 */
private fun clock(seconds: Double): String {
    val s = seconds.roundToInt().coerceAtLeast(0)
    return "%d:%02d".format(s / 60, s % 60)
}

@Composable
private fun SavedRecordingCard(
    rec: SavedRecording,
    busy: Boolean,
    onRetry: () -> Unit,
    onShare: () -> Unit,
    onExport: () -> Unit,
    onDelete: () -> Unit,
) {
    val t = LocalFreesia.current
    val ctx = LocalContext.current
    val inFlight = busy || rec.status == RecordingStore.PENDING
    FCard(
        Modifier.fillMaxWidth().animateContentSize(spring(dampingRatio = 0.8f, stiffness = 500f)),
        highlighted = rec.needsRetry,
        padding = PaddingValues(start = 16.dp, top = 14.dp, end = 6.dp, bottom = 8.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.padding(end = 10.dp)) {
            Icon(FIcons.wave, null, tint = t.ink2, modifier = Modifier.size(18.dp))
            Spacer(Modifier.width(8.dp))
            Text(
                (if (rec.durationSec > 0) "${clock(rec.durationSec)} recording" else "Recording") +
                    " · ${rec.formatLabel}, ${android.text.format.Formatter.formatShortFileSize(ctx, Graph.recordings.sizeBytes(rec))}",
                style = Type.label.copy(color = t.ink), modifier = Modifier.weight(1f), maxLines = 1, overflow = TextOverflow.Ellipsis,
            )
            Text(
                DateUtils.formatDateTime(
                    ctx, rec.createdAt,
                    DateUtils.FORMAT_SHOW_TIME or DateUtils.FORMAT_SHOW_DATE or DateUtils.FORMAT_ABBREV_MONTH,
                ),
                style = Type.eyebrow.copy(color = t.ink3),
            )
        }
        Spacer(Modifier.height(6.dp))
        Text(
            when {
                inFlight -> "Transcribing…"
                rec.status == RecordingStore.DONE -> "Transcribed: “${rec.transcript.orEmpty()}”"
                else -> rec.error ?: "Transcription failed."
            },
            style = Type.bodySmall.copy(color = if (rec.needsRetry && !inFlight) t.bad else t.ink3),
            maxLines = 3, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(end = 10.dp),
        )
        Spacer(Modifier.height(8.dp))
        Row(verticalAlignment = Alignment.CenterVertically) {
            GhostButton(if (inFlight) "Working…" else "Retry", onRetry, icon = FIcons.retry, enabled = !inFlight)
            Spacer(Modifier.weight(1f))
            IconAction(FIcons.share, "Share recording", onShare)
            IconAction(FIcons.download, "Save recording to a file", onExport)
            IconAction(FIcons.trash, "Delete recording", { if (!inFlight) onDelete() })
        }
    }
}

@Composable
private fun HistoryCard(item: HistoryItem, onCopy: () -> Unit, onFix: () -> Unit, onDelete: () -> Unit) {
    val t = LocalFreesia.current
    val ctx = LocalContext.current
    var expanded by remember { mutableStateOf(false) }
    val style = Styles.byId(item.styleId)
    FCard(Modifier.fillMaxWidth().animateContentSize(spring(dampingRatio = 0.8f, stiffness = 500f)), padding = PaddingValues(start = 16.dp, top = 14.dp, end = 6.dp, bottom = 6.dp)) {
        Text(
            item.text, style = Type.body.copy(color = t.ink), maxLines = if (expanded) Int.MAX_VALUE else 4,
            overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(end = 10.dp).clickable { expanded = !expanded },
        )
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(
                listOfNotNull(
                    DateUtils.getRelativeTimeSpanString(item.timestamp, System.currentTimeMillis(), DateUtils.MINUTE_IN_MILLIS).toString(),
                    "${style.icon} ${style.name}",
                    if (item.delivery == "recovered") "Recovered" else item.app?.let { appLabel(ctx, it) },
                ).joinToString("  ·  "),
                style = Type.eyebrow.copy(color = t.ink3), modifier = Modifier.weight(1f), maxLines = 1, overflow = TextOverflow.Ellipsis,
            )
            IconAction(FIcons.copy, "Copy", onCopy)
            IconAction(FIcons.edit, "Fix a word", onFix)
            IconAction(FIcons.trash, "Delete", onDelete)
        }
    }
}

/**
 * "Teach a correction" (desktop parity): what Freesia wrote and what was said.
 * Saved corrections apply to every future dictation, the right term joins the
 * dictionary, and the History item it was opened from is fixed too.
 */
@Composable
fun TeachDialog(onDismiss: () -> Unit, historyId: String? = null) {
    val t = LocalFreesia.current
    val ctx = LocalContext.current
    var from by rememberSaveable { mutableStateOf("") }
    var to by rememberSaveable { mutableStateOf("") }
    var error by remember { mutableStateOf<String?>(null) }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(if (historyId != null) "Fix a word" else "Teach a correction", style = Type.heading) },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                Text(
                    "Freesia will fix this automatically from now on, and the right term becomes a hint for the speech model.",
                    style = Type.bodySmall.copy(color = t.ink2),
                )
                FTextField(from.take(80), { from = it.take(80); error = null }, "Freesia wrote", placeholder = "cloud opus")
                FTextField(to.take(80), { to = it.take(80); error = null }, "I actually said", placeholder = "Claude Opus")
                error?.let { Text(it, style = Type.bodySmall.copy(color = t.bad)) }
            }
        },
        confirmButton = {
            TextButton({
                if (Graph.teachCorrection(from, to, historyId)) {
                    Toast.makeText(ctx, "Learned: “${from.trim()}” → “${to.trim()}”", Toast.LENGTH_SHORT).show()
                    onDismiss()
                } else {
                    error = "Fill in both, and make them different."
                }
            }) { Text("Save correction", color = t.ink) }
        },
        dismissButton = { TextButton(onDismiss) { Text("Cancel", color = t.ink2) } },
        containerColor = t.sheet,
    )
}

// ------------------------------------------------------------------ Styles

@OptIn(ExperimentalLayoutApi::class)
@Composable
fun StylesScreen() {
    val t = LocalFreesia.current
    val s by Graph.settings.flow.collectAsState()
    Column(Modifier.fillMaxSize().statusBarsPadding().verticalScroll(rememberScrollState()).padding(horizontal = 20.dp)) {
        ScreenHeader("Formatting", "Pick a *style*.")
        Text("Your words are cleaned up on your Freesia server in this style before they are typed. Verbatim skips formatting.", style = Type.bodySmall.copy(color = t.ink3))
        Spacer(Modifier.height(14.dp))
        Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Styles.builtIn.forEach { style ->
                val selected = style.id == s.styleId
                FCard(
                    Modifier.fillMaxWidth().clickable { Graph.settings.update { it.copy(styleId = style.id) } },
                    highlighted = selected,
                    padding = PaddingValues(16.dp),
                ) {
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(14.dp)) {
                        Text(style.icon, style = Type.heading)
                        Column(Modifier.weight(1f)) {
                            Text(style.name, style = Type.label.copy(color = t.ink))
                            Text(style.description, style = Type.bodySmall.copy(color = t.ink3))
                        }
                        if (selected) Icon(FIcons.check, "Selected", tint = t.ink, modifier = Modifier.size(20.dp))
                    }
                    if (selected && style.id == "native") {
                        Spacer(Modifier.height(12.dp))
                        Eyebrow("I speak")
                        Spacer(Modifier.height(8.dp))
                        FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                            Styles.nativeLanguages.forEach { lang ->
                                Chip(lang.name, lang.code == s.nativeLanguage, { Graph.settings.update { it.copy(nativeLanguage = lang.code) } })
                            }
                        }
                    }
                }
            }
        }
        Spacer(Modifier.height(24.dp))
    }
}

// ------------------------------------------------------------------ Vocabulary

@OptIn(ExperimentalLayoutApi::class)
@Composable
fun VocabularyScreen() {
    val t = LocalFreesia.current
    val s by Graph.settings.flow.collectAsState()
    var input by rememberSaveable { mutableStateOf("") }
    var teach by remember { mutableStateOf(false) }
    val used = PromptBuilder.vocabularyPrompt(s.dictionary)?.length ?: 0
    fun add() {
        val words = input.split(',', '\n').map { it.trim() }.filter { it.isNotEmpty() }
        if (words.isNotEmpty()) Graph.settings.update { cur -> cur.copy(dictionary = (cur.dictionary + words).distinct()) }
        input = ""
    }
    Column(Modifier.fillMaxSize().statusBarsPadding().verticalScroll(rememberScrollState()).padding(horizontal = 20.dp)) {
        ScreenHeader("Custom words", "Your *vocabulary*.")
        Text(
            "Names, places and jargon. They are sent to the recognizer as spelling hints, the formatter keeps them exactly as written, " +
                "and Freesia fixes split or spelled-out versions (\"Py Torch\", \"P Y T O R C H\") on its own.",
            style = Type.bodySmall.copy(color = t.ink3),
        )
        Spacer(Modifier.height(14.dp))
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Box(Modifier.weight(1f)) {
                FTextField(
                    input, { input = it }, "Add a word", placeholder = "e.g. Arash, Qwen, PyTorch",
                    keyboardOptions = KeyboardOptions(imeAction = ImeAction.Done),
                    keyboardActions = KeyboardActions(onDone = { add() }),
                )
            }
            IconAction(FIcons.plus, "Add", { add() })
        }
        Spacer(Modifier.height(6.dp))
        Text("$used / ${PromptBuilder.MAX_VOCAB_PROMPT} characters used for recognizer hints", style = Type.eyebrow.copy(color = t.ink3))
        Spacer(Modifier.height(14.dp))
        if (s.dictionary.isEmpty()) Text("No words yet.", style = Type.body.copy(color = t.ink3))
        FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            s.dictionary.forEach { w ->
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Chip("$w  ×", false, { Graph.settings.update { cur -> cur.copy(dictionary = cur.dictionary - w) } })
                }
            }
        }

        Spacer(Modifier.height(28.dp))
        Row(verticalAlignment = Alignment.CenterVertically) {
            Eyebrow("Corrections", Modifier.weight(1f))
            GhostButton("Teach one", { teach = true }, icon = FIcons.plus)
        }
        Spacer(Modifier.height(8.dp))
        Text(
            "When Freesia keeps writing something wrong, teach it the fix. Corrections run on every dictation, before and after formatting.",
            style = Type.bodySmall.copy(color = t.ink3),
        )
        Spacer(Modifier.height(10.dp))
        if (s.corrections.isEmpty()) {
            Text("None yet. Use “Fix a word” on any History item, or Teach one.", style = Type.body.copy(color = t.ink3))
        } else {
            FCard(Modifier.fillMaxWidth(), padding = PaddingValues(start = 16.dp, end = 6.dp, top = 4.dp, bottom = 4.dp)) {
                s.corrections.forEachIndexed { i, c ->
                    if (i > 0) Hairline()
                    Row(Modifier.fillMaxWidth().padding(vertical = 2.dp), verticalAlignment = Alignment.CenterVertically) {
                        Text(c.from, style = Type.body.copy(color = t.ink3), modifier = Modifier.weight(1f), maxLines = 2, overflow = TextOverflow.Ellipsis)
                        Text("  →  ", style = Type.body.copy(color = t.ink4))
                        Text(c.to, style = Type.label.copy(color = t.ink), modifier = Modifier.weight(1f), maxLines = 2, overflow = TextOverflow.Ellipsis)
                        IconAction(FIcons.close, "Forget ${c.from}", {
                            Graph.settings.update { cur -> cur.copy(corrections = cur.corrections.filterNot { it.from == c.from }) }
                        })
                    }
                }
            }
        }
        Spacer(Modifier.height(24.dp))
    }
    if (teach) TeachDialog(onDismiss = { teach = false })
}

// ------------------------------------------------------------------ Settings

@OptIn(ExperimentalLayoutApi::class)
@Composable
fun SettingsScreen() {
    val t = LocalFreesia.current
    val ctx = LocalContext.current
    val scope = rememberCoroutineScope()
    val s by Graph.settings.flow.collectAsState()
    val bubbleRunning by FreesiaAccessibilityService.running.collectAsState()
    var a11y by remember { mutableStateOf(isAccessibilityEnabled(ctx)) }
    var mic by remember { mutableStateOf(hasMicPermission(ctx)) }
    LifecycleResumeEffect(bubbleRunning) { a11y = isAccessibilityEnabled(ctx); mic = hasMicPermission(ctx); onPauseOrDispose { } }
    var serverDraft by rememberSaveable { mutableStateOf(s.server) }
    var serverError by remember { mutableStateOf<String?>(null) }
    var pickLanguage by remember { mutableStateOf(false) }

    Column(Modifier.fillMaxSize().statusBarsPadding().verticalScroll(rememberScrollState()).padding(horizontal = 20.dp)) {
        ScreenHeader("Freesia ${BuildConfig.VERSION_NAME}", "Settings")

        Eyebrow("Account"); Spacer(Modifier.height(8.dp))
        FCard {
            SettingRow("Signed in as ${s.username.ifBlank { "…" }}", "Freesia Cloud · " + s.server.removePrefix("https://"))
            Hairline()
            Spacer(Modifier.height(10.dp))
            FTextField(serverDraft, { serverDraft = it; serverError = null }, "Server", placeholder = FreesiaApi.SERVER_PLACEHOLDER)
            if (serverError != null) Text(serverError!!, style = Type.bodySmall.copy(color = t.bad))
            Spacer(Modifier.height(10.dp))
            Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                GhostButton("Save server", {
                    try {
                        val norm = FreesiaApi.normalizeServer(serverDraft)
                        if (norm != s.server) {
                            // A token belongs to one server: changing it signs out.
                            Graph.tokens.clear()
                            Graph.settings.update { it.copy(server = norm) }
                        }
                        serverDraft = norm
                    } catch (e: Exception) { serverError = e.message }
                }, enabled = serverDraft.trim() != s.server)
                GhostButton("Sign out", {
                    scope.launch {
                        withContext(Dispatchers.IO) { try { Graph.api.logout() } catch (e: Exception) { } }
                        Graph.tokens.clear()
                    }
                })
            }
        }

        Spacer(Modifier.height(20.dp)); Eyebrow("Bubble"); Spacer(Modifier.height(8.dp))
        FCard {
            SettingRow(
                "Accessibility service", if (a11y) "On · the bloom appears on text fields" else "Off · tap to open Accessibility settings",
                onClick = { openAccessibilitySettings(ctx) },
            ) { StatusDot(a11y) }
            SettingRow("Microphone", if (mic) "Allowed" else "Not allowed · tap to open App info", onClick = { openAppInfo(ctx) }) { StatusDot(mic) }
            Hairline()
            SettingRow("Size", "${s.bubbleSizeDp} dp")
            FSlider(s.bubbleSizeDp.toFloat(), { v -> Graph.settings.update { it.copy(bubbleSizeDp = v.roundToInt()) } }, 44f..64f, steps = 4)
            SettingRow("Opacity when idle", "${(s.bubbleOpacity * 100).roundToInt()}%")
            FSlider(s.bubbleOpacity, { v -> Graph.settings.update { it.copy(bubbleOpacity = v) } }, 0.4f..1f)
            SettingRow("Haptics", "A soft tick on tap, a pulse when text lands") { FSwitch(s.haptics) { v -> Graph.settings.update { it.copy(haptics = v) } } }
            Hairline()
            SettingRow("Hidden in apps", if (s.hiddenApps.isEmpty()) "None. Long-press the bubble to hide it in an app." else "Tap an app to show the bubble there again")
            s.hiddenApps.sorted().forEach { pkg ->
                SettingRow(appLabel(ctx, pkg), pkg, onClick = { Graph.settings.update { it.copy(hiddenApps = it.hiddenApps - pkg) } }) {
                    Icon(FIcons.close, "Unhide", tint = t.ink3, modifier = Modifier.size(18.dp))
                }
            }
        }

        Spacer(Modifier.height(20.dp)); Eyebrow("Dictation"); Spacer(Modifier.height(8.dp))
        FCard {
            SettingRow("Stop on silence", if (s.autoStop) "After ${"%.1f".format(s.autoStopSeconds)} s of quiet" else "Off · tap the bloom to finish") {
                FSwitch(s.autoStop) { v -> Graph.settings.update { it.copy(autoStop = v) } }
            }
            if (s.autoStop) FSlider(s.autoStopSeconds, { v -> Graph.settings.update { it.copy(autoStopSeconds = (v * 2).roundToInt() / 2f) } }, 1.5f..6f, steps = 8)
            Hairline()
            SettingRow(
                "Keep recordings",
                if (s.keepRecordings) "Audio stays in History → Saved recordings after it is transcribed"
                else "Audio is deleted once its text is delivered. Failed recordings are always kept for a retry.",
            ) { FSwitch(s.keepRecordings) { v -> Graph.settings.update { it.copy(keepRecordings = v) } } }
            Hairline()
            val lang = Styles.dictationLanguages.firstOrNull { it.code == s.language } ?: Styles.dictationLanguages.first()
            SettingRow("Language", "${lang.name} · the Native Language style uses its own setting", onClick = { pickLanguage = !pickLanguage })
            if (pickLanguage) {
                LanguagePicker(Styles.dictationLanguages, s.language) { code ->
                    Graph.settings.update { it.copy(language = code) }; pickLanguage = false
                }
            }
        }

        Spacer(Modifier.height(20.dp)); Eyebrow("Appearance"); Spacer(Modifier.height(8.dp))
        FCard {
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                listOf("system" to "System", "dark" to "Graphite", "light" to "Paper").forEach { (id, label) ->
                    Chip(label, s.theme == id, { Graph.settings.update { it.copy(theme = id) } })
                }
            }
        }

        Spacer(Modifier.height(20.dp)); Eyebrow("Privacy"); Spacer(Modifier.height(8.dp))
        FCard { ErrorReportsRow() }

        Spacer(Modifier.height(20.dp))
        DiagnosticsSection()

        Spacer(Modifier.height(20.dp)); Eyebrow("About"); Spacer(Modifier.height(8.dp))
        UpdateCard(Modifier.padding(bottom = 10.dp))
        FCard {
            UpdateSettingsRow()
            Spacer(Modifier.height(10.dp)); Hairline(); Spacer(Modifier.height(10.dp))
            Text(
                "Freesia ${BuildConfig.VERSION_NAME} for Android. Recordings go only to your Freesia Cloud server; history stays on this phone. " +
                    "Fonts: Geist and Geist Mono (Vercel), Instrument Serif (Instrument), all under the SIL Open Font License 1.1 (see assets/licenses).",
                style = Type.bodySmall.copy(color = t.ink3),
            )
        }
        Spacer(Modifier.height(28.dp))
    }
}

/** The error-report switch, with the desktop's wording. Shown in onboarding and Settings. */
@Composable
fun ErrorReportsRow() {
    val s by Graph.settings.flow.collectAsState()
    SettingRow("Send anonymous error reports", "Version, device and error text only. Never audio, transcripts or passwords.") {
        FSwitch(s.errorReporting) { v -> Graph.settings.update { it.copy(errorReporting = v) } }
    }
}

/** Settings → Diagnostics: the last 50 errors, kept on this phone, with Copy. */
@Composable
private fun DiagnosticsSection() {
    val t = LocalFreesia.current
    val ctx = LocalContext.current
    val entries by Graph.reporter.log.entries.collectAsState()
    Row(verticalAlignment = Alignment.CenterVertically) {
        Eyebrow("Diagnostics", Modifier.weight(1f))
        if (entries.isNotEmpty()) GhostButton("Copy", {
            val text = "Freesia ${BuildConfig.VERSION_NAME} · Android ${android.os.Build.VERSION.RELEASE}\n" +
                entries.joinToString("\n") { it.asText() }
            ctx.getSystemService(ClipboardManager::class.java)?.setPrimaryClip(ClipData.newPlainText("Freesia diagnostics", text))
            Toast.makeText(ctx, "Diagnostics copied", Toast.LENGTH_SHORT).show()
        }, icon = FIcons.copy)
    }
    Spacer(Modifier.height(8.dp))
    FCard(Modifier.fillMaxWidth()) {
        Text("The last ${entries.size.coerceAtLeast(0)} of up to 50 errors, kept on this phone.", style = Type.bodySmall.copy(color = t.ink3))
        if (entries.isEmpty()) {
            Spacer(Modifier.height(8.dp))
            Text("No errors recorded.", style = Type.body.copy(color = t.ink3))
        }
        entries.take(50).forEach { e ->
            Spacer(Modifier.height(8.dp))
            Hairline()
            Spacer(Modifier.height(8.dp))
            Text(
                DateUtils.formatDateTime(ctx, e.ts, DateUtils.FORMAT_SHOW_TIME or DateUtils.FORMAT_SHOW_DATE or DateUtils.FORMAT_ABBREV_MONTH) +
                    "  ·  ${e.level}  ·  ${e.context.removePrefix("android:")}",
                style = Type.eyebrow.copy(color = t.ink3),
            )
            Text(e.message, style = Type.bodySmall.copy(color = t.ink2), maxLines = 4, overflow = TextOverflow.Ellipsis)
        }
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun LanguagePicker(options: List<LanguageOption>, selected: String, onPick: (String) -> Unit) {
    FlowRow(Modifier.padding(bottom = 10.dp), horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        options.forEach { Chip(it.name, it.code == selected, { onPick(it.code) }) }
    }
}
