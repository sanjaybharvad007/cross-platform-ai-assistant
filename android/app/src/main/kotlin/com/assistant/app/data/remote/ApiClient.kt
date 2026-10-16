package com.assistant.app.data.remote

import com.assistant.core.PairCodeResponse
import com.assistant.core.ProtocolJson
import com.assistant.core.RegisterDeviceRequest
import com.assistant.core.RegisterDeviceResponse
import com.assistant.core.SyncResponse
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.decodeFromString
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.io.IOException

/** REST client; the WebSocket lives in SyncRepository. */
class ApiClient(private val http: OkHttpClient, private val baseUrl: () -> String) {
    private val json = "application/json".toMediaType()

    suspend fun registerDevice(name: String, pairCode: String?): RegisterDeviceResponse =
        post("/auth/device", ProtocolJson.encodeToString(RegisterDeviceRequest(name = name, pairCode = pairCode)), null)

    suspend fun pairCode(token: String): PairCodeResponse = post("/auth/pair-code", "", token)

    suspend fun sync(token: String, since: Long): SyncResponse = get("/sync?since=$since", token)

    suspend fun sendMessage(token: String, conversationId: String?, clientMsgId: String, text: String): JsonObject =
        post("/conversations/${conversationId ?: "new"}/messages", Json.encodeToString(JsonObject.serializer(), buildBody(clientMsgId, text)), token)

    private fun buildBody(clientMsgId: String, text: String) = kotlinx.serialization.json.buildJsonObject {
        put("clientMsgId", kotlinx.serialization.json.JsonPrimitive(clientMsgId)); put("text", kotlinx.serialization.json.JsonPrimitive(text))
    }

    private suspend inline fun <reified T> get(path: String, token: String?): T = execute(Request.Builder().url(baseUrl() + path).also { if (token != null) it.header("Authorization", "Bearer $token") }.build())
    private suspend inline fun <reified T> post(path: String, body: String, token: String?): T = execute(
        Request.Builder().url(baseUrl() + path).post(body.toRequestBody(if (body.isEmpty()) null else json)).also { if (token != null) it.header("Authorization", "Bearer $token") }.build(),
    )

    private suspend inline fun <reified T> execute(req: Request): T = withContext(Dispatchers.IO) {
        http.newCall(req).execute().use { res ->
            val text = res.body?.string().orEmpty()
            if (!res.isSuccessful) {
                val msg = runCatching { ProtocolJson.parseToJsonElement(text).jsonObject["error"]?.jsonPrimitive?.content }.getOrNull()
                throw ApiException(res.code, msg ?: "HTTP ${res.code}")
            }
            ProtocolJson.decodeFromString<T>(text)
        }
    }
}

class ApiException(val code: Int, message: String) : IOException(message)
