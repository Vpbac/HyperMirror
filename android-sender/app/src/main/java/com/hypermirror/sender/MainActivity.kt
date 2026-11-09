package com.hypermirror.sender

import android.app.Activity
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.ServiceConnection
import android.media.projection.MediaProjectionManager
import android.os.Build
import android.os.Bundle
import android.os.IBinder
import android.widget.SeekBar
import android.widget.Toast
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import androidx.lifecycle.lifecycleScope
import com.hypermirror.sender.databinding.ActivityMainBinding
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.launch
import java.net.NetworkInterface
import java.util.Locale

class MainActivity : AppCompatActivity() {

    private lateinit var binding: ActivityMainBinding
    private var mirrorService: MirrorForegroundService? = null
    private var serviceBound = false

    private val serviceConnection = object : ServiceConnection {
        override fun onServiceConnected(name: ComponentName?, service: IBinder?) {
            val binder = service as? MirrorForegroundService.LocalBinder
            mirrorService = binder?.getService()
            serviceBound = true
        }

        override fun onServiceDisconnected(name: ComponentName?) {
            mirrorService = null
            serviceBound = false
        }
    }

    private val capturePermissionLauncher = registerForActivityResult(
        ActivityResultContracts.StartActivityForResult()
    ) { result ->
        if (result.resultCode == Activity.RESULT_OK && result.data != null) {
            val config = buildMirrorConfigFromUi()
            val intent = Intent(this, MirrorForegroundService::class.java).apply {
                action = MirrorForegroundService.ACTION_START
                putExtra(MirrorForegroundService.EXTRA_RESULT_CODE, result.resultCode)
                putExtra(MirrorForegroundService.EXTRA_RESULT_DATA, result.data)
                putExtra(MirrorForegroundService.EXTRA_CONFIG, config)
            }
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                startForegroundService(intent)
            } else {
                startService(intent)
            }
        } else {
            Toast.makeText(this, "Bạn cần cấp quyền quay màn hình để phát luồng", Toast.LENGTH_SHORT).show()
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivityMainBinding.inflate(layoutInflater)
        setContentView(binding.root)

        binding.tvDeviceIp.text = "IP Thiết bị: ${getDeviceWifiIp()} • Cổng TCP: 27183"

        setupUiListeners()
        observeTelemetry()
    }

    override fun onStart() {
        super.onStart()
        Intent(this, MirrorForegroundService::class.java).also { intent ->
            bindService(intent, serviceConnection, Context.BIND_AUTO_CREATE)
        }
    }

    override fun onStop() {
        super.onStop()
        if (serviceBound) {
            unbindService(serviceConnection)
            serviceBound = false
        }
    }

    private fun setupUiListeners() {
        binding.sbBitrate.setOnSeekBarChangeListener(object : SeekBar.OnSeekBarChangeListener {
            override fun onProgressChanged(seekBar: SeekBar?, progress: Int, fromUser: Boolean) {
                val mbps = progress.coerceAtLeast(2)
                binding.tvBitrateLabel.text = "Bitrate (Đổi trực tiếp khi đang phát): $mbps Mbps"
                if (fromUser && MirrorForegroundService.isRunningFlow.value) {
                    mirrorService?.updateLiveBitrateMbps(mbps)
                }
            }

            override fun onStartTrackingTouch(seekBar: SeekBar?) {}
            override fun onStopTrackingTouch(seekBar: SeekBar?) {}
        })

        binding.btnToggleMirror.setOnClickListener {
            if (MirrorForegroundService.isRunningFlow.value) {
                val stopIntent = Intent(this, MirrorForegroundService::class.java).apply {
                    action = MirrorForegroundService.ACTION_STOP
                }
                startService(stopIntent)
            } else {
                val projectionManager =
                    getSystemService(Context.MEDIA_PROJECTION_SERVICE) as MediaProjectionManager
                capturePermissionLauncher.launch(projectionManager.createScreenCaptureIntent())
            }
        }

        binding.btnForceIdr.setOnClickListener {
            mirrorService?.requestKeyFrameNow()
            Toast.makeText(this, "Đã gửi khung hình IDR (KeyFrame) tức thì", Toast.LENGTH_SHORT).show()
        }
    }

