const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");
const crypto = require("crypto");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: false },
  pingInterval: 25000,
  pingTimeout: 20000
});

const PORT = process.env.PORT || 3000;
const rooms = new Map();
const queue = [];
const games = new Set(["ttt", "connect", "ships", "pool"]);

app.disable("x-powered-by");
app.use(express.static(path.join(__dirname, "public")));

app.get("/health", (_req, res) =>
  res.json({ ok: true, service: "DUEL UP", rooms: rooms.size })
);

function code() {
  return crypto.randomBytes(3).toString("hex").toUpperCase();
}

function cleanName(v) {
  return String(v || "Player")
    .replace(/[<>]/g, "")
    .trim()
    .slice(0, 18) || "Player";
}

function emptyRoom(game, host, name, isPublic = false) {
  return {
    code: code(),
    game,
    public: isPublic,
    players: [{ id: host, name, mark: 1 }],
    board: null,
    turn: 1,
    status: "waiting",
    winner: null,
    message: "Waiting for another player…",
    state: {},
    createdAt: Date.now()
  };
}

function initGame(room) {
  room.status = room.game === "ships" ? "placing" : "playing";
  room.winner = null;
  room.turn = 1;

  if (room.game === "ttt") {
    room.board = Array(9).fill(0);
  }

  if (room.game === "connect") {
    room.board = Array(42).fill(0);
  }

  if (room.game === "ships") {
    room.board = {
      shots: [Array(100).fill(""), Array(100).fill("")],
      fleets: [null, null],
      ships: [null, null],
      ready: [false, false],
      hits: [0, 0]
    };
  }

  if (room.game === "pool") {
    room.board = {
      balls: poolRack(),
      shots: [0, 0],
      pocketed: [0, 0],
      groups: [null, null],
      ballInHand: null,
      breakShot: true
    };
  }

  room.message = room.game === "ships"
    ? "Place your ships, then press Ready. The battle starts when both players are ready."
    : `${room.players[0].name} vs ${room.players[1].name} — ${room.players[0].name}'s turn.`;
}

function fleet() {
  const b = Array(100).fill(false);

  for (const len of [4, 3, 3, 2]) {
    let placed = false;
    let tries = 0;

    while (!placed && tries++ < 1000) {
      const horizontal = Math.random() < 0.5;
      const r = Math.floor(Math.random() * 10);
      const c = Math.floor(Math.random() * 10);
      const cells = [];

      for (let k = 0; k < len; k++) {
        const rr = r + (horizontal ? 0 : k);
        const cc = c + (horizontal ? k : 0);

        if (rr > 9 || cc > 9) {
          cells.length = 0;
          break;
        }

        cells.push(rr * 10 + cc);
      }

      if (cells.length && cells.every(i => !b[i])) {
        cells.forEach(i => b[i] = true);
        placed = true;
      }
    }
  }

  return b;
}

function poolRack() {
  const balls = [{ id: 0, x: 22, y: 50 }];

  // Standard 15-ball triangle, in normalized table coordinates.
  let id = 1;
  const startX = 68;
  const startY = 50;
  const spacingX = 4.0;
  const spacingY = 8.2;

  for (let col = 0; col < 5; col++) {
    for (let row = 0; row <= col; row++) {
      balls.push({
        id: id++,
        x: startX + col * spacingX,
        y: startY + (row - col / 2) * spacingY
      });
    }
  }

  return balls;
}

function playerIndex(room, id) {
  return room.players.findIndex(p => p.id === id);
}

