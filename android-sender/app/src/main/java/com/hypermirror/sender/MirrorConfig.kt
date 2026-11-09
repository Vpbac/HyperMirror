package com.hypermirror.sender

import android.media.MediaFormat
import java.io.Serializable

enum class VideoCodecType(val id: Byte, val mimeType: String, val displayName: String) {
    H264(1, MediaFormat.MIMETYPE_VIDEO_AVC, "H.264 (AVC - Giải mã nhanh nhất)"),
    H265(2, MediaFormat.MIMETYPE_VIDEO_HEVC, "H.265 (HEVC - Nén tốt hơn 35% qua Wi-Fi)")
}

enum class TransportMode(val displayName: String) {
    USB_SERVER("Cắm dây USB (ADB Forward / Listen :27183)"),
    CLIENT_CONNECT("Wi-Fi / USB Reverse (Kết nối tới IP PC)")
}

enum class OrientationMode(val displayName: String) {
    /**
     * Luôn xuất khung hình ngang 16:9 (1920x1080 / 1280x720) chuẩn màn hình PC.
     * Khi vào game ngang sẽ khớp 100% toàn màn hình 1920x1080 không bị viền đen trên dưới!
     */
    LANDSCAPE_GAME("Ngang 16:9 (1920×1080 Fullscreen Chơi Game)"),

    /**
     * Tự động xoay khung hình 1920x1080 <-> 1080x1920 theo cảm biến xoay của điện thoại.
     */
    AUTO_ROTATE("Tự động xoay theo điện thoại (Auto-Rotate)"),

    /**
     * Khung hình dọc 9:16 (1080x1920).
     */
    PORTRAIT("Dọc 9:16 (1080×1920)")
}

data class MirrorConfig(
    val codec: VideoCodecType = VideoCodecType.H264,
    val transportMode: TransportMode = TransportMode.USB_SERVER,
    val orientationMode: OrientationMode = OrientationMode.LANDSCAPE_GAME,
    val targetHost: String = "192.168.1.10",
    val targetPort: Int = 27183,
    val maxDimension: Int = 1920,     // 1280 (720p), 1920 (1080p), 2560 (1440p), 0 (Native)
    val fps: Int = 60,                // 60, 90, 120 FPS
    val bitrateMbps: Int = 16,        // 4 - 40 Mbps
    val intraRefreshSec: Int = 1,
    val ultraLowLatencyMode: Boolean = true
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
