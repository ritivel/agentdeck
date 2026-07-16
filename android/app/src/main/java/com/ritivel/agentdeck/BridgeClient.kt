package com.ritivel.agentdeck

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import java.util.concurrent.TimeUnit
import kotlin.math.min
import kotlin.math.pow

data class Target(val host: String, val token: String)

enum class ConnState { DISCONNECTED, CONNECTING, CONNECTED, FAILED }

/**
 * The bridge WebSocket client — the Android sibling of BridgeClient.swift and
 * web/app.js. Holds all UI state as StateFlows.
 */
class BridgeClient(app: Application) : AndroidViewModel(app) {

    val connState = MutableStateFlow(ConnState.DISCONNECTED)
    val serverName = MutableStateFlow("")
    val platforms = MutableStateFlow<Map<String, Boolean>>(emptyMap()) // id -> available
    val sessions = MutableStateFlow<List<SessionInfo>>(emptyList())
    val transcripts = MutableStateFlow<Map<String, List<StoredEvent>>>(emptyMap())
    val suggestedDirs = MutableStateFlow<List<String>>(emptyList())
    val lastError = MutableStateFlow<String?>(null)
    /** The session the user is looking at (drives notification suppression). */
    @Volatile var openSessionId: String? = null
    @Volatile var isForeground = true

    private val redirects = HashMap<String, String>()
    private val requestedHistory = HashSet<String>()
    private var ws: WebSocket? = null
    private var target: Target? = null
    private var explicitlyClosed = false
    private var reconnectAttempt = 0
    private var reconnectJob: Job? = null

    private val prefs = app.getSharedPreferences("agentdeck", Application.MODE_PRIVATE)
    private val http = OkHttpClient.Builder()
        .pingInterval(20, TimeUnit.SECONDS)
        .readTimeout(0, TimeUnit.MILLISECONDS)
        .build()
    private val json = Json { ignoreUnknownKeys = true }

    init {
        val host = prefs.getString("host", null)
        val token = prefs.getString("token", null)
        if (host != null && token != null) connect(Target(host, token))
    }

    fun connect(t: Target) {
        target = t
        explicitlyClosed = false
        reconnectAttempt = 0
        openSocket()
    }

    fun disconnect() {
        explicitlyClosed = true
        ws?.close(1000, "bye")
        ws = null
        connState.value = ConnState.DISCONNECTED
        prefs.edit().clear().apply()
    }

    private fun openSocket() {
        val t = target ?: return
        ws?.cancel()
        connState.value = ConnState.CONNECTING
        val request = Request.Builder()
            .url("ws://${t.host}/ws?token=${java.net.URLEncoder.encode(t.token, "UTF-8")}")
            .build()
        ws = http.newWebSocket(request, listener)
    }

    private val listener = object : WebSocketListener() {
        override fun onOpen(webSocket: WebSocket, response: Response) {
            send(buildJsonObject { put("type", "hello"); put("clientName", "android") })
        }

        override fun onMessage(webSocket: WebSocket, text: String) {
            runCatching { json.parseToJsonElement(text).obj()?.let { apply(it) } }
        }

        override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
            if (ws !== webSocket) return
            connState.value = ConnState.FAILED
            lastError.value = t.message
            scheduleReconnect()
        }

