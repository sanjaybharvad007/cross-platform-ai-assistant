package com.assistant.app.ui

import android.Manifest
import android.content.Intent
import android.os.Build
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.activity.viewModels
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.lifecycle.compose.collectAsStateWithLifecycle

class MainActivity : ComponentActivity() {
    private val vm: MainViewModel by viewModels()
    private var pendingPair by mutableStateOf<Pair<String, String?>?>(null)

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        handleIntent(intent)
        setContent { AssistantTheme { Root(vm, pendingPair) { pendingPair = null } } }
    }

    override fun onNewIntent(intent: Intent) { super.onNewIntent(intent); handleIntent(intent) }
    override fun onStart() { super.onStart(); vm.onForeground() }

    /** assistant://pair?code=123456&server=https://host (from the web app's QR code) */
    private fun handleIntent(intent: Intent?) {
        val data = intent?.data ?: return
        if (data.scheme == "assistant" && data.host == "pair") pendingPair = (data.getQueryParameter("code") ?: return) to data.getQueryParameter("server")
    }
}

@Composable
private fun Root(vm: MainViewModel, pendingPair: Pair<String, String?>?, onPairConsumed: () -> Unit) {
    val signedIn by vm.signedIn.collectAsStateWithLifecycle()
    val selected by vm.selected.collectAsStateWithLifecycle()
    val notifications = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) {}
    LaunchedEffect(signedIn) { if (signedIn && Build.VERSION.SDK_INT >= 33) notifications.launch(Manifest.permission.POST_NOTIFICATIONS) }
    LaunchedEffect(pendingPair, signedIn) {
        val p = pendingPair ?: return@LaunchedEffect
        if (!signedIn) { vm.register(vm.deviceName, p.second ?: vm.serverUrl, p.first); onPairConsumed() }
    }
    when {
        !signedIn -> OnboardingScreen(vm, prefillCode = pendingPair?.first, prefillServer = pendingPair?.second)
        selected == null -> ConversationListScreen(vm)
        else -> { BackHandler { vm.select(null) }; ChatScreen(vm, conversationId = selected!!) }
    }
}
