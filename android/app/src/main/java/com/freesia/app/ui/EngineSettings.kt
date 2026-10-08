package com.freesia.app.ui

import android.content.Intent
import android.net.Uri
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import com.freesia.app.Graph
import com.freesia.app.core.FreesiaApi
import com.freesia.app.core.GeminiModel
import com.freesia.app.ui.theme.LocalFreesia
import com.freesia.app.ui.theme.Type
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

@Composable
private fun EnginePicker() {
    val s by Graph.settings.flow.collectAsState()
    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        Chip("Freesia Cloud", s.engine == "cloud", { Graph.settings.update { it.copy(engine = "cloud") } })
        Chip("Gemini", s.engine == "gemini", { Graph.settings.update { it.copy(engine = "gemini") } })
    }
}

/** The same provider choice is available before the first cloud login. */
@Composable
fun EngineSetupScreen(onReady: () -> Unit) {
    val s by Graph.settings.flow.collectAsState()
    val hasKey by Graph.geminiKeys.signedIn.collectAsState()
    Column(Modifier.fillMaxSize().padding(horizontal = 20.dp)) {
        Spacer(Modifier.height(16.dp))
        Eyebrow("Step 1 · Speech engine")
        Spacer(Modifier.height(12.dp))
        EnginePicker()
        Spacer(Modifier.height(16.dp))
        if (s.engine == "cloud") {
            SignInScreen(Modifier.weight(1f), standalone = false, onSignedIn = onReady)
        } else {
            Column(Modifier.weight(1f).verticalScroll(rememberScrollState())) { GeminiConfiguration() }
            PrimaryButton("Continue", onReady, Modifier.fillMaxWidth().padding(vertical = 16.dp), enabled = hasKey)
        }
    }
}

@Composable
fun EngineSettingsCard() {
    val t = LocalFreesia.current
    val s by Graph.settings.flow.collectAsState()
    val signedIn by Graph.tokens.signedIn.collectAsState()
    val hasKey by Graph.geminiKeys.signedIn.collectAsState()
    var expanded by rememberSaveable { mutableStateOf(false) }
    var signIn by remember { mutableStateOf(false) }
    var serverDraft by rememberSaveable(s.server) { mutableStateOf(s.server) }
    var serverError by remember { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()
    Eyebrow("Speech engine")
    Spacer(Modifier.height(8.dp))
    FCard {
        SettingRow(if (s.engine == "gemini") "Google Gemini" else "Freesia Cloud",
            if (s.engine == "gemini") if (hasKey) "API key saved on this phone" else "Add your API key"
            else if (signedIn) "Signed in as ${s.username}" else "Sign in to your server",
            onClick = { expanded = !expanded }) {
            GhostButton(if (expanded) "Close" else "Configure", { expanded = !expanded })
        }
        if (expanded) {
            Hairline(); Spacer(Modifier.height(12.dp))
            EnginePicker()
            Spacer(Modifier.height(14.dp))
            if (s.engine == "gemini") {
                GeminiConfiguration()
            } else {
                FTextField(serverDraft, { serverDraft = it; serverError = null }, "Server", placeholder = FreesiaApi.SERVER_PLACEHOLDER)
                if (serverError != null) Text(serverError!!, style = Type.bodySmall.copy(color = t.bad))
                Spacer(Modifier.height(10.dp))
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    GhostButton("Save server", {
                        try {
                            val normal = FreesiaApi.normalizeServer(serverDraft)
                            if (normal != s.server) {
                                Graph.tokens.clear(); Contributions.clear()
                                Graph.settings.update { it.copy(server = normal) }
                            }
                            serverDraft = normal
                        } catch (e: Exception) { serverError = e.message }
                    }, enabled = serverDraft.trim() != s.server)
                    if (signedIn) GhostButton("Sign out", {
                        scope.launch {
                            withContext(Dispatchers.IO) { try { Graph.api.logout() } catch (_: Exception) { } }
                            Graph.tokens.clear(); Contributions.clear()
                        }
                    }) else GhostButton("Sign in", { signIn = true })
                }
            }
        }
    }
    if (signIn) Dialog(onDismissRequest = { signIn = false }, properties = DialogProperties(usePlatformDefaultWidth = false)) {
        com.freesia.app.ui.theme.FreesiaTheme(s.theme) {
            FCard(Modifier.fillMaxSize()) {
                GhostButton("Back", { signIn = false }, icon = FIcons.back)
                SignInScreen(Modifier.weight(1f), standalone = false) { signIn = false }
            }
        }
    }
}

@Composable
private fun GeminiConfiguration() {
    val t = LocalFreesia.current
    val ctx = LocalContext.current
    val scope = rememberCoroutineScope()
    val s by Graph.settings.flow.collectAsState()
    val hasKey by Graph.geminiKeys.signedIn.collectAsState()
    // API keys never enter saved instance state or the plain settings store.
    var draft by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var models by remember { mutableStateOf(emptyList<GeminiModel>()) }
    var menu by remember { mutableStateOf(false) }
    Text("Recordings and style formatting go directly to Google with your API key. Your Gemini usage follows Google's pricing and quota.", style = Type.bodySmall.copy(color = t.ink3))
    Spacer(Modifier.height(12.dp))
    FTextField(draft, { draft = it; error = null }, if (hasKey) "Replace API key" else "API key",
        placeholder = if (hasKey) "A key is already saved" else "Paste your Google AI Studio key",
        visualTransformation = PasswordVisualTransformation(), keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password))
    if (error != null) Text(error!!, style = Type.bodySmall.copy(color = t.bad))
    Spacer(Modifier.height(8.dp))
    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        GhostButton(if (busy) "Checking…" else "Save and test", {
            busy = true; error = null
            val value = draft.trim()
            scope.launch {
                try {
                    models = withContext(Dispatchers.IO) { Graph.gemini.listModels(value) }
                    Graph.geminiKeys.set(value)
                    draft = ""
                    Graph.settings.update { it.copy(geminiModel = "auto") }
                } catch (e: Exception) {
                    error = e.message ?: "Could not validate the Gemini key."
                } finally { busy = false }
            }
        }, enabled = !busy && draft.isNotBlank())
        if (hasKey) GhostButton("Remove key", { Graph.geminiKeys.clear(); draft = ""; models = emptyList() }, enabled = !busy)
    }
    GhostButton("Get an API key", { ctx.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse("https://aistudio.google.com/apikey"))) })
    if (hasKey) {
        Spacer(Modifier.height(8.dp)); Hairline()
        Box {
            SettingRow("Model", if (s.geminiModel == "auto") "Automatic · available Flash models" else s.geminiModel,
                onClick = {
                    menu = true
                    if (models.isEmpty()) scope.launch {
                        try { models = withContext(Dispatchers.IO) { Graph.gemini.listModels() } }
                        catch (e: Exception) { error = e.message }
                    }
                }) { Text("Change", style = Type.label.copy(color = t.ink2)) }
            DropdownMenu(expanded = menu, onDismissRequest = { menu = false }, modifier = Modifier.heightIn(max = 320.dp)) {
                DropdownMenuItem(text = { Text("Automatic") }, onClick = { Graph.settings.update { it.copy(geminiModel = "auto") }; menu = false })
                models.forEach { choice ->
                    DropdownMenuItem(text = { Text(choice.name) }, onClick = {
                        Graph.settings.update { it.copy(geminiModel = choice.id) }; menu = false
                    })
                }
            }
        }
    }
}
