const express = require('express');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));

const MAX_TOTAL_USERS = 20;
const DB_FILE = path.join(__dirname, 'database.json');

function loadDB() {
  if (!fs.existsSync(DB_FILE)) {
    const initialData = {
      knownUsers: {},     // name -> { name, ntfyTopic } (記錄曾經使用推播登入過的成員)
      confirmedPairs: [], // ["userA_userB", ...]
      pendingPairs: {}    // "userA_userB" -> { pin, setter }
    };
    fs.writeFileSync(DB_FILE, JSON.stringify(initialData, null, 2));
    return initialData;
  }
  return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
}

function saveDB(data) {
  fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
}

let db = loadDB();

let rooms = {};
for (let i = 1; i <= 5; i++) {
  rooms[i] = { id: i, name: `房間 ${i}`, adminId: null, adminName: null, members: [] };
}

let onlineUsers = {}; // socketId -> { id, name, ntfyTopic, currentRoom }

function getPairKey(name1, name2) {
  return [name1, name2].sort().join('_');
}

function getTotalInRoomUsers() {
  let count = 0;
  for (let i = 1; i <= 5; i++) count += rooms[i].members.length;
  return count;
}

function broadcastState() {
  const onlineList = Object.values(onlineUsers);
  const onlineNames = new Set(onlineList.map(u => u.name));

  // 合併目前線上成員 + 曾經綁定過 ntfy 推播的離線成員
  const contactMap = {};
  Object.values(db.knownUsers).forEach(u => {
    contactMap[u.name] = { name: u.name, ntfyTopic: u.ntfyTopic, isOnline: onlineNames.has(u.name) };
  });
  onlineList.forEach(u => {
    contactMap[u.name] = { name: u.name, ntfyTopic: u.ntfyTopic, isOnline: true };
  });

  io.emit('stateUpdate', {
    rooms,
    totalUsers: getTotalInRoomUsers(),
    maxUsers: MAX_TOTAL_USERS,
    onlineUsers: onlineList,
    contactList: Object.values(contactMap),
    confirmedPairs: db.confirmedPairs
  });
}

function handleLeaveRoom(socketId, nextAdminId = null) {
  const user = onlineUsers[socketId];
  if (!user || !user.currentRoom) return;

  const roomId = user.currentRoom;
  const room = rooms[roomId];
  if (!room) return;

  room.members.forEach(m => {
    if (m.id !== socketId) io.to(m.id).emit('userLeftVideo', socketId);
  });

  room.members = room.members.filter(m => m.id !== socketId);
  user.currentRoom = null;

  if (room.adminId === socketId) {
    if (room.members.length === 0) {
      room.adminId = null;
      room.adminName = null;
    } else if (nextAdminId && room.members.some(m => m.id === nextAdminId)) {
      const nextAdmin = room.members.find(m => m.id === nextAdminId);
      room.adminId = nextAdmin.id;
      room.adminName = nextAdmin.name;
      io.to(nextAdmin.id).emit('notification', `你已被指定為【${room.name}】的新管理者！`);
    } else {
      const nextAdmin = room.members;
      room.adminId = nextAdmin.id;
      room.adminName = nextAdmin.name;
      io.to(nextAdmin.id).emit('notification', `原管理者已離開，系統自動由你接任【${room.name}】管理者！`);
    }
  }
  broadcastState();
}

