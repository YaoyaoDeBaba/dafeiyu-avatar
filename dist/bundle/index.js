// src/index.ts
import path3 from "node:path";

// src/host/routes.ts
import fs2 from "node:fs";
import path2 from "node:path";

// src/host/http.ts
var LOOPBACK_HOSTS = /* @__PURE__ */ new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
var HOST_ORIGIN_SCHEMES = /* @__PURE__ */ new Set(["dsh-app:"]);
function hostnameOf(host) {
  const trimmed = host.trim().toLowerCase();
  if (trimmed.startsWith("[")) {
    const end = trimmed.indexOf("]");
    if (end === -1) return trimmed;
    const rest = trimmed.slice(end + 1);
    if (rest !== "" && !/^:\d+$/.test(rest)) return trimmed;
    return trimmed.slice(0, end + 1);
  }
  const colon = trimmed.lastIndexOf(":");
  if (colon !== -1 && !trimmed.slice(0, colon).includes(":") && /^\d+$/.test(trimmed.slice(colon + 1))) {
    return trimmed.slice(0, colon);
  }
  return trimmed;
}
function hostIsLoopback(host) {
  if (host === void 0 || host.trim() === "") return false;
  return LOOPBACK_HOSTS.has(hostnameOf(host));
}
function originLooksLikeTheHostItself(origin) {
  try {
    const url = new URL(origin);
    if (HOST_ORIGIN_SCHEMES.has(url.protocol)) return true;
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;
    return LOOPBACK_HOSTS.has(url.hostname);
  } catch {
    return false;
  }
}
function originIsLoopbackOrAbsent(origin) {
  if (origin === void 0 || origin.trim() === "") return true;
  return originLooksLikeTheHostItself(origin);
}
function applyCors(request, response) {
  const origin = request?.headers?.origin;
  if (origin === void 0 || origin.trim() === "" || !originLooksLikeTheHostItself(origin)) return;
  if (typeof response.setHeader !== "function") return;
  try {
    response.setHeader("Access-Control-Allow-Origin", origin);
    response.setHeader("Vary", "Origin");
    response.setHeader("Access-Control-Allow-Methods", "GET, POST, HEAD, OPTIONS");
    response.setHeader("Access-Control-Allow-Headers", "content-type, x-drc-pair");
    response.setHeader("Access-Control-Max-Age", "600");
  } catch {
  }
}
function preflight(request, response) {
  if (request.method !== "OPTIONS") return false;
  applyCors(request, response);
  response.writeHead(204, { "Access-Control-Max-Age": "600", "Content-Length": "0" });
  response.end();
  return true;
}

