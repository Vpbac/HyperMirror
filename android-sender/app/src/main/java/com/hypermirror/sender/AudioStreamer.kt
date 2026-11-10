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
 * Ultra-Low-Latency Audio Capture Engine for HyperMirror Pro
 * Captures internal game and media audio on Android 10+ (API 29+) using AudioPlaybackCaptureConfiguration.
 * Transmits lossless 16-bit Linear PCM Stereo @ 48,000 Hz with sub-10ms packetization latency.
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
                val bufferSize = maxOf(minBufSize, FRAME_BYTES * 2)

                val record = AudioRecord.Builder()
                    .setAudioPlaybackCaptureConfig(playbackConfig)
                    .setAudioFormat(audioFormat)
                    .setBufferSizeInBytes(bufferSize)
                    .build()

                if (record.state != AudioRecord.STATE_INITIALIZED) {
                    Log.e(TAG, "AudioRecord state is not INITIALIZED (state=${record.state})")
                    record.release()
                    isRunning.set(false)
                    return@Thread
                }

                audioRecord = record
                record.startRecording()
                Log.i(TAG, "AudioPlaybackCapture active: 48kHz Stereo 16-bit PCM (10ms Gaming Low-Latency)")

                val chunk = ByteArray(FRAME_BYTES)
                while (isRunning.get()) {
                    var bytesRead = 0
                    while (bytesRead < FRAME_BYTES && isRunning.get()) {
                        val res = record.read(chunk, bytesRead, FRAME_BYTES - bytesRead, AudioRecord.READ_BLOCKING)
                        if (res > 0) {
                            bytesRead += res
                        } else if (res < 0) {
                            Log.w(TAG, "AudioRecord read error: $res")
                            break
                        }
                    }

                    if (bytesRead > 0 && isRunning.get()) {
                        val nowUs = System.nanoTime() / 1000L
                        val packet = if (bytesRead == FRAME_BYTES) chunk else chunk.copyOf(bytesRead)
                        transport.sendAudioFrame(nowUs, SAMPLE_RATE, packet)
                    }
                }
            } catch (e: Exception) {
                if (isRunning.get()) {
                    Log.e(TAG, "Audio streamer loop error: ${e.message}", e)
                }
            } finally {
                try {
                    if (audioRecord?.recordingState == AudioRecord.RECORDSTATE_RECORDING) {
                        audioRecord?.stop()
                    }
                } catch (_: Exception) {}
                try {
                    audioRecord?.release()
                } catch (_: Exception) {}
                audioRecord = null
                isRunning.set(false)
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
            if (audioRecord?.recordingState == AudioRecord.RECORDSTATE_RECORDING) {
                audioRecord?.stop()
            }
        } catch (_: Exception) {}
        try {
            audioRecord?.release()
        } catch (_: Exception) {}
        audioRecord = null
        recordThread = null
    }
}