io.on('connection', (socket) => {
  // 免註冊、免密碼直接登入
  socket.on('quickLogin', ({ name, ntfyTopic }) => {
    const cleanName = (name || '').trim();
    const cleanTopic = (ntfyTopic || '').trim();
    if (!cleanName) return socket.emit('loginError', '請輸入你的稱呼！');

    const alreadyOnline = Object.values(onlineUsers).find(u => u.name === cleanName);
    if (alreadyOnline) return socket.emit('loginError', '這個稱呼目前已在線上使用中，請換一個稱呼！');

    onlineUsers[socket.id] = {
      id: socket.id,
      name: cleanName,
      ntfyTopic: cleanTopic,
      currentRoom: null
    };

    // 若有填寫 ntfy 頻道，記錄下來方便離線時也能被呼叫
    if (cleanTopic) {
      db.knownUsers[cleanName] = { name: cleanName, ntfyTopic: cleanTopic };
      saveDB(db);
    }

    socket.emit('loginSuccess', onlineUsers[socket.id]);
    broadcastState();
  });

  socket.on('updateNtfy', (newTopic) => {
    const user = onlineUsers[socket.id];
    if (!user) return;
    const cleanTopic = (newTopic || '').trim();
    user.ntfyTopic = cleanTopic;
    if (cleanTopic) {
      db.knownUsers[user.name] = { name: user.name, ntfyTopic: cleanTopic };
    } else {
      delete db.knownUsers[user.name];
    }
    saveDB(db);
    socket.emit('notification', `已更新你的 ntfy 推播頻道為：${cleanTopic || '(已清除)'}`);
    broadcastState();
  });

  socket.on('requestJoinRoom', (roomId) => {
    const user = onlineUsers[socket.id];
    const room = rooms[roomId];
    if (!user || !room) return;

    if (getTotalInRoomUsers() >= MAX_TOTAL_USERS) return socket.emit('notification', '全站視訊人數已達 20 人上限！');
    if (user.currentRoom) return socket.emit('notification', '你目前已經在房間內了，請先離開目前房間。');

    if (room.members.length === 0) {
      room.adminId = socket.id;
      room.adminName = user.name;
      room.members.push({ id: socket.id, name: user.name, joinTime: Date.now() });
      user.currentRoom = roomId;
      socket.emit('enteredRoom', { roomId, existingMembers: [] });
      broadcastState();
    } else {
      socket.emit('notification', `已向管理者【${room.adminName}】發送進入申請，請等待同意...`);
      io.to(room.adminId).emit('joinRequestToAdmin', { roomId, applicantId: socket.id, applicantName: user.name });
    }
  });

  socket.on('adminDecision', ({ roomId, applicantId, approved }) => {
    const room = rooms[roomId];
    const applicant = onlineUsers[applicantId];
    if (!room || !applicant || room.adminId !== socket.id) return;

    if (!approved) return io.to(applicantId).emit('notification', `管理者【${room.adminName}】婉拒了你的進入申請。`);
    if (getTotalInRoomUsers() >= MAX_TOTAL_USERS) return io.to(applicantId).emit('notification', '全站已達 20 人上限，無法進入。');

    const existingMembers = room.members.map(m => ({ id: m.id, name: m.name }));
    room.members.push({ id: applicant.id, name: applicant.name, joinTime: Date.now() });
    applicant.currentRoom = roomId;
    io.to(applicantId).emit('enteredRoom', { roomId, existingMembers });
    broadcastState();
  });

  socket.on('webrtcOffer', ({ targetId, offer }) => {
    const sender = onlineUsers[socket.id];
    io.to(targetId).emit('webrtcOffer', { senderId: socket.id, senderName: sender ? sender.name : '成員', offer });
  });

  socket.on('webrtcAnswer', ({ targetId, answer }) => {
    io.to(targetId).emit('webrtcAnswer', { senderId: socket.id, answer });
  });

  socket.on('webrtcIceCandidate', ({ targetId, candidate }) => {
    io.to(targetId).emit('webrtcIceCandidate', { senderId: socket.id, candidate });
  });

  socket.on('leaveRoom', ({ nextAdminId }) => handleLeaveRoom(socket.id, nextAdminId));

  socket.on('setupCallPair', ({ targetName, pin }) => {
    const user = onlineUsers[socket.id];
    if (!user) return;
    const key = getPairKey(user.name, targetName);

    if (db.confirmedPairs.includes(key)) return socket.emit('notification', `你與【${targetName}】已完成配對，可直接呼叫！`);

    if (!db.pendingPairs[key]) {
      db.pendingPairs[key] = { pin, setter: user.name };
      saveDB(db);
      socket.emit('notification', `已設定與【${targetName}】的配對密碼（${pin}），請通知對方輸入相同四位數密碼以完成綁定。`);
    } else if (db.pendingPairs[key].setter === user.name) {
      db.pendingPairs[key].pin = pin;
      saveDB(db);
      socket.emit('notification', `已更新配對密碼為 ${pin}。`);
    } else if (db.pendingPairs[key].pin === pin) {
      db.confirmedPairs.push(key);
      delete db.pendingPairs[key];
      saveDB(db);
      socket.emit('pairSuccess', targetName);
      const targetUser = Object.values(onlineUsers).find(u => u.name === targetName);
      if (targetUser) io.to(targetUser.id).emit('pairSuccess', user.name);
      broadcastState();
    } else {
      socket.emit('notification', `密碼不符！請確認雙方輸入相同的四位數密碼。`);
    }
  });

  socket.on('triggerNtfyCall', async ({ targetName }) => {
    const user = onlineUsers[socket.id];
    if (!user) return;

    const key = getPairKey(user.name, targetName);
    if (!db.confirmedPairs.includes(key)) return socket.emit('requirePairModal', targetName);

    const onlineTarget = Object.values(onlineUsers).find(u => u.name === targetName);
    const knownTarget = db.knownUsers[targetName];
    const targetTopic = (onlineTarget && onlineTarget.ntfyTopic) || (knownTarget && knownTarget.ntfyTopic);

    if (!targetTopic) {
      return socket.emit('notification', `【${targetName}】登入時未填寫 ntfy 推播頻道，無法發送手機通知。`);
    }

    try {
      const response = await fetch(`https://ntfy.sh{encodeURIComponent(targetTopic)}`, {
        method: 'POST',
        body: `【${user.name}】正在視訊網站呼叫你！快打開網頁加入吧！`,
        headers: { 'Title': 'Video Call Alert', 'Priority': 'high', 'Tags': 'telephone_receiver' }
      });
      if (!response.ok) throw new Error(`狀態碼 ${response.status}`);
      socket.emit('notification', `已成功發送手機/平板推播通知給【${targetName}】！`);
    } catch (err) {
      socket.emit('notification', `推播發送失敗（${err.message}），請確認 ntfy 頻道名稱為純英文數字！`);
    }
  });

  socket.on('disconnect', () => {
    handleLeaveRoom(socket.id, null);
    delete onlineUsers[socket.id];
    broadcastState();
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`網站已啟動！連接埠：${PORT}`));