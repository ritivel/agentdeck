package com.ritivel.agentdeck

import android.Manifest
import android.content.Intent
import android.os.Build
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.activity.viewModels
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import com.ritivel.agentdeck.ui.AgentDeckTheme
import com.ritivel.agentdeck.ui.RootView

class MainActivity : ComponentActivity() {
    private val client: BridgeClient by viewModels()

    private val notifPermission =
        registerForActivityResult(ActivityResultContracts.RequestPermission()) {}

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        handlePairingIntent(intent)
        setContent {
            AgentDeckTheme {
                val state by client.connState.collectAsState()
                RootView(client, state)
            }
        }
        if (Build.VERSION.SDK_INT >= 33) {
            notifPermission.launch(Manifest.permission.POST_NOTIFICATIONS)
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        handlePairingIntent(intent)
    }

    override fun onResume() {
        super.onResume()
        client.isForeground = true
    }

    override fun onPause() {
        super.onPause()
        client.isForeground = false
    }

    /** agentdeck://pair?host=..&port=..&token=.. — same deep link the iOS app uses. */
    private fun handlePairingIntent(intent: Intent?) {
        val uri = intent?.data ?: return
        if (uri.scheme != "agentdeck") return
        val host = uri.getQueryParameter("host") ?: return
        val token = uri.getQueryParameter("token") ?: return
        val port = uri.getQueryParameter("port")?.toIntOrNull() ?: 8787
        client.connect(Target("$host:$port", token))
    }
}
