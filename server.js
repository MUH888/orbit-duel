const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");

const PORT = Number(process.env.PORT || 3001);
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, "public");
const DATA_DIR = path.join(ROOT, "data");
const HISTORY_FILE = path.join(DATA_DIR, "matches.json");

const rooms = new Map();
const timers = new Map();

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".ico": "image/x-icon",
};

function ensureDataFile() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(HISTORY_FILE)) fs.writeFileSync(HISTORY_FILE, "[]\n", "utf8");
}

function readHistory() {
  ensureDataFile();
  try {
    const parsed = JSON.parse(fs.readFileSync(HISTORY_FILE, "utf8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeHistory(history) {
  ensureDataFile();
  fs.writeFileSync(HISTORY_FILE, `${JSON.stringify(history.slice(-100), null, 2)}\n`, "utf8");
}

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
    "Cache-Control": "no-store",
  });
  res.end(payload);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > 1024 * 1024) {
        reject(new Error("Request body too large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error("Invalid JSON"));
      }
    });
    req.on("error", reject);
  });
}

function makeId() {
  return crypto.randomBytes(8).toString("hex");
}

function makeRoomCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  for (let attempt = 0; attempt < 30; attempt += 1) {
    let code = "";
    for (let i = 0; i < 4; i += 1) code += alphabet[Math.floor(Math.random() * alphabet.length)];
    if (!rooms.has(code)) return code;
  }
  return crypto.randomBytes(3).toString("hex").toUpperCase();
}

function cleanName(name) {
  return String(name || "").trim().slice(0, 24);
}

function defaultSettings() {
  return {
    roundCount: 20,
    difficulty: "normal",
    bonusPoints: 15,
  };
}

function normalizeSettings(input) {
  const settings = input || {};
  return {
    roundCount: clampInt(settings.roundCount, 10, 40, 20),
    difficulty: ["easy", "normal", "hard"].includes(settings.difficulty) ? settings.difficulty : "normal",
    bonusPoints: 15,
  };
}

function clampInt(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isInteger(number)) return fallback;
  return Math.max(min, Math.min(max, number));
}

function createRoom(hostName) {
  const hostId = makeId();
  const code = makeRoomCode();
  const room = {
    code,
    hostId,
    status: "lobby",
    createdAt: new Date().toISOString(),
    settings: defaultSettings(),
    players: [{ id: hostId, name: cleanName(hostName) || "Player 1", score: 0 }],
    roundIndex: 0,
    currentRound: null,
    rounds: [],
    submissions: [],
    winner: null,
    clients: new Set(),
  };
  rooms.set(code, room);
  return { room, playerId: hostId };
}

function playerName(room, playerId) {
  return room.players.find((player) => player.id === playerId)?.name || null;
}

function publicRoom(room, playerId) {
  const current = room.currentRound;
  const myTap = current?.taps.find((tap) => tap.playerId === playerId) || null;
  return {
    code: room.code,
    hostId: room.hostId,
    myPlayerId: playerId || null,
    isHost: playerId === room.hostId,
    status: room.status,
    settings: room.settings,
    players: room.players.map((player) => ({
      id: player.id,
      name: player.name,
      score: player.score,
    })),
    roundIndex: room.roundIndex,
    totalRounds: room.settings.roundCount,
    currentRound: current
      ? {
          id: current.id,
          stage: current.stage,
          startAt: current.startAt,
          activeAt: current.activeAt,
          endAt: current.endAt,
          speedDegPerSec: current.speedDegPerSec,
          direction: current.direction,
          startAngle: current.startAngle,
          targetAngle: current.targetAngle,
          targetWidth: current.targetWidth,
          resolved: current.resolved,
          myTap,
          taps: current.taps.map((tap) => ({
            playerId: tap.playerId,
            playerName: tap.playerName,
            points: tap.points,
            accuracy: tap.accuracy,
            bonus: tap.bonus,
            falseStart: tap.falseStart,
            deltaDeg: tap.deltaDeg,
          })),
        }
      : null,
    recentRounds: room.rounds.slice(-5).map(roundSummary),
    winner: room.winner,
  };
}

function roundSummary(round) {
  return {
    roundNumber: round.roundNumber,
    targetAngle: round.targetAngle,
    targetWidth: round.targetWidth,
    stage: round.stage,
    taps: round.taps.map((tap) => ({
      playerName: tap.playerName,
      points: tap.points,
      accuracy: tap.accuracy,
      bonus: tap.bonus,
      falseStart: tap.falseStart,
    })),
  };
}