function snapshot(room, viewerId) {
  const board = room.board
    ? JSON.parse(JSON.stringify(room.board))
    : null;

  if (room.game === "ships" && board) {
    const idx = playerIndex(room, viewerId);
    const original = board;

    const privateBoard = {
      shots: original.shots,
      ready: original.ready,
      hits: original.hits,

      ownFleet: idx >= 0 && original.fleets[idx]
        ? original.fleets[idx]
        : Array(100).fill(false),

      ownShips: idx >= 0 && original.ships[idx]
        ? original.ships[idx]
        : [],

      incoming: idx >= 0
        ? original.shots[1 - idx]
        : Array(100).fill(""),

      outgoing: idx >= 0
        ? original.shots[idx]
        : Array(100).fill(""),

      sunkShips: idx >= 0 && original.ships[1 - idx]
        ? original.ships[1 - idx].filter(ship =>
            ship.every(cell => original.shots[idx][cell] === "H")
          ).length
        : 0
    };

    return {
      code: room.code,
      game: room.game,
      players: room.players.map((p, i) => ({
        id: p.id,
        name: p.name,
        mark: i + 1,
        connected: io.sockets.sockets.has(p.id)
      })),
      status: room.status,
      turn: room.turn,
      winner: room.winner,
      message: room.message,
      board: privateBoard
    };
  }

  return {
    code: room.code,
    game: room.game,
    players: room.players.map((p, i) => ({
      id: p.id,
      name: p.name,
      mark: i + 1,
      connected: io.sockets.sockets.has(p.id)
    })),
    status: room.status,
    turn: room.turn,
    winner: room.winner,
    message: room.message,
    board
  };
}

function emitRoom(room) {
  for (const p of room.players) {
    io.to(p.id).emit("room:update", snapshot(room, p.id));
  }
}

function validateShips(ships) {
  if (!Array.isArray(ships) || ships.length !== 4) {
    return null;
  }

  const lengths = [4, 3, 3, 2];
  const used = new Set();
  const fleet = Array(100).fill(false);
  const clean = [];

  for (let n = 0; n < lengths.length; n++) {
    const ship = ships[n];

    if (
      !Array.isArray(ship) ||
      ship.length !== lengths[n] ||
      ship.some(i => !Number.isInteger(i) || i < 0 || i > 99)
    ) {
      return null;
    }

    if (
      new Set(ship).size !== ship.length ||
      ship.some(i => used.has(i))
    ) {
      return null;
    }

    const rows = ship.map(i => Math.floor(i / 10));
    const cols = ship.map(i => i % 10);
    const sortedCols = [...cols].sort((a, b) => a - b);
    const sortedRows = [...rows].sort((a, b) => a - b);

    const horizontal =
      rows.every(r => r === rows[0]) &&
      sortedCols.every(
        (c, j) => j === 0 || c === sortedCols[j - 1] + 1
      );

    const vertical =
      cols.every(c => c === cols[0]) &&
      sortedRows.every(
        (r, j) => j === 0 || r === sortedRows[j - 1] + 1
      );

    if (!horizontal && !vertical) {
      return null;
    }

    ship.forEach(i => {
      used.add(i);
      fleet[i] = true;
    });

    clean.push([...ship]);
  }

  return { fleet, ships: clean };
}

function findRoomBySocket(id) {
  for (const room of rooms.values()) {
    if (playerIndex(room, id) !== -1) {
      return room;
    }
  }

  return null;
}

function closeRoom(room, message) {
  room.status = "finished";
  room.winner = 0;
  room.message = message;
  emitRoom(room);
}

function leaveRoom(socket, reason = "A player left the room.") {
  const room = findRoomBySocket(socket.id);
  if (!room) return;

  socket.leave(room.code);

  const idx = playerIndex(room, socket.id);
  if (idx !== -1) {
    room.players.splice(idx, 1);
  }

  if (room.players.length === 0) {
    rooms.delete(room.code);
  } else {
    room.status = "finished";
    room.winner = 0;
    room.message = reason;
    emitRoom(room);

    // A finished room is retained briefly so the remaining player sees the message.
    setTimeout(() => {
      if (rooms.get(room.code) === room && room.players.length < 2) {
        rooms.delete(room.code);
      }
    }, 60000);
  }

  io.emit("lobby:count", queue.length);
}

