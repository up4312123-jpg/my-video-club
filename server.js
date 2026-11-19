const express = require('express');
const http = require('http');
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
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
      users: {},
      confirmedPairs: [],
      pendingPairs: {}
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
  rooms[i] = {
    id: i,
    name: `房間 ${i}`,
    adminId: null,
    adminName: null,
    members: []
  };
}

let onlineUsers = {};

function getPairKey(name1, name2) {
  return [name1, name2].sort().join('_');
}

function getTotalInRoomUsers() {
  let count = 0;
  for (let i = 1; i <= 5; i++) {
    count += rooms[i].members.length;
  }
  return count;
}

function broadcastState() {
  const onlineNames = new Set(Object.values(onlineUsers).map(u => u.name));
  const allRegisteredUsers = Object.values(db.users).map(u => ({
    name: u.username,
    isOnline: onlineNames.has(u.username)
  }));

  io.emit('stateUpdate', {
    rooms,
    totalUsers: getTotalInRoomUsers(),
    maxUsers: MAX_TOTAL_USERS,
    onlineUsers: Object.values(onlineUsers),
    allRegisteredUsers,
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
    if (m.id !== socketId) {
      io.to(m.id).emit('userLeftVideo', socketId);
    }
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
      const nextAdmin = room.members[0];
      room.adminId = nextAdmin.id;
      room.adminName = nextAdmin.name;
      io.to(nextAdmin.id).emit('notification', `原管理者已離開，系統自動由你接任【${room.name}】管理者！`);
    }
  }

  broadcastState();
}

