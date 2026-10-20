package com.freesia.app.service

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat
import com.freesia.app.Graph
import com.freesia.app.R
import com.freesia.app.core.ActiveWork
import com.freesia.app.ui.MainActivity
import java.io.Closeable
import java.util.concurrent.TimeUnit

/** Keeps user requested dictation active after the microphone has stopped. */
class TranscriptionService : Service() {
    private var wakeLock: PowerManager.WakeLock? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        wakeLock = getSystemService(PowerManager::class.java)
            .newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "Freesia:transcription")
            .apply { setReferenceCounted(false) }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        // A very fast request can finish before Android dispatches its start intent.
        if (!work.hasActiveWork) {
            stopSelf(startId)
            return START_NOT_STICKY
        }
        try {
            val manager = getSystemService(NotificationManager::class.java)
            manager.createNotificationChannel(NotificationChannel(
                CHANNEL, getString(R.string.notif_channel), NotificationManager.IMPORTANCE_LOW,
            ).apply { setShowBadge(false) })
            val open = PendingIntent.getActivity(this, 0, Intent(this, MainActivity::class.java),
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
            val notification = NotificationCompat.Builder(this, CHANNEL)
                .setSmallIcon(R.drawable.ic_notif_bloom)
                .setContentTitle(getString(R.string.notif_transcribing))
                .setContentText(getString(R.string.notif_transcribing_body))
                .setContentIntent(open)
                .setOngoing(true).setSilent(true)
                .setCategory(NotificationCompat.CATEGORY_SERVICE)
                .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
                .build()
            ServiceCompat.startForeground(this, NOTIFICATION_ID, notification,
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC else 0)
            // A foreground service protects process priority but does not keep the CPU awake.
            // Bound the lock even if a vendor/network implementation never returns.
            wakeLock?.acquire(TimeUnit.MINUTES.toMillis(10))
        } catch (e: Exception) {
            Graph.reporter.warn("fgs:transcription", "Android could not keep dictation active", e)
            stopSelf()
        }
        return START_NOT_STICKY
    }

    override fun onTimeout(startId: Int, fgsType: Int) {
        Graph.reporter.warn("fgs:transcription", "Android ended the transcription service")
        Graph.dictation.cancel()
        stopSelf()
    }

    override fun onDestroy() {
        wakeLock?.let { if (it.isHeld) it.release() }
        wakeLock = null
        super.onDestroy()
    }

    companion object {
        private const val CHANNEL = "dictation"
        private const val NOTIFICATION_ID = 8
        private val work = ActiveWork()
        private val lock = Any()

        /** Only for a live dictation or a retry the user starts, never automatic recovery. */
        fun begin(context: Context): Closeable = synchronized(lock) {
            val app = context.applicationContext
            val id = work.acquire()
            try {
                ContextCompat.startForegroundService(app, Intent(app, TranscriptionService::class.java))
            } catch (e: Exception) {
                Graph.reporter.warn("fgs:transcription", "Android could not start transcription protection", e)
            }
            Closeable {
                synchronized(lock) {
                    if (work.release(id)) app.stopService(Intent(app, TranscriptionService::class.java))
                }
            }
        }
    }
}
