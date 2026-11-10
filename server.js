const { WebSocketServer } = require('ws');
const { v4: uuidv4 } = require('uuid');
const http = require('http');

const PORT = process.env.PORT || 3000;
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://btkcubibosbtpxcronnd.supabase.co';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;

if (!SUPABASE_ANON_KEY) {
  throw new Error('SUPABASE_ANON_KEY must be configured in the signaling server environment.');
}

const queue = [];
const peers = new Map();
const frames = new Map();

async function supabaseUser(token) {
  if (!token) return null;
  const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${token}` },
  });
  if (!res.ok) return null;
  const user = await res.json();
  return user && user.id ? user : null;
}

async function rpc(token, name, body) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${name}`, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Supabase ${name} check failed (${res.status})`);
  return res.json();
}

async function isBanned(token, userId) {
  const result = await rpc(token, 'is_user_banned', { check_id: userId });
  if (typeof result !== 'boolean') throw new Error('Invalid ban-check response');
  return result;
}

async function isUnderage(token, userId) {
  const dob = await rpc(token, 'get_dob', { target_id: userId });
  if (typeof dob !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(dob)) return true;
  const birth = new Date(`${dob}T00:00:00Z`);
  if (Number.isNaN(birth.getTime()) || birth.toISOString().slice(0, 10) !== dob) return true;
  const now = new Date();
  let age = now.getUTCFullYear() - birth.getUTCFullYear();
  const month = now.getUTCMonth() - birth.getUTCMonth();
  if (month < 0 || (month === 0 && now.getUTCDate() < birth.getUTCDate())) age--;
  return age < 18;
}

async function getProfile(userId, token) {
  try {
    const rows = await rpc(token, 'get_public_chat_profile', { target_user_id: userId });
    if (Array.isArray(rows) && rows.length) return rows[0];
  } catch (error) {
    console.warn('Public profile lookup failed:', error.message);
  }
  return null;
}

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  if (req.url === '/api/live' && req.method === 'GET') {
    const auth = req.headers.authorization || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    const viewer = await supabaseUser(token);
    if (!viewer) { res.writeHead(401); res.end('Unauthorized'); return; }
    const liveUsers = [];
    const seen = new Set();
    for (const [, p] of peers) {
      if (p.partner && p.userId && !seen.has(p.userId)) {
        seen.add(p.userId);
        const profile = await getProfile(p.userId, token);
        liveUsers.push({
          id: p.id,
          user_id: p.userId,
          name: profile?.display_name || 'Anonymous',
          avatar: profile?.avatar_url || '',
          bio: profile?.bio || '',
        });
      }
    }
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(liveUsers));
    return;
  }


  res.writeHead(404);
  res.end('Not found');
});

const wss = new WebSocketServer({ server });

wss.on('connection', async (ws, req) => {
  const requestUrl = new URL(req.url, 'http://localhost');
  const token = requestUrl.searchParams.get('access_token');
  const user = await supabaseUser(token);
  if (!user) {
    ws.close(4401, 'Authentication required');
    return;
  }

  const id = uuidv4().slice(0, 8);
  peers.set(id, { ws, id, userId: user.id, token, partner: null });
  ws.send(JSON.stringify({ type: 'connected', id }));

  ws.on('message', async (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    switch (msg.type) {
      case 'find': {
        const p = peers.get(id);
        if (!p || queue.includes(id) || p.partner) return;
        try {
          const [banned, underage] = await Promise.all([
            isBanned(p.token, p.userId),
            isUnderage(p.token, p.userId),
          ]);
          if (banned) {
            ws.send(JSON.stringify({ type: 'banned', reason: 'Your account has been suspended.' }));
            ws.close(4403, 'Account suspended');
            disconnect(id);
            return;
          }
          if (underage) {
            ws.send(JSON.stringify({ type: 'age_restricted', reason: 'Video chat is restricted to users 18 and older.' }));
            return;
          }
        } catch (error) {
          console.error('Access check failed:', error.message);
          ws.send(JSON.stringify({ type: 'auth_error', reason: 'We could not verify your account. Please sign in again.' }));
          ws.close(4401, 'Account verification failed');
          disconnect(id);
          return;
        }
        queue.push(id);
        match();
        break;
      }
      case 'leave':
        leaveMatchmaking(id);
        break;
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
        const p = peers.get(id);
        if (!p) break;
        if (p.partner) {
          const partner = peers.get(p.partner);
          if (partner) { partner.partner = null; try { partner.ws.send(JSON.stringify({ type: 'partner_left' })); } catch {} }
          p.partner = null;
        }
        frames.delete(p.userId);
        if (!queue.includes(id)) queue.push(id);
        match();
        break;
      }
      case 'frame': {
        const p = peers.get(id);
        if (p && p.partner && typeof msg.data === 'string' && msg.data.length <= 300000) {
          frames.set(p.userId, Buffer.from(msg.data, 'base64'));
        }
        break;
      }
      case 'report': {
        const reporter = peers.get(id);
        const reportedPeerId = msg.target;
        if (!reporter || reporter.partner !== reportedPeerId) return;
        const reported = peers.get(reportedPeerId);
        if (!reported || !reported.userId || reported.userId === reporter.userId) return;
        const msgText = typeof msg.messageText === 'string' ? msg.messageText.slice(0, 2000) : 'Live call harassment report';
        try {
          const response = await fetch(`${SUPABASE_URL}/rest/v1/reported_messages`, {
            method: 'POST',
            headers: {
              apikey: SUPABASE_ANON_KEY,
              Authorization: `Bearer ${reporter.token}`,
              'Content-Type': 'application/json',
              Prefer: 'return=minimal',
            },
            body: JSON.stringify({
              reporter_id: reporter.userId,
              reported_user_id: reported.userId,
              message_text: msgText,
              call_session_id: typeof msg.room === 'string' ? msg.room.slice(0, 100) : '',
            }),
          });
          if (!response.ok) {
            const detail = await response.text();
            throw new Error(`Report insert failed (${response.status}): ${detail.slice(0, 300)}`);
          }
          try { reporter.ws.send(JSON.stringify({ type: 'report_ack' })); } catch {}
          try { reported.ws.send(JSON.stringify({ type: 'reported' })); } catch {}
        } catch (error) {
          console.error('Report submission failed:', error.message);
          try { reporter.ws.send(JSON.stringify({ type: 'report_error', reason: 'Your report could not be submitted. Please try again.' })); } catch {}
        }
        break;
      }
    }
  });

  ws.on('close', () => disconnect(id));
  ws.on('error', () => disconnect(id));
});

setInterval(async () => {
  const checks = [];
  for (const [id, p] of peers) {
    if (p.partner) {
      checks.push((async () => {
        try {
          if (await isBanned(p.token, p.userId)) {
            try { p.ws.send(JSON.stringify({ type: 'banned', reason: 'Your account has been suspended.' })); } catch {}
            disconnect(id);
          }
        } catch (error) {
          console.error('Periodic ban check failed:', error.message);
          disconnect(id);
        }
      })());
    }
  }
  await Promise.allSettled(checks);
}, 15000);

function match() {
  let attempts = 0;
  while (queue.length >= 2 && attempts < queue.length * 2) {
    const a = queue.shift();
    const b = queue.shift();
    const pa = peers.get(a);
    const pb = peers.get(b);
    if (!pa || !pb || pa.ws.readyState !== 1 || pb.ws.readyState !== 1) { attempts++; continue; }
    if (pa.userId === pb.userId) {
      queue.push(a, b);
      attempts++;
      continue;
    }
    attempts = 0;
    pa.partner = b;
    pb.partner = a;
    const room = uuidv4().slice(0, 8);
    pa.ws.send(JSON.stringify({ type: 'matched', partner: b, userId: pb.userId, room, role: 'offer' }));
    pb.ws.send(JSON.stringify({ type: 'matched', partner: a, userId: pa.userId, room, role: 'answer' }));
  }
}

function leaveMatchmaking(id) {
  const p = peers.get(id);
  if (!p) return;

  const idx = queue.indexOf(id);
  if (idx >= 0) queue.splice(idx, 1);

  if (p.userId) frames.delete(p.userId);
  if (p.partner) {
    const partner = peers.get(p.partner);
    if (partner) {
      partner.partner = null;
      try { partner.ws.send(JSON.stringify({ type: 'partner_left' })); } catch {}
    }
    p.partner = null;
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
      try { partner.ws.send(JSON.stringify({ type: 'partner_left' })); } catch {}
    }
  }
  peers.delete(id);
  const idx = queue.indexOf(id);
  if (idx >= 0) queue.splice(idx, 1);
}

server.listen(PORT, () => console.log(`Signaling server running on port ${PORT}`));