function broadcast(room) {
  for (const client of Array.from(room.clients)) {
    sendEvent(client.res, "state", publicRoom(room, client.playerId));
  }
}

function sendEvent(res, event, data) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function startMatch(room, settings) {
  clearRoomTimer(room.code);
  room.settings = normalizeSettings(settings || room.settings);
  room.status = "playing";
  room.roundIndex = 0;
  room.rounds = [];
  room.submissions = [];
  room.winner = null;
  for (const player of room.players) player.score = 0;
  nextRound(room);
}

function nextRound(room) {
  clearRoomTimer(room.code);
  if (room.roundIndex >= room.settings.roundCount) {
    finishMatch(room);
    return;
  }

  room.roundIndex += 1;
  const round = generateRound(room.settings, room.roundIndex);
  room.currentRound = round;
  room.rounds.push(round);

  const timer = setTimeout(() => {
    const currentRoom = rooms.get(room.code);
    if (!currentRoom || currentRoom.status !== "playing") return;
    if (currentRoom.currentRound?.id !== round.id) return;
    resolveRound(currentRoom);
    broadcast(currentRoom);
  }, round.endAt - Date.now() + 100);
  timers.set(room.code, timer);
}

function generateRound(settings, roundIndex) {
  const stage = Math.min(4, Math.ceil(roundIndex / 5));
  const profile = difficultyProfile(settings.difficulty, stage);
  const now = Date.now();
  const activeDelay = 1500 + Math.floor(Math.random() * 900);
  const rotations = profile.rotations;
  const orbitMs = Math.round((360 * rotations * 1000) / profile.speedDegPerSec);
  return {
    id: `${now}-${roundIndex}-${Math.random().toString(16).slice(2)}`,
    roundNumber: roundIndex,
    stage,
    startAt: now,
    activeAt: now + activeDelay,
    endAt: now + activeDelay + orbitMs,
    speedDegPerSec: profile.speedDegPerSec,
    direction: profile.direction,
    startAngle: randomAngle(),
    targetAngle: randomAngle(),
    targetWidth: profile.targetWidth,
    resolved: false,
    taps: [],
  };
}

function difficultyProfile(difficulty, stage) {
  const base = {
    easy: [
      { speed: 105, width: 54 },
      { speed: 125, width: 48 },
      { speed: 145, width: 42 },
      { speed: 165, width: 36 },
    ],
    normal: [
      { speed: 135, width: 46 },
      { speed: 165, width: 38 },
      { speed: 195, width: 32 },
      { speed: 230, width: 26 },
    ],
    hard: [
      { speed: 165, width: 38 },
      { speed: 205, width: 30 },
      { speed: 250, width: 24 },
      { speed: 295, width: 18 },
    ],
  }[difficulty] || [];
  const profile = base[stage - 1] || base[base.length - 1];
  const direction = stage === 4 && Math.random() < 0.45 ? -1 : 1;
  return {
    speedDegPerSec: profile.speed,
    targetWidth: profile.width,
    direction,
    rotations: stage >= 3 ? 1.35 : 1.15,
  };
}

function randomAngle() {
  return Math.floor(Math.random() * 360);
}

function submitTap(room, playerId, clientTapAt) {
  if (room.status !== "playing" || !room.currentRound) throw httpError(409, "No active round");
  const player = room.players.find((item) => item.id === playerId);
  if (!player) throw httpError(403, "Player is not in this room");
  const round = room.currentRound;
  if (round.resolved) throw httpError(409, "Round already finished");
  if (round.taps.some((tap) => tap.playerId === playerId)) throw httpError(409, "You already tapped this round");

  const receivedAt = Date.now();
  const scored = scoreTap(round, receivedAt);
  const tap = {
    playerId,
    playerName: player.name,
    receivedAt,
    clientTapAt: Number(clientTapAt) || null,
    points: scored.points,
    basePoints: scored.points,
    accuracy: scored.accuracy,
    deltaDeg: scored.deltaDeg,
    dotAngle: scored.dotAngle,
    falseStart: scored.falseStart,
    bonus: 0,
  };
  round.taps.push(tap);
  room.submissions.push({ roundId: round.id, roundNumber: round.roundNumber, ...tap });

  if (round.taps.length >= room.players.length) {
    resolveRound(room);
  }
}

