import { DurableObject } from "cloudflare:workers";

const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization, content-type",
  "access-control-allow-methods": "GET, OPTIONS"
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: JSON_HEADERS });
}

function getToken(request) {
  const value = request.headers.get("authorization") || "";
  return value.replace(/^Bearer\s+/i, "").trim();
}

function newId() {
  return crypto.randomUUID().replace(/-/g, "").slice(0, 8);
}

function getSupabaseApiKey(env) {
  // Same public anon key already used by the frontend; retain the secret binding as fallback.
  return env.SUPABASE_PUBLIC_ANON_KEY || env.SUPABASE_ANON_KEY || "";
}

async function authUser(env, token) {
  if (!token) return null;
  const apiKey = getSupabaseApiKey(env) || "";
  console.log("Supabase API key runtime check:", {
    present: Boolean(apiKey),
    length: apiKey.length,
    startsWithExpectedPrefix: apiKey.startsWith("eyJhbGci"),
    endsWithExpectedSuffix: apiKey.endsWith("Pg6z8kj0")
  });
  const response = await fetch(`${env.SUPABASE_URL}/auth/v1/user`, {
    headers: {
      apikey: apiKey,
      authorization: `Bearer ${token}`
    }
  });
  if (!response.ok) {
    const detail = (await response.text().catch(() => "")).slice(0, 300);
    console.error("Supabase auth validation failed:", response.status, detail);
    return null;
  }
  const user = await response.json();
  if (!user?.id) console.error("Supabase auth response did not include a user id");
  return user?.id ? user : null;
}

