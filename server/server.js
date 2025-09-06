// server.js — Interviewer Mode + rooms list + private rooms (passcodes) + safety guards (hardened) + progressive reveal
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");
const crypto = require("crypto");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*", // tighten in prod
    methods: ["GET", "POST"]
  }
});

app.use(express.static(path.join(__dirname, "public")));

// ---------- config / guards ----------
const MAX_ROOMS = 200;
const MAX_PLAYERS_PER_ROOM = 12;
const MAX_NAME_LEN = 24;
const CHAT_COOLDOWN_MS = 1200;
const CREATE_JOIN_COOLDOWN_MS = 1500;
const ACTION_COOLDOWN_MS = 250; // generic small guard
const ROOM_IDLE_MS = 45 * 60 * 1000; // 45 min since last activity
const ROOM_LIST_LIMIT = 50;

const rooms = new Map(); // Map<roomCode, RoomState>
const lastActionAt = new Map(); // Map<socketId, number>
const lastChatAt = new Map(); // Map<socketId, number>
const lastCreateJoinAt = new Map(); // Map<socketId, number>

function now() { return Date.now(); }
function tooSoon(map, id, cooldown) {
  const t = map.get(id) || 0;
  if (now() - t < cooldown) return true;
  map.set(id, now());
  return false;
}
function touchRoom(R) { R.lastActivityAt = now(); }
function esc(s) { return String(s).replace(/[<>]/g, m => (m === "<" ? "&lt;" : "&gt;")).replace(/[\x00-\x1F]/g, ""); }
function hashPass(s) { return crypto.createHash("sha256").update(String(s)).digest("hex"); }

// ---------- utils ----------
function makeCode() {
  const letters = "ABCDEFGHJKLMNPQRSTUVWXYZ";
  let c = "";
  for (let i = 0; i < 4; i++) c += letters[Math.floor(Math.random() * letters.length)];
  return rooms.has(c) ? makeCode() : c;
}
const shuffle = (arr) => arr.sort(() => Math.random() - 0.5);

function baseJobs() {
  return shuffle([
    "Firefighter",
    "Author",
    "Chef",
    "Teacher",
    "Game Designer",
    "Comedian",
    "Pilot",
    "Barista",
    "Astronaut",
    "Zookeeper",
    "Professional Gamer",
    "AI Ethics Officer",
    "Cat Cafe Manager",
    "Middleschool Principal",
    "Lifeguard",
    "Wedding Planner",
    "Food Truck Chef", 
    // new ones
    "Fortune Cookie Writer",
    "Pornstar",
    "Doctor",
    "Baker",
    "Pastry Chef",
    "Rat Exterminator",
    "Plumber",
    "The President",
    "Governor of California",
    "Children's Book Author",
    "Smiling Friend",
    "Therapist",
    "Molecular Biologist",
    "Discord Mod"
  ]);
}

