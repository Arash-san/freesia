package com.freesia.app.ui

import com.freesia.app.Graph
import com.freesia.app.core.ContribState
import com.freesia.app.ui.theme.LocalFreesia
import com.freesia.app.ui.theme.Type
import android.widget.Toast
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.spring
import androidx.compose.animation.fadeIn
import androidx.compose.animation.slideInVertically
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlin.math.roundToInt

/**
 * Voice contributions: people signed in to a Freesia Voice server that supports
 * them (InquireLab's) can share their recordings to train its speech model. Off
 * by default. The server keeps the choice and the terms, so each account is asked
 * once per version of the terms, on whichever device opens first after the update.
 */
object Contributions {
    private val _state = MutableStateFlow<ContribState?>(null)
    val state = _state.asStateFlow()
    /** Asked at most once per app run, even if the dialog is closed without an answer. */
    var askedThisRun = false

    suspend fun refresh(): ContribState? = withContext(Dispatchers.IO) {
        try { Graph.api.contribution().also { _state.value = it } } catch (e: Exception) { null }
    }

    suspend fun set(enabled: Boolean): Result<ContribState> = withContext(Dispatchers.IO) {
        val version = _state.value?.version ?: 0
        runCatching { Graph.api.setContribution(enabled, version) }.onSuccess { _state.value = it }
    }

    suspend fun delete(): Result<ContribState> = withContext(Dispatchers.IO) {
        runCatching { Graph.api.deleteContributions() }.onSuccess { _state.value = it }
    }

    fun clear() { _state.value = null; askedThisRun = false }
}

/** Shown once after the update (or after signing in) to accounts that have not answered yet. */
@Composable
fun ContributionPrompt() {
    val signedIn by Graph.tokens.signedIn.collectAsState()
    var show by remember { mutableStateOf<ContribState?>(null) }
    LaunchedEffect(signedIn) {
        if (!signedIn) { Contributions.clear(); return@LaunchedEffect }
        kotlinx.coroutines.delay(1_200)
        val st = Contributions.refresh() ?: return@LaunchedEffect
        if (st.available && !st.decided && !Contributions.askedThisRun) {
            Contributions.askedThisRun = true
            show = st
        }
    }
    show?.let { ContributionDialog(it, firstTime = true) { show = null } }
}

/** The full terms. Its "Share my recordings" button is the only way to turn sharing on. */
@Composable
fun ContributionDialog(state: ContribState, firstTime: Boolean, onDone: () -> Unit) {
    val t = LocalFreesia.current
    val ctx = LocalContext.current
    val scope = rememberCoroutineScope()
    val terms = state.terms ?: return onDone()
    var busy by remember { mutableStateOf(false) }
    var askDelete by remember { mutableStateOf(false) }
    fun choose(enabled: Boolean) {
        busy = true
        scope.launch {
            Contributions.set(enabled)
                .onSuccess {
                    Toast.makeText(ctx, if (enabled) "Thank you. Your recordings now help train Freesia Voice." else "Sharing is off. Nothing new is kept.", Toast.LENGTH_LONG).show()
                    if (!enabled && it.sharedRecordings > 0) askDelete = true else onDone()
                }
                .onFailure { Toast.makeText(ctx, it.message ?: "Could not save your choice", Toast.LENGTH_LONG).show(); onDone() }
            busy = false
        }
    }
    if (askDelete) {
        DeleteSharedDialog(Contributions.state.value?.sharedRecordings ?: 0, onDone)
        return
    }
    AlertDialog(
        // Closing without an answer changes nothing; the question comes back next time
        onDismissRequest = onDone,
        title = { Text(terms.title, style = Type.heading) },
        text = {
            Column(Modifier.heightIn(max = 460.dp).verticalScroll(rememberScrollState())) {
                if (firstTime) {
                    Text(
                        "New in this version",
                        style = Type.eyebrow.copy(color = t.ink),
                        modifier = Modifier.border(1.dp, bloomBrush(t.bloom), CircleShape).padding(horizontal = 10.dp, vertical = 4.dp),
                    )
                    Spacer(Modifier.height(12.dp))
                }
                Text(terms.summary, style = Type.body.copy(color = t.ink))
                terms.paragraphs.forEachIndexed { i, p ->
                    // Paragraphs drift in one after another
                    var visible by remember { mutableStateOf(false) }
                    LaunchedEffect(Unit) { kotlinx.coroutines.delay(80L * i + 120); visible = true }
                    AnimatedVisibility(visible, enter = fadeIn(spring(stiffness = 300f)) + slideInVertically(spring(dampingRatio = 0.8f, stiffness = 300f)) { it / 3 }) {
                        Text(p, style = Type.bodySmall.copy(color = t.ink2), modifier = Modifier.padding(top = 10.dp))
                    }
                }
                Spacer(Modifier.height(12.dp))
                Text("You can change this at any time in Settings, under Account.", style = Type.bodySmall.copy(color = t.ink3))
            }
        },
        confirmButton = {
            if (state.enabled && !firstTime) TextButton(onDone) { Text("Close", color = t.ink) }
            else TextButton({ choose(true) }, enabled = !busy) { Text("Share my recordings", color = t.ink) }
        },
        dismissButton = {
            if (!(state.enabled && !firstTime)) TextButton({ choose(false) }, enabled = !busy) { Text("No thanks", color = t.ink2) }
        },
        containerColor = t.sheet,
    )
}

