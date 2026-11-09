package com.hypermirror.sender

import android.hardware.display.DisplayManager
import android.hardware.display.VirtualDisplay
import android.media.MediaCodec
import android.media.MediaCodecInfo
import android.media.MediaFormat
import android.media.projection.MediaProjection
import android.os.Build
import android.os.Bundle
import android.os.Process
import android.util.DisplayMetrics
import android.util.Log
import android.view.Surface
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
        private const val DEQUEUE_TIMEOUT_US = 8_000L // 8ms polling cho 120FPS
    }

    private val isEncoding = AtomicBoolean(false)
    private var codec: MediaCodec? = null
    private var inputSurface: Surface? = null
    private var virtualDisplay: VirtualDisplay? = null

    val encodedWidth: Int
    val encodedHeight: Int
    private val totalSentFrames = AtomicLong(0)

    init {
        val rawW = displayMetrics.widthPixels
        val rawH = displayMetrics.heightPixels

        if (config.maxDimension <= 0) {
            encodedWidth = align16(rawW)
            encodedHeight = align16(rawH)
        } else {
            val maxSide = max(rawW, rawH)
            val scale = if (maxSide > config.maxDimension) {
                config.maxDimension.toFloat() / maxSide.toFloat()
            } else {
                1.0f
            }
            encodedWidth = align16((rawW * scale).toInt())
            encodedHeight = align16((rawH * scale).toInt())
        }
    }

    private fun align16(value: Int): Int = max(256, value and 0xFFF0)

    fun start() {
        if (isEncoding.getAndSet(true)) return

        val mediaCodec = createConfiguredCodec()
        codec = mediaCodec
        val surface = mediaCodec.createInputSurface()
        inputSurface = surface
        mediaCodec.start()

        // Tạo VirtualDisplay ghi trực tiếp từ GPU SurfaceFlinger vào Surface của Hardware MediaCodec (Zero-Copy)
        virtualDisplay = mediaProjection.createVirtualDisplay(
            "HyperMirror-ZeroLatency",
            encodedWidth,
            encodedHeight,
            displayMetrics.densityDpi,
            DisplayManager.VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR or DisplayManager.VIRTUAL_DISPLAY_FLAG_PUBLIC,
            surface,
            null,
            null
        )

        Thread({
            // Đặt độ ưu tiên luồng ở mức URGENT_DISPLAY (-8) để tránh bị hệ điều hành preempt khi đang chơi game nặng
            Process.setThreadPriority(Process.THREAD_PRIORITY_URGENT_DISPLAY)
            drainEncoderLoop(mediaCodec)
        }, "HyperMirror-EncoderDrain").start()
    }

    private fun createConfiguredCodec(): MediaCodec {
        val mime = config.codec.mimeType
        val format = MediaFormat.createVideoFormat(mime, encodedWidth, encodedHeight).apply {
            setInteger(
                MediaFormat.KEY_COLOR_FORMAT,
                MediaCodecInfo.CodecCapabilities.COLOR_FormatSurface
            )
            setInteger(MediaFormat.KEY_BIT_RATE, config.bitrateBps)
            setInteger(MediaFormat.KEY_FRAME_RATE, config.fps)
            setInteger(MediaFormat.KEY_CAPTURE_RATE, config.fps)
            setInteger(MediaFormat.KEY_I_FRAME_INTERVAL, config.intraRefreshSec)

            // Lặp lại frame sau 100ms nếu màn hình đứng yên để giữ luồng ổn định cho bộ giải mã PC
            setLong(MediaFormat.KEY_REPEAT_PREVIOUS_FRAME_AFTER, 100_000L)

            if (config.ultraLowLatencyMode) {
                // 1. Đặt xung nhịp phần cứng Video DSP ở mức tối đa (giảm thời gian encode 1 frame xuống ~1.5 - 2.5ms)
                setInteger(MediaFormat.KEY_OPERATING_RATE, Short.MAX_VALUE.toInt())
                // 2. Ưu tiên thời gian thực (0 = Realtime Priority)
                setInteger(MediaFormat.KEY_PRIORITY, 0)
                // 3. Tắt hoàn toàn B-Frames để không bao giờ phải giữ lại frame chờ sắp xếp thứ tự
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                    setInteger(MediaFormat.KEY_MAX_B_FRAMES, 0)
                }
                // 4. Bật cờ Low-Latency chuẩn Android 11+ (API 30+)
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                    setInteger(MediaFormat.KEY_LOW_LATENCY, 1)
                }
                setInteger(MediaFormat.KEY_LATENCY, 0)

                // 5. Kích hoạt Vendor-specific Low-Latency cho Qualcomm Snapdragon, MediaTek Dimensity, Exynos & Pixel Tensor
                setInteger("vendor.qti-ext-enc-low-latency.enable", 1)
                setInteger("vendor.rtc-ext-enc-low-latency.enable", 1)
                setInteger("vendor.mtk.ext.venc.lowlatency", 1)
                setInteger("vendor.sec-dec-output.delay", 0)

                // 6. Ưu tiên CBR (Constant Bitrate) để tránh nghẽn đột biến trên đường truyền Wi-Fi
                setInteger(
                    MediaFormat.KEY_BITRATE_MODE,
                    MediaCodecInfo.EncoderCapabilities.BITRATE_MODE_CBR
                )
            }
        }

        val mediaCodec = MediaCodec.createEncoderByType(mime)
        try {
            mediaCodec.configure(format, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE)
        } catch (e: Exception) {
            Log.w(TAG, "CBR or extended flags rejected by SoC, falling back to VBR low-latency", e)
            format.setInteger(
                MediaFormat.KEY_BITRATE_MODE,
                MediaCodecInfo.EncoderCapabilities.BITRATE_MODE_VBR
            )
            mediaCodec.configure(format, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE)
        }
        return mediaCodec
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
                if (outIndex >= 0) {
                    val dequeueTimeUs = System.nanoTime() / 1000L
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

                        // Ước lượng thời gian phần cứng xử lý frame
                        val encodeDurationUs = if (bufferInfo.presentationTimeUs > 0 && !isConfig) {
                            min(50_000L, max(200L, (dequeueTimeUs - bufferInfo.presentationTimeUs).coerceAtLeast(800L))).toInt()
                        } else {
                            0
                        }

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

    /**
     * Ép bộ mã hóa phần cứng xuất ngay lập tức 1 khung hình IDR (KeyFrame) mà không cần khởi động lại stream.
     */
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

    /**
     * Thay đổi Bitrate trực tiếp theo thời gian thực khi đang chơi game (Dynamic Bitrate Adaptation).
     */
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
            codec?.release()
        } catch (_: Exception) {
        }
        codec = null
    }
}
