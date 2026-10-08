package com.freesia.app.ui

import com.freesia.app.Graph
import com.freesia.app.core.ApiException
import com.freesia.app.core.FreesiaApi
import com.freesia.app.service.FreesiaAccessibilityService
import com.freesia.app.ui.orb.BloomOrb
import com.freesia.app.ui.orb.OrbMode
import com.freesia.app.ui.theme.LocalFreesia
import com.freesia.app.ui.theme.Type
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.core.spring
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInHorizontally
import androidx.compose.animation.slideOutHorizontally
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Icon
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.LifecycleResumeEffect
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

private const val STEPS = 5

@Composable
fun Onboarding(onDone: () -> Unit) {
    var step by rememberSaveable { mutableIntStateOf(0) }
    val t = LocalFreesia.current
    Column(Modifier.fillMaxSize().safeDrawingPadding()) {
        // Progress: bloom segments
        Row(Modifier.fillMaxWidth().padding(horizontal = 24.dp, vertical = 14.dp), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            repeat(STEPS) { i ->
                Box(
                    Modifier.weight(1f).height(3.dp).clip(CircleShape)
                        .background(if (i <= step) bloomBrush(t.bloom) else androidx.compose.ui.graphics.Brush.linearGradient(listOf(t.raise3, t.raise3))),
                )
            }
        }
        AnimatedContent(
            targetState = step,
            transitionSpec = {
                val dir = if (targetState > initialState) 1 else -1
                (slideInHorizontally(spring(dampingRatio = 0.85f, stiffness = 380f)) { it / 5 * dir } + fadeIn())
                    .togetherWith(slideOutHorizontally(spring(stiffness = 600f)) { -it / 6 * dir } + fadeOut())
            },
            modifier = Modifier.weight(1f),
            label = "onboarding",
        ) { s ->
            when (s) {
                0 -> WelcomeStep { step = if (Graph.engineConfigured()) 2 else 1 }
                1 -> EngineSetupScreen { step = 2 }
                2 -> MicStep { step = 3 }
                3 -> AccessibilityStep(onNext = { step = 4 }, onSkip = { step = 4 })
                else -> TryItStep(onDone)
            }
        }
    }
}

