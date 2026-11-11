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

async function authUser(env, token) {
  if (!token) return null;
  const response = await fetch(`${env.SUPABASE_URL}/auth/v1/user`, {
    headers: {
      apikey: env.SUPABASE_ANON_KEY,
      authorization: `Bearer ${token}`
    }
  });
  if (!response.ok) return null;
  const user = await response.json();
  return user?.id ? user : null;
}

async function rpc(env, token, name, body) {
  const response = await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/${name}`, {
    method: "POST",
    headers: {
      apikey: env.SUPABASE_ANON_KEY,
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

    if (url.pathname === "/" && request.method === "GET" && request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
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

    const id = env.MATCHMAKER.idFromName("global-matchmaker");
    return env.MATCHMAKER.get(id).fetch(request);
  }
};

export class Matchmaker extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
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

    const token = url.searchParams.get("access_token") || "";
    const user = await authUser(this.env, token);
    if (!user) return new Response("Authentication required", { status: 401 });

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    const id = newId();
    server.serializeAttachment({
      id,
      userId: user.id,
      accessToken: token,
      partner: null,
      queued: false
    });
    this.ctx.acceptWebSocket(server);
    this.send(server, { type: "connected", id });
    return new Response(null, { status: 101, webSocket: client });
  }

  async eligibility(data) {
    if (!data?.userId || !data?.accessToken) throw new Error("IDENTITY_CHECK_FAILED");
    let banned;
    try {
      banned = await isBanned(this.env, data.userId, data.accessToken);
    } catch (error) {
      throw new Error("BAN_CHECK_FAILED: " + (error?.message || "unknown error"));
    }
    let underage;
    try {
      underage = await isUnderage(this.env, data.userId, data.accessToken);
    } catch (error) {
      throw new Error("AGE_CHECK_FAILED: " + (error?.message || "unknown error"));
    }
    return { banned, underage };
  }

  async enqueue(ws, data) {
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
      const detail = error?.message || "UNKNOWN_ELIGIBILITY_ERROR";
      const code = detail.startsWith("BAN_CHECK_FAILED:") ? "BAN_CHECK_FAILED"
        : detail.startsWith("AGE_CHECK_FAILED:") ? "AGE_CHECK_FAILED"
        : detail.startsWith("IDENTITY_CHECK_FAILED") ? "IDENTITY_CHECK_FAILED"
        : "ELIGIBILITY_CHECK_FAILED";
      console.error("Eligibility check failed:", detail);
      this.send(ws, {
        type: "auth_error",
        reason: code === "BAN_CHECK_FAILED"
          ? "Authentication passed, but account suspension verification failed (BAN_CHECK_FAILED)."
          : code === "AGE_CHECK_FAILED"
            ? "Authentication passed, but age verification failed (AGE_CHECK_FAILED)."
            : "Account authentication or eligibility verification failed (" + code + ")."
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
      b.data.partner = aId;
      b.data.queued = false;
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
    data.partner = null;
    data.queued = false;
    this.save(ws, data);
    if (partnerId) {
      const partner = this.sessionById(partnerId);
      if (partner) {
        partner.data.partner = null;
        partner.data.queued = false;
        this.save(partner.ws, partner.data);
        this.send(partner.ws, { type: "partner_left" });
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
      case "find": {
        // Refresh the socket's stored JWT at the moment the user starts searching.
        // A WebSocket can remain open after the browser refreshes its Supabase session.
        const freshToken = typeof msg.accessToken === "string" ? msg.accessToken : "";
        if (!freshToken) {
          this.send(ws, { type: "auth_error", reason: "Your session needs refreshing. Please try again." });
          break;
        }
        try {
          const user = await authUser(this.env, freshToken);
          if (!user || user.id !== data.userId) {
            this.send(ws, { type: "auth_error", reason: "Your session is no longer valid. Please sign in again." });
            break;
          }
          data.accessToken = freshToken;
          this.save(ws, data);
          await this.enqueue(ws, data);
        } catch (error) {
          console.error("Find-session refresh failed:", error.message);
          this.send(ws, { type: "auth_error", reason: "Unable to refresh your session. Please try again." });
        }
        break;
      }
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
        if (data.partner) {
          const partner = this.sessionById(data.partner);
          if (partner) this.send(partner.ws, { ...msg, from: data.id });
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
        if (data.partner && data.partner === msg.target) {
          const reported = this.sessionById(data.partner);
          if (reported) this.send(reported.ws, { type: "reported" });
          if (reported && data.accessToken) {
            fetch(`${this.env.SUPABASE_URL}/rest/v1/reported_messages`, {
              method: "POST",
              headers: {
                apikey: this.env.SUPABASE_ANON_KEY,
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
        this.save(partner.ws, partner.data);
        this.send(partner.ws, { type: "partner_left" });
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
        // A transient Supabase/network failure is not proof that the user is banned.
        // Keep the active call alive and retry on the next scheduled alarm.
        console.error("Periodic ban verification failed; keeping session and retrying:", error.message);
      }
    }
    await this.updateBanAlarm();
  }
}
