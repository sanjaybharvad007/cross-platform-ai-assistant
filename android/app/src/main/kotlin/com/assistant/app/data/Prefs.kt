package com.assistant.app.data

import android.content.Context
import com.assistant.app.BuildConfig

/** Device identity and server address. Excluded from backups (see res/xml). */
class Prefs(context: Context) {
    private val sp = context.getSharedPreferences("assistant_prefs", Context.MODE_PRIVATE)
    var serverUrl: String
        get() = sp.getString("server", BuildConfig.DEFAULT_SERVER)!!.trimEnd('/')
        set(v) = sp.edit().putString("server", v.trimEnd('/')).apply()
    var token: String? get() = sp.getString("token", null); set(v) = sp.edit().putString("token", v).apply()
    var deviceId: String? get() = sp.getString("deviceId", null); set(v) = sp.edit().putString("deviceId", v).apply()
    var userId: String? get() = sp.getString("userId", null); set(v) = sp.edit().putString("userId", v).apply()
    var deviceName: String get() = sp.getString("deviceName", android.os.Build.MODEL)!!; set(v) = sp.edit().putString("deviceName", v).apply()
    val isSignedIn get() = token != null && deviceId != null
    fun clear() = sp.edit().clear().apply()
}