@Composable
private fun StepScaffold(eyebrow: String, title: String, body: String, content: @Composable () -> Unit = {}, actions: @Composable () -> Unit) {
    val t = LocalFreesia.current
    Column(Modifier.fillMaxSize().imePadding().padding(horizontal = 24.dp)) {
        Column(Modifier.weight(1f).verticalScroll(rememberScrollState())) {
            Spacer(Modifier.height(24.dp))
            Eyebrow(eyebrow)
            Spacer(Modifier.height(10.dp))
            Heading(title, style = Type.display)
            Spacer(Modifier.height(14.dp))
            Text(body, style = Type.body.copy(color = t.ink2))
            Spacer(Modifier.height(22.dp))
            content()
        }
        Column(Modifier.fillMaxWidth().padding(vertical = 18.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) { actions() }
    }
}

@Composable
private fun WelcomeStep(onNext: () -> Unit) {
    val t = LocalFreesia.current
    Column(Modifier.fillMaxSize().padding(horizontal = 24.dp), horizontalAlignment = Alignment.CenterHorizontally) {
        Box(Modifier.weight(1f).fillMaxWidth(), contentAlignment = Alignment.Center) {
            BloomOrb(OrbMode.IDLE, 0f, t.bloom, Modifier.size(320.dp))
        }
        Eyebrow("Freesia for Android")
        Spacer(Modifier.height(10.dp))
        Heading("Your voice, *in bloom*.", style = Type.display)
        Spacer(Modifier.height(12.dp))
        Text(
            "Tap into any text field, tap the bloom, and speak. Freesia types it for you, cleaned up in the style you choose.",
            style = Type.body.copy(color = t.ink2),
        )
        Spacer(Modifier.height(28.dp))
        PrimaryButton("Get started", onNext, Modifier.fillMaxWidth())
        Spacer(Modifier.height(10.dp))
        ErrorReportsRow()
        Spacer(Modifier.height(12.dp))
    }
}

@Composable
fun SignInScreen(modifier: Modifier = Modifier, standalone: Boolean, onSignedIn: () -> Unit) {
    val t = LocalFreesia.current
    val scope = rememberCoroutineScope()
    val settings by Graph.settings.flow.collectAsState()
    // No built-in server: the field starts empty (or with the server used last time)
    var server by rememberSaveable { mutableStateOf(settings.server) }
    var user by rememberSaveable { mutableStateOf(settings.username) }
    var pass by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }

    fun submit() {
        if (busy) return
        error = null
        busy = true
        scope.launch {
            try {
                val normalized = FreesiaApi.normalizeServer(server)
                val res = withContext(Dispatchers.IO) { Graph.api.login(normalized, user.trim(), pass, Graph.deviceName) }
                Graph.settings.update { it.copy(server = normalized, username = res.username) }
                Graph.tokens.set(res.token)
                pass = ""
                onSignedIn()
            } catch (e: ApiException) {
                error = when {
                    e.httpStatus == 429 -> e.message ?: "Too many attempts. Wait a few minutes and try again."
                    e.httpStatus == 401 || e.httpStatus == 403 -> e.message ?: "That username and password did not match."
                    else -> e.message
                }
            } catch (e: Exception) {
                error = "Sign-in failed. Check the server address."
            } finally {
                busy = false
            }
        }
    }

    Box(modifier.then(if (standalone) Modifier.safeDrawingPadding() else Modifier)) {
        StepScaffold(
            eyebrow = if (standalone) "Signed out" else "Step 1 · Account",
            title = if (standalone) "Welcome *back*." else "Sign *in*.",
            body = "Freesia sends your recordings to your Freesia Cloud server to transcribe. Enter its address and the account you were given.",
            content = {
                Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                    FTextField(
                        server, { server = it; error = null }, "Server", placeholder = FreesiaApi.SERVER_PLACEHOLDER,
                        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri),
                    )
                    FTextField(user, { user = it }, "Username", keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Ascii))
                    FTextField(
                        pass, { pass = it }, "Password",
                        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password),
                        visualTransformation = PasswordVisualTransformation(),
                    )
                    if (error != null) Text(error!!, style = Type.bodySmall.copy(color = t.bad))
                }
            },
        ) {
            PrimaryButton("Sign in", ::submit, Modifier.fillMaxWidth(), enabled = server.isNotBlank() && user.isNotBlank() && pass.isNotEmpty(), loading = busy)
        }
    }
}

@Composable
private fun MicStep(onNext: () -> Unit) {
    val ctx = LocalContext.current
    val t = LocalFreesia.current
    var granted by remember { mutableStateOf(hasMicPermission(ctx)) }
    var asked by remember { mutableStateOf(false) }
    val launcher = rememberLauncherForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) {
        granted = hasMicPermission(ctx); asked = true
    }
    LifecycleResumeEffect(Unit) { granted = hasMicPermission(ctx); onPauseOrDispose { } }
    LaunchedEffect(granted) { if (granted) { kotlinx.coroutines.delay(450); onNext() } }
    StepScaffold(
        "Step 2 · Microphone", "Let it *listen*.",
        "Freesia records only while the bloom is active: from your tap until you tap again (or pause for a moment). " +
            "Android shows its green microphone indicator the whole time. Notifications let you stop a take from the shade.",
        content = {
            if (asked && !granted) {
                Text("Microphone access was denied. You can allow it in App info → Permissions.", style = Type.bodySmall.copy(color = t.bad))
                Spacer(Modifier.height(10.dp))
                GhostButton("Open app info", { openAppInfo(ctx) })
            }
        },
    ) {
        PrimaryButton(if (granted) "Microphone allowed" else "Allow microphone", { launcher.launch(runtimePermissions()) }, Modifier.fillMaxWidth(), enabled = !granted)
    }
}

