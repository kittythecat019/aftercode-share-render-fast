
const http = require("node:http");
const fs = require("node:fs/promises");
const path = require("node:path");

const PORT = process.env.PORT || 3100;
const HOST = "0.0.0.0";

const DATA_DIR = path.join(__dirname, "data");

const ALLOWED_ORIGINS = new Set([
  "https://aftercode-official.github.io",
  "http://localhost:5173",
  "http://127.0.0.1:5173"
]);

function sendJson(res, status, data) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8"
  });
  res.end(JSON.stringify(data, null, 2));
}

function setCors(req, res) {
  const origin = req.headers.origin;

  if (origin && ALLOWED_ORIGINS.has(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    res.setHeader("Access-Control-Allow-Private-Network", "true");
  }

  return !origin || ALLOWED_ORIGINS.has(origin);
}

async function readBody(req) {
  let body = "";
  let size = 0;

  for await (const chunk of req) {
    size += chunk.length;

    if (size > 5 * 1024 * 1024) {
      throw new Error("Dữ liệu vượt quá giới hạn 5 MB.");
    }

    body += chunk;
  }

  return JSON.parse(body);
}

async function saveJson(filePath, data) {
  await fs.mkdir(path.dirname(filePath), {
    recursive: true
  });

  const temporaryPath = filePath + ".tmp";

  await fs.writeFile(
    temporaryPath,
    JSON.stringify(data, null, 2),
    "utf8"
  );

  await fs.rename(temporaryPath, filePath);
}

const server = http.createServer(async (req, res) => {
  if (!setCors(req, res)) {
    return sendJson(res, 403, {
      success: false,
      error: "Origin không được phép."
    });
  }

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    return res.end();
  }

  if (req.method === "GET" && req.url === "/health") {
    return sendJson(res, 200, {
      success: true,
      server: "Aftercode Render Sync",
      port: PORT
    });
  }

  if (req.method !== "POST" || req.url !== "/api/sync") {
    return sendJson(res, 404, {
      success: false,
      error: "Endpoint không tồn tại."
    });
  }

  try {
    const payload = await readBody(req);

    const requiredArrays = [
      "whatsHappening",
      "featuredProjects",
      "recentProjects",
      "exploreProjects"
    ];

    for (const key of requiredArrays) {
      if (!Array.isArray(payload[key])) {
        throw new Error(`Thiếu dữ liệu hợp lệ: ${key}`);
      }
    }

    const sharedDir = path.join(DATA_DIR, "shared");

    await Promise.all([
      saveJson(
        path.join(sharedDir, "whats-happening.json"),
        payload.whatsHappening.slice(0, 5)
      ),

      saveJson(
        path.join(sharedDir, "featured-projects.json"),
        payload.featuredProjects.slice(0, 6)
      ),

      saveJson(
        path.join(sharedDir, "recent-projects.json"),
        payload.recentProjects.slice(0, 6)
      ),

      saveJson(
        path.join(sharedDir, "explore-projects.json"),
        payload.exploreProjects.slice(0, 8)
      )
    ]);

    await saveJson(
      path.join(DATA_DIR, "sync-info.json"),
      {
        success: true,
        updatedAt: new Date().toISOString(),
        counts: {
          whatsHappening: Math.min(payload.whatsHappening.length, 5),
          featuredProjects: Math.min(payload.featuredProjects.length, 6),
          recentProjects: Math.min(payload.recentProjects.length, 6),
          exploreProjects: Math.min(payload.exploreProjects.length, 8)
        }
      }
    );

    return sendJson(res, 200, {
      success: true,
      message: "Đã nhận và lưu dữ liệu Aftercode.",
      counts: {
        whatsHappening: Math.min(payload.whatsHappening.length, 5),
        featuredProjects: Math.min(payload.featuredProjects.length, 6),
        recentProjects: Math.min(payload.recentProjects.length, 6),
        exploreProjects: Math.min(payload.exploreProjects.length, 8)
      }
    });

  } catch (error) {
    console.error("Sync error:", error);

    return sendJson(res, 400, {
      success: false,
      error: error.message
    });
  }
});

server.listen(PORT, HOST, () => {
  console.log("--------------------------------");
  console.log("Aftercode Render Sync Server");
  console.log(`Running at http://${HOST}:${PORT}`);
  console.log("--------------------------------");
});
