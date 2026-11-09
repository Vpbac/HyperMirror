/**
 * HyperMirror Pro - PC Receiver & Low-Latency Gaming Engine
 * Supports:
 * 1. Auto USB Wired Tunnel (Auto ADB Forward + ADB Reverse + Active Poll)
 * 2. Wi-Fi 5GHz/6GHz Direct Socket Mode (:27183)
 * 3. Dual Browser Rendering Engine:
 *    - Primary: WebCodecs GPU Hardware Decoder (VideoDecoder optimizeForLatency: true, Zero external dependencies!)
 *    - Optional Fallback: FFmpeg MJPEG Stream (only if ffmpeg is installed)
 * 4. Native Direct3D11 / SDL Ultra-Low-Latency Window (via FFplay Zero-Buffer pipe)
 */

const net = require("net");
const dgram = require("dgram");
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const os = require("os");
const { spawn, exec, execSync } = require("child_process");

const STREAM_PORT = Number(process.env.STREAM_PORT || 27183);
const WEB_PORT = Number(process.env.WEB_PORT || 3080);

// Global crash protection so child_process or socket errors never terminate the server
process.on("uncaughtException", (err) => {
  console.warn(`[SafeGuard] Ignored non-fatal exception: ${err.message}`);
});
process.on("unhandledRejection", (reason) => {
  console.warn(`[SafeGuard] Ignored unhandled rejection: ${reason}`);
});

function resolveFfmpegTool(toolName) {
  const exeName = process.platform === "win32" ? `${toolName}.exe` : toolName;
  const localAppData =
    process.env.LOCALAPPDATA ||
    path.join(os.homedir(), "AppData", "Local");

  const wingetBase = path.join(localAppData, "Microsoft", "WinGet", "Packages");
  try {
    if (fs.existsSync(wingetBase)) {
      for (const pkg of fs.readdirSync(wingetBase)) {
        if (pkg.toLowerCase().includes("ffmpeg")) {
          const pkgDir = path.join(wingetBase, pkg);
          if (!fs.statSync(pkgDir).isDirectory()) continue;
          for (const sub of fs.readdirSync(pkgDir)) {
            const subDir = path.join(pkgDir, sub);
            try {
              if (!fs.statSync(subDir).isDirectory()) continue;
              const candidate = path.join(subDir, "bin", exeName);
              if (fs.existsSync(candidate)) return candidate;
            } catch (_) {}
          }
        }
      }
    }
  } catch (_) {}

  // Check `where.exe` on Windows
  try {
    const out = execSync(`where.exe ${exeName}`, {
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 1500,
    })
      .toString()
      .trim()
      .split(/\r?\n/)[0];
    if (out && fs.existsSync(out)) return out;
  } catch (_) {}

  return null; // Not installed or not found
}

function resolveAdbTool() {
  const localAppData =
    process.env.LOCALAPPDATA ||
    path.join(os.homedir(), "AppData", "Local");
  const sdkAdb = path.join(
    localAppData,
    "Android",
    "Sdk",
    "platform-tools",
    "adb.exe"
  );
  return fs.existsSync(sdkAdb) ? `"${sdkAdb}"` : "adb";
}

const FFMPEG_BIN = resolveFfmpegTool("ffmpeg");
const FFPLAY_BIN = resolveFfmpegTool("ffplay");
const ADB_CMD = resolveAdbTool();

// Protocol constants
const FRAME_TYPE_CONFIG = 0x01;
const FRAME_TYPE_KEYFRAME = 0x02;
const FRAME_TYPE_NORMAL = 0x03;
const FRAME_TYPE_PING = 0x04;
const FRAME_TYPE_JPEG = 0x05;

const CMD_REQUEST_IDR = 0x10;
const CMD_SET_BITRATE = 0x11;
const CMD_PONG = 0x12;

let activePhoneSocket = null;
let streamMeta = {
  connected: false,
  remoteAddress: "-",
  deviceName: "-",
  codec: "H.264",
  codecId: 1,
  width: 1920,
  height: 1080,
  targetFps: 60,
  targetBitrateKbps: 16000,
};

let cachedConfigFrame = null;
let ffplayProcess = null;
let universalDecoderProcess = null;
let simulatorProcess = null;
let simulatorSocket = null;

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
  const frame = encodeWsFrame(0x01, payload);
  for (const sock of wsClients) {
    if (!sock.destroyed) {
      try {
        sock.write(frame);
      } catch (_) {}
    }
  }
}

