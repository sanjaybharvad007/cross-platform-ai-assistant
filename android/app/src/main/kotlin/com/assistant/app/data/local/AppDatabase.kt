package com.assistant.app.data.local

import android.content.Context
import androidx.room.Dao
import androidx.room.Database
import androidx.room.Entity
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.PrimaryKey
import androidx.room.Query
import androidx.room.Room
import androidx.room.RoomDatabase
import kotlinx.coroutines.flow.Flow

/**
 * Local cache of the projected state so the app opens instantly and works
 * offline.  The event log stays on the server; we store the projection plus
 * the cursor (`seq`) needed to resume, and the outbox of unsent messages.
 */
@Entity(tableName = "conversations")
data class ConversationEntity(@PrimaryKey val id: String, val title: String, val createdAt: Long, val updatedAt: Long, val lastDeviceId: String?, val archived: Boolean)

@Entity(tableName = "messages")
data class MessageEntity(
    @PrimaryKey val id: String, val conversationId: String, val role: String, val content: String,
    val toolCallsJson: String?, val toolCallId: String?, val deviceId: String?, val clientMsgId: String?, val status: String, val createdAt: Long, val position: Int,
)

@Entity(tableName = "outbox")
data class OutboxEntity(@PrimaryKey val clientMsgId: String, val conversationId: String?, val text: String, val at: Long)

@Entity(tableName = "sync_state")
data class SyncStateEntity(@PrimaryKey val id: Int = 1, val seq: Long)

@Dao
interface AssistantDao {
    @Query("SELECT * FROM conversations WHERE archived = 0 ORDER BY updatedAt DESC") fun conversations(): Flow<List<ConversationEntity>>
    @Query("SELECT * FROM conversations") suspend fun allConversations(): List<ConversationEntity>
    @Query("SELECT * FROM messages WHERE conversationId = :id ORDER BY position") fun messages(id: String): Flow<List<MessageEntity>>
    @Query("SELECT * FROM messages ORDER BY conversationId, position") suspend fun allMessages(): List<MessageEntity>
    @Query("SELECT * FROM outbox ORDER BY at") suspend fun outbox(): List<OutboxEntity>
    @Query("SELECT seq FROM sync_state WHERE id = 1") suspend fun seq(): Long?
    @Insert(onConflict = OnConflictStrategy.REPLACE) suspend fun upsertConversations(c: List<ConversationEntity>)
    @Insert(onConflict = OnConflictStrategy.REPLACE) suspend fun upsertMessages(m: List<MessageEntity>)
    @Insert(onConflict = OnConflictStrategy.REPLACE) suspend fun replaceOutbox(o: List<OutboxEntity>)
    @Insert(onConflict = OnConflictStrategy.REPLACE) suspend fun setSeq(s: SyncStateEntity)
    @Query("DELETE FROM conversations WHERE id NOT IN (:keep)") suspend fun pruneConversations(keep: List<String>)
    @Query("DELETE FROM messages WHERE id NOT IN (:keep)") suspend fun pruneMessages(keep: List<String>)
    @Query("DELETE FROM outbox") suspend fun clearOutbox()
    @Query("DELETE FROM conversations") suspend fun clearConversations()
    @Query("DELETE FROM messages") suspend fun clearMessages()
}

@Database(entities = [ConversationEntity::class, MessageEntity::class, OutboxEntity::class, SyncStateEntity::class], version = 1, exportSchema = true)
abstract class AppDatabase : RoomDatabase() {
    abstract fun dao(): AssistantDao
    companion object {
        fun open(context: Context): AppDatabase = Room.databaseBuilder(context, AppDatabase::class.java, "assistant.db").fallbackToDestructiveMigration().build()
    }
}
