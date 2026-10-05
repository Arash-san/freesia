package com.freesia.app.ui

import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.ui.graphics.Color
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.ui.platform.LocalConfiguration
import com.freesia.app.Graph
import com.freesia.app.core.TextSplice
import com.freesia.app.dictation.Delivery
import com.freesia.app.dictation.DictationTarget
import com.freesia.app.dictation.Origin
import com.freesia.app.service.FreesiaAccessibilityService
import com.freesia.app.ui.theme.FreesiaTheme
import com.freesia.app.ui.theme.LocalFreesia
import com.freesia.app.ui.theme.Type
import android.Manifest
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.core.spring
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInVertically
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.TextRange
import androidx.compose.ui.text.input.TextFieldValue
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)
        if (savedInstanceState == null) handleIntent(intent)
        setContent {
            val s by Graph.settings.flow.collectAsState()
            FreesiaTheme(s.theme) { AppRoot() }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        handleIntent(intent)
    }

    override fun onResume() {
        super.onResume()
        Graph.settings.refreshStats()
    }

    private fun handleIntent(intent: Intent?) {
        if (intent?.getStringExtra(EXTRA_OPEN) == OPEN_SAVED) Nav.open(Tab.HISTORY)
    }

    companion object {
        private const val EXTRA_OPEN = "com.freesia.app.extra.OPEN"
        private const val OPEN_SAVED = "saved_recordings"

        /** Opens Freesia at History → Saved recordings (used by the bubble after a failed take). */
        fun savedRecordingsIntent(ctx: Context): Intent =
            Intent(ctx, MainActivity::class.java)
                .putExtra(EXTRA_OPEN, OPEN_SAVED)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP)
    }
}

/** Tab requests from outside the composition (intents, the Home banner). */
object Nav {
    private val _request = kotlinx.coroutines.flow.MutableStateFlow<Tab?>(null)
    val request: kotlinx.coroutines.flow.StateFlow<Tab?> = _request
    fun open(tab: Tab) { _request.value = tab }
    fun consumed() { _request.value = null }
}

/** The in-app scratch pad the Home orb dictates into. Lives outside composition so a take can finish anywhere. */
object Scratch {
    var value by mutableStateOf(TextFieldValue(""))

    val target = object : DictationTarget {
        override val origin = Origin.APP
        override val appPackage: String? = null
        override suspend fun deliver(text: String): Delivery = withContext(Dispatchers.Main) {
            val v = value
            val r = TextSplice.splice(v.text, v.selection.min, v.selection.max, text)
            value = TextFieldValue(r.text, TextRange(r.cursor))
            Delivery.APP
        }
    }
}

enum class Tab(val label: String, val icon: ImageVector) {
    HOME("Home", FIcons.home), HISTORY("History", FIcons.history), STYLES("Styles", FIcons.styles),
    WORDS("Vocabulary", FIcons.words), SETTINGS("Settings", FIcons.settings),
}

@Composable
fun AppRoot() {
    val t = LocalFreesia.current
    val s by Graph.settings.flow.collectAsState()
    val signedIn by Graph.tokens.signedIn.collectAsState()
    Box(Modifier.fillMaxSize().background(t.bg)) {
        when {
            // Setup screens stay phone-width, centred, on tablets
            !s.onboarded -> Box(Modifier.fillMaxSize(), contentAlignment = Alignment.TopCenter) {
                Box(Modifier.fillMaxHeight().widthIn(max = 560.dp)) {
                    Onboarding(onDone = { Graph.settings.update { it.copy(onboarded = true) } })
                }
            }
            !signedIn -> Box(Modifier.fillMaxSize(), contentAlignment = Alignment.TopCenter) {
                SignInScreen(modifier = Modifier.fillMaxHeight().widthIn(max = 560.dp), standalone = true, onSignedIn = {})
            }
            else -> MainTabs()
        }
    }
}

