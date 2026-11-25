
const http = require("node:http");
const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");

const PORT = process.env.PORT || 3100;
const HOST = "0.0.0.0";
const DATA_DIR = path.join(__dirname, "data");

const AFTERCODE_ORIGIN = "https://aftercode-official.github.io";

const SOURCES = {
  projects:
    "https://epeqemysiivpzhpcervt.supabase.co/functions/v1/api/projects",
  activity:
    "https://epeqemysiivpzhpcervt.supabase.co/functions/v1/api/activity"
};

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

let syncing = false;
let lastSyncError = null;

function sendJson(res, status, data) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  res.end(JSON.stringify(data, null, 2));
}

function setCors(req, res) {
  const origin = req.headers.origin;

  if (origin === AFTERCODE_ORIGIN) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  }

  return !origin || origin === AFTERCODE_ORIGIN;
}

async function saveJson(filePath, data) {
  await fs.mkdir(path.dirname(filePath), {
    recursive: true
  });

  const temp = filePath + ".tmp";

  await fs.writeFile(
    temp,
    JSON.stringify(data, null, 2),
    "utf8"
  );

  await fs.rename(temp, filePath);
}

async function loadJson(filePath) {
  return JSON.parse(
    await fs.readFile(filePath, "utf8")
  );
}

async function readBody(req) {
  let body = "";
  let size = 0;

  for await (const chunk of req) {
    size += chunk.length;

    if (size > 1024 * 1024) {
      throw new Error("Dữ liệu gửi lên quá lớn.");
    }

    body += chunk;
  }

  return body ? JSON.parse(body) : {};
}

// Tìm mảng dữ liệu trong nhiều kiểu JSON API khác nhau.
function findArray(value, keys, depth = 0) {
  if (!value || typeof value !== "object" || depth > 6) {
    return null;
  }

  if (Array.isArray(value)) {
    return value;
  }

  for (const key of keys) {
    if (Array.isArray(value[key])) {
      return value[key];
    }
  }

  for (const child of Object.values(value)) {
    const found = findArray(child, keys, depth + 1);
    if (found) return found;
  }

  return null;
}

async function fetchAftercode(url) {
  const response = await fetch(url, {
    method: "GET",
    headers: {
      "Accept": "application/json"
    },
    signal: AbortSignal.timeout(20000)
  });

  if (!response.ok) {
    throw new Error(
      `Aftercode API trả về HTTP ${response.status}: ${url}`
    );
  }

  const json = await response.json();

  if (json && json.success === false) {
    throw new Error("Aftercode API báo lấy dữ liệu thất bại.");
  }

  return json;
}

function isPublic(project) {
  return project &&
    project.is_public === true;
}

function sortNewest(a, b) {
  return new Date(b.created_at || b.updated_at || 0) -
    new Date(a.created_at || a.updated_at || 0);
}

function buildDatasets(projects, activities) {
  const publicProjects = projects.filter(isPublic);

  return {
    whatsHappening: activities.slice(0, 5),

    featuredProjects: publicProjects
      .filter(project => project.is_featured === true)
      .sort(sortNewest)
      .slice(0, 6),

    recentProjects: [...publicProjects]
      .sort(sortNewest)
      .slice(0, 6),

    exploreProjects: [...publicProjects]
      .sort((a, b) =>
        Number(b.view_count || 0) -
        Number(a.view_count || 0)
      )
      .slice(0, 8)
  };
}

async function readCachedDatasets() {
  const sharedDir = path.join(DATA_DIR, "shared");
  const data = {};

  for (const [key, config] of Object.entries(DATASETS)) {
    data[key] = await loadJson(
      path.join(sharedDir, config.file)
    );
  }

  return data;
}

