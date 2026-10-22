const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");
const crypto = require("crypto");

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: false }, pingInterval: 25000, pingTimeout: 20000 });
const PORT = process.env.PORT || 3000;
const rooms = new Map();
const queue = [];
const games = new Set(["ttt", "connect", "ships", "pong", "pool"]);

app.disable("x-powered-by");
app.use(express.static(path.join(__dirname, "public")));
app.get("/health", (_req, res) => res.json({ ok: true, service: "DUEL UP", rooms: rooms.size }));

function code() { return crypto.randomBytes(3).toString("hex").toUpperCase(); }
function cleanName(v) { return String(v || "Player").replace(/[<>]/g, "").trim().slice(0, 18) || "Player"; }
function emptyRoom(game, host, name, isPublic = false) {
  return {
    code: code(), game, public: isPublic, players: [{ id: host, name, mark: 1 }],
    board: null, turn: 1, status: "waiting", winner: null, message: "Waiting for another player…",
    state: {}, createdAt: Date.now()
  };
}
function initGame(room) {
  room.status = "playing"; room.winner = null; room.turn = 1;
  if (room.game === "ttt") room.board = Array(9).fill(0);
  if (room.game === "connect") room.board = Array(42).fill(0);
  if (room.game === "ships") {
    room.board = { shots: [Array(100).fill(""), Array(100).fill("")], fleets: [fleet(), fleet()], hits: [0,0] };
  }
  if (room.game === "pong") room.board = { cups: [Array(6).fill(false), Array(6).fill(false)], throws: [0,0] };
  if (room.game === "pool") room.board = { balls: poolRack(), shots: [0,0], pocketed: [0,0] };
  room.message = `${room.players[0].name} vs ${room.players[1].name} — ${room.players[0].name}'s turn.`;
}
function fleet() {
  const b = Array(100).fill(false);
  for (const len of [4,3,3,2]) {
    let placed = false, tries = 0;
    while (!placed && tries++ < 1000) {
      const horizontal = Math.random() < .5, r = Math.floor(Math.random()*10), c = Math.floor(Math.random()*10);
      const cells = [];
      for (let k=0;k<len;k++) {
        const rr=r+(horizontal?0:k), cc=c+(horizontal?k:0);
        if (rr>9 || cc>9) { cells.length=0; break; }
        cells.push(rr*10+cc);
      }
      if (cells.length && cells.every(i=>!b[i])) { cells.forEach(i=>b[i]=true); placed=true; }
    }
  }
  return b;
}
function poolRack() {
  const balls=[];
  for(let i=0;i<9;i++) balls.push({id:i+1,x:64+Math.floor(i/3)*7,y:30+(i%3)*18});
  return balls;
}
function playerIndex(room, id) { return room.players.findIndex(p=>p.id===id); }
function snapshot(room) {
  // Never send either Battleship fleet to clients.
  const board = room.board ? JSON.parse(JSON.stringify(room.board)) : null;
  if (room.game === "ships" && board) delete board.fleets;
  return {
    code: room.code, game: room.game, players: room.players.map((p,i)=>({id:p.id, name:p.name, mark:i+1, connected:io.sockets.sockets.has(p.id)})),
    status: room.status, turn: room.turn, winner: room.winner, message: room.message, board
  };
}
function emitRoom(room) { io.to(room.code).emit("room:update", snapshot(room)); }
function findRoomBySocket(id) { for (const room of rooms.values()) if (playerIndex(room,id)!==-1) return room; return null; }
function closeRoom(room, message) {
  room.status = "finished"; room.winner = 0; room.message = message; emitRoom(room);
}
function leaveRoom(socket, reason = "A player left the room.") {
  const room = findRoomBySocket(socket.id);
  if (!room) return;
  socket.leave(room.code);
  const idx = playerIndex(room,socket.id);
  if (idx !== -1) room.players.splice(idx,1);
  if (room.players.length === 0) rooms.delete(room.code);
  else {
    room.status = "finished"; room.winner = 0; room.message = reason;
    emitRoom(room);
    // A finished room is retained briefly so the remaining player sees the message.
    setTimeout(()=>{ if (rooms.get(room.code)===room && room.players.length<2) rooms.delete(room.code); }, 60000);
  }
  io.emit("lobby:count", queue.length);
}
function finish(room, winner, message) {
  room.status="finished"; room.winner=winner; room.message=message; emitRoom(room);
}
function nextTurn(room) { room.turn = room.turn===1 ? 2 : 1; room.message = `${room.players[room.turn-1]?.name || "Player"}'s turn.`; }
function tttWinner(b) {
  for(const [a,c,d] of [[0,1,2],[3,4,5],[6,7,8],[0,3,6],[1,4,7],[2,5,8],[0,4,8],[2,4,6]]) if(b[a] && b[a]===b[c] && b[a]===b[d]) return b[a];
  return 0;
}
function c4Winner(b,p) {
  for(let r=0;r<6;r++) for(let c=0;c<7;c++) {
    if(b[r*7+c]!==p) continue;
    for(const [dr,dc] of [[0,1],[1,0],[1,1],[1,-1]]) {
      let ok=true;
      for(let k=1;k<4;k++){const rr=r+dr*k,cc=c+dc*k;if(rr<0||rr>=6||cc<0||cc>=7||b[rr*7+cc]!==p){ok=false;break;}}
      if(ok)return true;
    }
  }
  return false;
}
function myTurn(room, idx) { return room.turn === idx+1; }
function reject(socket, msg) { socket.emit("action:error", msg); }
io.on("connection", socket => {
  socket.emit("lobby:count", queue.length);
  socket.on("room:create", ({game,name}={}) => {
    if (!games.has(game)) return reject(socket,"Choose a supported game.");
    leaveRoom(socket, "A player left the room.");
    const room=emptyRoom(game,socket.id,cleanName(name));
    rooms.set(room.code,room); socket.join(room.code);
    socket.emit("room:created",{code:room.code,game});
    emitRoom(room);
  });
  socket.on("room:join", ({code:raw,name}={}) => {
    const codeValue=String(raw||"").trim().toUpperCase();
    const room=rooms.get(codeValue);
    if(!room)return reject(socket,"That room code wasn't found. Ask your friend to create a room first.");
    if(room.players.length>=2)return reject(socket,"That room is already full.");
    if(room.status==="playing")return reject(socket,"That match has already started.");
    leaveRoom(socket,"A player left the room.");
    room.players.push({id:socket.id,name:cleanName(name),mark:2});
    socket.join(room.code); initGame(room); emitRoom(room);
    socket.emit("room:joined",{code:room.code,game:room.game});
  });
  socket.on("match:quick", ({game,name}={}) => {
    if(!games.has(game))return reject(socket,"Choose a supported game.");
    leaveRoom(socket);
    const qi=queue.findIndex(q=>q.game===game && q.id!==socket.id && io.sockets.sockets.has(q.id));
    if(qi!==-1){
      const waiting=queue.splice(qi,1)[0], other=io.sockets.sockets.get(waiting.id);
      const room=emptyRoom(game,waiting.id,waiting.name,true); room.players.push({id:socket.id,name:cleanName(name),mark:2});
      rooms.set(room.code,room); other.join(room.code); socket.join(room.code); initGame(room);
      other.emit("room:joined",{code:room.code,game}); socket.emit("room:joined",{code:room.code,game}); emitRoom(room);
    } else {
      queue.push({id:socket.id,game,name:cleanName(name)});
      socket.emit("match:waiting",{game});
    }
    io.emit("lobby:count",queue.length);
  });
  socket.on("match:cancel",()=>{
    const i=queue.findIndex(q=>q.id===socket.id);if(i!==-1)queue.splice(i,1);
    socket.emit("match:cancelled");io.emit("lobby:count",queue.length);
  });
  socket.on("game:move", payload => {
    const room=findRoomBySocket(socket.id);if(!room||room.status!=="playing")return reject(socket,"You're not in an active match.");
    const idx=playerIndex(room,socket.id), p=idx+1, b=room.board;
    if(!myTurn(room,idx))return reject(socket,"Wait for your turn.");
    if(room.game==="ttt"){
      const i=Number(payload?.index);
      if(!Number.isInteger(i)||i<0||i>8||b[i])return reject(socket,"That square isn't available.");
      b[i]=p;const w=tttWinner(b);
      if(w)finish(room,w,`${room.players[w-1].name} wins!`);
      else if(b.every(Boolean))finish(room,0,"It's a draw!");
      else {nextTurn(room);emitRoom(room);}
    } else if(room.game==="connect"){
      const c=Number(payload?.column);
      if(!Number.isInteger(c)||c<0||c>6)return reject(socket,"Choose a valid column.");
      let pos=-1;for(let r=5;r>=0;r--)if(!b[r*7+c]){pos=r*7+c;break;}
      if(pos<0)return reject(socket,"That column is full.");
      b[pos]=p;
      if(c4Winner(b,p))finish(room,p,`${room.players[p-1].name} connects four!`);
      else if(b.every(Boolean))finish(room,0,"It's a draw!");
      else {nextTurn(room);emitRoom(room);}
    } else if(room.game==="ships"){
      const i=Number(payload?.index);
      if(!Number.isInteger(i)||i<0||i>99||b.shots[idx][i])return reject(socket,"You've already fired at that square.");
      b.shots[idx][i]=b.fleets[1-idx][i]?"H":"M";
      if(b.shots[idx][i]==="H")b.hits[idx]++;
      if(b.hits[idx]>=12)finish(room,p,`${room.players[p-1].name} destroyed the fleet!`);
      else {nextTurn(room);room.message=b.shots[idx][i]==="H"?"Direct hit!": "Miss.";room.message+=` ${room.players[room.turn-1].name}'s turn.`;emitRoom(room);}
    } else if(room.game==="pong"){
      const i=Number(payload?.cup);
      if(!Number.isInteger(i)||i<0||i>5||b.cups[idx][i]||b.throws[idx]>=10)return reject(socket,"That cup isn't available.");
      b.throws[idx]++;
      const success=Boolean(payload?.success); // Server clamps client result to a per-throw chance.
      const hit=success && Math.random()<0.82;
      if(hit)b.cups[idx][i]=true;
      if(b.cups[idx].every(Boolean))finish(room,p,`${room.players[p-1].name} cleared all the cups!`);
      else if(b.throws[idx]>=10)finish(room,3-p,`${room.players[p-1].name} ran out of throws.`);
      else {nextTurn(room);room.message=hit?"Splash! Cup sunk.":"Miss!";emitRoom(room);}
    } else if(room.game==="pool"){
      if(typeof payload?.angle!=="number"||typeof payload?.power!=="number")return reject(socket,"Invalid shot.");
      if(Math.abs(payload.angle)>55||payload.power<1||payload.power>10)return reject(socket,"Invalid shot settings.");
      b.shots[idx]++;
      // Lightweight arcade shot: server owns the random outcome and shared ball state.
      let hit=null;
      if(b.balls.length && Math.random()<0.25+payload.power*0.055)hit=b.balls.splice(Math.floor(Math.random()*b.balls.length),1)[0];
      if(hit)b.pocketed[idx]++;
      if(!b.balls.length)finish(room,p,`${room.players[p-1].name} cleared the table!`);
      else {nextTurn(room);room.message=hit?`Ball ${hit.id} pocketed!`:"No ball pocketed.";emitRoom(room);}
    }
  });
  socket.on("game:restart",()=>{
    const room=findRoomBySocket(socket.id);if(!room||room.players.length!==2)return reject(socket,"Both players need to be in the room to restart.");
    initGame(room);emitRoom(room);
  });
  socket.on("room:leave",()=>leaveRoom(socket));
  socket.on("disconnect",()=>{
    const qi=queue.findIndex(q=>q.id===socket.id);if(qi!==-1)queue.splice(qi,1);
    leaveRoom(socket,"Your opponent disconnected. The match has ended.");
    io.emit("lobby:count",queue.length);
  });
});
server.listen(PORT,()=>console.log(`DUEL UP listening on port ${PORT}`));