function broadcastBinaryVideoFrame(frameType, codecId, ptsUs, encodeDurationUs, payloadBuffer) {
  if (wsClients.size === 0) return;
  const header = Buffer.allocUnsafe(14);
  header[0] = frameType;
  header[1] = codecId;
  header.writeBigInt64BE(ptsUs, 2);
  header.writeUInt32BE(encodeDurationUs, 10);
  const wsPacket = encodeWsFrame(0x02, Buffer.concat([header, payloadBuffer]));
  for (const sock of wsClients) {
    if (!sock.destroyed) {
      try {
        sock.write(wsPacket);
      } catch (_) {}
    }
  }
}

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
  } catch (_) {
    return false;
  }
}

/**
 * Optional Universal FFmpeg Decoder Pipe (only runs if FFMPEG_BIN is found on system)
 */
function startUniversalDecoder(codecId = 1) {
  stopUniversalDecoder();
  if (!FFMPEG_BIN) {
    // WebCodecs in browser handles H.264/H.265 hardware decoding directly without needing ffmpeg
    return;
  }

  const inputFormat = codecId === 2 ? "hevc" : "h264";
  const args = [
    "-fflags", "nobuffer",
    "-flags", "low_delay",
    "-probesize", "65536",
    "-analyzeduration", "100000",
    "-f", inputFormat,
    "-i", "pipe:0",
    "-strict", "-2",
    "-pix_fmt", "yuvj420p",
    "-f", "image2pipe",
    "-vcodec", "mjpeg",
    "-q:v", "4",
    "pipe:1",
  ];

  try {
    const proc = spawn(FFMPEG_BIN, args, { stdio: ["pipe", "pipe", "ignore"] });
    universalDecoderProcess = proc;

    proc.on("error", (err) => {
      console.warn(`[Universal Decoder] FFmpeg unavailable (${err.message}), using WebCodecs GPU directly.`);
      if (universalDecoderProcess === proc) {
        universalDecoderProcess = null;
      }
    });

    if (proc.stdin) {
      proc.stdin.on("error", () => {});
      if (cachedConfigFrame && !proc.stdin.destroyed) {
        try {
          proc.stdin.write(cachedConfigFrame);
        } catch (_) {}
      }
    }

    let jpegAcc = Buffer.alloc(0);
    if (proc.stdout) {
      proc.stdout.on("error", () => {});
      proc.stdout.on("data", (chunk) => {
        jpegAcc = jpegAcc.length === 0 ? chunk : Buffer.concat([jpegAcc, chunk]);

        while (true) {
          let soi = -1;
          for (let i = 0; i < jpegAcc.length - 1; i++) {
            if (jpegAcc[i] === 0xff && jpegAcc[i + 1] === 0xd8) {
              soi = i;
              break;
            }
          }
          if (soi < 0) {
            jpegAcc = Buffer.alloc(0);
            break;
          }
          let eoi = -1;
          for (let i = soi + 2; i < jpegAcc.length - 1; i++) {
            if (jpegAcc[i] === 0xff && jpegAcc[i + 1] === 0xd9) {
              eoi = i + 2;
              break;
            }
          }
          if (eoi < 0) {
            if (soi > 0) jpegAcc = jpegAcc.subarray(soi);
            break;
          }

          const jpegFrame = jpegAcc.subarray(soi, eoi);
          jpegAcc = jpegAcc.subarray(eoi);

          const nowUs = BigInt(Date.now()) * 1000n;
          broadcastBinaryVideoFrame(FRAME_TYPE_JPEG, codecId, nowUs, 1800, jpegFrame);
        }
      });
    }

    proc.on("exit", () => {
      if (universalDecoderProcess === proc) {
        universalDecoderProcess = null;
      }
    });
  } catch (_) {
    universalDecoderProcess = null;
  }
}

function stopUniversalDecoder() {
  if (universalDecoderProcess) {
    try {
      universalDecoderProcess.kill();
    } catch (_) {}
    universalDecoderProcess = null;
  }
}