function scoreTap(round, tapAt) {
  if (tapAt < round.activeAt) {
    return {
      points: -25,
      accuracy: 0,
      deltaDeg: null,
      dotAngle: round.startAngle,
      falseStart: true,
    };
  }
  if (tapAt > round.endAt) {
    return {
      points: 0,
      accuracy: 0,
      deltaDeg: 180,
      dotAngle: angleAt(round, round.endAt),
      falseStart: false,
    };
  }

  const dotAngle = angleAt(round, tapAt);
  const deltaDeg = angleDistance(dotAngle, round.targetAngle);
  const halfWidth = round.targetWidth / 2;
  let points = 0;
  if (deltaDeg <= halfWidth) {
    const closeness = 1 - deltaDeg / Math.max(1, halfWidth);
    points = Math.round(60 + closeness * 40);
  } else if (deltaDeg <= halfWidth + 42) {
    const closeness = 1 - (deltaDeg - halfWidth) / 42;
    points = Math.round(Math.max(10, closeness * 59));
  }
  return {
    points,
    accuracy: Math.max(0, Math.round((1 - deltaDeg / 180) * 100)),
    deltaDeg: Math.round(deltaDeg * 10) / 10,
    dotAngle: Math.round(dotAngle * 10) / 10,
    falseStart: false,
  };
}

function angleAt(round, at) {
  const elapsed = Math.max(0, at - round.activeAt) / 1000;
  const angle = round.startAngle + round.direction * round.speedDegPerSec * elapsed;
  return normalizeAngle(angle);
}

function normalizeAngle(angle) {
  return ((angle % 360) + 360) % 360;
}

function angleDistance(a, b) {
  const diff = Math.abs(normalizeAngle(a) - normalizeAngle(b));
  return Math.min(diff, 360 - diff);
}

function resolveRound(room) {
  const round = room.currentRound;
  if (!round || round.resolved) return;
  round.resolved = true;

  const validTaps = round.taps.filter((tap) => !tap.falseStart && tap.points > 0);
  if (validTaps.length > 1) {
    validTaps.sort((a, b) => a.deltaDeg - b.deltaDeg);
    if (validTaps[0].deltaDeg < validTaps[1].deltaDeg) {
      validTaps[0].bonus = room.settings.bonusPoints;
      validTaps[0].points += room.settings.bonusPoints;
    }
  }

  for (const tap of round.taps) {
    const player = room.players.find((item) => item.id === tap.playerId);
    if (player) player.score += tap.points;
  }

  if (room.roundIndex >= room.settings.roundCount) {
    finishMatch(room);
    return;
  }

  clearRoomTimer(room.code);
  const timer = setTimeout(() => {
    const currentRoom = rooms.get(room.code);
    if (!currentRoom || currentRoom.status !== "playing") return;
    if (currentRoom.currentRound?.id !== round.id) return;
    nextRound(currentRoom);
    broadcast(currentRoom);
  }, 1450);
  timers.set(room.code, timer);
}

function finishMatch(room) {
  clearRoomTimer(room.code);
  room.status = "finished";
  room.currentRound = null;
  const sorted = [...room.players].sort((a, b) => b.score - a.score);
  const high = sorted[0]?.score || 0;
  const winners = sorted.filter((player) => player.score === high);
  const bestTap = room.submissions
    .filter((tap) => !tap.falseStart)
    .sort((a, b) => (b.accuracy || 0) - (a.accuracy || 0))[0] || null;
  room.winner = winners.length === 1
    ? { type: "winner", playerId: winners[0].id, name: winners[0].name, score: winners[0].score }
    : { type: "tie", name: "Tie game", score: high };
  room.winner.bestTap = bestTap
    ? { playerName: bestTap.playerName, accuracy: bestTap.accuracy, roundNumber: bestTap.roundNumber }
    : null;
  saveMatch(room);
}

function saveMatch(room) {
  const history = readHistory();
  history.push({
    id: makeId(),
    roomCode: room.code,
    startedAt: room.createdAt,
    finishedAt: new Date().toISOString(),
    players: room.players.map(({ id, name, score }) => ({ id, name, score })),
    settings: room.settings,
    rounds: room.rounds.map(roundSummary),
    submissions: room.submissions,
    winner: room.winner,
  });
  writeHistory(history);
}

function clearRoomTimer(code) {
  const timer = timers.get(code);
  if (timer) clearTimeout(timer);
  timers.delete(code);
}

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function requireRoom(code) {
  const room = rooms.get(String(code || "").toUpperCase());
  if (!room) throw httpError(404, "Room not found");
  return room;
}

