package com.freesia.app.ui

import com.freesia.app.ui.theme.Fonts
import com.freesia.app.ui.theme.LocalFreesia
import com.freesia.app.ui.theme.Type
import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.spring
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsPressedAsState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Icon
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Slider
import androidx.compose.material3.SliderDefaults
import androidx.compose.material3.Switch
import androidx.compose.material3.SwitchDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp

val CardShape = RoundedCornerShape(18.dp)

fun bloomBrush(colors: List<Color>): Brush = Brush.linearGradient(colors)

/** A serif heading with *italic* accent words painted in the bloom. "Speak, *softly*." */
@Composable
fun accentText(source: String): AnnotatedString {
    val t = LocalFreesia.current
    return buildAnnotatedString {
        val parts = source.split('*')
        parts.forEachIndexed { i, p ->
            if (i % 2 == 1) withStyle(SpanStyle(fontStyle = FontStyle.Italic, brush = bloomBrush(t.bloom))) { append(p) }
            else append(p)
        }
    }
}

@Composable
fun Heading(text: String, modifier: Modifier = Modifier, style: TextStyle = Type.title) {
    Text(accentText(text), modifier = modifier, style = style.copy(color = LocalFreesia.current.ink))
}

@Composable
fun Eyebrow(text: String, modifier: Modifier = Modifier) {
    Text(text.uppercase(), modifier = modifier, style = Type.eyebrow.copy(color = LocalFreesia.current.ink3))
}

@Composable
fun FCard(modifier: Modifier = Modifier, padding: PaddingValues = PaddingValues(18.dp), highlighted: Boolean = false, content: @Composable ColumnScope.() -> Unit) {
    val t = LocalFreesia.current
    Column(
        modifier
            .clip(CardShape)
            .background(t.sheet)
            .then(if (highlighted) Modifier.border(1.2.dp, bloomBrush(t.bloom), CardShape) else Modifier.border(1.dp, t.line, CardShape))
            .padding(padding),
        content = content,
    )
}

/** Press feedback shared by buttons: a quick spring squish. */
@Composable
fun Modifier.pressScale(source: MutableInteractionSource): Modifier {
    val pressed by source.collectIsPressedAsState()
    val s by animateFloatAsState(if (pressed) 0.96f else 1f, spring(dampingRatio = 0.55f, stiffness = 900f), label = "press")
    return this.graphicsLayer { scaleX = s; scaleY = s }
}

@Composable
fun PrimaryButton(text: String, onClick: () -> Unit, modifier: Modifier = Modifier, enabled: Boolean = true, loading: Boolean = false) {
    val t = LocalFreesia.current
    val src = remember { MutableInteractionSource() }
    Box(
        modifier
            .pressScale(src)
            .height(50.dp)
            .clip(CircleShape)
            .background(if (enabled) t.btn else t.raise3)
            .clickable(interactionSource = src, indication = null, enabled = enabled && !loading, role = Role.Button, onClick = onClick)
            .padding(horizontal = 22.dp),
        contentAlignment = Alignment.Center,
    ) {
        Text(if (loading) "One moment…" else text, style = Type.label.copy(color = if (enabled) t.btnInk else t.ink3))
    }
}

