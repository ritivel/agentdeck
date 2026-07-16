package com.ritivel.agentdeck.ui

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Stop
import androidx.compose.material3.Button
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.ritivel.agentdeck.BridgeClient
import com.ritivel.agentdeck.ConnState
import com.ritivel.agentdeck.Platform
import com.ritivel.agentdeck.SessionInfo
import com.ritivel.agentdeck.StoredEvent
import com.ritivel.agentdeck.Target

// ---------- Root ----------

@Composable
fun RootView(client: BridgeClient, state: ConnState) {
    var openSession by rememberSaveable { mutableStateOf<String?>(null) }
    client.openSessionId = openSession

    Box(Modifier.fillMaxSize().background(Bg)) {
        when {
            state != ConnState.CONNECTED && openSession == null -> PairScreen(client, state)
            openSession != null -> ChatScreen(client, openSession!!) { openSession = null }
            else -> DeckScreen(client) { openSession = it }
        }
    }
}

// ---------- Pair ----------

@Composable
fun PairScreen(client: BridgeClient, state: ConnState) {
    var host by rememberSaveable { mutableStateOf("") }
    var token by rememberSaveable { mutableStateOf("") }
    val error by client.lastError.collectAsState()

    Column(
        Modifier.fillMaxSize().padding(28.dp).statusBarsPadding(),
        verticalArrangement = Arrangement.spacedBy(14.dp, Alignment.CenterVertically),
    ) {
        Text("🃏 AgentDeck", fontSize = 30.sp, fontWeight = FontWeight.Bold)
        Text("Connect to the bridge on your Mac.", color = TextMuted)
        OutlinedTextField(
            value = host, onValueChange = { host = it },
            label = { Text("Bridge address (host:port)") },
            placeholder = { Text("192.168.1.6:8787") },
            singleLine = true, modifier = Modifier.fillMaxWidth(),
        )
        OutlinedTextField(
            value = token, onValueChange = { token = it },
            label = { Text("Token") },
            singleLine = true, modifier = Modifier.fillMaxWidth(),
        )
        Button(
            onClick = {
                if (host.isNotBlank() && token.isNotBlank()) {
                    client.connect(Target(host.trim().removePrefix("http://").removeSuffix("/"), token.trim()))
                }
            },
            enabled = host.isNotBlank() && token.isNotBlank(),
            modifier = Modifier.fillMaxWidth(),
        ) {
            Text(if (state == ConnState.CONNECTING) "Connecting…" else "Connect")
        }
        if (state == ConnState.FAILED && error != null) {
            Text(error ?: "", color = Red, fontSize = 13.sp)
        }
        Text(
            "On the Mac, run `agentdeck pair` to see the address and token.",
            color = TextMuted, fontSize = 13.sp,
        )
    }
}

// ---------- Deck ----------

