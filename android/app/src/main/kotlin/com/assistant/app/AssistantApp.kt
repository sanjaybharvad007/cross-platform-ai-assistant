package com.assistant.app

import android.app.Application
import android.app.NotificationChannel
import android.app.NotificationManager
import androidx.lifecycle.DefaultLifecycleObserver
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.ProcessLifecycleOwner
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import com.assistant.app.data.Prefs
import com.assistant.app.data.local.AppDatabase
import com.assistant.app.data.remote.ApiClient
import com.assistant.app.sync.SyncRepository
import com.assistant.app.sync.SyncWorker
import okhttp3.OkHttpClient
import java.util.concurrent.TimeUnit

/** Manual dependency container: small enough that a DI framework would add more than it removes. */
class AssistantApp : Application() {
    lateinit var prefs: Prefs; private set
    lateinit var http: OkHttpClient; private set
    lateinit var api: ApiClient; private set
    lateinit var db: AppDatabase; private set
    lateinit var sync: SyncRepository; private set

    override fun onCreate() {
        super.onCreate()
        prefs = Prefs(this)
        http = OkHttpClient.Builder().pingInterval(25, TimeUnit.SECONDS).readTimeout(0, TimeUnit.MILLISECONDS).build()
        api = ApiClient(http) { prefs.serverUrl }
        db = AppDatabase.open(this)
        sync = SyncRepository(this, prefs, api, http, db)
        getSystemService(NotificationManager::class.java).createNotificationChannel(
            NotificationChannel(CHANNEL_ID, getString(R.string.notification_channel), NotificationManager.IMPORTANCE_DEFAULT),
        )
        // Keep the live socket only while the app is visible; WorkManager catches up in the background.
        ProcessLifecycleOwner.get().lifecycle.addObserver(object : DefaultLifecycleObserver {
            override fun onStart(owner: LifecycleOwner) { if (prefs.isSignedIn) sync.connect() }
            override fun onStop(owner: LifecycleOwner) { sync.disconnect() }
        })
        WorkManager.getInstance(this).enqueueUniquePeriodicWork(
            SyncWorker.NAME, ExistingPeriodicWorkPolicy.KEEP,
            PeriodicWorkRequestBuilder<SyncWorker>(15, TimeUnit.MINUTES).setConstraints(SyncWorker.constraints()).build(),
        )
    }

    companion object { const val CHANNEL_ID = "assistant.updates" }
}
