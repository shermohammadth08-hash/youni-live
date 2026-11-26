// Youni Live — PUBLIC version (Railway free tier) — server + real-time live chat (socket.io) + real Go Live video (WebRTC signalling) + PWA (installable app)
// PUBLIC mode: agar PORT environment variable set hai (Railway khud deta hai),
// to server sirf usi ek HTTP port par chalta hai — platform khud HTTPS deta hai,
// is liye certificate ki zaroorat nahi. PORT set nahi hai to local mode:
// HTTP port 3000 + HTTPS port 3443 (self-signed cert), bilkul v6 jaisa.
// ACCOUNTS BACHANA (v7): users.json ab DATA_DIR mein save hota hai.
// Railway par DATA_DIR=/data set karein aur /data par ek Volume lagayein —
// phir restart ya redeploy par bhi accounts nahi mitenge. DATA_DIR set nahi hai
// to users.json hamesha ki tarah app folder mein save hota hai (local mode).
// REPORT / BLOCK (v8): blocks.json { blocker: [blocked, ...] } aur reports.json
// [ { by, target, reason, text, room, time } ] bhi DATA_DIR mein save hote hain.
// Server chat sirf un viewers ko bhejta hai jinhon ne sender ko block nahi kiya,
// blocked host ke live room Home feed mein chhupte hain, blocked user live room
// mein join nahi kar sakta, aur host apne room ke watcher ko block karke
// nikaal sakta hai.
// - manifest.webmanifest, sw.js aur icons serve hote hain (PWA install ke liye); sw.js par no-cache headers.
// - index.html serve karta hai — HTTP port 3000 AND HTTPS port 3443 (self-signed cert)
// - HTTPS is liye: phone ka camera sirf secure connection (HTTPS / localhost) par chalta hai.
//   Phone https://<LAN-IP>:3443 se host kar sakta hai; laptop http://localhost:3000 se.
// - POST /api/register aur POST /api/login — users users.json mein save hote hain,
//   password SHA-256 hash ki shakal mein, seedha (plaintext) kabhi nahi rakha jata.
// - users.json, cert.pem aur key.pem kabhi file ki tarah serve nahi hote.
const http = require("http");
const https = require("https");
const os = require("os");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const selfsigned = require("selfsigned");
const { Server } = require("socket.io");

const PORT = 3000;
const HTTPS_PORT = 3443;
// Public hosting (jaise Render) ek PORT environment variable deta hai.
// Us waqt sirf usi port par ek HTTP server chalta hai; platform khud HTTPS deta hai.
const HOST_PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : null;
// DATA_DIR: jahan users.json save hoga. Railway par Volume /data par lagayein
// aur variable DATA_DIR=/data set karein — accounts restart par bhi bachenge.
// Warna (local mode) users.json app folder mein hi rehta hai.
const DATA_DIR = process.env.DATA_DIR || __dirname;
const USERS_FILE = path.join(DATA_DIR, "users.json");
const CERT_FILE = path.join(__dirname, "cert.pem");
const KEY_FILE = path.join(__dirname, "key.pem");
// v8: Report/Block — blocks.json { blockerName: [blockedName, ...] },
// reports.json [ { by, target, reason, text, room, time } ].
// Dono files DATA_DIR mein rehti hain (Railway: /data volume) aur
// pehli dafa use hone par banti hain — users.json jaisa hi tareeqa.
const BLOCKS_FILE = path.join(DATA_DIR, "blocks.json");
const REPORTS_FILE = path.join(DATA_DIR, "reports.json");

function loadUsers() {
  try {
    return JSON.parse(fs.readFileSync(USERS_FILE, "utf8"));
  } catch (e) {
    return {};
  }
}

function saveUsers(users) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
    return true;
  } catch (e) {
    console.error("users.json save nahi hua:", e.message);
    return false;
  }
}

// v8: blocks + reports ki file handling — users.json wala hi pattern.
function loadBlocks() {
  try {
    const b = JSON.parse(fs.readFileSync(BLOCKS_FILE, "utf8"));
    return b && typeof b === "object" && !Array.isArray(b) ? b : {};
  } catch (e) {
    return {};
  }
}