@Composable
fun DeckScreen(client: BridgeClient, onOpen: (String) -> Unit) {
    val sessions by client.sessions.collectAsState()
    val platforms by client.platforms.collectAsState()
    val serverName by client.serverName.collectAsState()
    var showNewSession by remember { mutableStateOf(false) }
    var newSessionPlatform by remember { mutableStateOf<Platform?>(null) }

    Column(Modifier.fillMaxSize().statusBarsPadding()) {
        Row(
            Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 10.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Box(Modifier.size(10.dp).background(Green, CircleShape))
            Spacer(Modifier.size(9.dp))
            Text(serverName.ifEmpty { "AgentDeck" }, fontWeight = FontWeight.Bold, fontSize = 18.sp, modifier = Modifier.weight(1f))
            IconButton(onClick = { newSessionPlatform = null; showNewSession = true }) {
                Icon(Icons.Filled.Add, contentDescription = "New session")
            }
        }

        val shown = Platform.entries.filter { p ->
            platforms[p.id] == true || sessions.any { it.platform == p }
        }
        LazyColumn(Modifier.fillMaxSize(), contentPadding = androidx.compose.foundation.layout.PaddingValues(bottom = 40.dp)) {
            shown.forEach { platform ->
                val ps = sessions.filter { it.platform == platform }
                item(key = "head-${platform.id}") {
                    Row(
                        Modifier.fillMaxWidth().padding(horizontal = 18.dp).padding(top = 16.dp, bottom = 6.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Box(Modifier.size(9.dp).background(platform.accent, CircleShape))
                        Spacer(Modifier.size(8.dp))
                        Text(platform.displayName, fontWeight = FontWeight.Bold, modifier = Modifier.weight(1f))
                        Text("${ps.size} session${if (ps.size == 1) "" else "s"}", color = TextMuted, fontSize = 12.sp)
                    }
                }
                items(ps, key = { it.id }) { s ->
                    SessionCard(s) { onOpen(s.id) }
                }
                if (platforms[platform.id] == true) {
                    item(key = "new-${platform.id}") {
                        Box(
                            Modifier
                                .fillMaxWidth()
                                .padding(horizontal = 14.dp, vertical = 5.dp)
                                .border(1.dp, platform.accent.copy(alpha = 0.5f), RoundedCornerShape(16.dp))
                                .clickable { newSessionPlatform = platform; showNewSession = true }
                                .padding(vertical = 14.dp),
                            contentAlignment = Alignment.Center,
                        ) {
                            Text("＋ New ${platform.displayName} session", color = TextMuted)
                        }
                    }
                }
            }
        }
    }

    if (showNewSession) {
        NewSessionSheet(client, newSessionPlatform, onDismiss = { showNewSession = false })
    }
}

@Composable
fun SessionCard(s: SessionInfo, onClick: () -> Unit) {
    Column(
        Modifier
            .fillMaxWidth()
            .padding(horizontal = 14.dp, vertical = 5.dp)
            .background(Surface1, RoundedCornerShape(16.dp))
            .border(1.dp, Color(0xFF2C2C34), RoundedCornerShape(16.dp))
            .clickable(onClick = onClick)
            .padding(14.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(7.dp)) {
            Text(
                s.title, fontWeight = FontWeight.SemiBold,
                maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f),
            )
            if (s.attached) LiveBadge()
            StatePill(s.state)
        }
        Text(
            s.cwd, color = TextMuted, fontSize = 11.sp, fontFamily = FontFamily.Monospace,
            maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(top = 2.dp),
        )
        s.lastText?.let {
            Text(
                it, color = TextMuted, fontSize = 13.sp, maxLines = 2, overflow = TextOverflow.Ellipsis,
                modifier = Modifier.padding(top = 7.dp),
            )
        }
    }
}

@Composable
fun LiveBadge() {
    Text(
        "LIVE", color = Live, fontSize = 10.sp, fontWeight = FontWeight.Black,
        modifier = Modifier
            .background(Live.copy(alpha = 0.16f), RoundedCornerShape(50))
            .padding(horizontal = 7.dp, vertical = 2.dp),
    )
}

@Composable
fun StatePill(state: String) {
    val color = when (state) {
        "working" -> Green
        "starting" -> Yellow
        "error", "exited" -> Red
        else -> TextMuted
    }
    Text(
        state, color = color, fontSize = 11.sp, fontWeight = FontWeight.SemiBold,
        modifier = Modifier
            .background(color.copy(alpha = 0.15f), RoundedCornerShape(50))
            .padding(horizontal = 8.dp, vertical = 2.dp),
    )
}

// ---------- Chat ----------

