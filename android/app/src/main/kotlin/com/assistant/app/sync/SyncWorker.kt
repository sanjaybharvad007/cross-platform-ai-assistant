package com.assistant.app.sync

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.NetworkType
import androidx.work.WorkerParameters
import com.assistant.app.AssistantApp
import com.assistant.app.R

/**
 * Periodic background sync: pulls events the phone missed while closed and
 * pushes anything queued offline, then notifies about assistant replies that
 * finished while the user was away (e.g. a task started from the laptop).
 */
class SyncWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {
    override suspend fun doWork(): Result {
        val app = applicationContext as AssistantApp
        if (!app.prefs.isSignedIn) return Result.success()
        val before = app.sync.state.value
        val changed = runCatching { app.sync.catchUp() }.getOrElse { return Result.retry() }
        if (changed) {
            val after = app.sync.state.value
            val newlyCompleted = after.messages.values.filter { it.role == "assistant" && it.status == "complete" && before.messages[it.id]?.status != "complete" }
            if (newlyCompleted.isNotEmpty() && ContextCompat.checkSelfPermission(applicationContext, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED) {
                val m = newlyCompleted.maxBy { it.createdAt }
                NotificationManagerCompat.from(applicationContext).notify(m.id.hashCode(), NotificationCompat.Builder(applicationContext, AssistantApp.CHANNEL_ID)
                    .setSmallIcon(R.drawable.ic_launcher_foreground).setContentTitle(after.conversations[m.conversationId]?.title ?: "Assistant")
                    .setContentText(m.content.take(120)).setStyle(NotificationCompat.BigTextStyle().bigText(m.content.take(600))).setAutoCancel(true).build())
            }
        }
        return Result.success()
    }

    companion object {
        const val NAME = "assistant-sync"
        fun constraints() = Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build()
    }
}
