const { WebSocketServer } = require('ws');
const { v4: uuidv4 } = require('uuid');

const PORT = process.env.PORT || 3000;
const wss = new WebSocketServer({ port: PORT });

const queue = [];
const peers = new Map(); // id -> { ws, id, userId, partner }

wss.on('connection', (ws) => {
  const id = uuidv4().slice(0, 8);
  peers.set(id, { ws, id, userId: null, partner: null });

  ws.send(JSON.stringify({ type: 'connected', id }));

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    switch (msg.type) {
      case 'find': {
        if (!peers.has(id)) peers.set(id, { ws, id, userId: null, partner: null });
        const p = peers.get(id);
        p.userId = msg.userId || null;
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
      case 'report': {
        const reporter = peers.get(id);
        const reportedId = msg.target;
        console.log(`REPORT: User ${id} reported user ${reportedId}`);
        if (reporter && reporter.partner === reportedId) {
          const reported = peers.get(reportedId);
          if (reported) {
            try { reported.ws.send(JSON.stringify({ type: 'reported' })); } catch {}
          }
          try { reporter.ws.send(JSON.stringify({ type: 'report_ack' })); } catch {}
        }
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
    pa.ws.send(JSON.stringify({ type: 'matched', partner: b, userId: pb.userId, room, role: 'offer' }));
    pb.ws.send(JSON.stringify({ type: 'matched', partner: a, userId: pa.userId, room, role: 'answer' }));
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