// src/host/manifest.ts
import fs from "node:fs";
import path from "node:path";
function avatarDir(dshHome) {
  return path.join(dshHome, "storages", "dsh-remote-dafeiyu", "avatar");
}
function sanitizeAvatarState(row) {
  if (!row || typeof row !== "object") return void 0;
  const value = row;
  const num = (v) => typeof v === "number" && Number.isFinite(v) ? Math.round(v) : 0;
  const unit = (v) => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1 ? v : void 0;
  const cols = num(value.cols);
  const rows = num(value.rows);
  const frames = num(value.frames);
  const file = typeof value.file === "string" ? value.file : "";
  if (typeof value.id !== "string" || cols <= 0 || rows <= 0 || frames <= 0 || file === "") return void 0;
  if (path.basename(file) !== file) return void 0;
  const anchorX = unit(value.anchorX);
  const anchorY = unit(value.anchorY);
  return {
    id: value.id,
    label: typeof value.label === "string" && value.label !== "" ? value.label : value.id,
    cols,
    rows,
    frames,
    // 与拆包前保持一致：格子尺寸缺省为 1（端上会按 cols/rows 再算），不在这里猜。
    cellWidth: num(value.cellWidth) || 1,
    cellHeight: num(value.cellHeight) || 1,
    file,
    ...anchorX !== void 0 ? { anchorX } : {},
    ...anchorY !== void 0 ? { anchorY } : {}
  };
}
function loadAvatarManifest(dir) {
  try {
    const raw = fs.readFileSync(path.join(dir, "manifest.json"), "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return void 0;
    const value = parsed;
    const rows = Array.isArray(value.states) ? value.states : [];
    const states = rows.map(sanitizeAvatarState).filter((row) => row !== void 0);
    if (states.length === 0) return void 0;
    const version = typeof value.version === "number" && Number.isFinite(value.version) ? value.version : 1;
    return { version, states };
  } catch {
    return void 0;
  }
}

// src/host/routes.ts
var AVATAR_BASE = "/api/dsh-remote-dafeiyu/avatar";
var AVATAR_MANIFEST_ROUTE = `${AVATAR_BASE}/manifest`;
var AVATAR_SHEET_ROUTE = `${AVATAR_BASE}/sheet`;
var AVATAR_STATE_ROUTE = `${AVATAR_BASE}/state`;
function json(response, status, body) {
  const payload = JSON.stringify(body);
  response.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) });
  response.end(payload);
}
function rejected(request) {
  if (!hostIsLoopback(request.headers.host)) return "host-not-loopback";
  if (!originIsLoopbackOrAbsent(request.headers.origin)) return "origin-not-trusted";
  return void 0;
}
function readonly(request) {
  return request.method === "GET" || request.method === "HEAD";
}
function avatarManifestHandler(dir) {
  return (request, response) => {
    applyCors(request, response);
    if (preflight(request, response)) return;
    const denied = rejected(request);
    if (denied) return json(response, 403, { ok: false, error: denied });
    if (!readonly(request)) return json(response, 405, { ok: false, error: "\u53EA\u652F\u6301 GET" });
    const manifest = loadAvatarManifest(dir);
    response.setHeader("Cache-Control", "no-store");
    if (manifest === void 0) return json(response, 200, { ok: true, manifest: null, message: "\u865A\u62DF\u5F62\u8C61\u7D20\u6750\u672A\u5B89\u88C5" });
    json(response, 200, { ok: true, manifest });
  };
}
function avatarSheetHandler(dir) {
  return (request, response) => {
    applyCors(request, response);
    if (preflight(request, response)) return;
    const denied = rejected(request);
    if (denied) return json(response, 403, { ok: false, error: denied });
    if (!readonly(request)) return json(response, 405, { ok: false, error: "\u53EA\u652F\u6301 GET" });
    const url = new URL(request.url ?? "/", "http://localhost");
    const id = (url.searchParams.get("id") ?? "").trim();
    if (id === "") return json(response, 400, { ok: false, error: "\u7F3A\u5C11 id" });
    const manifest = loadAvatarManifest(dir);
    const state = manifest?.states.find((row) => row.id === id);
    if (state === void 0) return json(response, 404, { ok: false, error: "\u6CA1\u6709\u8FD9\u4E2A\u52A8\u4F5C" });
    const file = path2.resolve(dir, state.file);
    if (!file.startsWith(path2.resolve(dir) + path2.sep)) return json(response, 403, { ok: false, error: "path-escape" });
    let data;
    try {
      data = fs2.readFileSync(file);
    } catch {
      return json(response, 404, { ok: false, error: "\u7D20\u6750\u6587\u4EF6\u4E0D\u5B58\u5728" });
    }
    response.writeHead(200, {
      "Content-Type": "image/webp",
      "Content-Length": data.byteLength,
      "Cache-Control": "public, max-age=86400, immutable"
    });
    if (request.method === "HEAD") response.end();
    else response.end(data);
  };
}
function avatarStateHandler(getStatus) {
  return (request, response) => {
    applyCors(request, response);
    if (preflight(request, response)) return;
    const denied = rejected(request);
    if (denied) return json(response, 403, { ok: false, error: denied });
    if (!readonly(request)) return json(response, 405, { ok: false, error: "\u53EA\u652F\u6301 GET" });
    const url = new URL(request.url ?? "/", "http://localhost");
    const sessionId = (url.searchParams.get("sessionId") ?? "").trim();
    if (sessionId === "") return json(response, 400, { ok: false, error: "\u7F3A\u5C11 sessionId" });
    let status;
    try {
      status = getStatus(sessionId);
    } catch {
      status = void 0;
    }
    json(response, 200, { ok: true, status: status === "running" ? "running" : "idle" });
  };
}

