import http from "http";
import net from "net";
import fs from "fs";
import path from "path";
import { URL } from "url";
import chalk from "chalk";
import { Telegraf } from "telegraf";
import "dotenv/config";

const debug = process.argv.includes("--debug");

// ─── Railway-injected variables ───────────────────────────────────────────────
const RAILWAY_PUBLIC_DOMAIN    = process.env.RAILWAY_PUBLIC_DOMAIN    || "";
const RAILWAY_TCP_PROXY_DOMAIN = process.env.RAILWAY_TCP_PROXY_DOMAIN || "";
const RAILWAY_TCP_PROXY_PORT   = process.env.RAILWAY_TCP_PROXY_PORT   || "";
const RAILWAY_SERVICE_NAME     = process.env.RAILWAY_SERVICE_NAME     || "proxy";
const RAILWAY_ENVIRONMENT_NAME = process.env.RAILWAY_ENVIRONMENT_NAME || "production";

// ─── App config ───────────────────────────────────────────────────────────────
const HTTP_PORT  = parseInt(process.env.PORT       || "8080");
const SOCKS_PORT = parseInt(process.env.SOCKS_PORT || "1080");
const USER       = process.env.PROXY_USER;
const PASS       = process.env.PROXY_PASS;
const BOT_TOKEN  = process.env.BOT_TOKEN || "";
const ALLOWED_ID = process.env.TELEGRAM_ID || "";

if (!USER || !PASS) {
  console.error("PROXY_USER and PROXY_PASS must be set in environment variables");
  process.exit(1);
}

// ─── Public addressing ────────────────────────────────────────────────────────
// Proxy connection info uses TCP proxy domain (raw TCP), webhook uses HTTP domain.
// They can differ when both are configured on Railway.
const PROXY_PUBLIC_HOST = RAILWAY_TCP_PROXY_DOMAIN || RAILWAY_PUBLIC_DOMAIN || "localhost";
const PROXY_PUBLIC_PORT = RAILWAY_TCP_PROXY_PORT   || HTTP_PORT;

// Webhook path — derived once so it's consistent everywhere
const BOT_WEBHOOK_PATH = BOT_TOKEN ? `/bot${BOT_TOKEN}` : "";

let reqCount = 0;
let botInstance = null; // kept for graceful shutdown

// ─── Persistent log volume ─────────────────────────────────────────────────────
// Railway injects RAILWAY_VOLUME_MOUNT_PATH when a volume is attached.
// Log files persist across restarts so you can debug later.
const LOG_DIR = process.env.RAILWAY_VOLUME_MOUNT_PATH || path.resolve("./logs");

function ensureLogDir() {
  try { fs.mkdirSync(LOG_DIR, { recursive: true }); } catch {}
}
ensureLogDir();

function logToFile(entry) {
  const filename = `${entry.timestamp.slice(0, 10)}.jsonl`;
  const filepath = path.join(LOG_DIR, filename);
  try {
    fs.appendFileSync(filepath, JSON.stringify(entry) + "\n");
  } catch (err) {
    log.debug(`Failed to write log file: ${err.message}`);
  }
}

// ─── Logger ───────────────────────────────────────────────────────────────────
const log = {
  info:    (msg) => console.log(chalk.blue("INFO   "), chalk.white(msg)),
  success: (msg) => console.log(chalk.green("SUCCESS"), chalk.white(msg)),
  error:   (msg) => console.log(chalk.red("ERROR  "),  chalk.white(msg)),
  warning: (msg) => console.log(chalk.yellow("WARNING"),chalk.white(msg)),
  debug:   (msg) => { if (debug) console.log(chalk.gray("DEBUG  "), chalk.gray(msg)); },
};

function ts() {
  return new Date().toISOString().replace("T", " ").slice(0, 23);
}

function divider(char = "─", len = 60) {
  return chalk.gray(char.repeat(len));
}

// ─── Proxy auth ───────────────────────────────────────────────────────────────
function checkAuth(req) {
  const header = req.headers["proxy-authorization"] || "";
  if (!header.startsWith("Basic ")) return false;
  const decoded = Buffer.from(header.slice(6), "base64").toString();
  const [u, p] = decoded.split(":");
  return u === USER && p === PASS;
}

function sendAuthRequired(res) {
  res.writeHead(407, {
    "Proxy-Authenticate": 'Basic realm="proxy"',
    "Content-Type": "text/plain",
  });
  res.end("Proxy authentication required");
}