function saveBlocks(blocks) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(BLOCKS_FILE, JSON.stringify(blocks, null, 2));
    return true;
  } catch (e) {
    console.error("blocks.json save nahi hua:", e.message);
    return false;
  }
}

function loadReports() {
  try {
    const r = JSON.parse(fs.readFileSync(REPORTS_FILE, "utf8"));
    return Array.isArray(r) ? r : [];
  } catch (e) {
    return [];
  }
}

function saveReports(reports) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(REPORTS_FILE, JSON.stringify(reports, null, 2));
    return true;
  } catch (e) {
    console.error("reports.json save nahi hua:", e.message);
    return false;
  }
}

// In-memory block cache — socket hot path ke liye (file har dafa nahi parhte).
// REST aur socket handlers is cache ko update karte hain aur file save karte hain.
let blocksCache = loadBlocks();

function cleanName(s) {
  return typeof s === "string" ? s.trim() : "";
}

// Naam ka muqabla hamesha case-insensitive (register/login jaisa).
function blocksListOf(name) {
  const key = Object.keys(blocksCache).find((k) => k.toLowerCase() === name.toLowerCase());
  return key ? blocksCache[key] : [];
}

function hasBlocked(blocker, target) {
  if (!blocker || !target) return false;
  return blocksListOf(blocker).some((n) => n.toLowerCase() === target.toLowerCase());
}

// Duplicate block no-op success hai. Save fail ho to cache wapas.
function addBlock(blocker, target) {
  const key = Object.keys(blocksCache).find((k) => k.toLowerCase() === blocker.toLowerCase());
  const list = key ? blocksCache[key] : [];
  if (list.some((n) => n.toLowerCase() === target.toLowerCase())) return true;
  const newList = list.concat([target]);
  if (key) blocksCache[key] = newList; else blocksCache[blocker] = newList;
  if (!saveBlocks(blocksCache)) {
    if (key) blocksCache[key] = list; else delete blocksCache[blocker];
    return false;
  }
  return true;
}

function removeBlock(blocker, target) {
  const key = Object.keys(blocksCache).find((k) => k.toLowerCase() === blocker.toLowerCase());
  if (!key) return true;
  const old = blocksCache[key];
  const list = old.filter((n) => n.toLowerCase() !== target.toLowerCase());
  if (!list.length) delete blocksCache[key]; else blocksCache[key] = list;
  if (!saveBlocks(blocksCache)) {
    blocksCache[key] = old;
    return false;
  }
  return true;
}

function hashPassword(password) {
  return crypto.createHash("sha256").update(password).digest("hex");
}

// LAN IP nikaalein (phone se connect karne ke liye)
function getLanIPs() {
  const ips = [];
  const ifaces = os.networkInterfaces();
  Object.keys(ifaces).forEach((name) => {
    ifaces[name].forEach((info) => {
      if (info.family === "IPv4" && !info.internal) ips.push(info.address);
    });
  });
  return ips;
}

// Self-signed certificate: pehli dafa banayein, phir reuse karein
function ensureCert() {
  try {
    if (fs.existsSync(CERT_FILE) && fs.existsSync(KEY_FILE)) {
      return { key: fs.readFileSync(KEY_FILE), cert: fs.readFileSync(CERT_FILE) };
    }
  } catch (e) {}
  const altNames = [
    { type: 2, value: "localhost" },
    { type: 7, ip: "127.0.0.1" }
  ];
  getLanIPs().forEach((ip) => altNames.push({ type: 7, ip: ip }));
  const pems = selfsigned.generate(
    [{ name: "commonName", value: "localhost" }],
    {
      keySize: 2048,
      days: 365,
      algorithm: "sha256",
      extensions: [{ name: "subjectAltName", altNames: altNames }]
    }
  );
  fs.writeFileSync(KEY_FILE, pems.private);
  fs.writeFileSync(CERT_FILE, pems.cert);
  return { key: pems.private, cert: pems.cert };
}

function sendJSON(res, status, obj) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(obj));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > 10000) {
        req.destroy();
        reject(new Error("Body too big"));
      }
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(data || "{}"));
      } catch (e) {
        reject(new Error("Invalid JSON"));
      }
    });
    req.on("error", reject);
  });
}

