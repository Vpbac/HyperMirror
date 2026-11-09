/**
 * HyperMirror Pro - PC Receiver & Low-Latency Gaming Engine
 * Supports:
 * 1. USB Wired Mode (ADB Forward / ADB Reverse TCP_NODELAY)
 * 2. Wi-Fi 5GHz/6GHz Direct Socket Mode (:27183)
 * 3. WebCodecs GPU Hardware Decoding (in-browser <canvas desynchronized>)
 * 4. Native Direct3D11 / SDL Ultra-Low-Latency Window (via FFplay Zero-Buffer pipe)
 * 5. Real-time Two-Way Control (Live Bitrate Adaptation, Instant IDR Keyframe, Sub-ms Ping/Pong RTT)
 */

const net = require("net");
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const os = require("os");
const { spawn, exec } = require("child_process");

const STREAM_PORT = Number(process.env.STREAM_PORT || 27183);
const WEB_PORT = Number(process.env.WEB_PORT || 3080);

// Protocol constants matching Android StreamTransport.kt
const FRAME_TYPE_CONFIG = 0x01;
const FRAME_TYPE_KEYFRAME = 0x02;
const FRAME_TYPE_NORMAL = 0x03;
const FRAME_TYPE_PING = 0x04;

const CMD_REQUEST_IDR = 0x10;
const CMD_SET_BITRATE = 0x11;
const CMD_PONG = 0x12;

// State
let activePhoneSocket = null;
let streamMeta = {
  connected: false,
  remoteAddress: "-",
  deviceName: "-",
  codec: "H.264",
  codecId: 1,
  width: 1920,
  height: 1080,
  targetFps: 120,
  targetBitrateKbps: 16000,
};

let cachedConfigFrame = null;
let ffplayProcess = null;
let simulatorProcess = null;
let simulatorSocket = null;

// Connected WebSocket UI clients
const wsClients = new Set();

function getLocalLanIps() {
  const nets = os.networkInterfaces();
  const ips = [];
  for (const name of Object.keys(nets)) {
    for (const iface of nets[name] || []) {
      if (iface.family === "IPv4" && !iface.internal) {
        ips.push({ interface: name, address: iface.address });
      }
    }
  }
  return ips;
}

/**
 * RFC 6455 Native WebSocket Frame Encoder (Zero npm dependencies)
 */
