package com.ritivel.agentdeck.ui

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color

// Matches the iOS/web design language: near-black background, subtle surfaces.
val Bg = Color(0xFF0D0D0F)
val Surface1 = Color(0xFF1B1B1F)
val Surface2 = Color(0xFF26262C)
val TextPrimary = Color(0xFFF2F2F4)
val TextMuted = Color(0xFF9A9AA3)
val Live = Color(0xFFB26AE8)
val Red = Color(0xFFFF5F57)
val Green = Color(0xFF34C47C)
val Yellow = Color(0xFFF5C542)

private val scheme = darkColorScheme(
    background = Bg,
    surface = Surface1,
    surfaceVariant = Surface2,
    onBackground = TextPrimary,
    onSurface = TextPrimary,
    primary = Color(0xFFE8823A),
    onPrimary = Color.White,
    error = Red,
)

@Composable
fun AgentDeckTheme(content: @Composable () -> Unit) {
    isSystemInDarkTheme() // always dark, like the iOS app
    MaterialTheme(colorScheme = scheme, content = content)
}
