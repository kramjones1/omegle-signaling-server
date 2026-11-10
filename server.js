const { WebSocketServer } = require('ws');
const { v4: uuidv4 } = require('uuid');
const http = require('http');

const PORT = process.env.PORT || 3000;
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://btkcubibosbtpxcronnd.supabase.co';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJ0a2N1Ymlib3NidHB4Y3Jvbm5kIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODMwMzI1ODAsImV4cCI6MjA5ODYwODU4MH0.IqR7dJbZJm83c_XHz923GQrBWdf5GCaNDYMPg6z8kj0';

const queue = [];
const peers = new Map(); // id -> { ws, id, userId, partner }
const frames = new Map(); // userId -> Buffer (latest JPEG frame)

async function getAuthUser(accessToken) {
  if (!accessToken) return null;
  const res = await fetch(SUPABASE_URL + '/auth/v1/user', {
    headers: { 'apikey': SUPABASE_ANON_KEY, 'Authorization': 'Bearer ' + accessToken },
  });
  if (!res.ok) return null;
  const user = await res.json();
  return user && user.id ? user : null;
}

async function rpc(accessToken, functionName, body) {
  const res = await fetch(SUPABASE_URL + '/rest/v1/rpc/' + functionName, {
    method: 'POST',
    headers: { 'apikey': SUPABASE_ANON_KEY, 'Authorization': 'Bearer ' + accessToken, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    const error = new Error('Supabase RPC ' + functionName + ' failed (' + res.status + '): ' + detail.slice(0, 300));
    error.status = res.status;
    throw error;
  }
  return res.json();
}

async function isBanned(userId, accessToken) {
  if (!userId || !accessToken) throw new Error('Missing authenticated identity for ban check');
  const result = await rpc(accessToken, 'is_user_banned', { check_id: userId });
  if (typeof result !== 'boolean') throw new Error('Invalid ban-check response');
  return result;
}

async function isUnderage(userId, accessToken) {
  if (!userId || !accessToken) throw new Error('Missing authenticated identity for age check');
  const dob = await rpc(accessToken, 'get_dob', { target_id: userId });
  if (typeof dob !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(dob)) return true;
  const parts = dob.split('-').map(Number);
  const now = new Date();
  let age = now.getUTCFullYear() - parts[0];
  const month = now.getUTCMonth() + 1;
  if (month < parts[1] || (month === parts[1] && now.getUTCDate() < parts[2])) age--;
  return age < 18;
}

async function getProfile(userId, accessToken) {
  try {
    const result = await rpc(accessToken, 'get_public_chat_profile', { target_user_id: userId });
    if (Array.isArray(result) && result.length) {
      const row = result[0];
      return { display_name: row.display_name, avatar_url: row.avatar_url, bio: row.bio };
    }
  } catch (error) { console.error('get_public_chat_profile failed:', error.message); }
  return null;
}
// HTTP server for API endpoints
const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  if (req.url === '/api/live' && req.method === 'GET') {
    const accessToken = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    const authUser = await getAuthUser(accessToken);
    if (!authUser) { res.writeHead(401, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Authentication required' })); return; }
    const liveUsers = [];
    const seen = new Set();

    for (const [, p] of peers) {
      if (p.partner && p.userId && !seen.has(p.userId)) {
        seen.add(p.userId);
        const profile = await getProfile(p.userId, accessToken);
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
    const userId = req.url.split('/api/live/frame/')[1].split('?')[0];
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

wss.on('connection', async (ws, req) => {
  const id = uuidv4().slice(0, 8);
  const requestUrl = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));
  const accessToken = requestUrl.searchParams.get('access_token');
  const authUser = await getAuthUser(accessToken);
  if (!authUser) { ws.close(4401, 'Authentication required'); return; }
  peers.set(id, { ws, id, userId: authUser.id, accessToken, partner: null });

  ws.send(JSON.stringify({ type: 'connected', id }));

  ws.on('message', async (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    switch (msg.type) {
      case 'find': {
        const p = peers.get(id);
        if (!p || !p.userId || !p.accessToken) { try { ws.send(JSON.stringify({ type: 'auth_error', reason: 'Authentication required. Please reconnect.' })); } catch {} ws.close(4401, 'Authentication required'); return; }
        try {
          const [banned, underage] = await Promise.all([isBanned(p.userId, p.accessToken), isUnderage(p.userId, p.accessToken)]);
          if (banned) {
            try { ws.send(JSON.stringify({ type: 'banned', reason: 'Your account has been suspended.' })); } catch {}
            return;
          }
          if (underage) {
            try { ws.send(JSON.stringify({ type: 'age_restricted', reason: 'Video chat is restricted to users 18 and older.' })); } catch {}
            return;
          }
        } catch (error) {
          console.error('Eligibility check failed:', error.message);
          try { ws.send(JSON.stringify({ type: 'auth_error', reason: 'Unable to verify your account. Please reconnect and try again.' })); } catch {}
          return;
        }
        if (!queue.includes(id) && !p.partner) queue.push(id);
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
            if (reporterUid !== 'unknown' && reportedUid !== 'unknown') {
              fetch(`${SUPABASE_URL}/rest/v1/reported_messages`, {
                method: 'POST',
                headers: { 'apikey': SUPABASE_ANON_KEY, 'Authorization': 'Bearer ' + reporter.accessToken, 'Content-Type': 'application/json', 'Prefer': 'return=minimal' },
                body: JSON.stringify({ reporter_id: reporterUid, reported_user_id: reportedUid, message_text: msgText, call_session_id: msg.room || '' }),
              }).catch(() => {});
            }
          }
          try { reporter.ws.send(JSON.stringify({ type: 'report_ack' })); } catch {}
        }
        break;
      }
    }
  });

  ws.on('close', () => disconnect(id));
});

// Periodic ban check for active calls (every 15s)
setInterval(async () => {
  const checks = [];
  for (const [id, p] of peers) {
    if (p.partner && p.userId) {
      checks.push(
        isBanned(p.userId, p.accessToken).then(banned => {
          if (banned) {
            try { p.ws.send(JSON.stringify({ type: 'banned', reason: 'Your account has been suspended.' })); } catch {}
            disconnect(id);
          }
        }).catch(error => { console.error('Periodic ban verification failed:', error.message); try { p.ws.send(JSON.stringify({ type: 'auth_error', reason: 'Unable to verify account status.' })); } catch {} disconnect(id); })
      );
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
    if (!pa || !pb) { if (pa) queue.push(a); attempts++; continue; }
    if (pa.userId && pb.userId && pa.userId === pb.userId) {
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
