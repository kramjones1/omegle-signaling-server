const { WebSocketServer } = require('ws');
const { v4: uuidv4 } = require('uuid');

const PORT = process.env.PORT || 3000;
const wss = new WebSocketServer({ port: PORT });

const queue = [];
const peers = new Map(); // id -> { ws, id }

wss.on('connection', (ws) => {
  const id = uuidv4().slice(0, 8);
  peers.set(id, { ws, id, partner: null });

  ws.send(JSON.stringify({ type: 'connected', id }));

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    switch (msg.type) {
      case 'find': {
        if (!peers.has(id)) peers.set(id, { ws, id, partner: null });
        queue.push(id);
        match();
        break;
      }
      case 'leave': {
        disconnect(id);
        break;
      }
      case 'sdp':
      case 'ice': {
        const p = peers.get(id);
        if (p && p.partner) {
          const partner = peers.get(p.partner);
          if (partner) partner.ws.send(JSON.stringify({ ...msg, from: id }));
        }
        break;
      }
      case 'next': {
        disconnect(id);
        queue.push(id);
        match();
        break;
      }
    }
  });

  ws.on('close', () => disconnect(id));
});

function match() {
  while (queue.length >= 2) {
    const a = queue.shift();
    const b = queue.shift();
    const pa = peers.get(a);
    const pb = peers.get(b);
    if (!pa || !pb) { if (pa) queue.unshift(a); continue; }
    pa.partner = b;
    pb.partner = a;
    const room = uuidv4().slice(0, 8);
    pa.ws.send(JSON.stringify({ type: 'matched', partner: b, room, role: 'offer' }));
    pb.ws.send(JSON.stringify({ type: 'matched', partner: a, room, role: 'answer' }));
  }
}

function disconnect(id) {
  const p = peers.get(id);
  if (!p) return;
  if (p.partner) {
    const partner = peers.get(p.partner);
    if (partner) {
      partner.partner = null;
      partner.ws.send(JSON.stringify({ type: 'partner_left' }));
    }
  }
  peers.delete(id);
  const idx = queue.indexOf(id);
  if (idx >= 0) queue.splice(idx, 1);
}

console.log(`Signaling server running on port ${PORT}`);
