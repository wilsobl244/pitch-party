// Add login authentication : save users


// * Bugs *
// Sometimes server crashes, mobile players cant see full card stack of traits,

// fuck



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

const MATCH_WIN_SCORE = 5;

const RECONNECT_GRACE_MS =
    90 * 1000;



const rooms = new Map(); // Map<roomCode, RoomState>

// Permanent browser playerId -> current room/socket information
const playerSessions = new Map();


const lastActionAt = new Map(); // Map<socketId, number>
const lastChatAt = new Map(); // Map<socketId, number>
const lastCreateJoinAt = new Map(); // Map<socketId, number>


const {
    pool,
    initializeDatabase
} = require("./database");

const {
    registerAccount,
    loginAccount,
    accountFromToken,
    createLoginToken,
    deleteLoginToken
} = require("./auth");




function now() { return Date.now(); }
function tooSoon(map, id, cooldown) {
  const t = map.get(id) || 0;
  if (now() - t < cooldown) return true;
  map.set(id, now());
  return false;
}
function touchRoom(R) { R.lastActivityAt = now(); }
function esc(s) { return String(s).replace(/[<>]/g, m => (m === "<" ? "&lt;" : "&gt;")).replace(/[\x00-\x1F]/g, ""); }



function cleanGameName(value) {
    const name =
        esc(String(value ?? "").trim());

    if (!name) {
        return null;
    }

    if (name.length > MAX_NAME_LEN) {
        return null;
    }

    return name;
}


const VALID_AVATARS = new Set([
    "bossbaby.png",
    "avatar2.png"
]);

function cleanAvatar(value) {

    const avatar =
        String(value || "").trim();

    if (!VALID_AVATARS.has(avatar)) {
        return "bossbaby.png";
    }

    return avatar;
}



function hashPass(s) {
    return crypto
        .createHash("sha256")
        .update(String(s))
        .digest("hex");
}

function isValidPlayerId(value) {
    return (
        typeof value === "string" &&
        value.length >= 12 &&
        value.length <= 128 &&
        /^[a-zA-Z0-9_-]+$/.test(value)
    );
}

function moveObjectKey(object, oldKey, newKey) {
    if (!object || oldKey === newKey) return;

    if (
        Object.prototype.hasOwnProperty.call(
            object,
            oldKey
        )
    ) {
        object[newKey] = object[oldKey];
        delete object[oldKey];
    }
}

function replaceIdInArray(array, oldId, newId) {
    if (!Array.isArray(array)) return array;

    return array.map((id) =>
        id === oldId ? newId : id
    );
}

