const express = require('express');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.static(path.join(__dirname, 'public')));

const MAX_TOTAL_USERS = 20;
const DB_FILE = path.join(__dirname, 'database.json');

function loadDB() {
  if (!fs.existsSync(DB_FILE)) {
    const init = { knownUsers: {}, confirmedPairs: [], pendingPairs: {} };
    fs.writeFileSync(DB_FILE, JSON.stringify(init, null, 2));
    return init;
  }
  return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
}
function saveDB(data) { fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2)); }

let db = loadDB();
let rooms = {};
for (let i = 1; i <= 5; i++) rooms[i] = { id: i, name: `房間 ${i}`, adminId: null, adminName: null, members: [] };
let onlineUsers = {};

function getPairKey(a, b) { return [a, b].sort().join('_'); }
function getTotalUsers() { return Object.values(rooms).reduce((sum, r) => sum + r.members.length, 0); }

function broadcastState() {
  const onlineList = Object.values(onlineUsers);
  const onlineNames = new Set(onlineList.map(u => u.name));
  const contactMap = {};
  Object.values(db.knownUsers).forEach(u => { contactMap[u.name] = { name: u.name, ntfyTopic: u.ntfyTopic, isOnline: onlineNames.has(u.name) }; });
  onlineList.forEach(u => { contactMap[u.name] = { name: u.name, ntfyTopic: u.ntfyTopic, isOnline: true }; });

  io.emit('stateUpdate', {
    rooms, totalUsers: getTotalUsers(), maxUsers: MAX_TOTAL_USERS,
    onlineUsers: onlineList, contactList: Object.values(contactMap), confirmedPairs: db.confirmedPairs
  });
}

function handleLeaveRoom(socketId, nextAdminId = null) {
  const user = onlineUsers[socketId];
  if (!user || !user.currentRoom) return;
  const room = rooms[user.currentRoom];
  if (!room) return;

  room.members.forEach(m => { if (m.id !== socketId) io.to(m.id).emit('userLeftVideo', socketId); });
  room.members = room.members.filter(m => m.id !== socketId);
  user.currentRoom = null;

  if (room.adminId === socketId) {
    if (room.members.length === 0) { room.adminId = null; room.adminName = null; }
    else {
      const next = (nextAdminId && room.members.find(m => m.id === nextAdminId)) || room.members[0];
      room.adminId = next.id;
      room.adminName = next.name;
      io.to(next.id).emit('notification', `你已成為【${room.name}】的新管理者！`);
    }
  }
  broadcastState();
}

