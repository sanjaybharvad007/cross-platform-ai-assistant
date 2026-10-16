package com.assistant.core

import com.google.common.truth.Truth.assertThat
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Test

/** Parses the fixtures written by `npm run fixtures` (packages/protocol) - the server's exact wire format. */
class ProtocolContractTest {
    private fun fixture(name: String) = checkNotNull(javaClass.classLoader.getResourceAsStream(name)) { "missing fixture $name" }.bufferedReader().readText()

    @Test fun `events fixture parses and re-encodes identically`() {
        val raw = fixture("events.json")
        val events = ProtocolJson.decodeFromString(ListSerializer(Event.serializer()), raw)
        assertThat(events).hasSize(11)
        assertThat(events.map { it.body::class.simpleName }).containsExactly(
            "ConversationCreated", "MessageCreated", "MessageCreated", "ToolCalled", "ToolResult", "TaskProgress",
            "MessageDelta", "DeviceActionRequested", "DeviceActionDone", "MessageCompleted", "ConversationUpdated",
        ).inOrder()
        // round-trip: re-encoding yields structurally identical JSON (field names, discriminators, defaults)
        val reEncoded = ProtocolJson.parseToJsonElement(ProtocolJson.encodeToString(ListSerializer(Event.serializer()), events))
        assertThat(reEncoded).isEqualTo(ProtocolJson.parseToJsonElement(raw))
    }

    @Test fun `server and client frames parse`() {
        val server = ProtocolJson.decodeFromString(ListSerializer(ServerFrame.serializer()), fixture("server-frames.json"))
        assertThat(server.map { it::class.simpleName }).containsExactly("Welcome", "EventFrame", "Synced", "Ack", "Error", "Pong").inOrder()
        assertThat((server[0] as ServerFrame.Welcome).devices.map { it.online }).containsExactly(true, false)
        val client = ProtocolJson.decodeFromString(ListSerializer(ClientFrame.serializer()), fixture("client-frames.json"))
        assertThat(client).hasSize(5)
        val hello = ProtocolJson.parseToJsonElement(ProtocolJson.encodeToString(ClientFrame.serializer(), ClientFrame.Hello(since = 0))).jsonObject
        assertThat(hello["type"]!!.jsonPrimitive.content).isEqualTo("hello")
        assertThat(hello["protocol"]).isEqualTo(JsonPrimitive(1))
    }

    @Test fun `projection folds the fixture log like the TypeScript client`() {
        val events = ProtocolJson.decodeFromString(ListSerializer(Event.serializer()), fixture("events.json"))
        val s = AssistantState().applyAll(events)
        assertThat(s.seq).isEqualTo(11)
        val conv = s.sortedConversations().single()
        assertThat(conv.title).isEqualTo("Zurich weekend")
        assertThat(conv.lastDeviceId).isEqualTo("dev_android")
        val msgs = s.conversationMessages("conv_1")
        assertThat(msgs.map { it.role }).containsExactly("user", "assistant").inOrder()
        assertThat(msgs[1].content).isEqualTo("Day 1: Old Town and the lake. ")
        assertThat(msgs[1].status).isEqualTo("complete")
        assertThat(msgs[1].toolCalls!!.single().name).isEqualTo("get_weather")
        assertThat(s.pendingActions).isEmpty()
        assertThat(s.toolResults["msg_a1"]!!["call_1"]!!.summary).isEqualTo("12°C, light rain")
        // idempotent and resumable
        assertThat(s.applyAll(events)).isEqualTo(s)
        val partial = AssistantState().applyAll(events.take(7))
        assertThat(partial.conversationMessages("conv_1")[1].status).isEqualTo("streaming")
        assertThat(partial.applyAll(events.drop(5))).isEqualTo(s)
    }
}