function migratePlayerSocket(
    R,
    oldSocketId,
    newSocketId
) {
    if (!R || !R.players?.[oldSocketId]) {
        return false;
    }

    if (oldSocketId === newSocketId) {
        R.players[newSocketId].connected = true;
        R.players[newSocketId].socketId = newSocketId;
        return true;
    }

    const migratedPlayer =
        R.players[oldSocketId];

    R.players[newSocketId] = {
        ...migratedPlayer,
        socketId: newSocketId,
        connected: true
    };

    delete R.players[oldSocketId];

    moveObjectKey(
        R.submissions,
        oldSocketId,
        newSocketId
    );

    moveObjectKey(
        R.twistsAssigned,
        oldSocketId,
        newSocketId
    );

    moveObjectKey(
        R.revealed,
        oldSocketId,
        newSocketId
    );

    if (R.hostId === oldSocketId) {
        R.hostId = newSocketId;
    }

    if (R.interviewerId === oldSocketId) {
        R.interviewerId = newSocketId;
    }

    if (R.currentCandidateId === oldSocketId) {
        R.currentCandidateId = newSocketId;
    }

    if (R.matchWinner === oldSocketId) {
        R.matchWinner = newSocketId;
    }

    R._order = replaceIdInArray(
        R._order,
        oldSocketId,
        newSocketId
    );

    R.stageOrder = replaceIdInArray(
        R.stageOrder,
        oldSocketId,
        newSocketId
    );

    return true;
}
function permanentlyRemovePlayer(
    code,
    oldSocketId,
    fallbackName
) {
    const R = rooms.get(code);

    if (!R || !R.players?.[oldSocketId]) {
        return;
    }

    const wasInterviewer =
        oldSocketId === R.interviewerId;

    const wasOnStage =
        R.phase === "reveal" &&
        oldSocketId === R.currentCandidateId;

    const who =
        R.players[oldSocketId]?.name ||
        fallbackName ||
        "Player";

    // Remove the player's saved game data.
    delete R.players[oldSocketId];
    delete R.submissions?.[oldSocketId];
    delete R.twistsAssigned?.[oldSocketId];
    delete R.revealed?.[oldSocketId];

    io.to(code).emit("chat", {
        name: "SYSTEM",
        msg: `${who} did not reconnect and left the game.`
    });

    const remainingIds = Object.keys(R.players);

    // Delete an empty room.
    if (remainingIds.length === 0) {
        rooms.delete(code);
        broadcastRoomList();
        return;
    }

    // Transfer host only after reconnect time expires.
    if (R.hostId === oldSocketId) {
        R.hostId = remainingIds[0];

        io.to(code).emit("chat", {
            name: "SYSTEM",
            msg: `${R.players[R.hostId].name} is the new host.`
        });
    }

    R._order = remainingIds;

    // If the interviewer never returned, safely begin another round.
    if (wasInterviewer) {
        R.interviewerIndex =
            (R.interviewerIndex || 0) %
            remainingIds.length;

        prepareRound(R);

        io.to(code).emit("chat", {
            name: "SYSTEM",
            msg:
                "New round – Interviewer: " +
                R.players[R.interviewerId].name
        });
    }

    // If the current candidate never returned, advance the stage.
    else if (wasOnStage) {
        const oldStageOrder = R.stageOrder || [];
        const leavingIndex =
            oldStageOrder.indexOf(oldSocketId);

        R.stageOrder = oldStageOrder.filter(
            id => id !== oldSocketId && R.players[id]
        );

        if (R.stageOrder.length === 0) {
            const remainingSubmissions =
                Object.keys(R.submissions || {});

            R.currentCandidateId = null;
            R.stageIndex = 0;

            R.phase =
                remainingSubmissions.length > 0
                    ? "judge"
                    : "chooseTraits";
        } else {
            R.stageIndex = Math.max(0, leavingIndex);

            if (R.stageIndex >= R.stageOrder.length) {
                R.phase = "judge";
                R.currentCandidateId = null;
            } else {
                R.currentCandidateId =
                    R.stageOrder[R.stageIndex];

                refillTwistChoices(R, 3);
            }
        }
    }

    touchRoom(R);
    emitLobby(code);

    if (R.phase !== "lobby") {
        emitGameState(code);
    }

    broadcastRoomList();
}
// ---------- utils ----------
function makeCode() {
  const letters = "ABCDEFGHJKLMNPQRSTUVWXYZ";
  let c = "";
  for (let i = 0; i < 4; i++) c += letters[Math.floor(Math.random() * letters.length)];
  return rooms.has(c) ? makeCode() : c;
}
function shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
        const j = crypto.randomInt(0, i + 1);
        [arr[i], arr[j]] = [arr[j], arr[i]];
    }

    return arr;
}

