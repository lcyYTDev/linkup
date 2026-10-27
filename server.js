const express = require("express");
const http = require("http");
const path = require("path");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const PORT = process.env.PORT || 3000;
const rooms = new Map();

app.use(express.static(path.join(__dirname, "public")));
app.get("/health", (_req, res) => res.json({ ok: true, app: "Linkup" }));

function roomUsers(room) {
  const users = rooms.get(room);
  if (!users) return [];
  return [...users.entries()].map(([id, user]) => ({ id, name: user.name, mic: user.mic, camera: user.camera }));
}
function broadcastUsers(room) {
  io.to(room).emit("participants", roomUsers(room));
}

io.on("connection", socket => {
  socket.on("join-room", ({ room, name }, reply) => {
    room = String(room || "").trim().toUpperCase().replace(/[^A-Z0-9-]/g, "").slice(0, 24);
    name = String(name || "").trim().slice(0, 40);
    if (!name) return reply?.({ ok: false, error: "Enter your name first." });
    if (!room) return reply?.({ ok: false, error: "Enter a meeting code." });
    if (!rooms.has(room)) rooms.set(room, new Map());
    const users = rooms.get(room);
    if (users.size >= 12) return reply?.({ ok: false, error: "This demo room is full (12 participants max)." });

    const existing = [...users.keys()];
    socket.join(room);
    socket.data.room = room;
    socket.data.name = name;
    socket.data.host = users.size === 0;
    users.set(socket.id, { name, mic: true, camera: true, host: socket.data.host });
    reply?.({ ok: true, room, host: socket.data.host, existing: existing.map(id => ({ id, name: users.get(id)?.name || "Participant" })) });
    socket.to(room).emit("participant-joined", { id: socket.id, name, host: socket.data.host });
    broadcastUsers(room);
    io.to(room).emit("system-message", { text: `${name} joined the meeting.`, time: Date.now() });
  });

  socket.on("signal", ({ to, signal }) => {
    if (typeof to === "string" && signal) io.to(to).emit("signal", { from: socket.id, signal });
  });

  socket.on("chat-message", ({ text }) => {
    const room = socket.data.room;
    const clean = String(text || "").trim().slice(0, 1000);
    if (!room || !clean) return;
    io.to(room).emit("chat-message", { id: socket.id, name: socket.data.name || "Participant", text: clean, time: Date.now() });
  });

  socket.on("media-state", ({ mic, camera }) => {
    const room = socket.data.room;
    if (!room || !rooms.has(room)) return;
    const user = rooms.get(room).get(socket.id);
    if (user) {
      if (typeof mic === "boolean") user.mic = mic;
      if (typeof camera === "boolean") user.camera = camera;
      broadcastUsers(room);
    }
  });

  socket.on("kick-participant", ({ id }) => {
    const room = socket.data.room;
    if (!room || !socket.data.host || typeof id !== "string") return;
    const target = io.sockets.sockets.get(id);
    if (target && target.data.room === room && id !== socket.id) {
      target.emit("removed-from-room");
      target.leave(room);
      target.data.room = null;
      rooms.get(room)?.delete(id);
      broadcastUsers(room);
      io.to(room).emit("system-message", { text: `${target.data.name || "A participant"} was removed by the host.`, time: Date.now() });
    }
  });

  socket.on("end-meeting", () => {
    const room = socket.data.room;
    if (!room || !socket.data.host) return;
    io.to(room).emit("meeting-ended");
    const users = rooms.get(room);
    if (users) for (const id of users.keys()) {
      const s = io.sockets.sockets.get(id);
      if (s) { s.leave(room); s.data.room = null; }
    }
    rooms.delete(room);
  });

  socket.on("disconnect", () => {
    const room = socket.data.room;
    if (!room || !rooms.has(room)) return;
    const users = rooms.get(room);
    const wasHost = !!socket.data.host;
    users.delete(socket.id);
    if (users.size === 0) rooms.delete(room);
    else {
      if (wasHost) {
        const nextId = users.keys().next().value;
        const next = users.get(nextId);
        if (next) {
          next.host = true;
          const nextSocket = io.sockets.sockets.get(nextId);
          if (nextSocket) nextSocket.data.host = true;
        }
      }
      broadcastUsers(room);
      io.to(room).emit("system-message", { text: `${socket.data.name || "A participant"} left the meeting.`, time: Date.now() });
    }
  });
});



server.listen(PORT, "0.0.0.0", () => {
  console.log(`
========================================
          LINKUP HOSTING
========================================
  Status : Online
  Website: http://localhost:${PORT}
  Network: Listening for connections
  Port   : ${PORT}
========================================
Linkup successfully started hosting at http://localhost:${PORT}
`);
});