        override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
            if (ws !== webSocket) return
            if (!explicitlyClosed) {
                connState.value = ConnState.DISCONNECTED
                scheduleReconnect()
            }
        }
    }

    private fun scheduleReconnect() {
        if (explicitlyClosed) return
        reconnectAttempt++
        reconnectJob?.cancel()
        reconnectJob = viewModelScope.launch {
            delay(min(15000.0, 1000.0 * 2.0.pow(min(reconnectAttempt, 4))).toLong())
            if (!explicitlyClosed && connState.value != ConnState.CONNECTED) openSocket()
        }
    }

    private fun send(obj: JsonObject) {
        ws?.send(obj.toString())
    }

    // ---- protocol ----

    private fun apply(m: JsonObject) {
        when (m.str("type")) {
            "welcome" -> {
                serverName.value = m.str("serverName") ?: "AgentDeck"
                platforms.value = (m["platforms"] as? JsonObject)?.mapValues { (_, v) ->
                    (v as? JsonObject)?.bool("available") == true
                } ?: emptyMap()
                sessions.value = parseSessions(m["sessions"])
                connState.value = ConnState.CONNECTED
                reconnectAttempt = 0
                target?.let { prefs.edit().putString("host", it.host).putString("token", it.token).apply() }
                send(buildJsonObject { put("type", "dirs.suggest") })
            }
            "sessions" -> sessions.value = parseSessions(m["sessions"])
            "session.created", "session.updated" ->
                (m["session"] as? JsonObject)?.let { SessionInfo.from(it) }?.let(::upsert)
            "session.removed" -> {
                val id = m.str("sessionId") ?: return
                sessions.value = sessions.value.filter { it.id != id }
                if (!redirects.containsKey(id)) transcripts.value = transcripts.value - id
            }
            "session.takeover" -> {
                val from = m.str("fromSessionId") ?: return
                val s = (m["session"] as? JsonObject)?.let { SessionInfo.from(it) } ?: return
                redirects[from] = s.id
                upsert(s)
                if (!transcripts.value.containsKey(s.id)) {
                    transcripts.value[from]?.let { transcripts.value = transcripts.value + (s.id to it) }
                }
                send(buildJsonObject { put("type", "session.history"); put("sessionId", s.id) })
            }
            "event" -> {
                val sid = m.str("sessionId") ?: return
                val seq = m.int("seq") ?: return
                val ev = (m["event"] as? JsonObject)?.let { StoredEvent.from(seq, it) } ?: return
                val list = transcripts.value[sid] ?: emptyList()
                if (list.none { it.seq == seq }) {
                    transcripts.value = transcripts.value + (sid to (list + ev).sortedBy { it.seq })
                }
                onEvent(sid, ev)
            }
            "history" -> {
                val sid = m.str("sessionId") ?: return
                val events = (m["events"] as? JsonArray)?.mapNotNull { el ->
                    (el as? JsonObject)?.let { o ->
                        val seq = o.int("seq") ?: return@let null
                        (o["event"] as? JsonObject)?.let { StoredEvent.from(seq, it) }
                    }
                } ?: emptyList()
                transcripts.value = transcripts.value + (sid to events.sortedBy { it.seq })
            }
            "dirs" -> suggestedDirs.value =
                (m["dirs"] as? JsonArray)?.mapNotNull {
                    runCatching { it.jsonPrimitive.content }.getOrNull()
                } ?: emptyList()
            "error" -> lastError.value = m.str("message")
        }
    }

    private fun onEvent(sessionId: String, ev: StoredEvent) {
        val body = when (ev.kind) {
            "turn.end" -> if (ev.isError) "Turn ended with an error." else "Agent finished — needs input."
            "permission.denied" -> "Blocked: ${ev.toolName}"
            "error" -> ev.text
            else -> null
        } ?: return
        if (isForeground && resolve(openSessionId ?: "") == sessionId) return
        val s = sessions.value.find { it.id == sessionId }
        Notifications.notify(getApplication(), "${s?.platform?.displayName ?: "Agent"} · ${s?.title ?: "Session"}", body)
    }

    private fun parseSessions(el: Any?) =
        ((el as? JsonArray)?.mapNotNull { (it as? JsonObject)?.let(SessionInfo::from) } ?: emptyList())
            .sortedByDescending { it.updatedAt }

    private fun upsert(s: SessionInfo) {
        sessions.value = (sessions.value.filter { it.id != s.id } + s).sortedByDescending { it.updatedAt }
    }

    // ---- API used by the UI ----

    fun resolve(id: String): String {
        var cur = id
        var hops = 0
        while (hops++ < 10) cur = redirects[cur] ?: return cur
        return cur
    }

    fun session(id: String): SessionInfo? = sessions.value.find { it.id == resolve(id) }

    fun requestHistoryIfNeeded(id: String) {
        val r = resolve(id)
        if (!transcripts.value.containsKey(r) && requestedHistory.add(r)) {
            send(buildJsonObject { put("type", "session.history"); put("sessionId", r) })
        }
    }

    fun prompt(id: String, text: String) =
        send(buildJsonObject { put("type", "prompt"); put("sessionId", resolve(id)); put("text", text) })

    fun interrupt(id: String) =
        send(buildJsonObject { put("type", "interrupt"); put("sessionId", resolve(id)) })

    fun archive(id: String) =
        send(buildJsonObject { put("type", "session.archive"); put("sessionId", resolve(id)) })

    fun createSession(platform: String, cwd: String, permissionMode: String, prompt: String?) =
        send(buildJsonObject {
            put("type", "session.create")
            put("platform", platform)
            put("cwd", cwd)
            put("permissionMode", permissionMode)
            if (!prompt.isNullOrBlank()) put("prompt", prompt)
        })
}
