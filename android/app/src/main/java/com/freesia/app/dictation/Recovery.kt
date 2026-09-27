package com.freesia.app.dictation

import com.freesia.app.Graph
import com.freesia.app.R
import com.freesia.app.ui.MainActivity
import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
import androidx.work.BackoffPolicy
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequest
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import java.util.concurrent.TimeUnit

/**
 * Background recovery of saved recordings whose failure looked temporary
 * (network down, timeout, server busy or restarting). WorkManager runs it once a
 * network is available, with exponential backoff, and it survives the app being
 * closed or the phone restarting.
 */
object RecoveryScheduler {
    const val UNIQUE_NAME = "freesia-recovery"
    /** Give the network or server a minute before the first background attempt. */
    const val DEFAULT_DELAY_MS = 60_000L
    const val BACKOFF_SECONDS = 30L
    /** After this many background runs a recording just waits in Saved recordings for a manual Retry. */
    const val MAX_RUNS = 10

    fun request(initialDelayMs: Long = DEFAULT_DELAY_MS): OneTimeWorkRequest =
        OneTimeWorkRequestBuilder<RecoveryWorker>()
            .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
            .setInitialDelay(initialDelayMs, TimeUnit.MILLISECONDS)
            .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, BACKOFF_SECONDS, TimeUnit.SECONDS)
            .addTag(UNIQUE_NAME)
            .build()

    /**
     * @param restart true after a new failure (the clock starts again from now);
     *   false at app start, to leave an already scheduled run alone
     */
    fun schedule(context: Context, initialDelayMs: Long = DEFAULT_DELAY_MS, restart: Boolean = true) {
        try {
            WorkManager.getInstance(context).enqueueUniqueWork(
                UNIQUE_NAME, if (restart) ExistingWorkPolicy.REPLACE else ExistingWorkPolicy.KEEP, request(initialDelayMs),
            )
        } catch (e: Exception) {
            Graph.reporter.warn("recovery:schedule", "Could not schedule a background retry", e)
        }
    }
}

class RecoveryWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {
    override suspend fun doWork(): Result {
        val remaining = Graph.dictation.recoverInBackground()
        return when {
            remaining == 0 -> Result.success()
            runAttemptCount + 1 >= RecoveryScheduler.MAX_RUNS -> Result.success()
            else -> Result.retry()
        }
    }
}

/** "Dictation recovered" notification for a background retry that worked. */
object RecoveryNotifier {
    private const val CHANNEL = "recovered"
    private const val ID = 11

    fun recovered(context: Context, count: Int) {
        if (Build.VERSION.SDK_INT >= 33 &&
            ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
        ) return
        val nm = context.getSystemService(NotificationManager::class.java) ?: return
        nm.createNotificationChannel(NotificationChannel(CHANNEL, context.getString(R.string.notif_channel_recovered), NotificationManager.IMPORTANCE_DEFAULT))
        val open = PendingIntent.getActivity(
            context, 2, MainActivity.savedRecordingsIntent(context),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        val n = NotificationCompat.Builder(context, CHANNEL)
            .setSmallIcon(R.drawable.ic_notif_bloom)
            .setContentTitle(if (count == 1) "Dictation recovered" else "$count dictations recovered")
            .setContentText("The text is on your clipboard and in History.")
            .setContentIntent(open)
            .setAutoCancel(true)
            .setCategory(NotificationCompat.CATEGORY_STATUS)
            .build()
        try { nm.notify(ID, n) } catch (e: SecurityException) { /* notifications turned off */ }
    }
}