    private fun observeTelemetry() {
        lifecycleScope.launch {
            MirrorForegroundService.isRunningFlow.collectLatest { running ->
                if (running) {
                    binding.btnToggleMirror.text = "DỪNG CHIẾU MÀN HÌNH"
                    binding.btnToggleMirror.backgroundTintList =
                        ContextCompat.getColorStateList(this@MainActivity, R.color.accent_red)
                } else {
                    binding.btnToggleMirror.text = "BẮT ĐẦU CHIẾU MÀN HÌNH (ZERO-LATENCY)"
                    binding.btnToggleMirror.backgroundTintList =
                        ContextCompat.getColorStateList(this@MainActivity, R.color.accent_cyan)
                }
            }
        }

        lifecycleScope.launch {
            MirrorForegroundService.telemetryFlow.collectLatest { stats ->
                val statusText = if (stats.connected) {
                    "ĐANG KẾT NỐI: ${stats.clientAddress}"
                } else if (MirrorForegroundService.isRunningFlow.value) {
                    "ĐANG CHỜ PC KẾT NỐI (:27183)..."
                } else {
                    "TRẠNG THÁI: SẴN SÀNG"
                }
                binding.tvConnectionStatus.text = statusText

                val mbps = stats.currentBitrateKbps / 1000.0
                val encodeMs = stats.avgEncodeTimeUs / 1000.0
                binding.tvTelemetryMetrics.text = String.format(
                    Locale.US,
                    "FPS: %d | Bitrate: %.1f Mbps | Frames: %d\nEncode DSP: %.2f ms | Network RTT: %.1f ms",
                    stats.currentFps,
                    mbps,
                    stats.sentFrames,
                    encodeMs,
                    stats.rttLatencyMs
                )
            }
        }
    }

    private fun buildMirrorConfigFromUi(): MirrorConfig {
        val transportMode = if (binding.rbUsbServer.isChecked) {
            TransportMode.USB_SERVER
        } else {
            TransportMode.CLIENT_CONNECT
        }

        val orientationMode = when {
            binding.rbOrientLandscape.isChecked -> OrientationMode.LANDSCAPE_GAME
            binding.rbOrientPortrait.isChecked -> OrientationMode.PORTRAIT
            else -> OrientationMode.AUTO_ROTATE
        }

        val codec = if (binding.rbH265.isChecked) {
            VideoCodecType.H265
        } else {
            VideoCodecType.H264
        }

        val fps = when {
            binding.rbFps120.isChecked -> 120
            binding.rbFps90.isChecked -> 90
            else -> 60
        }

        val maxDim = when {
            binding.rbRes720.isChecked -> 1280
            binding.rbRes1080.isChecked -> 1920
            binding.rbRes1440.isChecked -> 2560
            else -> 0
        }

        val bitrateMbps = binding.sbBitrate.progress.coerceAtLeast(2)
        val targetIp = binding.etTargetIp.text.toString().trim().ifEmpty { "127.0.0.1" }

        return MirrorConfig(
            codec = codec,
            transportMode = transportMode,
            orientationMode = orientationMode,
            targetHost = targetIp,
            targetPort = 27183,
            maxDimension = maxDim,
            fps = fps,
            bitrateMbps = bitrateMbps,
            intraRefreshSec = 1,
            ultraLowLatencyMode = true
        )
    }

    private fun getDeviceWifiIp(): String {
        return try {
            val interfaces = NetworkInterface.getNetworkInterfaces()
            for (intf in interfaces) {
                if (!intf.isUp || intf.isLoopback) continue
                for (addr in intf.inetAddresses) {
                    val host = addr.hostAddress ?: continue
                    if (!addr.isLoopbackAddress && host.indexOf(':') < 0) {
                        return host
                    }
                }
            }
            "127.0.0.1"
        } catch (_: Exception) {
            "127.0.0.1"
        }
    }
}