function baseJobs() {
  return shuffle([
    "Firefighter",
    "Author",
    "Chef",
    "Teacher",
    "Game Designer",
    "Comedian",
    "English Professor",
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
    "Discord Mod",
    "1st Grade Teacher",
    "Dermatologist",
    "Dentist",
    "Physical Trainer",
    "Rocket Scientist",
    "The Front Man from Squid Games",
    "MukBanger",
    "Crime Scene Cleaner",
    "Private Investigator"
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
    "Takes everything literally",
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
    "Ran a loom business in elementary school",
    "Has an ex wife named Shannon who took the kids",
    "Divorced and wife took the kids",
    "A little Racist",
    "Knows FNAF lore by heart",
    "Literally Gargamel from the Smurfs",
    "Indian Accent",
    "Filipino Accent",
    "Japanese Accent",
    "Is Firelord Ozai",
    "Packing 8 inches",
    "Is French",
    "Supplied low income neighborhoods with crack",
    "3 inch cock"
    
    

    
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
    "Methamphetamine Addict",
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
    "Sleeper activation code 'Garfield' makes them act like a cat",
    "Part-time Neko Girl",
    "Very Racist",
    "Orthodox Catholic",
     "Streams on Twitch but only gets 3 viewers",
     "Believes the earth is flat",
     "Been switching up on the day ones since day one",
     "Betrayed Jesus at the Last Supper",
     "Is actually 2 kids in a trench coat",
     "Plays Valorant",
     "Does not like Nicki Minaj",
     "Has dementia"


    
    
    
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
              {
                  name: p?.name ?? "—",
                  avatar: p?.avatar ?? "bossbaby.png",
                  score: p?.score ?? 0,
                  isHost: id === R.hostId
              }
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
                avatar: players[pid]?.avatar || "bossbaby.png",
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
            Object.entries(players).map(([id, p]) => [
                id,
                {
                    name: p?.name ?? "—",
                    avatar: p?.avatar ?? "bossbaby.png",
                    score: p?.score ?? 0
                }
            ])
        ),

        leaderboard: Object.entries(players)
            .map(([id, p]) => ({
                id,
                name: p?.name ?? "—",
                avatar: p?.avatar ?? "bossbaby.png",
                score: p?.score ?? 0
            }))
            .sort((a, b) => b.score - a.score),


        // spotlight fields for progressive reveal
        currentCandidateId: curId,
        currentCandidateTwist: curTwist, // ensure stage can show twist immediately
        canAssignTwist,
        canEndTurn,
        revealed,

        matchOver: R.matchOver,
        matchWinner: R.matchWinner,
        matchWinScore: MATCH_WIN_SCORE,
    };

    const send = (
        playerKey,
        forcedSocketId = null
    ) => {
        const player = players[playerKey];

        if (!player) {
            return;
        }

        const targetSocketId =
            forcedSocketId ||
            player.socketId ||
            playerKey;

        if (!targetSocketId) {
            return;
        }

        const isInterviewer =
            playerKey === R.interviewerId;

        const isCurrent =
            playerKey === curId;

        console.log(
            "[gameState]",
            {
                playerKey,
                targetSocketId,
                connected: player.connected,
                phase: R.phase,
                currentCandidateId: R.currentCandidateId,
                currentTwist:
                    R.currentCandidateId
                        ? R.twistsAssigned[
                        R.currentCandidateId
                        ]
                        : null
            }
        );

        io.to(targetSocketId).emit("gameState", {
            ...pub,

            // Keep the room's player key here because the rest
            // of the game state uses it for candidate/interviewer IDs.
            myId: playerKey,

            isInterviewer,

            jobOptions:
                (
                    isInterviewer &&
                    R.phase === "chooseJob"
                )
                    ? jobOptions
                    : undefined,

            twistBank:
                (
                    isInterviewer &&
                    R.phase === "reveal" &&
                    !curTwist &&
                    twistBank.length > 0
                )
                    ? twistBank
                    : undefined,

            hand:
                (
                    R.phase === "chooseTraits" &&
                    !isInterviewer
                )
                    ? (player.hand || [])
                    : [],

            myAllTraits:
                isCurrent
                    ? (
                        submissions[playerKey]
                            ?.traits || []
                    )
                    : undefined,

            submitted:
                !!submissions[playerKey],
        });
    };

    if (toId) {
        // toId may be either the player key or current socket ID.
        const matchingEntry =
            Object.entries(players).find(
                ([playerKey, player]) =>
                    playerKey === toId ||
                    player?.socketId === toId
            );

        if (matchingEntry) {
            const [playerKey, player] =
                matchingEntry;

            send(
                playerKey,
                player?.socketId || toId
            );
        }
    } else {
        Object.entries(players).forEach(
            ([playerKey, player]) => {
                if (player?.connected === false) {
                    return;
                }

                send(
                    playerKey,
                    player?.socketId
                );
            }
        );
    }
}


// ---------- round prep ----------

