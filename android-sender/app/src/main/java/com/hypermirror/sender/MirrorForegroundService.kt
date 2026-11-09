package com.hypermirror.sender

import android.app.Activity
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.media.projection.MediaProjection
import android.media.projection.MediaProjectionManager
import android.net.wifi.WifiManager
import android.os.Binder
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.PowerManager
import android.util.DisplayMetrics
import android.util.Log
import android.view.WindowManager
import androidx.core.app.NotificationCompat
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow

class MirrorForegroundService : Service() {

    companion object {
        private const val TAG = "MirrorForegroundService"
        const val ACTION_START = "com.hypermirror.sender.ACTION_START"
        const val ACTION_STOP = "com.hypermirror.sender.ACTION_STOP"
        const val EXTRA_RESULT_CODE = "extra_result_code"
        const val EXTRA_RESULT_DATA = "extra_result_data"
        const val EXTRA_CONFIG = "extra_config"

        private const val NOTIFICATION_CHANNEL_ID = "hypermirror_low_latency_channel"
        private const val NOTIFICATION_ID = 2718

        private val _telemetryFlow = MutableStateFlow(StreamTelemetry())
        val telemetryFlow: StateFlow<StreamTelemetry> = _telemetryFlow

        private val _isRunningFlow = MutableStateFlow(false)
        val isRunningFlow: StateFlow<Boolean> = _isRunningFlow
    }

    inner class LocalBinder : Binder() {
        fun getService(): MirrorForegroundService = this@MirrorForegroundService
    }

    private val binder = LocalBinder()
    private var mediaProjection: MediaProjection? = null
    private var encoder: LowLatencyEncoder? = null
    private var transport: StreamTransport? = null
    private var wakeLock: PowerManager.WakeLock? = null
    private var wifiLock: WifiManager.WifiLock? = null