@Composable
private fun DeleteSharedDialog(count: Int, onDone: () -> Unit) {
    val t = LocalFreesia.current
    val ctx = LocalContext.current
    val scope = rememberCoroutineScope()
    AlertDialog(
        onDismissRequest = onDone,
        title = { Text("Delete the $count recording${if (count == 1) "" else "s"} you shared?", style = Type.heading) },
        text = { Text("They are removed from the server right away and never used again. This cannot be undone.", style = Type.bodySmall.copy(color = t.ink2)) },
        confirmButton = {
            TextButton({
                scope.launch {
                    Contributions.delete()
                        .onSuccess { Toast.makeText(ctx, "Deleted ${it.deleted} clips from the server", Toast.LENGTH_SHORT).show() }
                        .onFailure { Toast.makeText(ctx, it.message ?: "Could not delete", Toast.LENGTH_LONG).show() }
                    onDone()
                }
            }) { Text("Delete", color = t.bad) }
        },
        dismissButton = { TextButton(onDone) { Text("Keep them", color = t.ink2) } },
        containerColor = t.sheet,
    )
}

/** Settings → Account: the switch, what was shared, the terms and deletion. Hidden on servers without the feature. */
@Composable
fun ContributionCard() {
    val t = LocalFreesia.current
    val scope = rememberCoroutineScope()
    val st by Contributions.state.collectAsState()
    var dialog by remember { mutableStateOf(false) }
    var askDelete by remember { mutableStateOf(false) }
    LaunchedEffect(Unit) { Contributions.refresh() }
    val s = st ?: return
    if (!s.available) return
    val n = s.sharedRecordings
    val mins = s.sharedSeconds / 60
    val amount = if (n == 0) "You have not shared any recordings."
    else "You have shared $n recording${if (n == 1) "" else "s"} (${if (mins < 1) "under a minute" else "${mins.roundToInt()} min"})."
    Spacer(Modifier.height(10.dp))
    FCard(highlighted = s.enabled) {
        SettingRow(
            "Help improve the voice engine",
            (if (s.enabled) "On. Recordings Freesia Cloud transcribes help train its speech model. " else "Off. Freesia Cloud keeps none of your audio. ") + amount,
        ) {
            FSwitch(s.enabled) { on ->
                // On goes through the terms; off is immediate
                if (on) dialog = true else scope.launch {
                    Contributions.set(false).onSuccess { if (it.sharedRecordings > 0) askDelete = true }
                }
            }
        }
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            GhostButton("Read the terms", { dialog = true })
            if (n > 0) GhostButton("Delete shared", { askDelete = true }, icon = FIcons.trash)
        }
    }
    if (dialog) ContributionDialog(s, firstTime = false) { dialog = false }
    if (askDelete) DeleteSharedDialog(n) { askDelete = false }
}