function refillTwistChoices(R, amount = 3) {
    if (!R || !R.deck) return;

    R.twistBank = [];

    while (R.twistBank.length < amount) {
        if (!Array.isArray(R.deck.twists) || R.deck.twists.length === 0) {
            R.deck.twists = baseTwists();
        }

        const twist = R.deck.twists.pop();

        if (
            typeof twist === "string" &&
            !R.twistBank.includes(twist)
        ) {
            R.twistBank.push(twist);
        }
    }
}


function prepareRound(R) {
  const ids = Object.keys(R.players);
  if (ids.length === 0) return;

  // seating/order (join order)
  R._order = ids.slice();

  // rotate interviewer
  if (R.interviewerIndex == null) R.interviewerIndex = 0;
  R.interviewerId = R._order[R.interviewerIndex % R._order.length];

    R.phase = "chooseJob";

    if (R.round === 0) {

        R.matchOver = false;
        R.matchWinner = null;

    }


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

    // Give the interviewer 3 randomized twist choices.
    refillTwistChoices(R, 3);


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
          for (const player of Object.values(R.players || {})) {
              const playerId = player?.playerId;

              if (!playerId) continue;

              const session = playerSessions.get(playerId);

              if (session?.disconnectTimer) {
                  clearTimeout(session.disconnectTimer);
              }

              playerSessions.delete(playerId);
          }

          rooms.delete(code);
      }
  }
  broadcastRoomList();
}, 60 * 1000);