@Composable
fun GhostButton(text: String, onClick: () -> Unit, modifier: Modifier = Modifier, icon: ImageVector? = null, enabled: Boolean = true) {
    val t = LocalFreesia.current
    val src = remember { MutableInteractionSource() }
    Row(
        modifier
            .pressScale(src)
            .height(42.dp)
            .clip(CircleShape)
            .background(t.raise)
            .border(1.dp, t.line2, CircleShape)
            .clickable(interactionSource = src, indication = null, enabled = enabled, role = Role.Button, onClick = onClick)
            .padding(horizontal = 16.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        if (icon != null) Icon(icon, null, tint = t.ink2, modifier = Modifier.size(18.dp))
        Text(text, style = Type.label.copy(color = if (enabled) t.ink else t.ink4))
    }
}

@Composable
fun IconAction(icon: ImageVector, contentDescription: String, onClick: () -> Unit, modifier: Modifier = Modifier, tint: Color? = null) {
    val t = LocalFreesia.current
    val src = remember { MutableInteractionSource() }
    Box(
        modifier
            .pressScale(src)
            .size(38.dp)
            .clip(CircleShape)
            .clickable(interactionSource = src, indication = null, role = Role.Button, onClick = onClick),
        contentAlignment = Alignment.Center,
    ) {
        Icon(icon, contentDescription, tint = tint ?: t.ink2, modifier = Modifier.size(19.dp))
    }
}

@Composable
fun FTextField(
    value: String,
    onValueChange: (String) -> Unit,
    label: String,
    modifier: Modifier = Modifier,
    singleLine: Boolean = true,
    keyboardOptions: KeyboardOptions = KeyboardOptions.Default,
    keyboardActions: KeyboardActions = KeyboardActions.Default,
    visualTransformation: VisualTransformation = VisualTransformation.None,
    placeholder: String? = null,
) {
    val t = LocalFreesia.current
    OutlinedTextField(
        value = value, onValueChange = onValueChange, modifier = modifier.fillMaxWidth(),
        label = { Text(label, style = Type.bodySmall) },
        placeholder = placeholder?.let { { Text(it, style = Type.body.copy(color = t.ink4)) } },
        singleLine = singleLine, keyboardOptions = keyboardOptions, keyboardActions = keyboardActions, visualTransformation = visualTransformation,
        textStyle = Type.body.copy(color = t.ink),
        shape = RoundedCornerShape(13.dp),
        colors = OutlinedTextFieldDefaults.colors(
            focusedBorderColor = t.bloom[1], unfocusedBorderColor = t.line2, cursorColor = t.bloom[1],
            focusedLabelColor = t.ink2, unfocusedLabelColor = t.ink3,
            focusedContainerColor = t.raise, unfocusedContainerColor = t.raise,
        ),
    )
}

@Composable
fun SettingRow(title: String, subtitle: String? = null, onClick: (() -> Unit)? = null, trailing: @Composable RowScope.() -> Unit = {}) {
    val t = LocalFreesia.current
    Row(
        Modifier.fillMaxWidth()
            .then(if (onClick != null) Modifier.clickable(onClick = onClick) else Modifier)
            .padding(vertical = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Column(Modifier.weight(1f)) {
            Text(title, style = Type.body.copy(color = t.ink))
            if (subtitle != null) Text(subtitle, style = Type.bodySmall.copy(color = t.ink3))
        }
        trailing()
    }
}

@Composable
fun FSwitch(checked: Boolean, onChange: (Boolean) -> Unit) {
    val t = LocalFreesia.current
    Switch(
        checked = checked, onCheckedChange = onChange,
        colors = SwitchDefaults.colors(
            checkedThumbColor = t.btnInk, checkedTrackColor = t.btn, checkedBorderColor = t.btn,
            uncheckedThumbColor = t.ink3, uncheckedTrackColor = t.raise2, uncheckedBorderColor = t.line2,
        ),
    )
}

@Composable
fun FSlider(value: Float, onChange: (Float) -> Unit, range: ClosedFloatingPointRange<Float>, modifier: Modifier = Modifier, steps: Int = 0) {
    val t = LocalFreesia.current
    Slider(
        value = value, onValueChange = onChange, valueRange = range, steps = steps, modifier = modifier,
        colors = SliderDefaults.colors(
            thumbColor = t.bloom[1], activeTrackColor = t.bloom[1], inactiveTrackColor = t.raise3,
            activeTickColor = Color.Transparent, inactiveTickColor = Color.Transparent,
        ),
    )
}

@Composable
fun Chip(text: String, selected: Boolean, onClick: () -> Unit, modifier: Modifier = Modifier) {
    val t = LocalFreesia.current
    val bg by animateColorAsState(if (selected) t.btn else t.raise, label = "chip")
    Box(
        modifier
            .clip(CircleShape)
            .background(bg)
            .border(BorderStroke(1.dp, if (selected) t.btn else t.line2), CircleShape)
            .clickable(onClick = onClick)
            .padding(horizontal = 14.dp, vertical = 8.dp),
    ) {
        Text(text, style = Type.label.copy(color = if (selected) t.btnInk else t.ink2))
    }
}

@Composable
fun Hairline(modifier: Modifier = Modifier) {
    Box(modifier.fillMaxWidth().height(1.dp).background(LocalFreesia.current.line))
}

@Composable
fun MonoNumber(text: String, modifier: Modifier = Modifier, size: TextStyle = Type.number) {
    Text(text, modifier = modifier, style = size.copy(fontFamily = Fonts.mono, color = LocalFreesia.current.ink))
}

@Composable
fun StatusDot(on: Boolean, modifier: Modifier = Modifier) {
    val t = LocalFreesia.current
    Box(modifier.size(8.dp).clip(CircleShape).background(if (on) bloomBrush(t.bloom) else Brush.linearGradient(listOf(t.ink4, t.ink4))))
}
