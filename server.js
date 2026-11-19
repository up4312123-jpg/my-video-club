const express = require('express');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

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
      const next = (nextAdminId && room.members.find(m => m.id === nextAdminId)) || room.members;
      room.adminId = next.id;
      room.adminName = next.name;
      io.to(next.id).emit('notification', `你已成為【${room.name}】的新管理者！`);
    }
  }
  broadcastState();
}

// 直接由後端提供完整前端網頁，徹底避免檔案路徑或快取不同步問題
app.get('/', (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="zh-TW">
<head>
  <meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>五房制視訊大廳</title>
  <script src="/socket.io/socket.io.js"></script>
  <style>
    body { font-family: "Microsoft JhengHei", sans-serif; background: #f0f2f5; margin: 0; padding: 15px; }
    .container { max-width: 1100px; margin: auto; }
    .card { background: white; padding: 20px; border-radius: 10px; box-shadow: 0 2px 8px rgba(0,0,0,0.1); margin-bottom: 15px; }
    .rooms-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 12px; }
    .room-card { border: 2px solid #e0e0e0; border-radius: 8px; padding: 15px; background: #fafafa; }
    .room-card.active { border-color: #4CAF50; background: #f1f8e9; }
    button { padding: 8px 14px; border: none; border-radius: 5px; cursor: pointer; font-weight: bold; margin: 3px; }
    .btn-primary { background: #1976d2; color: white; } .btn-success { background: #388e3c; color: white; }
    .btn-danger { background: #d32f2f; color: white; } .btn-warning { background: #f57c00; color: white; }
    .btn-secondary { background: #607d8b; color: white; }
    input[type="text"] { padding: 10px; border: 1px solid #ccc; border-radius: 5px; margin-bottom: 12px; width: 92%; display: block; font-size: 15px; }
    .hidden { display: none !important; }
    .member-tag { display: inline-block; background: #e3f2fd; padding: 4px 10px; border-radius: 15px; margin: 3px; font-size: 14px; }
    .badge-online { background: #e8f5e9; color: #2e7d32; padding: 2px 8px; border-radius: 10px; font-size: 12px; font-weight: bold; }
    .badge-offline { background: #eee; color: #757575; padding: 2px 8px; border-radius: 10px; font-size: 12px; }
    .badge-paired { background: #fff3e0; color: #ef6c00; padding: 2px 8px; border-radius: 10px; font-size: 12px; margin-left: 5px; }
    .video-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(250px, 1fr)); gap: 12px; margin: 15px 0; background: #1e1e1e; padding: 12px; border-radius: 8px; }
    .video-wrapper { position: relative; background: #000; border-radius: 8px; overflow: hidden; aspect-ratio: 4/3; border: 2px solid #555; }
    .video-wrapper video { width: 100%; height: 100%; object-fit: cover; display: block; }
    .video-label { position: absolute; bottom: 8px; left: 8px; background: rgba(0,0,0,0.75); color: white; padding: 4px 10px; border-radius: 4px; font-size: 13px; }
    .status-bar { padding: 8px; border-radius: 6px; margin-bottom: 15px; font-size: 14px; font-weight: bold; text-align: center; }
    .status-wait { background: #fff3e0; color: #e65100; } .status-ok { background: #e8f5e9; color: #2e7d32; }
  </style>
</head>
<body>
<div class="container">
  <div id="loginBox" class="card" style="max-width: 400px; margin: 30px auto;">
    <h2>進入視訊大廳</h2>
    <div id="connStatus" class="status-bar status-wait">⏳ 正在連線至伺服器，請稍候...</div>
    <label><b>1. 你的稱呼（必填）：</b></label>
    <input type="text" id="nicknameInput" placeholder="隨便輸入一個稱呼 (例: 小明)">
    <label><b>2. 手機 ntfy 推播頻道（選填）：</b></label>
    <input type="text" id="ntfyInput" placeholder="填寫純英文數字可接收手機呼叫 (可留空)">
    <div style="margin-bottom: 15px;"><input type="checkbox" id="rememberCheckbox" checked> 記住我的稱呼與 ntfy 頻道</div>
    <button class="btn-primary" style="width:100%; padding:12px; font-size:16px;" onclick="enterLobby()">立即進入大廳</button>
  </div>

  <div id="mainBox" class="hidden">
    <div class="card" style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap;">
      <div><b>歡迎，<span id="myNameDisplay"></span></b> | 全站人數：<b id="totalUsersDisplay" style="color:#d32f2f;">0 / 20</b></div>
      <div><b id="myStatusDisplay" style="color:#1976d2; margin-right:10px;">目前位置：大廳</b><button class="btn-secondary" onclick="changeMyNtfy()">⚙️ 設定推播頻道</button></div>
    </div>
    <div id="currentRoomPanel" class="card hidden" style="border: 2px solid #1976d2;">
      <h3 id="currentRoomTitle">你正在：房間 X</h3>
      <p>房間成員：<span id="roomMembersList"></span></p>
      <div id="videoGrid" class="video-grid"></div>
      <div>
        <button id="toggleMicBtn" class="btn-secondary" onclick="toggleMic()">🎤 麥克風：開啟</button>
        <button id="toggleCamBtn" class="btn-secondary" onclick="toggleCam()">📷 鏡頭：開啟</button>
        <button class="btn-danger" onclick="initiateLeaveRoom()">🚪 離開房間</button>
      </div>
    </div>
    <div class="card"><h3>視訊房間列表（共 5 間）</h3><div id="roomsContainer" class="rooms-grid"></div></div>
    <div class="card"><h3>成員名單與手機推播呼叫（首次需雙方輸入相同四位數密碼綁定）</h3><div id="contactList"></div></div>
  </div>
</div>
<script>
  const socket = io();
  let myUser = null, latestState = null, localStream = null, peerConnections = {};
  const rtcConfig = { iceServers: [{ urls: 'stun:://google.com' }, { urls: 'turn:openrelay.metered.ca:80', username: 'openrelayproject', credential: 'openrelayproject' }, { urls: 'turn:openrelay.metered.ca:443', username: 'openrelayproject', credential: 'openrelayproject' }] };

  socket.on('connect', () => { const el = document.getElementById('connStatus'); el.innerText = '✅ 已連線至伺服器，請按下方按鈕進入！'; el.className = 'status-bar status-ok'; });
  socket.on('disconnect', () => { const el = document.getElementById('connStatus'); el.innerText = '⚠️ 連線中斷，重新連線中...'; el.className = 'status-bar status-wait'; });

  window.onload = () => {
    if (localStorage.getItem('vc_nickname')) document.getElementById('nicknameInput').value = localStorage.getItem('vc_nickname');
    if (localStorage.getItem('vc_ntfy')) document.getElementById('ntfyInput').value = localStorage.getItem('vc_ntfy');
  };

  function enterLobby() {
    if (!socket.connected) return alert('尚未連上伺服器，請稍等上方變成綠色！');
    const name = document.getElementById('nicknameInput').value.trim();
    const ntfyTopic = document.getElementById('ntfyInput').value.trim();
    if (!name) return alert('請輸入稱呼！');
    socket.emit('quickLogin', { name, ntfyTopic });
  }

  socket.on('loginError', alert);
  socket.on('loginSuccess', (user) => {
    if (document.getElementById('rememberCheckbox').checked) {
      localStorage.setItem('vc_nickname', user.name); localStorage.setItem('vc_ntfy', user.ntfyTopic);
    } else { localStorage.removeItem('vc_nickname'); localStorage.removeItem('vc_ntfy'); }
    myUser = user;
    document.getElementById('loginBox').classList.add('hidden');
    document.getElementById('mainBox').classList.remove('hidden');
    document.getElementById('myNameDisplay').innerText = user.name;
  });

  function changeMyNtfy() {
    const topic = prompt('請輸入手機 ntfy 頻道名稱（純英文數字）：', myUser.ntfyTopic || '');
    if (topic !== null) { socket.emit('updateNtfy', topic); if (document.getElementById('rememberCheckbox').checked) localStorage.setItem('vc_ntfy', topic); }
  }

  socket.on('stateUpdate', (state) => {
    latestState = state;
    document.getElementById('totalUsersDisplay').innerText = state.totalUsers + ' / ' + state.maxUsers;
    const me = state.onlineUsers.find(u => u.id === myUser.id);
    if (me) myUser = me;

    const roomsDiv = document.getElementById('roomsContainer'); roomsDiv.innerHTML = '';
    const isFull = state.totalUsers >= state.maxUsers;
    for (let i = 1; i <= 5; i++) {
      const r = state.rooms[i], isEmpty = r.members.length === 0;
      let btn = myUser.currentRoom === r.id ? '<button class="btn-success" disabled>你在此房</button>'
: myUser.currentRoom !== null ? '請先離開目前房間'
: isFull ? '全站已滿'
: isEmpty ? '進入空房 (當管理者)'
: '申請進入 (需同意)';
roomsDiv.innerHTML += ''+r.name+'狀態：'+(isEmpty?'空房間':'使用中('+r.members.length+'人)')+'管理者：'+(r.adminName||'無')+''+btn+'';
}
const panel = document.getElementById('currentRoomPanel');
if (myUser.currentRoom) {
const cur = state.rooms[myUser.currentRoom]; panel.classList.remove('hidden');
document.getElementById('myStatusDisplay').innerText = '目前位置：' + cur.name + (cur.adminId === myUser.id ? ' (你是管理者)' : '');
document.getElementById('currentRoomTitle').innerText = cur.name + ' - 管理者：' + cur.adminName;
document.getElementById('roomMembersList').innerHTML = cur.members.map(m => ''+m.name+'').join('');
} else { panel.classList.add('hidden'); document.getElementById('myStatusDisplay').innerText = '目前位置：大廳'; }
const listDiv = document.getElementById('contactList'); listDiv.innerHTML = '';
state.contactList.forEach(u => {
if (u.name === myUser.name) return;
const isPaired = state.confirmedPairs.includes([myUser.name, u.name].sort().join('_'));
listDiv.innerHTML += '👤 '+u.name+' '
+ (u.isOnline ? '線上' : '離線')
+ (isPaired ? '✓ 已配對' : '')
+ (u.ntfyTopic ? '📲 手機推播呼叫' : '(未設推播)')
+ (!isPaired && u.ntfyTopic ? '🔑 設定4位數密碼' : '') + '';
});
});
function joinRoom(id) { socket.emit('requestJoinRoom', id); }
async function startLocalMedia() {
if (localStream) return localStream;
try { localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true }); }
catch (e) {
try { localStream = await navigator.mediaDevices.getUserMedia({ video: false, audio: true }); alert('無攝影機，以純語音進入'); }
catch (e2) { localStream = new MediaStream(); alert('無法取得鏡頭麥克風權限，以觀看模式進入'); }
}
addVideoBox('local', localStream, myUser.name + ' (我)', true);
return localStream;
}
function stopLocalMedia() {
if (localStream) { localStream.getTracks().forEach(t => t.stop()); localStream = null; }
Object.values(peerConnections).forEach(pc => pc.close()); peerConnections = {};
document.getElementById('videoGrid').innerHTML = '';
}
function addVideoBox(id, stream, labelText, isMuted) {
let wrap = document.getElementById('video-wrap-' + id);
if (wrap) { const v = wrap.querySelector('video'); if (v && v.srcObject !== stream) v.srcObject = stream; return; }
wrap = document.createElement('div'); wrap.className = 'video-wrapper'; wrap.id = 'video-wrap-' + id;
const v = document.createElement('video'); v.srcObject = stream; v.autoplay = true; v.playsInline = true; v.muted = isMuted;
const lbl = document.createElement('div'); lbl.className = 'video-label'; lbl.innerText = labelText;
wrap.appendChild(v); wrap.appendChild(lbl); document.getElementById('videoGrid').appendChild(wrap);
v.play().catch(() => {});
}
function createPC(targetId, targetName) {
if (peerConnections[targetId]) peerConnections[targetId].close();
const pc = new RTCPeerConnection(rtcConfig); peerConnections[targetId] = pc;
if (localStream) localStream.getTracks().forEach(t => pc.addTrack(t, localStream));
pc.onicecandidate = e => { if (e.candidate) socket.emit('webrtcIceCandidate', { targetId, candidate: e.candidate }); };
pc.ontrack = e => { if (e.streams && e.streams) addVideoBox(targetId, e.streams, targetName, false); };
return pc;
}
socket.on('enteredRoom', async ({ existingMembers }) => {
await startLocalMedia();
for (const m of existingMembers) {
const pc = createPC(m.id, m.name);
const offer = await pc.createOffer(); await pc.setLocalDescription(offer);
socket.emit('webrtcOffer', { targetId: m.id, offer });
}
});
socket.on('webrtcOffer', async ({ senderId, senderName, offer }) => {
await startLocalMedia();
const pc = createPC(senderId, senderName);
await pc.setRemoteDescription(new RTCSessionDescription(offer));
const answer = await pc.createAnswer(); await pc.setLocalDescription(answer);
socket.emit('webrtcAnswer', { targetId: senderId, answer });
});
socket.on('webrtcAnswer', async ({ senderId, answer }) => { if (peerConnections[senderId]) await peerConnections[senderId].setRemoteDescription(new RTCSessionDescription(answer)); });
socket.on('webrtcIceCandidate', async ({ senderId, candidate }) => { if (peerConnections[senderId] && candidate) try { await peerConnections[senderId].addIceCandidate(new RTCIceCandidate(candidate)); } catch (e) {} });
socket.on('userLeftVideo', (id) => { if (peerConnections[id]) { peerConnections[id].close(); delete peerConnections[id]; } const el = document.getElementById('video-wrap-' + id); if (el) el.remove(); });
function toggleMic() { if (localStream && localStream.getAudioTracks()) { const t = localStream.getAudioTracks(); t.enabled = !t.enabled; document.getElementById('toggleMicBtn').innerText = t.enabled ? '🎤 麥克風：開啟' : '🔇 麥克風：靜音'; } }
function toggleCam() { if (localStream && localStream.getVideoTracks()) { const t = localStream.getVideoTracks(); t.enabled = !t.enabled; document.getElementById('toggleCamBtn').innerText = t.enabled ? '📷 鏡頭：開啟' : '🚫 鏡頭：關閉'; } }
socket.on('joinRequestToAdmin', ({ roomId, applicantId, applicantName }) => {
const approved = confirm('【進入申請】「' + applicantName + '」想要進入你的房間，是否同意？');
socket.emit('adminDecision', { roomId, applicantId, approved });
});
function initiateLeaveRoom() {
const cur = latestState.rooms[myUser.currentRoom];
if (cur.adminId === myUser.id && cur.members.length > 1) {
if (confirm('你是管理者，離開前是否要指定下一位管理員？（按取消則系統自動指派）')) {
const others = cur.members.filter(m => m.id !== myUser.id);
const choice = prompt('請輸入編號：\n' + others.map((m, i) => (i+1) + '. ' + m.name).join('\n'));
const chosen = others[parseInt(choice) - 1];
if (chosen) { stopLocalMedia(); return socket.emit('leaveRoom', { nextAdminId: chosen.id }); }
}
}
stopLocalMedia(); socket.emit('leaveRoom', { nextAdminId: null });
}
function openPairDialog(targetName) {
const pin = prompt('請輸入與「' + targetName + '」約定的【四位數數字密碼】：');
if (pin && /^\d{4}$/.test(pin)) socket.emit('setupCallPair', { targetName, pin });
else if (pin !== null) alert('請輸入 4 位數純數字！');
}
function callUser(targetName) { socket.emit('triggerNtfyCall', { targetName }); }
socket.on('requirePairModal', (t) => { alert('尚未與「' + t + '」完成四位數密碼配對！'); openPairDialog(t); });
socket.on('pairSuccess', (t) => alert('🎉 已與「' + t + '」完成四位數密碼永久綁定！'));
socket.on('notification', alert);


`);
});
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
socket.emit('notification', 已向管理者【${room.adminName}】發送申請...);
io.to(room.adminId).emit('joinRequestToAdmin', { roomId, applicantId: socket.id, applicantName: user.name });
}
});
socket.on('adminDecision', ({ roomId, applicantId, approved }) => {
const room = rooms[roomId], applicant = onlineUsers[applicantId];
if (!room || !applicant || room.adminId !== socket.id) return;
if (!approved) return io.to(applicantId).emit('notification', 管理者【${room.adminName}】婉拒了你的申請。);
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
if (!db.pendingPairs[key]) { db.pendingPairs[key] = { pin, setter: user.name }; saveDB(db); socket.emit('notification', 已設定與【${targetName}】的配對密碼（${pin}），請對方輸入相同密碼！); }
else if (db.pendingPairs[key].setter === user.name) { db.pendingPairs[key].pin = pin; saveDB(db); socket.emit('notification', 已更新密碼為 ${pin}); }
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
if (!topic) return socket.emit('notification', 【${targetName}】未設定推播頻道！);
try {
const res = await fetch(https://ntfy.sh{encodeURIComponent(topic)}, {
method: 'POST', body: 【${user.name}】正在視訊網站呼叫你！快打開網頁加入！,
headers: { 'Title': 'Video Call Alert', 'Priority': 'high', 'Tags': 'telephone_receiver' }
});
if (!res.ok) throw new Error(res.status);
socket.emit('notification', 已成功發送手機推播通知給【${targetName}】！);
} catch (err) { socket.emit('notification', 推播失敗（${err.message}），請確認頻道為純英文數字！); }
});
socket.on('disconnect', () => { handleLeaveRoom(socket.id, null); delete onlineUsers[socket.id]; broadcastState(); });
});
const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => console.log('Server running'));