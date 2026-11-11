(() => {
  const canvas = document.getElementById("mirrorCanvas");
  // Standard 2D context double-buffered with browser compositor prevents VSync tearing
  const ctx = canvas.getContext("2d", { alpha: false }) || canvas.getContext("2d");

  const emptyOverlay = document.getElementById("emptyOverlay");
  const hudStatusDot = document.getElementById("hudStatusDot");
  const hudStatusText = document.getElementById("hudStatusText");
  const hudCodec = document.getElementById("hudCodec");
  const hudFps = document.getElementById("hudFps");
  const hudMonitorHz = document.getElementById("hudMonitorHz");
  const hudBitrate = document.getElementById("hudBitrate");
  const hudEncodeMs = document.getElementById("hudEncodeMs");
  const hudDecodeMs = document.getElementById("hudDecodeMs");

  const pcLanIp = document.getElementById("pcLanIp");
  const streamPortEl = document.getElementById("streamPort");
  const btnUsbAdb = document.getElementById("btnUsbAdb");
  const btnInstallApk = document.getElementById("btnInstallApk");
  const inputPhoneIp = document.getElementById("inputPhoneIp");
  const btnConnectPhone = document.getElementById("btnConnectPhone");
  const connectionToast = document.getElementById("connectionToast");

  // Discovered Phone & Reconnect Banner
  const discoveredPhoneCard = document.getElementById("discoveredPhoneCard");
  const discPhoneName = document.getElementById("discPhoneName");
  const discPhoneIp = document.getElementById("discPhoneIp");
  const btnConnectDiscovered = document.getElementById("btnConnectDiscovered");
  const reconnectBanner = document.getElementById("reconnectBanner");
  const reconnectText = document.getElementById("reconnectText");
  const btnCancelReconnect = document.getElementById("btnCancelReconnect");

  // Orientation / Crop / Fullscreen / VSync controls
  const btnCropLandscape = document.getElementById("btnCropLandscape");
  const btnRotate = document.getElementById("btnRotate");
  const btnScaleMode = document.getElementById("btnScaleMode");
  const btnFullscreen = document.getElementById("btnFullscreen");
  const btnVsyncMode = document.getElementById("btnVsyncMode");
  const btnQuickCinema = document.getElementById("btnQuickCinema");
  const btnFloatCrop = document.getElementById("btnFloatCrop");
  const btnFloatRotate = document.getElementById("btnFloatRotate");
  const btnFloatScale = document.getElementById("btnFloatScale");
  const btnFloatExitFs = document.getElementById("btnFloatExitFs");

  const sliderBitrate = document.getElementById("sliderBitrate");
  const lblBitrateVal = document.getElementById("lblBitrateVal");
  const presetChips = document.querySelectorAll(".btn-chip");
  const btnForceIdr = document.getElementById("btnForceIdr");
  const btnNativeFfplay = document.getElementById("btnNativeFfplay");
  const btnSimulator = document.getElementById("btnSimulator");
  const btnSimFps60 = document.getElementById("btnSimFps60");
  const btnSimFps120 = document.getElementById("btnSimFps120");
  const btnSimFps144 = document.getElementById("btnSimFps144");
  const viewportContainer = document.getElementById("viewportContainer");

  // Log Modal Elements
  const btnViewLogs = document.getElementById("btnViewLogs");
  const logModal = document.getElementById("logModal");
  const btnRefreshLogs = document.getElementById("btnRefreshLogs");
  const btnCloseLogs = document.getElementById("btnCloseLogs");
  const logContent = document.getElementById("logContent");

  // Audio Controls & Telemetry
  const hudAudioMetric = document.getElementById("hudAudioMetric");
  const hudAudioStatus = document.getElementById("hudAudioStatus");
  const btnToggleAudio = document.getElementById("btnToggleAudio");
  const sliderVolume = document.getElementById("sliderVolume");
  const lblVolumeVal = document.getElementById("lblVolumeVal");
  const btnFloatAudio = document.getElementById("btnFloatAudio");

  let audioCtx = null;
  let gainNode = null;
  let audioWorkletNode = null;
  let isWorkletInitializing = false;
  let isAudioMuted = false;
  let audioVolume = 1.0;
  let nextAudioPlayTime = 0;
  let clientLogStreak = 0;
  let discoveredPhone = null;

  function reportClientLog(level, message) {
    if (clientLogStreak++ > 300) return;
    try {
      fetch("/api/client-log", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ level, message }),
      }).catch(() => {});
    } catch (_) {}
  }

  const workletProcessorCode = `
    class HyperAudioProcessor extends AudioWorkletProcessor {
      constructor() {
        super();
        // 96,000 samples capacity = 2 seconds at 48kHz, handles any packet chunk size or burst
        this.capacity = 96000;
        this.bufL = new Float32Array(this.capacity);
        this.bufR = new Float32Array(this.capacity);
        this.writePos = 0;
        this.readPos = 0;
        this.available = 0;

        // 25ms Dynamic Jitter Buffer scaled to AudioContext native sampleRate
        // 25ms @ 48kHz = 1200 samples, @ 44.1kHz = 1102 samples, @ 96kHz = 2400 samples
        this.targetSamples = Math.round(sampleRate * 0.025);
        this.maxSamples = Math.round(sampleRate * 0.050); // 50ms Maximum Latency Clamp

        this.port.onmessage = (e) => {
          if (e.data && e.data.type === "flush") {
            this.writePos = 0;
            this.readPos = 0;
            this.available = 0;
            return;
          }

          const { left, right } = e.data;
          const len = left.length;
          if (len === 0) return;

          for (let i = 0; i < len; i++) {
            this.bufL[this.writePos] = left[i];
            this.bufR[this.writePos] = right[i];
            this.writePos = (this.writePos + 1) % this.capacity;
          }
          this.available = Math.min(this.capacity - 1, this.available + len);

          // Latency Clamp: if audio backlog builds up beyond 50ms (e.g. Wi-Fi packet jitter burst):
          // Smoothly crossfade over 32 samples across the skip point to completely eliminate CLICK / POP!
          if (this.available > this.maxSamples) {
            const excess = this.available - this.targetSamples;
            const crossfadeLen = Math.min(32, this.targetSamples);
            const oldRead = this.readPos;
            const newRead = (oldRead + excess) % this.capacity;
            for (let i = 0; i < crossfadeLen; i++) {
              const alpha = i / crossfadeLen;
              const pOld = (oldRead + i) % this.capacity;
              const pNew = (newRead + i) % this.capacity;
              this.bufL[pNew] = this.bufL[pOld] * (1 - alpha) + this.bufL[pNew] * alpha;
              this.bufR[pNew] = this.bufR[pOld] * (1 - alpha) + this.bufR[pNew] * alpha;
            }
            this.readPos = newRead;
            this.available = this.targetSamples;
          }
        };
      }

      process(inputs, outputs) {
        const out = outputs[0];
        const outL = out[0];
        const outR = out[1];
        const n = outL.length; // 128 samples

        const toCopy = Math.min(this.available, n);
        for (let i = 0; i < toCopy; i++) {
          outL[i] = this.bufL[this.readPos];
          outR[i] = this.bufR[this.readPos];
          this.readPos = (this.readPos + 1) % this.capacity;
        }
        this.available -= toCopy;

        if (toCopy < n) {
          // If buffer underrun occurs (e.g. Wi-Fi packet drop):
          // Smoothly ramp trailing samples down over 8 samples to 0 to prevent harsh click/pop!
          if (toCopy > 0) {
            const rampLen = Math.min(8, toCopy);
            for (let i = 0; i < rampLen; i++) {
              const gain = (rampLen - 1 - i) / rampLen;
              outL[toCopy - rampLen + i] *= gain;
              outR[toCopy - rampLen + i] *= gain;
            }
          }
          outL.fill(0, toCopy);
          outR.fill(0, toCopy);
        }
        return true;
      }
    }
    registerProcessor("hyper-audio-processor", HyperAudioProcessor);
  `;

  async function initAudioContext() {
    if (audioCtx) return audioCtx;
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) return null;

    try {
      try {
        audioCtx = new AudioContextClass({ latencyHint: "interactive", sampleRate: 48000 });
      } catch (_) {
        // Fallback: If 48kHz fixed sampleRate is rejected by browser/OS audio driver, use native rate
        audioCtx = new AudioContextClass({ latencyHint: "interactive" });
      }

      gainNode = audioCtx.createGain();
      gainNode.gain.setValueAtTime(isAudioMuted ? 0 : audioVolume, audioCtx.currentTime);
      gainNode.connect(audioCtx.destination);
      reportClientLog("INFO", `WebAudio AudioContext created (state=${audioCtx.state}, sampleRate=${audioCtx.sampleRate})`);

      audioCtx.onstatechange = () => {
        reportClientLog("INFO", `AudioContext state changed: ${audioCtx.state}`);
        updateAudioUI();
        if (audioCtx.state === "running" && audioWorkletNode) {
          audioWorkletNode.port.postMessage({ type: "flush" });
        }
      };

      if ("audioWorklet" in audioCtx && !audioWorkletNode && !isWorkletInitializing) {
        isWorkletInitializing = true;
        const blob = new Blob([workletProcessorCode], { type: "application/javascript" });
        const blobUrl = URL.createObjectURL(blob);
        audioCtx.audioWorklet.addModule(blobUrl)
          .then(() => {
            URL.revokeObjectURL(blobUrl);
            audioWorkletNode = new AudioWorkletNode(audioCtx, "hyper-audio-processor", {
              outputChannelCount: [2],
            });
            audioWorkletNode.connect(gainNode);
            reportClientLog("INFO", `AudioWorklet Zero-Latency Engine activated (<25ms jitter buffer, nativeRate=${audioCtx.sampleRate})`);
          })
          .catch((err) => {
            reportClientLog("WARN", `AudioWorklet addModule error: ${err.message}, using fallback`);
            audioWorkletNode = null;
          })
          .finally(() => {
            isWorkletInitializing = false;
          });
      }
    } catch (e) {
      reportClientLog("ERROR", `Failed creating AudioContext: ${e.message}`);
    }
    return audioCtx;
  }

  function ensureAudioRunning() {
    initAudioContext();
    if (audioCtx && audioCtx.state === "suspended") {
      audioCtx.resume().then(() => {
        reportClientLog("INFO", "AudioContext resumed to RUNNING state via user gesture");
        nextAudioPlayTime = audioCtx.currentTime + 0.02;
        updateAudioUI();
      }).catch((e) => {
        reportClientLog("WARN", `AudioContext resume failed: ${e.message}`);
      });
    }
  }

  function updateAudioUI() {
    const volPercent = Math.round(audioVolume * 100);
    if (lblVolumeVal) lblVolumeVal.textContent = `${volPercent}%`;
    if (sliderVolume) sliderVolume.value = volPercent;

    const rateHint = audioCtx && audioCtx.sampleRate !== 48000 ? ` (${(audioCtx.sampleRate / 1000).toFixed(1)}k)` : "";

    if (isAudioMuted || audioVolume === 0) {
      if (hudAudioStatus) {
        hudAudioStatus.textContent = "🔇 TẮT";
        hudAudioStatus.className = "highlight-gray";
      }
      if (btnToggleAudio) btnToggleAudio.textContent = "🔇 Đã tắt tiếng (M)";
      if (btnFloatAudio) btnFloatAudio.textContent = "🔇 Bật tiếng (M)";
    } else if (audioCtx && audioCtx.state === "suspended") {
      if (hudAudioStatus) {
        hudAudioStatus.textContent = "🔇 CLICK ĐỂ BẬT";
        hudAudioStatus.className = "highlight-yellow";
      }
      if (btnToggleAudio) btnToggleAudio.textContent = "🔇 Click bật tiếng (M)";
      if (btnFloatAudio) btnFloatAudio.textContent = "🔇 Click bật tiếng (M)";
    } else {
      if (hudAudioStatus) {
        hudAudioStatus.textContent = `🔊 ${volPercent}%${rateHint}`;
        hudAudioStatus.className = "highlight-cyan";
      }
      if (btnToggleAudio) btnToggleAudio.textContent = `🔊 Đang bật (M)${rateHint}`;
      if (btnFloatAudio) btnFloatAudio.textContent = "🔊 Tắt tiếng (M)";
    }
  }

  function toggleAudioMute() {
    ensureAudioRunning();
    isAudioMuted = !isAudioMuted;
    if (gainNode && audioCtx) {
      gainNode.gain.setValueAtTime(isAudioMuted ? 0 : audioVolume, audioCtx.currentTime);
    }
    updateAudioUI();
    setToast(isAudioMuted ? "Đã tắt âm thanh máy khách (Muted)." : `Đã bật âm thanh máy khách (${Math.round(audioVolume * 100)}%).`);
  }

  function setAudioVolume(volPercent) {
    ensureAudioRunning();
    audioVolume = Math.max(0, Math.min(100, volPercent)) / 100;
    if (audioVolume > 0) {
      isAudioMuted = false;
    }
    if (gainNode && audioCtx) {
      gainNode.gain.setValueAtTime(isAudioMuted ? 0 : audioVolume, audioCtx.currentTime);
    }
    updateAudioUI();
  }

  // High-precision linear resampler with fractional phase accumulator
  function resampleStereo(leftIn, rightIn, inRate, outRate) {
    if (inRate === outRate || Math.abs(inRate - outRate) < 5) {
      return { left: leftIn, right: rightIn };
    }
    const ratio = inRate / outRate;
    const inLen = leftIn.length;
    const outLen = Math.floor(inLen / ratio);
    if (outLen <= 0) return { left: leftIn, right: rightIn };
    const leftOut = new Float32Array(outLen);
    const rightOut = new Float32Array(outLen);
    for (let i = 0; i < outLen; i++) {
      const srcPos = i * ratio;
      const idx0 = Math.floor(srcPos);
      const idx1 = Math.min(idx0 + 1, inLen - 1);
      const frac = srcPos - idx0;
      leftOut[i] = leftIn[idx0] * (1 - frac) + leftIn[idx1] * frac;
      rightOut[i] = rightIn[idx0] * (1 - frac) + rightIn[idx1] * frac;
    }
    return { left: leftOut, right: rightOut };
  }

  function handleAudioPacket(view, arrayBuffer) {
    const senderSampleRate = view.getUint32(10, false) || 48000;
    const payloadOffset = 14;
    const payloadByteLen = arrayBuffer.byteLength - payloadOffset;
    if (payloadByteLen < 4) return;

    if (!audioCtx) initAudioContext();
    if (!audioCtx) return;

    // Auto-attempt resume if browser suspended audio
    if (audioCtx.state === "suspended") {
      audioCtx.resume().catch(() => {});
      updateAudioUI();
      return;
    }

    // 16-bit PCM stereo (Little Endian): 4 bytes per frame (2 bytes Left, 2 bytes Right)
    const numFrames = Math.floor(payloadByteLen / 4);
    if (numFrames === 0) return;

    const int16 = new Int16Array(arrayBuffer, payloadOffset, numFrames * 2);
    let left = new Float32Array(numFrames);
    let right = new Float32Array(numFrames);

    for (let i = 0; i < numFrames; i++) {
      left[i] = int16[i * 2] / 32768.0;
      right[i] = int16[i * 2 + 1] / 32768.0;
    }

    // Handle Sample Rate Mismatch:
    // If phone sends 48kHz but AudioContext runs at 44.1kHz or 96kHz, resample seamlessly!
    const ctxRate = audioCtx.sampleRate || 48000;
    if (senderSampleRate !== ctxRate) {
      const resampled = resampleStereo(left, right, senderSampleRate, ctxRate);
      left = resampled.left;
      right = resampled.right;
    }

    if (audioWorkletNode) {
      audioWorkletNode.port.postMessage({ left, right }, [left.buffer, right.buffer]);
    } else {
      // Ultra-Low-Latency Fallback (Locked to 20-50ms)
      const audioBuf = audioCtx.createBuffer(2, left.length, ctxRate);
      audioBuf.copyToChannel(left, 0);
      audioBuf.copyToChannel(right, 1);

      const now = audioCtx.currentTime;
      const TARGET_LATENCY_SEC = 0.025; // 25ms target
      if (nextAudioPlayTime < now || nextAudioPlayTime > now + 0.050) {
        nextAudioPlayTime = now + TARGET_LATENCY_SEC;
      }

      const source = audioCtx.createBufferSource();
      source.buffer = audioBuf;
      source.connect(gainNode);
      source.start(nextAudioPlayTime);

      nextAudioPlayTime += audioBuf.duration;
    }
  }

  let videoDecoder = null;
  let activeCodecId = 0;
  let detectedSpsCodecString = "avc1.42e01f";
  let cachedConfigBytes = null;
  let waitingForKeyFrame = true;
  let lastWebCodecsFrameTime = 0;
  let lastIdrRequestTime = 0;
  let isRenderingBitmap = false;
  // If the GPU decoder refuses this profile (or WebCodecs is missing), switch
  // to the server MJPEG fallback instead of retrying forever.
  let useJpegFallback = !("VideoDecoder" in window);
  let decoderErrorStreak = 0;

  // Viewport Transform State
  let cropLandscape16x9 = false;
  let rotationDeg = 0;
  const scaleModes = ["contain", "cover", "fill"];
  const scaleLabels = ["Vừa khít (Z)", "Lấp đầy (Z)", "1920×1080 (Z)"];
  let scaleIndex = 0;

  // Telemetry accumulators
  let frameCountWindow = 0;
  let byteCountWindow = 0;
  let encodeUsWindow = 0;
  let decodeMsWindow = 0;
  let lastStatTime = performance.now();
  const pendingDecodeTimestamps = new Map();

  function setToast(msg) {
    if (connectionToast) connectionToast.textContent = msg;
  }

  function requestIdrThrottled() {
    const now = performance.now();
    if (now - lastIdrRequestTime > 600) {
      lastIdrRequestTime = now;
      fetch("/api/request-idr", { method: "POST" }).catch(() => {});
    }
  }

  let lastCanvasW = 0;
  let lastCanvasH = 0;

  function drawVideoSourceToCanvas(source, rawW, rawH) {
    let sx = 0;
    let sy = 0;
    let sw = rawW;
    let sh = rawH;

    if (cropLandscape16x9 && rawH > rawW) {
      sh = Math.round((rawW * 9) / 16);
      sy = Math.max(0, Math.round((rawH - sh) / 2));
    } else if (cropLandscape16x9 && rawW > rawH) {
      const targetH = Math.round((rawW * 9) / 16);
      if (targetH < rawH) {
        sh = targetH;
        sy = Math.round((rawH - sh) / 2);
      }
    }

    const isRotated90 = rotationDeg === 90 || rotationDeg === 270;
    const outW = cropLandscape16x9 ? 1920 : isRotated90 ? sh : sw;
    const outH = cropLandscape16x9 ? 1080 : isRotated90 ? sw : sh;

    if (lastCanvasW !== outW || lastCanvasH !== outH) {
      canvas.width = outW;
      canvas.height = outH;
      lastCanvasW = outW;
      lastCanvasH = outH;
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "medium";
    }

    // Fast path: direct draw for standard unrotated, uncropped view
    if (rotationDeg === 0 && !cropLandscape16x9 && sw === outW && sh === outH) {
      ctx.drawImage(source, 0, 0, outW, outH);
      return;
    }

    ctx.save();
    if (rotationDeg === 0) {
      ctx.drawImage(source, sx, sy, sw, sh, 0, 0, outW, outH);
    } else {
      ctx.translate(outW / 2, outH / 2);
      ctx.rotate((rotationDeg * Math.PI) / 180);
      if (isRotated90) {
        ctx.drawImage(source, sx, sy, sw, sh, -outH / 2, -outW / 2, outH, outW);
      } else {
        ctx.drawImage(source, sx, sy, sw, sh, -outW / 2, -outH / 2, outW, outH);
      }
    }
    ctx.restore();
  }

  // VSync-Synchronized Render Loop (prevents tearing on 120Hz/144Hz displays)
  let vsyncMode = true;
  let latestVideoFrame = null;
  let monitorRefreshRate = 0;
  let rafFpsSamples = [];
  let lastRafTime = 0;

  function startVsyncRenderLoop() {
    function onRaf(timestamp) {
      if (lastRafTime > 0) {
        const dt = timestamp - lastRafTime;
        if (dt > 3 && dt < 40) {
          rafFpsSamples.push(1000 / dt);
          if (rafFpsSamples.length > 30) {
            rafFpsSamples.shift();
            const avgHz = Math.round(
              rafFpsSamples.reduce((a, b) => a + b, 0) / rafFpsSamples.length
            );
            if (avgHz >= 45 && avgHz <= 360) {
              monitorRefreshRate = avgHz;
              if (hudMonitorHz) {
                hudMonitorHz.textContent = `${avgHz}Hz (${vsyncMode ? "VSync" : "Direct"})`;
              }
            }
          }
        }
      }
      lastRafTime = timestamp;

      if (vsyncMode && latestVideoFrame) {
        const frameToDraw = latestVideoFrame;
        latestVideoFrame = null;
        drawVideoSourceToCanvas(frameToDraw, frameToDraw.displayWidth, frameToDraw.displayHeight);
        frameToDraw.close();
      }

      requestAnimationFrame(onRaf);
    }
    requestAnimationFrame(onRaf);
  }

  function toggleVsyncMode() {
    vsyncMode = !vsyncMode;
    if (btnVsyncMode) {
      btnVsyncMode.textContent = vsyncMode
        ? "🖥️ VSync 120/144Hz: BẬT (0 Xé hình) (V)"
        : "⚡ Chế độ: Direct Blit (Cực thấp ms) (V)";
      btnVsyncMode.classList.toggle("active", vsyncMode);
    }
    if (hudMonitorHz) {
      const hzStr = monitorRefreshRate ? `${monitorRefreshRate}Hz` : "-- Hz";
      hudMonitorHz.textContent = `${hzStr} (${vsyncMode ? "VSync" : "Direct"})`;
    }
    setToast(
      vsyncMode
        ? "Đã bật VSync 120Hz/144Hz: Khóa theo tần số quét màn hình, triệt tiêu xé hình!"
        : "Đã bật Direct Blit: Vẽ tức thì không chờ VSync (độ trễ tuyệt đối thấp nhất)."
    );
  }

  function toggleCropLandscape() {
    cropLandscape16x9 = !cropLandscape16x9;
    if (btnCropLandscape) {
      btnCropLandscape.classList.toggle("active", cropLandscape16x9);
      btnCropLandscape.textContent = cropLandscape16x9
        ? "✂️ Đang Cắt Viền 16:9 (C)"
        : "✂️ Cắt Viền Đen 16:9 (C)";
    }
    if (btnFloatCrop) {
      btnFloatCrop.textContent = cropLandscape16x9
        ? "✂️ Tắt Cắt Viền (C)"
        : "✂️ Cắt Viền Đen (C)";
    }
    setToast(
      cropLandscape16x9
        ? "Đã bật Cắt Viền Đen 16:9: Khung game ngang được phóng chuẩn 1920×1080!"
        : "Đã tắt Cắt Viền Đen 16:9 (hiển thị khung gốc)."
    );
  }

  function rotateCanvas90() {
    rotationDeg = (rotationDeg + 90) % 360;
    if (btnRotate) {
      btnRotate.textContent = `🔄 Xoay 90° (${rotationDeg}°)`;
    }
    if (btnFloatRotate) {
      btnFloatRotate.textContent = `🔄 Xoay (${rotationDeg}°)`;
    }
    setToast(`Đã xoay khung hình sang ${rotationDeg}°.`);
  }

  function cycleScaleMode() {
    scaleIndex = (scaleIndex + 1) % scaleModes.length;
    canvas.classList.remove("scale-cover", "scale-fill");
    if (scaleModes[scaleIndex] === "cover") {
      canvas.classList.add("scale-cover");
    } else if (scaleModes[scaleIndex] === "fill") {
      canvas.classList.add("scale-fill");
    }
    if (btnScaleMode) {
      btnScaleMode.textContent = `⤢ Khung: ${scaleLabels[scaleIndex]}`;
    }
    setToast(`Chế độ khung hình: ${scaleLabels[scaleIndex]}`);
  }

  function toggleTrueFullscreen() {
    if (!document.fullscreenElement) {
      document.body.classList.add("cinema-mode");
      viewportContainer.requestFullscreen().catch(() => {});
    } else {
      document.exitFullscreen().catch(() => {});
      document.body.classList.remove("cinema-mode");
    }
  }

  document.addEventListener("fullscreenchange", () => {
    if (!document.fullscreenElement) {
      document.body.classList.remove("cinema-mode");
    }
  });

  /**
   * Parse Annex-B buffer to inspect NAL units:
   * - Updates `detectedSpsCodecString` ONLY when an actual SPS (NAL type 7) is found
   * - Checks for SPS/PPS config, IDR KeyFrame slice (NAL 5 / HEVC 19..21), or Non-IDR VCL slice (NAL 1 / HEVC 0..9)
   */
  function inspectAnnexBNals(u8, codecId) {
    let hasConfig = false;
    let hasIdr = false;
    let hasSlice = false;

    for (let i = 0; i < u8.length - 4; i++) {
      let scLen = 0;
      if (u8[i] === 0 && u8[i + 1] === 0 && u8[i + 2] === 1) {
        scLen = 3;
      } else if (
        u8[i] === 0 &&
        u8[i + 1] === 0 &&
        u8[i + 2] === 0 &&
        u8[i + 3] === 1
      ) {
        scLen = 4;
      }
      if (scLen === 0) continue;

      const hdrIdx = i + scLen;
      if (hdrIdx >= u8.length) break;

      if (codecId === 2) {
        // H.265 HEVC NAL unit type
        const hevcType = (u8[hdrIdx] >> 1) & 0x3f;
        if (hevcType === 32 || hevcType === 33 || hevcType === 34) {
          hasConfig = true;
        } else if (hevcType >= 16 && hevcType <= 21) {
          hasIdr = true;
          hasSlice = true;
        } else if (hevcType >= 0 && hevcType <= 9) {
          hasSlice = true;
        }
      } else {
        // H.264 AVC NAL unit type
        const avcType = u8[hdrIdx] & 0x1f;
        if (avcType === 7) {
          hasConfig = true;
          if (hdrIdx + 3 < u8.length) {
            const profile = u8[hdrIdx + 1].toString(16).padStart(2, "0");
            const compat = u8[hdrIdx + 2].toString(16).padStart(2, "0");
            const level = u8[hdrIdx + 3].toString(16).padStart(2, "0");
            detectedSpsCodecString = `avc1.${profile}${compat}${level}`;
          }
        } else if (avcType === 8) {
          hasConfig = true;
        } else if (avcType === 5) {
          hasIdr = true;
          hasSlice = true;
        } else if (avcType >= 1 && avcType <= 4) {
          hasSlice = true;
        }
      }
      i += scLen - 1;
    }

    return { hasConfig, hasIdr, hasSlice };
  }

  let currentConfiguredCodec = "";

  function ensureHardwareDecoder(codecId) {
    if (!("VideoDecoder" in window)) {
      return false;
    }

    // If already configured for this codec AND codec string matches detected SPS (or default), keep it!
    if (
      videoDecoder &&
      videoDecoder.state === "configured" &&
      activeCodecId === codecId &&
      (!detectedSpsCodecString || currentConfiguredCodec === detectedSpsCodecString)
    ) {
      return true;
    }

    try {
      if (videoDecoder && videoDecoder.state !== "closed") {
        videoDecoder.close();
      }
    } catch (_) {}

    videoDecoder = new VideoDecoder({
      output: (frame) => {
        const now = performance.now();
        lastWebCodecsFrameTime = now;
        decoderErrorStreak = 0;
        const startT = pendingDecodeTimestamps.get(frame.timestamp);
        if (startT !== undefined) {
          decodeMsWindow += now - startT;
          pendingDecodeTimestamps.delete(frame.timestamp);
        }

        emptyOverlay.classList.add("hidden");
        frameCountWindow++;

        if (vsyncMode) {
          // VSync Latch: Lock to monitor scanout boundary to eliminate screen tearing!
          if (latestVideoFrame) {
            latestVideoFrame.close();
          }
          latestVideoFrame = frame;
        } else {
          // Direct Blit Mode (Immediate)
          drawVideoSourceToCanvas(frame, frame.displayWidth, frame.displayHeight);
          frame.close();
        }
      },
      error: (err) => {
        console.warn("[WebCodecs decode error]", err);
        waitingForKeyFrame = true;
        pendingDecodeTimestamps.clear();
        try {
          if (videoDecoder && videoDecoder.state !== "closed") videoDecoder.close();
        } catch (_) {}
        videoDecoder = null;
        activeCodecId = 0;
        currentConfiguredCodec = "";
        decoderErrorStreak++;
        if (decoderErrorStreak >= 2 && !useJpegFallback) {
          useJpegFallback = true;
          setToast(
            "GPU WebCodecs không hỗ trợ profile này — đã chuyển sang chế độ giải mã JPEG dự phòng."
          );
          try {
            currentWs.close();
          } catch (_) {}
          scheduleReconnect(200);
          return;
        }
        lastWebCodecsFrameTime = 0;
        requestIdrThrottled();
      },
    });

    const candidates =
      codecId === 2
        ? [
            "hev1.1.6.L156.90", // HEVC Level 5.2 (120/144Hz high refresh rate gaming)
            "hev1.1.6.L153.90", // HEVC Level 5.1 (120Hz)
            "hev1.1.6.L120.90", // HEVC Level 4.0
            "hvc1.1.6.L156.90",
            "hvc1.1.6.L153.90",
            "hvc1.1.6.L120.90",
          ]
        : [
            detectedSpsCodecString, // From SPS: e.g. avc1.640034 (144Hz) or avc1.640033 (120Hz)
            "avc1.640034", // H.264 High Profile Level 5.2 (144Hz/172Hz 1080p)
            "avc1.640033", // H.264 High Profile Level 5.1 (120Hz 1080p)
            "avc1.64002a", // H.264 High Profile Level 4.2
            "avc1.4d4034", // H.264 Main Profile Level 5.2
            "avc1.4d4033", // H.264 Main Profile Level 5.1
            "avc1.4d402a", // H.264 Main Profile Level 4.2
            "avc1.42e034", // H.264 Baseline Level 5.2
            "avc1.42e033", // H.264 Baseline Level 5.1
            "avc1.42e01f", // H.264 Baseline Level 3.1
          ];

    for (const c of candidates) {
      if (!c) continue;
      try {
        videoDecoder.configure({
          codec: c,
          optimizeForLatency: true,
          hardwareAcceleration: "prefer-hardware",
        });
        activeCodecId = codecId;
        currentConfiguredCodec = c;
        waitingForKeyFrame = true;
        return true;
      } catch (_) {
        try {
          videoDecoder.configure({
            codec: c,
            optimizeForLatency: true,
          });
          activeCodecId = codecId;
          currentConfiguredCodec = c;
          waitingForKeyFrame = true;
          return true;
        } catch (_) {}
      }
    }

    return false;
  }

  async function renderUniversalJpegFrame(jpegBytes, encodeDurationUs) {
    if (performance.now() - lastWebCodecsFrameTime < 300) {
      return;
    }
    if (isRenderingBitmap) return;
    isRenderingBitmap = true;
    const t0 = performance.now();
    try {
      const blob = new Blob([jpegBytes], { type: "image/jpeg" });
      const bmp = await createImageBitmap(blob);
      drawVideoSourceToCanvas(bmp, bmp.width, bmp.height);
      bmp.close();

      emptyOverlay.classList.add("hidden");
      frameCountWindow++;
      encodeUsWindow += encodeDurationUs;
      decodeMsWindow += performance.now() - t0;
    } catch (_) {
    } finally {
      isRenderingBitmap = false;
    }
  }

  function handleBinaryVideoPacket(arrayBuffer) {
    if (arrayBuffer.byteLength <= 14) return;
    const view = new DataView(arrayBuffer);
    const frameType = view.getUint8(0); // 1=Config, 2=Keyframe, 3=Normal, 5=Universal JPEG, 6=Audio
    const codecId = view.getUint8(1); // 1=H264, 2=H265
    const ptsUs = Number(view.getBigInt64(2, false));
    const encodeDurationUs = view.getUint32(10, false);
    const payloadBytes = new Uint8Array(arrayBuffer, 14);

    if (frameType === 6) {
      handleAudioPacket(view, arrayBuffer);
      return;
    }

    if (frameType === 5) {
      byteCountWindow += payloadBytes.byteLength;
      renderUniversalJpegFrame(payloadBytes, encodeDurationUs);
      return;
    }

    // GPU path unavailable/failed: ignore raw H.264 packets (MJPEG will arrive).
    if (useJpegFallback) return;

    byteCountWindow += payloadBytes.byteLength;
    encodeUsWindow += encodeDurationUs;

    const nalInfo = inspectAnnexBNals(payloadBytes, codecId);

    // If packet is pure SPS/PPS config without any VCL video slice, cache it and do NOT call decode()!
    if (frameType === 1 || (nalInfo.hasConfig && !nalInfo.hasSlice)) {
      cachedConfigBytes = new Uint8Array(payloadBytes);
      ensureHardwareDecoder(codecId);
      return;
    }

    // Ignore non-VCL packets (e.g. standalone SEI or AUD) so VideoDecoder never throws
    if (!nalInfo.hasSlice && frameType !== 2 && frameType !== 3) {
      return;
    }

    if (!ensureHardwareDecoder(codecId)) return;

    if (videoDecoder && videoDecoder.decodeQueueSize > 4) {
      waitingForKeyFrame = true;
      requestIdrThrottled();
      return;
    }

    const isKey = frameType === 2 || nalInfo.hasIdr;
    if (waitingForKeyFrame && !isKey) {
      requestIdrThrottled();
      return;
    }

    let chunkData = payloadBytes;
    if (isKey) {
      waitingForKeyFrame = false;
      if (cachedConfigBytes && !nalInfo.hasConfig) {
        const merged = new Uint8Array(
          cachedConfigBytes.byteLength + payloadBytes.byteLength
        );
        merged.set(cachedConfigBytes, 0);
        merged.set(payloadBytes, cachedConfigBytes.byteLength);
        chunkData = merged;
      }
    }

    try {
      pendingDecodeTimestamps.set(ptsUs, performance.now());
      if (pendingDecodeTimestamps.size > 120) {
        pendingDecodeTimestamps.clear();
      }

      const chunk = new EncodedVideoChunk({
        type: isKey ? "key" : "delta",
        timestamp: ptsUs,
        data: chunkData,
      });
      videoDecoder.decode(chunk);
    } catch (_) {
      waitingForKeyFrame = true;
      requestIdrThrottled();
    }
  }

  function updateStatusUI(meta) {
    if (meta.connected) {
      hudStatusDot.classList.add("online");
      hudStatusText.textContent = `LIVE • ${meta.deviceName || "Android"}`;
    } else {
      hudStatusDot.classList.remove("online");
      hudStatusText.textContent = "ĐANG CHỜ KẾT NỐI";
    }
    hudCodec.textContent = `${meta.codec || "H.264"} • ${meta.width}×${meta.height} @ ${meta.targetFps}Hz`;
  }

  setInterval(() => {
    const now = performance.now();
    const elapsedSec = (now - lastStatTime) / 1000;
    if (elapsedSec <= 0) return;

    const fps = Math.round(frameCountWindow / elapsedSec);
    const mbps = ((byteCountWindow * 8) / elapsedSec / 1_000_000).toFixed(1);
    const avgEncodeMs =
      frameCountWindow > 0
        ? (encodeUsWindow / frameCountWindow / 1000).toFixed(2)
        : "0.00";
    const avgDecodeMs =
      frameCountWindow > 0
        ? (decodeMsWindow / frameCountWindow).toFixed(2)
        : "0.00";

    hudFps.textContent = `${fps} FPS`;
    hudBitrate.textContent = `${mbps} Mbps`;
    hudEncodeMs.textContent = `${avgEncodeMs} ms`;
    hudDecodeMs.textContent = `${avgDecodeMs} ms`;

    frameCountWindow = 0;
    byteCountWindow = 0;
    encodeUsWindow = 0;
    decodeMsWindow = 0;
    lastStatTime = now;
  }, 500);

  let currentWs = null;
  let reconnectTimer = null;
  let wsReconnectAttempts = 0;

  function scheduleReconnect(immediate = false) {
    if (reconnectTimer) return;
    if (immediate) {
      connectWebSocket();
      return;
    }
    // Exponential backoff: 500ms, 1s, 2s, 4s, 8s, up to 10s max + jitter
    const base = Math.min(10000, 500 * Math.pow(1.5, Math.min(wsReconnectAttempts, 8)));
    const jitter = Math.floor(Math.random() * 300);
    const delay = Math.round(base + jitter);
    wsReconnectAttempts++;

    setToast(`Mất kết nối với máy chủ PC. Đang thử lại sau ${(delay / 1000).toFixed(1)}s (lần ${wsReconnectAttempts})...`);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connectWebSocket();
    }, delay);
  }

  function connectWebSocket() {
    // Never leave a half-open socket behind (our minimal server does not
    // acknowledge the WS close handshake, so onclose can take ~30s).
    if (currentWs) {
      try {
        currentWs.onclose = null;
        currentWs.close();
      } catch (_) {}
      currentWs = null;
    }

    const proto = location.protocol === "https:" ? "wss" : "ws";
    const wantJpeg = useJpegFallback ? 1 : 0;
    const ws = new WebSocket(
      `${proto}://${location.host}/?jpeg=${wantJpeg}&t=${Date.now()}`
    );
    ws.binaryType = "arraybuffer";
    currentWs = ws;

    ws.onopen = () => {
      wsReconnectAttempts = 0;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      reportClientLog("INFO", "WebSocket connected to PC receiver");
    };

    ws.onmessage = (ev) => {
      if (typeof ev.data === "string") {
        try {
          const msg = JSON.parse(ev.data);
          if (msg.type === "status" && msg.meta) {
            updateStatusUI(msg.meta);
          } else if (msg.type === "phone_discovered") {
            if (discoveredPhoneCard) {
              discoveredPhone = { host: msg.host, port: msg.port, name: msg.deviceName };
              if (discPhoneName) discPhoneName.textContent = msg.deviceName || "Thiết bị Android";
              if (discPhoneIp) discPhoneIp.textContent = `${msg.host}:${msg.port}`;
              discoveredPhoneCard.style.display = "flex";
            }
          } else if (msg.type === "reconnect_status") {
            if (reconnectBanner) {
              if (msg.reconnecting) {
                reconnectBanner.style.display = "flex";
                const sec = msg.delayMs ? (msg.delayMs / 1000).toFixed(1) : "vài";
                if (reconnectText) {
                  reconnectText.textContent = `🔄 Đang tự động kết nối lại ${msg.target}:${msg.port} sau ${sec}s (lần ${msg.attempt})...`;
                }
              } else {
                reconnectBanner.style.display = "none";
              }
            }
          } else if (msg.type === "simulator") {
            btnSimulator.classList.toggle("active", Boolean(msg.active));
            btnSimulator.textContent = msg.active
              ? `⏹ Dừng Luồng Giả Lập ${msg.fps || simSelectedFps}FPS H.264`
              : "🎮 Chạy Luồng Giả Lập H.264 (Test Ngay Trên PC)";
          } else if (msg.type === "ffplay") {
            btnNativeFfplay.textContent = msg.active
              ? "⏹ Đóng cửa sổ Native Direct3D (FFplay)"
              : "🚀 Mở cửa sổ Native Direct3D (FFplay Zero-Buffer)";
          }
        } catch (_) {}
      } else if (ev.data instanceof ArrayBuffer) {
        handleBinaryVideoPacket(ev.data);
      }
    };

    ws.onclose = () => {
      if (currentWs === ws) currentWs = null;
      scheduleReconnect();
    };
  }

  async function loadServerInfo() {
    try {
      const res = await fetch("/api/info");
      const info = await res.json();
      streamPortEl.textContent = info.streamPort;
      if (info.lanIps && info.lanIps.length > 0) {
        const primary = info.lanIps[0].address;
        const others = info.lanIps.slice(1).map((i) => i.address).join(", ");
        pcLanIp.textContent = primary + (others ? ` (phụ: ${others})` : "");
      } else {
        pcLanIp.textContent = "127.0.0.1 (USB Mode)";
      }
      if (info.meta) {
        updateStatusUI(info.meta);
      }
      if (info.reconnectStatus && info.reconnectStatus.reconnecting && reconnectBanner) {
        reconnectBanner.style.display = "flex";
        if (reconnectText) {
          reconnectText.textContent = `🔄 Đang tự động kết nối lại ${info.reconnectStatus.target}:${info.reconnectStatus.port}...`;
        }
      }
    } catch (_) {}
  }

  btnUsbAdb.addEventListener("click", async () => {
    setToast("Đang thiết lập đường truyền cáp USB (ADB Forward/Reverse)...");
    const res = await fetch("/api/usb-adb", { method: "POST" });
    const data = await res.json();
    setToast(data.message);
  });

  if (btnInstallApk) {
    btnInstallApk.addEventListener("click", async () => {
      setToast("Đang cài đặt HyperMirrorSender-debug.apk lên điện thoại qua cáp USB...");
      const res = await fetch("/api/install-apk", { method: "POST" });
      const data = await res.json();
      setToast(data.message);
    });
  }

  btnConnectPhone.addEventListener("click", async () => {
    const host = inputPhoneIp.value.trim() || "127.0.0.1";
    setToast(`Đang kết nối tới ${host}...`);
    const res = await fetch("/api/connect-phone", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ host, port: 27183 }),
    });
    const data = await res.json();
    setToast(data.message);
  });

  if (btnConnectDiscovered) {
    btnConnectDiscovered.addEventListener("click", async () => {
      if (!discoveredPhone) return;
      if (inputPhoneIp) inputPhoneIp.value = discoveredPhone.host;
      setToast(`Đang kết nối tới ${discoveredPhone.name} (${discoveredPhone.host})...`);
      const res = await fetch("/api/connect-phone", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ host: discoveredPhone.host, port: discoveredPhone.port }),
      });
      const data = await res.json();
      setToast(data.message);
      if (data.ok && discoveredPhoneCard) {
        discoveredPhoneCard.style.display = "none";
      }
    });
  }

  if (btnCancelReconnect) {
    btnCancelReconnect.addEventListener("click", async () => {
      await fetch("/api/cancel-reconnect", { method: "POST" }).catch(() => {});
      if (reconnectBanner) reconnectBanner.style.display = "none";
      setToast("Đã dừng tự động kết nối lại.");
    });
  }

  async function applyBitrate(mbps) {
    sliderBitrate.value = mbps;
    lblBitrateVal.textContent = `${mbps} Mbps`;
    presetChips.forEach((c) =>
      c.classList.toggle("active", Number(c.dataset.mbps) === Number(mbps))
    );
    await fetch("/api/bitrate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mbps: Number(mbps) }),
    });
  }

  sliderBitrate.addEventListener("input", (e) => {
    lblBitrateVal.textContent = `${e.target.value} Mbps`;
  });

  sliderBitrate.addEventListener("change", (e) => {
    applyBitrate(Number(e.target.value));
  });

  presetChips.forEach((chip) => {
    chip.addEventListener("click", () => {
      applyBitrate(Number(chip.dataset.mbps));
    });
  });

  btnForceIdr.addEventListener("click", async () => {
    await fetch("/api/request-idr", { method: "POST" });
    setToast("Đã gửi lệnh ép xuất khung hình IDR (KeyFrame) tức thì!");
  });

  if (btnCropLandscape) btnCropLandscape.addEventListener("click", toggleCropLandscape);
  if (btnFloatCrop) btnFloatCrop.addEventListener("click", toggleCropLandscape);

  if (btnRotate) btnRotate.addEventListener("click", rotateCanvas90);
  if (btnFloatRotate) btnFloatRotate.addEventListener("click", rotateCanvas90);

  if (btnScaleMode) btnScaleMode.addEventListener("click", cycleScaleMode);
  if (btnFloatScale) btnFloatScale.addEventListener("click", cycleScaleMode);

  if (btnFullscreen) btnFullscreen.addEventListener("click", toggleTrueFullscreen);
  if (btnFloatExitFs) btnFloatExitFs.addEventListener("click", toggleTrueFullscreen);

  if (btnVsyncMode) btnVsyncMode.addEventListener("click", toggleVsyncMode);

  if (btnQuickCinema) {
    btnQuickCinema.addEventListener("click", () => {
      document.body.classList.toggle("cinema-mode");
    });
  }

  viewportContainer.addEventListener("dblclick", toggleTrueFullscreen);

  // Resume audio on page interaction or tab focus
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && audioCtx && audioCtx.state === "suspended") {
      audioCtx.resume().then(() => updateAudioUI()).catch(() => {});
    }
  });

  if (navigator.mediaDevices) {
    navigator.mediaDevices.addEventListener("devicechange", () => {
      if (audioCtx && audioCtx.state === "suspended") {
        audioCtx.resume().then(() => updateAudioUI()).catch(() => {});
      }
    });
  }

  ["click", "pointerdown", "keydown", "touchstart"].forEach((evt) => {
    window.addEventListener(evt, ensureAudioRunning, { passive: true, once: false });
  });

  window.addEventListener("keydown", (e) => {
    ensureAudioRunning();
    if (e.target && e.target.tagName === "INPUT") return;
    const key = e.key.toLowerCase();
    if (key === "c") {
      toggleCropLandscape();
    } else if (key === "r") {
      rotateCanvas90();
    } else if (key === "z") {
      cycleScaleMode();
    } else if (key === "v") {
      toggleVsyncMode();
    } else if (key === "m") {
      toggleAudioMute();
    } else if (key === "f" || e.key === "F11") {
      e.preventDefault();
      toggleTrueFullscreen();
    } else if (key === "h") {
      document.body.classList.toggle("cinema-mode");
    }
  });

  if (hudAudioMetric) hudAudioMetric.addEventListener("click", toggleAudioMute);
  if (btnToggleAudio) btnToggleAudio.addEventListener("click", toggleAudioMute);
  if (btnFloatAudio) btnFloatAudio.addEventListener("click", toggleAudioMute);
  if (sliderVolume) {
    sliderVolume.addEventListener("input", (e) => {
      setAudioVolume(Number(e.target.value));
    });
  }
  updateAudioUI();

  btnNativeFfplay.addEventListener("click", async () => {
    const res = await fetch("/api/ffplay", { method: "POST" });
    const data = await res.json();
    if (data.error) {
      setToast(`Lỗi mở FFplay: ${data.error}`);
    } else {
      setToast(
        data.active
          ? "Đã mở cửa sổ Native Direct3D (FFplay Zero-Buffer)!"
          : "Đã đóng cửa sổ FFplay."
      );
    }
  });

  // Simulator FPS Selection (60Hz / 120Hz / 144Hz)
  let simSelectedFps = 60;
  const simFpsList = [
    { el: btnSimFps60, fps: 60 },
    { el: btnSimFps120, fps: 120 },
    { el: btnSimFps144, fps: 144 },
  ];
  simFpsList.forEach(({ el, fps }) => {
    if (!el) return;
    el.addEventListener("click", () => {
      simSelectedFps = fps;
      simFpsList.forEach((c) => c.el && c.el.classList.toggle("active", c.fps === fps));
      setToast(`Đã chọn tốc độ giả lập: ${fps} FPS`);
    });
  });

  btnSimulator.addEventListener("click", async () => {
    const res = await fetch("/api/simulator", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        fps: simSelectedFps,
        bitrateMbps: Number(sliderBitrate.value || 16),
      }),
    });
    const data = await res.json();
    setToast(
      data.active
        ? `Đang phát luồng H.264 ${simSelectedFps}FPS Zero-Latency giả lập!`
        : "Đã dừng luồng giả lập."
    );
  });

  async function fetchAndRenderLogs() {
    if (!logContent) return;
    try {
      const res = await fetch("/api/logs");
      const data = await res.json();
      if (data && data.lines && Array.isArray(data.lines)) {
        logContent.textContent = data.lines.join("\n") || "(Chưa có dữ liệu nhật ký)";
      } else {
        logContent.textContent = (data && data.content) || "(Trống)";
      }
      logContent.scrollTop = logContent.scrollHeight;
    } catch (err) {
      logContent.textContent = `Lỗi khi tải nhật ký: ${err.message}`;
    }
  }

  if (btnViewLogs && logModal) {
    btnViewLogs.addEventListener("click", () => {
      logModal.style.display = "flex";
      fetchAndRenderLogs();
    });
  }

  if (btnCloseLogs && logModal) {
    btnCloseLogs.addEventListener("click", () => {
      logModal.style.display = "none";
    });
  }

  if (btnRefreshLogs) {
    btnRefreshLogs.addEventListener("click", fetchAndRenderLogs);
  }

  if (logModal) {
    logModal.addEventListener("click", (e) => {
      if (e.target === logModal) {
        logModal.style.display = "none";
      }
    });
  }

  startVsyncRenderLoop();
  loadServerInfo();
  connectWebSocket();
})();
