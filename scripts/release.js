/**
 * Automated GitHub Release Publisher for HyperMirror
 * Usage: node scripts/release.js <tag> "<release-title>" "<changelog>"
 */

const https = require("https");
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

function getGitToken() {
  if (process.env.GH_TOKEN) return process.env.GH_TOKEN;
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
  try {
    const cred = execSync('cmd.exe /c "(echo protocol=https & echo host=github.com & echo.) | git credential fill"', {
      stdio: ["pipe", "pipe", "ignore"],
    }).toString();
    const match = cred.match(/^password=(.+)$/m);
    if (match) return match[1].trim();
  } catch (_) {}
  return null;
}

function request(options, data) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let chunks = [];
      res.on("data", (d) => chunks.push(d));
      res.on("end", () => {
        const buf = Buffer.concat(chunks);
        resolve({ statusCode: res.statusCode, headers: res.headers, data: buf });
      });
    });
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}

async function main() {
  const tag = process.argv[2] || "v1.0.1";
  const title = process.argv[3] || `HyperMirror Pro ${tag}`;
  const notes = process.argv[4] || `Bản phát hành ${tag} với các cải tiến và bản vá mới nhất.`;

  const token = getGitToken();
  if (!token) {
    console.error("Không tìm thấy token GitHub trong Git Credential Manager hoặc biến môi trường GH_TOKEN.");
    process.exit(1);
  }

  const repo = "Vpbac/HyperMirror";
  const apkPath = path.join(__dirname, "..", "HyperMirrorSender-debug.apk");
  if (!fs.existsSync(apkPath)) {
    console.error("Chưa có file APK tại:", apkPath);
    process.exit(1);
  }

  console.log(`Đang tạo GitHub Release [${tag}] trên ${repo}...`);

  const payload = JSON.stringify({
    tag_name: tag,
    target_commitish: "main",
    name: title,
    body: notes,
    draft: false,
    prerelease: false,
  });

  const relRes = await request(
    {
      hostname: "api.github.com",
      path: `/repos/${repo}/releases`,
      method: "POST",
      headers: {
        "User-Agent": "HyperMirror-Release-Bot",
        Authorization: `token ${token}`,
        Accept: "application/vnd.github.v3+json",
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(payload),
      },
    },
    payload
  );

  const relData = JSON.parse(relRes.data.toString());
  if (relRes.statusCode >= 300) {
    console.error("Lỗi tạo Release:", relRes.statusCode, relData);
    process.exit(1);
  }

  console.log(`Release tạo thành công: ${relData.html_url}`);
  console.log("Đang tải file APK lên Release...");

  const uploadUrl = new URL(relData.upload_url.replace("{?name,label}", "?name=HyperMirrorSender-debug.apk"));
  const apkBytes = fs.readFileSync(apkPath);

  const uploadRes = await request(
    {
      hostname: uploadUrl.hostname,
      path: uploadUrl.pathname + uploadUrl.search,
      method: "POST",
      headers: {
        "User-Agent": "HyperMirror-Release-Bot",
        Authorization: `token ${token}`,
        "Content-Type": "application/vnd.android.package-archive",
        "Content-Length": apkBytes.length,
      },
    },
    apkBytes
  );

  const uploadData = JSON.parse(uploadRes.data.toString());
  console.log(`Tải file APK lên thành công!`);
  console.log(`Link tải trực tiếp: ${uploadData.browser_download_url}`);
}

main().catch((err) => {
  console.error("Lỗi:", err.message);
  process.exit(1);
});
