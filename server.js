const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 5 * 1024 * 1024 });

app.use(express.static(path.join(__dirname)));

const messages = [];
const MAX_MSGS = 100;
let onlineCount = 0;

function broadcast(payload) {
  const data = JSON.stringify(payload);
  wss.clients.forEach(c => { if (c.readyState === 1) c.send(data); });
}

// Heartbeat — keeps Railway proxy from closing idle WebSocket connections
const heartbeatInterval = setInterval(() => {
  wss.clients.forEach(ws => {
    if (!ws.isAlive) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
}, 25000);
wss.on('close', () => clearInterval(heartbeatInterval));

wss.on('connection', ws => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  onlineCount++;
  broadcast({ type: 'online', count: onlineCount });
  ws.send(JSON.stringify({ type: 'history', messages }));

  ws.on('message', raw => {
    try {
      const msg = JSON.parse(raw);
      if (msg.type === 'chat' && msg.username && (msg.text || msg.image)) {
        const entry = {
          id: Date.now(),
          username: msg.username,
          text: String(msg.text || '').substring(0, 300),
          image: msg.image || null,
          time: new Date().toISOString()
        };
        messages.push(entry);
        if (messages.length > MAX_MSGS) messages.shift();
        broadcast({ type: 'message', message: entry });
      } else if (msg.type === 'delete_msg' && msg.id) {
        const idx = messages.findIndex(m => String(m.id) === String(msg.id));
        if (idx >= 0) {
          messages.splice(idx, 1);
          broadcast({ type: 'msg_deleted', id: msg.id });
        }
      }
    } catch {}
  });

  ws.on('close', () => {
    onlineCount = Math.max(0, onlineCount - 1);
    broadcast({ type: 'online', count: onlineCount });
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('Race Timer server on port ' + PORT));