// ─── Request/response formatting ──────────────────────────────────────────────
function formatHeaders(headers) {
  return Object.entries(headers)
    .map(([k, v]) =>
      chalk.gray("  ") + chalk.cyan(k) + chalk.gray(": ") + chalk.white(v))
    .join("\n");
}

function formatBody(body, contentType = "") {
  if (!body || body.length === 0) return chalk.gray("  (empty)");
  const text = body.toString("utf8");
  if (contentType.includes("application/json")) {
    try {
      return JSON.stringify(JSON.parse(text), null, 2)
        .split("\n").map((l) => "  " + chalk.white(l)).join("\n");
    } catch {}
  }
  if (contentType.includes("text/") || contentType.includes("application/x-www-form-urlencoded")) {
    return "  " + chalk.white(
      text.slice(0, 2000) + (text.length > 2000 ? "\n  ...(truncated)" : ""));
  }
  return chalk.gray(`  (binary, ${body.length} bytes)`);
}

// ─── Request/response logging ─────────────────────────────────────────────────
function logRequest(id, method, url, headers, body) {
  console.log("\n" + divider());
  console.log(chalk.bold.white(`#${id}`) + " " + chalk.green(method) + " " + chalk.yellow(url));
  console.log(chalk.gray(ts()));
  console.log(divider("·"));
  console.log(chalk.bold.white("REQUEST HEADERS"));
  console.log(formatHeaders(headers));
  if (body && body.length > 0) {
    console.log(chalk.bold.white("REQUEST BODY"));
    console.log(formatBody(body, headers["content-type"] || ""));
  }
}

function logResponse(id, statusCode, headers, body) {
  console.log(divider("·"));
  const color = statusCode < 300 ? chalk.green : statusCode < 400 ? chalk.yellow : chalk.red;
  console.log(chalk.bold.white("RESPONSE") + " " + color(statusCode));
  console.log(chalk.bold.white("RESPONSE HEADERS"));
  console.log(formatHeaders(headers));
  if (body && body.length > 0) {
    console.log(chalk.bold.white("RESPONSE BODY"));
    console.log(formatBody(body, headers["content-type"] || ""));
  }
  console.log(divider());
}

function logTunnel(id, host, port) {
  console.log("\n" + divider("·"));
  console.log(chalk.bold.white(`#${id}`) + " " + chalk.magenta("HTTPS TUNNEL") + " " + chalk.yellow(`${host}:${port}`));
  console.log(chalk.gray(ts()) + chalk.gray(" (encrypted, content not visible)"));
  console.log(divider("·"));
}

