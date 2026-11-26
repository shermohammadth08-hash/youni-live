// Youni Live — PUBLIC version (Render free tier) — server + real-time live chat (socket.io) + real Go Live video (WebRTC signalling) + PWA (installable app)
// PUBLIC mode: agar PORT environment variable set hai (Render khud deta hai),
// to server sirf usi ek HTTP port par chalta hai — platform khud HTTPS deta hai,
// is liye certificate ki zaroorat nahi. PORT set nahi hai to local mode:
// HTTP port 3000 + HTTPS port 3443 (self-signed cert), bilkul v6 jaisa.
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
const USERS_FILE = path.join(__dirname, "users.json");
const CERT_FILE = path.join(__dirname, "cert.pem");
const KEY_FILE = path.join(__dirname, "key.pem");

function loadUsers() {
  try {
    return JSON.parse(fs.readFileSync(USERS_FILE, "utf8"));
  } catch (e) {
    return {};
  }
}

function saveUsers(users) {
  fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
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
  saveUsers(users);
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

function handleRequest(req, res) {
  const url = req.url.split("?")[0];

  if (req.method === "POST" && (url === "/api/register" || url === "/api/login")) {
    readBody(req).then((data) => {
      if (url === "/api/register") handleRegister(data, res);
      else handleLogin(data, res);
    }).catch(() => sendJSON(res, 400, { ok: false, error: "Ghalat data bheja gaya." }));
    return;
  }

  if (req.method !== "GET") {
    res.writeHead(405);
    res.end("Method not allowed");
    return;
  }

  let file = url === "/" ? "/index.html" : url;
  const full = path.join(__dirname, file);
  const resolved = path.resolve(full);
  // Public version: sirf ye files serve hongi. users.json, cert.pem, key.pem,
  // server.js aur package.json jaise files kabhi file ki tarah serve nahi hongi,
  // aur folder se bahar koi file nahi:
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

io.on("connection", (sock) => {
  let joinedRoom = null;

  // Naye connect hone wale ko pehle se live rooms ki list (Home feed ke liye)
  sock.emit("live list", Object.keys(liveRooms).map((rid) => Object.assign({ room: rid }, liveRooms[rid])));

  sock.on("join room", (roomId) => {
    if (typeof roomId !== "string") return;
    if (!DEMO_ROOMS.has(roomId) && !roomId.startsWith("live-")) return;
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
    if (!name || !text || text.length > 200) return;
    const msg = { room: roomId, name: name, text: text, time: Date.now() };
    if (!roomHistory[roomId]) roomHistory[roomId] = [];
    roomHistory[roomId].push(msg);
    if (roomHistory[roomId].length > MAX_HISTORY) roomHistory[roomId] = roomHistory[roomId].slice(-MAX_HISTORY);
    io.to(roomId).emit("chat message", msg);
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
    io.emit("live started", Object.assign({ room: roomId }, liveRooms[roomId]));
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
    io.to(liveRooms[roomId].hostId).emit("watcher", { watcherId: sock.id, room: roomId });
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
