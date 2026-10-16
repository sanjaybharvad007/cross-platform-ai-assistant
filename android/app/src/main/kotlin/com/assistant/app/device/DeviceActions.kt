package com.assistant.app.device

import android.Manifest
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.location.Location
import android.location.LocationManager
import android.net.Uri
import android.os.Build
import android.provider.AlarmClock
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import com.assistant.app.AssistantApp
import com.assistant.app.R
import com.assistant.core.DeviceAction
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonPrimitive
import kotlin.coroutines.resume

/**
 * Tool calls the model routed to this phone.  Each one maps to a platform
 * intent or API; results are reported back through the sync engine so the
 * agent loop (and every other device) sees what happened.
 */
object DeviceActions {
    data class Outcome(val ok: Boolean, val result: JsonElement)

    suspend fun run(context: Context, a: DeviceAction): Outcome = withContext(Dispatchers.Main) {
        val args = a.arguments
        fun str(k: String) = args[k]?.jsonPrimitive?.content
        fun int(k: String, d: Int) = args[k]?.jsonPrimitive?.intOrNull ?: d
        try {
            when (a.name) {
                "set_alarm" -> {
                    val i = Intent(AlarmClock.ACTION_SET_ALARM).putExtra(AlarmClock.EXTRA_HOUR, int("hour", 7)).putExtra(AlarmClock.EXTRA_MINUTES, int("minute", 0))
                        .putExtra(AlarmClock.EXTRA_MESSAGE, str("label") ?: "Assistant").putExtra(AlarmClock.EXTRA_SKIP_UI, true).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                    if (i.resolveActivity(context.packageManager) == null) return@withContext fail("no clock app")
                    context.startActivity(i); ok("scheduled" to JsonPrimitive(true))
                }
                "open_url" -> { context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(str("url"))).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)); ok("opened" to JsonPrimitive(str("url") ?: "")) }
                "share_text" -> { context.startActivity(Intent.createChooser(Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_TEXT, str("text")), null).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)); ok("shared" to JsonPrimitive(true)) }
                "copy_to_clipboard" -> { context.getSystemService(ClipboardManager::class.java).setPrimaryClip(ClipData.newPlainText("assistant", str("text"))); ok("copied" to JsonPrimitive(true)) }
                "notify" -> {
                    if (ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) return@withContext fail("notification permission not granted")
                    NotificationManagerCompat.from(context).notify(a.id.hashCode(), NotificationCompat.Builder(context, AssistantApp.CHANNEL_ID).setSmallIcon(R.drawable.ic_launcher_foreground)
                        .setContentTitle(str("title") ?: "Assistant").setContentText(str("body")).setAutoCancel(true).build())
                    ok("shown" to JsonPrimitive(true))
                }
                "get_location" -> location(context)
                else -> fail("unsupported on this device")
            }
        } catch (e: Exception) { fail(e.message ?: e.javaClass.simpleName) }
    }

    private suspend fun location(context: Context): Outcome {
        val granted = listOf(Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION).any { ContextCompat.checkSelfPermission(context, it) == PackageManager.PERMISSION_GRANTED }
        if (!granted) return fail("location permission not granted")
        val lm = context.getSystemService(LocationManager::class.java)
        val provider = listOf(LocationManager.GPS_PROVIDER, LocationManager.NETWORK_PROVIDER).firstOrNull { lm.isProviderEnabled(it) } ?: return fail("location disabled")
        val loc: Location = withTimeoutOrNull(10_000) {
            suspendCancellableCoroutine<Location?> { cont ->
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                    lm.getCurrentLocation(provider, null, context.mainExecutor) { cont.resume(it) }
                } else {
                    cont.resume(lm.getLastKnownLocation(provider))
                }
            }
        } ?: return fail("location timeout")
        return ok("lat" to JsonPrimitive(loc.latitude), "lon" to JsonPrimitive(loc.longitude), "accuracy" to JsonPrimitive(loc.accuracy))
    }

    private fun ok(vararg kv: Pair<String, JsonElement>) = Outcome(true, buildJsonObject { kv.forEach { (k, v) -> put(k, v) } })
    private fun fail(reason: String) = Outcome(false, buildJsonObject { put("error", JsonPrimitive(reason)) })
}