function baseTraits() {
  return shuffle([
    "Blue",
    "Goon Lord",
    "5’9",
    "Fat",
    "Reads 12 words per minute",
    "Redditor",
    "Momma’s boy",
    "Pirate",
    "Liberal",
    "63mm Pupillary Distance",
    "Cross-Eyed",
    "Really good at Mario Kart",

    "Talks about their Funko Pop Collection",
    "Takes Pride in their Feet Fetish",
    "Won 8th grade Spelling Bee",
    "Doesn’t shut up about Undertale",
    "Helped their friend move one time",
    "Collects Rocks",
    "Has a tick every 5 seconds making them go “cakooo”",
    "Fakes deep voice",
    "Has a shiny bald head",
    "Talks like moist critical",
    "2nd loser in Mr.Beast’s “Last to take their hand off the Lamborghini” Challenge",
    "Excel & Word certified",
    "Has an associates degree",
    "Is the Boy with Striped Pajamas",
    "Licensed to chill",
    "Roger from American Dad",
    "Catered Rebecca Sugar’s Wedding",
    "Has an original Steven Universe Crystal Gem OC",
    "Good at math",
    "If they were green they would die",
    "Lois Griffin",
    "Extremely Ripped",
    "Uncontrollable Gas",
    "6’3",
    "Feminist",
    "Liberal",
    "Extremely Politically Correct",
    "Fastest kid in their 5th grade class",
    "Major in Psychology",
    "4.0 GPA in Middle School",
    "Really loves Sonic The Hedgehog",
    "Blunt",
    "Always holding in a sneeze",
    "Extremely strong grip",
    "Reads Feminist Literature",
    // keep a few wholesome ones in the mix
    "Brings snacks",
    "Certified plant whisperer",
    "Gives immaculate high-fives",
    "Parallel parks like a video game speedrun",
    "Can assemble IKEA without a single spare piece",
    "Makes playlists for every mood",
    "Is flexible",
    "Is in a toxic relationship with their stepdad",
    "Can only speak in questions",
    "Is 4 years old",
    "Only fucks with BBWS",
    "Fat Bitch Pussy Connossieur",
    "'Does someone smell that?' (hitting the stanky leg)",
    "Advocate for Chinese feet binding in 2025",
    "Supports Eugenics",
    "Jolly Funny Looking Gummy Bear",
    "Plays League competitively",
    "Was Emperor Mao Zedong's Last Dancer",
    "Certified Munch",
    "Slimy",
    "Acts if 9/11 JUST happened",
    "Bred Gorillas for 4 years",
    "Just found out Steve Irwin died",
    "Is convinced Doja Cat is their wife",
    "Is handicapped but they roll around in a doggy wheelchair",
    "Talks like Ben Shapiro",
    "Anti-Vax",
    "Is in the middle of e-sexing their online partner",
    "Is currently in an intense text argument with their toxic boyfriend",
    "Just found out their grandmother died",
    "Really good at Go Fish",
    "Has a 2 inch penis but knows how to use it",
    "Has huge boobs but no ass",
    "Knows how to change oil in a car",
    "Unclogs pipes",
    "Ran a loom business elementary school",
    "A little Racist"

    
  ]);
}

function baseTwists() {
  return shuffle([
    "Emotionally Unavailable",
    "Registered Sex Offender",
    "Major in Business",
    "Schizophrenic",
    "Watched every single Game Theory FNAF Lore Video",
    "Secretly just farted right now",
    "Has Nightvision",
    "Can only count up to 10",
    "Extremely overweight",
    "Traumatic Childhood",
    "Has watched every single Pewdiepie video ever",
    "Uncontrollable bladder",
    "Can smell your fears",
    "Is secretly Indian",
    "Doesn’t wash their hands after using the restroom",
    "Severely addicted to crack",
    "Methamphetamine",
    "Is a Bronie",
    "5’2",
    "Has a Sonic OC",
    "63 years old",
    "Obsessive Compulsive Disorder",
    "Holding in a fart right now",
    "Thinks Fanboy and ChumChum is better than The Amazing World of Gumball",
    "Must rhyme while talking",
    "Physically Violent",
    "is a groomer",
    "Has a foot fetish",
    "Nose grows longer when they lie",
    "Cant stop applying chapstick",
    "Really Sweaty like REALLY Sweaty",
    "Has a picture of Nicki Minaj in their wallet",
    "Is really bad at Fortnite",
    "Is actually a dog",
    "Just found out about the Holocaust",
    "Is handicapped",
    "Swag",
    "Really Loves Game Theory",
    "Sleeper activation code 'Garfield' makes them act like a cat",
    "Part-time Neko Girl",
    "Very Racist",
    "Orthodox Catholic",
     "Streams on Twitch but only gets 3 viewers",
     "Believes the earth is flat"

    
    
    
    
  ]);
}

// ---------- emits ----------
function emitLobby(code) {
  const R = rooms.get(code);
  if (!R) return; // room gone
  const players = R.players || {};
  io.to(code).emit("lobbyState", {
    players: Object.fromEntries(
      Object.entries(players).map(([id, p]) => [
        id,
        { name: p?.name ?? "—", isHost: id === R.hostId, score: p?.score ?? 0 },
      ])
    ),
  });
}

