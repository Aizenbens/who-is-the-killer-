const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http, {
    cors: { origin: "*" }
});

app.use(express.static(__dirname));

let rooms = {};

io.on('connection', (socket) => {
    socket.on('joinRoom', (data) => {
        let roomId = "main-room"; 
        socket.join(roomId);
        if (!rooms[roomId]) rooms[roomId] = { players: [], roles: {}, started: false };
        
        if (!rooms[roomId].players.find(p => p.id === socket.id)) {
            rooms[roomId].players.push({ id: socket.id, name: data.name });
        }
        io.to(roomId).emit('updatePlayers', rooms[roomId].players);
    });

    socket.on('startGame', () => {
        let roomId = "main-room";
        let room = rooms[roomId];
        if (!room || room.players.length < 4) return;

        let rolesPool = ["🐺 ذئب خفي", "🔍 محقق سيبراني", "🧪 طبيب معالج", "🧑‍🌾 مواطن بريء"];
        while (rolesPool.length < room.players.length) {
            rolesPool.push("🧑‍🌾 مواطن بريء");
        }
        rolesPool.sort(() => Math.random() - 0.5);

        room.players.forEach((player, idx) => {
            room.roles[player.id] = rolesPool[idx];
            io.to(player.id).emit('yourRole', rolesPool[idx]);
        });
        io.to(roomId).emit('gameStarted');
    });

    socket.on('disconnect', () => {
        for (let roomId in rooms) {
            rooms[roomId].players = rooms[roomId].players.filter(p => p.id !== socket.id);
            io.to(roomId).emit('updatePlayers', rooms[roomId].players);
        }
    });
});

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => console.log(`Server running on port ${PORT}`));
