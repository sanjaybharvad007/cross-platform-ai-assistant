/**
 * Kotlin mirror of `@assistant/protocol` (packages/protocol/src/index.ts).
 * Field names and discriminators match the JSON the server emits exactly;
 * ProtocolContractTest parses the shared fixtures to prove it.
 */
package com.assistant.core

import kotlinx.serialization.EncodeDefault
import kotlinx.serialization.ExperimentalSerializationApi
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject

const val PROTOCOL_VERSION = 1

val ProtocolJson = Json {
    ignoreUnknownKeys = true      // forward compatible with newer servers
    encodeDefaults = true
    classDiscriminator = "type"
    explicitNulls = false
}

@Serializable data class ToolCall(val id: String, val name: String, val arguments: JsonObject)

@Serializable
data class Message(
    val id: String,
    val conversationId: String,
    val role: String,
    val content: String,
    val toolCalls: List<ToolCall>? = null,
    val toolCallId: String? = null,
    val deviceId: String? = null,
    val clientMsgId: String? = null,
    val status: String = "complete",
    val createdAt: Long,
)

@Serializable
data class Conversation(
    val id: String,
    val title: String,
    val createdAt: Long,
    val updatedAt: Long,
    val lastDeviceId: String? = null,
    val archived: Boolean = false,
)

@Serializable
data class Device(val id: String, val name: String, val platform: String, val lastSeenAt: Long, val online: Boolean = false)

@Serializable
data class DeviceAction(
    val id: String,
    val conversationId: String,
    val messageId: String,
    val toolCallId: String,
    val name: String,
    val arguments: JsonObject,
    val targetDeviceId: String? = null,
    val expiresAt: Long,
)

@Serializable data class ConversationPatch(val title: String? = null, val archived: Boolean? = null, val lastDeviceId: String? = null, val updatedAt: Long? = null)
@Serializable data class Usage(val input: Int, val output: Int)

@Serializable
sealed class EventBody {
    @Serializable @SerialName("conversation.created") data class ConversationCreated(val conversation: Conversation) : EventBody()
    @Serializable @SerialName("conversation.updated") data class ConversationUpdated(val conversationId: String, val patch: ConversationPatch) : EventBody()
    @Serializable @SerialName("conversation.deleted") data class ConversationDeleted(val conversationId: String) : EventBody()
    @Serializable @SerialName("message.created") data class MessageCreated(val message: Message) : EventBody()
    @Serializable @SerialName("message.delta") data class MessageDelta(val conversationId: String, val messageId: String, val delta: String) : EventBody()
    @Serializable @SerialName("message.completed") data class MessageCompleted(val conversationId: String, val messageId: String, val status: String, val error: String? = null, val usage: Usage? = null) : EventBody()
    @Serializable @SerialName("tool.called") data class ToolCalled(val conversationId: String, val messageId: String, val call: ToolCall, val executor: String) : EventBody()
    @Serializable @SerialName("tool.result") data class ToolResult(val conversationId: String, val messageId: String, val toolCallId: String, val ok: Boolean, val summary: String, val deviceId: String? = null) : EventBody()
    @Serializable @SerialName("device.action") data class DeviceActionRequested(val action: DeviceAction) : EventBody()
    @Serializable @SerialName("device.action.done") data class DeviceActionDone(val actionId: String, val deviceId: String, val ok: Boolean) : EventBody()
    @Serializable @SerialName("task.progress") data class TaskProgress(val conversationId: String, val messageId: String, val step: Int, val total: Int, val label: String) : EventBody()
}

@Serializable data class Event(val seq: Long, val at: Long, val body: EventBody)

@Serializable
sealed class ClientFrame {
    @OptIn(ExperimentalSerializationApi::class)
    @Serializable @SerialName("hello") data class Hello(val since: Long, @EncodeDefault val protocol: Int = PROTOCOL_VERSION) : ClientFrame()
    @Serializable @SerialName("send") data class Send(val conversationId: String? = null, val clientMsgId: String, val text: String) : ClientFrame()
    @Serializable @SerialName("cancel") data class Cancel(val conversationId: String) : ClientFrame()
    @Serializable @SerialName("device.result") data class DeviceResult(val actionId: String, val ok: Boolean, val result: JsonElement) : ClientFrame()
    @Serializable @SerialName("ping") data class Ping(val t: Long) : ClientFrame()
}

@Serializable
sealed class ServerFrame {
    @Serializable @SerialName("welcome") data class Welcome(val deviceId: String, val userId: String, val serverSeq: Long, val devices: List<Device>) : ServerFrame()
    @Serializable @SerialName("event") data class EventFrame(val event: Event) : ServerFrame()
    @Serializable @SerialName("synced") data class Synced(val seq: Long) : ServerFrame()
    @Serializable @SerialName("presence") data class Presence(val devices: List<Device>) : ServerFrame()
    @Serializable @SerialName("ack") data class Ack(val clientMsgId: String, val messageId: String, val conversationId: String) : ServerFrame()
    @Serializable @SerialName("error") data class Error(val code: String, val message: String, val clientMsgId: String? = null) : ServerFrame()
    @Serializable @SerialName("pong") data class Pong(val t: Long) : ServerFrame()
}

@Serializable data class RegisterDeviceRequest(val name: String, val platform: String = "android", val pairCode: String? = null)
@Serializable data class RegisterDeviceResponse(val token: String, val userId: String, val deviceId: String)
@Serializable data class PairCodeResponse(val code: String, val expiresAt: Long)
@Serializable data class SyncResponse(val events: List<Event>, val seq: Long, val hasMore: Boolean)
