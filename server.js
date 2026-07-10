const { WebSocketServer } = require('ws');
const { v4: uuidv4 } = require('uuid');
const http = require('http');

const PORT = process.env.PORT || 3000;
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://btkcubibosbtpxcronnd.supabase.co';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJ0a2N1Ymlib3NidHB4Y3Jvbm5kIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODMwMzI1ODAsImV4cCI6MjA5ODYwODU4MH0.IqR7dJbZJm83c_XHz923GQrBWdf5GCaNDYMPg6z8kj0';

const queue = [];
const peers = new Map(); // id -> { ws, id, userId, partner }
const frames = new Map(); // userId -> Buffer (latest JPEG frame)

async function isBanned(userId) {
  if (!userId) return false;
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/is_user_banned`, {
      method: 'POST',
      headers: { 'apikey': SUPABASE_ANON_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ check_id: userId }),
    });
    const data = await res.json();
    return data === true;
  } catch { return false; }
}

async function isUnderage(userId) {
  if (!userId) return true;
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/get_dob`, {
      method: 'POST',
      headers: { 'apikey': SUPABASE_ANON_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ target_id: userId }),
    });
    const data = await res.json();
    if (!data) return true;
    const bd = new Date(data);
    const t = new Date();
    let age = t.getFullYear() - bd.getFullYear();
    const m = t.getMonth() - bd.getMonth();
    if (m < 0 || (m === 0 && t.getDate() < bd.getDate())) age--;
    return age < 18;
  } catch { return true; }
}

async function getProfile(userId) {
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/chat_profiles?user_id=eq.${userId}&select=display_name,avatar_url,bio`, {
      headers: { 'apikey': SUPABASE_ANON_KEY },
    });
    const data = await res.json();
    if (Array.isArray(data) && data.length > 0) return data[0];
  } catch {}
  return null;
}

// HTTP server for API endpoints
const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  if (req.url === '/api/live' && req.method === 'GET') {
    const liveUsers = [];
    const seen = new Set();

    for (const [, p] of peers) {
      if (p.partner && p.userId && !seen.has(p.userId)) {
        seen.add(p.userId);
        const profile = await getProfile(p.userId);
        liveUsers.push({
          id: p.id,
          user_id: p.userId,
          name: profile?.display_name || 'Anonymous',
          avatar: profile?.avatar_url || '',
          bio: profile?.bio || '',
        });
      }
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(liveUsers));
    return;
  }

  if (req.url.startsWith('/api/live/frame/') && req.method === 'GET') {
    const userId = req.url.split('/api/live/frame/')[1];
    const frame = frames.get(userId);
    if (frame) {
      res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'no-cache, no-store, must-revalidate' });
      res.end(frame);
    } else {
      res.writeHead(404);
      res.end();
    }
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  const id = uuidv4().slice(0, 8);
  peers.set(id, { ws, id, userId: null, partner: null });

  ws.send(JSON.stringify({ type: 'connected', id }));

  ws.on('message', async (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    switch (msg.type) {
      case 'find': {
        if (!peers.has(id)) peers.set(id, { ws, id, userId: null, partner: null });
        const p = peers.get(id);
        p.userId = msg.userId || null;
        if (p.userId) {
          const [banned, underage] = await Promise.all([isBanned(p.userId), isUnderage(p.userId)]);
          if (banned) {
            try { ws.send(JSON.stringify({ type: 'banned', reason: 'Your account has been suspended.' })); } catch {}
            return;
          }
          if (underage) {
            try { ws.send(JSON.stringify({ type: 'age_restricted', reason: 'Video chat is restricted to users 18 and older.' })); } catch {}
            return;
          }
        }
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
      case 'frame': {
        const p = peers.get(id);
        if (p && p.userId && msg.data) {
          const buf = Buffer.from(msg.data, 'base64');
          frames.set(p.userId, buf);
        }
        break;
      }
      case 'report': {
        const reporter = peers.get(id);
        const reportedId = msg.target;
        if (reporter && reporter.partner === reportedId) {
          const reported = peers.get(reportedId);
          if (reported) {
            try { reported.ws.send(JSON.stringify({ type: 'reported' })); } catch {}
            const reporterUid = reporter.userId || 'unknown';
            const reportedUid = reported.userId || 'unknown';
            const msgText = msg.messageText || 'Live call harassment report';
            fetch(`${SUPABASE_URL}/rest/v1/reported_messages`, {
              method: 'POST',
              headers: { 'apikey': SUPABASE_ANON_KEY, 'Content-Type': 'application/json', 'Prefer': 'return=minimal' },
              body: JSON.stringify({ reporter_id: reporterUid, reported_user_id: reportedUid, message_text: msgText, call_session_id: msg.room || '' }),
            }).catch(() => {});
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
  if (p.userId) frames.delete(p.userId);
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

server.listen(PORT, () => console.log(`Signaling server running on port ${PORT}`));