function finish(room, winner, message) {
  room.status = "finished";
  room.winner = winner;
  room.message = message;
  emitRoom(room);
}

function nextTurn(room) {
  room.turn = room.turn === 1 ? 2 : 1;
  room.message = `${room.players[room.turn - 1]?.name || "Player"}'s turn.`;
}

function tttWinner(b) {
  for (const [a, c, d] of [
    [0, 1, 2],
    [3, 4, 5],
    [6, 7, 8],
    [0, 3, 6],
    [1, 4, 7],
    [2, 5, 8],
    [0, 4, 8],
    [2, 4, 6]
  ]) {
    if (b[a] && b[a] === b[c] && b[a] === b[d]) {
      return b[a];
    }
  }

  return 0;
}

function c4Winner(b, p) {
  for (let r = 0; r < 6; r++) {
    for (let c = 0; c < 7; c++) {
      if (b[r * 7 + c] !== p) continue;

      for (const [dr, dc] of [
        [0, 1],
        [1, 0],
        [1, 1],
        [1, -1]
      ]) {
        let ok = true;

        for (let k = 1; k < 4; k++) {
          const rr = r + dr * k;
          const cc = c + dc * k;

          if (
            rr < 0 ||
            rr >= 6 ||
            cc < 0 ||
            cc >= 7 ||
            b[rr * 7 + cc] !== p
          ) {
            ok = false;
            break;
          }
        }

        if (ok) return true;
      }
    }
  }

  return false;
}

function myTurn(room, idx) {
  return room.turn === idx + 1;
}

function reject(socket, msg) {
  socket.emit("action:error", msg);
}