function handleRegister(data, res) {
  const name = typeof data.name === "string" ? data.name.trim() : "";
  const password = typeof data.password === "string" ? data.password : "";
  if (!name) return sendJSON(res, 400, { ok: false, error: "Naam likhein." });
  if (name.length > 30) return sendJSON(res, 400, { ok: false, error: "Naam 30 harf se zyada nahi." });
  if (password.length < 4) return sendJSON(res, 400, { ok: false, error: "Password kam se kam 4 harf ka ho." });
  const users = loadUsers();
  const taken = Object.keys(users).some((k) => k.toLowerCase() === name.toLowerCase());
  if (taken) return sendJSON(res, 400, { ok: false, error: "Ye naam pehle se hai — koi aur naam chunein ya Log in karein." });
  users[name] = { pass: hashPassword(password), created: new Date().toISOString() };
  if (!saveUsers(users)) {
    delete users[name];
    return sendJSON(res, 500, { ok: false, error: "Account save nahi hua — dobara koshish karein." });
  }
  sendJSON(res, 200, { ok: true, name: name });
}

function handleLogin(data, res) {
  const name = typeof data.name === "string" ? data.name.trim() : "";
  const password = typeof data.password === "string" ? data.password : "";
  if (!name || !password) return sendJSON(res, 400, { ok: false, error: "Naam aur password likhein." });
  const users = loadUsers();
  const key = Object.keys(users).find((k) => k.toLowerCase() === name.toLowerCase());
  if (!key) return sendJSON(res, 400, { ok: false, error: "Ye naam nahi mila — pehle Sign up karein." });
  if (users[key].pass !== hashPassword(password)) {
    return sendJSON(res, 400, { ok: false, error: "Password ghalat hai." });
  }
  sendJSON(res, 200, { ok: true, name: key });
}

// v8: Block / Report — register/login jaisi hi validation.
const REPORT_REASONS = ["spam", "abuse", "bad content", "fake", "other"];

function blockTargetError(name, target) {
  if (!name) return "Naam likhein.";
  if (name.length > 30) return "Naam 30 harf se zyada nahi.";
  if (!target) return "Kis ko block karna hai, naam likhein.";
  if (target.length > 30) return "Naam 30 harf se zyada nahi.";
  if (name.toLowerCase() === target.toLowerCase()) return "Khud ko block nahi kar sakte.";
  return null;
}

function handleBlock(data, res) {
  const name = cleanName(data.name);
  const target = cleanName(data.target);
  const err = blockTargetError(name, target);
  if (err) return sendJSON(res, 400, { ok: false, error: err });
  if (!addBlock(name, target)) return sendJSON(res, 500, { ok: false, error: "Block save nahi hua — dobara koshish karein." });
  sendJSON(res, 200, { ok: true, blocked: blocksListOf(name) });
}

function handleUnblock(data, res) {
  const name = cleanName(data.name);
  const target = cleanName(data.target);
  const err = blockTargetError(name, target);
  if (err) return sendJSON(res, 400, { ok: false, error: err });
  if (!removeBlock(name, target)) return sendJSON(res, 500, { ok: false, error: "Unblock save nahi hua — dobara koshish karein." });
  sendJSON(res, 200, { ok: true, blocked: blocksListOf(name) });
}

function handleGetBlocks(req, res) {
  const q = req.url.includes("?") ? req.url.split("?")[1] : "";
  const name = cleanName(new URLSearchParams(q).get("name") || "");
  if (!name) return sendJSON(res, 400, { ok: false, error: "Naam likhein." });
  sendJSON(res, 200, { ok: true, blocked: blocksListOf(name) });
}