@Composable
private fun AccessibilityStep(onNext: () -> Unit, onSkip: () -> Unit) {
    val ctx = LocalContext.current
    val t = LocalFreesia.current
    val running by FreesiaAccessibilityService.running.collectAsState()
    var enabled by remember { mutableStateOf(isAccessibilityEnabled(ctx)) }
    var agreed by rememberSaveable { mutableStateOf(false) }
    LifecycleResumeEffect(running) { enabled = isAccessibilityEnabled(ctx); onPauseOrDispose { } }
    LaunchedEffect(enabled, running) { if (enabled || running) { kotlinx.coroutines.delay(500); onNext() } }
    StepScaffold(
        "Step 3 · The bubble", "Dictate *anywhere*.",
        "To float the bloom over other apps and type into them, Freesia uses an Android accessibility service. Please read what that means before turning it on.",
        content = {
            FCard {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    Icon(FIcons.shield, null, tint = t.ink2, modifier = Modifier.size(20.dp))
                    Text("Accessibility disclosure", style = Type.label.copy(color = t.ink))
                }
                Spacer(Modifier.height(10.dp))
                Disclosure("What it accesses", "Which text field is focused on screen, and, only at the moment a dictation finishes, the text and cursor position of that one field so the transcript can be inserted at the cursor.")
                Disclosure("What it never does", "It does not read or record what you type, never appears on or reads password fields, does not look at other screen content, and does not perform any action except inserting your dictation.")
                Disclosure("Where data goes", "Your voice recording goes to your selected engine: your Freesia Cloud server or Google Gemini. Field contents never leave the device. History and recordings awaiting a retry stay on this phone.")
                Disclosure("Your control", "Turn it off any time in Settings → Accessibility, or hide the bubble for specific apps.")
            }
            Spacer(Modifier.height(16.dp))
            Text("In Accessibility settings: open Installed apps (Samsung: Installed apps) → Freesia dictation bubble → turn it on.", style = Type.bodySmall.copy(color = t.ink3))
            Spacer(Modifier.height(10.dp))
            Text(
                "If Android says \"Restricted setting\" (common for apps installed from a file): open App info → ⋮ menu → Allow restricted settings, confirm, then come back and turn Freesia on.",
                style = Type.bodySmall.copy(color = t.ink3),
            )
            Spacer(Modifier.height(10.dp))
            GhostButton("Open App info", { openAppInfo(ctx) })
        },
    ) {
        if (!agreed) {
            PrimaryButton("I agree, open Accessibility settings", { agreed = true; openAccessibilitySettings(ctx) }, Modifier.fillMaxWidth())
        } else {
            PrimaryButton(if (enabled) "Enabled" else "Open Accessibility settings", { openAccessibilitySettings(ctx) }, Modifier.fillMaxWidth(), enabled = !enabled)
        }
        GhostButton("Not now", onSkip, Modifier.fillMaxWidth())
    }
}

@Composable
private fun Disclosure(title: String, body: String) {
    val t = LocalFreesia.current
    Column(Modifier.padding(vertical = 6.dp)) {
        Text(title, style = Type.label.copy(color = t.ink))
        Text(body, style = Type.bodySmall.copy(color = t.ink2))
    }
}

@Composable
private fun TryItStep(onDone: () -> Unit) {
    val t = LocalFreesia.current
    val ctx = LocalContext.current
    var text by rememberSaveable { mutableStateOf("") }
    val running by FreesiaAccessibilityService.running.collectAsState()
    StepScaffold(
        "Step 4 · Try it", "Now, *speak*.",
        if (running) "Tap the field below. When the bloom appears at the edge of the screen, tap it, say a sentence, and tap it again."
        else "The bubble is off, so try the orb on the Home screen instead. You can turn the bubble on later in Settings.",
        content = {
            OutlinedTextField(
                value = text, onValueChange = { text = it }, modifier = Modifier.fillMaxWidth().height(160.dp),
                placeholder = { Text("Tap here, then tap the bloom…", style = Type.body.copy(color = t.ink4)) },
                textStyle = Type.body.copy(color = t.ink),
                colors = OutlinedTextFieldDefaults.colors(
                    focusedBorderColor = t.bloom[1], unfocusedBorderColor = t.line2, cursorColor = t.bloom[1],
                    focusedContainerColor = t.raise, unfocusedContainerColor = t.raise,
                ),
            )
            Spacer(Modifier.height(12.dp))
            Text("Long-press the bloom to switch styles. Drag it to move it; it snaps to the nearest edge.", style = Type.bodySmall.copy(color = t.ink3))
            if (!hasMicPermission(ctx)) {
                Spacer(Modifier.height(8.dp))
                Text("Microphone permission is still off; dictation will ask for it.", style = Type.bodySmall.copy(color = t.bad))
            }
        },
    ) {
        PrimaryButton("Finish", onDone, Modifier.fillMaxWidth())
        Spacer(Modifier.width(0.dp))
    }
}