async function rpc(env, token, name, body) {
  const response = await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/${name}`, {
    method: "POST",
    headers: {
      apikey: getSupabaseApiKey(env),
      authorization: `Bearer ${token}`,
      "content-type": "application/json"
    },
    body: JSON.stringify(body)
  });
  if (!response.ok) {
    const detail = (await response.text().catch(() => "")).slice(0, 300);
    throw new Error(`Supabase RPC ${name} failed (${response.status}): ${detail}`);
  }
  return response.json();
}

async function isBanned(env, userId, token) {
  const result = await rpc(env, token, "is_user_banned", { check_id: userId });
  if (typeof result !== "boolean") throw new Error("Invalid ban-check response");
  return result;
}

async function isUnderage(env, userId, token) {
  const dob = await rpc(env, token, "get_dob", { target_id: userId });
  if (typeof dob !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(dob)) return true;
  const [year, month, day] = dob.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return true;
  const now = new Date();
  let age = now.getUTCFullYear() - year;
  if (now.getUTCMonth() + 1 < month || (now.getUTCMonth() + 1 === month && now.getUTCDate() < day)) age--;
  return age < 18;
}

async function profile(env, userId, token) {
  try {
    const result = await rpc(env, token, "get_public_chat_profile", { target_user_id: userId });
    if (Array.isArray(result) && result.length) {
      const row = result[0];
      return {
        display_name: row.display_name,
        avatar_url: row.avatar_url,
        bio: row.bio
      };
    }
  } catch (error) {
    console.error("get_public_chat_profile failed:", error.message);
  }
  return null;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: JSON_HEADERS });
    }
    if (url.pathname === "/health" && request.method === "GET") {
      return json({
        status: "ok",
        service: "omegle-signaling-cloudflare",
        auth: "supabase-user-jwt",
        build: "cloudflare-migration-v1"
      });
    }

    if (url.pathname === "/__ws-diagnostic" && request.method === "GET") {
      const html = `<!doctype html>
<html lang="en"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>LivMe WebSocket diagnostic</title>
<style>body{font:16px system-ui;max-width:680px;margin:32px auto;padding:0 16px;background:#111;color:#eee}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#222;padding:16px;border-radius:8px}.ok{color:#70d890}.bad{color:#ff7777}</style>
<h2>Cloudflare WebSocket test</h2>
<p>This checks the Worker and Durable Object connection only. No login or camera is used.</p>
<pre id="out">Starting test…</pre>
<script>
const out=document.getElementById('out');
function log(s){out.textContent += "\\n"+new Date().toLocaleTimeString()+"  "+s;}
out.textContent="Opening WebSocket…";
const scheme=location.protocol==="https:"?"wss:":"ws:";
const ws=new WebSocket(scheme+"//"+location.host+"/");
ws.onopen=()=>{log("PASS: browser WebSocket handshake opened");};
ws.onmessage=(e)=>{log("Message: "+e.data);try{const m=JSON.parse(e.data);if(m.type==="connected"){log("PASS: Durable Object sent connected message");ws.send(JSON.stringify({type:"find"}));}if(m.type==="auth_error"){log("Expected: unauthenticated diagnostic connection was rejected at find");}}catch{}};
ws.onerror=()=>log("FAIL: WebSocket error (browser does not expose server details)");
ws.onclose=(e)=>log("Closed: code="+e.code+" reason="+(e.reason||"(none)"));
</script></html>`;
      return new Response(html, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
    }

    if (url.pathname === "/" && request.method === "GET" &&
        request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("Omegle signaling service", {
        headers: { "content-type": "text/plain; charset=utf-8", "access-control-allow-origin": "*" }
      });
    }

    if (url.pathname !== "/api/live" && !url.pathname.startsWith("/api/live/frame/")) {
      const upgrade = request.headers.get("Upgrade");
      if (upgrade?.toLowerCase() !== "websocket") {
        return json({ error: "WebSocket upgrade required" }, 426);
      }
      if (request.method !== "GET") return json({ error: "Method not allowed" }, 405);
    }

    const mainWorkerKey = getSupabaseApiKey(env) || "";
    console.log("Supabase key check at Worker entrypoint:", {
      present: Boolean(mainWorkerKey),
      length: mainWorkerKey.length
    });
    const id = env.MATCHMAKER.idFromName("global-matchmaker");
    return env.MATCHMAKER.get(id).fetch(request);
  }
};

export class Matchmaker extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    const durableObjectKey = getSupabaseApiKey(env) || "";
    console.log("Supabase key check in Matchmaker constructor:", {
      present: Boolean(durableObjectKey),
      length: durableObjectKey.length
    });
    this.ctx.getWebSockets().forEach((ws) => {
      const attachment = ws.deserializeAttachment();
      if (attachment) this.restoreSession(ws, attachment);
    });
  }

  restoreSession(ws, attachment) {
    // The attachment is the durable source of truth for each live connection.
    return attachment;
  }

  sessions() {
    return this.ctx.getWebSockets().map((ws) => ({
      ws,
      data: ws.deserializeAttachment()
    })).filter((entry) => entry.data?.id && entry.data?.userId);
  }

  sessionById(id) {
    return this.sessions().find((entry) => entry.data.id === id) || null;
  }

  save(ws, data) {
    ws.serializeAttachment(data);
  }

  send(ws, message) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      try { ws.send(JSON.stringify(message)); } catch (error) {
        console.error("WebSocket send failed:", error.message);
      }
    }
  }

  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname === "/api/live" && request.method === "GET") {
      const token = getToken(request);
      const user = await authUser(this.env, token);
      if (!user) return json({ error: "Authentication required" }, 401);

      const liveUsers = [];
      const seen = new Set();
      for (const { data } of this.sessions()) {
        if (data.partner && data.userId && !seen.has(data.userId)) {
          seen.add(data.userId);
          const publicProfile = await profile(this.env, data.userId, token);
          liveUsers.push({
            id: data.id,
            user_id: data.userId,
            name: publicProfile?.display_name || "Anonymous",
            avatar: publicProfile?.avatar_url || "",
            bio: publicProfile?.bio || ""
          });
        }
      }
      return json(liveUsers);
    }

    if (url.pathname.startsWith("/api/live/frame/") && request.method === "GET") {
      const userId = decodeURIComponent(url.pathname.slice("/api/live/frame/".length));
      if (!userId || userId.length > 128) return new Response(null, { status: 404 });
      const frame = await this.ctx.storage.get(`frame:${userId}`);
      if (!frame) return new Response(null, { status: 404 });
      const bytes = Uint8Array.from(atob(frame), (char) => char.charCodeAt(0));
      return new Response(bytes, {
        headers: {
          "content-type": "image/jpeg",
          "cache-control": "no-cache, no-store, must-revalidate",
          "access-control-allow-origin": "*"
        }
      });
    }

    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return json({ error: "WebSocket upgrade required" }, 426);
    }

    // Match Belmo's lifecycle: complete the WebSocket upgrade first.
    // Supabase authentication is performed when the client sends "find",
    // before the session is allowed into the matching queue.
    const token = url.searchParams.get("access_token") || "";
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    const id = newId();
    server.serializeAttachment({
      id,
      userId: null,
      accessToken: token,
      partner: null,
      queued: false
    });
    this.ctx.acceptWebSocket(server);
    this.send(server, { type: "connected", id });
    return new Response(null, { status: 101, webSocket: client });
  }

  async eligibility(data) {
    if (!data?.userId || !data?.accessToken) throw new Error("Missing authenticated identity");
    const [banned, underage] = await Promise.all([
      isBanned(this.env, data.userId, data.accessToken),
      isUnderage(this.env, data.userId, data.accessToken)
    ]);
    return { banned, underage };
  }

  async enqueue(ws, data) {
    // Authenticate after the socket is open, as the original Belmo server does.
    // Never enqueue or match a socket until Supabase confirms its identity.
    if (!data.userId) {
      const user = await authUser(this.env, data.accessToken);
      if (!user?.id) {
        this.send(ws, { type: "auth_error", reason: "Authentication required. Please sign in again." });
        try { ws.close(4401, "Authentication required"); } catch {}
        return;
      }
      data.userId = user.id;
      this.save(ws, data);
    }

    try {
      const result = await this.eligibility(data);
      if (result.banned) {
        this.send(ws, { type: "banned", reason: "Your account has been suspended." });
        return;
      }
      if (result.underage) {
        this.send(ws, { type: "age_restricted", reason: "Video chat is restricted to users 18 and older." });
        return;
      }
    } catch (error) {
      console.error("Eligibility check failed:", error.message);
      this.send(ws, {
        type: "auth_error",
        reason: "Unable to verify your account. Please reconnect and try again."
      });
      return;
    }

    if (data.partner) await this.unpair(ws, data);
    const queue = await this.ctx.storage.get("queue") || [];
    if (!queue.includes(data.id)) queue.push(data.id);
    data.queued = true;
    data.partner = null;
    this.save(ws, data);
    await this.ctx.storage.put("queue", queue);
    await this.match();
  }

  async match() {
    let queue = await this.ctx.storage.get("queue") || [];
    queue = queue.filter((id, index) => queue.indexOf(id) === index && this.sessionById(id));
    while (queue.length >= 2) {
      const aId = queue.shift();
      let bIndex = queue.findIndex((candidate) => {
        const a = this.sessionById(aId);
        const b = this.sessionById(candidate);
        return a && b && a.data.userId !== b.data.userId;
      });
      if (bIndex < 0) {
        queue.unshift(aId);
        break;
      }
      const [bId] = queue.splice(bIndex, 1);
      const a = this.sessionById(aId);
      const b = this.sessionById(bId);
      if (!a || !b) continue;
      const room = newId();
      a.data.partner = bId;
      a.data.queued = false;
      a.data.room = room;
      b.data.partner = aId;
      b.data.queued = false;
      b.data.room = room;
      this.save(a.ws, a.data);
      this.save(b.ws, b.data);
      this.send(a.ws, { type: "matched", partner: bId, userId: b.data.userId, room, role: "offer" });
      this.send(b.ws, { type: "matched", partner: aId, userId: a.data.userId, room, role: "answer" });
    }
    await this.ctx.storage.put("queue", queue);
    await this.updateBanAlarm();
  }

  async unpair(ws, data) {
    const partnerId = data.partner;
    const oldRoom = data.room || null;
    data.partner = null;
    data.queued = false;
    data.room = null;
    this.save(ws, data);
    if (partnerId) {
      const partner = this.sessionById(partnerId);
      if (partner) {
        partner.data.partner = null;
        partner.data.queued = false;
        partner.data.room = null;
        this.save(partner.ws, partner.data);
        this.send(partner.ws, { type: "partner_left", room: oldRoom });
      }
    }
  }

  async remove(ws) {
    const data = ws.deserializeAttachment();
    if (!data?.id) return;
    if (data.partner) await this.unpair(ws, data);
    const queue = (await this.ctx.storage.get("queue") || []).filter((id) => id !== data.id);
    await this.ctx.storage.put("queue", queue);
    try { ws.close(1000, "Disconnected"); } catch {}
    await this.updateBanAlarm();
  }

  async updateBanAlarm() {
    const hasMatched = this.sessions().some(({ data }) => !!data.partner);
    if (hasMatched) {
      await this.ctx.storage.setAlarm(Date.now() + 15000);
    } else {
      await this.ctx.storage.deleteAlarm();
    }
  }

  async webSocketMessage(ws, message) {
    const data = ws.deserializeAttachment();
    if (!data?.id) return;
    let msg;
    try {
      const raw = typeof message === "string" ? message : new TextDecoder().decode(message);
      msg = JSON.parse(raw);
    } catch { return; }

    switch (msg.type) {
      case "find":
        if (!data.partner && !data.queued) await this.enqueue(ws, data);
        break;
      case "leave":
        await this.remove(ws);
        break;
      case "next": {
        await this.unpair(ws, data);
        await this.enqueue(ws, data);
        break;
      }
      case "sdp":
      case "ice": {
        if (data.partner && data.room && msg.room === data.room) {
          const partner = this.sessionById(data.partner);
          if (partner && partner.data.partner === data.id && partner.data.room === data.room)
            this.send(partner.ws, { ...msg, from: data.id, room: data.room });
        }
        break;
      }
      case "frame": {
        if (msg.data && typeof msg.data === "string" && msg.data.length <= 1400000) {
          const base64 = msg.data.replace(/^data:image\/jpeg;base64,/, "");
          if (/^[A-Za-z0-9+/]*={0,2}$/.test(base64)) {
            await this.ctx.storage.put(`frame:${data.userId}`, base64);
          }
        }
        break;
      }
      case "report": {
        if (data.partner && data.partner === msg.target && data.room && msg.room === data.room) {
          const reported = this.sessionById(data.partner);
          if (reported) this.send(reported.ws, { type: "reported" });
          if (reported && data.accessToken) {
            fetch(`${this.env.SUPABASE_URL}/rest/v1/reported_messages`, {
              method: "POST",
              headers: {
                apikey: getSupabaseApiKey(this.env),
                authorization: `Bearer ${data.accessToken}`,
                "content-type": "application/json",
                prefer: "return=minimal"
              },
              body: JSON.stringify({
                reporter_id: data.userId,
                reported_user_id: reported.data.userId,
                message_text: msg.messageText || "Live call harassment report",
                call_session_id: msg.room || ""
              })
            }).catch((error) => console.error("Report submission failed:", error.message));
          }
          this.send(ws, { type: "report_ack" });
        }
        break;
      }
      default:
        break;
    }
  }

  async webSocketClose(ws) {
    await this.removeClosed(ws);
  }

  async webSocketError(ws) {
    await this.removeClosed(ws);
  }

  async removeClosed(ws) {
    const data = ws.deserializeAttachment();
    if (!data?.id) return;
    if (data.partner) {
      const partner = this.sessionById(data.partner);
      if (partner) {
        partner.data.partner = null;
        partner.data.queued = false;
        partner.data.room = null;
        this.save(partner.ws, partner.data);
        this.send(partner.ws, { type: "partner_left", room: data.room || null });
      }
    }
    const queue = (await this.ctx.storage.get("queue") || []).filter((id) => id !== data.id);
    await this.ctx.storage.put("queue", queue);
    if (data.userId) await this.ctx.storage.delete(`frame:${data.userId}`);
    await this.updateBanAlarm();
  }

  async alarm() {
    const checks = this.sessions().filter(({ data }) => data.partner);
    for (const { ws, data } of checks) {
      try {
        if (await isBanned(this.env, data.userId, data.accessToken)) {
          this.send(ws, { type: "banned", reason: "Your account has been suspended." });
          await this.remove(ws);
        }
      } catch (error) {
        console.error("Periodic ban verification failed:", error.message);
        this.send(ws, { type: "auth_error", reason: "Unable to verify account status." });
        await this.remove(ws);
      }
    }
    await this.updateBanAlarm();
  }
}