@Composable
fun ChatScreen(client: BridgeClient, sessionId: String, onBack: () -> Unit) {
    val sessions by client.sessions.collectAsState()
    val transcripts by client.transcripts.collectAsState()
    val session = remember(sessions, sessionId) { client.session(sessionId) }
    val events = transcripts[client.resolve(sessionId)] ?: emptyList()
    var draft by rememberSaveable { mutableStateOf("") }
    val listState = rememberLazyListState()

    BackHandler(onBack = onBack)
    LaunchedEffect(sessionId) { client.requestHistoryIfNeeded(sessionId) }
    LaunchedEffect(events.size) {
        if (events.isNotEmpty()) listState.animateScrollToItem(events.size - 1)
    }

    Column(Modifier.fillMaxSize().statusBarsPadding().imePadding()) {
        Row(
            Modifier.fillMaxWidth().padding(horizontal = 6.dp, vertical = 8.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "Back") }
            Column(Modifier.weight(1f)) {
                Text(session?.title ?: "Session", fontWeight = FontWeight.Bold, maxLines = 1, overflow = TextOverflow.Ellipsis)
                Text(session?.cwd ?: "", color = TextMuted, fontSize = 11.sp, fontFamily = FontFamily.Monospace, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
            if (session?.attached == true) { LiveBadge(); Spacer(Modifier.size(6.dp)) }
            session?.let { StatePill(it.state) }
            Spacer(Modifier.size(8.dp))
        }

        LazyColumn(
            state = listState,
            modifier = Modifier.weight(1f).fillMaxWidth(),
            contentPadding = androidx.compose.foundation.layout.PaddingValues(horizontal = 12.dp, vertical = 8.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            items(events, key = { it.seq }) { ev -> EventRow(ev, session?.platform?.accent ?: Platform.CLAUDE.accent) }
        }

        if (session?.readOnly == true) {
            Text(
                "Terminal session — sending a message takes it over",
                color = TextMuted, fontSize = 12.sp,
                modifier = Modifier.fillMaxWidth().background(Surface1).padding(horizontal = 14.dp, vertical = 7.dp),
            )
        }

        Row(
            Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 8.dp).navigationBarsPadding(),
            verticalAlignment = Alignment.Bottom,
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            OutlinedTextField(
                value = draft, onValueChange = { draft = it },
                placeholder = { Text(if (session?.readOnly == true) "Take over & message…" else "Message…") },
                modifier = Modifier.weight(1f),
                maxLines = 5,
                shape = RoundedCornerShape(20.dp),
            )
            val busy = session?.isBusy == true && session.readOnly.not()
            if (busy) {
                IconButton(
                    onClick = { client.interrupt(sessionId) },
                    modifier = Modifier.background(Red, CircleShape),
                ) { Icon(Icons.Filled.Stop, "Interrupt", tint = Color.White) }
            } else {
                val accent = session?.platform?.accent ?: Platform.CLAUDE.accent
                IconButton(
                    onClick = {
                        if (draft.isNotBlank()) {
                            client.prompt(sessionId, draft.trim())
                            draft = ""
                        }
                    },
                    enabled = draft.isNotBlank(),
                    modifier = Modifier.background(if (draft.isNotBlank()) accent else Surface2, CircleShape),
                ) { Icon(Icons.AutoMirrored.Filled.Send, "Send", tint = Color.White) }
            }
        }
    }
}

@Composable
fun EventRow(ev: StoredEvent, accent: Color) {
    when (ev.kind) {
        "user" -> Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
            Text(
                ev.text ?: "", color = Color.White,
                modifier = Modifier
                    .widthIn(max = 300.dp)
                    .background(accent, RoundedCornerShape(15.dp, 15.dp, 4.dp, 15.dp))
                    .padding(horizontal = 12.dp, vertical = 8.dp),
            )
        }
        "text" -> Row(Modifier.fillMaxWidth()) {
            Text(
                ev.text ?: "",
                modifier = Modifier
                    .widthIn(max = 320.dp)
                    .background(Surface1, RoundedCornerShape(15.dp, 15.dp, 15.dp, 4.dp))
                    .padding(horizontal = 12.dp, vertical = 8.dp),
            )
        }
        "thinking" -> Text(
            ev.text ?: "", color = TextMuted, fontSize = 13.sp, fontStyle = FontStyle.Italic,
            modifier = Modifier.padding(horizontal = 12.dp),
        )
        "tool.start" -> ToolRow("🔧", ev.toolName ?: "tool", ev.detail)
        "tool.end" -> ToolRow(if (ev.isError) "❌" else "✅", null, ev.detail ?: if (ev.isError) "error" else "done")
        "turn.end" -> {
            val parts = buildList {
                ev.costUsd?.let { add("$" + String.format("%.4f", it)) }
                ev.durationMs?.let { add(String.format("%.1fs", it / 1000)) }
            }
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.Center) {
                Text(
                    if (ev.isError) "turn failed" else parts.joinToString(" · ").ifEmpty { "turn ended" },
                    color = if (ev.isError) Red else TextMuted, fontSize = 11.sp,
                )
            }
        }
        "permission.denied" -> Notice(Yellow, "✋ Permission denied: ${ev.toolName}${ev.detail?.let { " — $it" } ?: ""}")
        "error" -> Notice(Red, "⚠️ ${ev.text}")
        "status" -> Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.Center) {
            Text("status: ${ev.text}", color = TextMuted, fontSize = 11.sp)
        }
    }
}

