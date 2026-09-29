package com.freesia.app.ui

import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.padding
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.SpanStyle
import com.freesia.app.ui.theme.Fonts
import com.freesia.app.core.Markdown
import com.freesia.app.BuildConfig
import com.freesia.app.Graph
import com.freesia.app.update.UpdateState
import com.freesia.app.ui.theme.LocalFreesia
import com.freesia.app.ui.theme.Type
import android.text.format.DateUtils
import android.widget.Toast
import androidx.compose.animation.animateContentSize
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.size
import androidx.compose.material3.Icon
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.LifecycleResumeEffect

/**
 * "Update available": release notes and an Update button. The APK is downloaded
 * and checked against its SHA-256 only after a tap, and Android's installer asks
 * for a final confirmation. Shows nothing when there is no update.
 */
@Composable
fun UpdateCard(modifier: Modifier = Modifier) {
    val t = LocalFreesia.current
    val ctx = LocalContext.current
    val st by Graph.updates.state.collectAsState()
    var canInstall by remember { mutableStateOf(Graph.updates.canInstall()) }
    var expanded by remember { mutableStateOf(false) }
    // Back from "Install unknown apps": pick up the new permission
    LifecycleResumeEffect(Unit) { canInstall = Graph.updates.canInstall(); onPauseOrDispose { } }
    val release = when (val s = st) {
        is UpdateState.Available -> s.release
        is UpdateState.Downloading -> s.release
        is UpdateState.Ready -> s.release
        is UpdateState.Failed -> s.release
        else -> null
    } ?: return
    FCard(modifier.fillMaxWidth().animateContentSize(), highlighted = true, padding = PaddingValues(16.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            Icon(FIcons.download, null, tint = t.ink, modifier = Modifier.size(22.dp))
            Column(Modifier.weight(1f)) {
                Text("Update available: Freesia ${release.version}", style = Type.label.copy(color = t.ink))
                Text("You have ${BuildConfig.VERSION_NAME}.", style = Type.bodySmall.copy(color = t.ink3))
            }
        }
        if (release.notes.isNotBlank()) {
            Spacer(Modifier.height(10.dp))
            ReleaseNotes(release.notes, expanded, onToggle = { expanded = !expanded })
        }
        Spacer(Modifier.height(12.dp))
        when (val s = st) {
            is UpdateState.Downloading -> {
                Text("Downloading… ${(s.progress * 100).toInt()}%", style = Type.bodySmall.copy(color = t.ink2))
                Spacer(Modifier.height(6.dp))
                LinearProgressIndicator(progress = { s.progress }, modifier = Modifier.fillMaxWidth(), color = t.bloom[1], trackColor = t.raise3)
            }
            is UpdateState.Ready -> {
                if (!canInstall) {
                    Text(
                        "Android asks you to allow Freesia to install updates once. Turn on \"Allow from this source\", then come back.",
                        style = Type.bodySmall.copy(color = t.ink2),
                    )
                    Spacer(Modifier.height(8.dp))
                    PrimaryButton("Allow installing updates", { ctx.startActivity(Graph.updates.installPermissionIntent()) }, Modifier.fillMaxWidth())
                } else {
                    Text("Downloaded and verified.", style = Type.bodySmall.copy(color = t.ink2))
                    Spacer(Modifier.height(8.dp))
                    PrimaryButton("Install", {
                        try { ctx.startActivity(Graph.updates.installIntent(s.file)) } catch (e: Exception) {
                            Toast.makeText(ctx, "Could not open the installer", Toast.LENGTH_SHORT).show()
                        }
                    }, Modifier.fillMaxWidth())
                }
            }
            is UpdateState.Failed -> {
                Text(s.message, style = Type.bodySmall.copy(color = t.bad))
                Spacer(Modifier.height(8.dp))
                PrimaryButton("Try again", { Graph.updates.download(release) }, Modifier.fillMaxWidth())
            }
            else -> PrimaryButton("Update", { Graph.updates.download(release) }, Modifier.fillMaxWidth())
        }
    }
}

/** Settings → About: version, last check, and "Check for updates". */
@Composable
fun UpdateSettingsRow() {
    val t = LocalFreesia.current
    val st by Graph.updates.state.collectAsState()
    val status = when (val s = st) {
        is UpdateState.Checking -> "Checking…"
        is UpdateState.Idle -> s.note ?: if (s.lastCheckedAt > 0) {
            "Last checked " + DateUtils.getRelativeTimeSpanString(s.lastCheckedAt, System.currentTimeMillis(), DateUtils.MINUTE_IN_MILLIS)
        } else "Updates come from the Freesia releases on GitHub."
        is UpdateState.Available, is UpdateState.Downloading, is UpdateState.Ready -> "A new version is ready (see above)."
        is UpdateState.Failed -> s.message
    }
    Row(verticalAlignment = Alignment.CenterVertically) {
        Column(Modifier.weight(1f)) {
            Text("Freesia ${BuildConfig.VERSION_NAME}", style = Type.body.copy(color = t.ink))
            Text(status, style = Type.bodySmall.copy(color = t.ink3))
        }
        GhostButton("Check for updates", { Graph.updates.check(userAsked = true) }, enabled = st !is UpdateState.Checking && st !is UpdateState.Downloading)
    }
}

/**
 * Release notes rendered from the release's Markdown (headings, lists, bold,
 * code), not shown as raw text. Collapsed, the first few blocks; tap for all.
 */
@Composable
fun ReleaseNotes(md: String, expanded: Boolean, onToggle: () -> Unit) {
    val t = LocalFreesia.current
    val blocks = remember(md) { Markdown.parse(md) }
    val shown = if (expanded) blocks else blocks.take(COLLAPSED_BLOCKS)
    fun spans(list: List<Markdown.Span>) = buildAnnotatedString {
        for (sp in list) {
            when (sp.kind) {
                Markdown.Kind.TEXT -> append(sp.text)
                Markdown.Kind.BOLD -> withStyle(SpanStyle(fontWeight = FontWeight.SemiBold, color = t.ink)) { append(sp.text) }
                Markdown.Kind.ITALIC -> withStyle(SpanStyle(fontStyle = FontStyle.Italic)) { append(sp.text) }
                Markdown.Kind.CODE -> withStyle(SpanStyle(fontFamily = Fonts.mono, background = t.raise2)) { append(sp.text) }
                Markdown.Kind.LINK -> withStyle(SpanStyle(textDecoration = TextDecoration.Underline)) { append(sp.text) }
            }
        }
    }
    Column(Modifier.fillMaxWidth().clickable(onClick = onToggle), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        shown.forEach { b ->
            when (b) {
                is Markdown.Heading -> Text(spans(b.spans), style = Type.label.copy(color = t.ink), modifier = Modifier.padding(top = 4.dp))
                is Markdown.Paragraph -> Text(spans(b.spans), style = Type.bodySmall.copy(color = t.ink2))
                is Markdown.ListBlock -> Column(verticalArrangement = Arrangement.spacedBy(3.dp)) {
                    b.items.forEachIndexed { i, item ->
                        Row {
                            Text(if (b.ordered) "${i + 1}." else "•", style = Type.bodySmall.copy(color = t.ink3), modifier = Modifier.width(16.dp))
                            Text(spans(item), style = Type.bodySmall.copy(color = t.ink2), modifier = Modifier.weight(1f))
                        }
                    }
                }
            }
        }
        if (blocks.size > COLLAPSED_BLOCKS) {
            Text(if (expanded) "Show less" else "Show all changes", style = Type.label.copy(color = t.ink3))
        }
    }
}

private const val COLLAPSED_BLOCKS = 3
