/**
 * Transport-agnostic sync state machine shared by the app's WebSocket client
 * and the background WorkManager sync.  It owns the cursor, the projected
 * state, the outbox (client-generated idempotency keys, so a retry after a
 * crash never duplicates a message) and the set of device actions this
 * device should execute.  Transport code feeds it frames and drains its
 * outgoing frames; everything here is pure and unit-tested on the JVM.
 */
package com.assistant.core

import kotlinx.serialization.json.JsonElement

data class Outgoing(val clientMsgId: String, val conversationId: String?, val text: String, val at: Long)

enum class ConnState { OFFLINE, CONNECTING, SYNCING, LIVE }

class SyncEngine(
    private val deviceId: String,
    initialState: AssistantState = AssistantState(),
    initialOutbox: List<Outgoing> = emptyList(),
    private val now: () -> Long = { System.currentTimeMillis() },
    private val newId: () -> String = { "c_" + java.util.UUID.randomUUID().toString().replace("-", "").take(16) },
) {
    var state: AssistantState = initialState; private set
    var conn: ConnState = ConnState.OFFLINE; private set
    var devices: List<Device> = emptyList(); private set
    val outbox: MutableList<Outgoing> = initialOutbox.toMutableList()
    private val handledActions = HashSet<String>()
    private val outgoingFrames = ArrayDeque<ClientFrame>()
    private val actionsToRun = ArrayDeque<DeviceAction>()

    /** Frames the transport must send, in order. */
    fun drainOutgoing(): List<ClientFrame> = outgoingFrames.toList().also { outgoingFrames.clear() }
    /** Device actions addressed to this device that have not been executed yet. */
    fun drainActions(): List<DeviceAction> = actionsToRun.toList().also { actionsToRun.clear() }

    fun onConnecting() { conn = ConnState.CONNECTING }
    fun onOpen() { conn = ConnState.SYNCING }
    fun onClosed() { conn = ConnState.OFFLINE }

    fun onFrame(f: ServerFrame) {
        when (f) {
            is ServerFrame.Welcome -> { devices = f.devices; outgoingFrames += ClientFrame.Hello(since = state.seq) }
            is ServerFrame.EventFrame -> {
                if (f.event.seq <= state.seq) return
                state = state.apply(f.event)
                val b = f.event.body
                if (b is EventBody.DeviceActionRequested) maybeRun(b.action)
            }
            is ServerFrame.Synced -> {
                conn = ConnState.LIVE
                state.pendingActions.values.forEach { maybeRun(it) }
                outbox.forEach { outgoingFrames += ClientFrame.Send(it.conversationId, it.clientMsgId, it.text) }
            }
            is ServerFrame.Presence -> devices = f.devices
            is ServerFrame.Ack -> outbox.removeAll { it.clientMsgId == f.clientMsgId }
            is ServerFrame.Error -> f.clientMsgId?.let { id -> outbox.removeAll { it.clientMsgId == id } }
            is ServerFrame.Pong -> Unit
        }
    }

    private fun maybeRun(a: DeviceAction) {
        val mine = a.targetDeviceId == null || a.targetDeviceId == deviceId
        if (mine && a.expiresAt > now() && handledActions.add(a.id)) actionsToRun += a
    }

    /** Queue a user message; returns its idempotency key. Sent immediately when live, otherwise on the next sync. */
    fun send(text: String, conversationId: String?): String {
        val id = newId()
        outbox += Outgoing(id, conversationId, text, now())
        if (conn == ConnState.LIVE) outgoingFrames += ClientFrame.Send(conversationId, id, text)
        return id
    }

    fun cancel(conversationId: String) { outgoingFrames += ClientFrame.Cancel(conversationId) }
    fun deviceResult(actionId: String, ok: Boolean, result: JsonElement) { outgoingFrames += ClientFrame.DeviceResult(actionId, ok, result) }

    /** REST catch-up (background sync): apply a page of events fetched with GET /sync?since=. */
    fun applyRemoteEvents(events: List<Event>) { events.forEach { onFrame(ServerFrame.EventFrame(it)) } }
}
