package com.assistant.core

import com.google.common.truth.Truth.assertThat
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import org.junit.Test

class SyncEngineTest {
    private val events = ProtocolJson.decodeFromString(ListSerializer(Event.serializer()), checkNotNull(javaClass.classLoader.getResourceAsStream("events.json")).bufferedReader().readText())
    private val now = 1_760_000_000_000L
    private fun engine(deviceId: String = "dev_android") = SyncEngine(deviceId, now = { now }, newId = { "c_test" })
    private val devices = listOf(Device("dev_web", "Chrome", "web", now, true), Device("dev_android", "Pixel", "android", now, true))

    @Test fun `handshake sends hello with the cursor and goes live on synced`() {
        val e = engine()
        e.onConnecting(); assertThat(e.conn).isEqualTo(ConnState.CONNECTING)
        e.onOpen(); e.onFrame(ServerFrame.Welcome("dev_android", "usr", 11, devices))
        assertThat(e.drainOutgoing()).containsExactly(ClientFrame.Hello(since = 0))
        events.forEach { e.onFrame(ServerFrame.EventFrame(it)) }
        e.onFrame(ServerFrame.Synced(11))
        assertThat(e.conn).isEqualTo(ConnState.LIVE)
        assertThat(e.state.seq).isEqualTo(11)
        // resuming later uses the advanced cursor
        e.onFrame(ServerFrame.Welcome("dev_android", "usr", 11, devices))
        assertThat(e.drainOutgoing()).containsExactly(ClientFrame.Hello(since = 11))
    }

    @Test fun `device actions addressed to this device are surfaced once, others ignored`() {
        val e = engine("dev_android")
        e.onOpen(); e.onFrame(ServerFrame.Welcome("dev_android", "usr", 0, devices)); e.drainOutgoing()
        events.take(8).forEach { e.onFrame(ServerFrame.EventFrame(it)) }   // includes device.action for dev_android
        assertThat(e.drainActions().map { it.name }).containsExactly("set_alarm")
        e.onFrame(ServerFrame.Synced(8))
        assertThat(e.drainActions()).isEmpty()                                // not run twice on synced
        val web = engine("dev_web")
        web.onOpen(); web.onFrame(ServerFrame.Welcome("dev_web", "usr", 0, devices)); web.drainOutgoing()
        events.take(8).forEach { web.onFrame(ServerFrame.EventFrame(it)) }
        assertThat(web.drainActions()).isEmpty()
        e.deviceResult("act_1", true, buildJsonObject { put("scheduled", JsonPrimitive(true)) })
        assertThat(e.drainOutgoing().single()).isInstanceOf(ClientFrame.DeviceResult::class.java)
    }

    @Test fun `outbox queues while offline, flushes on live, clears on ack and survives duplicates`() {
        val e = engine()
        val id = e.send("hello", null)
        assertThat(id).isEqualTo("c_test")
        assertThat(e.drainOutgoing()).isEmpty()              // offline: nothing sent yet
        assertThat(e.outbox).hasSize(1)
        e.onOpen(); e.onFrame(ServerFrame.Welcome("dev_android", "usr", 0, devices)); e.drainOutgoing()
        e.onFrame(ServerFrame.Synced(0))
        assertThat(e.drainOutgoing()).containsExactly(ClientFrame.Send(null, "c_test", "hello"))
        e.onFrame(ServerFrame.Ack("c_test", "msg_1", "conv_1"))
        assertThat(e.outbox).isEmpty()
        // duplicate event delivery (overlapping replay) is ignored
        val ev = events[0]
        e.onFrame(ServerFrame.EventFrame(ev)); e.onFrame(ServerFrame.EventFrame(ev))
        assertThat(e.state.conversations).hasSize(1)
        e.send("live message", "conv_1")
        assertThat(e.drainOutgoing()).containsExactly(ClientFrame.Send("conv_1", "c_test", "live message"))
    }

    @Test fun `REST catch-up applies pages in order`() {
        val e = engine()
        e.applyRemoteEvents(events.take(5))
        e.applyRemoteEvents(events)                            // overlapping page
        assertThat(e.state.seq).isEqualTo(11)
        assertThat(e.state.conversationMessages("conv_1")[1].toolCalls!!.single().arguments).isEqualTo(JsonObject(mapOf("city" to JsonPrimitive("Zurich"))))
    }
}