function handleReport(data, res) {
  const name = cleanName(data.name);
  const target = cleanName(data.target);
  const reason = typeof data.reason === "string" ? data.reason.trim() : "";
  const text = typeof data.text === "string" ? data.text.trim() : "";
  const room = typeof data.room === "string" ? data.room.trim().slice(0, 60) : "";
  if (!name) return sendJSON(res, 400, { ok: false, error: "Naam likhein." });
  if (name.length > 30) return sendJSON(res, 400, { ok: false, error: "Naam 30 harf se zyada nahi." });
  if (!target) return sendJSON(res, 400, { ok: false, error: "Kis ko report karna hai, naam likhein." });
  if (target.length > 30) return sendJSON(res, 400, { ok: false, error: "Naam 30 harf se zyada nahi." });
  if (name.toLowerCase() === target.toLowerCase()) return sendJSON(res, 400, { ok: false, error: "Khud ko report nahi kar sakte." });
  if (!REPORT_REASONS.includes(reason)) return sendJSON(res, 400, { ok: false, error: "Report ki wajah chunein." });
  if (text.length > 200) return sendJSON(res, 400, { ok: false, error: "Report 200 harf se zyada nahi." });
  const reports = loadReports();
  reports.push({ by: name, target: target, reason: reason, text: text, room: room, time: new Date().toISOString() });
  if (reports.length > 500) reports.splice(0, reports.length - 500);
  if (!saveReports(reports)) return sendJSON(res, 500, { ok: false, error: "Report save nahi hua — dobara koshish karein." });
  sendJSON(res, 200, { ok: true });
}

// Reports screen ke liye — v1 mein koi bhi logged-in user dekh sakta hai.
function handleGetReports(req, res) {
  const reports = loadReports().slice().reverse().slice(0, 100);
  sendJSON(res, 200, { ok: true, reports: reports });
}

function handleRequest(req, res) {
  const url = req.url.split("?")[0];

  if (req.method === "POST" && (url === "/api/register" || url === "/api/login" || url === "/api/block" || url === "/api/unblock" || url === "/api/report")) {
    readBody(req).then((data) => {
      if (url === "/api/register") handleRegister(data, res);
      else if (url === "/api/login") handleLogin(data, res);
      else if (url === "/api/block") handleBlock(data, res);
      else if (url === "/api/unblock") handleUnblock(data, res);
      else handleReport(data, res);
    }).catch(() => sendJSON(res, 400, { ok: false, error: "Ghalat data bheja gaya." }));
    return;
  }

  // v8: blocked list aur reports padhna (GET).
  if (req.method === "GET" && url === "/api/blocks") { handleGetBlocks(req, res); return; }
  if (req.method === "GET" && url === "/api/reports") { handleGetReports(req, res); return; }

  if (req.method !== "GET") {
    res.writeHead(405);
    res.end("Method not allowed");
    return;
  }

  let file = url === "/" ? "/index.html" : url;
  const full = path.join(__dirname, file);
  const resolved = path.resolve(full);
  // Public version: sirf ye files serve hongi. users.json, blocks.json,
  // reports.json, cert.pem, key.pem, server.js aur package.json jaise files
  // kabhi file ki tarah serve nahi hongi, aur folder se bahar koi file nahi:
  const PUBLIC_FILES = new Set(["index.html", "manifest.webmanifest", "sw.js", "icon-180.png", "icon-192.png", "icon-512.png"]);
  if (!PUBLIC_FILES.has(path.basename(resolved)) || !resolved.startsWith(__dirname)) {
    res.writeHead(404);
    res.end("Not found");
    return;
  }
  fs.readFile(resolved, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }
    const type = resolved.endsWith(".html") ? "text/html"
      : resolved.endsWith(".webmanifest") ? "application/manifest+json"
      : resolved.endsWith(".png") ? "image/png"
      : resolved.endsWith(".js") ? "application/javascript"
      : resolved.endsWith(".css") ? "text/css"
      : "application/octet-stream";
    // sw.js par no-cache: taake nayi version phone tak foran pahunche.
    const headers = { "Content-Type": type };
    if (path.basename(resolved) === "sw.js") {
      headers["Cache-Control"] = "no-cache, no-store, must-revalidate";
    }
    res.writeHead(200, headers);
    res.end(data);
  });
}