@Composable
private fun ToolRow(icon: String, name: String?, detail: String?) {
    Row(
        Modifier.fillMaxWidth().background(Surface2, RoundedCornerShape(9.dp)).padding(horizontal = 10.dp, vertical = 7.dp),
        horizontalArrangement = Arrangement.spacedBy(7.dp),
    ) {
        Text(icon, fontSize = 12.sp)
        Column {
            name?.let { Text(it, fontWeight = FontWeight.Bold, fontSize = 12.sp, fontFamily = FontFamily.Monospace) }
            detail?.let {
                Text(
                    it.take(400), color = TextMuted, fontSize = 11.sp, fontFamily = FontFamily.Monospace,
                    maxLines = 3, overflow = TextOverflow.Ellipsis,
                )
            }
        }
    }
}

@Composable
private fun Notice(color: Color, text: String) {
    Text(
        text, color = color, fontSize = 13.sp,
        modifier = Modifier
            .fillMaxWidth()
            .background(color.copy(alpha = 0.12f), RoundedCornerShape(9.dp))
            .padding(horizontal = 10.dp, vertical = 7.dp),
    )
}

// ---------- New session ----------

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun NewSessionSheet(client: BridgeClient, initial: Platform?, onDismiss: () -> Unit) {
    val platforms by client.platforms.collectAsState()
    val dirs by client.suggestedDirs.collectAsState()
    val available = Platform.entries.filter { platforms[it.id] == true }
    var platform by remember { mutableStateOf(initial ?: available.firstOrNull() ?: Platform.CLAUDE) }
    var cwd by rememberSaveable { mutableStateOf(dirs.firstOrNull() ?: "") }
    var mode by rememberSaveable { mutableStateOf("acceptEdits") }
    var prompt by rememberSaveable { mutableStateOf("") }

    ModalBottomSheet(onDismissRequest = onDismiss, containerColor = Surface1) {
        Column(Modifier.padding(horizontal = 18.dp).padding(bottom = 24.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Text("New Session", fontWeight = FontWeight.Bold, fontSize = 18.sp)
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                available.forEach { p ->
                    TextButton(
                        onClick = { platform = p },
                        colors = androidx.compose.material3.ButtonDefaults.textButtonColors(
                            containerColor = if (p == platform) Surface2 else Color.Transparent,
                            contentColor = if (p == platform) TextPrimary else TextMuted,
                        ),
                    ) { Text(p.displayName) }
                }
            }
            OutlinedTextField(
                value = cwd, onValueChange = { cwd = it },
                label = { Text("Working directory") }, singleLine = true, modifier = Modifier.fillMaxWidth(),
            )
            if (dirs.isNotEmpty()) {
                LazyColumn(Modifier.height(110.dp).fillMaxWidth().background(Surface2, RoundedCornerShape(9.dp))) {
                    items(dirs, key = { it }) { d ->
                        Text(
                            d, fontSize = 12.sp, fontFamily = FontFamily.Monospace, maxLines = 1, overflow = TextOverflow.Ellipsis,
                            modifier = Modifier.fillMaxWidth().clickable { cwd = d }.padding(horizontal = 10.dp, vertical = 7.dp),
                        )
                    }
                }
            }
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                listOf("acceptEdits" to "Accept Edits", "plan" to "Plan", "bypassPermissions" to "Bypass").forEach { (id, label) ->
                    TextButton(
                        onClick = { mode = id },
                        colors = androidx.compose.material3.ButtonDefaults.textButtonColors(
                            containerColor = if (mode == id) Surface2 else Color.Transparent,
                            contentColor = if (mode == id) TextPrimary else TextMuted,
                        ),
                    ) { Text(label, fontSize = 13.sp) }
                }
            }
            OutlinedTextField(
                value = prompt, onValueChange = { prompt = it },
                label = { Text("First prompt (optional)") }, modifier = Modifier.fillMaxWidth(), maxLines = 4,
            )
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
                TextButton(onClick = onDismiss) { Text("Cancel") }
                Spacer(Modifier.size(8.dp))
                Button(
                    onClick = {
                        client.createSession(platform.id, cwd.trim(), mode, prompt.trim())
                        onDismiss()
                    },
                    enabled = cwd.isNotBlank(),
                ) { Text("Create Session") }
            }
        }
    }
}