function encodeWsFrame(opcode, payloadBuffer) {
  const len = payloadBuffer.length;
  let header;
  if (len < 126) {
    header = Buffer.allocUnsafe(2);
    header[0] = 0x80 | opcode;
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.allocUnsafe(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.allocUnsafe(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, payloadBuffer]);
}

function broadcastJson(obj) {
  const payload = Buffer.from(JSON.stringify(obj), "utf8");
  const frame = encodeWsFrame(0x01, payload); // Text frame
  for (const sock of wsClients) {
    if (!sock.destroyed) {
      sock.write(frame);
    }
  }
}

/**
 * Broadcasts a binary video frame to all WebCodecs UI clients:
 * Header (14 bytes):
 *   [0]: frameType (1=Config, 2=Keyframe, 3=Normal)
 *   [1]: codecId (1=H264, 2=H265)
 *   [2..9]: ptsUs (BigInt64BE)
 *   [10..13]: encodeDurationUs (UInt32BE)
 *   [14..]: raw Annex-B NAL payload
 */
function broadcastBinaryVideoFrame(frameType, codecId, ptsUs, encodeDurationUs, nalBuffer) {
  if (wsClients.size === 0) return;
  const header = Buffer.allocUnsafe(14);
  header[0] = frameType;
  header[1] = codecId;
  header.writeBigInt64BE(ptsUs, 2);
  header.writeUInt32BE(encodeDurationUs, 10);
  const wsPacket = encodeWsFrame(0x02, Buffer.concat([header, nalBuffer]));
  for (const sock of wsClients) {
    if (!sock.destroyed) {
      sock.write(wsPacket);
    }
  }
}

/**
 * Send control command back to Android phone over the full-duplex TCP socket
 */
function sendCommandToPhone(cmdByte, payloadBuf = Buffer.alloc(0)) {
  if (!activePhoneSocket || activePhoneSocket.destroyed) return false;
  try {
    const buf = Buffer.allocUnsafe(1 + payloadBuf.length);
    buf[0] = cmdByte;
    if (payloadBuf.length > 0) {
      payloadBuf.copy(buf, 1);
    }
    activePhoneSocket.write(buf);
    return true;
  } catch (err) {
    return false;
  }
}

/**
 * Attach GMIR protocol parser to a connected phone socket (either incoming or outgoing USB)
 */
function attachPhoneStreamSocket(socket, modeLabel = "TCP") {
  if (activePhoneSocket && activePhoneSocket !== socket) {
    try {
      activePhoneSocket.destroy();
    } catch (_) {}
  }

  socket.setNoDelay(true);
  socket.setKeepAlive(true, 2000);
  activePhoneSocket = socket;

  let handshakeDone = false;
  let rxBuffer = Buffer.alloc(0);

  streamMeta.connected = true;
  streamMeta.remoteAddress = `${socket.remoteAddress || "127.0.0.1"}:${socket.remotePort || STREAM_PORT} (${modeLabel})`;
  broadcastJson({ type: "status", meta: streamMeta });

  socket.on("data", (chunk) => {
    rxBuffer = rxBuffer.length === 0 ? chunk : Buffer.concat([rxBuffer, chunk]);

    // Step 1: Parse 24-byte Handshake ("GMIR")
    if (!handshakeDone) {
      if (rxBuffer.length < 24) return;
      const magic = rxBuffer.subarray(0, 4).toString("ascii");
      if (magic === "GMIR") {
        const version = rxBuffer.readUInt8(4);
        const codecId = rxBuffer.readUInt8(5);
        const width = rxBuffer.readUInt16BE(6);
        const height = rxBuffer.readUInt16BE(8);
        const fps = rxBuffer.readUInt16BE(10);
        const bitrateKbps = rxBuffer.readUInt32BE(12);
        const deviceName = rxBuffer.subarray(16, 24).toString("utf8").trim() || "Android";

        streamMeta = {
          connected: true,
          remoteAddress: streamMeta.remoteAddress,
          deviceName,
          version,
          codecId,
          codec: codecId === 2 ? "H.265 (HEVC)" : "H.264 (AVC)",
          width,
          height,
          targetFps: fps,
          targetBitrateKbps: bitrateKbps,
        };
        handshakeDone = true;
        rxBuffer = rxBuffer.subarray(24);
        console.log(
          `[GMIR Handshake] Device=${deviceName} | ${width}x${height} @ ${fps}FPS | ${streamMeta.codec} | ${bitrateKbps} kbps`
        );
        broadcastJson({ type: "status", meta: streamMeta });
      } else {
        // Fallback if raw Annex-B stream is piped directly without GMIR header
        handshakeDone = true;
      }
    }

    // Step 2: Parse 17-byte GMIR Frame Packets
    while (rxBuffer.length >= 17) {
      const frameType = rxBuffer.readUInt8(0);
      const ptsUs = rxBuffer.readBigInt64BE(1);
      const encodeDurationUs = rxBuffer.readUInt32BE(9);
      const payloadLen = rxBuffer.readUInt32BE(13);

      if (payloadLen > 16 * 1024 * 1024 || frameType < 1 || frameType > 4) {
        // Malformed stream recovery
        console.warn(`[GMIR] Invalid frame header (type=${frameType}, len=${payloadLen}), resetting buffer`);
        rxBuffer = Buffer.alloc(0);
        sendCommandToPhone(CMD_REQUEST_IDR);
        break;
      }

      if (rxBuffer.length < 17 + payloadLen) {
        // Wait for remaining NAL bytes
        break;
      }

      const payload = rxBuffer.subarray(17, 17 + payloadLen);
      rxBuffer = rxBuffer.subarray(17 + payloadLen);

      if (frameType === FRAME_TYPE_PING) {
        // Immediately reply with PONG (0x12 + 8-byte timestamp) for sub-ms RTT measurement
        if (payload.length >= 8) {
          sendCommandToPhone(CMD_PONG, payload.subarray(0, 8));
        }
        continue;
      }

      if (frameType === FRAME_TYPE_CONFIG) {
        cachedConfigFrame = Buffer.from(payload);
      }

      // Forward to Native FFplay Direct3D window if active
      if (ffplayProcess && ffplayProcess.stdin && !ffplayProcess.stdin.destroyed) {
        try {
          ffplayProcess.stdin.write(payload);
        } catch (_) {}
      }

      // Broadcast binary NAL frame to WebCodecs UI clients
      broadcastBinaryVideoFrame(frameType, streamMeta.codecId, ptsUs, encodeDurationUs, payload);
    }
  });

  socket.on("close", () => {
    if (activePhoneSocket === socket) {
      activePhoneSocket = null;
      streamMeta.connected = false;
      broadcastJson({ type: "status", meta: streamMeta });
      console.log("[Stream] Phone disconnected.");
    }
  });

  socket.on("error", (err) => {
    console.warn(`[Stream Socket Error] ${err.message}`);
  });
}

/**
 * 1. TCP Server listening on 0.0.0.0:27183 for Wi-Fi Client Mode or ADB Reverse Mode
 */
const tcpServer = net.createServer((socket) => {
  console.log(`[TCP Server] Incoming connection from ${socket.remoteAddress}:${socket.remotePort}`);
  attachPhoneStreamSocket(socket, "Incoming Wi-Fi / ADB Reverse");
});

tcpServer.listen(STREAM_PORT, "0.0.0.0", () => {
  console.log(`[HyperMirror TCP Server] Listening on 0.0.0.0:${STREAM_PORT} (TCP_NODELAY enabled)`);
});

/**
 * 2. Active Connect to Android USB Server (127.0.0.1:27183 via adb forward or Phone IP)
 */
function connectToPhoneServer(host = "127.0.0.1", port = STREAM_PORT, label = "USB ADB Forward") {
  return new Promise((resolve, reject) => {
    const client = new net.Socket();
    client.setTimeout(3000);
    client.connect(port, host, () => {
      client.setTimeout(0);
      attachPhoneStreamSocket(client, label);
      resolve(true);
    });
    client.on("error", (err) => {
      client.destroy();
      reject(err);
    });
    client.on("timeout", () => {
      client.destroy();
      reject(new Error("Connection timeout"));
    });
  });
}

/**
 * 3. Launch Native Direct3D11 / SDL Ultra-Low-Latency FFplay Window
 */
function toggleNativeFfplayWindow() {
  if (ffplayProcess) {
    try {
      ffplayProcess.kill();
    } catch (_) {}
    ffplayProcess = null;
    broadcastJson({ type: "ffplay", active: false });
    return { active: false };
  }

  const inputCodec = streamMeta.codecId === 2 ? "hevc" : "h264";
  const args = [
    "-f", inputCodec,
    "-fflags", "nobuffer",
    "-flags", "low_delay",
    "-framedrop",
    "-strict", "experimental",
    "-probesize", "32",
    "-analyzeduration", "0",
    "-sync", "ext",
    "-window_title", `HyperMirror Pro Native Direct3D (${streamMeta.codec} Zero-Latency)`,
    "-i", "pipe:0"
  ];

  try {
    ffplayProcess = spawn("ffplay", args, { stdio: ["pipe", "ignore", "ignore"] });
    if (cachedConfigFrame && ffplayProcess.stdin) {
      ffplayProcess.stdin.write(cachedConfigFrame);
      sendCommandToPhone(CMD_REQUEST_IDR);
    }
    ffplayProcess.on("exit", () => {
      ffplayProcess = null;
      broadcastJson({ type: "ffplay", active: false });
    });
    broadcastJson({ type: "ffplay", active: true });
    return { active: true };
  } catch (err) {
    ffplayProcess = null;
    return { active: false, error: err.message };
  }
}

/**
 * 4. Built-in 60/120FPS H.264 Ultra-Low-Latency Hardware Simulator (for instant PC testing!)
 */
function toggleBuiltInSimulator(fps = 60, bitrateMbps = 12) {
  if (simulatorProcess) {
    try {
      simulatorProcess.kill();
    } catch (_) {}
    simulatorProcess = null;
    if (simulatorSocket) {
      try {
        simulatorSocket.destroy();
      } catch (_) {}
      simulatorSocket = null;
    }
    broadcastJson({ type: "simulator", active: false });
    return { active: false };
  }

  const width = 1280;
  const height = 720;
  const sock = net.createConnection({ host: "127.0.0.1", port: STREAM_PORT }, () => {
    sock.setNoDelay(true);

    // Send 24-byte GMIR Handshake
    const hs = Buffer.alloc(24);
    hs.write("GMIR", 0, "ascii");
    hs.writeUInt8(1, 4);              // Version 1
    hs.writeUInt8(1, 5);              // Codec 1 = H.264
    hs.writeUInt16BE(width, 6);
    hs.writeUInt16BE(height, 8);
    hs.writeUInt16BE(fps, 10);
    hs.writeUInt32BE(bitrateMbps * 1000, 12);
    hs.write("SIM-120Hz".padEnd(8, " ").slice(0, 8), 16, "ascii");
    sock.write(hs);

    // Spawn FFmpeg generating a real-time 60/120FPS low-latency Baseline/Main H.264 Annex-B stream
    const ffArgs = [
      "-re",
      "-f", "lavfi",
      "-i", `testsrc2=size=${width}x${height}:rate=${fps}`,
      "-c:v", "libx264",
      "-preset", "ultrafast",
      "-tune", "zerolatency",
      "-profile:v", "baseline",
      "-pix_fmt", "yuv420p",
      "-b:v", `${bitrateMbps}M`,
      "-g", String(fps),
      "-bf", "0",
      "-f", "h264",
      "pipe:1"
    ];

    simulatorProcess = spawn("ffmpeg", ffArgs, { stdio: ["ignore", "pipe", "ignore"] });
    let frameIndex = 0n;

    simulatorProcess.stdout.on("data", (nalChunk) => {
      if (sock.destroyed) return;
      const ptsUs = (frameIndex * 1000000n) / BigInt(fps);
      frameIndex++;

      // Detect if chunk contains SPS (NAL type 7) or IDR (NAL type 5)
      let fType = FRAME_TYPE_NORMAL;
      for (let i = 0; i < nalChunk.length - 4; i++) {
        if (nalChunk[i] === 0 && nalChunk[i + 1] === 0 && nalChunk[i + 2] === 0 && nalChunk[i + 3] === 1) {
          const nalType = nalChunk[i + 4] & 0x1f;
          if (nalType === 7 || nalType === 8) {
            fType = FRAME_TYPE_CONFIG;
            break;
          } else if (nalType === 5) {
            fType = FRAME_TYPE_KEYFRAME;
          }
        }
      }

      const pkt = Buffer.allocUnsafe(17 + nalChunk.length);
      pkt.writeUInt8(fType, 0);
      pkt.writeBigInt64BE(ptsUs, 1);
      pkt.writeUInt32BE(1450, 9); // 1.45ms simulated hardware DSP encode time
      pkt.writeUInt32BE(nalChunk.length, 13);
      nalChunk.copy(pkt, 17);
      sock.write(pkt);
    });

    simulatorProcess.on("exit", () => {
      simulatorProcess = null;
      if (!sock.destroyed) sock.destroy();
      broadcastJson({ type: "simulator", active: false });
    });
  });

  simulatorSocket = sock;
  broadcastJson({ type: "simulator", active: true });
  return { active: true };
}

/**
 * 5. USB ADB Tunnel Helper (`adb forward` & `adb reverse`)
 */
function setupUsbAdbTunnel() {
  const sdkAdb = path.join(
    process.env.LOCALAPPDATA || "",
    "Android",
    "Sdk",
    "platform-tools",
    "adb.exe"
  );
  const adbCmd = fs.existsSync(sdkAdb) ? `"${sdkAdb}"` : "adb";

  return new Promise((resolve) => {
    exec(
      `${adbCmd} forward tcp:${STREAM_PORT} tcp:${STREAM_PORT} && ${adbCmd} reverse tcp:${STREAM_PORT} tcp:${STREAM_PORT}`,
      (err, stdout, stderr) => {
        if (err) {
          resolve({
            ok: false,
            message:
              "Không tìm thấy thiết bị ADB hoặc chưa bật Gỡ lỗi USB (USB Debugging). Bạn vẫn có thể kết nối qua Wi-Fi IP hoặc bật USB Tethering!",
            details: stderr || err.message,
          });
        } else {
          // Try connecting actively to Phone's USB Server on 127.0.0.1:27183
          connectToPhoneServer("127.0.0.1", STREAM_PORT, "USB Cable (ADB Forward)")
            .then(() => {
              resolve({
                ok: true,
                message: `Đã thiết lập đường truyền cáp USB (cổng ${STREAM_PORT}) và kết nối thành công tới điện thoại!`,
              });
            })
            .catch(() => {
              resolve({
                ok: true,
                message: `Đã mở đường hầm cáp USB (adb forward & reverse cổng ${STREAM_PORT}). Hãy bấm 'Bắt đầu chiếu' trên điện thoại!`,
              });
            });
        }
      }
    );
  });
}

/**
 * 6. HTTP + WebSocket Control & UI Server
 */
const httpServer = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (url.pathname === "/api/info" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        streamPort: STREAM_PORT,
        lanIps: getLocalLanIps(),
        meta: streamMeta,
        ffplayActive: Boolean(ffplayProcess),
        simulatorActive: Boolean(simulatorProcess),
      })
    );
    return;
  }

  if (url.pathname === "/api/usb-adb" && req.method === "POST") {
    const result = await setupUsbAdbTunnel();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(result));
    return;
  }

  if (url.pathname === "/api/install-apk" && req.method === "POST") {
    const sdkAdb = path.join(
      process.env.LOCALAPPDATA || "",
      "Android",
      "Sdk",
      "platform-tools",
      "adb.exe"
    );
    const adbCmd = fs.existsSync(sdkAdb) ? `"${sdkAdb}"` : "adb";
    const apkCandidate1 = path.join(__dirname, "..", "HyperMirrorSender-debug.apk");
    const apkCandidate2 = path.join(
      __dirname,
      "..",
      "android-sender",
      "app",
      "build",
      "outputs",
      "apk",
      "debug",
      "app-debug.apk"
    );
    const apkPath = fs.existsSync(apkCandidate1) ? apkCandidate1 : apkCandidate2;

    if (!fs.existsSync(apkPath)) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          ok: false,
          message: "File APK đang được biên dịch hoặc chưa tồn tại.",
        })
      );
      return;
    }

    exec(`${adbCmd} install -r "${apkPath}"`, (err, stdout, stderr) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      if (err) {
        res.end(
          JSON.stringify({
            ok: false,
            message: `Chưa thể cài qua USB ADB (${stderr || err.message}). Bạn có thể tải APK trực tiếp qua Wi-Fi tại http://192.168.1.10:${WEB_PORT}/download-apk`,
          })
        );
      } else {
        res.end(
          JSON.stringify({
            ok: true,
            message: "Đã cài đặt thành công HyperMirror Pro APK lên điện thoại Android của bạn!",
          })
        );
      }
    });
    return;
  }

  if (url.pathname === "/download-apk" && req.method === "GET") {
    const apkCandidate1 = path.join(__dirname, "..", "HyperMirrorSender-debug.apk");
    const apkCandidate2 = path.join(
      __dirname,
      "..",
      "android-sender",
      "app",
      "build",
      "outputs",
      "apk",
      "debug",
      "app-debug.apk"
    );
    const apkPath = fs.existsSync(apkCandidate1) ? apkCandidate1 : apkCandidate2;
    if (!fs.existsSync(apkPath)) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("APK not found yet.");
      return;
    }
    const stat = fs.statSync(apkPath);
    res.writeHead(200, {
      "Content-Type": "application/vnd.android.package-archive",
      "Content-Disposition": 'attachment; filename="HyperMirrorSender-debug.apk"',
      "Content-Length": stat.size,
    });
    fs.createReadStream(apkPath).pipe(res);
    return;
  }

  if (url.pathname === "/api/connect-phone" && req.method === "POST") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", async () => {
      try {
        const { host, port } = JSON.parse(body || "{}");
        await connectToPhoneServer(host || "127.0.0.1", Number(port || STREAM_PORT), `Direct -> ${host}`);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, message: `Đã kết nối tới ${host}:${port || STREAM_PORT}` }));
      } catch (err) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, message: `Không thể kết nối tới điện thoại: ${err.message}` }));
      }
    });
    return;
  }

  if (url.pathname === "/api/bitrate" && req.method === "POST") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const { mbps } = JSON.parse(body || "{}");
      const bps = Math.max(2, Math.min(50, Number(mbps || 16))) * 1_000_000;
      const payload = Buffer.allocUnsafe(4);
      payload.writeInt32BE(bps, 0);
      const sent = sendCommandToPhone(CMD_SET_BITRATE, payload);
      streamMeta.targetBitrateKbps = Math.round(bps / 1000);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: sent, bitrateMbps: bps / 1_000_000 }));
    });
    return;
  }

  if (url.pathname === "/api/request-idr" && req.method === "POST") {
    const sent = sendCommandToPhone(CMD_REQUEST_IDR);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: sent }));
    return;
  }

  if (url.pathname === "/api/ffplay" && req.method === "POST") {
    const status = toggleNativeFfplayWindow();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(status));
    return;
  }

  if (url.pathname === "/api/simulator" && req.method === "POST") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const { fps, bitrateMbps } = JSON.parse(body || "{}");
      const status = toggleBuiltInSimulator(Number(fps || 60), Number(bitrateMbps || 12));
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(status));
    });
    return;
  }

  // Static files in public/
  const publicDir = path.join(__dirname, "public");
  let filePath = path.join(publicDir, url.pathname === "/" ? "index.html" : url.pathname);
  if (!filePath.startsWith(publicDir)) {
    res.writeHead(403);
    res.end();
    return;
  }

  fs.readFile(filePath, (err, content) => {
    if (err) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }
    const ext = path.extname(filePath);
    const mimeTypes = {
      ".html": "text/html; charset=utf-8",
      ".css": "text/css; charset=utf-8",
      ".js": "application/javascript; charset=utf-8",
    };
    res.writeHead(200, { "Content-Type": mimeTypes[ext] || "application/octet-stream" });
    res.end(content);
  });
});

