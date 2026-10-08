package com.freesia.app.ui

import androidx.compose.foundation.layout.wrapContentWidth
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.BoxWithConstraints
import com.freesia.app.Graph
import com.freesia.app.core.ApiException
import com.freesia.app.core.MeInfo
import com.freesia.app.core.Styles
import com.freesia.app.dictation.Origin
import com.freesia.app.dictation.Phase
import com.freesia.app.service.FreesiaAccessibilityService
import com.freesia.app.ui.orb.BloomOrb
import com.freesia.app.ui.orb.OrbMode
import com.freesia.app.ui.theme.LocalFreesia
import com.freesia.app.ui.theme.Type
import android.content.ClipData
import android.content.ClipboardManager
import android.widget.Toast
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.input.TextFieldValue
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.LifecycleResumeEffect
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.text.NumberFormat

private fun Phase.orb() = when (this) {
    Phase.IDLE -> OrbMode.IDLE
    Phase.RECORDING -> OrbMode.LISTENING
    Phase.PROCESSING -> OrbMode.PROCESSING
    Phase.DONE -> OrbMode.DONE
    Phase.SAVED -> OrbMode.SAVED
    Phase.ERROR -> OrbMode.ERROR
}

@Composable
fun HomeScreen(onOpenStyles: () -> Unit, onOpenSettings: () -> Unit, onOpenSaved: () -> Unit) {
    val t = LocalFreesia.current
    val ctx = LocalContext.current
    val st by Graph.dictation.state.collectAsState()
    val level by Graph.dictation.level.collectAsState()
    val s by Graph.settings.flow.collectAsState()
    val stats by Graph.settings.stats.collectAsState()
    val bubbleOn by FreesiaAccessibilityService.running.collectAsState()
    val recordings by Graph.recordings.items.collectAsState()
    val waiting = recordings.count { it.needsRetry }
    val mine = st.origin == Origin.APP
    val phase = if (mine) st.phase else Phase.IDLE
    val style = Styles.byId(s.styleId)

    val permLauncher = rememberLauncherForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) {
        if (hasMicPermission(ctx)) Graph.dictation.start(Scratch.target)
    }
    fun toggle() {
        when (Graph.dictation.state.value.phase) {
            Phase.RECORDING -> Graph.dictation.stop()
            Phase.PROCESSING -> Unit
            else -> when {
                !Graph.engineConfigured() -> onOpenSettings()
                hasMicPermission(ctx) -> Graph.dictation.start(Scratch.target)
                else -> permLauncher.launch(runtimePermissions())
            }
        }
    }

    // Engine status: a light /api/me ping
    var me by remember { mutableStateOf<MeInfo?>(null) }
    var latency by remember { mutableStateOf<Long?>(null) }
    var engineError by remember { mutableStateOf<String?>(null) }
    var refresh by remember { mutableIntStateOf(0) }
    LifecycleResumeEffect(Unit) { refresh++; onPauseOrDispose { } }
    val hasKey by Graph.geminiKeys.signedIn.collectAsState()
    val signedIn by Graph.tokens.signedIn.collectAsState()
    LaunchedEffect(refresh, s.engine, s.server, signedIn, hasKey) {
        me = null; latency = null; engineError = null
        if (s.engine == "gemini") return@LaunchedEffect
        if (!signedIn) { engineError = "Sign in from Settings"; return@LaunchedEffect }
        val t0 = System.currentTimeMillis()
        try {
            me = withContext(Dispatchers.IO) { Graph.api.me() }
            latency = System.currentTimeMillis() - t0
            engineError = null
        } catch (e: ApiException) {
            engineError = e.message
        }
    }

    // Phones: one column. Tablets: the orb on the left, the pad and status on the
    // right; the orb is sized by the screen height so it never outgrows the view.
    BoxWithConstraints(Modifier.fillMaxSize().statusBarsPadding()) {
        val wide = maxWidth >= 840.dp
        val orbSize = Modifier.widthIn(max = if (wide) minOf(maxHeight * 0.62f, 520.dp) else minOf(maxHeight * 0.55f, 460.dp))
        val headerPart: @Composable ColumnScope.() -> Unit = {
            Spacer(Modifier.height(18.dp))
            Row(verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    Eyebrow("Freesia")
                    Heading("Speak, *softly*.", style = Type.title)
                }
                Chip("${style.icon}  ${style.name}", selected = false, onClick = onOpenStyles)
            }

        }
        val bannersPart: @Composable ColumnScope.() -> Unit = {
            // A new version of Freesia (downloads only when tapped)
            UpdateCard(Modifier.padding(top = 14.dp))

            // Saved recordings waiting for a retry
            if (waiting > 0) {
                Spacer(Modifier.height(14.dp))
                FCard(Modifier.fillMaxWidth().clickable(onClick = onOpenSaved), highlighted = true, padding = androidx.compose.foundation.layout.PaddingValues(16.dp)) {
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                        androidx.compose.material3.Icon(FIcons.wave, null, tint = t.ink, modifier = Modifier.size(22.dp))
                        Column(Modifier.weight(1f)) {
                            Text(
                                if (waiting == 1) "1 saved recording is waiting" else "$waiting saved recordings are waiting",
                                style = Type.label.copy(color = t.ink),
                            )
                            Text("They could not be transcribed. The audio is safe on this phone. Tap to retry.", style = Type.bodySmall.copy(color = t.ink3))
                        }
                        androidx.compose.material3.Icon(FIcons.arrow, null, tint = t.ink3, modifier = Modifier.size(18.dp))
                    }
                }
            }

        }
        val orbPart: @Composable ColumnScope.() -> Unit = {
            // The orb
            Box(
                Modifier.fillMaxWidth().then(orbSize).aspectRatio(1f).align(Alignment.CenterHorizontally)
                    .semantics { contentDescription = if (phase == Phase.RECORDING) "Stop dictation" else "Start dictation" }
                    .clickable(interactionSource = remember { MutableInteractionSource() }, indication = null) { toggle() },
                contentAlignment = Alignment.Center,
            ) {
                BloomOrb(phase.orb(), if (phase == Phase.RECORDING) level else 0f, t.bloom, Modifier.fillMaxSize())
            }
            AnimatedContent(
                targetState = when {
                    mine && phase == Phase.ERROR -> st.message ?: "Something went wrong."
                    mine && phase == Phase.SAVED -> st.message ?: "Saved. Retry it from History."
                    phase == Phase.RECORDING -> "Listening… tap to finish"
                    phase == Phase.PROCESSING -> st.message ?: "Transcribing…"
                    phase == Phase.DONE -> "Done"
                    else -> "Tap the bloom to dictate here"
                },
                transitionSpec = { fadeIn().togetherWith(fadeOut()) },
                modifier = Modifier.fillMaxWidth(),
                label = "status",
            ) { msg ->
                Text(msg, style = Type.body.copy(color = if (phase == Phase.ERROR) t.bad else t.ink2), modifier = Modifier.fillMaxWidth(),
                    textAlign = androidx.compose.ui.text.style.TextAlign.Center)
            }
        }
        val scratchPart: @Composable ColumnScope.() -> Unit = {
            // Scratch box
            FCard(padding = androidx.compose.foundation.layout.PaddingValues(start = 16.dp, end = 6.dp, top = 12.dp, bottom = 6.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Eyebrow("Scratch pad", Modifier.weight(1f))
                    IconAction(FIcons.copy, "Copy", {
                        val text = Scratch.value.text
                        if (text.isNotBlank()) {
                            ctx.getSystemService(ClipboardManager::class.java)?.setPrimaryClip(ClipData.newPlainText("Freesia", text))
                            Toast.makeText(ctx, "Copied", Toast.LENGTH_SHORT).show()
                        }
                    })
                    IconAction(FIcons.close, "Clear", { Scratch.value = TextFieldValue("") })
                }
                BasicTextField(
                    value = Scratch.value, onValueChange = { Scratch.value = it },
                    textStyle = Type.body.copy(color = t.ink),
                    cursorBrush = SolidColor(t.bloom[1]),
                    modifier = Modifier.fillMaxWidth().heightIn(min = 96.dp).padding(end = 10.dp, bottom = 10.dp, top = 4.dp),
                    decorationBox = { inner ->
                        if (Scratch.value.text.isEmpty()) Text("Your words land here. Edit, then copy.", style = Type.body.copy(color = t.ink4))
                        inner()
                    },
                )
            }
        }
        val statsPart: @Composable ColumnScope.() -> Unit = {
            // Stats + status
            Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                FCard(Modifier.weight(1f)) {
                    Eyebrow("Today")
                    Spacer(Modifier.height(6.dp))
                    MonoNumber(NumberFormat.getIntegerInstance().format(stats.wordsToday))
                    Text("words dictated", style = Type.bodySmall.copy(color = t.ink3))
                }
                FCard(Modifier.weight(1f)) {
                    Eyebrow("All time")
                    Spacer(Modifier.height(6.dp))
                    MonoNumber(NumberFormat.getIntegerInstance().format(stats.wordsTotal))
                    Text("${stats.dictations} dictations", style = Type.bodySmall.copy(color = t.ink3))
                }
            }
            Spacer(Modifier.height(12.dp))
            FCard {
                Eyebrow("Engine")
                Spacer(Modifier.height(8.dp))
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    StatusDot(if (s.engine == "gemini") hasKey else engineError == null && me != null)
                    Text(
                        when {
                            s.engine == "gemini" -> if (hasKey) "Google Gemini · key saved" else "Gemini · add an API key"
                            engineError != null -> engineError!!
                            me != null -> "Freesia Cloud · connected"
                            else -> "Checking…"
                        },
                        style = Type.body.copy(color = t.ink), modifier = Modifier.weight(1f),
                    )
                    latency?.takeIf { engineError == null }?.let { Text("$it ms", style = Type.eyebrow.copy(color = t.ink3)) }
                }
                Text(
                    if (s.engine == "gemini") (if (s.geminiModel == "auto") "Automatic model selection" else s.geminiModel)
                    else listOfNotNull(s.username.ifBlank { me?.username ?: "" }.ifBlank { null }, s.server.removePrefix("https://").ifBlank { null }, me?.asrModel)
                        .joinToString(" · "),
                    style = Type.bodySmall.copy(color = t.ink3),
                )
                if (!Graph.engineConfigured()) GhostButton("Set up engine", onOpenSettings)
                Spacer(Modifier.height(10.dp))
                Hairline()
                Spacer(Modifier.height(10.dp))
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    StatusDot(bubbleOn)
                    Text(if (bubbleOn) "Bubble is on in other apps" else "Bubble is off", style = Type.body.copy(color = t.ink), modifier = Modifier.weight(1f))
                    if (!bubbleOn) GhostButton("Turn on", { openAccessibilitySettings(ctx) })
                }
            }
        }
        if (wide) {
            Row(Modifier.fillMaxSize().padding(horizontal = 32.dp), horizontalArrangement = Arrangement.spacedBy(32.dp)) {
                Column(Modifier.weight(1f).fillMaxHeight().verticalScroll(rememberScrollState())) {
                    headerPart()
                    bannersPart()
                    Spacer(Modifier.height(12.dp))
                    orbPart()
                    Spacer(Modifier.height(28.dp))
                }
                Column(Modifier.weight(1f).fillMaxHeight().verticalScroll(rememberScrollState())) {
                    Spacer(Modifier.height(24.dp))
                    scratchPart()
                    Spacer(Modifier.height(14.dp))
                    statsPart()
                    Spacer(Modifier.height(28.dp))
                }
            }
        } else {
            Column(
                Modifier.fillMaxSize().verticalScroll(rememberScrollState())
                    .wrapContentWidth(Alignment.CenterHorizontally).widthIn(max = 640.dp).padding(horizontal = 20.dp),
            ) {
                headerPart()
                bannersPart()
                orbPart()
                Spacer(Modifier.height(18.dp))
                scratchPart()
                Spacer(Modifier.height(14.dp))
                statsPart()
                Spacer(Modifier.height(28.dp))
            }
        }
    }
}
