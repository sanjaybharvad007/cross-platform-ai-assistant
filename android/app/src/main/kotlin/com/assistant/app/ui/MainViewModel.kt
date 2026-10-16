package com.assistant.app.ui

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.assistant.app.AssistantApp
import com.assistant.core.AssistantState
import com.assistant.core.ConnState
import com.assistant.core.Device
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch

class MainViewModel(app: Application) : AndroidViewModel(app) {
    private val container = app as AssistantApp
    private val prefs = container.prefs
    private val sync = container.sync

    val state: StateFlow<AssistantState> = sync.state
    val conn: StateFlow<ConnState> = sync.conn
    val devices: StateFlow<List<Device>> = sync.devices
    val outboxSize: StateFlow<Int> = sync.outboxSize
    val deviceId: String? get() = prefs.deviceId

    private val _signedIn = MutableStateFlow(prefs.isSignedIn)
    val signedIn: StateFlow<Boolean> = _signedIn.asStateFlow()
    private val _selected = MutableStateFlow<String?>(null)
    val selected: StateFlow<String?> = _selected.asStateFlow()
    private val _pairCode = MutableStateFlow<String?>(null)
    val pairCode: StateFlow<String?> = _pairCode.asStateFlow()
    private val _error = MutableStateFlow<String?>(null)
    val error: StateFlow<String?> = _error.asStateFlow()
    val serverUrl: String get() = prefs.serverUrl
    val deviceName: String get() = prefs.deviceName

    /** clientMsgId of a message sent into a brand-new conversation: adopt that conversation once the server creates it. */
    private var pendingNewClientMsgId: String? = null
    init {
        viewModelScope.launch {
            state.collect { s ->
                val id = pendingNewClientMsgId ?: return@collect
                s.messages.values.firstOrNull { it.clientMsgId == id }?.let { _selected.value = it.conversationId; pendingNewClientMsgId = null }
            }
        }
    }

    fun register(name: String, server: String, pairCode: String?) = viewModelScope.launch {
        _error.value = null
        try {
            prefs.serverUrl = server
            val r = container.api.registerDevice(name, pairCode?.takeIf { it.length == 6 })
            prefs.token = r.token; prefs.deviceId = r.deviceId; prefs.userId = r.userId; prefs.deviceName = name
            _signedIn.value = true
            sync.connect()
        } catch (e: Exception) { _error.value = e.message ?: "registration failed" }
    }

    fun select(id: String?) { _selected.value = id }
    fun send(text: String) = viewModelScope.launch {
        if (text.isBlank()) return@launch
        val conv = _selected.value?.takeIf { it != NEW }
        val clientMsgId = sync.send(text, conv)
        if (conv == null) pendingNewClientMsgId = clientMsgId
    }
    fun cancel() = viewModelScope.launch { _selected.value?.takeIf { it != NEW }?.let { sync.cancel(it) } }
    fun requestPairCode() = viewModelScope.launch { runCatching { container.api.pairCode(prefs.token!!) }.onSuccess { _pairCode.value = it.code }.onFailure { _error.value = it.message } }
    fun dismissPairCode() { _pairCode.value = null }
    fun dismissError() { _error.value = null }
    fun signOut() = viewModelScope.launch { sync.signOut(); _signedIn.value = false; _selected.value = null }
    fun onForeground() { if (prefs.isSignedIn) sync.connect() }
}
