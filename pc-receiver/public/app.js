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

  const sliderBitrate = document.getElementById("sliderBitrate");
  const lblBitrateVal = document.getElementById("lblBitrateVal");
  const presetChips = document.querySelectorAll(".btn-chip");
  const btnForceIdr = document.getElementById("btnForceIdr");
  const btnFullscreen = document.getElementById("btnFullscreen");
  const btnNativeFfplay = document.getElementById("btnNativeFfplay");
  const btnSimulator = document.getElementById("btnSimulator");
  const viewportContainer = document.getElementById("viewportContainer");

  let videoDecoder = null;
  let configuredCodecString = "";
  let cachedConfigBytes = null;
  let waitingForKeyFrame = true;
  let lastWebCodecsFrameTime = 0;
  let isRenderingBitmap = false;

  // Telemetry accumulators
  let frameCountWindow = 0;
  let byteCountWindow = 0;
  let encodeUsWindow = 0;
  let decodeMsWindow = 0;
  let lastStatTime = performance.now();
  const pendingDecodeTimestamps = new Map();

  function setToast(msg) {
    connectionToast.textContent = msg;
  }

  function detectH264CodecString(u8) {
    for (let i = 0; i < u8.length - 7; i++) {
      let startCodeLen = 0;
      if (u8[i] === 0 && u8[i + 1] === 0 && u8[i + 2] === 1) {
        startCodeLen = 3;
      } else if (
        u8[i] === 0 &&
        u8[i + 1] === 0 &&
        u8[i + 2] === 0 &&
        u8[i + 3] === 1
      ) {
        startCodeLen = 4;
      }
      if (startCodeLen > 0) {
        const nalHeaderIndex = i + startCodeLen;
        const nalType = u8[nalHeaderIndex] & 0x1f;
        if (nalType === 7 && nalHeaderIndex + 3 < u8.length) {
          const profile = u8[nalHeaderIndex + 1]
            .toString(16)
            .padStart(2, "0");
          const compat = u8[nalHeaderIndex + 2]
            .toString(16)
            .padStart(2, "0");
          const level = u8[nalHeaderIndex + 3]
            .toString(16)
            .padStart(2, "0");
          return `avc1.${profile}${compat}${level}`;
        }
        i += startCodeLen - 1;
      }
    }
    return "avc1.42e01f";
  }

  function containsConfigNal(u8, codecId) {
    for (let i = 0; i < u8.length - 4; i++) {
      if (
        u8[i] === 0 &&
        u8[i + 1] === 0 &&
        (u8[i + 2] === 1 || (u8[i + 2] === 0 && u8[i + 3] === 1))
      ) {
        const offset = u8[i + 2] === 1 ? i + 3 : i + 4;
        if (offset >= u8.length) break;
        if (codecId === 2) {
          const hevcType = (u8[offset] >> 1) & 0x3f;
          if (hevcType === 32 || hevcType === 33) return true;
        } else {
          const avcType = u8[offset] & 0x1f;
          if (avcType === 7) return true;
        }
      }
    }
    return false;
  }

  function ensureHardwareDecoder(codecId, sampleBytes) {
    if (!("VideoDecoder" in window)) {
      return false;
    }

    const targetCodec =
      codecId === 2
        ? "hev1.1.6.L120.90"
        : detectH264CodecString(sampleBytes || cachedConfigBytes || new Uint8Array());

    if (
      videoDecoder &&
      videoDecoder.state === "configured" &&
      configuredCodecString === targetCodec
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
        const startT = pendingDecodeTimestamps.get(frame.timestamp);
        if (startT !== undefined) {
          decodeMsWindow += now - startT;
          pendingDecodeTimestamps.delete(frame.timestamp);
        }

        if (
          canvas.width !== frame.displayWidth ||
          canvas.height !== frame.displayHeight
        ) {
          canvas.width = frame.displayWidth;
          canvas.height = frame.displayHeight;
        }

        ctx.drawImage(frame, 0, 0, canvas.width, canvas.height);
        frame.close();

        emptyOverlay.classList.add("hidden");
        frameCountWindow++;
      },
      error: () => {
        waitingForKeyFrame = true;
      },
    });

    try {
      videoDecoder.configure({
        codec: targetCodec,
        optimizeForLatency: true,
        hardwareAcceleration: "prefer-hardware",
      });
      configuredCodecString = targetCodec;
      waitingForKeyFrame = true;
      return true;
    } catch (_) {
      try {
        videoDecoder.configure({
          codec: "avc1.42e01f",
          optimizeForLatency: true,
        });
        configuredCodecString = "avc1.42e01f";
        waitingForKeyFrame = true;
        return true;
      } catch (_) {
        return false;
      }
    }
  }

  async function renderUniversalJpegFrame(jpegBytes, encodeDurationUs) {
    // Only render universal decoded frame if WebCodecs hasn't rendered within the last 250ms
    if (performance.now() - lastWebCodecsFrameTime < 250) {
      return;
    }
    if (isRenderingBitmap) return;
    isRenderingBitmap = true;
    const t0 = performance.now();
    try {
      const blob = new Blob([jpegBytes], { type: "image/jpeg" });
      const bmp = await createImageBitmap(blob);
      if (canvas.width !== bmp.width || canvas.height !== bmp.height) {
        canvas.width = bmp.width;
        canvas.height = bmp.height;
      }
      ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
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
      renderUniversalJpegFrame(payloadBytes, encodeDurationUs);
      return;
    }

    byteCountWindow += payloadBytes.byteLength;
    encodeUsWindow += encodeDurationUs;

    if (frameType === 1) {
      cachedConfigBytes = new Uint8Array(payloadBytes);
      ensureHardwareDecoder(codecId, cachedConfigBytes);
      return;
    }

    if (!ensureHardwareDecoder(codecId, payloadBytes)) return;

    const isKey = frameType === 2;
    if (waitingForKeyFrame && !isKey) {
      return;
    }

    let chunkData = payloadBytes;
    if (isKey) {
      waitingForKeyFrame = false;
      if (cachedConfigBytes && !containsConfigNal(payloadBytes, codecId)) {
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

  function connectWebSocket() {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${proto}://${location.host}`);
    ws.binaryType = "arraybuffer";

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
      setTimeout(connectWebSocket, 1200);
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

  btnFullscreen.addEventListener("click", () => {
    if (!document.fullscreenElement) {
      viewportContainer.requestFullscreen().catch(() => {});
    } else {
      document.exitFullscreen().catch(() => {});
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