// Native WebSocket Upgrade Handler
httpServer.on("upgrade", (req, socket) => {
  const key = req.headers["sec-websocket-key"];
  if (!key) {
    socket.destroy();
    return;
  }
  const acceptKey = crypto
    .createHash("sha1")
    .update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")
    .digest("base64");

  socket.write(
    [
      "HTTP/1.1 101 Switching Protocols",
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Sec-WebSocket-Accept: ${acceptKey}`,
      "\r\n",
    ].join("\r\n")
  );

  socket.setNoDelay(true);
  wsClients.add(socket);

  // Send initial metadata & cached SPS/PPS config frame immediately
  socket.write(encodeWsFrame(0x01, Buffer.from(JSON.stringify({ type: "status", meta: streamMeta }))));
  if (cachedConfigFrame) {
    const header = Buffer.allocUnsafe(14);
    header[0] = FRAME_TYPE_CONFIG;
    header[1] = streamMeta.codecId;
    header.writeBigInt64BE(0n, 2);
    header.writeUInt32BE(0, 10);
    socket.write(encodeWsFrame(0x02, Buffer.concat([header, cachedConfigFrame])));
    sendCommandToPhone(CMD_REQUEST_IDR);
  }

  socket.on("close", () => wsClients.delete(socket));
  socket.on("error", () => wsClients.delete(socket));
});

httpServer.listen(WEB_PORT, "0.0.0.0", () => {
  const ips = getLocalLanIps().map((i) => i.address).join(", ") || "127.0.0.1";
  console.log(`================================================================`);
  console.log(`  HYPERMIRROR PRO - PC GAMING RECEIVER READY`);
  console.log(`  - Control Center UI : http://localhost:${WEB_PORT}`);
  console.log(`  - LAN Wi-Fi IP(s)   : ${ips} (TCP Port ${STREAM_PORT})`);
  console.log(`================================================================`);
});
