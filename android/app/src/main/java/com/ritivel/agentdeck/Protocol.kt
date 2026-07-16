package com.ritivel.agentdeck

import androidx.compose.ui.graphics.Color
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

// Bridge protocol models (PROTOCOL.md) — parsed leniently from JsonObject so
// unknown fields/kinds never crash the client.

enum class Platform(val id: String, val displayName: String, val accent: Color) {
    CLAUDE("claude", "Claude", Color(0xFFE8823A)),
    CURSOR("cursor", "Cursor", Color(0xFF3F8CFF)),
    CODEX("codex", "Codex", Color(0xFF34C47C));

    companion object {
        fun from(id: String?) = entries.find { it.id == id }
    }
}

data class SessionInfo(
    val id: String,
    val platform: Platform,
    val title: String,
    val cwd: String,
    val state: String,
    val nativeSessionId: String?,
    val updatedAt: Double,
    val lastText: String?,
    val attached: Boolean,
    val readOnly: Boolean,
) {
    val isBusy get() = state == "working" || state == "starting"

    companion object {
        fun from(o: JsonObject): SessionInfo? {
            val platform = Platform.from(o.str("platform")) ?: return null
            return SessionInfo(
                id = o.str("id") ?: return null,
                platform = platform,
                title = o.str("title") ?: "session",
                cwd = o.str("cwd") ?: "",
                state = o.str("state") ?: "unknown",
                nativeSessionId = o.str("nativeSessionId"),
                updatedAt = o["updatedAt"]?.jsonPrimitive?.doubleOrNull ?: 0.0,
                lastText = o.str("lastText"),
                attached = o.bool("attached"),
                readOnly = o.bool("readOnly"),
            )
        }
    }
}

/** One transcript entry: kind + the fields the UI renders. */
data class StoredEvent(
    val seq: Int,
    val kind: String,
    val text: String? = null,
    val toolName: String? = null,
    val detail: String? = null,
    val isError: Boolean = false,
    val costUsd: Double? = null,
    val durationMs: Double? = null,
) {
    companion object {
        fun from(seq: Int, e: JsonObject): StoredEvent {
            val kind = e.str("kind") ?: "unknown"
            return when (kind) {
                "user", "text", "thinking" -> StoredEvent(seq, kind, text = e.str("text") ?: "")
                "tool.start" -> StoredEvent(
                    seq, kind,
                    toolName = e.str("toolName") ?: "tool",
                    detail = e["input"]?.compact(),
                )
                "tool.end" -> StoredEvent(
                    seq, kind,
                    detail = e.str("output"),
                    isError = e.bool("isError"),
                )
                "turn.end" -> StoredEvent(
                    seq, kind,
                    isError = e.bool("isError"),
                    costUsd = e["costUsd"]?.jsonPrimitive?.doubleOrNull,
                    durationMs = e["durationMs"]?.jsonPrimitive?.doubleOrNull,
                )
                "permission.denied" -> StoredEvent(
                    seq, kind,
                    toolName = e.str("toolName") ?: "tool",
                    detail = e.str("detail"),
                )
                "error" -> StoredEvent(seq, kind, text = e.str("message") ?: "error")
                "status" -> StoredEvent(seq, kind, text = e.str("state") ?: "")
                else -> StoredEvent(seq, kind)
            }
        }
    }
}

fun JsonObject.str(key: String): String? =
    (this[key] as? JsonElement)?.let { runCatching { it.jsonPrimitive.content }.getOrNull() }

fun JsonObject.bool(key: String): Boolean =
    this[key]?.jsonPrimitive?.booleanOrNull == true

fun JsonObject.int(key: String): Int? = this[key]?.jsonPrimitive?.intOrNull

fun JsonElement.compact(): String = when (this) {
    is JsonObject -> this.entries.joinToString(", ", "{", "}") { "${it.key}: ${it.value.compact()}" }
    else -> runCatching { jsonPrimitive.content }.getOrElse { toString() }
}

fun JsonElement.obj(): JsonObject? = this as? JsonObject ?: runCatching { jsonObject }.getOrNull()
