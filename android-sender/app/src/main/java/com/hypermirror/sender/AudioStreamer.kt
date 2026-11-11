package com.hypermirror.sender

import android.annotation.SuppressLint
import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioPlaybackCaptureConfiguration
import android.media.AudioRecord
import android.media.projection.MediaProjection
import android.os.Build
import android.util.Log
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Ultra-Low-Latency Audio Capture Engine for HyperMirror Pro (Hardened for Poco X8 Pro & HyperOS)
 * Captures internal game and media audio on Android 10+ (API 29+) using AudioPlaybackCaptureConfiguration.
 * Transmits lossless 16-bit Linear PCM Stereo @ 48,000 Hz with sub-10ms packetization latency.
 * Specially hardened for heavy games (Vuong Gia Vinh Dieu, Lien Quan, Wuthering Waves) with
 * generous ring buffers and automatic recovery on audio buffer underrun or audio server restart.
 */
class AudioStreamer(
    private val mediaProjection: MediaProjection,
    private val transport: StreamTransport
) {
    companion object {
        private const val TAG = "AudioStreamer"
        const val SAMPLE_RATE = 48000
        const val CHANNEL_CONFIG = AudioFormat.CHANNEL_IN_STEREO
        const val AUDIO_FORMAT = AudioFormat.ENCODING_PCM_16BIT
        // 480 stereo samples @ 48kHz = 10ms ultra-low-latency audio frame
        // 480 samples * 2 channels * 2 bytes = 1,920 bytes
        const val SAMPLES_PER_FRAME = 480
        const val FRAME_BYTES = SAMPLES_PER_FRAME * 2 * 2
    }

    private val isRunning = AtomicBoolean(false)
    private var recordThread: Thread? = null
    @Volatile
    private var audioRecord: AudioRecord? = null

    @SuppressLint("MissingPermission")
    fun start(): Boolean {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) {
            Log.w(TAG, "AudioPlaybackCapture requires Android 10 (API 29) or higher")
            return false
        }

        if (isRunning.getAndSet(true)) return true

        recordThread = Thread({
            try {
                android.os.Process.setThreadPriority(android.os.Process.THREAD_PRIORITY_URGENT_AUDIO)
            } catch (_: Exception) {}

            var loggedFirstAudio = false

            // Auto-recovery outer loop: recreates AudioRecord if audio server restarts,
            // buffer underruns catastrophically, or audio routing changes (e.g. game start / headphones)
            while (isRunning.get()) {
                var currentRecord: AudioRecord? = null
                try {
                    val playbackConfig = AudioPlaybackCaptureConfiguration.Builder(mediaProjection)
                        .addMatchingUsage(AudioAttributes.USAGE_GAME)
                        .addMatchingUsage(AudioAttributes.USAGE_MEDIA)
                        .addMatchingUsage(AudioAttributes.USAGE_UNKNOWN)
                        .build()

                    val audioFormat = AudioFormat.Builder()
                        .setEncoding(AUDIO_FORMAT)
                        .setSampleRate(SAMPLE_RATE)
                        .setChannelMask(CHANNEL_CONFIG)
                        .build()

                    val minBufSize = AudioRecord.getMinBufferSize(SAMPLE_RATE, CHANNEL_CONFIG, AUDIO_FORMAT)
                    // High-headroom buffer (minBufSize * 4 or at least 16 frames = ~30KB+) to absorb
                    // HyperOS scheduling jitter and Wuwa / Lien Quan heavy shader load spikes
                    val bufferSize = maxOf(minBufSize * 4, FRAME_BYTES * 16)

                    val record = AudioRecord.Builder()
                        .setAudioPlaybackCaptureConfig(playbackConfig)
                        .setAudioFormat(audioFormat)
                        .setBufferSizeInBytes(bufferSize)
                        .build()

                    if (record.state != AudioRecord.STATE_INITIALIZED) {
                        Log.w(TAG, "AudioRecord state not INITIALIZED (state=${record.state}). Retrying in 250ms...")
                        record.release()
                        Thread.sleep(250)
                        continue
                    }

                    currentRecord = record
                    audioRecord = record
                    record.startRecording()
                    Log.i(TAG, "AudioPlaybackCapture active: 48kHz Stereo 16-bit PCM (Lossless Game Audio)")

                    val chunk = ByteArray(FRAME_BYTES)
                    var consecutiveErrors = 0
                    var consecutiveZeroReads = 0

                    while (isRunning.get() && record.recordingState == AudioRecord.RECORDSTATE_RECORDING) {
                        var bytesRead = 0
                        var hadFatalError = false

                        while (bytesRead < FRAME_BYTES && isRunning.get()) {
                            val res = record.read(chunk, bytesRead, FRAME_BYTES - bytesRead, AudioRecord.READ_BLOCKING)
                            if (res > 0) {
                                bytesRead += res
                                consecutiveErrors = 0
                                consecutiveZeroReads = 0
                            } else if (res == 0) {
                                consecutiveZeroReads++
                                if (consecutiveZeroReads > 10) {
                                    Thread.sleep(2)
                                }
                            } else {
                                // res < 0: AudioRecord error code
                                consecutiveErrors++
                                Log.w(TAG, "AudioRecord read error: $res (consecutive errors: $consecutiveErrors)")
                                when (res) {
                                    AudioRecord.ERROR_DEAD_OBJECT -> {
                                        Log.e(TAG, "Audio server died (ERROR_DEAD_OBJECT). Initiating auto-recovery...")
                                        hadFatalError = true
                                        break
                                    }
                                    AudioRecord.ERROR_INVALID_OPERATION -> {
                                        Log.w(TAG, "AudioRecord ERROR_INVALID_OPERATION. Initiating auto-recovery...")
                                        hadFatalError = true
                                        break
                                    }
                                    else -> {
                                        Thread.sleep(10)
                                        if (consecutiveErrors >= 5) {
                                            Log.w(TAG, "Too many read errors ($consecutiveErrors). Initiating auto-recovery...")
                                            hadFatalError = true
                                            break
                                        }
                                    }
                                }
                            }
                        }

                        if (hadFatalError) {
                            // Break inner capture loop to trigger auto-recovery re-initialization
                            break
                        }

                        if (bytesRead > 0 && isRunning.get()) {
                            val nowUs = System.nanoTime() / 1000L
                            val packet = if (bytesRead == FRAME_BYTES) chunk else chunk.copyOf(bytesRead)
                            transport.sendAudioFrame(nowUs, SAMPLE_RATE, packet)
                            if (!loggedFirstAudio) {
                                Log.i(TAG, "First lossless game audio frame transmitted (${packet.size} bytes @ 48kHz stereo)")
                                loggedFirstAudio = true
                            }
                        }
                    }
                } catch (e: Exception) {
                    if (isRunning.get()) {
                        Log.w(TAG, "Audio capture loop exception: ${e.message}. Recovering in 300ms...", e)
                    }
                } finally {
                    try {
                        if (currentRecord?.recordingState == AudioRecord.RECORDSTATE_RECORDING) {
                            currentRecord.stop()
                        }
                    } catch (_: Exception) {}
                    try {
                        currentRecord?.release()
                    } catch (_: Exception) {}
                    if (audioRecord === currentRecord) {
                        audioRecord = null
                    }
                }

                if (isRunning.get()) {
                    try {
                        Thread.sleep(300)
                    } catch (_: InterruptedException) {
                        break
                    }
                }
            }
        }, "HyperMirror-AudioCapture")

        recordThread?.start()
        return true
    }

    fun stop() {
        isRunning.set(false)
        try {
            recordThread?.interrupt()
        } catch (_: Exception) {}
        try {
            val record = audioRecord
            if (record?.recordingState == AudioRecord.RECORDSTATE_RECORDING) {
                record.stop()
            }
        } catch (_: Exception) {}
        try {
            audioRecord?.release()
        } catch (_: Exception) {}
        audioRecord = null
        recordThread = null
    }
}
