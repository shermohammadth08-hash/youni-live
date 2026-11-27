// Chai Live — PUBLIC version (Railway free tier) — server + real-time live chat (socket.io) + real Go Live video (WebRTC signalling) + PWA (installable app)
// PUBLIC mode: agar PORT environment variable set hai (Railway khud deta hai),
// to server sirf usi ek HTTP port par chalta hai — platform khud HTTPS deta hai,
// is liye certificate ki zaroorat nahi. PORT set nahi hai to local mode:
// HTTP port 3000 + HTTPS port 3443 (self-signed cert), bilkul v6 jaisa.
// ACCOUNTS BACHANA (v7): users.json ab DATA_DIR mein save hota hai.
// Railway par DATA_DIR=/data set karein aur /data par ek Volume lagayein —
// phir restart ya redeploy par bhi accounts nahi mitenge. DATA_DIR set nahi hai
// to users.json hamesha ki tarah app folder mein save hota hai (local mode).
// GIFTS + COINS (v12): har user ke users.json record mein coins, beans
// (gift se kamai), giftsReceived aur lastClaim (rozana free coins ki tareekh)
// rehte hain. Naye user ko 1000 welcome coins; roz 500 free coins claim.
// POST /api/gift se coins kat te hain aur host ke beans barhte hain; socket
// par "gift" event se room ke sab log gift dekhte hain (nakli gift rokne ke
// liye ek dafa ka token — sirf asal payment ke baad broadcast hota hai).
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
const AVATAR_DIR = path.join(DATA_DIR, "avatars"); // v24: profile photos
const REPORTS_FILE = path.join(DATA_DIR, "reports.json");
// v12: Gifts — client ke GIFT_DEFS se rate milne chahiye (Rose 10, Heart 50,
// Diamond 200, Crown 500, Sports Car 1500, Rocket 3000, Palace 5000, Yacht 9999).
const GIFTS = { rose: 10, heart: 50, gem: 200, crown: 500, car: 1500, rocket: 3000, castle: 5000, yacht: 9999 };
const DAILY_COINS = 500;
const WELCOME_COINS = 1000;
// v12: gift tokens — /api/gift kamyab ho to ek token banta hai; socket "gift"
// handler sirf token dekh kar broadcast karta hai (bina payment ke nakli gift nahi).
const giftTokens = [];
function todayStr() { return new Date().toISOString().slice(0, 10); }
// v13: Har account ko Bigo jaisa number ID milta hai (9 digit) — naam nahi.
// Purane users ko pehli dafa milne par ID aur follow/location fields de dein.
function makeUserId(users) {
  const used = new Set(Object.values(users || {}).map((u) => u && u.id).filter((x) => typeof x === "number"));
  let id = 0;
  do { id = 100000000 + Math.floor(Math.random() * 900000000); } while (used.has(id));
  return id;
}
function normalizeUser(u, users) {
  if (!u || typeof u !== "object") return null;
  let changed = false;
  if (typeof u.coins !== "number") { u.coins = WELCOME_COINS; changed = true; }
  if (typeof u.beans !== "number") { u.beans = 0; changed = true; }
  if (typeof u.giftsReceived !== "number") { u.giftsReceived = 0; changed = true; }
  if (typeof u.lastClaim !== "string") { u.lastClaim = ""; changed = true; }
  if (typeof u.id !== "number") { u.id = makeUserId(users); changed = true; }
  if (!Array.isArray(u.followers)) { u.followers = []; changed = true; }
  if (!Array.isArray(u.following)) { u.following = []; changed = true; }
  if (typeof u.country !== "string") { u.country = ""; changed = true; }
  if (typeof u.city !== "string") { u.city = ""; changed = true; }
  if (typeof u.locationOn !== "boolean") { u.locationOn = false; changed = true; }
  if (typeof u.xp !== "number") { u.xp = 0; changed = true; }
  if (typeof u.livesHosted !== "number") { u.livesHosted = 0; changed = true; }
  if (typeof u.privateAccount !== "boolean") { u.privateAccount = false; changed = true; }
  if (typeof u.allowFollow !== "boolean") { u.allowFollow = true; changed = true; }
  if (typeof u.hideOnline !== "boolean") { u.hideOnline = false; changed = true; }
  if (typeof u.hideActive !== "boolean") { u.hideActive = false; changed = true; }
  if (typeof u.dndStrangers !== "boolean") { u.dndStrangers = false; changed = true; }
  if (typeof u.lastSeen !== "number") { u.lastSeen = 0; changed = true; }
  return changed ? u : null;
}
// v14: Level — har 100 XP par ek level, Level 1 se shuru, zyada se zyada 100.
function levelFor(xp) { return Math.min(100, Math.floor((xp || 0) / 100) + 1); }
function findUserKey(users, name) {
  return Object.keys(users).find((k) => k.toLowerCase() === name.toLowerCase());
}

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
      if (data.length > 300000) { // v24: avatar photo bhi isi se aati hai
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

// v24: Profile photo upload — client 256px JPEG bhejta hai, file /data/avatars mein.
function handleAvatar(data, res) {
  const name = cleanName(data.name);
  if (!name) return sendJSON(res, 400, { ok: false, error: "Please enter a name." });
  const image = typeof data.image === "string" ? data.image : "";
  const m = image.match(/^data:image\/(jpeg|png);base64,([A-Za-z0-9+/=]+)$/);
  if (!m) return sendJSON(res, 400, { ok: false, error: "Please choose a photo." });
  const buf = Buffer.from(m[2], "base64");
  if (buf.length > 200 * 1024) return sendJSON(res, 400, { ok: false, error: "Photo is too big." });
  const users = loadUsers();
  const key = findUserKey(users, name);
  if (!key) return sendJSON(res, 400, { ok: false, error: "No account with this name — please sign up first." });
  const safe = key.toLowerCase().replace(/[^a-z0-9]/g, "") || "user";
  const ext = m[1] === "png" ? "png" : "jpg";
  try {
    fs.mkdirSync(AVATAR_DIR, { recursive: true });
    fs.writeFileSync(path.join(AVATAR_DIR, safe + "." + ext), buf);
    const other = ext === "jpg" ? "png" : "jpg";
    try { fs.unlinkSync(path.join(AVATAR_DIR, safe + "." + other)); } catch (e) {}
  } catch (e) { return sendJSON(res, 500, { ok: false, error: "Could not save the photo." }); }
  users[key].avatar = "/avatars/" + safe + "." + ext;
  saveUsers(users);
  sendJSON(res, 200, { ok: true, avatar: users[key].avatar });
}
function handleGetAvatar(req, res) {
  const file = req.url.slice("/avatars/".length).split("?")[0];
  if (!/^[a-z0-9_-]+\.(jpg|png)$/.test(file)) { res.writeHead(404); res.end("Not found"); return; }
  const full = path.join(AVATAR_DIR, file);
  fs.readFile(full, (err, data) => {
    if (err) { res.writeHead(404); res.end("Not found"); return; }
    res.writeHead(200, { "Content-Type": file.endsWith(".png") ? "image/png" : "image/jpeg", "Cache-Control": "public, max-age=86400" });
    res.end(data);
  });
}
function handleRegister(data, res) {
  const name = typeof data.name === "string" ? data.name.trim() : "";
  const password = typeof data.password === "string" ? data.password : "";
  if (!name) return sendJSON(res, 400, { ok: false, error: "Please enter a name." });
  if (name.length > 30) return sendJSON(res, 400, { ok: false, error: "Name must be 30 characters or less." });
  if (password.length < 4) return sendJSON(res, 400, { ok: false, error: "Password kam se kam 4 harf ka ho." });
  const users = loadUsers();
  const taken = Object.keys(users).some((k) => k.toLowerCase() === name.toLowerCase());
  if (taken) return sendJSON(res, 400, { ok: false, error: "This name is already taken — choose another name or log in." });
  users[name] = { pass: hashPassword(password), created: new Date().toISOString(), id: makeUserId(users), coins: WELCOME_COINS, beans: 0, giftsReceived: 0, lastClaim: "", followers: [], following: [], country: "", city: "", locationOn: false, xp: 0, livesHosted: 0, privateAccount: false, allowFollow: true, hideOnline: false, hideActive: false, dndStrangers: false, lastSeen: Date.now() };
  if (!saveUsers(users)) {
    delete users[name];
    return sendJSON(res, 500, { ok: false, error: "Account could not be saved — please try again." });
  }
  sendJSON(res, 200, { ok: true, name: name, id: users[name].id });
}

function handleLogin(data, res) {
  const name = typeof data.name === "string" ? data.name.trim() : "";
  const password = typeof data.password === "string" ? data.password : "";
  if (!name || !password) return sendJSON(res, 400, { ok: false, error: "Please enter your name and password." });
  const users = loadUsers();
  const key = Object.keys(users).find((k) => k.toLowerCase() === name.toLowerCase());
  if (!key) return sendJSON(res, 400, { ok: false, error: "No account with this name — please sign up first." });
  if (users[key].pass !== hashPassword(password)) {
    return sendJSON(res, 400, { ok: false, error: "Wrong password." });
  }
  if (normalizeUser(users[key], users)) saveUsers(users); // v12: purane user ko wallet dein
  users[key].lastSeen = Date.now(); saveUsers(users); // v17: online status ke liye
  sendJSON(res, 200, { ok: true, name: key });
}

// v8: Block / Report — register/login jaisi hi validation.
const REPORT_REASONS = ["spam", "abuse", "bad content", "fake", "other"];

function blockTargetError(name, target) {
  if (!name) return "Please enter a name.";
  if (name.length > 30) return "Name must be 30 characters or less.";
  if (!target) return "Please enter the name to block.";
  if (target.length > 30) return "Name must be 30 characters or less.";
  if (name.toLowerCase() === target.toLowerCase()) return "You cannot block yourself.";
  return null;
}

function handleBlock(data, res) {
  const name = cleanName(data.name);
  const target = cleanName(data.target);
  const err = blockTargetError(name, target);
  if (err) return sendJSON(res, 400, { ok: false, error: err });
  if (!addBlock(name, target)) return sendJSON(res, 500, { ok: false, error: "Block could not be saved — please try again." });
  sendJSON(res, 200, { ok: true, blocked: blocksListOf(name) });
}

function handleUnblock(data, res) {
  const name = cleanName(data.name);
  const target = cleanName(data.target);
  const err = blockTargetError(name, target);
  if (err) return sendJSON(res, 400, { ok: false, error: err });
  if (!removeBlock(name, target)) return sendJSON(res, 500, { ok: false, error: "Unblock could not be saved — please try again." });
  sendJSON(res, 200, { ok: true, blocked: blocksListOf(name) });
}

function handleGetBlocks(req, res) {
  const q = req.url.includes("?") ? req.url.split("?")[1] : "";
  const name = cleanName(new URLSearchParams(q).get("name") || "");
  if (!name) return sendJSON(res, 400, { ok: false, error: "Please enter a name." });
  sendJSON(res, 200, { ok: true, blocked: blocksListOf(name) });
}

function handleReport(data, res) {
  const name = cleanName(data.name);
  const target = cleanName(data.target);
  const reason = typeof data.reason === "string" ? data.reason.trim() : "";
  const text = typeof data.text === "string" ? data.text.trim() : "";
  const room = typeof data.room === "string" ? data.room.trim().slice(0, 60) : "";
  if (!name) return sendJSON(res, 400, { ok: false, error: "Please enter a name." });
  if (name.length > 30) return sendJSON(res, 400, { ok: false, error: "Name must be 30 characters or less." });
  if (!target) return sendJSON(res, 400, { ok: false, error: "Please enter who to report." });
  if (target.length > 30) return sendJSON(res, 400, { ok: false, error: "Name must be 30 characters or less." });
  if (name.toLowerCase() === target.toLowerCase()) return sendJSON(res, 400, { ok: false, error: "You cannot report yourself." });
  if (!REPORT_REASONS.includes(reason)) return sendJSON(res, 400, { ok: false, error: "Report ki wajah chunein." });
  if (text.length > 200) return sendJSON(res, 400, { ok: false, error: "Report must be 200 characters or less." });
  const reports = loadReports();
  reports.push({ by: name, target: target, reason: reason, text: text, room: room, time: new Date().toISOString() });
  if (reports.length > 500) reports.splice(0, reports.length - 500);
  if (!saveReports(reports)) return sendJSON(res, 500, { ok: false, error: "Report could not be saved — please try again." });
  sendJSON(res, 200, { ok: true });
}

// Reports screen ke liye — v1 mein koi bhi logged-in user dekh sakta hai.
function handleGetReports(req, res) {
  const reports = loadReports().slice().reverse().slice(0, 100);
  sendJSON(res, 200, { ok: true, reports: reports });
}

// v12: Coins — balance, beans aur rozana claim ki haalat.
function handleGetCoins(req, res) {
  const q = req.url.includes("?") ? req.url.split("?")[1] : "";
  const name = cleanName(new URLSearchParams(q).get("name") || "");
  if (!name) return sendJSON(res, 400, { ok: false, error: "Please enter a name." });
  const users = loadUsers();
  const key = findUserKey(users, name);
  if (!key) return sendJSON(res, 400, { ok: false, error: "No account with this name — please sign up first." });
  if (normalizeUser(users[key], users)) saveUsers(users);
  const u = users[key];
  sendJSON(res, 200, { ok: true, coins: u.coins, beans: u.beans, giftsReceived: u.giftsReceived, canClaim: u.lastClaim !== todayStr() });
}

// v12: Rozana 500 free coins — ek din mein sirf ek dafa.
function handleClaimCoins(data, res) {
  const name = cleanName(data.name);
  if (!name) return sendJSON(res, 400, { ok: false, error: "Please enter a name." });
  const users = loadUsers();
  const key = findUserKey(users, name);
  if (!key) return sendJSON(res, 400, { ok: false, error: "No account with this name — please sign up first." });
  normalizeUser(users[key], users);
  const u = users[key];
  if (u.lastClaim === todayStr()) {
    return sendJSON(res, 200, { ok: false, error: "You already claimed today's free coins — come back tomorrow.", coins: u.coins });
  }
  u.coins += DAILY_COINS;
  u.lastClaim = todayStr();
  if (!saveUsers(users)) return sendJSON(res, 500, { ok: false, error: "Claim could not be saved — please try again." });
  sendJSON(res, 200, { ok: true, coins: u.coins, claimed: DAILY_COINS });
}

// v12: Gift bhejna — sender ke coins kat te hain, host ke beans barhte hain.
// Demo hosts (Ayesha Khan waghera) asal user nahi hote — un ko gift nahi bhej sakte.
function handleGift(data, res) {
  const from = cleanName(data.from);
  const to = cleanName(data.to);
  const gift = typeof data.gift === "string" ? data.gift.trim() : "";
  if (!from) return sendJSON(res, 400, { ok: false, error: "Please enter a name." });
  if (!to) return sendJSON(res, 400, { ok: false, error: "Please enter who to send the gift to." });
  if (from.toLowerCase() === to.toLowerCase()) return sendJSON(res, 400, { ok: false, error: "You cannot send a gift to yourself." });
  if (!Object.prototype.hasOwnProperty.call(GIFTS, gift)) return sendJSON(res, 400, { ok: false, error: "Gift not found." });
  const cost = GIFTS[gift];
  const users = loadUsers();
  const fromKey = findUserKey(users, from);
  const toKey = findUserKey(users, to);
  if (!fromKey) return sendJSON(res, 400, { ok: false, error: "Please sign up first." });
  if (!toKey) return sendJSON(res, 400, { ok: false, error: "This is a demo room — gifts can only be sent in a real live." });
  normalizeUser(users[fromKey], users);
  normalizeUser(users[toKey], users);
  if (users[fromKey].coins < cost) {
    return sendJSON(res, 400, { ok: false, error: "Not enough coins — get 500 free coins daily from Profile.", coins: users[fromKey].coins });
  }
  users[fromKey].coins -= cost;
  users[toKey].beans += cost;
  users[toKey].giftsReceived += 1;
  users[toKey].xp = (users[toKey].xp || 0) + Math.max(1, Math.floor(cost / 10)); // v14: gift milna = XP
  users[fromKey].xp = (users[fromKey].xp || 0) + 1; // v14: gift bhejna = +1 XP
  if (!saveUsers(users)) return sendJSON(res, 500, { ok: false, error: "Gift could not be saved — please try again." });
  giftTokens.push({ from: from, to: to, gift: gift, cost: cost, time: Date.now() });
  if (giftTokens.length > 200) giftTokens.splice(0, giftTokens.length - 200);
  sendJSON(res, 200, { ok: true, coins: users[fromKey].coins, gift: gift, cost: cost });
}

// v13: Profile — number ID, asli followers/following, location (sirf jab on ho).
function handleGetProfile(req, res) {
  const q = req.url.includes("?") ? req.url.split("?")[1] : "";
  const params = new URLSearchParams(q);
  const name = cleanName(params.get("name") || "");
  const viewer = cleanName(params.get("viewer") || "");
  if (!name) return sendJSON(res, 400, { ok: false, error: "Please enter a name." });
  const users = loadUsers();
  const key = findUserKey(users, name);
  if (!key) return sendJSON(res, 400, { ok: false, error: "No account with this name — please sign up first." });
  if (normalizeUser(users[key], users)) saveUsers(users);
  const u = users[key];
  const followers = Array.isArray(u.followers) ? u.followers : [];
  const following = Array.isArray(u.following) ? u.following : [];
  // v14: private account — doosron se location aur lists chhupayein.
  const isSelf = viewer && viewer.toLowerCase() === key.toLowerCase();
  const hidden = !!u.privateAccount && !isSelf;
  let isFollowing = false;
  if (viewer) {
    const vKey = findUserKey(users, viewer);
    if (vKey) {
      normalizeUser(users[vKey], users);
      const vFollowing = Array.isArray(users[vKey].following) ? users[vKey].following : [];
      isFollowing = vFollowing.some((n) => n.toLowerCase() === key.toLowerCase());
    }
  }
  const xp = u.xp || 0;
  // v17: Online status — lastSeen 3 minute ke andar ho to online. hideOnline
  // par doosron ko kuch nahi dikhta; hideActive par sirf "last seen" waqt chhupta hai.
  const lastSeenMin = (typeof u.lastSeen === "number" && u.lastSeen > 0) ? Math.floor((Date.now() - u.lastSeen) / 60000) : null;
  const online = isSelf ? true : (u.hideOnline ? null : (lastSeenMin !== null && lastSeenMin < 3));
  const lastActiveMin = isSelf ? (lastSeenMin === null ? 0 : lastSeenMin) : (u.hideOnline || u.hideActive ? null : lastSeenMin);
  sendJSON(res, 200, {
    ok: true, name: key, id: u.id, avatar: u.avatar || "",
    followers: followers.length, following: following.length,
    followersList: hidden ? [] : followers.slice(0, 200),
    followingList: hidden ? [] : following.slice(0, 200),
    beans: u.beans || 0, giftsReceived: u.giftsReceived || 0,
    country: (u.locationOn && !hidden) ? (u.country || "") : "",
    city: (u.locationOn && !hidden) ? (u.city || "") : "",
    locationOn: !!u.locationOn && !hidden, isFollowing: isFollowing,
    xp: xp, level: levelFor(xp), xpToNext: levelFor(xp) >= 100 ? 0 : 100 - (xp % 100),
    livesHosted: u.livesHosted || 0,
    privateAccount: !!u.privateAccount, allowFollow: u.allowFollow !== false,
    online: online, lastActiveMin: lastActiveMin,
    hideOnline: isSelf ? !!u.hideOnline : undefined,
    hideActive: isSelf ? !!u.hideActive : undefined,
    dndStrangers: isSelf ? !!u.dndStrangers : undefined
  });
}

// v13: Follow / Unfollow — dono taraf ki lists update hoti hain.
function handleFollow(data, res, unfollow) {
  const from = cleanName(data.from);
  const to = cleanName(data.to);
  if (!from) return sendJSON(res, 400, { ok: false, error: "Please enter a name." });
  if (!to) return sendJSON(res, 400, { ok: false, error: "Please enter who to follow." });
  if (from.toLowerCase() === to.toLowerCase()) return sendJSON(res, 400, { ok: false, error: "You cannot follow yourself." });
  const users = loadUsers();
  const fromKey = findUserKey(users, from);
  const toKey = findUserKey(users, to);
  if (!fromKey) return sendJSON(res, 400, { ok: false, error: "Please sign up first." });
  if (!toKey) return sendJSON(res, 400, { ok: false, error: "User not found — only real accounts can be followed." });
  normalizeUser(users[fromKey], users);
  normalizeUser(users[toKey], users);
  if (!unfollow && users[toKey].allowFollow === false) return sendJSON(res, 400, { ok: false, error: "This user does not accept new followers." });
  if (unfollow) {
    users[fromKey].following = users[fromKey].following.filter((n) => n.toLowerCase() !== toKey.toLowerCase());
    users[toKey].followers = users[toKey].followers.filter((n) => n.toLowerCase() !== fromKey.toLowerCase());
  } else {
    if (!users[fromKey].following.some((n) => n.toLowerCase() === toKey.toLowerCase())) users[fromKey].following.push(toKey);
    if (!users[toKey].followers.some((n) => n.toLowerCase() === fromKey.toLowerCase())) {
      users[toKey].followers.push(fromKey);
      users[toKey].xp = (users[toKey].xp || 0) + 5; // v14: naya follower = +5 XP
    }
  }
  if (!saveUsers(users)) return sendJSON(res, 500, { ok: false, error: "Could not be saved — please try again." });
  sendJSON(res, 200, { ok: true, isFollowing: !unfollow, followers: users[toKey].followers.length, following: users[fromKey].following.length });
}

// v13: Location — sirf jab user khud on kare; band ho to profile par chhupta hai.
function handleLocation(data, res) {
  const name = cleanName(data.name);
  if (!name) return sendJSON(res, 400, { ok: false, error: "Please enter a name." });
  const locationOn = data.locationOn === true;
  const country = typeof data.country === "string" ? data.country.trim().slice(0, 60) : "";
  const city = typeof data.city === "string" ? data.city.trim().slice(0, 60) : "";
  const users = loadUsers();
  const key = findUserKey(users, name);
  if (!key) return sendJSON(res, 400, { ok: false, error: "No account with this name — please sign up first." });
  normalizeUser(users[key], users);
  users[key].locationOn = locationOn;
  if (locationOn) { users[key].country = country; users[key].city = city; }
  if (!saveUsers(users)) return sendJSON(res, 500, { ok: false, error: "Location could not be saved — please try again." });
  sendJSON(res, 200, { ok: true, locationOn: users[key].locationOn, country: users[key].country, city: users[key].city });
}

// v14: Live khatam — host ko +20 XP aur livesHosted +1.
function handleLiveEnded(data, res) {
  const name = cleanName(data.name);
  if (!name) return sendJSON(res, 400, { ok: false, error: "Please enter a name." });
  const users = loadUsers();
  const key = findUserKey(users, name);
  if (!key) return sendJSON(res, 400, { ok: false, error: "No account with this name — please sign up first." });
  normalizeUser(users[key], users);
  users[key].xp = (users[key].xp || 0) + 20;
  users[key].livesHosted = (users[key].livesHosted || 0) + 1;
  if (!saveUsers(users)) return sendJSON(res, 500, { ok: false, error: "Could not be saved — please try again." });
  sendJSON(res, 200, { ok: true, xp: users[key].xp, level: levelFor(users[key].xp), livesHosted: users[key].livesHosted });
}

// v14: Privacy settings — private account aur follow ki ijazat.
function handlePrivacy(data, res) {
  const name = cleanName(data.name);
  if (!name) return sendJSON(res, 400, { ok: false, error: "Please enter a name." });
  const users = loadUsers();
  const key = findUserKey(users, name);
  if (!key) return sendJSON(res, 400, { ok: false, error: "No account with this name — please sign up first." });
  normalizeUser(users[key], users);
  if (typeof data.privateAccount === "boolean") users[key].privateAccount = data.privateAccount;
  if (typeof data.allowFollow === "boolean") users[key].allowFollow = data.allowFollow;
  if (typeof data.hideOnline === "boolean") users[key].hideOnline = data.hideOnline;
  if (typeof data.hideActive === "boolean") users[key].hideActive = data.hideActive;
  if (typeof data.dndStrangers === "boolean") users[key].dndStrangers = data.dndStrangers;
  if (!saveUsers(users)) return sendJSON(res, 500, { ok: false, error: "Could not be saved — please try again." });
  sendJSON(res, 200, { ok: true, privateAccount: !!users[key].privateAccount, allowFollow: users[key].allowFollow !== false, hideOnline: !!users[key].hideOnline, hideActive: !!users[key].hideActive, dndStrangers: !!users[key].dndStrangers });
}

// v15: Ranking — sab se zyada XP wale top 20 users.
function handleGetRanking(req, res) {
  const users = loadUsers();
  let changed = false;
  const arr = Object.keys(users).map((k) => {
    const u = users[k];
    if (normalizeUser(u, users)) changed = true; // v18: purane account ko bhi apni ID mile
    if (typeof u.xp !== "number") u.xp = 0;
    return { name: k, id: u.id, xp: u.xp || 0, level: levelFor(u.xp), followers: Array.isArray(u.followers) ? u.followers.length : 0, avatar: u.avatar || "" };
  });
  if (changed) saveUsers(users);
  arr.sort((a, b) => b.xp - a.xp);
  sendJSON(res, 200, { ok: true, ranking: arr.slice(0, 20) });
}

// v15: Password change.
function handleChangePassword(data, res) {
  const name = cleanName(data.name);
  const oldPass = typeof data.oldPassword === "string" ? data.oldPassword : "";
  const newPass = typeof data.newPassword === "string" ? data.newPassword : "";
  if (!name) return sendJSON(res, 400, { ok: false, error: "Please enter a name." });
  if (newPass.length < 4) return sendJSON(res, 400, { ok: false, error: "Password must be at least 4 characters." });
  const users = loadUsers();
  const key = findUserKey(users, name);
  if (!key) return sendJSON(res, 400, { ok: false, error: "No account with this name — please sign up first." });
  if (users[key].pass !== hashPassword(oldPass)) return sendJSON(res, 400, { ok: false, error: "Wrong password." });
  users[key].pass = hashPassword(newPass);
  if (!saveUsers(users)) return sendJSON(res, 500, { ok: false, error: "Could not be saved — please try again." });
  sendJSON(res, 200, { ok: true });
}

// v17: Heartbeat — app khuli rehte har 60 second mein lastSeen update (online status).
function handleHeartbeat(data, res) {
  const name = cleanName(data.name);
  if (!name) return sendJSON(res, 400, { ok: false, error: "Please enter a name." });
  const users = loadUsers();
  const key = findUserKey(users, name);
  if (!key) return sendJSON(res, 400, { ok: false, error: "No account with this name." });
  users[key].lastSeen = Date.now();
  if (!saveUsers(users)) return sendJSON(res, 500, { ok: false, error: "Could not be saved." });
  sendJSON(res, 200, { ok: true });
}

function handleRequest(req, res) {
  const url = req.url.split("?")[0];

  if (req.method === "POST" && (url === "/api/register" || url === "/api/login" || url === "/api/block" || url === "/api/unblock" || url === "/api/report" || url === "/api/coins/claim" || url === "/api/gift" || url === "/api/follow" || url === "/api/unfollow" || url === "/api/location" || url === "/api/live-ended" || url === "/api/privacy" || url === "/api/change-password" || url === "/api/heartbeat" || url === "/api/avatar")) {
    readBody(req).then((data) => {
      if (url === "/api/register") handleRegister(data, res);
      else if (url === "/api/login") handleLogin(data, res);
      else if (url === "/api/block") handleBlock(data, res);
      else if (url === "/api/unblock") handleUnblock(data, res);
      else if (url === "/api/coins/claim") handleClaimCoins(data, res);
      else if (url === "/api/gift") handleGift(data, res);
      else if (url === "/api/follow") handleFollow(data, res, false);
      else if (url === "/api/unfollow") handleFollow(data, res, true);
      else if (url === "/api/location") handleLocation(data, res);
      else if (url === "/api/live-ended") handleLiveEnded(data, res);
      else if (url === "/api/privacy") handlePrivacy(data, res);
      else if (url === "/api/change-password") handleChangePassword(data, res);
      else if (url === "/api/heartbeat") handleHeartbeat(data, res);
      else if (url === "/api/avatar") handleAvatar(data, res);
      else handleReport(data, res);
    }).catch(() => sendJSON(res, 400, { ok: false, error: "Invalid data sent." }));
    return;
  }

  // v8: blocked list aur reports padhna (GET).
  if (req.method === "GET" && url.startsWith("/avatars/")) { handleGetAvatar(req, res); return; } // v24
  if (req.method === "GET" && url === "/api/blocks") { handleGetBlocks(req, res); return; }
  if (req.method === "GET" && url === "/api/coins") { handleGetCoins(req, res); return; }
  if (req.method === "GET" && url === "/api/profile") { handleGetProfile(req, res); return; }
  if (req.method === "GET" && url === "/api/ranking") { handleGetRanking(req, res); return; }
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

/* ================= Real live video — WebRTC signalling ================= */
// Video server par save nahi hoti — server sirf signalling messages aage bhejta hai.
// Camera sirf secure context (localhost / HTTPS) mein milti hai:
// HOST laptop se (http://localhost:3000) YA phone se (https://<LAN-IP>:3443) live ja sakta hai.
// Phone plain HTTP par sirf dekh sakta hai; dekhne ke liye camera ki zaroorat nahi hoti.
const liveRooms = {}; // roomId -> { hostId, title, host, cat, cover }

/* ================= v20: Multi-guest live — 1 host + 4 guest seats ================= */
// Seats sirf memory mein rehti hain (live rooms ki tarah) — server restart par khatam.
const GUEST_SEATS = 4;
const guestSeats = {}; // roomId -> [ {seat, guestId, name, seq} | null x4 ]
const guestSeq = {};   // roomId -> counter (tiles ki order ke liye)
function avatarFor(name){ // v24: user ki profile photo ka URL
  if (!name) return "";
  try {
    const users = loadUsers();
    const key = findUserKey(users, name);
    return (key && users[key].avatar) || "";
  } catch (e) { return ""; }
}
function seatCount(roomId){ // v25: audio room mein 8 seats, baaki mein 4
  return (liveRooms[roomId] && liveRooms[roomId].mode === 'audio') ? 8 : 4;
}
function seatsFor(roomId){
  if (!guestSeats[roomId]) guestSeats[roomId] = new Array(seatCount(roomId)).fill(null);
  return guestSeats[roomId];
}
function seatsPayload(roomId){
  return seatsFor(roomId).map(function(x){ return x ? { seat: x.seat, guestId: x.guestId, name: x.name, seq: x.seq, avatar: avatarFor(x.name), muted: !!(x.selfMuted || x.hostMuted), hostMuted: !!x.hostMuted } : null; }); // v31: mute state
}
function broadcastSeats(roomId){
  io.to(roomId).emit("guest seats", { room: roomId, seats: seatsPayload(roomId) });
}
function freeGuestSeat(roomId, guestId){
  const seats = seatsFor(roomId);
  let changed = false;
  for (let i = 0; i < seats.length; i++) {
    if (seats[i] && seats[i].guestId === guestId) { seats[i] = null; changed = true; }
  }
  if (changed) broadcastSeats(roomId);
  return changed;
}
function clearGuestSeats(roomId){
  delete guestSeats[roomId];
  delete guestSeq[roomId];
}
const socketRoom = {}; // socketId -> roomId (signalling validation ke liye)

function validRoomId(roomId){
  return typeof roomId === "string" && roomId.startsWith("live-"); // v19: real rooms only
}
function isHostOf(sockId, roomId){
  return !!liveRooms[roomId] && liveRooms[roomId].hostId === sockId;
}
// v28: PK Battle — do hosts aamne-saamne, gifts se score, 5 minute timer.
const PK_DURATION = 5 * 60 * 1000;
const pkBattles = {}; // pkId -> battle
const pkByRoom = {}; // roomId -> pkId
function pkForRoom(roomId){ const id = pkByRoom[roomId]; return id ? pkBattles[id] : null; }
function endPk(pkId, reason, forfeitRoomId){
  const pk = pkBattles[pkId]; if (!pk) return;
  if (pk.timer) clearTimeout(pk.timer);
  delete pkBattles[pkId];
  delete pkByRoom[pk.roomA]; delete pkByRoom[pk.roomB];
  let winner = null;
  if (forfeitRoomId) winner = forfeitRoomId === pk.roomA ? 'B' : 'A';
  else if (pk.scoreA !== pk.scoreB) winner = pk.scoreA > pk.scoreB ? 'A' : 'B';
  const payload = { pkId: pkId, winner: winner, winnerRoom: winner ? (winner === 'A' ? pk.roomA : pk.roomB) : null, winnerName: winner ? (winner === 'A' ? pk.nameA : pk.nameB) : null, scoreA: pk.scoreA, scoreB: pk.scoreB, nameA: pk.nameA, nameB: pk.nameB, roomA: pk.roomA, roomB: pk.roomB, reason: reason || 'time' };
  io.to(pk.roomA).emit("pk result", payload);
  io.to(pk.roomB).emit("pk result", payload);
}
function endLiveRoom(roomId){
  if (!liveRooms[roomId]) return;
  const pk = pkForRoom(roomId);
  if (pk) endPk(pk.id, 'live-ended', roomId); // live khatam — doosra host jeetta hai
  delete liveRooms[roomId];
  clearGuestSeats(roomId);
  io.emit("live ended", { room: roomId });
}

/* ================= v8: Report/Block enforcement (server-side) ================= */
// Har socket ka username sock.data.userName mein rehta hai — client "identify"
// event se bhejta hai.
// Live list / live started: wo room chhupayein jahan viewer ne host ko block
// kiya ho YA host ne viewer ko block kiya ho. Chat: har viewer ko alag se
// bhejein — jis ne sender ko block kiya hai use message nahi milta.
function roomHiddenFor(viewerName, hostName){
  if (!viewerName || !hostName) return false;
  return hasBlocked(viewerName, hostName) || hasBlocked(hostName, viewerName);
}

function roomViewerCount(roomId){ // v29: asli viewers — host ko ginay baghair
  const live = liveRooms[roomId]; if (!live) return 0;
  let n = 0;
  for (const [, s] of io.sockets.sockets) {
    if (s.rooms.has(roomId) && s.id !== live.hostId) n++;
  }
  return n;
}
function broadcastViewers(roomId){ // v29
  if (!liveRooms[roomId]) return;
  io.to(roomId).emit("viewers", { room: roomId, count: roomViewerCount(roomId) });
}
function isRoomAdmin(sock, roomId){ // v32: room admin — host ne banaya ho
  const r = liveRooms[roomId]; if (!r || !r.admins) return false;
  const n = ((sock.data && sock.data.userName) || "").toLowerCase();
  return !!n && r.admins.some((a) => (a || "").toLowerCase() === n);
}
function kickFromRoom(roomId, name){ // v34: Bigo jaisa — kick hua banda is live mein dobara nahi aa sakta
  const r = liveRooms[roomId]; if (!r || !name) return;
  r.kicked = r.kicked || [];
  const k = (name || "").toLowerCase();
  if (k && !r.kicked.includes(k)) r.kicked.push(k);
}
function isKickedFromRoom(roomId, name){
  const r = liveRooms[roomId]; if (!r || !r.kicked || !name) return false;
  return r.kicked.includes((name || "").toLowerCase());
}
function broadcastLiveList(){ // v32: Home cards update karein (room DP badli ho to)
  for (const [, x] of io.sockets.sockets) {
    const vn = (x.data && x.data.userName) || "";
    x.emit("live list", liveListFor(vn));
  }
}
function liveListFor(viewerName){
  return Object.keys(liveRooms)
    .filter((rid) => !roomHiddenFor(viewerName, liveRooms[rid].host))
    .map((rid) => {
      const base = Object.assign({ room: rid, hostAvatar: avatarFor(liveRooms[rid].host), viewers: roomViewerCount(rid) }, liveRooms[rid]); // v29: asli viewer count
      const pk = pkForRoom(rid); // v28: PK chal rahi ho to late joiner ko bhi pata chale
      if (pk) {
        const isA = pk.roomA === rid;
        base.pk = { id: pk.id, roomA: pk.roomA, roomB: pk.roomB, nameA: pk.nameA, nameB: pk.nameB, opponentRoom: isA ? pk.roomB : pk.roomA, opponentName: isA ? pk.nameB : pk.nameA, endsAt: pk.endsAt, scoreA: pk.scoreA, scoreB: pk.scoreB };
      }
      return base;
    });
}

function emitChatToRoom(roomId, msg){
  for (const [, s] of io.sockets.sockets) {
    if (!s.rooms.has(roomId)) continue;
    const viewer = (s.data && s.data.userName) || "";
    if (viewer && hasBlocked(viewer, msg.name)) continue;
    s.emit("chat message", msg);
  }
}

// v12: Gift room ke sab viewers ko — jis ne sender ko block kiya hai use nahi.
function emitGiftToRoom(roomId, gift){
  for (const [, s] of io.sockets.sockets) {
    if (!s.rooms.has(roomId)) continue;
    const viewer = (s.data && s.data.userName) || "";
    if (viewer && hasBlocked(viewer, gift.from)) continue;
    s.emit("gift", gift);
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
    if (!roomId.startsWith("live-")) return; // v19: real rooms only
    // v8: live room mein join nahi — agar host ne joiner ko block kiya ho
    // ya joiner ne host ko block kiya ho.
    const live = liveRooms[roomId];
    if (live) {
      const joiner = (sock.data && sock.data.userName) || "";
      if (joiner && roomHiddenFor(joiner, live.host)) {
        sock.emit("blocked", { room: roomId, message: "You can't join this live — you are blocked." });
        return;
      }
      if (joiner && isKickedFromRoom(roomId, joiner)) { // v34: kick hua — is live mein wapas nahi
        sock.emit("blocked", { room: roomId, message: "You were kicked from this live." });
        return;
      }
    }
    if (joinedRoom) sock.leave(joinedRoom);
    joinedRoom = roomId;
    sock.join(roomId);
    socketRoom[sock.id] = roomId;
    sock.emit("chat history", (roomHistory[roomId] || []).slice(-MAX_HISTORY));
    if (liveRooms[roomId]) {
      broadcastViewers(roomId); // v29: naya viewer aaya — count update
      sock.emit("live started", Object.assign({ room: roomId, hostAvatar: avatarFor(liveRooms[roomId].host) }, liveRooms[roomId])); // v34
      sock.emit("guest seats", { room: roomId, seats: seatsPayload(roomId) }); // v20
      sock.emit("room admins", { room: roomId, admins: liveRooms[roomId].admins || [] }); // v32
    }
  });

  sock.on("leave room", (roomId) => {
    if (joinedRoom === roomId) {
      freeGuestSeat(roomId, sock.id); // v20: guest tha to seat khaali karein
      sock.leave(roomId);
      joinedRoom = null;
      delete socketRoom[sock.id];
      if (liveRooms[roomId] && liveRooms[roomId].hostId === sock.id) {
        endLiveRoom(roomId);
      } else if (liveRooms[roomId]) {
        io.to(liveRooms[roomId].hostId).emit("watcher left", { watcherId: sock.id, room: roomId });
        broadcastViewers(roomId); // v29: viewer gaya — count update
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

  // v12: Gift broadcast — sirf tab jab /api/gift se payment ho chuki ho
  // (token milna zaroori hai). Bina token ke gift room mein nahi dikhega.
  sock.on("gift", (data) => {
    if (!data || typeof data !== "object") return;
    const roomId = typeof data.room === "string" ? data.room : "";
    const from = cleanName(data.from);
    const to = cleanName(data.to);
    const gift = typeof data.gift === "string" ? data.gift.trim() : "";
    if (!roomId || roomId !== joinedRoom) return;
    if (!from || !to || !Object.prototype.hasOwnProperty.call(GIFTS, gift)) return;
    const me = (sock.data && sock.data.userName) || "";
    if (!me || me.toLowerCase() !== from.toLowerCase()) return;
    const now = Date.now();
    const ti = giftTokens.findIndex((t) => t.from.toLowerCase() === from.toLowerCase() && t.to.toLowerCase() === to.toLowerCase() && t.gift === gift && now - t.time < 60000);
    if (ti === -1) return;
    const tok = giftTokens.splice(ti, 1)[0];
    emitGiftToRoom(roomId, { room: roomId, from: from, to: to, gift: gift, cost: tok.cost, time: now });
    const pk = pkForRoom(roomId); // v28: PK mein gift = score
    if (pk) {
      if (roomId === pk.roomA) pk.scoreA += tok.cost; else pk.scoreB += tok.cost;
      const sp = { pkId: pk.id, scoreA: pk.scoreA, scoreB: pk.scoreB };
      io.to(pk.roomA).emit("pk score", sp);
      io.to(pk.roomB).emit("pk score", sp);
    }
  });

  // ---- WebRTC signalling: sirf usi room ke andar, host <-> watcher ----
  sock.on("go live", (data) => {
    if (!data || typeof data !== "object") return;
    const roomId = typeof data.room === "string" ? data.room : "";
    if (!roomId.startsWith("live-") || roomId !== joinedRoom) return;
    const title = typeof data.title === "string" ? data.title.slice(0, 60) : "Live";
    const host = typeof data.host === "string" ? data.host.slice(0, 30) : "Host";
    const cat = typeof data.cat === "string" ? data.cat.slice(0, 20) : "Chat";
    const rawCover = typeof data.cover === "string" ? data.cover : "singer"; // v32: gallery DP (data URL) ya built-in cover
    const cover = (rawCover.startsWith("data:image/") && rawCover.length <= 200000) ? rawCover : (rawCover.length <= 30 ? rawCover : "singer");
    liveRooms[roomId] = { hostId: sock.id, title: title, host: host, cat: cat, cover: cover, theme: (typeof data.theme === "string" && data.theme.length <= 20) ? data.theme.slice(0, 20) : cover, multiGuest: data.multiGuest !== false, mode: typeof data.mode === "string" ? data.mode.slice(0, 10) : "video", cameraOn: true }; // v23, v26 theme
    if (!sock.data.userName) sock.data.userName = host;
    emitLiveStarted(Object.assign({ room: roomId, hostAvatar: avatarFor(host) }, liveRooms[roomId])); // v34: guest ko host ki photo dikhe
  });

  sock.on("end live", (data) => {
    if (!data || typeof data !== "object") return;
    const roomId = typeof data.room === "string" ? data.room : "";
    if (!isHostOf(sock.id, roomId)) return;
    endLiveRoom(roomId);
  });
  sock.on("room cover", (data) => { // v32: host room DP badle (gallery se) — sab ko dikhe + Home card update
    if (!data || typeof data !== "object") return;
    const roomId = typeof data.room === "string" ? data.room : "";
    if (!isHostOf(sock.id, roomId) || !liveRooms[roomId]) return;
    const cover = typeof data.cover === "string" ? data.cover : "";
    const ok = (cover.startsWith("data:image/") && cover.length <= 200000) || (cover.length <= 30 && /^[a-z0-9_-]+$/i.test(cover));
    if (!ok) return;
    liveRooms[roomId].cover = cover;
    liveRooms[roomId].theme = cover;
    io.to(roomId).emit("room cover", { room: roomId, cover: cover });
    broadcastLiveList();
  });
  sock.on("room theme", (data) => { // v26: host background badle — sab viewers ko batayein
    if (!data || typeof data !== "object") return;
    const roomId = typeof data.room === "string" ? data.room : "";
    if (!isHostOf(sock.id, roomId)) return;
    const theme = typeof data.theme === "string" ? data.theme.slice(0, 20) : "";
    if (!theme || !liveRooms[roomId]) return;
    liveRooms[roomId].theme = theme;
    io.to(roomId).emit("room theme", { room: roomId, theme: theme });
  });
  // v28: PK Battle events
  sock.on("pk request", (data) => {
    if (!data || typeof data !== "object") return;
    const toRoom = typeof data.toRoom === "string" ? data.toRoom : "";
    if (!joinedRoom || !isHostOf(sock.id, joinedRoom)) return;
    if (!toRoom || toRoom === joinedRoom || !liveRooms[toRoom]) return;
    if (liveRooms[joinedRoom].mode === 'audio' || liveRooms[toRoom].mode === 'audio') { io.to(sock.id).emit("pk declined", { reason: "audio" }); return; }
    if (pkForRoom(joinedRoom) || pkForRoom(toRoom)) { io.to(sock.id).emit("pk declined", { reason: "busy" }); return; }
    io.to(liveRooms[toRoom].hostId).emit("pk invite", { fromRoom: joinedRoom, fromName: liveRooms[joinedRoom].host, fromHostId: sock.id });
  });
  sock.on("pk accept", (data) => {
    if (!data || typeof data !== "object") return;
    const fromRoom = typeof data.fromRoom === "string" ? data.fromRoom : "";
    if (!joinedRoom || !isHostOf(sock.id, joinedRoom)) return;
    if (!fromRoom || !liveRooms[fromRoom] || !liveRooms[joinedRoom]) return;
    if (pkForRoom(joinedRoom) || pkForRoom(fromRoom)) return;
    if (liveRooms[fromRoom].mode === 'audio' || liveRooms[joinedRoom].mode === 'audio') return;
    const pkId = 'pk-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
    const pk = { id: pkId, roomA: fromRoom, roomB: joinedRoom, hostA: liveRooms[fromRoom].hostId, hostB: sock.id, nameA: liveRooms[fromRoom].host, nameB: liveRooms[joinedRoom].host, scoreA: 0, scoreB: 0, endsAt: Date.now() + PK_DURATION, timer: null };
    pk.timer = setTimeout(() => endPk(pkId, 'time'), PK_DURATION);
    pkBattles[pkId] = pk;
    pkByRoom[fromRoom] = pkId; pkByRoom[joinedRoom] = pkId;
    const payload = { pkId: pkId, roomA: pk.roomA, roomB: pk.roomB, nameA: pk.nameA, nameB: pk.nameB, hostA: pk.hostA, hostB: pk.hostB, endsAt: pk.endsAt, scoreA: 0, scoreB: 0 };
    io.to(fromRoom).emit("pk start", payload);
    io.to(joinedRoom).emit("pk start", payload);
  });
  sock.on("pk reject", (data) => {
    if (!data || typeof data !== "object") return;
    const fromRoom = typeof data.fromRoom === "string" ? data.fromRoom : "";
    if (!fromRoom || !liveRooms[fromRoom]) return;
    io.to(liveRooms[fromRoom].hostId).emit("pk declined", { reason: "declined" });
  });
  sock.on("pk end", () => {
    if (!joinedRoom || !isHostOf(sock.id, joinedRoom)) return;
    const pk = pkForRoom(joinedRoom);
    if (pk) endPk(pk.id, 'ended');
  });
  sock.on("pk offer", (data) => { // v28: PK video signalling relay
    if (!data || typeof data !== "object" || !pkForRoom(joinedRoom)) return;
    const to = typeof data.to === "string" ? data.to : "";
    if (!to || !data.sdp) return;
    io.to(to).emit("pk offer", { from: sock.id, room: joinedRoom, kind: data.kind, sdp: data.sdp });
  });
  sock.on("pk answer", (data) => {
    if (!data || typeof data !== "object" || !pkForRoom(joinedRoom)) return;
    const to = typeof data.to === "string" ? data.to : "";
    if (!to || !data.sdp) return;
    io.to(to).emit("pk answer", { from: sock.id, room: joinedRoom, kind: data.kind, sdp: data.sdp });
  });
  sock.on("pk ice", (data) => {
    if (!data || typeof data !== "object" || !pkForRoom(joinedRoom)) return;
    const to = typeof data.to === "string" ? data.to : "";
    if (!to || !data.candidate) return;
    io.to(to).emit("pk ice", { from: sock.id, room: joinedRoom, kind: data.kind, candidate: data.candidate });
  });
  sock.on("camera state", (data) => { // v23: host camera on/off — sab viewers ko batayein
    if (!data || typeof data !== "object") return;
    const roomId = typeof data.room === "string" ? data.room : "";
    if (!isHostOf(sock.id, roomId)) return;
    const on = data.on !== false;
    if (liveRooms[roomId]) liveRooms[roomId].cameraOn = on;
    io.to(roomId).emit("camera state", { room: roomId, on: on });
  });

  // ---- v20: Multi-guest seats — request / approve / reject / leave / kick ----
  sock.on("guest request", (data) => {
    if (!data || typeof data !== "object") return;
    const roomId = typeof data.room === "string" ? data.room : "";
    const name = cleanName(data.name) || (sock.data && sock.data.userName) || "Guest";
    const live = liveRooms[roomId];
    if (!live) return;
    if (live.multiGuest === false) { sock.emit("guest request failed", { room: roomId, reason: "off" }); return; } // v22
    if (socketRoom[sock.id] !== roomId) return;
    if (roomHiddenFor(name, live.host)) { sock.emit("guest request failed", { room: roomId, reason: "blocked" }); return; }
    if (isKickedFromRoom(roomId, name)) { sock.emit("guest request failed", { room: roomId, reason: "kicked" }); return; } // v34
    if (seatsFor(roomId).some((x) => x && x.guestId === sock.id)) return; // pehle se guest hai
    if (seatsFor(roomId).every(Boolean)) { sock.emit("guest request failed", { room: roomId, reason: "full" }); return; }
    const seatsNow = seatsFor(roomId);
    const wantSeat = parseInt(data.seat, 10);
    if (wantSeat >= 1 && wantSeat <= seatsNow.length) { // v36: seat par tap — khud-ba-khud seat (host ki approve nahi)
      if (seatsNow[wantSeat - 1]) { sock.emit("guest request failed", { room: roomId, reason: "taken" }); return; }
      guestSeq[roomId] = (guestSeq[roomId] || 0) + 1;
      seatsNow[wantSeat - 1] = { seat: wantSeat, guestId: sock.id, name: name, seq: guestSeq[roomId] };
      io.to(sock.id).emit("guest approved", { room: roomId, seat: wantSeat, hostId: live.hostId });
      broadcastSeats(roomId);
      emitChatToRoom(roomId, { room: roomId, name: "System", text: name + " sat on seat " + wantSeat });
      return;
    }
    io.to(live.hostId).emit("guest request", { room: roomId, guestId: sock.id, name: name, seat: 0 }); // button se request — host approve kare
  });

  sock.on("guest approve", (data) => {
    if (!data || typeof data !== "object") return;
    const roomId = typeof data.room === "string" ? data.room : "";
    const guestId = typeof data.guestId === "string" ? data.guestId : "";
    const name = cleanName(data.name) || "Guest";
    if (!isHostOf(sock.id, roomId)) return;
    if (socketRoom[guestId] !== roomId) return; // guest ab room mein nahi
    const seats = seatsFor(roomId);
    if (seats.some((x) => x && x.guestId === guestId)) return;
    const wantSeat = parseInt(data.seat, 10); // v32: host seat chune — khaali ho to wahi, warna pehli khaali
    const idx = (wantSeat >= 1 && wantSeat <= seats.length && !seats[wantSeat - 1]) ? wantSeat - 1 : seats.findIndex((x) => !x);
    if (idx === -1) { sock.emit("guest request failed", { room: roomId, reason: "full" }); return; }
    guestSeq[roomId] = (guestSeq[roomId] || 0) + 1;
    seats[idx] = { seat: idx + 1, guestId: guestId, name: name, seq: guestSeq[roomId] };
    io.to(guestId).emit("guest approved", { room: roomId, seat: idx + 1, hostId: sock.id });
    broadcastSeats(roomId);
  });

  sock.on("guest reject", (data) => {
    if (!data || typeof data !== "object") return;
    const roomId = typeof data.room === "string" ? data.room : "";
    const guestId = typeof data.guestId === "string" ? data.guestId : "";
    if (!isHostOf(sock.id, roomId)) return;
    io.to(guestId).emit("guest rejected", { room: roomId });
  });

  sock.on("guest leave", (data) => {
    if (!data || typeof data !== "object") return;
    const roomId = typeof data.room === "string" ? data.room : "";
    if (socketRoom[sock.id] !== roomId) return;
    freeGuestSeat(roomId, sock.id);
  });

  sock.on("guest kick", (data) => {
    if (!data || typeof data !== "object") return;
    const roomId = typeof data.room === "string" ? data.room : "";
    const guestId = typeof data.guestId === "string" ? data.guestId : "";
    if (!isHostOf(sock.id, roomId) && !isRoomAdmin(sock, roomId)) return; // v32: admin bhi kick kar sakta hai
    if (guestId === sock.id) return; // v36: khud ko kick nahi
    const seat = seatsFor(roomId).find((x) => x && x.guestId === guestId);
    if (freeGuestSeat(roomId, guestId)) { if (seat) kickFromRoom(roomId, seat.name); io.to(guestId).emit("guest removed", { room: roomId }); } // v34: kick = is live mein dobara nahi
  });

  // v32: Kick viewer — room se nikaale, block NA kare (block alag option hai)
  sock.on("kick viewer", (data) => {
    if (!data || typeof data !== "object") return;
    const roomId = typeof data.room === "string" ? data.room : "";
    const target = cleanName(data.target);
    if (!roomId || !target || !liveRooms[roomId]) return;
    if (!isHostOf(sock.id, roomId) && !isRoomAdmin(sock, roomId)) return;
    if (liveRooms[roomId].host.toLowerCase() === target.toLowerCase()) return; // host ko kick nahi
    if ((sock.data.userName || "").toLowerCase() === target.toLowerCase()) return; // v36: khud ko kick nahi
    kickFromRoom(roomId, target); // v34: is live mein dobara nahi aa sakta
    for (const [, x] of io.sockets.sockets) {
      const sName = (x.data && x.data.userName) || "";
      if (sName && sName.toLowerCase() === target.toLowerCase() && x.rooms.has(roomId)) {
        x.leave(roomId);
        if (socketRoom[x.id] === roomId) delete socketRoom[x.id];
        x.emit("you were kicked", { room: roomId, message: "The host removed you from this live." });
      }
    }
    sock.emit("viewer kicked", { room: roomId, target: target });
  });

  // v32: Host invite — viewer ko guest banne ki request bheje (seat ke saath)
  sock.on("guest invite", (data) => {
    if (!data || typeof data !== "object") return;
    const to = typeof data.to === "string" ? data.to : "";
    const seat = parseInt(data.seat, 10);
    if (!joinedRoom || !isHostOf(sock.id, joinedRoom) || !to) return;
    if (socketRoom[to] !== joinedRoom) return; // target room mein nahi
    if (!seat || seat < 1 || seat > seatCount(joinedRoom)) return;
    if (seatsFor(joinedRoom)[seat - 1]) return; // seat bhari hui
    io.to(to).emit("guest invite", { from: liveRooms[joinedRoom].host, room: joinedRoom, seat: seat });
  });
  sock.on("guest invite accept", (data) => {
    if (!data || typeof data !== "object") return;
    const roomId = typeof data.room === "string" ? data.room : "";
    const wantSeat = parseInt(data.seat, 10);
    if (!roomId || socketRoom[sock.id] !== roomId || !liveRooms[roomId]) return;
    const seats = seatsFor(roomId);
    if (seats.some((x) => x && x.guestId === sock.id)) return;
    const idx = (wantSeat >= 1 && wantSeat <= seats.length && !seats[wantSeat - 1]) ? wantSeat - 1 : seats.findIndex((x) => !x);
    if (idx === -1) { sock.emit("guest request failed", { room: roomId, reason: "full" }); return; }
    const name = cleanName((sock.data && sock.data.userName) || "") || "Guest";
    guestSeq[roomId] = (guestSeq[roomId] || 0) + 1;
    seats[idx] = { seat: idx + 1, guestId: sock.id, name: name, seq: guestSeq[roomId] };
    io.to(sock.id).emit("guest approved", { room: roomId, seat: idx + 1, hostId: liveRooms[roomId].hostId });
    broadcastSeats(roomId);
  });
  sock.on("guest invite decline", (data) => {
    if (!data || typeof data !== "object") return;
    const roomId = typeof data.room === "string" ? data.room : "";
    if (!roomId || socketRoom[sock.id] !== roomId || !liveRooms[roomId]) return;
    io.to(liveRooms[roomId].hostId).emit("guest invite declined", { room: roomId, name: (sock.data && sock.data.userName) || "Guest" });
  });

  // v32: Room admin — host kisi ko admin banaye / hataye
  sock.on("make admin", (data) => {
    if (!data || typeof data !== "object") return;
    const roomId = typeof data.room === "string" ? data.room : "";
    const target = cleanName(data.target);
    if (!roomId || !target || !liveRooms[roomId]) return;
    if (!isHostOf(sock.id, roomId)) return;
    if (liveRooms[roomId].host.toLowerCase() === target.toLowerCase()) return;
    liveRooms[roomId].admins = liveRooms[roomId].admins || [];
    if (!liveRooms[roomId].admins.some((a) => a.toLowerCase() === target.toLowerCase())) liveRooms[roomId].admins.push(target);
    io.to(roomId).emit("room admins", { room: roomId, admins: liveRooms[roomId].admins });
  });
  sock.on("remove admin", (data) => {
    if (!data || typeof data !== "object") return;
    const roomId = typeof data.room === "string" ? data.room : "";
    const target = cleanName(data.target);
    if (!roomId || !target || !liveRooms[roomId]) return;
    if (!isHostOf(sock.id, roomId)) return;
    liveRooms[roomId].admins = (liveRooms[roomId].admins || []).filter((a) => a.toLowerCase() !== target.toLowerCase());
    io.to(roomId).emit("room admins", { room: roomId, admins: liveRooms[roomId].admins });
  });

  // v31: Mute system — guest khud ko mute kare; host guest ko mute kare (guest khud unmute nahi kar sakta)
  sock.on("guest mute self", (data) => {
    if (!data || typeof data !== "object") return;
    if (!joinedRoom || !liveRooms[joinedRoom]) return;
    const seat = seatsFor(joinedRoom).find((x) => x && x.guestId === sock.id);
    if (!seat) return; // sirf seated guest
    seat.selfMuted = !!data.muted;
    broadcastSeats(joinedRoom);
  });
  sock.on("guest mute", (data) => {
    if (!data || typeof data !== "object") return;
    const guestId = typeof data.guestId === "string" ? data.guestId : "";
    if (!joinedRoom || (!isHostOf(sock.id, joinedRoom) && !isRoomAdmin(sock, joinedRoom)) || !guestId) return; // v32: admin bhi mute kar sakta hai
    if (guestId === sock.id) return; // v36: khud ko host-mute nahi (self-mute alag hai)
    const seat = seatsFor(joinedRoom).find((x) => x && x.guestId === guestId);
    if (!seat) return;
    seat.hostMuted = !!data.muted;
    broadcastSeats(joinedRoom);
    io.to(guestId).emit("guest mute", { room: joinedRoom, muted: seat.hostMuted });
  });

  // ---- v20: Guest media signalling — guest offer karta hai, host answer deta hai ----
  sock.on("guest offer", (data) => {
    if (!data || typeof data !== "object") return;
    const roomId = typeof data.room === "string" ? data.room : "";
    const to = typeof data.to === "string" ? data.to : "";
    const sdp = data.sdp && typeof data.sdp === "object" && typeof data.sdp.sdp === "string" ? data.sdp : null;
    if (!sdp || sdp.sdp.length > 20000) return;
    if (socketRoom[sock.id] !== roomId || socketRoom[to] !== roomId) return;
    // offer ya to guest ki taraf se host ko, ya host ki taraf se guest ko (renegotiation)
    const guestOk = seatsFor(roomId).some((x) => x && x.guestId === sock.id) && isHostOf(to, roomId);
    const hostOk = isHostOf(sock.id, roomId) && seatsFor(roomId).some((x) => x && x.guestId === to);
    if (!guestOk && !hostOk) return;
    io.to(to).emit("guest offer", { from: sock.id, room: roomId, sdp: sdp });
  });

  sock.on("guest answer", (data) => {
    if (!data || typeof data !== "object") return;
    const roomId = typeof data.room === "string" ? data.room : "";
    const to = typeof data.to === "string" ? data.to : "";
    const sdp = data.sdp && typeof data.sdp === "object" && typeof data.sdp.sdp === "string" ? data.sdp : null;
    if (!sdp || sdp.sdp.length > 20000) return;
    if (socketRoom[sock.id] !== roomId || socketRoom[to] !== roomId) return;
    const guestOk = seatsFor(roomId).some((x) => x && x.guestId === sock.id) && isHostOf(to, roomId);
    const hostOk = isHostOf(sock.id, roomId) && seatsFor(roomId).some((x) => x && x.guestId === to);
    if (!guestOk && !hostOk) return;
    io.to(to).emit("guest answer", { from: sock.id, room: roomId, sdp: sdp });
  });

  sock.on("guest ice", (data) => {
    if (!data || typeof data !== "object") return;
    const roomId = typeof data.room === "string" ? data.room : "";
    const to = typeof data.to === "string" ? data.to : "";
    if (!data.candidate || typeof data.candidate !== "object") return;
    if (socketRoom[sock.id] !== roomId || socketRoom[to] !== roomId) return;
    const ok = (isHostOf(sock.id, roomId) && seatsFor(roomId).some((x) => x && x.guestId === to)) ||
               (isHostOf(to, roomId) && seatsFor(roomId).some((x) => x && x.guestId === sock.id));
    if (!ok) return;
    io.to(to).emit("guest ice", { from: sock.id, room: roomId, candidate: data.candidate });
  });

  sock.on("watch", (data) => {
    if (!data || typeof data !== "object") return;
    const roomId = typeof data.room === "string" ? data.room : "";
    if (roomId !== joinedRoom || !liveRooms[roomId]) return;
    // v8: watcher ka naam bhi host ko bhejein — host apne live view mein
    // watcher ke naam ke saath Block button dekhega.
    const wname = cleanName(data.name) || (sock.data && sock.data.userName) || "";
    io.to(liveRooms[roomId].hostId).emit("watcher", { watcherId: sock.id, room: roomId, name: wname });
    if (wname && sock.data.welcomedRoom !== roomId) { // v32: Bigo jaisa entry welcome — sab ko dikhe
      sock.data.welcomedRoom = roomId;
      emitChatToRoom(roomId, { room: roomId, name: "System", text: "Welcome, " + wname + "!" });
    }
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
      freeGuestSeat(roomId, sock.id); // v20: guest tha to seat khaali karein
      if (liveRooms[roomId].hostId === sock.id) {
        endLiveRoom(roomId);
      } else if (joinedRoom === roomId) {
        io.to(liveRooms[roomId].hostId).emit("watcher left", { watcherId: sock.id, room: roomId });
        broadcastViewers(roomId); // v29: viewer disconnect — count update
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
