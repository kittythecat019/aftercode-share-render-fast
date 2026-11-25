
const http = require("node:http");
const fs = require("node:fs/promises");
const path = require("node:path");

const PORT = process.env.PORT || 3100;
const HOST = "0.0.0.0";
const DATA_DIR = path.join(__dirname, "data");

const ALLOWED_ORIGINS = new Set([
  "https://aftercode-official.github.io"
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
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
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

async function loadJson(filePath) {
  const content = await fs.readFile(filePath, "utf8");
  return JSON.parse(content);
}

const DATASETS = {
  whatsHappening: {
    file: "whats-happening.json",
    limit: 5
  },
  featuredProjects: {
    file: "featured-projects.json",
    limit: 6
  },
  recentProjects: {
    file: "recent-projects.json",
    limit: 6
  },
  exploreProjects: {
    file: "explore-projects.json",
    limit: 8
  }
};

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

  // Kiểm tra trạng thái dữ liệu
  if (req.method === "GET" && req.url === "/api/status") {
    try {
      const info = await loadJson(
        path.join(DATA_DIR, "sync-info.json")
      );

      return sendJson(res, 200, {
        success: true,
        hasData: true,
        ...info
      });
    } catch {
      return sendJson(res, 200, {
        success: true,
        hasData: false,
        needsSync: true
      });
    }
  }

  // Render lấy toàn bộ dữ liệu
  if (req.method === "GET" && req.url === "/api/data") {
    try {
      const sharedDir = path.join(DATA_DIR, "shared");

      const data = {};

      for (const [key, config] of Object.entries(DATASETS)) {
        data[key] = await loadJson(
          path.join(sharedDir, config.file)
        );
      }

      const syncInfo = await loadJson(
        path.join(DATA_DIR, "sync-info.json")
      );

      return sendJson(res, 200, {
        success: true,
        updatedAt: syncInfo.updatedAt,
        data
      });
    } catch {
      return sendJson(res, 404, {
        success: false,
        hasData: false,
        needsSync: true,
        error: "Chưa có dữ liệu. Cần đồng bộ lại."
      });
    }
  }

  // Aftercode gửi dữ liệu lên Render
  if (req.method === "POST" && req.url === "/api/sync") {
    try {
      const payload = await readBody(req);
      const sharedDir = path.join(DATA_DIR, "shared");

      for (const [key, config] of Object.entries(DATASETS)) {
        if (!Array.isArray(payload[key])) {
          throw new Error(`Thiếu dữ liệu hợp lệ: ${key}`);
        }

        await saveJson(
          path.join(sharedDir, config.file),
          payload[key].slice(0, config.limit)
        );
      }

      const syncInfo = {
        success: true,
        updatedAt: new Date().toISOString(),
        counts: Object.fromEntries(
          Object.entries(DATASETS).map(([key, config]) => [
            key,
            Math.min(payload[key].length, config.limit)
          ])
        )
      };

      await saveJson(
        path.join(DATA_DIR, "sync-info.json"),
        syncInfo
      );

      return sendJson(res, 200, {
        success: true,
        message: "Đồng bộ thành công.",
        ...syncInfo
      });

    } catch (error) {
      console.error("Sync error:", error);

      return sendJson(res, 400, {
        success: false,
        error: error.message
      });
    }
  }

  return sendJson(res, 404, {
    success: false,
    error: "Endpoint không tồn tại."
  });
});

server.listen(PORT, HOST, () => {
  console.log("--------------------------------");
  console.log("Aftercode Render Sync Server");
  console.log(`Running at http://${HOST}:${PORT}`);
  console.log("--------------------------------");
});