function emitGameState(code, toId = null) {
  const R = rooms.get(code);
  if (!R) return;

  const players = R.players || {};
  const submissions = R.submissions || {};
  const revealed = R.revealed || {};
  const twistsAssigned = R.twistsAssigned || {};
  const jobOptions = R.jobOptions || [];
  const twistBank = Array.isArray(R.twistBank) ? R.twistBank : [];

  // Public submissions show ONLY revealed traits
  const pubSubmissions = Object.fromEntries(
    Object.entries(submissions).map(([pid, s]) => {
      const revealedForPid = revealed[pid] || [];
      return [pid, {
        id: pid,
        name: players[pid]?.name || "Left",
        traits: revealedForPid,
        twist: twistsAssigned[pid] || null,
        winner: !!s.winner,
      }];
    })
  );

  // Per-stage convenience flags so client can toggle UI instantly
  const curId = R.currentCandidateId || null;
  const curRevealedCount = curId ? (revealed[curId] || []).length : 0;
  const curTwist = curId ? (twistsAssigned[curId] || null) : null;
  const canAssignTwist = (R.phase === "reveal") && !!curId && curRevealedCount === 3 && !curTwist;
  const canEndTurn = (R.phase === "reveal") && !!curId && !!curTwist;

  const pub = {
    // phases: lobby | chooseJob | chooseTraits | reveal | judge
    phase: R.phase,
    round: R.round,
    interviewerId: R.interviewerId,
    interviewerName: players[R.interviewerId]?.name || "—",
    currentJob: R.currentJob,
    submissions: pubSubmissions,
    players: Object.fromEntries(
      Object.entries(players).map(([id, p]) => [id, { name: p?.name ?? "—", score: p?.score ?? 0 }])
    ),
    // spotlight fields for progressive reveal
    currentCandidateId: curId,
    currentCandidateTwist: curTwist, // ensure stage can show twist immediately
    canAssignTwist,
    canEndTurn,
    revealed,
  };

  const send = (id) => {
    const isInterviewer = id === R.interviewerId;
    const me = players[id];
    const isCurrent = id === curId;

    io.to(id).emit("gameState", {
      ...pub,
      myId: id,
      isInterviewer,
      jobOptions: (isInterviewer && R.phase === "chooseJob") ? jobOptions : undefined,
      // Hide the twist bank from interviewer as soon as the current candidate has a twist (or empty)
      twistBank: (isInterviewer && R.phase === "reveal" && !curTwist && twistBank.length > 0) ? twistBank : undefined,
      hand: (R.phase === "chooseTraits" && !isInterviewer) ? (me?.hand || []) : [],
      // Give the on-stage candidate their full locked traits to choose reveal order
      myAllTraits: (isCurrent ? (submissions[id]?.traits || []) : undefined),
      submitted: !!submissions[id],
    });
  };

  if (toId) send(toId);
  else Object.keys(players).forEach(send);
}

// ---------- round prep ----------
function prepareRound(R) {
  const ids = Object.keys(R.players);
  if (ids.length === 0) return;

  // seating/order (join order)
  R._order = ids.slice();

  // rotate interviewer
  if (R.interviewerIndex == null) R.interviewerIndex = 0;
  R.interviewerId = R._order[R.interviewerIndex % R._order.length];

  R.phase = "chooseJob";
  R.round = (R.round || 0) + 1;
  R.submissions = {};
  R.twistsAssigned = {};
  R.currentJob = null;

  // progressive reveal state
  R.stageOrder = [];      // array of candidate ids (excludes interviewer)
  R.stageIndex = 0;       // index into stageOrder
  R.currentCandidateId = null;
  R.revealed = {};        // { [pid]: [revealedTrait, ...] }

  // build decks
  R.deck = {
    jobs: baseJobs(),
    traits: baseTraits(),
    twists: baseTwists(),
  };

  // interviewer sees 5 job options
  R.jobOptions = [];
  for (let i = 0; i < 5 && R.deck.jobs.length; i++) R.jobOptions.push(R.deck.jobs.pop());

  // twist bank: guarantee one per candidate (refill twists deck if needed)
  const candidates = ids.filter((id) => id !== R.interviewerId);
  R.twistBank = [];
  while (R.twistBank.length < candidates.length) {
    if (R.deck.twists.length === 0) R.deck.twists = baseTwists();
    R.twistBank.push(R.deck.twists.pop());
  }

  // deal 6 traits to each candidate (interviewer gets none)
  ids.forEach((id) => {
    if (id === R.interviewerId) {
      R.players[id].hand = [];
    } else {
      const hand = [];
      for (let i = 0; i < 6; i++) {
        if (R.deck.traits.length === 0) R.deck.traits = baseTraits();
        hand.push(R.deck.traits.pop());
      }
      R.players[id].hand = hand;
    }
  });

  touchRoom(R);
}

