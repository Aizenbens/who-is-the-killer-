const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http, { cors: { origin: "*" } });

app.use(express.static(__dirname));
let rooms = {};

io.on('connection', (socket) => {
    socket.on('joinRoom', (data) => {
        let roomId = "main-room"; 
        socket.join(roomId);
        if (!rooms[roomId]) rooms[roomId] = { players: [], roles: {}, alive: {}, votes: {}, nightActions: { target: null, protect: null }, phase: "lobby", currentSpeakerIndex: 0 };
        
        if (!rooms[roomId].players.find(p => p.id === socket.id)) {
            rooms[roomId].players.push({ id: socket.id, name: data.name });
        }
        io.to(roomId).emit('updatePlayers', rooms[roomId].players);
    });

    socket.on('sendMessage', (msg) => {
        let room = rooms["main-room"];
        if(!room || room.phase !== "discussion") return;
        
        // التحقق من أن هذا اللاعب هو من يملك حق الكلام حالياً
        let currentSpeaker = room.players.filter(p => room.alive[p.id])[room.currentSpeakerIndex];
        if (currentSpeaker && currentSpeaker.id === socket.id) {
            io.to("main-room").emit('receiveMessage', { name: currentSpeaker.name, text: msg });
        }
    });

    socket.on('startGame', () => {
        let roomId = "main-room";
        let room = rooms[roomId];
        if (!room || room.players.length < 4) return;

        room.votes = {};
        room.nightActions = { target: null, protect: null };
        room.phase = "night";

        let count = room.players.length;
        let rolesPool = ["🧪 ساحرة معالجة"];
        let wolvesCount = count >= 7 ? 2 : 1; 
        for(let i=0; i<wolvesCount; i++) rolesPool.push("🐺 ذئب خفي");
        while(rolesPool.length < count) rolesPool.push("🧑‍🌾 مواطن بريء");
        
        rolesPool.sort(() => Math.random() - 0.5);

        room.players.forEach((player, idx) => {
            room.roles[player.id] = rolesPool[idx];
            room.alive[player.id] = true;
            io.to(player.id).emit('yourRole', { role: rolesPool[idx], id: player.id });
        });

        io.to(roomId).emit('gameStarted');
        startNightPhase(room);
    });

    socket.on('wolfAttack', ({ targetId }) => {
        let room = rooms["main-room"];
        if(!room || room.phase !== "night") return;
        room.nightActions.target = targetId;
        checkNightEnded(room);
    });

    socket.on('witchProtect', ({ targetId }) => {
        let room = rooms["main-room"];
        if(!room || room.phase !== "night") return;
        room.nightActions.protect = targetId;
        checkNightEnded(room);
    });

    // القائد يطلب الانتقال للاعب التالي في حال أنهى كلامه مبكراً
    socket.on('nextSpeakerRequest', () => {
        let room = rooms["main-room"];
        if(!room || room.phase !== "discussion") return;
        let leader = room.players[0];
        if(socket.id === leader.id) {
            nextSpeaker(room);
        }
    });

    socket.on('submitVote', ({ targetId }) => {
        let room = rooms["main-room"];
        if (!room || room.phase !== "voting") return;
        room.votes[socket.id] = targetId;
        
        let aliveCount = room.players.filter(p => room.alive[p.id]).length;
        if (Object.keys(room.votes).length === aliveCount) {
            calculateVotingResult(room);
        }
    });

    socket.on('disconnect', () => {
        for (let roomId in rooms) {
            rooms[roomId].players = rooms[roomId].players.filter(p => p.id !== socket.id);
            io.to(roomId).emit('updatePlayers', rooms[roomId].players);
        }
    });
});

function startNightPhase(room) {
    room.phase = "night";
    room.votes = {};
    let alivePlayers = room.players.filter(p => room.alive[p.id]);
    io.to("main-room").emit('nightStarted', { alivePlayers });
}

function checkNightEnded(room) {
    let hasWitch = Object.values(room.roles).includes("🧪 ساحرة معالجة") && room.players.some(p => room.roles[p.id] === "🧪 ساحرة معالجة" && room.alive[p.id]);
    if (room.nightActions.target && (!hasWitch || room.nightActions.protect)) {
        endNight(room);
    }
}

function endNight(room) {
    let killedName = "لم يمت أحد في هذه الليلة! 🎉";
    let killedId = null;

    if (room.nightActions.target && room.nightActions.target !== room.nightActions.protect) {
        killedId = room.nightActions.target;
        room.alive[killedId] = false;
        let deadPlayer = room.players.find(p => p.id === killedId);
        if(deadPlayer) killedName = `💀 للاسف، تم تصفية اللاعب: [ ${deadPlayer.name} ]`;
    }

    room.nightActions = { target: null, protect: null };
    
    if (checkGameEnd(room)) return;

    room.phase = "discussion";
    room.currentSpeakerIndex = 0; // بدء الدور من أول لاعب حي

    let alivePlayers = room.players.filter(p => room.alive[p.id]);
    io.to("main-room").emit('dayStarted', { killedMessage: killedName, alivePlayers });
    
    // تشغيل أول دور للكلام
    sendSpeakerTurn(room);
}

function sendSpeakerTurn(room) {
    let alivePlayers = room.players.filter(p => room.alive[p.id]);
    
    if (room.currentSpeakerIndex >= alivePlayers.length) {
        // انتهى دور الجميع، ننتقل للتصويت
        room.phase = "voting";
        io.to("main-room").emit('votingStarted');
        return;
    }

    let currentSpeaker = alivePlayers[room.currentSpeakerIndex];
    io.to("main-room").emit('speakerTurn', { 
        speakerName: currentSpeaker.name, 
        speakerId: currentSpeaker.id 
    });
}

function nextSpeaker(room) {
    room.currentSpeakerIndex++;
    sendSpeakerTurn(room);
}

function calculateVotingResult(room) {
    let counts = {};
    Object.values(room.votes).forEach(t => { if(t !== 'skip') counts[t] = (counts[t] || 0) + 1; });
    
    let highest = 0, eliminated = null, isTie = false;
    for (let p in counts) {
        if (counts[p] > highest) { highest = counts[p]; eliminated = p; isTie = false; }
        else if (counts[p] === highest) { isTie = true; }
    }

    let resultMsg = "⚖️ تعادلت الأصوات ولم يُطرد أحد!";
    if (!isTie && eliminated) {
        room.alive[eliminated] = false;
        let targetPlayer = room.players.find(p => p.id === eliminated);
        resultMsg = `💀 قررت المحكمة طرد اللاعب: [ ${targetPlayer ? targetPlayer.name : ''} ]<br>ودوره الحقيقي: ${room.roles[eliminated]}`;
    }

    io.to("main-room").emit('votingResult', { resultMsg });

    if (!checkGameEnd(room)) {
        setTimeout(() => { startNightPhase(room); }, 7000);
    }
}

function checkGameEnd(room) {
    let wolves = 0;
    let innocents = 0;

    room.players.forEach(p => {
        if (room.alive[p.id]) {
            if (room.roles[p.id].includes("ذئب")) wolves++;
            else innocents++;
        }
    });

    if (wolves === 0) {
        io.to("main-room").emit('gameOver', { winner: "🎉 الأبرياء والساحرة! تم القضاء على جميع الذئاب." });
        return true;
    }
    if (wolves >= innocents || (wolves === 1 && innocents === 1)) {
        io.to("main-room").emit('gameOver', { winner: "🐺 الذئاب الرقمية! لقد تغلبت الذئاب على القرية." });
        return true;
    }
    return false;
}

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => console.log(`Server running on port ${PORT}`));