    override fun onBind(intent: Intent?): IBinder = binder

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_START -> {
                val resultCode = intent.getIntExtra(EXTRA_RESULT_CODE, Activity.RESULT_CANCELED)
                val resultData: Intent? = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                    intent.getParcelableExtra(EXTRA_RESULT_DATA, Intent::class.java)
                } else {
                    @Suppress("DEPRECATION")
                    intent.getParcelableExtra(EXTRA_RESULT_DATA)
                }
                val config: MirrorConfig = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                    intent.getSerializableExtra(EXTRA_CONFIG, MirrorConfig::class.java) ?: MirrorConfig()
                } else {
                    @Suppress("DEPRECATION")
                    (intent.getSerializableExtra(EXTRA_CONFIG) as? MirrorConfig) ?: MirrorConfig()
                }

                if (resultData != null && resultCode == Activity.RESULT_OK) {
                    startMirrorSessionSafely(resultCode, resultData, config)
                } else {
                    stopSelf()
                }
            }
            ACTION_STOP -> {
                stopMirrorSession()
                stopSelf()
            }
            else -> {
                stopSelf()
            }
        }
        return START_NOT_STICKY
    }

    private fun startMirrorSessionSafely(resultCode: Int, resultData: Intent, config: MirrorConfig) {
        try {
            stopMirrorSession()
            createNotificationChannel()
            val notification = buildNotification(config)

            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                startForeground(
                    NOTIFICATION_ID,
                    notification,
                    ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION
                )
            } else {
                startForeground(NOTIFICATION_ID, notification)
            }

            acquireLowLatencyLocks()

            val projectionManager = getSystemService(Context.MEDIA_PROJECTION_SERVICE) as MediaProjectionManager
            val projection = projectionManager.getMediaProjection(resultCode, resultData)
            if (projection == null) {
                Log.e(TAG, "MediaProjection returned null")
                stopMirrorSession()
                stopSelf()
                return
            }

            projection.registerCallback(object : MediaProjection.Callback() {
                override fun onStop() {
                    stopMirrorSession()
                    stopSelf()
                }
            }, Handler(Looper.getMainLooper()))
            mediaProjection = projection

            val wm = getSystemService(Context.WINDOW_SERVICE) as WindowManager
            val metrics = DisplayMetrics()
            @Suppress("DEPRECATION")
            wm.defaultDisplay.getRealMetrics(metrics)

            var currentClientAddr = "-"
            var isConnected = false

            val streamTransport = StreamTransport(
                config = config,
                onRequestSyncFrame = { encoder?.requestInstantSyncFrame() },
                onDynamicBitrateChange = { newBps -> encoder?.updateDynamicBitrate(newBps) },
                onConnectionStateChanged = { connected, addr ->
                    isConnected = connected
                    currentClientAddr = addr
                    _telemetryFlow.value = _telemetryFlow.value.copy(
                        connected = connected,
                        clientAddress = addr
                    )
                }
            )
            transport = streamTransport

            val hwEncoder = LowLatencyEncoder(
                mediaProjection = projection,
                displayMetrics = metrics,
                config = config,
                transport = streamTransport,
                onStatsUpdated = { fps, bitrateKbps, avgEncodeUs, totalFrames ->
                    _telemetryFlow.value = StreamTelemetry(
                        connected = isConnected,
                        clientAddress = currentClientAddr,
                        currentFps = fps,
                        currentBitrateKbps = bitrateKbps,
                        avgEncodeTimeUs = avgEncodeUs,
                        rttLatencyMs = streamTransport.latestRttMs,
                        sentFrames = totalFrames,
                        droppedFrames = streamTransport.droppedFrames.get()
                    )
                }
            )
            encoder = hwEncoder

            if (hwEncoder.start()) {
                streamTransport.start(hwEncoder.encodedWidth, hwEncoder.encodedHeight)
                _isRunningFlow.value = true
            } else {
                Log.e(TAG, "Hardware encoder failed all configuration tiers")
                stopMirrorSession()
                stopSelf()
            }
        } catch (e: Exception) {
            Log.e(TAG, "Error starting mirror session", e)
            stopMirrorSession()
            stopSelf()
        }
    }

    fun updateLiveBitrateMbps(mbps: Int) {
        encoder?.updateDynamicBitrate(mbps * 1_000_000)
    }

    fun requestKeyFrameNow() {
        encoder?.requestInstantSyncFrame()
    }

    private fun acquireLowLatencyLocks() {
        try {
            val pm = applicationContext.getSystemService(Context.POWER_SERVICE) as PowerManager
            wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "HyperMirror::GamingEncodeWakeLock").apply {
                setReferenceCounted(false)
                acquire(4 * 60 * 60 * 1000L)
            }

            val wm = applicationContext.getSystemService(Context.WIFI_SERVICE) as WifiManager
            val wifiLockMode = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                WifiManager.WIFI_MODE_FULL_LOW_LATENCY
            } else {
                @Suppress("DEPRECATION")
                WifiManager.WIFI_MODE_FULL_HIGH_PERF
            }
            wifiLock = wm.createWifiLock(wifiLockMode, "HyperMirror::GamingLowLatencyWifiLock").apply {
                setReferenceCounted(false)
                acquire()
            }
        } catch (_: Exception) {
        }
    }

    private fun releaseLowLatencyLocks() {
        try {
            if (wakeLock?.isHeld == true) wakeLock?.release()
        } catch (_: Exception) {
        }
        wakeLock = null

        try {
            if (wifiLock?.isHeld == true) wifiLock?.release()
        } catch (_: Exception) {
        }
        wifiLock = null
    }

    fun stopMirrorSession() {
        _isRunningFlow.value = false
        try {
            encoder?.stop()
        } catch (_: Exception) {
        }
        encoder = null
        try {
            transport?.stop()
        } catch (_: Exception) {
        }
        transport = null
        try {
            mediaProjection?.stop()
        } catch (_: Exception) {
        }
        mediaProjection = null
        releaseLowLatencyLocks()
        _telemetryFlow.value = StreamTelemetry()
    }

    override fun onDestroy() {
        stopMirrorSession()
        super.onDestroy()
    }

    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                NOTIFICATION_CHANNEL_ID,
                "HyperMirror Low-Latency Engine",
                NotificationManager.IMPORTANCE_LOW
            ).apply {
                description = "Duy trì kết nối truyền màn hình độ trễ thấp khi đang chơi game"
            }
            val nm = getSystemService(NotificationManager::class.java)
            nm.createNotificationChannel(channel)
        }
    }

    private fun buildNotification(config: MirrorConfig): Notification {
        val openIntent = Intent(this, MainActivity::class.java)
        val pendingOpen = PendingIntent.getActivity(
            this,
            0,
            openIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        val stopIntent = Intent(this, MirrorForegroundService::class.java).apply {
            action = ACTION_STOP
        }
        val pendingStop = PendingIntent.getService(
            this,
            1,
            stopIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        return NotificationCompat.Builder(this, NOTIFICATION_CHANNEL_ID)
            .setSmallIcon(android.R.drawable.presence_video_online)
            .setContentTitle("HyperMirror • ${config.fps} FPS (${config.codec.name})")
            .setContentText("Bitrate: ${config.bitrateMbps} Mbps • Zero-Latency Mode Active")
            .setContentIntent(pendingOpen)
            .setOngoing(true)
            .addAction(android.R.drawable.ic_media_pause, "Dừng phát", pendingStop)
            .build()
    }
}