async function syncFromAftercode() {
  if (syncing) {
    return {
      success: false,
      message: "Đang có một lần đồng bộ khác."
    };
  }

  syncing = true;

  try {
    console.log("Đang lấy dữ liệu từ Aftercode...");

    const projectResponse = await fetchAftercode(SOURCES.projects);

let activityResponse = null;

try {
  activityResponse = await fetchAftercode(SOURCES.activity);
} catch (error) {
  console.warn("Không lấy được activity:", error.message);
}

    const projects = findArray(
      projectResponse,
      ["projects", "data", "items", "results"]
    );

    const activities = activityResponse
  ? findArray(
      activityResponse,
      ["activities", "activity", "data", "items", "results"]
    ) || []
  : [];

    if (!projects) {
      throw new Error(
        "Không tìm thấy mảng projects hoặc activities trong API."
      );
    }

    const datasets = buildDatasets(projects, activities);

    // Không ghi đè cache nếu API trả về toàn bộ dữ liệu rỗng.
    if (projects.length === 0 && activities.length === 0) {
      throw new Error("API trả về dữ liệu rỗng.");
    }

    const hash = crypto
      .createHash("sha256")
      .update(JSON.stringify(datasets))
      .digest("hex");

    let oldInfo = null;

    try {
      oldInfo = await loadJson(
        path.join(DATA_DIR, "sync-info.json")
      );
    } catch {}

    // Nếu dữ liệu không đổi thì không ghi lại.
    if (oldInfo && oldInfo.hash === hash) {
      lastSyncError = null;

      console.log("Dữ liệu không thay đổi.");

      return {
        success: true,
        changed: false,
        message: "Dữ liệu không thay đổi."
      };
    }

    const sharedDir = path.join(DATA_DIR, "shared");

    for (const [key, config] of Object.entries(DATASETS)) {
      await saveJson(
        path.join(sharedDir, config.file),
        datasets[key]
      );
    }

    const syncInfo = {
      success: true,
      updatedAt: new Date().toISOString(),
      hash,
      counts: Object.fromEntries(
        Object.entries(datasets).map(([key, value]) => [
          key,
          value.length
        ])
      )
    };

    await saveJson(
      path.join(DATA_DIR, "sync-info.json"),
      syncInfo
    );

    lastSyncError = null;

    console.log("Đã cập nhật dữ liệu:", syncInfo.counts);

    return {
      success: true,
      changed: true,
      ...syncInfo
    };

  } catch (error) {
    lastSyncError = error.message;
    console.error("Lỗi đồng bộ:", error.message);

    return {
      success: false,
      error: error.message
    };

  } finally {
    syncing = false;
  }
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

  const url = new URL(
    req.url,
    `http://${req.headers.host || "localhost"}`
  );

  if (req.method === "GET" && url.pathname === "/health") {
    return sendJson(res, 200, {
      success: true,
      server: "Aftercode Render Sync"
    });
  }

  if (req.method === "GET" && url.pathname === "/api/status") {
    try {
      const info = await loadJson(
        path.join(DATA_DIR, "sync-info.json")
      );

      return sendJson(res, 200, {
        success: true,
        hasData: true,
        syncing,
        lastSyncError,
        ...info
      });
    } catch {
      return sendJson(res, 200, {
        success: true,
        hasData: false,
        needsSync: true,
        syncing,
        lastSyncError
      });
    }
  }

  // Lấy dữ liệu: chỉ tự đồng bộ nếu cache chưa tồn tại.
  if (req.method === "GET" && url.pathname === "/api/data") {
    try {
      let data;
      let info;

      try {
        data = await readCachedDatasets();
        info = await loadJson(
          path.join(DATA_DIR, "sync-info.json")
        );
      } catch {
        const result = await syncFromAftercode();

        if (!result.success) {
          return sendJson(res, 502, result);
        }

        data = await readCachedDatasets();
        info = await loadJson(
          path.join(DATA_DIR, "sync-info.json")
        );
      }

      return sendJson(res, 200, {
        success: true,
        updatedAt: info.updatedAt,
        data
      });

    } catch (error) {
      return sendJson(res, 500, {
        success: false,
        error: error.message
      });
    }
  }

  // Aftercode gọi endpoint này khi có dữ liệu mới.
  if (req.method === "POST" && url.pathname === "/api/notify") {
    if (req.headers.origin !== AFTERCODE_ORIGIN) {
      return sendJson(res, 403, {
        success: false,
        error: "Chỉ nhận tín hiệu từ Aftercode."
      });
    }

    const result = await syncFromAftercode();

    return sendJson(
      res,
      result.success ? 200 : 502,
      result
    );
  }

  // Giữ lại endpoint đồng bộ cũ để tương thích.
  if (req.method === "POST" && url.pathname === "/api/sync") {
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

      return sendJson(res, 200, syncInfo);

    } catch (error) {
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
  console.log(`Running on port ${PORT}`);
  console.log("--------------------------------");
});