// src/host/start.ts
function startAvatar(ctx, deps) {
  const probe = {};
  const dir = avatarDir(deps.dshHome);
  const disposers = [];
  let unregister;
  let web;
  let started = false;
  let stopped = false;
  const tryStart = () => {
    if (started || stopped || web === void 0) return;
    started = true;
    try {
      disposers.push(web.register({ kind: "exact", path: AVATAR_MANIFEST_ROUTE, handler: avatarManifestHandler(dir) }));
      disposers.push(web.register({ kind: "exact", path: AVATAR_SHEET_ROUTE, handler: avatarSheetHandler(dir) }));
      disposers.push(
        web.register({
          kind: "exact",
          path: AVATAR_STATE_ROUTE,
          handler: avatarStateHandler((sessionId) => {
            try {
              const agents = ctx.get?.("agents", true);
              const agent = agents?.get?.(sessionId);
              return typeof agent?.status === "string" ? agent.status : void 0;
            } catch {
              return void 0;
            }
          })
        })
      );
      unregister = () => {
        for (const dispose of disposers.splice(0)) dispose();
      };
      probe.routes = "registered";
    } catch (error) {
      probe.routes = `register threw: ${String(error?.message ?? error).slice(0, 80)}`;
      started = false;
      if (disposers.length > 0) {
        const registered = disposers.splice(0);
        unregister = () => {
          for (const dispose of registered) dispose();
        };
      }
    }
  };
  const accept = (value, via) => {
    if (!value || typeof value !== "object" || typeof value.register !== "function") return false;
    web = value;
    probe.webServer = via;
    tryStart();
    return true;
  };
  try {
    const found = ctx.get?.("webServer", true);
    if (found) accept(found, "via get");
    else probe.webServer = "none";
  } catch (error) {
    probe.webServer = `get threw: ${String(error?.message ?? error).slice(0, 80)}`;
  }
  try {
    ctx.inject?.(["webServer"], ((scoped) => {
      const asContext = scoped;
      let candidate;
      try {
        candidate = asContext?.get?.("webServer", true);
      } catch {
        candidate = void 0;
      }
      if (!accept(candidate, "via inject")) probe.webServer = `${probe.webServer ?? "none"} (inject fired, empty)`;
    }));
  } catch (error) {
    probe["injectThrew:webServer"] = String(error?.message ?? error).slice(0, 120);
  }
  return {
    probe,
    stop() {
      if (stopped) return;
      stopped = true;
      try {
        unregister?.();
      } catch {
      }
    }
  };
}

// src/index.ts
function resolveDshHome(env = process.env) {
  const explicit = (env.DSH_HOME ?? "").trim();
  if (explicit !== "") return explicit;
  const home = (env.USERPROFILE ?? env.HOME ?? "").trim();
  return home === "" ? path3.join(".") : path3.join(home, ".dsh");
}
function apply(ctx) {
  const log = (message, extra) => {
    try {
      console.log(`[avatar] ${message}`, extra ?? "");
    } catch {
    }
  };
  let handle;
  try {
    handle = startAvatar(ctx, { dshHome: resolveDshHome(process.env), log });
  } catch (error) {
    handle = void 0;
    log("\u5F62\u8C61\u7D20\u6750\u8DEF\u7531\u8D77\u4E0D\u6765\uFF08\u4E0D\u5F71\u54CD\u5176\u5B83\u529F\u80FD\uFF09", {
      message: String(error?.message ?? error).slice(0, 200)
    });
  }
  const stop = () => {
    try {
      handle?.stop();
    } catch {
    }
  };
  try {
    if (typeof ctx.effect === "function") {
      ctx.effect(() => stop);
    } else if (typeof ctx.on === "function") {
      ctx.on("dispose", stop);
    }
  } catch {
  }
}
export {
  apply,
  resolveDshHome
};