// ---------- room directory ----------
function getRoomList() {
  const list = [];
  for (const [code, R] of rooms.entries()) {
    if (R.isPrivate) continue;
    list.push({
      code,
      players: Object.keys(R.players).length,
      phase: R.phase || "lobby",
      round: R.round || 0,
      createdAt: R.createdAt,
    });
  }
  return list.sort((a, b) => b.createdAt - a.createdAt).slice(0, ROOM_LIST_LIMIT);
}
function broadcastRoomList() {
  io.emit("roomList", getRoomList());
}

// ---------- cleanup ----------
setInterval(() => {
  const t = now();
  for (const [code, R] of rooms.entries()) {
    const empty = Object.keys(R.players).length === 0;
    const idle = (t - (R.lastActivityAt || R.createdAt)) > ROOM_IDLE_MS;
    if (empty || idle) {
      rooms.delete(code);
    }
  }
  broadcastRoomList();
}, 60 * 1000);

// ---------- sockets ----------
io.on("connection", (socket) => {
  socket.data.name = `Player-${socket.id.slice(0, 4)}`;
  // send initial room list so lobby has content immediately
  socket.emit("roomList", getRoomList());

  function leaveOtherGameRooms() {
    for (const r of socket.rooms) {
      if (rooms.has(r)) socket.leave(r);
    }
  }
  function getMyRoom() {
    return [...socket.rooms].find((r) => rooms.has(r));
  }

  socket.on("setName", (name) => {
    if (tooSoon(lastActionAt, socket.id, ACTION_COOLDOWN_MS)) return;
    const clean = esc(String(name ?? "").trim().slice(0, MAX_NAME_LEN));
    if (clean) socket.data.name = clean;
  });

  // create room
  socket.on("createRoom", (payload = {}) => {
    if (tooSoon(lastCreateJoinAt, socket.id, CREATE_JOIN_COOLDOWN_MS)) {
      socket.emit("createError", "Slow down a bit before creating again.");
      return;
    }
    if (rooms.size >= MAX_ROOMS) {
      socket.emit("createError", "Room capacity reached. Try again later.");
      return;
    }

    const isPrivate = !!payload.isPrivate;
    const passRaw = String(payload.passcode || "").trim();

    if (isPrivate && passRaw.length < 2) {
      socket.emit("createError", "Private rooms need a passcode (min 2 chars).");
      return;
    }

    leaveOtherGameRooms();

    const room = makeCode();
    const passHash = isPrivate ? hashPass(passRaw) : null;

    const R = {
      hostId: socket.id,
      players: { [socket.id]: { name: socket.data.name, hand: [], score: 0 } },
      isPrivate,
      passHash,
      createdAt: now(),
      lastActivityAt: now(),
      // game state
      phase: "lobby",
      round: 0,
      _order: null,
      interviewerIndex: null,
      interviewerId: null,
      submissions: {},
      twistsAssigned: {},
      jobOptions: [],
      twistBank: [],
      currentJob: null,
      deck: { jobs: [], traits: [], twists: [] },

      // progressive reveal fields initial (not used in lobby)
      stageOrder: [],
      stageIndex: 0,
      currentCandidateId: null,
      revealed: {},
    };

    rooms.set(room, R);
    socket.join(room);
    socket.emit("roomCreated", { room });
    emitLobby(room);
    broadcastRoomList();
  });

  // join room
  socket.on("joinRoom", (payload) => {
    if (tooSoon(lastCreateJoinAt, socket.id, CREATE_JOIN_COOLDOWN_MS)) {
      socket.emit("joinError", "Slow down a bit before joining again.");
      return;
    }
    const roomCode = esc(String((payload?.room || "")).toUpperCase());
    const passRaw = String(payload?.passcode || "").trim();

    const R = rooms.get(roomCode);
    if (!R) return socket.emit("joinError", "Room not found.");
    if (R.isPrivate) {
      const ok = hashPass(passRaw) === R.passHash;
      if (!ok) return socket.emit("joinError", "Wrong passcode.");
    }
    if (R.phase !== "lobby") return socket.emit("joinError", "That game already started.");
    if (Object.keys(R.players).length >= MAX_PLAYERS_PER_ROOM) {
      return socket.emit("joinError", "Room is full.");
    }

    leaveOtherGameRooms();

    R.players[socket.id] = { name: socket.data.name, hand: [], score: 0 };
    R._order = Object.keys(R.players);
    touchRoom(R);

    socket.join(roomCode);
    socket.emit("joined", { room: roomCode, isHost: socket.id === R.hostId });
    emitLobby(roomCode);
    broadcastRoomList();
  });

  // list rooms
  socket.on("listRooms", () => {
    if (tooSoon(lastActionAt, socket.id, ACTION_COOLDOWN_MS)) return;
    socket.emit("roomList", getRoomList());
  });

  // start game (host only)
  socket.on("startGame", () => {
    if (tooSoon(lastActionAt, socket.id, ACTION_COOLDOWN_MS)) return;
    const room = getMyRoom();
    const R = rooms.get(room);
    if (!R || R.hostId !== socket.id) return;
    if (R.phase !== "lobby") return;
    if (Object.keys(R.players).length < 2) {
      socket.emit("createError", "Need at least 2 players to start.");
      return;
    }
    R.interviewerIndex = 0;
    R._order = Object.keys(R.players);
    prepareRound(R);
    io.to(room).emit("chat", { name: "SYSTEM", msg: `Round ${R.round} – Interviewer: ${R.players[R.interviewerId].name}` });
    emitGameState(room);
    broadcastRoomList();
  });

  // interviewer chooses job
  socket.on("pickJob", (job) => {
    if (tooSoon(lastActionAt, socket.id, ACTION_COOLDOWN_MS)) return;
    const room = getMyRoom();
    const R = rooms.get(room);
    if (!R || socket.id !== R.interviewerId || R.phase !== "chooseJob") return;
    if (typeof job !== "string" || !R.jobOptions.includes(job)) return;
    R.currentJob = job;
    R.phase = "chooseTraits";
    // prevent double-pick shenanigans
    R.jobOptions = [];
    touchRoom(R);
    emitGameState(room);
  });

  // candidate submits 3 traits (locked, still hidden from others)
  socket.on("submitTraits", (picks) => {
    if (tooSoon(lastActionAt, socket.id, ACTION_COOLDOWN_MS)) return;
    const room = getMyRoom();
    const R = rooms.get(room);
    if (!R || R.phase !== "chooseTraits") return;
    if (socket.id === R.interviewerId) return; // interviewer doesn't submit

    if (!Array.isArray(picks) || picks.length !== 3) return;
    const unique = new Set(picks);
    if (unique.size !== 3) return;
    if (!picks.every((t) => typeof t === "string")) return;

    const hand = R.players[socket.id]?.hand || [];
    if (!picks.every((t) => hand.includes(t))) return;

    // remove from hand to lock
    R.players[socket.id].hand = hand.filter((c) => !picks.includes(c));
    R.submissions[socket.id] = { traits: picks, winner: false };

    // when all candidates submit, move on to REVEAL (spotlight) phase
    const candidates = Object.keys(R.players).filter((id) => id !== R.interviewerId);
    const allIn = candidates.every((id) => !!R.submissions[id]);
    if (candidates.length >= 1 && allIn) {
      R.stageOrder = candidates.slice(); // or shuffle(candidates.slice()) to randomize
      R.stageIndex = 0;
      R.currentCandidateId = R.stageOrder[0] || null;
      R.revealed = {};
      R.phase = "reveal";
    }
    touchRoom(R);
    emitGameState(room);
  });

  // progressive reveal: on-stage candidate reveals one of their locked traits
  socket.on("revealTrait", (trait) => {
    if (tooSoon(lastActionAt, socket.id, ACTION_COOLDOWN_MS)) return;
    const room = getMyRoom();
    const R = rooms.get(room);
    if (!R || R.phase !== "reveal") return;

    const pid = socket.id;
    if (pid !== R.currentCandidateId) return; // only current candidate can reveal

    const sub = R.submissions[pid];
    if (!sub) return;
    if (typeof trait !== "string") return;

    const myTraits = sub.traits || [];
    if (!myTraits.includes(trait)) return; // must be one of the locked 3

    const already = R.revealed[pid] || (R.revealed[pid] = []);
    if (already.includes(trait)) return;   // cannot reveal same trait twice
    if (already.length >= 3) return;       // already fully revealed

    already.push(trait);
    touchRoom(R);
    emitGameState(room);
  });

  // interviewer assigns one twist — in reveal phase, only to current candidate and only after 3 reveals
  socket.on("assignTwist", ({ targetId, twist } = {}) => {
    if (tooSoon(lastActionAt, socket.id, ACTION_COOLDOWN_MS)) return;
    const room = getMyRoom();
    const R = rooms.get(room);
    if (!R || socket.id !== R.interviewerId) return;

    const isReveal = R.phase === "reveal";
    const isLegacyAssign = R.phase === "assignTwists"; // backwards-compat safety

    if (!isReveal && !isLegacyAssign) return; // only allowed in reveal (or legacy mode)

    if (typeof targetId !== "string" || typeof twist !== "string") return;
    if (!R.submissions[targetId]) return;
    if (!R.twistBank.includes(twist)) return;

    // One twist per person
    if (R.twistsAssigned[targetId]) return;

    if (isReveal) {
      // in progressive reveal, ensure target is current candidate and has fully revealed
      if (targetId !== R.currentCandidateId) return;
      const rev = (R.revealed[targetId] || []);
      if (rev.length !== 3) return; // require all 3 traits revealed first
    }

    R.twistsAssigned[targetId] = twist;
    // remove chosen twist from bank so it can't be reused
    R.twistBank = R.twistBank.filter((t) => t !== twist);

    // legacy path: if all twisted, go to judge
    if (!isReveal) {
      const candidates = Object.keys(R.submissions);
      const allTwisted = candidates.every((id) => !!R.twistsAssigned[id]);
      if (candidates.length && allTwisted) R.phase = "judge";
    }

    touchRoom(R);
    emitGameState(room);
  });

  // interviewer ends the current candidate's turn (only after twist assigned)
  socket.on("endTurn", () => {
    if (tooSoon(lastActionAt, socket.id, ACTION_COOLDOWN_MS)) return;
    const room = getMyRoom();
    const R = rooms.get(room);
    if (!R || R.phase !== "reveal") return;
    if (socket.id !== R.interviewerId) return;

    const pid = R.currentCandidateId;
    if (!pid) return;
    if (!R.twistsAssigned[pid]) return; // must assign twist before ending turn

    R.stageIndex++;
    if (R.stageIndex >= R.stageOrder.length) {
      // all candidates done — move to judge
      R.phase = "judge";
      R.currentCandidateId = null;
    } else {
      R.currentCandidateId = R.stageOrder[R.stageIndex];
    }

    touchRoom(R);
    emitGameState(room);
  });

  // interviewer picks winner
  socket.on("selectWinner", (winnerId) => {
    if (tooSoon(lastActionAt, socket.id, ACTION_COOLDOWN_MS)) return;
    const room = getMyRoom();
    const R = rooms.get(room);
    if (!R || socket.id !== R.interviewerId || R.phase !== "judge") return;
    if (typeof winnerId !== "string" || !R.submissions[winnerId]) return;

    Object.values(R.submissions).forEach((s) => (s.winner = false));
    R.submissions[winnerId].winner = true;
    if (R.players[winnerId]) R.players[winnerId].score++;

    touchRoom(R);
    emitGameState(room);
    io.to(room).emit("chat", { name: "SYSTEM", msg: `${R.players[winnerId]?.name || "Someone"} wins the round!` });
  });

  // next round (interviewer only)
  socket.on("nextRound", () => {
    if (tooSoon(lastActionAt, socket.id, ACTION_COOLDOWN_MS)) return;
    const room = getMyRoom();
    const R = rooms.get(room);
    if (!R || socket.id !== R.interviewerId) return;

    R.interviewerIndex = (R.interviewerIndex + 1) % Object.keys(R.players).length;
    prepareRound(R);
    io.to(room).emit("chat", { name: "SYSTEM", msg: `Round ${R.round} – Interviewer: ${R.players[R.interviewerId].name}` });
    emitGameState(room);
  });

  // simple chat
  socket.on("chat", (msg) => {
    if (tooSoon(lastChatAt, socket.id, CHAT_COOLDOWN_MS)) return;
    const room = getMyRoom();
    if (!room) return;
    const R = rooms.get(room);
    if (!R) return;

    const from = R.players[socket.id]?.name || "Player";
    const safeMsg = esc(String(msg).slice(0, 300));
    touchRoom(R);
    io.to(room).emit("chat", { name: from, msg: safeMsg });
  });

  // disconnect cleanup
  socket.on("disconnect", () => {
    for (const [code, R] of rooms.entries()) {
      if (!R.players[socket.id]) continue;

      const wasInterviewer = socket.id === R.interviewerId;
      const wasOnStage = R.phase === "reveal" && socket.id === R.currentCandidateId;
      const who = R.players[socket.id]?.name || socket.data.name;

      delete R.players[socket.id];
      delete R.submissions[socket.id];
      delete R.twistsAssigned[socket.id];

      // also clean reveal map
      if (R.revealed && R.revealed[socket.id]) delete R.revealed[socket.id];

      io.to(code).emit("chat", { name: "SYSTEM", msg: `${who} left.` });

      // empty room — delete then continue so we don't emit to a deleted room
      if (Object.keys(R.players).length === 0) {
        rooms.delete(code);
        broadcastRoomList();
        continue;
      }

      // host handoff
      if (R.hostId === socket.id) {
        R.hostId = Object.keys(R.players)[0];
        io.to(code).emit("chat", { name: "SYSTEM", msg: `${R.players[R.hostId].name} is the new host.` });
      }

      // refresh order
      R._order = Object.keys(R.players);

      // if interviewer left, immediately prep a new round
      if (wasInterviewer) {
        R.interviewerIndex = R.interviewerIndex % R._order.length;
        prepareRound(R);
        io.to(code).emit("chat", { name: "SYSTEM", msg: `New round – Interviewer: ${R.players[R.interviewerId].name}` });
      }

      // if current on-stage candidate left during reveal, advance turn safely
      if (wasOnStage) {
        R.stageOrder = (R.stageOrder || []).filter(id => id !== socket.id);
        if (R.stageOrder.length === 0) {
          R.phase = "judge";
          R.currentCandidateId = null;
        } else {
          if (R.stageIndex >= R.stageOrder.length) R.stageIndex = R.stageOrder.length - 1;
          R.currentCandidateId = R.stageOrder[R.stageIndex] || null;
        }
      }

      touchRoom(R);
      emitLobby(code);
      emitGameState(code);
      broadcastRoomList();
    }
    // cleanup rate maps
    lastActionAt.delete(socket.id);
    lastChatAt.delete(socket.id);
    lastCreateJoinAt.delete(socket.id);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Pitch Party server on ${PORT}`));