// ---------- sockets ----------
io.on("connection", (socket) => {
    socket.data.accountUsername = null;
    socket.data.gameName = null;
   
    socket.data.authenticated = false;


    async function attachAccount(account, token) {
        socket.data.accountId = account.id;
        socket.data.playerId = account.id;
        socket.data.accountUsername =
            account.username;

        socket.data.authenticated = true;

        socket.emit("accountAuthenticated", {
            username: account.username,
            token
        });

        const session = playerSessions.get(account.id);

        if (!session) {
            return;
        }

        const R = rooms.get(session.roomCode);

        if (!R) {
            if (session.disconnectTimer) {
                clearTimeout(session.disconnectTimer);
            }

            playerSessions.delete(account.id);
            return;
        }

        const oldSocketId = session.socketId;

        if (!R.players?.[oldSocketId]) {
            playerSessions.delete(account.id);
            return;
        }

        if (session.disconnectTimer) {
            clearTimeout(session.disconnectTimer);
            session.disconnectTimer = null;
        }

        const migrated = migratePlayerSocket(
            R,
            oldSocketId,
            socket.id
        );

        if (!migrated) {
            playerSessions.delete(account.id);
            return;
        }

        session.socketId = socket.id;

        R.players[socket.id].playerId =
            account.id;

        socket.data.gameName =
            R.players[socket.id].name;

        socket.join(session.roomCode);

        touchRoom(R);

        socket.emit("reconnectedToRoom", {
            room: session.roomCode,
            isHost: R.hostId === socket.id,
            phase: R.phase,
            name: R.players[socket.id].name
        });

        emitLobby(session.roomCode);

        if (R.phase !== "lobby") {
            emitGameState(
                session.roomCode,
                socket.id
            );
        }

        broadcastRoomList();
    }



    socket.on(
        "registerAccount",
        async ({ username, password } = {}) => {
            try {
                const account =
                    await registerAccount(
                        username,
                        password
                    );

                const token =
                    await createLoginToken(account.id);

                await attachAccount(account, token);
            } catch (error) {
                console.error("Registration error:", error);

                socket.emit(
                    "accountError",
                    error.message ||
                    "Could not create account."
                );
            }
        }
    );

    socket.on(
        "loginAccount",
        async ({ username, password } = {}) => {
            try {
                const account =
                    await loginAccount(
                        username,
                        password
                    );

                const token =
                    await createLoginToken(account.id);

                await attachAccount(account, token);
            } catch (error) {
                console.error("Login error:", error);

                socket.emit(
                    "accountError",
                    error.message ||
                    "Could not log in."
                );
            }
        }
    );

    socket.on(
        "authenticateToken",
        async ({ token } = {}) => {
            try {
                const account =
                    await accountFromToken(token);

                if (!account) {
                    socket.emit("accountTokenInvalid");
                    return;
                }

                await attachAccount(account, token);
            } catch (error) {
                console.error(
                    "Token authentication error:",
                    error
                );

                socket.emit("accountTokenInvalid");
            }
        }
    );

    socket.on(
        "logoutAccount",
        async ({ token } = {}) => {
            try {
                await deleteLoginToken(token);

                if (socket.data.playerId) {
                    playerSessions.delete(socket.data.playerId);
                }
            } catch (error) {
                console.error("Logout error:", error);
            }

            socket.data.accountId = null;
            socket.data.playerId = null;
            socket.data.accountUsername = null;
            socket.data.gameName = null;
            socket.data.authenticated = false;

            socket.emit("accountLoggedOut");
        }
    );


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
  
  // create room
    socket.on("createRoom", (payload = {}) => {


        if (
            !socket.data.authenticated ||
            !socket.data.accountId
        ) {

            socket.emit(
                "createError",
                "Log in before creating a room."
            );
            return;
        }


        const displayName =
            cleanGameName(payload.displayName);


        const avatar =
            cleanAvatar(payload.avatar);


        if (!displayName) {
            socket.emit(
                "createError",
                "Choose a valid game name with 1–24 characters."
            );

            return;
        }

        socket.data.gameName =
            displayName;

        if (!socket.data.playerId) {
            socket.emit(
                "createError",
                "Player session is still loading. Try again."
            );
            return;
        }

        const existingSession =
            playerSessions.get(socket.data.playerId);

        if (existingSession) {

            const existingRoom =
                rooms.get(existingSession.roomCode);

            if (!existingRoom) {

                playerSessions.delete(socket.data.playerId);

            } else {

                socket.emit(
                    "joinError",
                    "You are already connected to a room."
                );

                return;
            }

        }


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
        players: {
            [socket.id]: {
                name: displayName,
                avatar,
                hand: [],
                score: 0,
                socketId: socket.id,
                connected: true,
                playerId: socket.data.playerId
            }
        },
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

        // Match
        matchOver: false,
        matchWinner: null,


    };

    rooms.set(room, R);
        socket.join(room);

        playerSessions.set(
            socket.data.playerId,
            {
                roomCode: room,
                socketId: socket.id,
                disconnectTimer: null
            }
        );

        socket.emit("roomCreated", { room });
    emitLobby(room);
    broadcastRoomList();
  });

  // join room
    socket.on("joinRoom", (payload) => {


        if (
            !socket.data.authenticated ||
            !socket.data.accountId
        ) {
            socket.emit(
                "joinError",
                "Log in before joining a room."
            );
            return;
        }


        const displayName =
            cleanGameName(payload?.displayName);


        const avatar =
            cleanAvatar(payload.avatar);


        if (!displayName) {
            socket.emit(
                "joinError",
                "Choose a valid game name with 1–24 characters."
            );

            return;
        }

        socket.data.gameName =
            displayName;

        if (!socket.data.playerId) {
            socket.emit(
                "joinError",
                "Player session is still loading. Try again."
            );
            return;
        }

        const existingSession =
            playerSessions.get(socket.data.playerId);

        if (existingSession) {

            const existingRoom =
                rooms.get(existingSession.roomCode);

            if (!existingRoom) {

                playerSessions.delete(socket.data.playerId);

            } else {

                socket.emit(
                    "joinError",
                    "You are already connected to a room."
                );

                return;
            }

        }

    if (tooSoon(lastCreateJoinAt, socket.id, CREATE_JOIN_COOLDOWN_MS)) {
      socket.emit("joinError", "Slow down a bit before joining again.");
      return;
    }
        const roomCode = esc(
            String(payload?.room || "")
                .trim()
                .toUpperCase()
        );

        const passRaw = String(payload?.passcode || "").trim();

        if (!/^[A-Z]{4}$/.test(roomCode)) {
            socket.emit("joinError", "Room codes must contain exactly 4 letters.");
            return;
        }

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

        R.players[socket.id] = {
            name: displayName,
            avatar,
            hand: [],
            score: 0,
            socketId: socket.id,
            connected: true,
            playerId: socket.data.playerId
        };

        R._order = Object.keys(R.players);
        touchRoom(R);

        socket.join(roomCode);

        playerSessions.set(
            socket.data.playerId,
            {
                roomCode,
                socketId: socket.id,
                disconnectTimer: null
            }
        );

        socket.emit("joined", {
            room: roomCode,
            isHost: socket.id === R.hostId
        });

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

        console.log("START GAME CLICKED");

        if (tooSoon(lastActionAt, socket.id, ACTION_COOLDOWN_MS)) {
            console.log("Cooldown");
            return;
        }

        const room = getMyRoom();

        console.log("Room:", room);

        const R = rooms.get(room);

        if (!R) {
            console.log("Room doesn't exist");
            return;
        }

        if (R.hostId !== socket.id) {
            console.log("Not host");
            return;
        }

        if (R.phase !== "lobby") {
            console.log("Wrong phase:", R.phase);
            return;
        }

        console.log("Players:", Object.keys(R.players).length);

        if (Object.keys(R.players).length < 2) {
            socket.emit(
                "createError",
                "Need at least 2 players."
            );
            return;
        }

        R.interviewerIndex = 0;
        R._order = Object.keys(R.players);

        prepareRound(R);

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

      if (socket.id === R.interviewerId) {
          socket.emit("gameError", "The interviewer does not choose candidate traits.");
          return;
      }

      if (R.submissions[socket.id]) {
          socket.emit("gameError", "You already submitted your traits.");
          return;
      }

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
        R.stageOrder = shuffle(candidates.slice());
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
        if (tooSoon(lastActionAt, socket.id, ACTION_COOLDOWN_MS)) {
            return;
        }

        const room = getMyRoom();
        const R = rooms.get(room);

        if (!R) {
            socket.emit("gameError", "Room not found.");
            return;
        }

        if (socket.id !== R.interviewerId) {
            socket.emit("gameError", "Only the interviewer can assign a twist.");
            return;
        }

        if (R.phase !== "reveal") {
            socket.emit(
                "gameError",
                "Twists can only be assigned during the reveal phase."
            );
            return;
        }

        if (targetId !== R.currentCandidateId) {
            socket.emit("gameError", "That candidate is not currently on stage.");
            return;
        }

        if (!R.submissions[targetId]) {
            socket.emit("gameError", "Candidate submission could not be found.");
            return;
        }

        if (
            typeof twist !== "string" ||
            !R.twistBank.includes(twist)
        ) {
            socket.emit("gameError", "Please select one of the available twists.");
            return;
        }

        const revealedTraits = R.revealed[targetId] || [];

        if (revealedTraits.length !== 3) {
            socket.emit(
                "gameError",
                "The candidate must reveal all 3 traits before receiving a twist."
            );
            return;
        }

        if (R.twistsAssigned[targetId]) {
            socket.emit("gameError", "This candidate already has a twist.");
            return;
        }

        R.twistsAssigned[targetId] = twist;

        // The current three choices should disappear after selection.
        R.twistBank = [];

        touchRoom(R);

        // Resend individualized state to every connected player.
        emitGameState(room);
        emitLobby(room);
    });
  // interviewer ends the current candidate's turn (only after twist assigned)
  socket.on("endTurn", () => {
    if (tooSoon(lastActionAt, socket.id, ACTION_COOLDOWN_MS)) return;
    const room = getMyRoom();
    const R = rooms.get(room);
    if (!R || R.phase !== "reveal") return;
    if (socket.id !== R.interviewerId) return;
      const pid = R.currentCandidateId;

      if (!pid) {
          socket.emit("gameError", "There is no candidate currently on stage.");
          return;
      }

      if (!R.twistsAssigned[pid]) {
          socket.emit(
              "gameError",
              "Assign a twist before ending the candidate's turn."
          );
          return;
      }

    R.stageIndex++;
    if (R.stageIndex >= R.stageOrder.length) {
      // all candidates done — move to judge
      R.phase = "judge";
      R.currentCandidateId = null;
    } else {
        R.currentCandidateId = R.stageOrder[R.stageIndex];

        refillTwistChoices(R);
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

      const winnerAlreadySelected = Object.values(R.submissions).some(
          submission => submission.winner
      );

      if (winnerAlreadySelected) {
          socket.emit("gameError", "A winner has already been selected.");
          return;
      }

      R.submissions[winnerId].winner = true;

      if (R.players[winnerId]) {

          R.players[winnerId].score++;

          if (R.players[winnerId].score >= MATCH_WIN_SCORE) {

              R.matchOver = true;
              R.matchWinner = winnerId;

          }

      }

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
        if (R.phase !== "judge") return;

        const winnerSelected = Object.values(R.submissions || {}).some(
            submission => submission.winner
        );

        if (!winnerSelected) {
            socket.emit(
                "gameError",
                "Choose a winner before starting the next round."
            );
            return;
        }

        const playerIds = Object.keys(R.players);

        if (playerIds.length < 2) {
            socket.emit(
                "gameError",
                "At least 2 players are required to continue."
            );
            return;
        }

        const currentInterviewerId = R.interviewerId;

        const possibleInterviewers = playerIds.filter(
            id => id !== currentInterviewerId
        );

        const nextInterviewerId =
            possibleInterviewers[
            crypto.randomInt(0, possibleInterviewers.length)
            ];

        R.interviewerIndex = playerIds.indexOf(nextInterviewerId);

        if (R.matchOver) {

            emitGameState(room);

            return;

        }

        prepareRound(R);

        io.to(room).emit("chat", {
            name: "SYSTEM",
            msg: `Round ${R.round} – Interviewer: ${R.players[R.interviewerId].name}`
        });

        emitGameState(room);
        broadcastRoomList();
    });


    // restart entire match
    socket.on("restartMatch", () => {

        if (tooSoon(lastActionAt, socket.id, ACTION_COOLDOWN_MS)) return;

        const room = getMyRoom();
        const R = rooms.get(room);

        if (!R) return;

        if (socket.id !== R.hostId) return;

        if (!R.matchOver) return;

        // reset scores
        for (const player of Object.values(R.players)) {
            player.score = 0;
        }

        R.matchOver = false;
        R.matchWinner = null;

        R.round = 0;
        R.interviewerIndex = 0;

        prepareRound(R);

        io.to(room).emit("chat", {
            name: "SYSTEM",
            msg: "A new match has begun!"
        });

        emitLobby(room);
        emitGameState(room);
        broadcastRoomList();

    });


    socket.on("leaveRoom", () => {

        const room = getMyRoom();

        if (!room) {
            socket.emit("leftRoom");
            return;
        }

        const R = rooms.get(room);

        if (!R) {
            socket.emit("leftRoom");
            return;
        }


        const playerName =
            R.players[socket.id]?.name || "Player";

        const leavingDuringGame =
            R.phase !== "lobby";


        socket.rooms.forEach(r => {
            if (rooms.has(r)) {
                socket.leave(r);
            }
        });

        if (leavingDuringGame) {

            io.to(room).emit("chat", {
                name: "SYSTEM",
                msg: `${playerName} left the game.`
            });

        }


        delete R.players[socket.id];
        delete R.submissions[socket.id];
        delete R.twistsAssigned[socket.id];
        delete R.revealed[socket.id];

        if (R.matchWinner === socket.id) {
            R.matchWinner = null;
        }


        R._order = (R._order || []).filter(
            id => id !== socket.id
        );


        const leavingStageIndex =
            (R.stageOrder || []).indexOf(socket.id);


        R.stageOrder = (R.stageOrder || []).filter(
            id => id !== socket.id
        );


        if (socket.data.playerId) {
            playerSessions.delete(socket.data.playerId);
            socket.data.playerId = socket.data.accountId;
        }

        if (R.hostId === socket.id) {

            const ids = Object.keys(R.players);

            if (ids.length > 0) {

                R.hostId = ids[0];

                io.to(room).emit("chat", {
                    name: "SYSTEM",
                    msg: `${R.players[R.hostId].name} is now the host.`
                });

            } else {

                R.hostId = null;

            }
        }

        if (R.interviewerId === socket.id) {

            if (Object.keys(R.players).length > 0) {

                prepareRound(R);

            } else {

                R.interviewerId = null;

            }

        }

     

        if (R.currentCandidateId === socket.id) {

            if (R.stageOrder.length === 0) {

                R.currentCandidateId = null;
                R.stageIndex = 0;

                R.phase =
                    Object.keys(R.submissions).length > 0
                        ? "judge"
                        : "chooseTraits";

            } else {

                R.stageIndex = Math.min(
                    leavingStageIndex,
                    R.stageOrder.length - 1
                );

                if (R.stageIndex < 0) {
                    R.stageIndex = 0;
                }

                R.currentCandidateId =
                    R.stageOrder[R.stageIndex];

                refillTwistChoices(R);

            }

        }

        if (Object.keys(R.players).length === 0) {

            rooms.delete(room);

        }
        else {

            touchRoom(R);

            emitLobby(room);

            emitGameState(room);

        }

     


        if (rooms.has(room)) {

            touchRoom(R);

        }

        broadcastRoomList();

        socket.emit("leftRoom");

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


   



    // Temporary disconnect: allow Safari/mobile players to return.
    socket.on("disconnect", () => {
        const playerId = socket.data.playerId;

        function clearRateLimits() {
            lastActionAt.delete(socket.id);
            lastChatAt.delete(socket.id);
            lastCreateJoinAt.delete(socket.id);
        }

        if (!playerId) {
            clearRateLimits();
            return;
        }

        const session = playerSessions.get(playerId);

        // Ignore stale disconnects from an older socket.
        if (
            !session ||
            session.socketId !== socket.id
        ) {
            clearRateLimits();
            return;
        }

        const R = rooms.get(session.roomCode);
        const player = R?.players?.[socket.id];

        if (!R || !player) {
            playerSessions.delete(playerId);
            clearRateLimits();
            return;
        }

        // Keep all game data, but mark the player offline.
        player.connected = false;

        const disconnectedName =
            player.name ||
            socket.data.gameName ||
            socket.data.accountUsername ||
            "Player";


        io.to(session.roomCode).emit("chat", {
            name: "SYSTEM",
            msg:
                `${disconnectedName} disconnected. ` +
                "Waiting up to 90 seconds for them to reconnect…"
        });

        if (session.disconnectTimer) {
            clearTimeout(session.disconnectTimer);
        }

        const disconnectedSocketId = socket.id;
        const disconnectedRoomCode = session.roomCode;

        session.disconnectTimer = setTimeout(() => {
            const latestSession =
                playerSessions.get(playerId);

            // The player already reconnected with another socket.
            if (
                !latestSession ||
                latestSession.socketId !==
                disconnectedSocketId
            ) {
                return;
            }

            permanentlyRemovePlayer(
                disconnectedRoomCode,
                disconnectedSocketId,
                disconnectedName
            );

            playerSessions.delete(playerId);
        }, RECONNECT_GRACE_MS);

        clearRateLimits();
    }); // closes socket.on("disconnect")

}); // closes io.on("connection")

const PORT = process.env.PORT || 3000;

async function startServer() {
    try {
        await initializeDatabase();

        await pool.query(`
    DELETE FROM login_tokens
    WHERE expires_at <= EXTRACT(EPOCH FROM NOW()) * 1000
`);

        server.listen(PORT, () => {
            console.log(
                `Lumpia Fart server running on port ${PORT}`
            );
        });
    } catch (error) {
        console.error(
            "Server startup failed:",
            error
        );

        process.exit(1);
    }
}

setInterval(async () => {

    try {

        await pool.query(`
            DELETE FROM login_tokens
            WHERE expires_at <= EXTRACT(EPOCH FROM NOW()) * 1000
        `);

    }

    catch (err) {

        console.error(
            "Failed cleaning expired login tokens:",
            err
        );

    }

}, 60 * 60 * 1000);



startServer();