function attachPhoneStreamSocket(socket, modeLabel = "TCP") {
  if (activePhoneSocket && activePhoneSocket !== socket && !activePhoneSocket.destroyed) {
    try {
      socket.destroy();
    } catch (_) {}
    return;
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
        startUniversalDecoder(codecId);
      } else {
        handshakeDone = true;
        startUniversalDecoder(1);
      }
    }

    while (rxBuffer.length >= 17) {
      const frameType = rxBuffer.readUInt8(0);
      const ptsUs = rxBuffer.readBigInt64BE(1);
      const encodeDurationUs = rxBuffer.readUInt32BE(9);
      const payloadLen = rxBuffer.readUInt32BE(13);

      if (payloadLen > 16 * 1024 * 1024 || frameType < 1 || frameType > 4) {
        console.warn(`[GMIR] Invalid frame header (type=${frameType}, len=${payloadLen}), resyncing`);
        rxBuffer = Buffer.alloc(0);
        sendCommandToPhone(CMD_REQUEST_IDR);
        break;
      }

      if (rxBuffer.length < 17 + payloadLen) {
        break;
      }

      const payload = Buffer.from(rxBuffer.subarray(17, 17 + payloadLen));
      rxBuffer = rxBuffer.subarray(17 + payloadLen);

      if (frameType === FRAME_TYPE_PING) {
        if (payload.length >= 8) {
          sendCommandToPhone(CMD_PONG, payload.subarray(0, 8));
        }
        continue;
      }

      if (frameType === FRAME_TYPE_CONFIG) {
        cachedConfigFrame = payload;
      }

      if (ffplayProcess && ffplayProcess.stdin && !ffplayProcess.stdin.destroyed) {
        try {
          ffplayProcess.stdin.write(payload);
        } catch (_) {}
      }

      if (universalDecoderProcess && universalDecoderProcess.stdin && !universalDecoderProcess.stdin.destroyed) {
        try {
          if (frameType === FRAME_TYPE_KEYFRAME && cachedConfigFrame) {
            universalDecoderProcess.stdin.write(cachedConfigFrame);
          }
          universalDecoderProcess.stdin.write(payload);
        } catch (_) {}
      }

      broadcastBinaryVideoFrame(frameType, streamMeta.codecId, ptsUs, encodeDurationUs, payload);
    }
  });

  socket.on("close", () => {
    if (activePhoneSocket === socket) {
      activePhoneSocket = null;
      streamMeta.connected = false;
      stopUniversalDecoder();
      broadcastJson({ type: "status", meta: streamMeta });
      console.log("[Stream] Phone disconnected.");
    }
  });

  socket.on("error", (err) => {
    console.warn(`[Stream Socket Error] ${err.message}`);
  });
}

// 1. TCP Server on 0.0.0.0:27183
const tcpServer = net.createServer((socket) => {
  console.log(`[TCP Server] Incoming connection from ${socket.remoteAddress}:${socket.remotePort}`);
  attachPhoneStreamSocket(socket, "Incoming Wi-Fi / USB Reverse");
});

tcpServer.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.log(`[Info] TCP Stream Port ${STREAM_PORT} is already active.`);
  } else {
    console.warn(`[TCP Server Error] ${err.message}`);
  }
});

tcpServer.listen(STREAM_PORT, "0.0.0.0", () => {
  console.log(`[HyperMirror TCP Server] Listening on 0.0.0.0:${STREAM_PORT} (TCP_NODELAY enabled)`);
});