io.on('connection', (socket) => {
  socket.on('quickLogin', ({ name, ntfyTopic }) => {
    const cleanName = (name || '').trim(), cleanTopic = (ntfyTopic || '').trim();
    if (!cleanName) return socket.emit('loginError', '請輸入稱呼！');
    if (Object.values(onlineUsers).find(u => u.name === cleanName)) return socket.emit('loginError', '此稱呼目前已在線上！');
    onlineUsers[socket.id] = { id: socket.id, name: cleanName, ntfyTopic: cleanTopic, currentRoom: null };
    if (cleanTopic) { db.knownUsers[cleanName] = { name: cleanName, ntfyTopic: cleanTopic }; saveDB(db); }
    socket.emit('loginSuccess', onlineUsers[socket.id]);
    broadcastState();
  });

  socket.on('updateNtfy', (newTopic) => {
    const user = onlineUsers[socket.id]; if (!user) return;
    user.ntfyTopic = (newTopic || '').trim();
    if (user.ntfyTopic) db.knownUsers[user.name] = { name: user.name, ntfyTopic: user.ntfyTopic };
    else delete db.knownUsers[user.name];
    saveDB(db); socket.emit('notification', '已更新推播頻道！'); broadcastState();
  });

  socket.on('requestJoinRoom', (roomId) => {
    const user = onlineUsers[socket.id], room = rooms[roomId];
    if (!user || !room) return;
    if (getTotalUsers() >= MAX_TOTAL_USERS) return socket.emit('notification', '全站已達 20 人上限！');
    if (user.currentRoom) return socket.emit('notification', '你已在房間內！');
    if (room.members.length === 0) {
      room.adminId = socket.id; room.adminName = user.name;
      room.members.push({ id: socket.id, name: user.name }); user.currentRoom = roomId;
      socket.emit('enteredRoom', { roomId, existingMembers: [] }); broadcastState();
    } else {
      socket.emit('notification', `已向管理者【${room.adminName}】發送申請...`);
      io.to(room.adminId).emit('joinRequestToAdmin', { roomId, applicantId: socket.id, applicantName: user.name });
    }
  });

  socket.on('adminDecision', ({ roomId, applicantId, approved }) => {
    const room = rooms[roomId], applicant = onlineUsers[applicantId];
    if (!room || !applicant || room.adminId !== socket.id) return;
    if (!approved) return io.to(applicantId).emit('notification', `管理者【${room.adminName}】婉拒了你的申請。`);
    if (getTotalUsers() >= MAX_TOTAL_USERS) return io.to(applicantId).emit('notification', '全站已達 20 人上限！');
    const existingMembers = room.members.map(m => ({ id: m.id, name: m.name }));
    room.members.push({ id: applicant.id, name: applicant.name }); applicant.currentRoom = roomId;
    io.to(applicantId).emit('enteredRoom', { roomId, existingMembers }); broadcastState();
  });

  socket.on('webrtcOffer', ({ targetId, offer }) => { const s = onlineUsers[socket.id]; io.to(targetId).emit('webrtcOffer', { senderId: socket.id, senderName: s ? s.name : '成員', offer }); });
  socket.on('webrtcAnswer', ({ targetId, answer }) => io.to(targetId).emit('webrtcAnswer', { senderId: socket.id, answer }));
  socket.on('webrtcIceCandidate', ({ targetId, candidate }) => io.to(targetId).emit('webrtcIceCandidate', { senderId: socket.id, candidate }));
  socket.on('leaveRoom', ({ nextAdminId }) => handleLeaveRoom(socket.id, nextAdminId));

  socket.on('setupCallPair', ({ targetName, pin }) => {
    const user = onlineUsers[socket.id]; if (!user) return;
    const key = getPairKey(user.name, targetName);
    if (db.confirmedPairs.includes(key)) return socket.emit('notification', '已完成配對，可直接呼叫！');
    if (!db.pendingPairs[key]) { db.pendingPairs[key] = { pin, setter: user.name }; saveDB(db); socket.emit('notification', `已設定與【${targetName}】的配對密碼（${pin}），請對方輸入相同密碼！`); }
    else if (db.pendingPairs[key].setter === user.name) { db.pendingPairs[key].pin = pin; saveDB(db); socket.emit('notification', `已更新密碼為 ${pin}`); }
    else if (db.pendingPairs[key].pin === pin) {
      db.confirmedPairs.push(key); delete db.pendingPairs[key]; saveDB(db);
      socket.emit('pairSuccess', targetName);
      const t = Object.values(onlineUsers).find(u => u.name === targetName);
      if (t) io.to(t.id).emit('pairSuccess', user.name);
      broadcastState();
    } else socket.emit('notification', '密碼不符！');
  });

  socket.on('triggerNtfyCall', async ({ targetName }) => {
    const user = onlineUsers[socket.id]; if (!user) return;
    if (!db.confirmedPairs.includes(getPairKey(user.name, targetName))) return socket.emit('requirePairModal', targetName);
    const onlineT = Object.values(onlineUsers).find(u => u.name === targetName);
    const topic = (onlineT && onlineT.ntfyTopic) || (db.knownUsers[targetName] && db.knownUsers[targetName].ntfyTopic);
    if (!topic) return socket.emit('notification', `【${targetName}】未設定推播頻道！`);
    try {
      const res = await fetch(`https://ntfy.sh{encodeURIComponent(topic)}`, {
        method: 'POST', body: `【${user.name}】正在視訊網站呼叫你！快打開網頁加入！`,
        headers: { 'Title': 'Video Call Alert', 'Priority': 'high', 'Tags': 'telephone_receiver' }
      });
      if (!res.ok) throw new Error(res.status);
      socket.emit('notification', `已成功發送手機推播通知給【${targetName}】！`);
    } catch (err) { socket.emit('notification', `推播失敗（${err.message}），請確認頻道為純英文數字！`); }
  });

  socket.on('disconnect', () => { handleLeaveRoom(socket.id, null); delete onlineUsers[socket.id]; broadcastState(); });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => console.log('Server v2.0 running on port ' + PORT));