io.on("connection", socket => {
  socket.emit("lobby:count", queue.length);

  socket.on("room:create", ({ game, name } = {}) => {
    if (!games.has(game)) {
      return reject(socket, "Choose a supported game.");
    }

    leaveRoom(socket, "A player left the room.");

    const room = emptyRoom(game, socket.id, cleanName(name));
    rooms.set(room.code, room);
    socket.join(room.code);
    socket.emit("room:created", { code: room.code, game });
    emitRoom(room);
  });

  socket.on("room:join", ({ code: raw, name } = {}) => {
    const codeValue = String(raw || "").trim().toUpperCase();
    const room = rooms.get(codeValue);

    if (!room) {
      return reject(
        socket,
        "That room code wasn't found. Ask your friend to create a room first."
      );
    }

    if (room.players.length >= 2) {
      return reject(socket, "That room is already full.");
    }

    if (room.status === "playing") {
      return reject(socket, "That match has already started.");
    }

    leaveRoom(socket, "A player left the room.");
    room.players.push({
      id: socket.id,
      name: cleanName(name),
      mark: 2
    });

    socket.join(room.code);
    initGame(room);
    emitRoom(room);
    socket.emit("room:joined", {
      code: room.code,
      game: room.game
    });
  });

  socket.on("match:quick", ({ game, name } = {}) => {
    if (!games.has(game)) {
      return reject(socket, "Choose a supported game.");
    }

    leaveRoom(socket);

    const qi = queue.findIndex(q =>
      q.game === game &&
      q.id !== socket.id &&
      io.sockets.sockets.has(q.id)
    );

    if (qi !== -1) {
      const waiting = queue.splice(qi, 1)[0];
      const other = io.sockets.sockets.get(waiting.id);
      const room = emptyRoom(game, waiting.id, waiting.name, true);

      room.players.push({
        id: socket.id,
        name: cleanName(name),
        mark: 2
      });

      rooms.set(room.code, room);
      other.join(room.code);
      socket.join(room.code);
      initGame(room);

      other.emit("room:joined", { code: room.code, game });
      socket.emit("room:joined", { code: room.code, game });
      emitRoom(room);
    } else {
      queue.push({
        id: socket.id,
        game,
        name: cleanName(name)
      });

      socket.emit("match:waiting", { game });
    }

    io.emit("lobby:count", queue.length);
  });

  socket.on("match:cancel", () => {
    const i = queue.findIndex(q => q.id === socket.id);
    if (i !== -1) queue.splice(i, 1);

    socket.emit("match:cancelled");
    io.emit("lobby:count", queue.length);
  });

  socket.on("ships:place", ({ ships } = {}) => {
    const room = findRoomBySocket(socket.id);

    if (
      !room ||
      room.game !== "ships" ||
      room.status !== "placing"
    ) {
      return reject(socket, "Ship placement is not open right now.");
    }

    const idx = playerIndex(room, socket.id);
    const b = room.board;

    if (b.ready[idx]) {
      return reject(
        socket,
        "You are already ready. Ask for a rematch to change your fleet."
      );
    }

    const valid = validateShips(ships);

    if (!valid) {
      return reject(
        socket,
        "That fleet is invalid. Place ships of lengths 4, 3, 3, and 2 without overlap."
      );
    }

    b.fleets[idx] = valid.fleet;
    b.ships[idx] = valid.ships;
    room.message = `${room.players[idx].name} has placed their fleet.`;
    emitRoom(room);
  });

  socket.on("ships:ready", () => {
    const room = findRoomBySocket(socket.id);

    if (
      !room ||
      room.game !== "ships" ||
      room.status !== "placing"
    ) {
      return reject(socket, "Ship placement is not open right now.");
    }

    const idx = playerIndex(room, socket.id);
    const b = room.board;

    if (!b.ships[idx] || b.ships[idx].length !== 4) {
      return reject(socket, "Place all four ships before pressing Ready.");
    }

    b.ready[idx] = true;

    if (b.ready.every(Boolean)) {
      room.status = "playing";
      room.turn = 1;
      room.message = `${room.players[0].name} vs ${room.players[1].name} — battle starts! ${room.players[0].name} fires first.`;
    } else {
      room.message = `${room.players[idx].name} is ready. Waiting for the other player to finish placing ships.`;
    }

    emitRoom(room);
  });

  socket.on("game:move", payload => {
    const room = findRoomBySocket(socket.id);

    if (!room || room.status !== "playing") {
      return reject(socket, "You're not in an active match.");
    }

    const idx = playerIndex(room, socket.id);
    const p = idx + 1;
    const b = room.board;

    if (!myTurn(room, idx)) {
      return reject(socket, "Wait for your turn.");
    }

    if (room.game === "ttt") {
      const i = Number(payload?.index);

      if (!Number.isInteger(i) || i < 0 || i > 8 || b[i]) {
        return reject(socket, "That square isn't available.");
      }

      b[i] = p;
      const w = tttWinner(b);

      if (w) {
        finish(room, w, `${room.players[w - 1].name} wins!`);
      } else if (b.every(Boolean)) {
        finish(room, 0, "It's a draw!");
      } else {
        nextTurn(room);
        emitRoom(room);
      }
    } else if (room.game === "connect") {
      const c = Number(payload?.column);

      if (!Number.isInteger(c) || c < 0 || c > 6) {
        return reject(socket, "Choose a valid column.");
      }

      let pos = -1;

      for (let r = 5; r >= 0; r--) {
        if (!b[r * 7 + c]) {
          pos = r * 7 + c;
          break;
        }
      }

      if (pos < 0) {
        return reject(socket, "That column is full.");
      }

      b[pos] = p;

      if (c4Winner(b, p)) {
        finish(room, p, `${room.players[p - 1].name} connects four!`);
      } else if (b.every(Boolean)) {
        finish(room, 0, "It's a draw!");
      } else {
        nextTurn(room);
        emitRoom(room);
      }
    } else if (room.game === "ships") {
      const i = Number(payload?.index);

      if (!Number.isInteger(i) || i < 0 || i > 99 || b.shots[idx][i]) {
        return reject(socket, "You've already fired at that square.");
      }

      if (!b.fleets[1 - idx]) {
        return reject(socket, "Your opponent hasn't finished placing ships yet.");
      }

      b.shots[idx][i] = b.fleets[1 - idx][i] ? "H" : "M";

      if (b.shots[idx][i] === "H") {
        b.hits[idx]++;
      }

      const sunkCount = b.ships[1 - idx].filter(ship =>
        ship.every(cell => b.shots[idx][cell] === "H")
      ).length;

      if (b.hits[idx] >= 12) {
        finish(
          room,
          p,
          `${room.players[p - 1].name} destroyed the entire fleet!`
        );
      } else {
        nextTurn(room);

        room.message = b.shots[idx][i] === "H"
          ? (
              sunkCount > 0
                ? `Hit! ${sunkCount} of 4 enemy ships sunk.`
                : "Direct hit!"
            )
          : "Miss.";

        room.message += ` ${room.players[room.turn - 1].name}'s turn.`;
        emitRoom(room);
      }
    } else if (room.game === "pool") {
      if (
        payload?.poolShot !== true ||
        !Array.isArray(payload.balls) ||
        payload.balls.length < 1 ||
        payload.balls.length > 16
      ) {
        return reject(socket, "Invalid pool shot.");
      }

      if (b.ballInHand !== null && b.ballInHand !== idx) {
        return reject(socket, "Your opponent has ball-in-hand.");
      }

      const clean = [];
      const seen = new Set();

      for (const ball of payload.balls) {
        if (
          !ball ||
          !Number.isInteger(ball.id) ||
          ball.id < 0 ||
          ball.id > 15 ||
          seen.has(ball.id) ||
          typeof ball.x !== "number" ||
          typeof ball.y !== "number" ||
          !Number.isFinite(ball.x) ||
          !Number.isFinite(ball.y) ||
          ball.x < 0 ||
          ball.x > 100 ||
          ball.y < 0 ||
          ball.y > 100
        ) {
          return reject(socket, "Invalid pool ball state.");
        }

        seen.add(ball.id);
        clean.push({
          id: ball.id,
          x: ball.x,
          y: ball.y
        });
      }

      if (!seen.has(0)) {
        clean.unshift({ id: 0, x: 22, y: 50 });
      }

      const before = new Set(
        b.balls.filter(ball => ball.id !== 0).map(ball => ball.id)
      );

      const after = new Set(
        clean.filter(ball => ball.id !== 0).map(ball => ball.id)
      );

      const pocketedIds = [...before].filter(id => !after.has(id));
      const pocketedNow = pocketedIds.length;
      const first = Number.isInteger(payload.firstContact)
        ? payload.firstContact
        : null;

      const scratched = payload.scratched === true;
      const railAfterContact = payload.railAfterContact === true;
      const eightPocketed = pocketedIds.includes(8);
      const group = b.groups[idx];

      const ownRemainingBefore = group === "solids"
        ? [...before].filter(id => id >= 1 && id <= 7).length
        : group === "stripes"
          ? [...before].filter(id => id >= 9 && id <= 15).length
          : null;

      let foul = scratched || first === null;

      if (
        !foul &&
        group &&
        first !== 8 &&
        (
          (group === "solids" && first >= 9) ||
          (group === "stripes" && first >= 1 && first <= 7)
        )
      ) {
        foul = true;
      }

      if (!foul && group && first === 8 && ownRemainingBefore > 0) {
        foul = true;
      }

      if (!foul && pocketedNow === 0 && !railAfterContact) {
        foul = true;
      }

      b.balls = clean;
      b.shots[idx]++;
      b.pocketed[idx] += pocketedNow;

      if (eightPocketed) {
        const legalEight =
          !foul &&
          group !== null &&
          ownRemainingBefore === 0 &&
          first === 8;

        if (legalEight) {
          finish(
            room,
            p,
            `${room.players[p - 1].name} legally pocketed the 8-ball and wins!`
          );
        } else {
          finish(
            room,
            3 - p,
            `${room.players[p - 1].name} pocketed the 8-ball illegally. ${room.players[2 - p].name} wins!`
          );
        }
      } else if (foul) {
        b.ballInHand = 1 - idx;
        nextTurn(room);

        room.message = `${room.players[p - 1].name} fouled${scratched ? " (scratch)" : ""}. ${room.players[room.turn - 1].name} has ball-in-hand and may place the cue ball anywhere on the table.`;

        emitRoom(room);
      } else {
        b.ballInHand = null;

        // On an open table, the first legally pocketed object ball assigns solids/stripes.
        if (
          group === null &&
          pocketedIds.some(id => id >= 1 && id <= 15 && id !== 8)
        ) {
          const chosen = pocketedIds.find(
            id => id >= 1 && id <= 15 && id !== 8
          );

          b.groups[idx] = chosen <= 7 ? "solids" : "stripes";
          b.groups[1 - idx] =
            b.groups[idx] === "solids" ? "stripes" : "solids";
        }

        const keepsTurn =
          pocketedNow > 0 &&
          pocketedIds.some(id =>
            id !== 8 &&
            (
              b.groups[idx] === null ||
              (
                b.groups[idx] === "solids"
                  ? id >= 1 && id <= 7
                  : id >= 9 && id <= 15
              )
            )
          );

        if (keepsTurn) {
          room.message = `${room.players[p - 1].name} pocketed a ball and keeps the turn.`;
          emitRoom(room);
        } else {
          nextTurn(room);

          room.message = pocketedNow
            ? `${room.players[p - 1].name} pocketed an opponent's ball. ${room.players[room.turn - 1].name}'s turn.`
            : `No ball pocketed. ${room.players[room.turn - 1].name}'s turn.`;

          emitRoom(room);
        }
      }
    }
  });

  socket.on("pool:placeCue", ({ x, y } = {}) => {
    const room = findRoomBySocket(socket.id);

    if (!room || room.game !== "pool" || room.status !== "playing") {
      return reject(socket, "No active pool game.");
    }

    const idx = playerIndex(room, socket.id);
    const b = room.board;

    if (b.ballInHand !== idx || room.turn !== idx + 1) {
      return reject(socket, "You don't have ball-in-hand right now.");
    }

    if (
      typeof x !== "number" ||
      typeof y !== "number" ||
      !Number.isFinite(x) ||
      !Number.isFinite(y) ||
      x < 3 ||
      x > 97 ||
      y < 3 ||
      y > 97
    ) {
      return reject(socket, "Choose a spot on the table.");
    }

    const cue = b.balls.find(ball => ball.id === 0);

    if (!cue) {
      return reject(socket, "Cue ball is missing.");
    }

    const blocked = b.balls.some(
      ball => ball.id !== 0 && Math.hypot(ball.x - x, ball.y - y) < 3.2
    );

    if (blocked) {
      return reject(socket, "Cue ball cannot overlap another ball.");
    }

    cue.x = x;
    cue.y = y;
    b.ballInHand = null;

    room.message = `${room.players[idx].name} placed the cue ball. Their turn.`;
    emitRoom(room);
  });

  socket.on("game:restart", () => {
    const room = findRoomBySocket(socket.id);

    if (!room || room.players.length !== 2) {
      return reject(socket, "Both players need to be in the room to restart.");
    }

    initGame(room);
    emitRoom(room);
  });

  socket.on("room:leave", () => leaveRoom(socket));

  socket.on("disconnect", () => {
    const qi = queue.findIndex(q => q.id === socket.id);
    if (qi !== -1) queue.splice(qi, 1);

    leaveRoom(socket, "Your opponent disconnected. The match has ended.");
    io.emit("lobby:count", queue.length);
  });
});

server.listen(PORT, () => {
  console.log(`DUEL UP listening on port ${PORT}`);
});
