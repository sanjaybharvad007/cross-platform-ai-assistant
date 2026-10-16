package com.assistant.app.sync

import android.content.Context
import android.util.Log
import androidx.room.withTransaction
import com.assistant.app.data.Prefs
import com.assistant.app.data.local.AppDatabase
import com.assistant.app.data.local.ConversationEntity
import com.assistant.app.data.local.MessageEntity
import com.assistant.app.data.local.OutboxEntity
import com.assistant.app.data.local.SyncStateEntity
import com.assistant.app.data.remote.ApiClient
import com.assistant.app.device.DeviceActions
import com.assistant.core.AssistantState
import com.assistant.core.ClientFrame
import com.assistant.core.ConnState
import com.assistant.core.Conversation
import com.assistant.core.Device
import com.assistant.core.Message
import com.assistant.core.Outgoing
import com.assistant.core.ProtocolJson
import com.assistant.core.ServerFrame
import com.assistant.core.SyncEngine
import com.assistant.core.ToolCall
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.builtins.ListSerializer
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener

/**
 * Owns the SyncEngine, the OkHttp WebSocket and persistence.  The UI observes
 * [state], [conn] and [devices]; everything else is plumbing: feed frames to
 * the engine, send what it asks, run device actions, write the projection to
 * Room so the next launch is instant and offline-capable.
 */
class SyncRepository(private val context: Context, private val prefs: Prefs, val api: ApiClient, private val http: OkHttpClient, private val db: AppDatabase) {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val mutex = Mutex()
    private var engine: SyncEngine? = null
    private var socket: WebSocket? = null
    private var reconnectJob: Job? = null
    private var backoffMs = 500L
    private var wantConnected = false
    /** Frames are applied strictly in arrival order: event seq must be monotonic. */
    private val frames = Channel<String>(Channel.UNLIMITED)

    private val _state = MutableStateFlow(AssistantState())
    val state: StateFlow<AssistantState> = _state.asStateFlow()
    private val _conn = MutableStateFlow(ConnState.OFFLINE)
    val conn: StateFlow<ConnState> = _conn.asStateFlow()
    private val _devices = MutableStateFlow<List<Device>>(emptyList())
    val devices: StateFlow<List<Device>> = _devices.asStateFlow()
    private val _outboxSize = MutableStateFlow(0)
    val outboxSize: StateFlow<Int> = _outboxSize.asStateFlow()

    init {
        scope.launch { for (text in frames) handleFrame(text) }
    }

    /** Load the cached projection and outbox into a fresh engine. Safe to call repeatedly. */
    suspend fun ensureEngine(): SyncEngine = mutex.withLock {
        engine ?: run {
            val dao = db.dao()
            val conversations = dao.allConversations().associate { it.id to Conversation(it.id, it.title, it.createdAt, it.updatedAt, it.lastDeviceId, it.archived) }
            val messages = dao.allMessages()
            val state = AssistantState(
                seq = dao.seq() ?: 0,
                conversations = conversations,
                messages = messages.associate { it.id to it.toMessage() },
                order = messages.groupBy { it.conversationId }.mapValues { (_, ms) -> ms.sortedBy { it.position }.map { it.id } },
            )
            val outbox = dao.outbox().map { Outgoing(it.clientMsgId, it.conversationId, it.text, it.at) }
            SyncEngine(prefs.deviceId ?: "", state, outbox).also { engine = it; publish(it) }
        }
    }

    fun connect() {
        wantConnected = true
        scope.launch {
            val e = ensureEngine()
            val token = prefs.token ?: return@launch
            if (socket != null) return@launch
            e.onConnecting(); publish(e)
            val url = prefs.serverUrl.replace(Regex("^http"), "ws") + "/ws?token=$token"
            socket = http.newWebSocket(Request.Builder().url(url).build(), listener)
        }
    }

    fun disconnect() { wantConnected = false; reconnectJob?.cancel(); socket?.close(1000, "background"); socket = null }