function requireHost(room, playerId) {
  if (room.hostId !== playerId) throw httpError(403, "Only the host can do that");
}

async function handleApi(req, res, url) {
  try {
    if (req.method === "GET" && url.pathname === "/api/history") {
      return json(res, 200, { history: readHistory().slice(-20).reverse() });
    }

    if (req.method === "POST" && url.pathname === "/api/rooms") {
      const body = await readJson(req);
      const { room, playerId } = createRoom(body.name);
      broadcast(room);
      return json(res, 200, { code: room.code, playerId, state: publicRoom(room, playerId) });
    }

    const match = url.pathname.match(/^\/api\/rooms\/([^/]+)\/(join|settings|start|tap)$/);
    if (!match) return json(res, 404, { error: "API route not found" });

    const room = requireRoom(match[1]);
    const action = match[2];
    const body = await readJson(req);
    const playerId = body.playerId;

    if (action === "join") {
      if (room.players.length >= 2 && !room.players.some((player) => player.id === playerId)) {
        throw httpError(409, "This room already has two players");
      }
      let id = playerId;
      let player = room.players.find((item) => item.id === id);
      if (!player) {
        id = makeId();
        player = { id, name: cleanName(body.name) || `Player ${room.players.length + 1}`, score: 0 };
        room.players.push(player);
      } else if (body.name) {
        player.name = cleanName(body.name);
      }
      broadcast(room);
      return json(res, 200, { code: room.code, playerId: id, state: publicRoom(room, id) });
    }

    if (action === "settings") {
      requireHost(room, playerId);
      if (room.status !== "lobby" && room.status !== "finished") {
        throw httpError(409, "Settings can only change before a match starts");
      }
      room.settings = normalizeSettings(body.settings || {});
      broadcast(room);
      return json(res, 200, { state: publicRoom(room, playerId) });
    }

    if (action === "start") {
      requireHost(room, playerId);
      if (room.players.length !== 2) throw httpError(409, "Two players are needed to start");
      startMatch(room, body.settings);
      broadcast(room);
      return json(res, 200, { state: publicRoom(room, playerId) });
    }

    if (action === "tap") {
      submitTap(room, playerId, body.clientTapAt);
      broadcast(room);
      return json(res, 200, { state: publicRoom(room, playerId) });
    }

    return json(res, 404, { error: "API route not found" });
  } catch (error) {
    return json(res, error.status || 500, { error: error.message || "Server error" });
  }
}

function handleEvents(req, res, url) {
  const code = String(url.searchParams.get("room") || "").toUpperCase();
  const playerId = url.searchParams.get("player") || "";
  const room = rooms.get(code);
  if (!room) {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Room not found");
    return;
  }

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-store",
    Connection: "keep-alive",
    "Access-Control-Allow-Origin": "*",
  });
  const client = { res, playerId };
  room.clients.add(client);
  sendEvent(res, "state", publicRoom(room, playerId));
  const ping = setInterval(() => sendEvent(res, "ping", { at: Date.now() }), 15000);
  req.on("close", () => {
    clearInterval(ping);
    room.clients.delete(client);
  });
}

function serveStatic(req, res, url) {
  let pathname = decodeURIComponent(url.pathname);
  if (pathname === "/") pathname = "/index.html";
  const filePath = path.normalize(path.join(PUBLIC_DIR, pathname));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }
  fs.readFile(filePath, (error, content) => {
    if (error) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Not found");
      return;
    }
    res.writeHead(200, {
      "Content-Type": mimeTypes[path.extname(filePath)] || "application/octet-stream",
      "Cache-Control": "no-store",
    });
    res.end(content);
  });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname === "/events") return handleEvents(req, res, url);
  if (url.pathname.startsWith("/api/")) return handleApi(req, res, url);
  return serveStatic(req, res, url);
});

ensureDataFile();
server.listen(PORT, "0.0.0.0", () => {
  console.log(`Orbit Duel running at http://localhost:${PORT}`);
  for (const address of getLocalAddresses()) {
    console.log(`Phone URL: http://${address}:${PORT}`);
  }
});

function getLocalAddresses() {
  const nets = os.networkInterfaces();
  const results = [];
  for (const entries of Object.values(nets)) {
    for (const entry of entries || []) {
      if (entry.family === "IPv4" && !entry.internal) results.push(entry.address);
    }
  }
  return results;
}
