package com.hypermirror.sender

import android.media.MediaFormat
import java.io.Serializable

enum class VideoCodecType(val id: Byte, val mimeType: String, val displayName: String) {
    H264(1, MediaFormat.MIMETYPE_VIDEO_AVC, "H.264 (AVC - Tương thích & Giải mã nhanh nhất)"),
    H265(2, MediaFormat.MIMETYPE_VIDEO_HEVC, "H.265 (HEVC - Nén tốt hơn 35% qua Wi-Fi)")
}

enum class TransportMode(val displayName: String) {
    /**
     * Cắm cáp USB (ADB Forward): Điện thoại mở cổng TCP 27183, PC chạy `adb forward tcp:27183 tcp:27183`
     * và chủ động kết nối vào điện thoại. Không cần cấu hình IP.
     */
    USB_SERVER("Cắm dây USB (ADB Forward / Listen :27183)"),

    /**
     * Cắm cáp USB (ADB Reverse) hoặc Wi-Fi Direct: Điện thoại kết nối tới IP của PC (hoặc 127.0.0.1 qua adb reverse).
     */
    CLIENT_CONNECT("Wi-Fi / USB Reverse (Kết nối tới IP PC)")
}

data class MirrorConfig(
    val codec: VideoCodecType = VideoCodecType.H264,
    val transportMode: TransportMode = TransportMode.CLIENT_CONNECT,
    val targetHost: String = "192.168.1.10",
    val targetPort: Int = 27183,
    val maxDimension: Int = 1920,     // 1280 (720p), 1920 (1080p), 2560 (1440p), 0 (Native)
    val fps: Int = 60,                // 60, 90, 120 FPS
    val bitrateMbps: Int = 16,        // 4 - 40 Mbps
    val intraRefreshSec: Int = 1,     // Khoảng cách I-Frame (giây)
    val ultraLowLatencyMode: Boolean = true // Tắt B-Frame, bật CBR, KEY_LOW_LATENCY = 1
) : Serializable {
    val bitrateBps: Int
        get() = bitrateMbps * 1_000_000
}

data class StreamTelemetry(
    val connected: Boolean = false,
    val clientAddress: String = "-",
    val currentFps: Int = 0,
    val currentBitrateKbps: Int = 0,
    val avgEncodeTimeUs: Long = 0,
    val rttLatencyMs: Double = 0.0,
    val sentFrames: Long = 0,
    val droppedFrames: Long = 0
)