    private val listener = object : WebSocketListener() {
        override fun onOpen(webSocket: WebSocket, response: Response) { scope.launch { val e = ensureEngine(); e.onOpen(); backoffMs = 500; flush(e) } }
        override fun onMessage(webSocket: WebSocket, text: String) { frames.trySend(text) }
        override fun onClosed(webSocket: WebSocket, code: Int, reason: String) = onDrop()
        override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) { Log.w(TAG, "socket failure: ${t.message}"); onDrop() }
    }

    private suspend fun handleFrame(text: String) {
        val e = ensureEngine()
        val frame = runCatching { ProtocolJson.decodeFromString(ServerFrame.serializer(), text) }.getOrElse { Log.w(TAG, "bad frame: ${it.message}"); return }
        mutex.withLock { e.onFrame(frame) }
        if (frame is ServerFrame.Error) Log.w(TAG, "server error ${frame.code}: ${frame.message}")
        flush(e)
        persist(e)
        publish(e)
    }

    private fun onDrop() {
        socket = null
        scope.launch { val e = ensureEngine(); e.onClosed(); publish(e) }
        if (!wantConnected) return
        reconnectJob?.cancel()
        reconnectJob = scope.launch { delay(backoffMs); backoffMs = (backoffMs * 2).coerceAtMost(15_000); if (wantConnected && socket == null) connect() }
    }

    /** Send queued frames and execute device actions the engine surfaced. */
    private suspend fun flush(e: SyncEngine) {
        val frames = mutex.withLock { e.drainOutgoing() }
        val s = socket
        for (f in frames) s?.send(ProtocolJson.encodeToString(ClientFrame.serializer(), f))
        val actions = mutex.withLock { e.drainActions() }
        for (a in actions) scope.launch {
            val r = DeviceActions.run(context, a)
            mutex.withLock { e.deviceResult(a.id, r.ok, r.result) }
            flush(e)
        }
    }

    suspend fun send(text: String, conversationId: String?): String {
        val e = ensureEngine()
        val id = mutex.withLock { e.send(text, conversationId) }
        flush(e); persist(e); publish(e)
        return id
    }

    suspend fun cancel(conversationId: String) { val e = ensureEngine(); mutex.withLock { e.cancel(conversationId) }; flush(e) }

    /** Background catch-up over REST (no socket): pull events, push the outbox. Used by SyncWorker. */
    suspend fun catchUp(): Boolean {
        val token = prefs.token ?: return false
        val e = ensureEngine()
        var since = e.state.seq
        var changed = false
        while (true) {
            val page = api.sync(token, since)
            if (page.events.isEmpty()) break
            mutex.withLock { e.applyRemoteEvents(page.events) }
            since = page.events.last().seq; changed = true
            if (!page.hasMore) break
        }
        for (o in e.outbox.toList()) {
            runCatching { api.sendMessage(token, o.conversationId, o.clientMsgId, o.text) }.onSuccess { mutex.withLock { e.outbox.removeAll { it.clientMsgId == o.clientMsgId } }; changed = true }
        }
        if (changed) { persist(e); publish(e) }
        return changed
    }

    suspend fun signOut() {
        disconnect()
        db.withTransaction { with(db.dao()) { clearConversations(); clearMessages(); clearOutbox(); setSeq(SyncStateEntity(seq = 0)) } }
        prefs.clear(); mutex.withLock { engine = null }; _state.value = AssistantState(); _devices.value = emptyList() }

    private fun publish(e: SyncEngine) { _state.value = e.state; _conn.value = e.conn; _devices.value = e.devices; _outboxSize.value = e.outbox.size }

    private suspend fun persist(e: SyncEngine) {
        val s = e.state
        val dao = db.dao()
        db.withTransaction {
        dao.upsertConversations(s.conversations.values.map { ConversationEntity(it.id, it.title, it.createdAt, it.updatedAt, it.lastDeviceId, it.archived) })
        dao.upsertMessages(s.order.flatMap { (cid, ids) -> ids.mapIndexedNotNull { i, id -> s.messages[id]?.toEntity(cid, i) } })
        dao.pruneConversations(s.conversations.keys.toList().ifEmpty { listOf("-") })
        dao.pruneMessages(s.messages.keys.toList().ifEmpty { listOf("-") })
        dao.clearOutbox(); dao.replaceOutbox(e.outbox.map { OutboxEntity(it.clientMsgId, it.conversationId, it.text, it.at) })
        dao.setSeq(SyncStateEntity(seq = s.seq))
        }
    }

    private fun Message.toEntity(conversationId: String, position: Int) = MessageEntity(
        id, conversationId, role, content, toolCalls?.let { ProtocolJson.encodeToString(ListSerializer(ToolCall.serializer()), it) }, toolCallId, deviceId, clientMsgId, status, createdAt, position,
    )
    private fun MessageEntity.toMessage() = Message(
        id, conversationId, role, content, toolCallsJson?.let { ProtocolJson.decodeFromString(ListSerializer(ToolCall.serializer()), it) }, toolCallId, deviceId, clientMsgId, status, createdAt,
    )

    companion object { private const val TAG = "SyncRepository" }
}