// 2. Active Connect to Android Server
function connectToPhoneServer(host = "127.0.0.1", port = STREAM_PORT, label = "USB ADB Forward") {
  return new Promise((resolve, reject) => {
    if (activePhoneSocket && !activePhoneSocket.destroyed) {
      resolve(true);
      return;
    }
    const client = new net.Socket();
    client.setTimeout(1500);
    client.connect(port, host, () => {
      client.setTimeout(0);
      let gotData = false;
      const timer = setTimeout(() => {
        if (!gotData && host === "127.0.0.1") {
          client.destroy();
          reject(new Error("Loopback self-connection ignored"));
        }
      }, 600);

      client.once("data", (firstChunk) => {
        gotData = true;
        clearTimeout(timer);
        attachPhoneStreamSocket(client, label);
        client.emit("data", firstChunk);
        resolve(true);
      });
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

// 3. Automatic Background USB ADB Tunnel + UDP Wi-Fi Auto-Discovery & Reverse Bypass
const udpBeacon = dgram.createSocket({ type: "udp4", reuseAddr: true });
udpBeacon.on("error", (err) => {
  console.warn(`[UDP Beacon] ${err.message}`);
});

udpBeacon.on("message", (msg, rinfo) => {
  const str = msg.toString("utf8").trim();
  if (str.startsWith("GMIR_PHONE_READY")) {
    const parts = str.split(":");
    const phonePort = parts.length > 1 ? Number(parts[1]) : 27184;
    if (!activePhoneSocket || activePhoneSocket.destroyed) {
      console.log(`[Auto-Discovery] Phone beacon detected from ${rinfo.address}:${phonePort}, initiating outbound connect...`);
      connectToPhoneServer(rinfo.address, phonePort, "Wi-Fi Outbound (Firewall Bypass)").catch(() => {});
    }
  }
});

udpBeacon.bind(27185, "0.0.0.0", () => {
  try {
    udpBeacon.setBroadcast(true);
  } catch (_) {}
});

let adbCheckInProgress = false;

setInterval(() => {
  // Broadcast PC presence on Wi-Fi LAN so Android phones auto-fill the PC IP
  const msg = Buffer.from(`GMIR_PC_HERE:${STREAM_PORT}`);
  try {
    udpBeacon.send(msg, 27185, "255.255.255.255");
    for (const item of getLocalLanIps()) {
      const parts = item.address.split(".");
      if (parts.length === 4) {
        parts[3] = "255";
        udpBeacon.send(msg, 27185, parts.join("."));
      }
    }
  } catch (_) {}

  if (activePhoneSocket && !activePhoneSocket.destroyed) return;
  if (adbCheckInProgress) return;
  adbCheckInProgress = true;
  exec(
    `${ADB_CMD} forward tcp:27184 tcp:27184 && ${ADB_CMD} reverse tcp:${STREAM_PORT} tcp:${STREAM_PORT}`,
    { timeout: 1800 },
    (err) => {
      adbCheckInProgress = false;
      if (!err && (!activePhoneSocket || activePhoneSocket.destroyed)) {
        connectToPhoneServer("127.0.0.1", 27184, "Auto USB Cable").catch(() => {});
      }
    }
  );
}, 3000);

// 4. Native FFplay Direct3D Window
function toggleNativeFfplayWindow() {
  if (ffplayProcess) {
    try {
      ffplayProcess.kill();
    } catch (_) {}
    ffplayProcess = null;
    broadcastJson({ type: "ffplay", active: false });
    return { active: false };
  }

  if (!FFPLAY_BIN) {
    return {
      active: false,
      error: "Không tìm thấy ffplay.exe trên máy. Hãy xem trực tiếp trên trình duyệt (WebCodecs GPU)!",
    };
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
    "-i", "pipe:0",
  ];

  try {
    const proc = spawn(FFPLAY_BIN, args, { stdio: ["pipe", "ignore", "ignore"] });
    ffplayProcess = proc;
    proc.on("error", () => {
      if (ffplayProcess === proc) ffplayProcess = null;
      broadcastJson({ type: "ffplay", active: false });
    });
    if (proc.stdin) {
      proc.stdin.on("error", () => {});
      if (cachedConfigFrame) {
        try {
          proc.stdin.write(cachedConfigFrame);
        } catch (_) {}
        sendCommandToPhone(CMD_REQUEST_IDR);
      }
    }
    proc.on("exit", () => {
      if (ffplayProcess === proc) ffplayProcess = null;
      broadcastJson({ type: "ffplay", active: false });
    });
    broadcastJson({ type: "ffplay", active: true });
    return { active: true };
  } catch (err) {
    ffplayProcess = null;
    return { active: false, error: err.message };
  }
}

// 5. Built-in 60FPS Simulator
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

  if (!FFMPEG_BIN) {
    return { active: false, error: "Cần cài FFmpeg để chạy bộ giả lập luồng." };
  }

  const width = 1280;
  const height = 720;
  const sock = net.createConnection({ host: "127.0.0.1", port: STREAM_PORT }, () => {
    sock.setNoDelay(true);

    const hs = Buffer.alloc(24);
    hs.write("GMIR", 0, "ascii");
    hs.writeUInt8(1, 4);
    hs.writeUInt8(1, 5);
    hs.writeUInt16BE(width, 6);
    hs.writeUInt16BE(height, 8);
    hs.writeUInt16BE(fps, 10);
    hs.writeUInt32BE(bitrateMbps * 1000, 12);
    hs.write("SIM-60Hz".padEnd(8, " ").slice(0, 8), 16, "ascii");
    sock.write(hs);

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
      "pipe:1",
    ];

    const proc = spawn(FFMPEG_BIN, ffArgs, { stdio: ["ignore", "pipe", "ignore"] });
    simulatorProcess = proc;
    proc.on("error", () => {
      if (simulatorProcess === proc) simulatorProcess = null;
      if (!sock.destroyed) sock.destroy();
      broadcastJson({ type: "simulator", active: false });
    });

    let frameIndex = 0n;
    if (proc.stdout) {
      proc.stdout.on("error", () => {});
      proc.stdout.on("data", (nalChunk) => {
        if (sock.destroyed) return;
        const ptsUs = (frameIndex * 1000000n) / BigInt(fps);
        frameIndex++;

        let fType = FRAME_TYPE_NORMAL;
        for (let i = 0; i < nalChunk.length - 4; i++) {
          if (
            nalChunk[i] === 0 &&
            nalChunk[i + 1] === 0 &&
            nalChunk[i + 2] === 0 &&
            nalChunk[i + 3] === 1
          ) {
            const nalType = nalChunk[i + 4] & 0x1f;
            if (nalType === 5 || nalType === 7) {
              fType = FRAME_TYPE_KEYFRAME;
              break;
            }
          }
        }

        const pkt = Buffer.allocUnsafe(17 + nalChunk.length);
        pkt.writeUInt8(fType, 0);
        pkt.writeBigInt64BE(ptsUs, 1);
        pkt.writeUInt32BE(1450, 9);
        pkt.writeUInt32BE(nalChunk.length, 13);
        nalChunk.copy(pkt, 17);
        try {
          sock.write(pkt);
        } catch (_) {}
      });
    }

    proc.on("exit", () => {
      if (simulatorProcess === proc) simulatorProcess = null;
      if (!sock.destroyed) sock.destroy();
      broadcastJson({ type: "simulator", active: false });
    });
  });

  sock.on("error", () => {});
  simulatorSocket = sock;
  broadcastJson({ type: "simulator", active: true });
  return { active: true };
}

function setupUsbAdbTunnel() {
  return new Promise((resolve) => {
    exec(
      `${ADB_CMD} forward tcp:27184 tcp:27184 && ${ADB_CMD} reverse tcp:${STREAM_PORT} tcp:${STREAM_PORT}`,
      (err, stdout, stderr) => {
        if (err) {
          resolve({
            ok: false,
            message:
              "Không tìm thấy thiết bị ADB hoặc chưa bật USB Debugging. Bạn vẫn có thể kết nối qua Wi-Fi IP!",
            details: stderr || err.message,
          });
        } else {
          connectToPhoneServer("127.0.0.1", 27184, "USB Cable (ADB Forward)")
            .then(() => {
              resolve({
                ok: true,
                message: `Đã kết nối thành công qua cáp USB và bắt đầu nhận luồng hình ảnh!`,
              });
            })
            .catch(() => {
              resolve({
                ok: true,
                message: `Đã mở đường hầm cáp USB (adb forward & reverse). Hãy bấm 'Bắt đầu chiếu' trên điện thoại!`,
              });
            });
        }
      }
    );
  });
}

// 6. HTTP + WebSocket Server
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

    exec(`${ADB_CMD} install -r "${apkPath}"`, (err, stdout, stderr) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      if (err) {
        res.end(
          JSON.stringify({
            ok: false,
            message: `Chưa thể cài qua USB ADB (${stderr || err.message}).`,
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
        const targetHost = host || "127.0.0.1";
        const portsToTry = port ? [Number(port)] : [27184, 27183];
        let connected = false;
        let lastErr = null;
        for (const p of portsToTry) {
          try {
            await connectToPhoneServer(targetHost, p, `Direct -> ${targetHost}:${p}`);
            connected = true;
            break;
          } catch (e) {
            lastErr = e;
          }
        }
        if (connected) {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true, message: `Đã kết nối thành công tới ${targetHost}!` }));
        } else {
          throw lastErr || new Error("Connection failed");
        }
      } catch (err) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, message: `Đang chờ điện thoại phát luồng (${err.message})` }));
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

httpServer.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.log(`================================================================`);
    console.log(`  HyperMirror Pro PC Receiver is ALREADY running!`);
    console.log(`  Open http://localhost:${WEB_PORT} in your browser.`);
    console.log(`================================================================`);
    process.exit(0);
  }
});

httpServer.listen(WEB_PORT, "0.0.0.0", () => {
  const ips = getLocalLanIps().map((i) => i.address).join(", ") || "127.0.0.1";
  console.log(`================================================================`);
  console.log(`  HYPERMIRROR PRO - PC GAMING RECEIVER READY`);
  console.log(`  - Control Center UI : http://localhost:${WEB_PORT}`);
  console.log(`  - LAN Wi-Fi IP(s)   : ${ips} (TCP Port ${STREAM_PORT})`);
  console.log(`  - FFmpeg Engine     : ${FFMPEG_BIN ? "Found" : "WebCodecs GPU Direct Mode"}`);
  console.log(`================================================================`);

  if (process.platform === "win32") {
    exec(`start "" "http://localhost:${WEB_PORT}"`);
  }
});
