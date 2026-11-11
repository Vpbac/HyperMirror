package com.hypermirror.sender

import android.hardware.display.DisplayManager
import android.hardware.display.VirtualDisplay
import android.media.MediaCodec
import android.media.MediaCodecInfo
import android.media.MediaFormat
import android.media.projection.MediaProjection
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.Process
import android.util.DisplayMetrics
import android.util.Log
import android.view.Surface
import java.nio.ByteBuffer
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicLong
import kotlin.math.max
import kotlin.math.min

class LowLatencyEncoder(
    private val mediaProjection: MediaProjection,
    private val displayMetrics: DisplayMetrics,
    private val config: MirrorConfig,
    private val transport: StreamTransport,
    private val onStatsUpdated: (fps: Int, bitrateKbps: Int, avgEncodeUs: Long, totalFrames: Long) -> Unit
) {
    companion object {
        private const val TAG = "LowLatencyEncoder"
        private const val DEQUEUE_TIMEOUT_US = 10_000L
    }

    private val isEncoding = AtomicBoolean(false)
    private var codec: MediaCodec? = null
    private var inputSurface: Surface? = null
    private var virtualDisplay: VirtualDisplay? = null

    private val projectionCallback = object : MediaProjection.Callback() {
        override fun onStop() {
            Log.w(TAG, "MediaProjection session terminated by system or user")
            stop()
        }
    }

    var encodedWidth: Int = 1920
        private set
    var encodedHeight: Int = 1080
        private set
    var actualFps: Int = 60
        private set

    private val totalSentFrames = AtomicLong(0)

    init {
        val rawW = displayMetrics.widthPixels.coerceAtLeast(720)
        val rawH = displayMetrics.heightPixels.coerceAtLeast(720)

        val targetMax = if (config.maxDimension <= 0) max(rawW, rawH) else config.maxDimension
        val maxSide = max(rawW, rawH)
        val scale = if (maxSide > targetMax) {
            targetMax.toFloat() / maxSide.toFloat()
        } else {
            1.0f
        }
        val scaledA = align8((rawW * scale).toInt())
        val scaledB = align8((rawH * scale).toInt())

        when (config.orientationMode) {
            OrientationMode.LANDSCAPE_GAME -> {
                encodedWidth = max(scaledA, scaledB)
                encodedHeight = min(scaledA, scaledB)
            }
            OrientationMode.PORTRAIT -> {
                encodedWidth = min(scaledA, scaledB)
                encodedHeight = max(scaledA, scaledB)
            }
            OrientationMode.AUTO_ROTATE -> {
                encodedWidth = scaledA
                encodedHeight = scaledB
            }
        }
        actualFps = config.fps
    }

    private fun align8(value: Int): Int = max(256, (value / 8) * 8)

    fun start(): Boolean {
        if (isEncoding.getAndSet(true)) return true

        val mediaCodec = createConfiguredCodecSafely()
        if (mediaCodec == null) {
            isEncoding.set(false)
            return false
        }

        return try {
            codec = mediaCodec
            val surface = mediaCodec.createInputSurface()
            inputSurface = surface
            mediaCodec.start()

            // CRITICAL FOR ANDROID 14/15: Register MediaProjection.Callback before calling createVirtualDisplay.
            // Failure to do so throws IllegalStateException on Android 14+.
            val mainHandler = Handler(Looper.getMainLooper())
            try {
                mediaProjection.registerCallback(projectionCallback, mainHandler)
            } catch (e: Exception) {
                Log.w(TAG, "MediaProjection callback registration info: ${e.message}")
            }

            val virtualDisplayCallback = object : VirtualDisplay.Callback() {
                override fun onPaused() {
                    Log.d(TAG, "VirtualDisplay paused")
                }

                override fun onResumed() {
                    Log.d(TAG, "VirtualDisplay resumed - requesting instant sync frame")
                    requestInstantSyncFrame()
                }

                override fun onStopped() {
                    Log.d(TAG, "VirtualDisplay stopped")
                }
            }

            virtualDisplay = mediaProjection.createVirtualDisplay(
                "HyperMirror-ZeroLatency",
                encodedWidth,
                encodedHeight,
                displayMetrics.densityDpi,
                DisplayManager.VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR,
                surface,
                virtualDisplayCallback,
                mainHandler
            )

            Thread({
                try {
                    Process.setThreadPriority(Process.THREAD_PRIORITY_URGENT_DISPLAY)
                } catch (_: Exception) {
                }
                drainEncoderLoop(mediaCodec)
            }, "HyperMirror-EncoderDrain").start()

            true
        } catch (e: Exception) {
            Log.e(TAG, "Failed to start encoder or VirtualDisplay", e)
            stop()
            false
        }
    }

    private fun createConfiguredCodecSafely(): MediaCodec? {
        val primaryMime = config.codec.mimeType
        val mimesToTry = if (primaryMime == MediaFormat.MIMETYPE_VIDEO_HEVC) {
            listOf(MediaFormat.MIMETYPE_VIDEO_HEVC, MediaFormat.MIMETYPE_VIDEO_AVC)
        } else {
            listOf(MediaFormat.MIMETYPE_VIDEO_AVC)
        }

        val isLandscape = encodedWidth >= encodedHeight
        val res1080W = if (isLandscape) 1920 else 1080
        val res1080H = if (isLandscape) 1080 else 1920
        val res720W = if (isLandscape) 1280 else 720
        val res720H = if (isLandscape) 720 else 1280

        for (mime in mimesToTry) {
            // Tầng 1: Độ phân giải mục tiêu + FPS (lên tới 120Hz/144Hz) + MTK / Qualcomm Low-Latency + CBR
            tryConfigureTier(mime, encodedWidth, encodedHeight, config.fps, useExtendedFlags = true, useVendorExtensions = true)?.let {
                Log.i(TAG, "Encoder Tier 1 (Vendor Low-Latency) active: $mime ${encodedWidth}x${encodedHeight} @ ${actualFps}fps")
                return it
            }

            // Tầng 1b: Độ phân giải mục tiêu + FPS (lên tới 120Hz/144Hz) + Chuẩn Android Low-Latency
            tryConfigureTier(mime, encodedWidth, encodedHeight, config.fps, useExtendedFlags = true, useVendorExtensions = false)?.let {
                Log.i(TAG, "Encoder Tier 1b (Standard Low-Latency) active: $mime ${encodedWidth}x${encodedHeight} @ ${actualFps}fps")
                return it
            }

            // Tầng 2: Chuẩn 1080p @ target FPS + vendor extensions
            tryConfigureTier(mime, res1080W, res1080H, config.fps, useExtendedFlags = true, useVendorExtensions = true)?.let {
                Log.i(TAG, "Encoder Tier 2 (1080p @ ${actualFps}fps) active: $mime")
                return it
            }

            // Tầng 2b: Chuẩn 1080p @ 60FPS
            tryConfigureTier(mime, res1080W, res1080H, min(config.fps, 60), useExtendedFlags = false, useVendorExtensions = false)?.let {
                Log.i(TAG, "Encoder Tier 2b (1080p@60) active: $mime ${encodedWidth}x${encodedHeight} @ ${actualFps}fps")
                return it
            }

            // Tầng 3: Chuẩn 720p @ 60FPS
            tryConfigureTier(mime, res720W, res720H, 60, useExtendedFlags = false, useVendorExtensions = false)?.let {
                Log.i(TAG, "Encoder Tier 3 (720p@60) active: $mime ${encodedWidth}x${encodedHeight} @ ${actualFps}fps")
                return it
            }

            // Tầng 4: 720p @ 30FPS an toàn tuyệt đối
            tryConfigureTier(mime, res720W, res720H, 30, useExtendedFlags = false, useVendorExtensions = false)?.let {
                Log.i(TAG, "Encoder Tier 4 (720p@30) active: $mime ${encodedWidth}x${encodedHeight} @ ${actualFps}fps")
                return it
            }
        }
        return null
    }

    private fun tryConfigureTier(
        mime: String,
        width: Int,
        height: Int,
        fps: Int,
        useExtendedFlags: Boolean,
        useVendorExtensions: Boolean = true
    ): MediaCodec? {
        var mc: MediaCodec? = null
        return try {
            mc = MediaCodec.createEncoderByType(mime)
            val codecCaps = mc.codecInfo.getCapabilitiesForType(mime)
            val videoCaps = codecCaps.videoCapabilities

            val clampedBitrate = config.bitrateBps.coerceIn(
                videoCaps.bitrateRange.lower,
                videoCaps.bitrateRange.upper
            )

            // For high refresh rate gaming displays (120Hz/144Hz on Poco X8 Pro),
            // support target fps up to 144
            val targetFps = if (!useExtendedFlags) {
                fps.coerceAtMost(60)
            } else {
                val maxSupported = try {
                    if (videoCaps.isSizeSupported(width, height)) {
                        videoCaps.getSupportedFrameRatesFor(width, height).upper.toInt()
                    } else if (videoCaps.isSizeSupported(height, width)) {
                        videoCaps.getSupportedFrameRatesFor(height, width).upper.toInt()
                    } else {
                        fps
                    }
                } catch (_: Exception) {
                    fps
                }
                fps.coerceIn(30, maxOf(fps, maxSupported).coerceAtMost(144))
            }

            // Repeat interval matching the target refresh rate (e.g. 6.94ms for 144fps, 8.33ms for 120fps)
            val repeatIntervalUs = (1_000_000L / targetFps.coerceAtLeast(30)).coerceAtLeast(6_944L)

            val format = MediaFormat.createVideoFormat(mime, width, height).apply {
                setInteger(
                    MediaFormat.KEY_COLOR_FORMAT,
                    MediaCodecInfo.CodecCapabilities.COLOR_FormatSurface
                )
                setInteger(MediaFormat.KEY_BIT_RATE, clampedBitrate)
                setInteger(MediaFormat.KEY_FRAME_RATE, targetFps)
                setInteger(MediaFormat.KEY_I_FRAME_INTERVAL, config.intraRefreshSec)
                setLong(MediaFormat.KEY_REPEAT_PREVIOUS_FRAME_AFTER, repeatIntervalUs)

                // Constant Bitrate (CBR) for ultra-stable streaming without buffer bloat
                setInteger(
                    MediaFormat.KEY_BITRATE_MODE,
                    MediaCodecInfo.EncoderCapabilities.BITRATE_MODE_CBR
                )

                if (useExtendedFlags) {
                    setInteger(MediaFormat.KEY_PRIORITY, 0)
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                        setInteger(MediaFormat.KEY_MAX_B_FRAMES, 0)
                    }
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R &&
                        codecCaps.isFeatureSupported(MediaCodecInfo.CodecCapabilities.FEATURE_LowLatency)
                    ) {
                        setInteger(MediaFormat.KEY_LOW_LATENCY, 1)
                    }

                    if (useVendorExtensions) {
                        // MediaTek Dimensity low-latency & no frame-dropping vendor extensions (e.g. Poco X8 Pro)
                        try {
                            setInteger("vendor.mtk.ext.venc.lowlatency", 1)
                            setInteger("vendor.mtk.ext.venc.frame-dropping", 0)
                        } catch (_: Exception) {}

                        // Qualcomm Snapdragon hardware encoder low-latency extensions
                        try {
                            setInteger("vendor.qti-ext-enc-low-latency.enable", 1)
                        } catch (_: Exception) {}
                    }
                }
            }

            mc.configure(format, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE)
            encodedWidth = width
            encodedHeight = height
            actualFps = targetFps
            mc
        } catch (e: Exception) {
            Log.w(TAG, "Tier config rejected ($mime ${width}x${height}@${fps}fps, ext=$useExtendedFlags, vendor=$useVendorExtensions): ${e.message}")
            try {
                mc?.release()
            } catch (_: Exception) {
            }
            null
        }
    }

    private fun extractCsdFromOutputFormat(format: MediaFormat): ByteArray? {
        return try {
            val csd0: ByteBuffer? = format.getByteBuffer("csd-0")
            val csd1: ByteBuffer? = format.getByteBuffer("csd-1")
            if (csd0 == null) return null

            val b0 = ByteArray(csd0.remaining())
            csd0.duplicate().get(b0)

            if (csd1 != null && csd1.remaining() > 0) {
                val b1 = ByteArray(csd1.remaining())
                csd1.duplicate().get(b1)
                val combined = ByteArray(b0.size + b1.size)
                System.arraycopy(b0, 0, combined, 0, b0.size)
                System.arraycopy(b1, 0, combined, b0.size, b1.size)
                combined
            } else {
                b0
            }
        } catch (_: Exception) {
            null
        }
    }

    private fun drainEncoderLoop(mediaCodec: MediaCodec) {
        val bufferInfo = MediaCodec.BufferInfo()
        var windowFrames = 0
        var windowBytes = 0L
        var windowEncodeUs = 0L
        var lastStatTimestampMs = System.currentTimeMillis()

        while (isEncoding.get()) {
            try {
                val outIndex = mediaCodec.dequeueOutputBuffer(bufferInfo, DEQUEUE_TIMEOUT_US)
                if (outIndex == MediaCodec.INFO_TRY_AGAIN_LATER) {
                    continue
                } else if (outIndex == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED) {
                    extractCsdFromOutputFormat(mediaCodec.outputFormat)?.let { csdBytes ->
                        Log.i(TAG, "Extracted SPS/PPS from INFO_OUTPUT_FORMAT_CHANGED (${csdBytes.size} bytes)")
                        transport.sendEncodedFrame(
                            frameType = StreamTransport.FRAME_TYPE_CONFIG,
                            ptsUs = System.nanoTime() / 1000L,
                            encodeDurationUs = 0,
                            data = csdBytes
                        )
                    }
                } else if (outIndex >= 0) {
                    val outputBuffer = mediaCodec.getOutputBuffer(outIndex)

                    if (outputBuffer != null && bufferInfo.size > 0) {
                        outputBuffer.position(bufferInfo.offset)
                        outputBuffer.limit(bufferInfo.offset + bufferInfo.size)

                        val nalBytes = ByteArray(bufferInfo.size)
                        outputBuffer.get(nalBytes)

                        val isConfig = (bufferInfo.flags and MediaCodec.BUFFER_FLAG_CODEC_CONFIG) != 0
                        val isKeyFrame = (bufferInfo.flags and MediaCodec.BUFFER_FLAG_KEY_FRAME) != 0

                        val frameType = when {
                            isConfig -> StreamTransport.FRAME_TYPE_CONFIG
                            isKeyFrame -> StreamTransport.FRAME_TYPE_KEYFRAME
                            else -> StreamTransport.FRAME_TYPE_NORMAL
                        }

                        val encodeDurationUs = 1800

                        transport.sendEncodedFrame(
                            frameType = frameType,
                            ptsUs = bufferInfo.presentationTimeUs,
                            encodeDurationUs = encodeDurationUs,
                            data = nalBytes
                        )

                        if (!isConfig) {
                            val total = totalSentFrames.incrementAndGet()
                            windowFrames++
                            windowBytes += nalBytes.size
                            windowEncodeUs += encodeDurationUs

                            val nowMs = System.currentTimeMillis()
                            val elapsedMs = nowMs - lastStatTimestampMs
                            if (elapsedMs >= 1000L) {
                                val fps = ((windowFrames * 1000L) / elapsedMs).toInt()
                                val kbps = (((windowBytes * 8L) / elapsedMs)).toInt()
                                val avgEnc = if (windowFrames > 0) windowEncodeUs / windowFrames else 0L
                                onStatsUpdated(fps, kbps, avgEnc, total)

                                windowFrames = 0
                                windowBytes = 0L
                                windowEncodeUs = 0L
                                lastStatTimestampMs = nowMs
                            }
                        }
                    }
                    mediaCodec.releaseOutputBuffer(outIndex, false)
                }
            } catch (e: Exception) {
                if (isEncoding.get()) {
                    Log.e(TAG, "Encoder loop error", e)
                }
                break
            }
        }
    }

    fun requestInstantSyncFrame() {
        try {
            val params = Bundle().apply {
                putInt(MediaCodec.PARAMETER_KEY_REQUEST_SYNC_FRAME, 0)
            }
            codec?.setParameters(params)
        } catch (e: Exception) {
            Log.w(TAG, "Failed to request sync frame: ${e.message}")
        }
    }

    fun updateDynamicBitrate(newBitrateBps: Int) {
        try {
            val safeBitrate = newBitrateBps.coerceIn(1_000_000, 60_000_000)
            val params = Bundle().apply {
                putInt(MediaCodec.PARAMETER_KEY_VIDEO_BITRATE, safeBitrate)
            }
            codec?.setParameters(params)
        } catch (e: Exception) {
            Log.w(TAG, "Failed to update dynamic bitrate: ${e.message}")
        }
    }

    fun stop() {
        if (!isEncoding.getAndSet(false)) return
        try {
            mediaProjection.unregisterCallback(projectionCallback)
        } catch (_: Exception) {
        }
        try {
            virtualDisplay?.release()
        } catch (_: Exception) {
        }
        virtualDisplay = null
        try {
            inputSurface?.release()
        } catch (_: Exception) {
        }
        inputSurface = null
        try {
            codec?.stop()
        } catch (_: Exception) {
        }
        try {
            codec?.release()
        } catch (_: Exception) {
        }
        codec = null
    }
}
