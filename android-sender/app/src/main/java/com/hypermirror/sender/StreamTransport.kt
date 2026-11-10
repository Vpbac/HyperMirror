package com.hypermirror.sender

import android.os.Build
import android.util.Log
import java.io.BufferedInputStream
import java.io.BufferedOutputStream
import java.io.DataInputStream
import java.io.DataOutputStream
import java.net.DatagramPacket
import java.net.DatagramSocket
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.ServerSocket
import java.net.Socket
import java.nio.charset.StandardCharsets
import java.util.concurrent.ArrayBlockingQueue
import java.util.concurrent.TimeUnit
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
        const val PC_SERVER_PORT = 27183
        const val PHONE_SERVER_PORT = 27184
        const val UDP_DISCOVERY_PORT = 27185

        const val FRAME_TYPE_CONFIG: Byte = 0x01
        const val FRAME_TYPE_KEYFRAME: Byte = 0x02
        const val FRAME_TYPE_NORMAL: Byte = 0x03
        const val FRAME_TYPE_PING: Byte = 0x04
        const val FRAME_TYPE_AUDIO: Byte = 0x06

        const val CMD_REQUEST_IDR: Byte = 0x10
        const val CMD_SET_BITRATE: Byte = 0x11
        const val CMD_PONG: Byte = 0x12
    }

    private data class QueuedFrame(
        val frameType: Byte,
        val ptsUs: Long,
        val encodeDurationUs: Int,
        val data: ByteArray
    )

    private val running = AtomicBoolean(false)
    private var serverSocket: ServerSocket? = null

    @Volatile
    private var activeSocket: Socket? = null

    @Volatile
    private var outputStream: DataOutputStream? = null

    private val writeLock = Any()
    private val socketSwitchLock = Any()

    private val frameQueue = ArrayBlockingQueue<QueuedFrame>(6)

    @Volatile
    var latestRttMs: Double = 0.0
        private set

    val droppedFrames = AtomicLong(0)

    @Volatile
    private var cachedConfigNal: ByteArray? = null

    @Volatile
    private var cachedKeyFrameNal: ByteArray? = null

    @Volatile
    private var streamWidth: Int = 1920

    @Volatile
    private var streamHeight: Int = 1080

    fun start(width: Int, height: Int) {
        streamWidth = width
        streamHeight = height
        if (running.getAndSet(true)) return

        // Luồng gửi gói tin bất đồng bộ
        Thread({
            while (running.get()) {
                try {
                    val pkt = frameQueue.poll(100, TimeUnit.MILLISECONDS) ?: continue
                    val out = outputStream ?: continue
                    sendFrameInternal(out, pkt.frameType, pkt.ptsUs, pkt.encodeDurationUs, pkt.data)
                } catch (e: Exception) {
                    droppedFrames.incrementAndGet()
                    closeActiveSocketOnly()
                }
            }
        }, "HyperMirror-AsyncWriter").start()

        // Luồng 1: Mở cổng TCP Server trên PHONE_SERVER_PORT (27184)
        // Cho phép PC kết nối CHIỀU ĐI (Outbound PC -> Phone:27184) xuyên qua Windows Firewall ở mọi mạng Wi-Fi!
        Thread({
            try {
                val srv = ServerSocket()
                srv.reuseAddress = true
                srv.bind(InetSocketAddress("0.0.0.0", PHONE_SERVER_PORT))
                serverSocket = srv
                Log.i(TAG, "Phone Server listening on 0.0.0.0:$PHONE_SERVER_PORT")

                while (running.get()) {
                    val incoming = srv.accept()
                    Log.i(TAG, "Accepted incoming PC connection: ${incoming.remoteSocketAddress}")
                    Thread({
                        handleConnectedSocket(incoming)
                    }, "HyperMirror-ServerSession").start()
                }
            } catch (e: Exception) {
                if (running.get()) {
                    Log.w(TAG, "Server accept loop ended: ${e.message}")
                }
            }
        }, "HyperMirror-ServerAccept").start()

        // Luồng 2: Chủ động kết nối tới PC_SERVER_PORT (27183) VÀ bắn tín hiệu UDP cho PC biết IP của điện thoại
        // để nếu Windows Firewall trên PC chặn cổng 27183, PC sẽ tự động kết nối ngược lại vào cổng 27184 của điện thoại!
        Thread({
            val targets = mutableListOf<String>()
            val trimmedHost = config.targetHost.trim()
            if (config.transportMode == TransportMode.USB_SERVER) {
                targets.add("127.0.0.1")
            } else {
                if (trimmedHost.isNotEmpty() && trimmedHost != "127.0.0.1") {
                    targets.add(trimmedHost)
                }
                targets.add("127.0.0.1")
            }

            var idx = 0
            var udpSock: DatagramSocket? = null
            try {
                udpSock = DatagramSocket()
                udpSock.broadcast = true
            } catch (_: Exception) {
            }

            while (running.get()) {
                if (activeSocket == null) {
                    // Bắn gói UDP thông báo cho PC kết nối ngược vào cổng 27184 (vượt tường lửa Windows)
                    try {
                        val beaconBytes = "GMIR_PHONE_READY:$PHONE_SERVER_PORT".toByteArray(StandardCharsets.UTF_8)
                        if (trimmedHost.isNotEmpty() && trimmedHost != "127.0.0.1") {
                            udpSock?.send(
                                DatagramPacket(
                                    beaconBytes,
                                    beaconBytes.size,
                                    InetAddress.getByName(trimmedHost),
                                    UDP_DISCOVERY_PORT
                                )
                            )
                        }
                        udpSock?.send(
                            DatagramPacket(
                                beaconBytes,
                                beaconBytes.size,
                                InetAddress.getByName("255.255.255.255"),
                                UDP_DISCOVERY_PORT
                            )
                        )
                    } catch (_: Exception) {
                    }

                    val hostToTry = targets[idx % targets.size]
                    idx++
                    try {
                        val sock = Socket()
                        sock.connect(InetSocketAddress(hostToTry, PC_SERVER_PORT), 1000)
                        Log.i(TAG, "Connected to PC Server at $hostToTry:$PC_SERVER_PORT")
                        handleConnectedSocket(sock)
                    } catch (_: Exception) {
                    }
                }
                try {
                    Thread.sleep(700)
                } catch (_: InterruptedException) {
                    break
                }
            }
            try {
                udpSock?.close()
            } catch (_: Exception) {
            }
        }, "HyperMirror-ClientConnect").start()
    }

    private fun handleConnectedSocket(socket: Socket) {
        val out: DataOutputStream
        synchronized(socketSwitchLock) {
            val existing = activeSocket
            if (existing != null && existing.isConnected && !existing.isClosed) {
                try {
                    socket.close()
                } catch (_: Exception) {
                }
                return
            }
            configureLowLatencySocket(socket)
            frameQueue.clear()
            activeSocket = socket
            out = DataOutputStream(BufferedOutputStream(socket.getOutputStream(), 64 * 1024))
            outputStream = out
        }

        val remoteAddr = socket.remoteSocketAddress?.toString() ?: "Connected"
        onConnectionStateChanged(true, remoteAddr)

        try {
            sendHandshake(out, streamWidth, streamHeight)
            val nowUs = System.nanoTime() / 1000L
            cachedConfigNal?.let { csd ->
                sendFrameInternal(out, FRAME_TYPE_CONFIG, nowUs, 0, csd)
            }
            // Gửi ngay lập tức KeyFrame gần nhất đã lưu để màn hình PC sáng hình ngay trong 10ms đầu tiên!
            cachedKeyFrameNal?.let { idr ->
                sendFrameInternal(out, FRAME_TYPE_KEYFRAME, nowUs + 1, 1500, idr)
            }
            onRequestSyncFrame()

            // Ép xuất thêm IDR sau 100ms và 400ms để đảm bảo 100% trình duyệt PC nhận được luồng mượt
            Thread({
                try {
                    Thread.sleep(100)
                    onRequestSyncFrame()
                    Thread.sleep(300)
                    onRequestSyncFrame()
                } catch (_: Exception) {
                }
            }, "HyperMirror-InitIdr").start()

            startPingLoop(socket, out)
            readControlLoop(DataInputStream(BufferedInputStream(socket.getInputStream(), 1024)))
        } catch (e: Exception) {
            if (running.get()) {
                Log.w(TAG, "Session ended (${e.message})")
            }
        } finally {
            synchronized(socketSwitchLock) {
                if (activeSocket === socket) {
                    closeActiveSocketOnly()
                    onConnectionStateChanged(false, "Disconnected")
                }
            }
        }
    }

    private fun configureLowLatencySocket(socket: Socket) {
        try {
            socket.tcpNoDelay = true
            socket.keepAlive = true
            socket.trafficClass = 0x10 or 0x08
            socket.sendBufferSize = 512 * 1024
            socket.receiveBufferSize = 32 * 1024
        } catch (_: Exception) {
        }
    }

    private fun sendHandshake(out: DataOutputStream, width: Int, height: Int) {
        synchronized(writeLock) {
            out.writeBytes("GMIR")
            out.writeByte(1)
            out.writeByte(config.codec.id.toInt())
            out.writeShort(width)
            out.writeShort(height)
            out.writeShort(config.fps)
            out.writeInt(config.bitrateMbps * 1000)

            val modelBytes = Build.MODEL.take(8).padEnd(8, ' ').toByteArray(StandardCharsets.US_ASCII)
            out.write(modelBytes, 0, 8)
            out.flush()
        }
    }

    fun sendEncodedFrame(frameType: Byte, ptsUs: Long, encodeDurationUs: Int, data: ByteArray) {
        if (frameType == FRAME_TYPE_CONFIG) {
            cachedConfigNal = data.clone()
        } else if (frameType == FRAME_TYPE_KEYFRAME) {
            cachedKeyFrameNal = data.clone()
        }
        if (outputStream == null) return

        val item = QueuedFrame(frameType, ptsUs, encodeDurationUs, data)
        if (!frameQueue.offer(item)) {
            frameQueue.poll()
            frameQueue.offer(item)
            droppedFrames.incrementAndGet()
            if (frameType != FRAME_TYPE_KEYFRAME && frameType != FRAME_TYPE_CONFIG) {
                onRequestSyncFrame()
            }
        }
    }

    fun sendAudioFrame(ptsUs: Long, sampleRate: Int, data: ByteArray) {
        val out = outputStream ?: return
        try {
            sendFrameInternal(out, FRAME_TYPE_AUDIO, ptsUs, sampleRate, data)
        } catch (_: Exception) {
            closeActiveSocketOnly()
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

    private fun startPingLoop(sock: Socket, out: DataOutputStream) {
        Thread({
            val pingPayload = ByteArray(8)
            while (running.get() && activeSocket === sock && !sock.isClosed) {
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
                CMD_REQUEST_IDR -> onRequestSyncFrame()
                CMD_SET_BITRATE -> {
                    val newBitrateBps = input.readInt()
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

    private fun closeActiveSocketOnly() {
        synchronized(writeLock) {
            frameQueue.clear()
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
        }
    }

    fun stop() {
        running.set(false)
        closeActiveSocketOnly()
        try {
            serverSocket?.close()
        } catch (_: Exception) {
        }
        serverSocket = null
    }
}
