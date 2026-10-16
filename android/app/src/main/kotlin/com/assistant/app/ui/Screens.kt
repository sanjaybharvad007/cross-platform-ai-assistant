package com.assistant.app.ui

import androidx.compose.foundation.background
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
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
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
import androidx.compose.material.icons.filled.Devices
import androidx.compose.material.icons.filled.Stop
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.AssistChip
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilledIconButton
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.ListItem
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.assistant.core.ConnState
import com.assistant.core.Message

@Composable
fun OnboardingScreen(vm: MainViewModel, prefillCode: String?, prefillServer: String?) {
    var name by rememberSaveable { mutableStateOf(vm.deviceName) }
    var server by rememberSaveable { mutableStateOf(prefillServer ?: vm.serverUrl) }
    var code by rememberSaveable { mutableStateOf(prefillCode ?: "") }
    val error by vm.error.collectAsStateWithLifecycle()
    Surface(Modifier.fillMaxSize()) {
        Column(Modifier.fillMaxSize().padding(24.dp), verticalArrangement = Arrangement.Center) {
            Text("Assistant", style = MaterialTheme.typography.headlineMedium, fontWeight = FontWeight.SemiBold)
            Text("One assistant across your phone and your browser. Pair with a code from the web app to continue the same conversations here.", style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(top = 8.dp, bottom = 24.dp))
            OutlinedTextField(name, { name = it }, label = { Text("This device") }, singleLine = true, modifier = Modifier.fillMaxWidth())
            Spacer(Modifier.height(12.dp))
            OutlinedTextField(server, { server = it }, label = { Text("Server URL") }, singleLine = true, modifier = Modifier.fillMaxWidth())
            Spacer(Modifier.height(12.dp))
            OutlinedTextField(code, { code = it.filter(Char::isDigit).take(6) }, label = { Text("Pairing code (optional)") }, singleLine = true, modifier = Modifier.fillMaxWidth())
            error?.let { Text(it, color = MaterialTheme.colorScheme.error, modifier = Modifier.padding(top = 8.dp)) }
            Spacer(Modifier.height(20.dp))
            Button(onClick = { vm.register(name.trim(), server.trim(), code.takeIf { it.length == 6 }) }, enabled = name.isNotBlank() && server.startsWith("http") && (code.isEmpty() || code.length == 6), modifier = Modifier.fillMaxWidth()) {
                Text(if (code.length == 6) "Join with code" else "Start")
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ConversationListScreen(vm: MainViewModel) {
    val state by vm.state.collectAsStateWithLifecycle()
    val conn by vm.conn.collectAsStateWithLifecycle()
    val devices by vm.devices.collectAsStateWithLifecycle()
    val pairCode by vm.pairCode.collectAsStateWithLifecycle()
    var showDevices by remember { mutableStateOf(false) }
    Scaffold(
        topBar = { TopAppBar(title = { Text("Assistant") }, actions = {
            ConnDot(conn)
            IconButton(onClick = { showDevices = true }) { Icon(Icons.Default.Devices, contentDescription = "Devices") }
        }) },
        floatingActionButton = { FilledIconButton(onClick = { vm.select(NEW) }, modifier = Modifier.size(56.dp)) { Icon(Icons.Default.Add, contentDescription = "New conversation") } },
    ) { pad ->
        val convs = state.sortedConversations()
        if (convs.isEmpty()) Box(Modifier.fillMaxSize().padding(pad), contentAlignment = Alignment.Center) {
            Text("No conversations yet.\nStart one here or on the web - they stay in sync.", color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(32.dp))
        }
        LazyColumn(Modifier.fillMaxSize().padding(pad)) {
            items(convs, key = { it.id }) { c ->
                val other = c.lastDeviceId?.takeIf { it != vm.deviceId }?.let { id -> devices.find { it.id == id }?.name }
                ListItem(
                    headlineContent = { Text(c.title, maxLines = 1, overflow = TextOverflow.Ellipsis) },
                    supportingContent = { Text(listOfNotNull(timeAgo(c.updatedAt), other?.let { "last on $it" }).joinToString(" · ")) },
                    modifier = Modifier.padding(horizontal = 4.dp).clickable { vm.select(c.id) },
                )
            }
        }
    }
    if (showDevices) AlertDialog(onDismissRequest = { showDevices = false }, confirmButton = { TextButton({ showDevices = false }) { Text("Done") } },
        dismissButton = { TextButton({ vm.requestPairCode() }) { Text("Add device") } }, title = { Text("Your devices") },
        text = { Column { devices.forEach { d -> Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.padding(vertical = 4.dp)) {
            Box(Modifier.size(8.dp).background(if (d.online) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.outline, CircleShape)); Spacer(Modifier.width(10.dp))
            Text(d.name + if (d.id == vm.deviceId) " (this phone)" else "", modifier = Modifier.weight(1f)); Text(if (d.online) "online" else timeAgo(d.lastSeenAt), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        } }
            TextButton({ vm.signOut(); showDevices = false }) { Text("Sign out of this phone") } } })
    pairCode?.let { code -> AlertDialog(onDismissRequest = vm::dismissPairCode, confirmButton = { TextButton(vm::dismissPairCode) { Text("Done") } }, title = { Text("Add a device") },
        text = { Column(horizontalAlignment = Alignment.CenterHorizontally, modifier = Modifier.fillMaxWidth()) { Text("Enter this code on the other device within 5 minutes."); Spacer(Modifier.height(12.dp)); Text(code.chunked(3).joinToString(" "), fontSize = 32.sp, fontFamily = FontFamily.Monospace, fontWeight = FontWeight.SemiBold) } }) }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ChatScreen(vm: MainViewModel, conversationId: String) {
    val state by vm.state.collectAsStateWithLifecycle()
    val devices by vm.devices.collectAsStateWithLifecycle()
    val conn by vm.conn.collectAsStateWithLifecycle()
    val outbox by vm.outboxSize.collectAsStateWithLifecycle()
    val isNew = conversationId == NEW
    val conv = state.conversations[conversationId]
    val msgs = if (isNew) emptyList() else state.conversationMessages(conversationId)
    val streaming = msgs.any { it.status == "streaming" }
    var input by rememberSaveable { mutableStateOf("") }
    val list = rememberLazyListState()
    LaunchedEffect(msgs.size, msgs.lastOrNull()?.content?.length) { if (msgs.isNotEmpty()) list.animateScrollToItem(msgs.lastIndex) }
    Scaffold(
        topBar = { TopAppBar(title = { Text(conv?.title ?: "New conversation", maxLines = 1, overflow = TextOverflow.Ellipsis) },
            navigationIcon = { IconButton(onClick = { vm.select(null) }) { Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back") } }, actions = { ConnDot(conn) }) },
        bottomBar = {
            Column(Modifier.imePadding().padding(12.dp)) {
                Row(verticalAlignment = Alignment.Bottom) {
                    OutlinedTextField(input, { input = it }, placeholder = { Text("Message your assistant…") }, modifier = Modifier.weight(1f), maxLines = 5, shape = RoundedCornerShape(20.dp))
                    Spacer(Modifier.width(8.dp))
                    if (streaming) FilledIconButton(onClick = { vm.cancel() }) { Icon(Icons.Default.Stop, contentDescription = "Stop") }
                    else FilledIconButton(onClick = { vm.send(input.trim()); input = "" }, enabled = input.isNotBlank()) { Icon(Icons.AutoMirrored.Filled.Send, contentDescription = "Send") }
                }
                Text(when { outbox > 0 -> "$outbox queued · sends when online"; conn == ConnState.LIVE -> "Synced"; else -> conn.name.lowercase() }, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(top = 4.dp, start = 4.dp))
            }
        },
    ) { pad ->
        val lastOther = conv?.lastDeviceId?.takeIf { it != vm.deviceId }?.let { id -> devices.find { it.id == id } }
        LazyColumn(state = list, modifier = Modifier.fillMaxSize().padding(pad), contentPadding = androidx.compose.foundation.layout.PaddingValues(12.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            if (lastOther != null) item { AssistChip(onClick = {}, label = { Text("Last active on ${lastOther.name} — continuing here") }) }
            if (isNew) item { Text("I can check the weather, set reminders and alarms, save notes, open links and do arithmetic — on this phone or your browser.", color = MaterialTheme.colorScheme.onSurfaceVariant) }
            items(msgs, key = { it.id }) { m -> MessageBubble(m, vm, devices.find { it.id == m.deviceId }?.name) }
            state.pendingActions.values.filter { it.conversationId == conversationId && it.targetDeviceId != null && it.targetDeviceId != vm.deviceId }.forEach { a ->
                item { Text("Waiting for ${devices.find { it.id == a.targetDeviceId }?.name ?: "another device"} to run ${a.name}…", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.tertiary) }
            }
        }
    }
}

@Composable
private fun MessageBubble(m: Message, vm: MainViewModel, fromDevice: String?) {
    val state by vm.state.collectAsStateWithLifecycle()
    when (m.role) {
        "user" -> Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
            Column(horizontalAlignment = Alignment.End) {
                Surface(color = MaterialTheme.colorScheme.primary, shape = RoundedCornerShape(18.dp, 18.dp, 4.dp, 18.dp)) { Text(m.content, color = MaterialTheme.colorScheme.onPrimary, modifier = Modifier.padding(12.dp, 8.dp).widthIn(max = 300.dp)) }
                fromDevice?.let { Text("from $it", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
            }
        }
        "assistant" -> Column {
            val progress = state.progress[m.id]
            if (m.status == "streaming" && progress != null) { Text(progress.label, style = MaterialTheme.typography.labelSmall); LinearProgressIndicator(progress = { progress.step.toFloat() / progress.total }, modifier = Modifier.fillMaxWidth().padding(vertical = 4.dp)) }
            m.toolCalls?.forEach { c ->
                val r = state.toolResults[m.id]?.get(c.id)
                Card(Modifier.fillMaxWidth().padding(bottom = 4.dp)) { Row(Modifier.padding(10.dp, 6.dp), verticalAlignment = Alignment.CenterVertically) {
                    Text(c.name, fontFamily = FontFamily.Monospace, style = MaterialTheme.typography.bodySmall); Spacer(Modifier.width(8.dp))
                    Text(r?.summary ?: "running…", style = MaterialTheme.typography.bodySmall, color = if (r?.ok == false) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 2, overflow = TextOverflow.Ellipsis)
                } }
            }
            if (m.content.isEmpty() && m.status == "streaming") CircularProgressIndicator(Modifier.size(16.dp), strokeWidth = 2.dp) else Text(m.content)
            when (m.status) { "error" -> Text("Something went wrong. Try again.", color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall); "cancelled" -> Text("Stopped.", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
        }
    }
}

@Composable
private fun ConnDot(conn: ConnState) {
    val color = when (conn) { ConnState.LIVE -> MaterialTheme.colorScheme.primary; ConnState.OFFLINE -> MaterialTheme.colorScheme.error; else -> MaterialTheme.colorScheme.tertiary }
    Box(Modifier.padding(end = 8.dp).size(10.dp).background(color, CircleShape))
}

internal const val NEW = "__new__"

internal fun timeAgo(t: Long): String {
    val s = ((System.currentTimeMillis() - t) / 1000).coerceAtLeast(0)
    return when { s < 60 -> "just now"; s < 3600 -> "${s / 60}m ago"; s < 86400 -> "${s / 3600}h ago"; else -> "${s / 86400}d ago" }
}