@Composable
private fun MainTabs() {
    val t = LocalFreesia.current
    var tab by rememberSaveable { mutableIntStateOf(0) }
    val requested by Nav.request.collectAsState()
    LaunchedEffect(requested) { requested?.let { tab = it.ordinal; Nav.consumed() } }
    val recs by Graph.recordings.items.collectAsState()
    val waiting = recs.count { it.needsRetry }
    // Tablets and unfolded foldables: a navigation rail on the side instead of the bottom bar
    val wide = LocalConfiguration.current.screenWidthDp >= 600
    val content: @Composable (Modifier) -> Unit = { modifier ->
        AnimatedContent(
            targetState = Tab.entries[tab],
            transitionSpec = {
                (fadeIn(spring(stiffness = 500f)) + slideInVertically(spring(dampingRatio = 0.8f, stiffness = 420f)) { it / 24 })
                    .togetherWith(fadeOut(spring(stiffness = 900f)))
            },
            modifier = modifier,
            label = "tabs",
        ) { current ->
            if (current == Tab.HOME) {
                HomeScreen(
                    onOpenStyles = { tab = Tab.STYLES.ordinal }, onOpenSettings = { tab = Tab.SETTINGS.ordinal },
                    onOpenSaved = { tab = Tab.HISTORY.ordinal },
                )
            } else {
                // Lists and forms read best at a phone-like width, centred on a tablet
                Box(Modifier.fillMaxSize(), contentAlignment = Alignment.TopCenter) {
                    Box(Modifier.fillMaxHeight().widthIn(max = 720.dp)) {
                        when (current) {
                            Tab.HISTORY -> HistoryScreen()
                            Tab.STYLES -> StylesScreen()
                            Tab.WORDS -> VocabularyScreen()
                            else -> SettingsScreen()
                        }
                    }
                }
            }
        }
    }
    // Voice contributions: asked once after the update, on servers that support them
    ContributionPrompt()
    if (wide) {
        Row(Modifier.fillMaxSize()) {
            NavRail(tab, waiting) { tab = it }
            Box(Modifier.width(1.dp).fillMaxHeight().background(t.line))
            content(Modifier.weight(1f).fillMaxHeight())
        }
        return
    }
    Column(Modifier.fillMaxSize()) {
        content(Modifier.weight(1f))
        Hairline()
        Row(
            Modifier.fillMaxWidth().background(t.bg).navigationBarsPadding().padding(horizontal = 8.dp, vertical = 6.dp),
            horizontalArrangement = Arrangement.SpaceAround,
        ) {
            Tab.entries.forEach { item ->
                val selected = item.ordinal == tab
                Column(
                    Modifier.weight(1f).clip(CircleShape)
                        .clickable(interactionSource = remember { MutableInteractionSource() }, indication = null) { tab = item.ordinal }
                        .padding(vertical = 6.dp),
                    horizontalAlignment = Alignment.CenterHorizontally,
                ) {
                    Box {
                        Icon(item.icon, item.label, tint = if (selected) t.ink else t.ink3, modifier = Modifier.size(22.dp))
                        // Badge: saved recordings waiting for a retry
                        if (item == Tab.HISTORY && waiting > 0) {
                            Box(
                                Modifier.align(Alignment.TopEnd).offset(x = 5.dp, y = (-3).dp).size(9.dp).clip(CircleShape)
                                    .background(t.bad).semantics { contentDescription = "$waiting saved recordings waiting" },
                            )
                        }
                    }
                    Spacer(Modifier.height(4.dp))
                    Box(
                        Modifier.width(if (selected) 16.dp else 0.dp).height(2.dp).clip(CircleShape)
                            .background(bloomBrush(t.bloom)),
                    )
                    Text(item.label, style = Type.eyebrow.copy(color = if (selected) t.ink else t.ink3), maxLines = 1)
                }
            }
        }
    }
}

/** The side navigation on tablets: same items, badge and bloom indicator as the bottom bar. */
@Composable
private fun NavRail(tab: Int, waiting: Int, onSelect: (Int) -> Unit) {
    val t = LocalFreesia.current
    Column(
        Modifier.fillMaxHeight().width(96.dp).background(t.bg).statusBarsPadding().navigationBarsPadding().padding(vertical = 20.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Box(
            Modifier.size(12.dp).clip(CircleShape).background(bloomBrush(t.bloom)),
        )
        Spacer(Modifier.height(18.dp))
        Tab.entries.forEach { item ->
            val selected = item.ordinal == tab
            Column(
                Modifier.width(80.dp).clip(RoundedCornerShape(16.dp))
                    .background(if (selected) t.raise2 else Color.Transparent)
                    .clickable { onSelect(item.ordinal) }
                    .padding(vertical = 12.dp),
                horizontalAlignment = Alignment.CenterHorizontally,
            ) {
                Box {
                    Icon(item.icon, item.label, tint = if (selected) t.ink else t.ink3, modifier = Modifier.size(24.dp))
                    if (item == Tab.HISTORY && waiting > 0) {
                        Box(
                            Modifier.align(Alignment.TopEnd).offset(x = 5.dp, y = (-3).dp).size(9.dp).clip(CircleShape)
                                .background(t.bad).semantics { contentDescription = "$waiting saved recordings waiting" },
                        )
                    }
                }
                Spacer(Modifier.height(6.dp))
                Text(item.label, style = Type.eyebrow.copy(color = if (selected) t.ink else t.ink3), maxLines = 1)
            }
        }
    }
}

// ------------------------------------------------------------------ system helpers

fun hasMicPermission(ctx: Context) =
    ContextCompat.checkSelfPermission(ctx, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED

fun runtimePermissions(): Array<String> =
    if (Build.VERSION.SDK_INT >= 33) arrayOf(Manifest.permission.RECORD_AUDIO, Manifest.permission.POST_NOTIFICATIONS)
    else arrayOf(Manifest.permission.RECORD_AUDIO)

fun isAccessibilityEnabled(ctx: Context): Boolean {
    if (FreesiaAccessibilityService.running.value) return true
    val enabled = Settings.Secure.getString(ctx.contentResolver, Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES) ?: return false
    val me = ComponentName(ctx, FreesiaAccessibilityService::class.java)
    return enabled.split(':').any { ComponentName.unflattenFromString(it) == me }
}

/** Opens Freesia's own page in Accessibility settings when the OS supports it, else the list. */
fun openAccessibilitySettings(ctx: Context) {
    val me = ComponentName(ctx, FreesiaAccessibilityService::class.java).flattenToString()
    val detail = Intent("android.settings.ACCESSIBILITY_DETAILS_SETTINGS")
        .putExtra(Intent.EXTRA_COMPONENT_NAME, me)
        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    try {
        if (Build.VERSION.SDK_INT >= 33) { ctx.startActivity(detail); return }
    } catch (e: Exception) { /* fall through */ }
    ctx.startActivity(Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
}

fun openAppInfo(ctx: Context) {
    ctx.startActivity(
        Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.fromParts("package", ctx.packageName, null))
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
    )
}

fun appLabel(ctx: Context, pkg: String?): String {
    if (pkg == null) return "Freesia"
    return try {
        ctx.packageManager.getApplicationLabel(ctx.packageManager.getApplicationInfo(pkg, 0)).toString()
    } catch (e: Exception) { pkg }
}
