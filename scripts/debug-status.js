#!/usr/bin/env node
/**
 * HyperMirror Pro - Self Diagnostic & Debug Inspector
 * 
 * Usage: node scripts/debug-status.js
 * Scans ADB devices, tunnels, local server ports, and parses recent audio/video telemetry logs.
 */

const fs = require("fs");
const path = require("path");
const os = require("os");
const http = require("http");
const { execSync } = require("child_process");

function resolveAdb() {
  const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
  const sdkAdb = path.join(localAppData, "Android", "Sdk", "platform-tools", "adb.exe");
  return fs.existsSync(sdkAdb) ? `"${sdkAdb}"` : "adb";
}

const ADB = resolveAdb();
const LOGS_DIR = path.join(__dirname, "..", "logs");

console.log("=================================================");
console.log("🔍 HYPERMIRROR PRO - CHẨN ĐOÁN HỆ THỐNG & LOGS");
console.log("=================================================");

// 1. Check ADB Devices
console.log("\n[1] Kiểm Tra Thiết Bị Android (ADB)...");
let adbConnected = false;
let deviceId = null;
try {
  const adbOut = execSync(`${ADB} devices -l`, { encoding: "utf8", timeout: 3000 });
  const lines = adbOut.trim().split(/\r?\n/).slice(1).filter(l => l.trim().length > 0);
  if (lines.length === 0) {
    console.log("  ⚠️  Không tìm thấy thiết bị Android nào cắm qua USB (hoặc chưa bật USB Debugging).");
  } else {
    lines.forEach(l => {
      console.log(`  📱 ${l}`);
      if (!l.includes("unauthorized") && !l.includes("offline")) {
        adbConnected = true;
        const match = l.match(/^(\S+)/);
        if (match && !deviceId) deviceId = match[1];
      }
    });
  }
} catch (e) {
  console.log(`  ❌ Lỗi khi gọi ADB: ${e.message}`);
}

// 2. Check ADB Port Forwarding / Reversing
if (adbConnected) {
  console.log("\n[2] Kiểm Tra Cấu Hình Cổng ADB Tunnels...");
  try {
    const rev = execSync(`${ADB} reverse --list`, { encoding: "utf8", timeout: 2000 }).trim();
    const fwd = execSync(`${ADB} forward --list`, { encoding: "utf8", timeout: 2000 }).trim();
    console.log(`  🔁 Reverse Tunnels:\n${rev ? rev.split("\n").map(s => "     " + s).join("\n") : "     (Chưa thiết lập)"}`);
    console.log(`  ⏩ Forward Tunnels:\n${fwd ? fwd.split("\n").map(s => "     " + s).join("\n") : "     (Chưa thiết lập)"}`);
  } catch (e) {
    console.log(`  ⚠️ Không thể đọc danh sách ADB tunnels: ${e.message}`);
  }
}

// 3. Check PC Receiver Server Status via HTTP
console.log("\n[3] Kiểm Tra Máy Chủ PC Receiver (http://localhost:3080)...");
function checkServerStatus() {
  return new Promise((resolve) => {
    const req = http.get("http://127.0.0.1:3080/api/info", { timeout: 1500 }, (res) => {
      let data = "";
      res.on("data", chunk => data += chunk);
      res.on("end", () => {
        try {
          const info = JSON.parse(data);
          resolve({ ok: true, info });
        } catch (_) {
          resolve({ ok: true, raw: data });
        }
      });
    });
    req.on("error", (err) => resolve({ ok: false, error: err.message }));
  });
}

(async () => {
  const srv = await checkServerStatus();
  if (srv.ok) {
    console.log("  ✅ Server PC đang chạy mượt mà tại http://localhost:3080");
    if (srv.info && srv.info.meta) {
      const meta = srv.info.meta;
      console.log(`  📡 Trạng thái Stream: ${meta.connected ? "🟢 ĐANG KẾT NỐI (" + meta.mode + ")" : "⚪ Chờ kết nối..."}`);
      if (meta.connected) {
        console.log(`     Codec: ${meta.codec || "Auto"} | FPS: ${meta.fps || 0} | Độ phân giải: ${meta.width}x${meta.height}`);
      }
    }
  } else {
    console.log(`  ❌ Server PC CHƯA CHẠY hoặc không phản hồi (${srv.error}). Hãy chạy: npm start hoặc node server.js trong pc-receiver!`);
  }

  // 4. Inspect Logs Directory & Latest Telemetry
  console.log("\n[4] Kiểm Tra Thư Mục Nhật Ký (Logs Engine)...");
  if (!fs.existsSync(LOGS_DIR)) {
    console.log(`  ⚠️ Thư mục ${LOGS_DIR} chưa được tạo.`);
  } else {
    const logFiles = fs.readdirSync(LOGS_DIR).filter(f => f.endsWith(".log")).sort().reverse();
    console.log(`  📁 Tìm thấy ${logFiles.length} file log: ${logFiles.slice(0, 5).join(", ")}`);
    const latestPath = path.join(LOGS_DIR, "latest.log");
    if (fs.existsSync(latestPath)) {
      const stat = fs.statSync(latestPath);
      console.log(`  📄 File latest.log (${(stat.size / 1024).toFixed(1)} KB) - Cập nhật lúc: ${stat.mtime.toLocaleTimeString()}`);
      
      const content = fs.readFileSync(latestPath, "utf8");
      const lines = content.trim().split(/\r?\n/);
      const tail = lines.slice(-25);

      console.log("\n--- [25 DÒNG LOG MỚI NHẤT TRONG latest.log] ---");
      tail.forEach(line => {
        if (line.includes("[ERROR]") || line.includes("Alert")) {
          console.log(`  ❌ ${line}`);
        } else if (line.includes("[WARN]")) {
          console.log(`  ⚠️  ${line}`);
        } else if (line.includes("[Audio Telemetry]")) {
          console.log(`  🔊 ${line}`);
        } else if (line.includes("[Browser Client]")) {
          console.log(`  🌐 ${line}`);
        } else {
          console.log(`     ${line}`);
        }
      });
      console.log("-------------------------------------------------");
    }
  }

  // 5. Android logcat for Audio / Streamer events if device is connected
  if (adbConnected && deviceId) {
    console.log("\n[5] Kiểm Tra Nhật Ký Trên Điện Thoại Android (Logcat Audio)...");
    try {
      const logcatOut = execSync(
        `${ADB} -s ${deviceId} logcat -d -s HyperAudio:V AudioStreamer:V HyperSender:V AudioRecord:W *:E`,
        { encoding: "utf8", timeout: 3000 }
      );
      const logLines = logcatOut.trim().split(/\r?\n/).slice(-15);
      if (logLines.length > 0 && logLines[0].length > 0) {
        logLines.forEach(l => console.log(`  📱 [Logcat] ${l}`));
      } else {
        console.log("  📱 Logcat bình thường, không có lỗi AudioRecord nào được báo cáo gần đây.");
      }
    } catch (e) {
      console.log(`  ⚠️ Không thể đọc Android logcat: ${e.message}`);
    }
  }

  console.log("\n=================================================");
  console.log("💡 KẾT LUẬN & HƯỚNG DẪN:");
  console.log("  1. Mở http://localhost:3080 để xem màn hình & âm thanh trực tiếp.");
  console.log("  2. Nhấp vào nút '📋 Xem Nhật Ký / Logs Trực Tiếp (Debug)' trên giao diện để theo dõi log real-time.");
  console.log("  3. Nếu gặp sự cố âm thanh, chạy 'node scripts/debug-status.js' để tự động chẩn đoán!");
  console.log("=================================================\n");
})();
