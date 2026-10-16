/**
 * Port of packages/protocol/src/projection.ts: fold events into state.
 * Deterministic and idempotent (events at or below the cursor are ignored),
 * so replaying from any cursor converges on the same state as the web client.
 */
package com.assistant.core

data class ToolOutcome(val ok: Boolean, val summary: String)
data class Progress(val step: Int, val total: Int, val label: String)

data class AssistantState(
    val seq: Long = 0,
    val conversations: Map<String, Conversation> = emptyMap(),
    val messages: Map<String, Message> = emptyMap(),
    val order: Map<String, List<String>> = emptyMap(),
    val pendingActions: Map<String, DeviceAction> = emptyMap(),
    val toolResults: Map<String, Map<String, ToolOutcome>> = emptyMap(),
    val progress: Map<String, Progress> = emptyMap(),
) {
    fun conversationMessages(conversationId: String): List<Message> = (order[conversationId] ?: emptyList()).mapNotNull { messages[it] }
    fun sortedConversations(): List<Conversation> = conversations.values.filter { !it.archived }.sortedByDescending { it.updatedAt }
}

fun AssistantState.apply(ev: Event): AssistantState {
    if (ev.seq <= seq) return this
    var s = copy(seq = ev.seq)
    when (val b = ev.body) {
        is EventBody.ConversationCreated -> s = s.copy(
            conversations = s.conversations + (b.conversation.id to b.conversation),
            order = s.order + (b.conversation.id to (s.order[b.conversation.id] ?: emptyList())),
        )
        is EventBody.ConversationUpdated -> s.conversations[b.conversationId]?.let { c ->
            s = s.copy(conversations = s.conversations + (c.id to c.copy(
                title = b.patch.title ?: c.title, archived = b.patch.archived ?: c.archived,
                lastDeviceId = b.patch.lastDeviceId ?: c.lastDeviceId, updatedAt = b.patch.updatedAt ?: c.updatedAt,
            )))
        }
        is EventBody.ConversationDeleted -> {
            val ids = s.order[b.conversationId] ?: emptyList()
            s = s.copy(conversations = s.conversations - b.conversationId, messages = s.messages - ids.toSet(), order = s.order - b.conversationId)
        }
        is EventBody.MessageCreated -> {
            val m = b.message
            val list = s.order[m.conversationId] ?: emptyList()
            s = s.copy(messages = s.messages + (m.id to m), order = s.order + (m.conversationId to if (m.id in list) list else list + m.id))
            s = s.touch(m.conversationId, ev.at, m.deviceId)
        }
        is EventBody.MessageDelta -> s.messages[b.messageId]?.let { m -> s = s.copy(messages = s.messages + (m.id to m.copy(content = m.content + b.delta))) }
        is EventBody.MessageCompleted -> {
            s.messages[b.messageId]?.let { m -> s = s.copy(messages = s.messages + (m.id to m.copy(status = b.status))) }
            s = s.touch(b.conversationId, ev.at, null)
        }
        is EventBody.ToolCalled -> s.messages[b.messageId]?.let { m ->
            s = s.copy(messages = s.messages + (m.id to m.copy(toolCalls = (m.toolCalls ?: emptyList()).filter { it.id != b.call.id } + b.call)))
        }
        is EventBody.ToolResult -> s = s.copy(toolResults = s.toolResults + (b.messageId to ((s.toolResults[b.messageId] ?: emptyMap()) + (b.toolCallId to ToolOutcome(b.ok, b.summary)))))
        is EventBody.DeviceActionRequested -> s = s.copy(pendingActions = s.pendingActions + (b.action.id to b.action))
        is EventBody.DeviceActionDone -> s = s.copy(pendingActions = s.pendingActions - b.actionId)
        is EventBody.TaskProgress -> s = s.copy(progress = s.progress + (b.messageId to Progress(b.step, b.total, b.label)))
    }
    return s
}

private fun AssistantState.touch(conversationId: String, at: Long, deviceId: String?): AssistantState {
    val c = conversations[conversationId] ?: return this
    return copy(conversations = conversations + (c.id to c.copy(updatedAt = maxOf(c.updatedAt, at), lastDeviceId = deviceId ?: c.lastDeviceId)))
}

fun AssistantState.applyAll(events: List<Event>): AssistantState = events.fold(this) { acc, e -> acc.apply(e) }