/* ================= Real-time chat (socket.io) ================= */
// Har room ki aakhri 50 messages server ki memory mein rehti hain.
// Laptop aur phone — jo bhi usi room mein hain — ek doosre ke messages dekhte hain.
// HTTP aur HTTPS — dono par wohi socket.io, is liye laptop (http) aur phone (https)
// ek hi rooms, chat aur signalling mein hote hain.
const httpServer = http.createServer(handleRequest);
const io = new Server();
io.attach(httpServer);
// Local mode mein hi HTTPS server banta hai (self-signed cert ke saath).
// Public hosting par platform khud HTTPS deta hai, is liye wahan cert nahi banta.
let httpsServer = null;
if (!HOST_PORT) {
  const certs = ensureCert();
  httpsServer = https.createServer(certs, handleRequest);
  io.attach(httpsServer);
}
const roomHistory = {};
const MAX_HISTORY = 50;
const DEMO_ROOMS = new Set(["r1", "r2", "r3", "r4", "r5", "r6"]);

/* ================= Real live video — WebRTC signalling ================= */
// Video server par save nahi hoti — server sirf signalling messages aage bhejta hai.
// Camera sirf secure context (localhost / HTTPS) mein milti hai:
// HOST laptop se (http://localhost:3000) YA phone se (https://<LAN-IP>:3443) live ja sakta hai.
// Phone plain HTTP par sirf dekh sakta hai; dekhne ke liye camera ki zaroorat nahi hoti.
const liveRooms = {}; // roomId -> { hostId, title, host, cat, cover }
const socketRoom = {}; // socketId -> roomId (signalling validation ke liye)

function validRoomId(roomId){
  return typeof roomId === "string" && (DEMO_ROOMS.has(roomId) || roomId.startsWith("live-"));
}
function isHostOf(sockId, roomId){
  return !!liveRooms[roomId] && liveRooms[roomId].hostId === sockId;
}
function endLiveRoom(roomId){
  if (!liveRooms[roomId]) return;
  delete liveRooms[roomId];
  io.emit("live ended", { room: roomId });
}

/* ================= v8: Report/Block enforcement (server-side) ================= */
// Har socket ka username sock.data.userName mein rehta hai — client "identify"
// event se bhejta hai; demo rooms mein chat karne wale ka naam fallback hai.
// Live list / live started: wo room chhupayein jahan viewer ne host ko block
// kiya ho YA host ne viewer ko block kiya ho. Chat: har viewer ko alag se
// bhejein — jis ne sender ko block kiya hai use message nahi milta.
function roomHiddenFor(viewerName, hostName){
  if (!viewerName || !hostName) return false;
  return hasBlocked(viewerName, hostName) || hasBlocked(hostName, viewerName);
}

function liveListFor(viewerName){
  return Object.keys(liveRooms)
    .filter((rid) => !roomHiddenFor(viewerName, liveRooms[rid].host))
    .map((rid) => Object.assign({ room: rid }, liveRooms[rid]));
}

function emitChatToRoom(roomId, msg){
  for (const [, s] of io.sockets.sockets) {
    if (!s.rooms.has(roomId)) continue;
    const viewer = (s.data && s.data.userName) || "";
    if (viewer && hasBlocked(viewer, msg.name)) continue;
    s.emit("chat message", msg);
  }
}

function emitLiveStarted(info){
  for (const [, s] of io.sockets.sockets) {
    const viewer = (s.data && s.data.userName) || "";
    if (roomHiddenFor(viewer, info.host)) continue;
    s.emit("live started", info);
  }
}

