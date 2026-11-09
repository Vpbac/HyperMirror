package com.hypermirror.sender

import android.os.Build
import android.util.Log
import java.io.BufferedInputStream
import java.io.BufferedOutputStream
import java.io.DataInputStream
import java.io.DataOutputStream
import java.net.InetSocketAddress
import java.net.ServerSocket
import java.net.Socket
import java.nio.charset.StandardCharsets
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicLong

class StreamTransport(
    private val config: MirrorConfig,
    private val onRequestSyncFrame: () -> Unit,
    private val onDynamicBitrateChange: (Int) -> Unit,
    private val onConnectionStateChanged: (Boolean, String) -> Unit
) {
    companion object {
        private const val TAG = "StreamTransport"
        const val FRAME_TYPE_CONFIG: Byte = 0x01
        const val FRAME_TYPE_KEYFRAME: Byte = 0x02
        const val FRAME_TYPE_NORMAL: Byte = 0x03
        const val FRAME_TYPE_PING: Byte = 0x04

        const val CMD_REQUEST_IDR: Byte = 0x10
        const val CMD_SET_BITRATE: Byte = 0x11
        const val CMD_PONG: Byte = 0x12
    }

    private val running = AtomicBoolean(false)
    private var serverSocket: ServerSocket? = null
    private var activeSocket: Socket? = null
    private var outputStream: DataOutputStream? = null
    private val writeLock = Any()

    @Volatile
    var latestRttMs: Double = 0.0
        private set

    val droppedFrames = AtomicLong(0)
    private var cachedConfigNal: ByteArray? = null

    fun start(width: Int, height: Int) {
        running.set(true)
        Thread({
            while (running.get()) {
                try {
                    val socket = if (config.transportMode == TransportMode.USB_SERVER) {
                        Log.i(TAG, "Listening on TCP port ${config.targetPort} (USB ADB Forward / Wi-Fi Server)...")
                        val srv = ServerSocket()
                        srv.reuseAddress = true
                        srv.bind(InetSocketAddress("0.0.0.0", config.targetPort))
                        serverSocket = srv
                        srv.accept()
                    } else {
                        Log.i(TAG, "Connecting to PC ${config.targetHost}:${config.targetPort}...")
                        val sock = Socket()
                        sock.connect(InetSocketAddress(config.targetHost, config.targetPort), 2500)
                        sock
                    }

                    configureLowLatencySocket(socket)
                    activeSocket = socket
                    val out = DataOutputStream(BufferedOutputStream(socket.getOutputStream(), 64 * 1024))
                    outputStream = out

                    val remoteAddr = socket.remoteSocketAddress?.toString() ?: "Connected"
                    onConnectionStateChanged(true, remoteAddr)

                    // Gửi Handshake 24 bytes
                    sendHandshake(out, width, height)

                    // Nếu đã có SPS/PPS/VPS cache từ MediaCodec, gửi ngay lập tức rồi ép xuất 1 IDR frame
                    cachedConfigNal?.let { csd ->
                        sendFrameInternal(out, FRAME_TYPE_CONFIG, System.nanoTime() / 1000L, 0, csd)
                    }
                    onRequestSyncFrame()

                    // Khởi chạy luồng Ping định kỳ đo RTT
                    startPingLoop(out)

                    // Đọc kênh điều khiển chiều về (PC -> Android)
                    readControlLoop(DataInputStream(BufferedInputStream(socket.getInputStream(), 1024)))
                } catch (e: Exception) {
                    if (running.get()) {
                        Log.w(TAG, "Transport connection interrupted: ${e.message}")
                    }
                } finally {
                    closeCurrentSocket()
                    onConnectionStateChanged(false, "Disconnected")
                    if (running.get()) {
                        try {
                            Thread.sleep(1000)
                        } catch (_: InterruptedException) {
                            break
                        }
                    }
                }
            }
        }, "HyperMirror-Transport").start()
    }

    private fun configureLowLatencySocket(socket: Socket) {
        // Tắt thuật toán Nagle để mọi gói NAL xuất ra mạng ngay lập tức (< 0.2ms)
        socket.tcpNoDelay = true
        socket.keepAlive = true
        // Đánh dấu gói tin ưu tiên thời gian thực (IPTOS_LOWDELAY | IPTOS_THROUGHPUT) cho Wi-Fi WMM
        try {
            socket.trafficClass = 0x10 or 0x08
        } catch (_: Exception) {
        }
        // Giới hạn SendBuffer vừa đủ để tránh hiện tượng Bufferbloat khi mạng Wi-Fi nhiễu
        socket.sendBufferSize = 256 * 1024
        socket.receiveBufferSize = 32 * 1024
    }

    private fun sendHandshake(out: DataOutputStream, width: Int, height: Int) {
        synchronized(writeLock) {
            out.writeBytes("GMIR")                        // 4B Magic
            out.writeByte(1)                              // 1B Protocol Version
            out.writeByte(config.codec.id.toInt())        // 1B Codec (1=H264, 2=H265)
            out.writeShort(width)                         // 2B Width
            out.writeShort(height)                        // 2B Height
            out.writeShort(config.fps)                    // 2B Target FPS
            out.writeInt(config.bitrateMbps * 1000)       // 4B Bitrate (kbps)

            val modelBytes = Build.MODEL.take(8).padEnd(8, ' ').toByteArray(StandardCharsets.US_ASCII)
            out.write(modelBytes, 0, 8)                   // 8B Device Tag
            out.flush()
        }
    }

    fun sendEncodedFrame(frameType: Byte, ptsUs: Long, encodeDurationUs: Int, data: ByteArray) {
        if (frameType == FRAME_TYPE_CONFIG) {
            cachedConfigNal = data.clone()
        }
        val out = outputStream ?: return
        try {
            sendFrameInternal(out, frameType, ptsUs, encodeDurationUs, data)
        } catch (e: Exception) {
            droppedFrames.incrementAndGet()
            closeCurrentSocket()
        }
    }

    private fun sendFrameInternal(
        out: DataOutputStream,
        frameType: Byte,
        ptsUs: Long,
        encodeDurationUs: Int,
        data: ByteArray
    ) {
        synchronized(writeLock) {
            out.writeByte(frameType.toInt())
            out.writeLong(ptsUs)
            out.writeInt(encodeDurationUs)
            out.writeInt(data.size)
            out.write(data)
            out.flush()
        }
    }

    private fun startPingLoop(out: DataOutputStream) {
        Thread({
            val pingPayload = ByteArray(8)
            while (running.get() && activeSocket?.isConnected == true && !activeSocket!!.isClosed) {
                try {
                    val nowNs = System.nanoTime()
                    for (i in 0..7) {
                        pingPayload[i] = ((nowNs ushr ((7 - i) * 8)) and 0xFF).toByte()
                    }
                    sendFrameInternal(out, FRAME_TYPE_PING, nowNs / 1000L, 0, pingPayload)
                    Thread.sleep(1000)
                } catch (_: Exception) {
                    break
                }
            }
        }, "HyperMirror-Ping").start()
    }

    private fun readControlLoop(input: DataInputStream) {
        while (running.get()) {
            val cmd = input.readByte()
            when (cmd) {
                CMD_REQUEST_IDR -> {
                    Log.i(TAG, "PC requested immediate IDR Sync Frame")
                    onRequestSyncFrame()
                }
                CMD_SET_BITRATE -> {
                    val newBitrateBps = input.readInt()
                    Log.i(TAG, "PC requested live bitrate update: ${newBitrateBps / 1_000_000} Mbps")
                    onDynamicBitrateChange(newBitrateBps)
                }
                CMD_PONG -> {
                    val sentNs = input.readLong()
                    val rttNs = System.nanoTime() - sentNs
                    if (rttNs > 0) {
                        latestRttMs = rttNs / 1_000_000.0
                    }
                }
            }
        }
    }

    private fun closeCurrentSocket() {
        synchronized(writeLock) {
            try {
                outputStream?.close()
            } catch (_: Exception) {
            }
            outputStream = null
            try {
                activeSocket?.close()
            } catch (_: Exception) {
            }
            activeSocket = null
            try {
                serverSocket?.close()
            } catch (_: Exception) {
            }
            serverSocket = null
        }
    }

    fun stop() {
        running.set(false)
        closeCurrentSocket()
    }
}