function logSocks(id, host, port) {
  console.log("\n" + divider("·"));
  console.log(chalk.bold.white(`#${id}`) + " " + chalk.blue("SOCKS5") + " " + chalk.yellow(`${host}:${port}`));
  console.log(chalk.gray(ts()));
  console.log(divider("·"));
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function collectBody(stream) {
  return new Promise((resolve) => {
    const chunks = [];
    stream.on("data",  (c) => chunks.push(c));
    stream.on("end",   () => resolve(Buffer.concat(chunks)));
    stream.on("error", () => resolve(Buffer.alloc(0)));
  });
}

function pipe(a, b) {
  a.pipe(b);
  b.pipe(a);
  a.on("error", () => b.destroy());
  b.on("error", () => a.destroy());
}

// ─── Proxy handler ────────────────────────────────────────────────────────────
async function handleProxy(req, res) {
  if (!checkAuth(req)) {
    log.warning(`HTTP auth failed from ${req.socket.remoteAddress}`);
    return sendAuthRequired(res);
  }

  const id = ++reqCount;
  let target;

  try {
    target = new URL(req.url);
  } catch {
    res.writeHead(400);
    res.end("Bad Request");
    return;
  }

  const reqBody = await collectBody(req);
  const timestamp = ts();
  logRequest(id, req.method, req.url, req.headers, reqBody);

  const entry = {
    type: "http",
    id,
    timestamp,
    method: req.method,
    url: req.url,
    client: req.socket.remoteAddress || "",
    reqHeaders: { ...req.headers },
    reqBody: reqBody.length > 0 ? reqBody.toString("utf8").slice(0, 50000) : null,
  };
  delete entry.reqHeaders["proxy-authorization"];

  const opts = {
    hostname: target.hostname,
    port: target.port || 80,
    path: target.pathname + target.search,
    method: req.method,
    headers: { ...req.headers, host: target.host },
  };
  delete opts.headers["proxy-authorization"];
  delete opts.headers["proxy-connection"];

  const proxyReq = http.request(opts, async (proxyRes) => {
    const resBody = await collectBody(proxyRes);
    logResponse(id, proxyRes.statusCode, proxyRes.headers, resBody);
    entry.status = proxyRes.statusCode;
    entry.resHeaders = proxyRes.headers;
    entry.resBody = resBody.length > 0 ? resBody.toString("utf8").slice(0, 50000) : null;
    entry.duration = Math.round((Date.now() - new Date(timestamp).getTime()));
    logToFile(entry);
    res.writeHead(proxyRes.statusCode, proxyRes.headers);
    res.end(resBody);
  });

  proxyReq.on("error", (err) => {
    log.error(`HTTP #${id} failed: ${err.message}`);
    entry.status = 502;
    entry.error = err.message || err.code || "Unknown";
    entry.duration = Math.round((Date.now() - new Date(timestamp).getTime()));
    logToFile(entry);
    res.writeHead(502);
    res.end("Bad Gateway");
  });

  if (reqBody.length > 0) proxyReq.write(reqBody);
  proxyReq.end();
}

// ─── HTTP server — single handler routes by URL ───────────────────────────────
const httpServer = http.createServer(async (req, res) => {
  // ── Route: Telegram bot webhook (no auth needed) ────────────────────────
  if (BOT_WEBHOOK_PATH && req.method === "POST" && req.url === BOT_WEBHOOK_PATH) {
    // Forward to the Telegraf webhook middleware (set up in startBot)
    // If no middleware registered yet, skip
    if (typeof httpServer.webhookHandler === "function") {
      return httpServer.webhookHandler(req, res);
    }
    // Bot not ready — let it fall through to proxy handler which will reject
  }

  // ── Route: HTTP proxy (requires auth) ───────────────────────────────────
  return handleProxy(req, res);
});

// ─── HTTPS CONNECT tunnel ─────────────────────────────────────────────────────
httpServer.on("connect", (req, clientSocket, head) => {
  if (!checkAuth(req)) {
    log.warning(`CONNECT auth failed from ${clientSocket.remoteAddress}`);
    clientSocket.write(
      'HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="proxy"\r\n\r\n');
    clientSocket.destroy();
    return;
  }

  const id = ++reqCount;
  const [host, portStr] = req.url.split(":");
  const port = parseInt(portStr) || 443;
  const tunnelTs = ts();
  logTunnel(id, host, port);

  const tunnelEntry = {
    type: "tunnel",
    id,
    timestamp: tunnelTs,
    host,
    port,
    client: clientSocket.remoteAddress || "",
  };

  const remote = net.connect(port, host, () => {
    clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    if (head && head.length) remote.write(head);
    tunnelEntry.status = "connected";
    tunnelEntry.duration = Math.round((Date.now() - new Date(tunnelTs).getTime()));
    logToFile(tunnelEntry);
    pipe(clientSocket, remote);
  });

  remote.on("error", (err) => {
    log.error(`TUNNEL #${id} error: ${err.message}`);
    tunnelEntry.status = "error";
    tunnelEntry.error = err.message || err.code || "Unknown";
    tunnelEntry.duration = Math.round((Date.now() - new Date(tunnelTs).getTime()));
    logToFile(tunnelEntry);
    clientSocket.destroy();
  });
});

// ─── SOCKS5 ───────────────────────────────────────────────────────────────────
const SOCKS_VER    = 0x05;
const CMD_CONNECT  = 0x01;
const ATYP_IPV4    = 0x01;
const ATYP_DOMAIN  = 0x03;
const ATYP_IPV6    = 0x04;

const socksServer = net.createServer((client) => {
  client.once("data", (data) => {
    if (data[0] !== SOCKS_VER) { client.destroy(); return; }
    client.write(Buffer.from([SOCKS_VER, 0x02]));

    client.once("data", (auth) => {
      const ulen = auth[1];
      const u = auth.slice(2, 2 + ulen).toString();
      const plen = auth[2 + ulen];
      const p = auth.slice(3 + ulen, 3 + ulen + plen).toString();

      if (u !== USER || p !== PASS) {
        log.warning(`SOCKS5 auth failed for user: ${u}`);
        client.write(Buffer.from([0x01, 0xff]));
        client.destroy();
        return;
      }

      client.write(Buffer.from([0x01, 0x00]));

      client.once("data", (req) => {
        if (req[0] !== SOCKS_VER || req[1] !== CMD_CONNECT) {
          client.destroy();
          return;
        }

        const atyp = req[3];
        let host, port, headerLen;

        if (atyp === ATYP_IPV4) {
          host = `${req[4]}.${req[5]}.${req[6]}.${req[7]}`;
          port = req.readUInt16BE(8);
          headerLen = 10;
        } else if (atyp === ATYP_DOMAIN) {
          const dlen = req[4];
          host = req.slice(5, 5 + dlen).toString();
          port = req.readUInt16BE(5 + dlen);
          headerLen = 6 + dlen;
        } else if (atyp === ATYP_IPV6) {
          host = req.slice(4, 20).toString("hex").match(/.{1,4}/g).join(":");
          port = req.readUInt16BE(20);
          headerLen = 22;
        } else {
          client.destroy();
          return;
        }

        const id = ++reqCount;
        const socksTs = ts();
        logSocks(id, host, port);

        const socksEntry = {
          type: "socks5",
          id,
          timestamp: socksTs,
          host,
          port,
          atyp: ["?", "IPv4", "?", "Domain", "?", "IPv6"][atyp] || "?",
        };

        const remote = net.connect(port, host, () => {
          const resp = Buffer.alloc(10);
          resp[0] = SOCKS_VER;
          resp[1] = 0x00;
          resp[2] = 0x00;
          resp[3] = ATYP_IPV4;
          client.write(resp);

          const leftover = req.slice(headerLen);
          if (leftover.length > 0) remote.write(leftover);

          socksEntry.status = "connected";
          socksEntry.duration = Math.round((Date.now() - new Date(socksTs).getTime()));
          logToFile(socksEntry);

          pipe(client, remote);
          log.debug(`SOCKS5 #${id} connected to ${host}:${port}`);
        });

        remote.on("error", (err) => {
          log.error(`SOCKS5 #${id} error: ${err.message}`);
          socksEntry.status = "error";
          socksEntry.error = err.message || err.code || "Unknown";
          socksEntry.duration = Math.round((Date.now() - new Date(socksTs).getTime()));
          logToFile(socksEntry);
          client.write(Buffer.from([SOCKS_VER, 0x04, 0x00, ATYP_IPV4, 0, 0, 0, 0, 0, 0]));
          client.destroy();
        });
      });
    });
  });

  client.on("error", (err) => log.debug(`SOCKS5 client error: ${err.message}`));
});

// ─── Telegram bot ─────────────────────────────────────────────────────────────
function isAllowed(ctx) {
  if (!ALLOWED_ID) return true;
  return String(ctx.from.id) === String(ALLOWED_ID);
}

function mainMenu() {
  const rows = [
    [{ text: "Credentials",     callback_data: "creds" }],
    [{ text: "Connection Info", callback_data: "info"  }],
    [{ text: "Traffic Stats",   callback_data: "stats" }],
  ];
  if (LOG_DIR) {
    rows.push([{ text: "Log Storage", callback_data: "logs" }]);
  }
  return { reply_markup: { inline_keyboard: rows } };
}

function backButton() {
  return { reply_markup: { inline_keyboard: [[{ text: "Back", callback_data: "back" }]] } };
}

async function startBot() {
  if (!BOT_TOKEN) {
    log.warning("BOT_TOKEN not set — Telegram bot disabled");
    return;
  }

  const bot = new Telegraf(BOT_TOKEN);
  botInstance = bot;

  // ── Commands ────────────────────────────────────────────────────────────
  bot.start((ctx) => {
    if (!isAllowed(ctx)) return ctx.reply("Unauthorized.");
    ctx.reply(
      `Proxy Manager\nService: ${RAILWAY_SERVICE_NAME} (${RAILWAY_ENVIRONMENT_NAME})`,
      mainMenu());
  });

  bot.action("creds", (ctx) => {
    if (!isAllowed(ctx)) return ctx.answerCbQuery("Unauthorized.");
    ctx.answerCbQuery();
    ctx.editMessageText(
      `Credentials\n\n` +
      `User: ${USER}\nPass: ${PASS}\n\n` +
      `HTTP\n${USER}:${PASS}@${PROXY_PUBLIC_HOST}:${PROXY_PUBLIC_PORT}\n\n` +
      `SOCKS5\n${USER}:${PASS}@${PROXY_PUBLIC_HOST}:${SOCKS_PORT}`,
      backButton());
  });

  bot.action("info", (ctx) => {
    if (!isAllowed(ctx)) return ctx.answerCbQuery("Unauthorized.");
    ctx.answerCbQuery();
    ctx.editMessageText(
      `Connection Info\n\n` +
      `Host: ${PROXY_PUBLIC_HOST}\n` +
      `HTTP Port: ${PROXY_PUBLIC_PORT}\n` +
      `SOCKS5 Port: ${SOCKS_PORT}\n\n` +
      `HTTP format\nhttp://${USER}:${PASS}@${PROXY_PUBLIC_HOST}:${PROXY_PUBLIC_PORT}\n\n` +
      `SOCKS5 format\nsocks5://${USER}:${PASS}@${PROXY_PUBLIC_HOST}:${SOCKS_PORT}\n\n` +
      `Service: ${RAILWAY_SERVICE_NAME}\nEnv: ${RAILWAY_ENVIRONMENT_NAME}`,
      backButton());
  });

  bot.action("stats", (ctx) => {
    if (!isAllowed(ctx)) return ctx.answerCbQuery("Unauthorized.");
    ctx.answerCbQuery();
    ctx.editMessageText(
      `Traffic Stats\n\n` +
      `Total requests: ${reqCount}\n` +
      `Uptime: ${Math.floor(process.uptime() / 60)} minutes`,
      backButton());
  });

  bot.action("logs", (ctx) => {
    if (!isAllowed(ctx)) return ctx.answerCbQuery("Unauthorized.");
    ctx.answerCbQuery();
    let totalSize = 0, fileCount = 0;
    try {
      const files = fs.readdirSync(LOG_DIR);
      for (const f of files) {
        if (f.endsWith(".jsonl")) {
          fileCount++;
          totalSize += fs.statSync(path.join(LOG_DIR, f)).size;
        }
      }
    } catch {}
    const sizeMb = (totalSize / 1024 / 1024).toFixed(2);
    ctx.editMessageText(
      `Log Storage\n\n` +
      `Path: \`${LOG_DIR}\`\n` +
      `Log files: ${fileCount}\n` +
      `Total size: ${sizeMb} MB\n\n` +
      `Logs are written as JSONL files (one JSON object per line).\n` +
      `They persist across restarts via Railway Volume.`,
      { parse_mode: "Markdown", ...backButton() });
  });

  bot.action("back", (ctx) => {
    if (!isAllowed(ctx)) return ctx.answerCbQuery();
    ctx.answerCbQuery();
    ctx.editMessageText(
      `Proxy Manager\nService: ${RAILWAY_SERVICE_NAME} (${RAILWAY_ENVIRONMENT_NAME})`,
      mainMenu());
  });

  // ── Launch ──────────────────────────────────────────────────────────────
  if (!RAILWAY_PUBLIC_DOMAIN) {
    // Polling mode — no webhook, no conflict
    log.warning("RAILWAY_PUBLIC_DOMAIN not set — using polling instead of webhook");
    await bot.launch();
    log.success("Telegram bot started (polling)");
    return;
  }

  // ── Webhook mode using Telegraf's createWebhook (per docs) ──────────────
  // createWebhook returns an Express-style middleware: (req, res, next?) => Promise<void>
  // It handles body parsing, update dispatch, and response writing.
  log.info(`Setting webhook to https://${RAILWAY_PUBLIC_DOMAIN}${BOT_WEBHOOK_PATH}`);

  httpServer.webhookHandler = await bot.createWebhook({
    domain: RAILWAY_PUBLIC_DOMAIN,
    path:   BOT_WEBHOOK_PATH,
  });

  log.success(`Webhook handler registered at ${BOT_WEBHOOK_PATH}`);
}

// ─── Start ────────────────────────────────────────────────────────────────────
httpServer.listen(HTTP_PORT, "0.0.0.0", () => {
  log.success(`HTTP proxy on port ${HTTP_PORT}`);
});

socksServer.listen(SOCKS_PORT, "0.0.0.0", () => {
  log.success(`SOCKS5 proxy on port ${SOCKS_PORT}`);
});

startBot().catch((err) => {
  log.error(`Bot failed to start: ${err?.message ?? err}`);
});

log.info(`Service: ${RAILWAY_SERVICE_NAME} — Env: ${RAILWAY_ENVIRONMENT_NAME}`);
log.info(`Public address: ${PROXY_PUBLIC_HOST}:${PROXY_PUBLIC_PORT}`);

// ─── Graceful shutdown ────────────────────────────────────────────────────────
process.once("SIGINT", async () => {
  log.info("Shutting down (SIGINT)…");
  if (botInstance) await botInstance.stop("SIGINT");
  process.exit(0);
});

process.once("SIGTERM", async () => {
  log.info("Shutting down (SIGTERM)…");
  if (botInstance) await botInstance.stop("SIGTERM");
  process.exit(0);
});