io.on("connection", (sock) => {
  let joinedRoom = null;

  // Naye connect hone wale ko pehle se live rooms ki list (Home feed ke liye)
  sock.emit("live list", Object.keys(liveRooms).map((rid) => Object.assign({ room: rid }, liveRooms[rid])));

  // v8: client apna logged-in naam batata hai — is se block filtering hoti hai.
  // Identify aate hi filtered live list dobara bhejein (blocked hosts chhup jayein).
  sock.on("identify", (name) => {
    const n = cleanName(name);
    if (!n) return;
    sock.data.userName = n;
    sock.emit("live list", liveListFor(n));
  });

  sock.on("join room", (roomId) => {
    if (typeof roomId !== "string") return;
    if (!DEMO_ROOMS.has(roomId) && !roomId.startsWith("live-")) return;
    // v8: live room mein join nahi — agar host ne joiner ko block kiya ho
    // ya joiner ne host ko block kiya ho.
    const live = liveRooms[roomId];
    if (live) {
      const joiner = (sock.data && sock.data.userName) || "";
      if (joiner && roomHiddenFor(joiner, live.host)) {
        sock.emit("blocked", { room: roomId, message: "You can't join this live — you are blocked." });
        return;
      }
    }
    if (joinedRoom) sock.leave(joinedRoom);
    joinedRoom = roomId;
    sock.join(roomId);
    socketRoom[sock.id] = roomId;
    sock.emit("chat history", (roomHistory[roomId] || []).slice(-MAX_HISTORY));
    if (liveRooms[roomId]) sock.emit("live started", Object.assign({ room: roomId }, liveRooms[roomId]));
  });

  sock.on("leave room", (roomId) => {
    if (joinedRoom === roomId) {
      sock.leave(roomId);
      joinedRoom = null;
      delete socketRoom[sock.id];
      if (liveRooms[roomId] && liveRooms[roomId].hostId === sock.id) {
        endLiveRoom(roomId);
      } else if (liveRooms[roomId]) {
        io.to(liveRooms[roomId].hostId).emit("watcher left", { watcherId: sock.id, room: roomId });
      }
    }
  });

  sock.on("chat message", (data) => {
    if (!data || typeof data !== "object") return;
    const roomId = typeof data.room === "string" ? data.room : "";
    const name = typeof data.name === "string" ? data.name.trim().slice(0, 30) : "";
    const text = typeof data.text === "string" ? data.text.trim() : "";
    if (!roomId || roomId !== joinedRoom) return; // sirf apne room mein bhej sakta hai
    if (!sock.rooms.has(roomId)) return; // v8: room se nikaale gaye (block) to message nahi
    if (!name || !text || text.length > 200) return;
    const msg = { room: roomId, name: name, text: text, time: Date.now() };
    if (!roomHistory[roomId]) roomHistory[roomId] = [];
    roomHistory[roomId].push(msg);
    if (roomHistory[roomId].length > MAX_HISTORY) roomHistory[roomId] = roomHistory[roomId].slice(-MAX_HISTORY);
    // v8: chat karne wale ka naam yaad rakhein (demo rooms ka fallback),
    // aur message sirf un viewers ko bhejein jinhon ne sender ko block nahi kiya.
    if (!sock.data.userName) sock.data.userName = name;
    emitChatToRoom(roomId, msg);
  });

  // ---- WebRTC signalling: sirf usi room ke andar, host <-> watcher ----
  sock.on("go live", (data) => {
    if (!data || typeof data !== "object") return;
    const roomId = typeof data.room === "string" ? data.room : "";
    if (!roomId.startsWith("live-") || roomId !== joinedRoom) return;
    const title = typeof data.title === "string" ? data.title.slice(0, 60) : "Live";
    const host = typeof data.host === "string" ? data.host.slice(0, 30) : "Host";
    const cat = typeof data.cat === "string" ? data.cat.slice(0, 20) : "Chat";
    const cover = typeof data.cover === "string" ? data.cover.slice(0, 30) : "singer";
    liveRooms[roomId] = { hostId: sock.id, title: title, host: host, cat: cat, cover: cover };
    if (!sock.data.userName) sock.data.userName = host;
    emitLiveStarted(Object.assign({ room: roomId }, liveRooms[roomId]));
  });

  sock.on("end live", (data) => {
    if (!data || typeof data !== "object") return;
    const roomId = typeof data.room === "string" ? data.room : "";
    if (!isHostOf(sock.id, roomId)) return;
    endLiveRoom(roomId);
  });

  sock.on("watch", (data) => {
    if (!data || typeof data !== "object") return;
    const roomId = typeof data.room === "string" ? data.room : "";
    if (roomId !== joinedRoom || !liveRooms[roomId]) return;
    // v8: watcher ka naam bhi host ko bhejein — host apne live view mein
    // watcher ke naam ke saath Block button dekhega.
    const wname = cleanName(data.name) || (sock.data && sock.data.userName) || "";
    io.to(liveRooms[roomId].hostId).emit("watcher", { watcherId: sock.id, room: roomId, name: wname });
  });

  // v8: host apne live room ke watcher ko block kare — sirf host kar sakta hai.
  // Watcher host ki block list mein aa jata hai aur room se nikaal diya jata hai.
  sock.on("block user", (data) => {
    if (!data || typeof data !== "object") return;
    const roomId = typeof data.room === "string" ? data.room : "";
    const target = cleanName(data.target);
    if (!roomId || !target) return;
    if (!isHostOf(sock.id, roomId)) return;
    const hostName = liveRooms[roomId].host;
    if (!hostName || hostName.toLowerCase() === target.toLowerCase()) return;
    if (!addBlock(hostName, target)) return;
    for (const [, s] of io.sockets.sockets) {
      const sName = (s.data && s.data.userName) || "";
      if (sName && sName.toLowerCase() === target.toLowerCase() && s.rooms.has(roomId)) {
        s.leave(roomId);
        if (socketRoom[s.id] === roomId) delete socketRoom[s.id];
        s.emit("you were blocked", { room: roomId, message: "The host removed you from this live." });
      }
    }
    sock.emit("user blocked", { room: roomId, target: target });
  });

  sock.on("offer", (data) => {
    if (!data || typeof data !== "object") return;
    const roomId = typeof data.room === "string" ? data.room : "";
    const to = typeof data.to === "string" ? data.to : "";
    const sdp = data.sdp && typeof data.sdp === "object" && typeof data.sdp.sdp === "string" ? data.sdp : null;
    if (!sdp || sdp.sdp.length > 20000) return;
    if (!isHostOf(sock.id, roomId)) return;
    if (socketRoom[sock.id] !== roomId || socketRoom[to] !== roomId) return;
    io.to(to).emit("offer", { from: sock.id, room: roomId, sdp: sdp });
  });

  sock.on("answer", (data) => {
    if (!data || typeof data !== "object") return;
    const roomId = typeof data.room === "string" ? data.room : "";
    const to = typeof data.to === "string" ? data.to : "";
    const sdp = data.sdp && typeof data.sdp === "object" && typeof data.sdp.sdp === "string" ? data.sdp : null;
    if (!sdp || sdp.sdp.length > 20000) return;
    if (roomId !== joinedRoom || !isHostOf(to, roomId)) return;
    if (socketRoom[sock.id] !== roomId || socketRoom[to] !== roomId) return;
    io.to(to).emit("answer", { from: sock.id, room: roomId, sdp: sdp });
  });

  sock.on("ice", (data) => {
    if (!data || typeof data !== "object") return;
    const roomId = typeof data.room === "string" ? data.room : "";
    const to = typeof data.to === "string" ? data.to : "";
    if (!data.candidate || typeof data.candidate !== "object") return;
    if (socketRoom[sock.id] !== roomId || socketRoom[to] !== roomId) return;
    io.to(to).emit("ice", { from: sock.id, room: roomId, candidate: data.candidate });
  });

  sock.on("disconnect", () => {
    delete socketRoom[sock.id];
    Object.keys(liveRooms).forEach((roomId) => {
      if (liveRooms[roomId].hostId === sock.id) {
        endLiveRoom(roomId);
      } else if (joinedRoom === roomId) {
        io.to(liveRooms[roomId].hostId).emit("watcher left", { watcherId: sock.id, room: roomId });
      }
    });
    joinedRoom = null;
  });
});

if (HOST_PORT) {
  // Public hosting: ek hi HTTP port, 0.0.0.0 par (platform khud HTTPS deta hai).
  httpServer.listen(HOST_PORT, "0.0.0.0", () => {
    console.log("App chal rahi hai, port " + HOST_PORT);
  });
} else {
  // Local mode: bilkul v6 jaisa.
  httpServer.listen(PORT, () => {
    console.log("App chal rahi hai: http://localhost:" + PORT);
  });
  httpsServer.listen(HTTPS_PORT, () => {
    const lan = getLanIPs();
    console.log("Phone se live ke liye: https://" + (lan[0] || "localhost") + ":" + HTTPS_PORT);
    if (lan.length > 1) {
      lan.slice(1).forEach((ip) => console.log("  ya: https://" + ip + ":" + HTTPS_PORT));
    }
  });
}
