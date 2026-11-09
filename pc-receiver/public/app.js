(() => {
  const canvas = document.getElementById("mirrorCanvas");
  const ctx =
    canvas.getContext("2d", { alpha: false, desynchronized: true }) ||
    canvas.getContext("2d");

  const emptyOverlay = document.getElementById("emptyOverlay");
  const hudStatusDot = document.getElementById("hudStatusDot");
  const hudStatusText = document.getElementById("hudStatusText");
  const hudCodec = document.getElementById("hudCodec");
  const hudFps = document.getElementById("hudFps");
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

  // Orientation / Crop / Fullscreen controls
  const btnCropLandscape = document.getElementById("btnCropLandscape");
  const btnRotate = document.getElementById("btnRotate");
  const btnScaleMode = document.getElementById("btnScaleMode");
  const btnFullscreen = document.getElementById("btnFullscreen");
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
  const viewportContainer = document.getElementById("viewportContainer");

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

    if (canvas.width !== outW || canvas.height !== outH) {
      canvas.width = outW;
      canvas.height = outH;
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

  function ensureHardwareDecoder(codecId) {
    if (!("VideoDecoder" in window)) {
      return false;
    }

    // NEVER close or reset an already-configured working VideoDecoder unless codecId changed or it closed!
    if (
      videoDecoder &&
      videoDecoder.state === "configured" &&
      activeCodecId === codecId
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

        drawVideoSourceToCanvas(frame, frame.displayWidth, frame.displayHeight);
        frame.close();

        emptyOverlay.classList.add("hidden");
        frameCountWindow++;
      },
      error: (err) => {
        console.warn("[WebCodecs decode error]", err);
        waitingForKeyFrame = true;
        pendingDecodeTimestamps.clear();
        // A decoder that errored is dead: release it and stop re-configuring
        // every single frame (prevents an endless warning/IDR flood).
        try {
          if (videoDecoder && videoDecoder.state !== "closed") videoDecoder.close();
        } catch (_) {}
        videoDecoder = null;
        activeCodecId = 0;
        decoderErrorStreak++;
        if (decoderErrorStreak >= 2 && !useJpegFallback) {
          useJpegFallback = true;
          setToast(
            "GPU WebCodecs không hỗ trợ codec này — đã chuyển sang chế độ giải mã JPEG dự phòng."
          );
          // Reconnect so the server starts the MJPEG fallback pipeline.
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
        ? ["hev1.1.6.L120.90", "hvc1.1.6.L120.90"]
        : [
            detectedSpsCodecString,
            "avc1.64002a",
            "avc1.4d402a",
            "avc1.42e01f",
          ];

    for (const c of candidates) {
      try {
        videoDecoder.configure({
          codec: c,
          optimizeForLatency: true,
          hardwareAcceleration: "prefer-hardware",
        });
        activeCodecId = codecId;
        waitingForKeyFrame = true;
        return true;
      } catch (_) {
        try {
          videoDecoder.configure({
            codec: c,
            optimizeForLatency: true,
          });
          activeCodecId = codecId;
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
    const frameType = view.getUint8(0); // 1=Config, 2=Keyframe, 3=Normal, 5=Universal JPEG
    const codecId = view.getUint8(1); // 1=H264, 2=H265
    const ptsUs = Number(view.getBigInt64(2, false));
    const encodeDurationUs = view.getUint32(10, false);
    const payloadBytes = new Uint8Array(arrayBuffer, 14);

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

  function scheduleReconnect(delay = 1200) {
    if (reconnectTimer) return;
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

    ws.onmessage = (ev) => {
      if (typeof ev.data === "string") {
        try {
          const msg = JSON.parse(ev.data);
          if (msg.type === "status" && msg.meta) {
            updateStatusUI(msg.meta);
          } else if (msg.type === "simulator") {
            btnSimulator.classList.toggle("active", Boolean(msg.active));
            btnSimulator.textContent = msg.active
              ? "⏹ Dừng Luồng Giả Lập 60FPS H.264"
              : "🎮 Chạy Luồng Giả Lập 60FPS H.264 (Test Ngay Trên PC)";
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
        pcLanIp.textContent = info.lanIps.map((i) => i.address).join(" / ");
      } else {
        pcLanIp.textContent = "127.0.0.1 (USB Mode)";
      }
      if (info.meta) {
        updateStatusUI(info.meta);
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

  if (btnQuickCinema) {
    btnQuickCinema.addEventListener("click", () => {
      document.body.classList.toggle("cinema-mode");
    });
  }

  viewportContainer.addEventListener("dblclick", toggleTrueFullscreen);

  window.addEventListener("keydown", (e) => {
    if (e.target && e.target.tagName === "INPUT") return;
    const key = e.key.toLowerCase();
    if (key === "c") {
      toggleCropLandscape();
    } else if (key === "r") {
      rotateCanvas90();
    } else if (key === "z") {
      cycleScaleMode();
    } else if (key === "f" || e.key === "F11") {
      e.preventDefault();
      toggleTrueFullscreen();
    } else if (key === "h") {
      document.body.classList.toggle("cinema-mode");
    }
  });

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

  btnSimulator.addEventListener("click", async () => {
    const res = await fetch("/api/simulator", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        fps: 60,
        bitrateMbps: Number(sliderBitrate.value || 12),
      }),
    });
    const data = await res.json();
    setToast(
      data.active
        ? "Đang phát luồng H.264 60FPS Zero-Latency giả lập!"
        : "Đã dừng luồng giả lập."
    );
  });

  loadServerInfo();
  connectWebSocket();
})();