io.on('connection', (socket) => {
  socket.on('register', ({ username, password, ntfyTopic }) => {
    const cleanName = (username || '').trim();
    if (!cleanName || !password) {
      return socket.emit('authError', '帳號與密碼不能為空！');
    }
    if (db.users[cleanName]) {
      return socket.emit('authError', '此會員名稱已被註冊，請換一個名稱！');
    }

    const passwordHash = bcrypt.hashSync(password, 10);
    db.users[cleanName] = {
      username: cleanName,
      passwordHash,
      ntfyTopic: (ntfyTopic || '').trim()
    };
    saveDB(db);
    socket.emit('registerSuccess', '註冊成功！請使用剛設定的帳號密碼登入。');
  });

  socket.on('login', ({ username, password }) => {
    const cleanName = (username || '').trim();
    const record = db.users[cleanName];
    if (!record || !bcrypt.compareSync(password, record.passwordHash)) {
      return socket.emit('authError', '會員名稱或密碼錯誤！');
    }

    const alreadyOnline = Object.values(onlineUsers).find(u => u.name === cleanName);
    if (alreadyOnline) {
      return socket.emit('authError', '此帳號目前已在其他視窗登入中！');
    }

    onlineUsers[socket.id] = {
      id: socket.id,
      name: record.username,
      ntfyTopic: record.ntfyTopic,
      currentRoom: null
    };
    socket.emit('loginSuccess', onlineUsers[socket.id]);
    broadcastState();
  });

  socket.on('updateNtfy', (newTopic) => {
    const user = onlineUsers[socket.id];
    if (!user || !db.users[user.name]) return;
    const cleanTopic = (newTopic || '').trim();
    db.users[user.name].ntfyTopic = cleanTopic;
    user.ntfyTopic = cleanTopic;
    saveDB(db);
    socket.emit('notification', `已成功更新你的手機接收頻道為：${cleanTopic || '(未設定)'}`);
    broadcastState();
  });

  socket.on('requestJoinRoom', (roomId) => {
    const user = onlineUsers[socket.id];
    const room = rooms[roomId];
    if (!user || !room) return;

    if (getTotalInRoomUsers() >= MAX_TOTAL_USERS) {
      return socket.emit('notification', '全站視訊人數已達 20 人上限，請稍後再試！');
    }
    if (user.currentRoom) {
      return socket.emit('notification', '你目前已經在房間內了，請先離開目前房間。');
    }

    if (room.members.length === 0) {
      room.adminId = socket.id;
      room.adminName = user.name;
      room.members.push({ id: socket.id, name: user.name, joinTime: Date.now() });
      user.currentRoom = roomId;
      socket.emit('enteredRoom', { roomId, existingMembers: [] });
      broadcastState();
    } else {
      socket.emit('notification', `已向管理者【${room.adminName}】發送進入申請，請等待同意...`);
      io.to(room.adminId).emit('joinRequestToAdmin', {
        roomId,
        applicantId: socket.id,
        applicantName: user.name
      });
    }
  });

  socket.on('adminDecision', ({ roomId, applicantId, approved }) => {
    const room = rooms[roomId];
    const applicant = onlineUsers[applicantId];
    if (!room || !applicant || room.adminId !== socket.id) return;

    if (!approved) {
      return io.to(applicantId).emit('notification', `管理者【${room.adminName}】婉拒了你的進入申請。`);
    }
    if (getTotalInRoomUsers() >= MAX_TOTAL_USERS) {
      return io.to(applicantId).emit('notification', '剛剛全站已達 20 人上限，無法進入。');
    }

    const existingMembers = room.members.map(m => ({ id: m.id, name: m.name }));
    room.members.push({ id: applicant.id, name: applicant.name, joinTime: Date.now() });
    applicant.currentRoom = roomId;
    io.to(applicantId).emit('enteredRoom', { roomId, existingMembers });
    broadcastState();
  });

  socket.on('webrtcOffer', ({ targetId, offer }) => {
    const sender = onlineUsers[socket.id];
    io.to(targetId).emit('webrtcOffer', {
      senderId: socket.id,
      senderName: sender ? sender.name : '成員',
      offer
    });
  });

  socket.on('webrtcAnswer', ({ targetId, answer }) => {
    io.to(targetId).emit('webrtcAnswer', { senderId: socket.id, answer });
  });

  socket.on('webrtcIceCandidate', ({ targetId, candidate }) => {
    io.to(targetId).emit('webrtcIceCandidate', { senderId: socket.id, candidate });
  });

  socket.on('leaveRoom', ({ nextAdminId }) => {
    handleLeaveRoom(socket.id, nextAdminId);
  });

  socket.on('setupCallPair', ({ targetName, pin }) => {
    const user = onlineUsers[socket.id];
    if (!user || !db.users[targetName]) return;
    const key = getPairKey(user.name, targetName);

    if (db.confirmedPairs.includes(key)) {
      return socket.emit('notification', `你與【${targetName}】已經完成永久配對，可直接呼叫！`);
    }

    if (!db.pendingPairs[key]) {
      db.pendingPairs[key] = { pin, setter: user.name };
      saveDB(db);
      socket.emit('notification', `已設定與【${targetName}】的配對密碼（${pin}），請通知對方在登入後輸入相同四位數密碼即可永久綁定。`);
    } else {
      if (db.pendingPairs[key].setter === user.name) {
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
    }
  });

  // 修復版：支援中文頻道名稱編碼，並回報具體錯誤訊息
  socket.on('triggerNtfyCall', async ({ targetName }) => {
    const user = onlineUsers[socket.id];
    const targetRecord = db.users[targetName];
    if (!user || !targetRecord) return;

    const key = getPairKey(user.name, targetName);
    if (!db.confirmedPairs.includes(key)) {
      return socket.emit('requirePairModal', targetName);
    }

    if (!targetRecord.ntfyTopic) {
      return socket.emit('notification', `【${targetName}】尚未設定 ntfy 推播頻道名稱，無法發送手機通知。`);
    }

    try {
      const encodedTopic = encodeURIComponent(targetRecord.ntfyTopic);
      const response = await fetch(`https://ntfy.sh{encodedTopic}`, {
        method: 'POST',
        body: `會員【${user.name}】正在視訊網站呼叫你！快打開網頁加入吧！`,
        headers: {
          'Title': 'Video Call Alert',
          'Priority': 'high',
          'Tags': 'telephone_receiver'
        }
      });

      if (!response.ok) {
        throw new Error(`HTTP 狀態碼 ${response.status}`);
      }
      socket.emit('notification', `已成功發送手機/平板推播通知給【${targetName}】！`);
    } catch (err) {
      console.error('ntfy 推播失敗:', err);
      socket.emit('notification', `推播發送失敗（原因：${err.message}），請確認對方的 ntfy 頻道名稱是否為純英文數字！`);
    }
  });

  socket.on('disconnect', () => {
    handleLeaveRoom(socket.id, null);
    delete onlineUsers[socket.id];
    broadcastState();
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`網站已啟動！連接埠：${PORT}`);
});
