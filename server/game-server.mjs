import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, stat } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CONTENT_TYPES = new Map([
  [".css", "text/css; charset=utf-8"],
  [".fnt", "text/plain; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".ico", "image/x-icon"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".mp3", "audio/mpeg"],
  [".ogg", "audio/ogg"],
  [".plist", "application/xml; charset=utf-8"],
  [".png", "image/png"],
  [".xml", "application/xml; charset=utf-8"],
]);

function proofFor(secret, challenge) {
  return createHmac("sha256", secret).update(challenge).digest("hex");
}

function safePath(root, pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (decoded.includes("\0")) return null;
  const filename = path.resolve(root, decoded.replace(/^\/+/, "") || "index.html");
  if (filename !== root && !filename.startsWith(`${root}${path.sep}`)) return null;
  return filename;
}

function rangeFor(value, size) {
  if (typeof value !== "string" || !value.startsWith("bytes=")) return null;
  const [startText, endText] = value.slice(6).split("-", 2);
  const start = startText ? Number(startText) : Math.max(0, size - Number(endText || 0));
  const end = endText ? Number(endText) : size - 1;
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || start >= size) return null;
  return { start, end: Math.min(end, size - 1) };
}

async function sendStatic(request, response, filename) {
  let details;
  try {
    details = await stat(filename);
  } catch {
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("Not found");
    return;
  }
  if (details.isDirectory()) return sendStatic(request, response, path.join(filename, "index.html"));

  const headers = {
    "accept-ranges": "bytes",
    "cache-control": path.basename(filename) === "index.html" || path.basename(filename) === "codex-entry.js"
      ? "no-cache"
      : "public, max-age=31536000, immutable",
    "content-type": CONTENT_TYPES.get(path.extname(filename).toLowerCase()) || "application/octet-stream",
    "x-content-type-options": "nosniff",
  };
  if (request.headers.origin === "app://-") {
    headers["access-control-allow-origin"] = "app://-";
    headers.vary = "Origin";
  }
  const range = rangeFor(request.headers.range, details.size);
  if (range) {
    headers["content-range"] = `bytes ${range.start}-${range.end}/${details.size}`;
    headers["content-length"] = String(range.end - range.start + 1);
    response.writeHead(206, headers);
    if (request.method !== "HEAD") createReadStream(filename, { start: range.start, end: range.end }).pipe(response);
    else response.end();
    return;
  }
  headers["content-length"] = String(details.size);
  response.writeHead(200, headers);
  if (request.method !== "HEAD") createReadStream(filename).pipe(response);
  else response.end();
}

export async function startGameServer({ gameRoot, host = "127.0.0.1", port = 0 } = {}) {
  const root = path.resolve(gameRoot || path.join(path.dirname(fileURLToPath(import.meta.url)), "../game/web-desktop"));
  await mkdir(root, { recursive: true });
  const token = randomUUID();
  const secret = randomBytes(32).toString("hex");
  const prefix = `/${token}/doudizhu`;
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url || "/", `http://${request.headers.host || "127.0.0.1"}`);
      if (request.method !== "GET" && request.method !== "HEAD") {
        response.writeHead(405, { allow: "GET, HEAD" });
        response.end();
        return;
      }
      if (url.pathname === "/health") {
        const challenge = String(request.headers["x-codex-doudizhu-challenge"] || "");
        const body = JSON.stringify({ status: "ok", product: "codex-doudizhu", proof: proofFor(secret, challenge) });
        response.writeHead(200, {
          "cache-control": "no-store",
          "content-type": "application/json; charset=utf-8",
          "x-codex-doudizhu-proof": proofFor(secret, challenge),
        });
        response.end(body);
        return;
      }
      if (url.pathname === prefix || url.pathname.startsWith(`${prefix}/`)) {
        const relative = url.pathname.slice(prefix.length) || "/";
        const filename = safePath(root, relative);
        if (!filename) {
          response.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
          response.end("Invalid path");
          return;
        }
        await sendStatic(request, response, filename);
        return;
      }
      response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      response.end("Not found");
    } catch (error) {
      response.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
      response.end(String(error?.message || error));
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });
  const address = server.address();
  const actualPort = typeof address === "object" && address ? address.port : port;
  return {
    server,
    port: actualPort,
    token,
    secret,
    gameUrl: `http://${host}:${actualPort}${prefix}/`,
    healthUrl: `http://${host}:${actualPort}/health`,
    async close() {
      await new Promise((resolve) => server.close(() => resolve()));
    },
  };
}
