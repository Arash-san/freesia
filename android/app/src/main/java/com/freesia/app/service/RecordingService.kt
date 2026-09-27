package com.freesia.app.service

import com.freesia.app.Graph
import com.freesia.app.R
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat

/**
 * A short-lived `microphone` foreground service that runs only while a take is
 * being recorded. It keeps the microphone capability if the screen turns off
 * mid-dictation and shows the ongoing "Listening" notification with a Stop action.
 *
 * Recording itself does not depend on it: the accessibility service process
 * already holds the while-in-use microphone capability (the system binds it with
 * BIND_INCLUDE_CAPABILITIES), so any failure to promote is ignored.
 */
class RecordingService : Service() {
    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP_DICTATION) {
            Graph.dictation.stop()
            return START_NOT_STICKY
        }
        try {
            ServiceCompat.startForeground(
                this, NOTIFICATION_ID, buildNotification(),
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE else 0,
            )
        } catch (e: Exception) {
            // Not eligible right now (OEM restriction etc.): recording continues without it.
            Graph.reporter.warn("fgs", "The microphone foreground service could not start", e)
            stopSelf()
        }
        return START_NOT_STICKY
    }

    private fun buildNotification(): Notification {
        val nm = getSystemService(NotificationManager::class.java)
        nm.createNotificationChannel(
            NotificationChannel(CHANNEL, getString(R.string.notif_channel), NotificationManager.IMPORTANCE_LOW).apply {
                setShowBadge(false)
            },
        )
        val stop = PendingIntent.getService(
            this, 1, Intent(this, RecordingService::class.java).setAction(ACTION_STOP_DICTATION),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        return NotificationCompat.Builder(this, CHANNEL)
            .setSmallIcon(R.drawable.ic_notif_bloom)
            .setContentTitle(getString(R.string.notif_listening))
            .setContentText(getString(R.string.notif_listening_body))
            .setOngoing(true)
            .setSilent(true)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
            .addAction(0, getString(R.string.notif_stop), stop)
            .build()
    }

    companion object {
        private const val CHANNEL = "dictation"
        private const val NOTIFICATION_ID = 7
        private const val ACTION_STOP_DICTATION = "com.freesia.app.STOP_DICTATION"

        /** Best effort: plain startService (not startForegroundService) so a refusal can never crash the app. */
        fun start(context: Context) {
            try { context.startService(Intent(context, RecordingService::class.java)) } catch (e: Exception) { }
        }

        fun stop(context: Context) {
            try { context.stopService(Intent(context, RecordingService::class.java)) } catch (e: Exception) { }
        }
    }
}
