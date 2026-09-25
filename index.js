require("dotenv").config();
const { Client, GatewayIntentBits, ActivityType, ApplicationCommandOptionType } = require("discord.js");
const { joinVoiceChannel, createAudioPlayer, createAudioResource, entersState, VoiceConnectionStatus, AudioPlayerStatus, StreamType } = require("@discordjs/voice");
const { execFile, spawn } = require("child_process");
const https = require("https");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const express = require("express");
const session = require("express-session");
const cookieParser = require("cookie-parser");

const TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.DISCORD_CLIENT_ID || "1552647926780534874";
const CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET || "";
const BASE_URL = process.env.BASE_URL || "";
const BOT_NAME = "NOTIXMIX";
const START_TIME = Date.now();

// ---------------------------------------------------------------------------
// Rate-limited yt-dlp request queue
// Prevents YouTube 429 (Too Many Requests) by serializing and throttling
// yt-dlp calls with a configurable cooldown between requests.
// ---------------------------------------------------------------------------
const YTDLP_MAX_CONCURRENT = 2;          // max simultaneous yt-dlp processes
const YTDLP_COOLDOWN_MS = 1500;           // min ms between launching new yt-dlp calls
let ytdlpActiveCount = 0;
let ytdlpLastCall = 0;
const ytdlpPendingQueue = [];             // { resolve, reject, args, timeout }

function enqueueYtDlp(args, timeout = 30000) {
  return new Promise((resolve, reject) => {
    ytdlpPendingQueue.push({ resolve, reject, args, timeout });
    drainYtDlpQueue();
  });
}

async function drainYtDlpQueue() {
  if (ytdlpActiveCount >= YTDLP_MAX_CONCURRENT || ytdlpPendingQueue.length === 0) return;
  const now = Date.now();
  const wait = YTDLP_COOLDOWN_MS - (now - ytdlpLastCall);
  if (wait > 0) {
    setTimeout(() => drainYtDlpQueue(), wait);
    return;
  }
  const job = ytdlpPendingQueue.shift();
  if (!job) return;
  ytdlpActiveCount++;
  ytdlpLastCall = Date.now();
  try {
    const result = await runYtDlpRaw(job.args, job.timeout);
    job.resolve(result);
  } catch (e) {
    job.reject(e);
  } finally {
    ytdlpActiveCount--;
    // Small delay before draining the next item to space out calls
    setTimeout(() => drainYtDlpQueue(), YTDLP_COOLDOWN_MS);
  }
}

// ---------------------------------------------------------------------------
// Discord message queue — sends messages sequentially per channel to avoid
// hitting Discord's per-channel rate limit and ensures messages arrive in
// the correct order.
// ---------------------------------------------------------------------------
const channelMessageQueues = new Map(); // channelId -> { queue: [], processing: bool }

function safeSend(channel, payload) {
  if (!channel || typeof channel.send !== "function") return Promise.resolve();
  const channelId = channel.id || "unknown";
  if (!channelMessageQueues.has(channelId)) {
    channelMessageQueues.set(channelId, { queue: [], processing: false });
  }
  const q = channelMessageQueues.get(channelId);
  return new Promise((resolve) => {
    q.queue.push({ payload, resolve });
    processChannelQueue(channelId);
  });
}

async function processChannelQueue(channelId) {
  const q = channelMessageQueues.get(channelId);
  if (!q || q.processing || q.queue.length === 0) return;
  q.processing = true;
  while (q.queue.length > 0) {
    const { payload, resolve } = q.queue.shift();
    try {
      // Find the channel object from the client cache
      const data = typeof payload === "string" ? { content: payload } : payload;
      const channel = client.channels?.cache?.get(channelId);
      if (channel && typeof channel.send === "function") {
        await channel.send(data);
      }
    } catch (err) {
      // If we hit a rate limit, wait for the retry-after duration
      if (err?.status === 429 || err?.httpStatus === 429) {
        const retryAfter = (err.retryAfter || 2) * 1000;
        console.warn(`Discord rate limit on channel ${channelId}, waiting ${retryAfter}ms`);
        await new Promise((r) => setTimeout(r, retryAfter));
      } else {
        console.error("safeSend error:", err.message || err);
      }
    }
    // Small spacing between messages to stay well under rate limits
    await new Promise((r) => setTimeout(r, 300));
  }
  q.processing = false;
  // Clean up empty queues to prevent memory leak
  if (q.queue.length === 0) channelMessageQueues.delete(channelId);
}

// ---------------------------------------------------------------------------
// Per-guild play command cooldown
// ---------------------------------------------------------------------------
const guildPlayCooldowns = new Map();     // guildId -> timestamp of last /play
const PLAY_COOLDOWN_MS = 3000;            // 3 seconds between /play per guild

const SLASH_COMMANDS = [
  { name: "play", description: "Play a YouTube video, Spotify track/playlist, or search query", options: [{ type: ApplicationCommandOptionType.String, name: "query", description: "YouTube URL, Spotify link, or search terms", required: true }] },
  { name: "skip", description: "Skip the current song" },
  { name: "stop", description: "Stop playback and clear the queue" },
  { name: "pause", description: "Pause playback" },
  { name: "resume", description: "Resume playback" },
  { name: "queue", description: "Show the current queue" },
  { name: "loop", description: "Toggle loop mode" },
  { name: "volume", description: "Set the playback volume", options: [{ type: ApplicationCommandOptionType.Integer, name: "level", description: "Volume from 0 to 10", required: true, min_value: 0, max_value: 10 }] },
  { name: "remove", description: "Remove a song from the queue", options: [{ type: ApplicationCommandOptionType.Integer, name: "number", description: "Queue position (1-based)", required: true, min_value: 1 }] },
  { name: "clear", description: "Clear the queue" },
  { name: "nowplaying", description: "Show the currently playing song" },
  { name: "help", description: "List all commands" },
];

function resolveYtDlp() {
  if (process.env.YTDLP_PATH && fs.existsSync(process.env.YTDLP_PATH)) return process.env.YTDLP_PATH;
  const local = path.join(__dirname, process.platform === "win32" ? "yt-dlp.exe" : "yt-dlp");
  if (fs.existsSync(local)) return local;
  return "yt-dlp";
}
let YTDLP = resolveYtDlp();

// Auto-download yt-dlp if missing at runtime (Linux only — for Render/Docker)
async function ensureYtDlp() {
  // Quick check — can we actually run the resolved binary?
  try {
    const { execFileSync } = require("child_process");
    execFileSync(YTDLP, ["--version"], { timeout: 10000 });
    console.log(`yt-dlp found at: ${YTDLP}`);
    return; // works fine
  } catch {
    // Not found or not executable — try to download
  }

  if (process.platform === "win32") {
    console.error("yt-dlp.exe not found — please download it and place it in the project folder.");
    return;
  }

  const dest = path.join(__dirname, "yt-dlp");
  console.log("yt-dlp not found — downloading latest release...");
  try {
    const { execSync } = require("child_process");
    execSync(
      `curl -fL https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o "${dest}" && chmod a+rx "${dest}"`,
      { timeout: 60000, stdio: "inherit" }
    );
    if (fs.existsSync(dest)) {
      YTDLP = dest;
      console.log(`yt-dlp downloaded to: ${YTDLP}`);
    }
  } catch (e) {
    console.error("Failed to auto-download yt-dlp:", e.message);
  }
}

// Optional YouTube credentials: a cookies.txt exported from a logged-in
// browser session is the most reliable way past "not a bot" checks.
function ytCookieArgs() {
  if (process.env.YTDLP_COOKIES && fs.existsSync(process.env.YTDLP_COOKIES)) {
    return ["--cookies", process.env.YTDLP_COOKIES];
  }
  if (process.env.YTDLP_COOKIES_FROM_BROWSER) {
    return ["--cookies-from-browser", process.env.YTDLP_COOKIES_FROM_BROWSER];
  }
  return [];
}

// Raw yt-dlp execution — called only via the rate-limited queue
function runYtDlpRaw(args, timeout = 30000) {
  return new Promise((resolve, reject) => {
    execFile(YTDLP, ["--no-warnings", ...ytCookieArgs(), ...args], { maxBuffer: 10 * 1024 * 1024, timeout }, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr || err.message));
      else resolve(stdout.trim());
    });
  });
}

// Public interface — all yt-dlp calls go through the rate-limited queue
function runYtDlp(args, timeout = 30000) {
  return enqueueYtDlp(args, timeout);
}

// ---------------------------------------------------------------------------
// YouTube player-client fallback
// "Sign in to confirm you're not a bot" is checked per player client, so when
// one client is blocked we retry with the next one in the list.
// ---------------------------------------------------------------------------
const TRANSIENT_YT_ERROR = /not a bot|sign in to confirm|too many requests|http error 429|http error 5\d\d|rate.?limit|page needs to be reloaded|please retry/i;

function isTransientYtError(msg) {
  return TRANSIENT_YT_ERROR.test(String(msg || ""));
}

function resolveYtClients() {
  const fallback = process.env.YTDLP_CLIENTS || "android_vr,web_embedded,mweb,tv_embedded";
  return fallback.split(",").map((s) => s.trim()).filter(Boolean);
}

function ytClientArgs(client) {
  return client ? ["--extractor-args", `youtube:player_client=${client}`] : [];
}

// Tries the default client first, then each fallback client while YouTube
// keeps returning bot-check / rate-limit errors. Non-transient errors
// (private video, bad URL, ...) are thrown immediately.
// Resolves with { out, client } so the caller can reuse the client that worked.
async function withYtClients(args, timeout = 30000, runner = runYtDlp) {
  const clients = [null, ...resolveYtClients()];
  let lastErr = null;
  for (let i = 0; i < clients.length; i++) {
    try {
      const out = await runner([...args, ...ytClientArgs(clients[i])], timeout);
      return { out, client: clients[i] };
    } catch (e) {
      lastErr = e;
      if (!isTransientYtError(e.message)) throw e;
      if (i < clients.length - 1) await new Promise((r) => setTimeout(r, 750));
    }
  }
  throw lastErr;
}

function isYouTubeUrl(s) {
  return /^https?:\/\/(www\.)?(youtube\.com|youtu\.be)\//i.test(s);
}

function isSoundCloudUrl(s) {
  return /^https?:\/\/(www\.)?soundcloud\.com\/\S+/i.test(String(s || "").trim());
}

// Turns yt-dlp's JSON dump (single entry or a 1-entry search result) into { url, title }.
function parseYtDlpInfo(json) {
  const info = JSON.parse(json);
  if (!info) throw new Error("No results");

  if (info._type === "playlist") {
    const entry = Array.isArray(info.entries) ? info.entries[0] : null;
    if (!entry) throw new Error("No results");
    const url = entry.webpage_url || entry.url;
    if (!url) throw new Error("No results");
    return { url, title: entry.title || info.title || "Unknown" };
  }

  if (!info.webpage_url) throw new Error("No results");
  return { url: info.webpage_url, title: info.title || "Unknown" };
}

// SoundCloud has no "not a bot" checks, so it doubles as a free fallback
// source when YouTube blocks this server's IP.
async function resolveSoundCloud(query) {
  const json = await runYtDlp(["-J", "--no-playlist", `scsearch1:${query}`]);
  const parsed = parseYtDlpInfo(json);
  return { ...parsed, source: "soundcloud", client: null };
}

async function resolveVideo(query, retries = 2) {
  const q = String(query || "").trim();
  const isYtUrl = isYouTubeUrl(q);
  const isScUrl = isSoundCloudUrl(q);
  const target = isYtUrl || isScUrl ? q : `ytsearch1:${q}`;
  try {
    const { out, client } = await withYtClients(["-J", "--no-playlist", target]);
    const parsed = parseYtDlpInfo(out);
    return { ...parsed, source: isScUrl ? "soundcloud" : "youtube", client };
  } catch (e) {
    // YouTube bot-check on a search query → retry against SoundCloud, which
    // never asks for bot verification (only worth trying for search terms).
    if (!isYtUrl && !isScUrl && isTransientYtError(e.message)) {
      try {
        console.warn(`YouTube blocked the search (${e.message.split("\n")[0]}) — falling back to SoundCloud`);
        return await resolveSoundCloud(q);
      } catch (scErr) {
        console.error("SoundCloud fallback failed:", scErr.message);
      }
    }
    if (retries > 0) {
      await new Promise((r) => setTimeout(r, 1500));
      return resolveVideo(query, retries - 1);
    }
    console.error("resolveVideo failed:", e.message);
    throw e;
  }
}

function describeYtDlpError(msg) {
  const m = String(msg || "");
  if (/HTTP Error 429|Too Many Requests|rate.?limit/i.test(m)) {
    return "YouTube is rate-limiting this server right now — wait a few seconds and try again.";
  }
  if (/not a bot/i.test(m)) {
    return "YouTube is asking for bot verification on this server's IP — it usually clears in a minute. Searches automatically retry on SoundCloud; paste a SoundCloud link to play now, or set YTDLP_COOKIES in .env to a cookies.txt exported from a logged-in browser.";
  }
  if (/Private video/i.test(m)) return "That video is private.";
  if (/age.restricted|Sign in to confirm your age|inappropriate for some users/i.test(m)) {
    return "That video is age-restricted and can't be played.";
  }
  if (/Video unavailable|video has been removed|This video is unavailable/i.test(m)) {
    return "That video is unavailable or has been removed.";
  }
  if (/not available in your country|geo.?restrict/i.test(m)) {
    return "That video is not available in this region.";
  }
  if (/spawn ffmpeg|ffmpeg.*(not found|no such file)/i.test(m)) {
    return "FFmpeg not found — reinstall dependencies (npm install) or add ffmpeg to PATH.";
  }
  if (/enoent|yt-dlp.*(not found|no such file)|spawn .* ENOENT/i.test(m)) {
    return "yt-dlp binary not found — set YTDLP_PATH or install yt-dlp.";
  }
  if (/timed out|timeout|etimedout|econnreset|network/i.test(m)) {
    return "Network timeout while contacting YouTube — try again.";
  }
  if (/Unsupported URL|no results|not a valid URL/i.test(m)) {
    return "Couldn't find any results for that URL or query.";
  }
  return "Couldn't fetch that track — try again in a few seconds.";
}

// ---------------------------------------------------------------------------
// Spotify support
// Metadata comes from Spotify's official Web API (client-credentials flow)
// when SPOTIFY_CLIENT_ID + SPOTIFY_CLIENT_SECRET are set, and falls back to
// the public embed page otherwise. Each track is then matched against
// YouTube via yt-dlp for playback — Spotify exposes no audio streams.
// ---------------------------------------------------------------------------
const SPOTIFY_MAX_TRACKS = 50;
const SPOTIFY_EMBED_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const SPOTIFY_API = "https://api.spotify.com/v1";
const SPOTIFY_CLIENT_ID = process.env.SPOTIFY_CLIENT_ID || "";
const SPOTIFY_CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET || "";
const SPOTIFY_USE_API = Boolean(SPOTIFY_CLIENT_ID && SPOTIFY_CLIENT_SECRET);

function isSpotifyLink(s) {
  const v = String(s || "").trim();
  return /^spotify:(track|album|playlist|episode|show):/i.test(v) ||
    /^https?:\/\/(open\.spotify\.com|play\.spotify\.com|spotify\.link)\/\S+/i.test(v);
}

function parseSpotifyUrl(input) {
  const s = String(input || "").trim();
  const uri = s.match(/^spotify:(track|album|playlist|episode|show):([A-Za-z0-9]+)$/i);
  if (uri) return { type: uri[1].toLowerCase(), id: uri[2] };
  const m = s.match(/^https?:\/\/(?:open|play)\.spotify\.com\/(?:intl-[a-z-]+\/)?(track|album|playlist|episode|show)\/([A-Za-z0-9]+)/i);
  if (m) return { type: m[1].toLowerCase(), id: m[2] };
  return null;
}

// Minimal HTTP text request with redirect following. Returns { status, body, finalUrl }.
function httpRequestText(method, url, { headers = {}, body = null } = {}, redirects = 5) {
  return new Promise((resolve, reject) => {
    if (redirects <= 0) return reject(new Error("Too many redirects"));
    const lib = url.startsWith("http:") ? require("http") : https;
    const payload = body == null ? null : Buffer.from(String(body), "utf8");
    const hdrs = Object.assign({ "User-Agent": SPOTIFY_EMBED_UA, Accept: "text/html,application/json,*/*" }, headers);
    if (payload) hdrs["Content-Length"] = payload.length;
    const req = lib.request(url, { method, headers: hdrs }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        const next = new URL(res.headers.location, url).toString();
        return httpRequestText(method, next, { headers, body }, redirects - 1).then(resolve, reject);
      }
      let out = "";
      res.setEncoding("utf8");
      res.on("data", (c) => { out += c; });
      res.on("end", () => resolve({ status: res.statusCode, body: out, finalUrl: url }));
      res.on("error", reject);
    });
    req.on("error", reject);
    req.setTimeout(20000, () => req.destroy(new Error("Spotify request timed out")));
    if (payload) req.write(payload);
    req.end();
  });
}

async function httpGetText(url, redirects = 5) {
  const res = await httpRequestText("GET", url, {}, redirects);
  if (res.status !== 200) {
    const err = new Error(`HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return { body: res.body, finalUrl: res.finalUrl };
}

function extractSpotifyEntity(html) {
  const m = String(html).match(/<script[^>]*id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) return null;
  try {
    const data = JSON.parse(m[1]);
    return data?.props?.pageProps?.state?.data?.entity || null;
  } catch {
    return null;
  }
}

function spotifySearchQuery(track) {
  return track.artist ? `${track.artist} - ${track.title}` : track.title;
}

// --- Official Web API (client-credentials flow) ----------------------------
let spotifyTokenCache = { value: null, expiresAt: 0 };

async function getSpotifyToken(forceRefresh = false) {
  if (!forceRefresh && spotifyTokenCache.value && Date.now() < spotifyTokenCache.expiresAt - 60000) {
    return spotifyTokenCache.value;
  }
  const basic = Buffer.from(`${SPOTIFY_CLIENT_ID}:${SPOTIFY_CLIENT_SECRET}`).toString("base64");
  let res;
  try {
    res = await httpRequestText("POST", "https://accounts.spotify.com/api/token", {
      headers: { Authorization: `Basic ${basic}`, "Content-Type": "application/x-www-form-urlencoded" },
      body: "grant_type=client_credentials",
    });
  } catch (e) {
    throw new Error(`Couldn't reach Spotify's auth server — ${e.message}`);
  }
  if (res.status === 400 || res.status === 401) {
    const err = new Error("Spotify rejected SPOTIFY_CLIENT_ID / SPOTIFY_CLIENT_SECRET — fix them in your environment.");
    err.spotifyConfig = true;
    throw err;
  }
  if (res.status !== 200) throw new Error(`Spotify auth failed (HTTP ${res.status}) — try again shortly.`);
  let data;
  try {
    data = JSON.parse(res.body);
  } catch {
    throw new Error("Spotify returned an invalid token response.");
  }
  if (!data.access_token) throw new Error("Spotify didn't return an access token.");
  spotifyTokenCache.value = data.access_token;
  spotifyTokenCache.expiresAt = Date.now() + (Number(data.expires_in) || 3600) * 1000;
  return spotifyTokenCache.value;
}

async function spotifyApiGet(pathname, retryAuth = true) {
  const token = await getSpotifyToken();
  let res;
  try {
    res = await httpRequestText("GET", `${SPOTIFY_API}${pathname}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    });
  } catch (e) {
    throw new Error(`Couldn't reach Spotify — ${e.message}`);
  }
  if (res.status === 200) {
    try {
      return JSON.parse(res.body);
    } catch {
      throw new Error("Spotify returned an invalid response.");
    }
  }
  if (res.status === 401 && retryAuth) {
    spotifyTokenCache.value = null;
    return spotifyApiGet(pathname, false);
  }
  if (res.status === 404) throw new Error("That Spotify link is invalid or unavailable.");
  if (res.status === 429) throw new Error("Spotify is rate-limiting this server — try again in a minute.");
  if (res.status >= 500) throw new Error(`Spotify is having issues right now (HTTP ${res.status}) — try again.`);
  throw new Error(`Spotify API error (HTTP ${res.status}).`);
}

function spotifyTrackFields(items) {
  return items
    .filter((t) => t && t.name)
    .map((t) => ({
      title: t.name,
      artist: (t.artists || []).map((a) => a && a.name).filter(Boolean).join(", "),
    }));
}

async function resolveSpotifyViaApi(ref) {
  if (ref.type === "track") {
    const t = await spotifyApiGet(`/tracks/${encodeURIComponent(ref.id)}`);
    if (!t.name) throw new Error("Couldn't read that track from Spotify.");
    return { kind: "track", title: t.name, total: 1, tracks: spotifyTrackFields([t]) };
  }

  if (ref.type === "album") {
    const a = await spotifyApiGet(`/albums/${encodeURIComponent(ref.id)}`);
    const tracks = spotifyTrackFields((a.tracks && Array.isArray(a.tracks.items)) ? a.tracks.items : []);
    if (!tracks.length) throw new Error("No playable tracks found in that Spotify album.");
    return {
      kind: "album",
      title: a.name || "Album",
      total: Number(a.total_tracks) || tracks.length,
      tracks: tracks.slice(0, SPOTIFY_MAX_TRACKS),
    };
  }

  const list = await spotifyApiGet(`/playlists/${encodeURIComponent(ref.id)}?fields=name,tracks(total)`);
  const page = await spotifyApiGet(`/playlists/${encodeURIComponent(ref.id)}/tracks?limit=50`);
  const tracks = spotifyTrackFields(
    (page.items || []).map((item) => item && item.track).filter((t) => t && t.type === "track")
  );
  if (!tracks.length) throw new Error("No playable tracks found in that Spotify playlist.");
  return {
    kind: "playlist",
    title: list.name || "Playlist",
    total: (list.tracks && Number(list.tracks.total)) || tracks.length,
    tracks: tracks.slice(0, SPOTIFY_MAX_TRACKS),
  };
}

// Resolves a Spotify track/album/playlist link into playable track metadata.
async function resolveSpotify(input) {
  const raw = String(input || "").trim();
  let ref = parseSpotifyUrl(raw);
  if (!ref) {
    // Short link (spotify.link/...) — follow the redirect to the real URL
    let finalUrl;
    try {
      ({ finalUrl } = await httpGetText(raw));
    } catch {
      throw new Error("Couldn't reach that Spotify link — try again in a few seconds.");
    }
    ref = parseSpotifyUrl(finalUrl);
    if (!ref) throw new Error("That Spotify link isn't a track, album, or playlist.");
  }
  if (ref.type === "episode" || ref.type === "show") {
    throw new Error("Podcasts aren't supported — paste a Spotify track, album, or playlist link instead.");
  }

  if (SPOTIFY_USE_API) {
    try {
      return await resolveSpotifyViaApi(ref);
    } catch (e) {
      if (e && e.spotifyConfig) throw e; // bad credentials — surface instead of masking
      console.warn(`Spotify API lookup failed (${e.message}) — falling back to embed metadata.`);
    }
  }

  let body;
  try {
    ({ body } = await httpGetText(`https://open.spotify.com/embed/${ref.type}/${ref.id}`));
  } catch {
    throw new Error("Couldn't reach Spotify right now — try again in a few seconds.");
  }

  const entity = extractSpotifyEntity(body);
  if (!entity) throw new Error("Couldn't read that Spotify link — it may be private or unavailable.");

  if (entity.type === "track" || ref.type === "track") {
    const artist = (entity.artists || []).map((a) => a?.name).filter(Boolean).join(", ");
    const title = entity.name || entity.title;
    if (!title) throw new Error("Couldn't read that track from Spotify.");
    return { kind: "track", title, total: 1, tracks: [{ title, artist }] };
  }

  const list = Array.isArray(entity.trackList) ? entity.trackList : [];
  const container = entity.title || entity.name || (ref.type === "album" ? "Album" : "Playlist");
  const all = list
    .filter((t) => t && t.title && (!t.entityType || t.entityType === "track"))
    .map((t) => ({ title: t.title, artist: t.subtitle || "" }));
  if (all.length === 0) {
    throw new Error(`No playable tracks found in that Spotify ${ref.type}.`);
  }
  return {
    kind: ref.type,
    title: container,
    total: all.length,
    tracks: all.slice(0, SPOTIFY_MAX_TRACKS),
  };
}

async function getStreamUrl(url, retries = 2) {
  try {
    const { out } = await withYtClients(["-f", "bestaudio/best", "--get-url", url], 45000);
    return out.split(/\r?\n/)[0] || out;
  } catch (e) {
    if (retries > 0) {
      // Exponential backoff: wait longer on each retry
      const delay = 2000 * (3 - retries);
      await new Promise((r) => setTimeout(r, delay));
      return getStreamUrl(url, retries - 1);
    }
    throw e;
  }
}

// ---------------------------------------------------------------------------
// Playback: yt-dlp -> ffmpeg -> PCM -> AudioResource
// The previous path fetched a direct stream URL and piped it into demuxProbe.
// Those URLs are IP-bound, expire, and carry no retry, so any hiccup silently
// killed the track. Spawning yt-dlp keeps its retries/range requests in charge
// of the whole transfer, and ffmpeg (bundled via ffmpeg-static) decodes every
// container YouTube or SoundCloud can hand back, including HLS.
// ---------------------------------------------------------------------------
let FFMPEG_BIN = null;
function resolveFfmpeg() {
  if (FFMPEG_BIN) return FFMPEG_BIN;
  try {
    const p = require("ffmpeg-static");
    const v = (p && p.path) || p;
    if (typeof v === "string" && v && fs.existsSync(v)) FFMPEG_BIN = v;
  } catch { /* fall through to PATH lookup */ }
  if (!FFMPEG_BIN) FFMPEG_BIN = "ffmpeg";
  return FFMPEG_BIN;
}

function stopPipe(pipe) {
  if (!pipe) return;
  try { if (pipe.ytdlp && !pipe.ytdlp.killed) pipe.ytdlp.kill(); } catch { /* already gone */ }
  try { if (pipe.ffmpeg && !pipe.ffmpeg.killed) pipe.ffmpeg.kill(); } catch { /* already gone */ }
}

// Spawns yt-dlp writing audio to stdout, piped through ffmpeg into raw PCM
// (48kHz stereo) that @discordjs/voice encodes to opus. `started` resolves once
// audio actually flows, so a failed extraction surfaces as an error we can
// report instead of leaving the channel in silence.
function createPipedResource(song) {
  const ytdlp = spawn(YTDLP, [
    "--no-warnings",
    ...ytCookieArgs(),
    "-f", "bestaudio/best",
    "--no-playlist",
    "-o", "-",
    ...ytClientArgs(song.client || null),
    song.url,
  ], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });

  let stderr = "";
  ytdlp.stderr.on("data", (d) => { stderr = (stderr + d.toString()).slice(-4000); });

  const ffmpeg = spawn(resolveFfmpeg(), [
    "-hide_banner", "-loglevel", "error", "-nostdin",
    "-i", "pipe:0", "-vn",
    "-f", "s16le", "-ar", "48000", "-ac", "2",
    "pipe:1",
  ], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });

  // EPIPE is normal whenever yt-dlp finishes or dies before ffmpeg does.
  ffmpeg.stdin.on("error", () => {});
  ytdlp.stdout.pipe(ffmpeg.stdin);

  const resource = createAudioResource(ffmpeg.stdout, {
    inputType: StreamType.Raw,
    inlineVolume: true,
  });

  const started = new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };
    const timer = setTimeout(() => finish(reject, new Error("Timed out starting the stream")), 45000);
    ffmpeg.stdout.once("data", () => finish(resolve));
    ytdlp.once("error", (e) => finish(reject, e));
    ffmpeg.once("error", (e) => finish(reject, e));
    ytdlp.once("exit", (code) => {
      // Exit code 0 just means yt-dlp finished writing — ffmpeg may still be
      // draining, so only a real failure counts as an error here.
      if (code !== 0) finish(reject, new Error(stderr.trim() || `yt-dlp exited with code ${code}`));
    });
  });

  return { ytdlp, ffmpeg, resource, started };
}

function createClient() {
  return new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent] });
}

const client = createClient();
const queue = new Map();

function getQueue(guildId) {
  return queue.get(guildId);
}

function createQueue(guildId) {
  const q = {
    songs: [],
    volume: 5,
    loop: false,
    textChannel: null,
    voiceChannel: null,
    connection: null,
    player: null,
    resource: null,
    _starting: false,
    _announceNext: false,
    _advanceMode: null, // null = default advance, "keep" = songs already adjusted, "force" = advance even when looping
  };
  queue.set(guildId, q);
  return q;
}

function destroyVoice(q) {
  try {
    stopPipe(q && q._pipe);
    if (q) q._pipe = null;
  } catch (e) {
    console.error("Pipe destroy failed:", e);
  }
  try {
    if (q && q.connection && q.connection.state && q.connection.state.status !== "destroyed") {
      q.connection.destroy();
    }
  } catch (e) {
    console.error("Voice destroy failed:", e);
  }
}

function destroyQueue(guildId, q) {
  destroyVoice(q);
  queue.delete(guildId);
}

async function play(guildId) {
  const q = getQueue(guildId);
  if (!q || q.songs.length === 0) {
    if (q) destroyQueue(guildId, q);
    return;
  }
  if (q._starting) return;
  q._starting = true;

  if (!q.connection || q.connection.state.status === VoiceConnectionStatus.Destroyed) {
    q._starting = false;
    destroyQueue(guildId, q);
    if (q.textChannel) {
      safeSend(q.textChannel, "❌ Lost the voice connection — stopped playback.");
    }
    return;
  }
  try {
    await entersState(q.connection, VoiceConnectionStatus.Ready, 20000);
  } catch {
    q._starting = false;
    if (getQueue(guildId) === q) {
      destroyQueue(guildId, q);
      if (q.textChannel) {
        safeSend(q.textChannel, "❌ Could not connect to the voice channel — stopped playback.");
      }
    }
    return;
  }

  const song = q.songs[0];
  let pipe = null;

  try {
    // Spotify tracks are queued without a stream URL — resolve the match
    // lazily right before playback so big playlists load instantly.
    if (!song.url) {
      const resolved = await resolveVideo(song.search || song.title);
      if (getQueue(guildId) !== q) {
        q._starting = false;
        return;
      }
      if (q.songs[0] !== song) {
        q._starting = false;
        play(guildId).catch(() => {});
        return;
      }
      song.url = resolved.url;
      song.client = resolved.client;
      song.source = resolved.source || song.source;
    }

    // yt-dlp -> ffmpeg -> PCM. `started` only resolves once audio flows, so a
    // bot-check or bad URL throws into the catch below and skips the track.
    pipe = createPipedResource(song);
    try {
      await pipe.started;
    } catch (e) {
      stopPipe(pipe);
      pipe = null;
      throw e;
    }

    if (getQueue(guildId) !== q) {
      stopPipe(pipe);
      q._starting = false;
      return;
    }

    if (q.songs[0] !== song) {
      stopPipe(pipe);
      q._starting = false;
      play(guildId).catch(() => {});
      return;
    }

    stopPipe(q._pipe); // tear down the previous track's processes
    q._pipe = pipe;
    q.resource = pipe.resource;

    if (!q.player) {
      q.player = createAudioPlayer();
    }

    q.player.removeAllListeners();
    q.player.on(AudioPlayerStatus.Idle, () => {
      stopPipe(q._pipe);
      q._pipe = null;
      const mode = q._advanceMode;
      q._advanceMode = null;
      if (mode === "keep") {
        play(guildId).catch(() => {});
      } else if (mode === "force" || !q.loop) {
        q.songs.shift();
        play(guildId).catch(() => {});
      } else {
        play(guildId).catch(() => {});
      }
    });

    q.player.on(AudioPlayerStatus.Playing, () => {
      if (!q._announceNext) return;
      q._announceNext = false;
      if (q.textChannel) {
        const label = song.source === "soundcloud" ? `**${song.title}** _(SoundCloud)_` : `**${song.title}**`;
        safeSend(q.textChannel, { content: `🎵 Now playing: ${label}` });
      }
    });

    q.player.on("error", (error) => {
      console.error("Player error:", error);
      // The player transitions to Idle right after emitting "error";
      // flag the advance so the Idle handler drops the broken track
      // even when loop is enabled (and does not advance twice).
      if (!q._advanceMode) q._advanceMode = "force";
      if (q.textChannel) {
        safeSend(q.textChannel, { content: `⚠️ Playback error on **${song.title}** — skipping.` });
      }
    });

    if (!q.connection || getQueue(guildId) !== q) {
      stopPipe(pipe);
      q._starting = false;
      return;
    }
    q._announceNext = true;
    q.connection.subscribe(q.player);
    q.player.play(pipe.resource);
    if (q.resource && q.resource.volume) {
      q.resource.volume.setVolume(q.volume / 10);
    }
  } catch (e) {
    console.error("Play error:", e);
    stopPipe(pipe);
    if (q._pipe === pipe) q._pipe = null;
    if (getQueue(guildId) !== q) {
      q._starting = false;
      return;
    }
    if (q.textChannel) {
      safeSend(q.textChannel, { content: `⚠️ Skipping **${song.title}** — ${describeYtDlpError(e.message)}` });
    }
    if (q.songs[0] === song) q.songs.shift();
    q._advanceMode = null;
    q._starting = false;
    return play(guildId);
  }
  q._starting = false;
}

function addSongToQueue(guildId, songs, textChannel) {
  const q = getQueue(guildId) || createQueue(guildId);
  if (!q.textChannel) q.textChannel = textChannel;
  for (const song of songs) q.songs.push(song);
  return q;
}

function setupVoiceConnection(guildId, voiceChannel, message) {
  const q = getQueue(guildId);
  if (!q.voiceChannel) {
    try {
      q.connection = joinVoiceChannel({
        channelId: voiceChannel.id,
        guildId: guildId,
        adapterCreator: message.guild.voiceAdapterCreator,
      });
      q.voiceChannel = voiceChannel;
      q.connection.on(VoiceConnectionStatus.Disconnected, async () => {
        if (getQueue(guildId) !== q) return;
        try {
          await Promise.race([
            entersState(q.connection, VoiceConnectionStatus.Signalling, 5000),
            entersState(q.connection, VoiceConnectionStatus.Connecting, 5000),
          ]);
          await entersState(q.connection, VoiceConnectionStatus.Ready, 20000);
        } catch {
          if (getQueue(guildId) === q) {
            destroyVoice(q);
            queue.delete(guildId);
          }
        }
      });
    } catch (e) {
      console.error(e);
    }
  }
}

async function handlePlayCommand(message, args) {
  const guildId = message.guild.id;
  const textChannel = message.channel;
  const voiceChannel = message.member?.voice?.channel;
  if (!voiceChannel) {
    return message.reply("❌ You need to be in a voice channel to use this command!").catch(() => {});
  }

  if (!args[0]) {
    return message.reply("❌ Please provide a YouTube URL, SoundCloud link, Spotify link, or search query!").catch(() => {});
  }

  // Per-guild cooldown to prevent spamming /play
  const now = Date.now();
  const lastPlay = guildPlayCooldowns.get(guildId) || 0;
  if (now - lastPlay < PLAY_COOLDOWN_MS) {
    const wait = Math.ceil((PLAY_COOLDOWN_MS - (now - lastPlay)) / 1000);
    return message.reply(`⏳ Please wait ${wait}s before using /play again.`).catch(() => {});
  }
  guildPlayCooldowns.set(guildId, now);

  const query = args.join(" ");
  const spotify = isSpotifyLink(query);
  let songs;
  let container = null;

  if (spotify) {
    let sp;
    try {
      sp = await resolveSpotify(query);
    } catch (e) {
      console.error("Spotify resolve error:", e.message);
      return message.reply("❌ " + e.message).catch(() => {});
    }
    container = sp.title;
    songs = sp.tracks.map((t) => ({
      url: null,
      title: t.title,
      artist: t.artist,
      search: spotifySearchQuery(t),
      source: "spotify",
    }));
    if (sp.total > sp.tracks.length) {
      container = `${sp.title} (first ${sp.tracks.length} of ${sp.total})`;
    }
  } else {
    try {
      const resolved = await resolveVideo(query);
      songs = [{ url: resolved.url, title: resolved.title, source: resolved.source || "youtube", client: resolved.client }];
    } catch (e) {
      console.error("Play resolve error:", e.message);
      return message.reply("❌ " + describeYtDlpError(e.message)).catch(() => {});
    }
  }

  const existing = getQueue(guildId);
  const wasEmpty = !existing || existing.songs.length === 0;
  const q = addSongToQueue(guildId, songs, textChannel);
  const first = songs[0];

  if (wasEmpty) {
    message.reply(
      songs.length > 1
        ? `🎶 Queued **${songs.length}** tracks from **${container}** — joining voice…`
        : `🎶 **${first.title}** — joining voice…`
    ).catch(() => {});
    setupVoiceConnection(guildId, voiceChannel, message);
    try {
      if (!q.connection) {
        queue.delete(guildId);
        message.reply("❌ Could not join voice channel!").catch(() => {});
        return;
      }
      await entersState(q.connection, VoiceConnectionStatus.Ready, 20000);
      play(guildId).catch(() => {});
    } catch {
      destroyVoice(q);
      queue.delete(guildId);
      message.reply("❌ Could not join voice channel!").catch(() => {});
    }
  } else if (songs.length > 1) {
    safeSend(textChannel, { content: `🎶 Added **${songs.length}** tracks from **${container}** (${q.songs.length - songs.length} already in queue)` });
  } else {
    safeSend(textChannel, { content: `🎶 Added to queue: **${first.title}** (${q.songs.length - 1} more in queue)` });
  }
}

function handleSkipCommand(message) {
  const q = getQueue(message.guild.id);
  if (!q || !q.player || q.songs.length === 0 || q.player.state.status === AudioPlayerStatus.Idle) {
    return message.reply("❌ Nothing is playing!").catch(() => {});
  }
  // Check remaining *before* stop(), because stop() triggers the Idle
  // handler synchronously which shifts the songs array.
  const hasMore = q.songs.length > 1;
  q._advanceMode = "force";
  q.player.stop(true);
  message.reply(hasMore ? "⏭️ Skipped!" : "⏭️ Skipped — the queue has finished!").catch(() => {});
}

function handleStopCommand(message) {
  const q = getQueue(message.guild.id);
  if (!q) {
    return message.reply("❌ Nothing is playing!").catch(() => {});
  }
  q.songs = [];
  queue.delete(message.guild.id);
  if (q.player) q.player.stop(true);
  destroyVoice(q);
  message.reply("⏹️ Stopped!").catch(() => {});
}

function handlePauseCommand(message) {
  const q = getQueue(message.guild.id);
  if (!q || !q.player) {
    return message.reply("❌ Nothing is playing!").catch(() => {});
  }
  if (!q.player.pause()) {
    return message.reply("⚠️ Playback is not active right now!").catch(() => {});
  }
  message.reply("⏸️ Paused!").catch(() => {});
}

function handleResumeCommand(message) {
  const q = getQueue(message.guild.id);
  if (!q || !q.player) {
    return message.reply("❌ Nothing is playing!").catch(() => {});
  }
  if (!q.player.unpause()) {
    return message.reply("⚠️ Playback is not paused!").catch(() => {});
  }
  message.reply("▶️ Resumed!").catch(() => {});
}

function handleQueueCommand(message) {
  const q = getQueue(message.guild.id);
  if (!q || q.songs.length === 0) {
    return message.reply("❌ The queue is empty!").catch(() => {});
  }
  const MAX_LINES = 15;
  const shown = q.songs.slice(0, MAX_LINES);
  const list = shown.map((s, i) => `${i + 1}. ${s.title}`).join("\n");
  const more = q.songs.length > MAX_LINES ? `\n… and ${q.songs.length - MAX_LINES} more` : "";
  let content = `📋 Queue:\n${list}${more}`;
  if (content.length > 1900) content = content.slice(0, 1900) + "\n…";
  message.reply({ content }).catch(() => {});
}

function handleLoopCommand(message) {
  const q = getQueue(message.guild.id);
  if (!q || q.songs.length === 0) {
    return message.reply("❌ Nothing is playing!").catch(() => {});
  }
  q.loop = !q.loop;
  message.reply(q.loop ? "🔁 Loop enabled!" : "🔁 Loop disabled!").catch(() => {});
}

function handleVolumeCommand(message, args) {
  const q = getQueue(message.guild.id);
  if (!q) {
    return message.reply("❌ Nothing is playing!").catch(() => {});
  }
  const vol = parseInt(args[0]);
  if (isNaN(vol) || vol < 0 || vol > 10) {
    return message.reply("❌ Volume must be between 0 and 10!").catch(() => {});
  }
  q.volume = vol;
  if (q.player && q.resource && q.resource.volume) {
    q.resource.volume.setVolume(vol / 10);
  }
  message.reply(`🔊 Volume set to ${vol}`).catch(() => {});
}

function handleRemoveCommand(message, args) {
  const q = getQueue(message.guild.id);
  if (!q || q.songs.length === 0) {
    return message.reply("❌ Nothing to remove!").catch(() => {});
  }
  const index = parseInt(args[0]) - 1;
  if (isNaN(index) || index < 0 || index >= q.songs.length) {
    return message.reply("❌ Invalid song number!").catch(() => {});
  }
  const removed = q.songs.splice(index, 1)[0];
  if (index === 0) {
    // Current track was removed: advance without letting the Idle
    // handler shift again (that would drop the next song too).
    // stop() emits Idle synchronously, so flag first — but only when the
    // player is actually active (a no-op stop would leave the flag stale
    // and make the next song replay instead of advancing).
    const active = q.player && q.player.state.status !== AudioPlayerStatus.Idle;
    if (active) q._advanceMode = "keep";
    if (q.player) q.player.stop(true);
    if (q.songs.length === 0) destroyQueue(message.guild.id, q);
    else if (!active && !q._starting) play(message.guild.id).catch(() => {});
  }
  message.reply(`🗑️ Removed: ${removed.title}`).catch(() => {});
}

function handleClearCommand(message) {
  const q = getQueue(message.guild.id);
  if (!q || q.songs.length === 0) {
    return message.reply("❌ Nothing in the queue!").catch(() => {});
  }
  q.songs = [];
  queue.delete(message.guild.id);
  if (q.player) q.player.stop(true);
  destroyVoice(q);
  message.reply("🗑️ Queue cleared!").catch(() => {});
}

function handleNowPlayingCommand(message) {
  const q = getQueue(message.guild.id);
  if (!q || q.songs.length === 0) {
    return message.reply("❌ Nothing is playing!").catch(() => {});
  }
  message.reply({ content: `🎵 Now playing: **${q.songs[0].title}**` }).catch(() => {});
}

function handleHelpCommand(message) {
  const lines = [
    `**${BOT_NAME} Commands**`,
    "`/play <url/query>` — Play YouTube, Spotify (track/album/playlist), or search",
    "`/skip` — Skip the current song",
    "`/stop` — Stop playback and clear the queue",
    "`/pause` — Pause playback",
    "`/resume` — Resume playback",
    "`/queue` — Show the queue",
    "`/loop` — Toggle loop mode",
    "`/volume <0-10>` — Set volume",
    "`/remove <n>` — Remove a song by number",
    "`/clear` — Clear the queue",
    "`/nowplaying` — Show the current song",
    "`/help` — Show this message",
  ];
  message.reply({ content: lines.join("\n") }).catch(() => {});
}

const VOICE_COMMANDS = new Set(["play", "stop", "skip", "pause", "resume"]);

function interactionCtx(interaction) {
  let responded = false;
  const reply = (payload) => {
    const data = typeof payload === "string" ? { content: payload } : { ...payload };
    if (interaction.deferred || interaction.replied) {
      if (!responded) {
        responded = true;
        return interaction.editReply(data);
      }
      return interaction.followUp(data);
    }
    responded = true;
    return interaction.reply(data);
  };
  return {
    guild: interaction.guild,
    member: interaction.member,
    author: interaction.user,
    reply,
    channel: {
      send: (payload) => {
        const data = typeof payload === "string" ? { content: payload } : payload;
        if (interaction.channel) return interaction.channel.send(data);
        return reply(payload);
      },
    },
  };
}

async function handleInteraction(interaction) {
  if (!interaction.isChatInputCommand()) return;
  const name = interaction.commandName;

  if (!interaction.guild) {
    return interaction.reply({ content: "❌ This command only works in a server.", flags: 64 }).catch(() => {});
  }

  if (VOICE_COMMANDS.has(name) && !interaction.member?.voice?.channel) {
    return interaction.reply({ content: "❌ You need to be in a voice channel to use this command!", flags: 64 }).catch(() => {});
  }

  if (name === "play") {
    try {
      await interaction.deferReply();
    } catch (e) {
      console.error("deferReply failed:", e);
      return;
    }
  }

  const ctx = interactionCtx(interaction);

  try {
    switch (name) {
      // handlePlayCommand is async — must be awaited so errors are caught
      // and the deferred reply is properly resolved
      case "play": await handlePlayCommand(ctx, [interaction.options.getString("query", true)]); break;
      case "skip": handleSkipCommand(ctx); break;
      case "stop": handleStopCommand(ctx); break;
      case "pause": handlePauseCommand(ctx); break;
      case "resume": handleResumeCommand(ctx); break;
      case "queue": handleQueueCommand(ctx); break;
      case "loop": handleLoopCommand(ctx); break;
      case "volume": handleVolumeCommand(ctx, [String(interaction.options.getInteger("level", true))]); break;
      case "remove": handleRemoveCommand(ctx, [String(interaction.options.getInteger("number", true))]); break;
      case "clear": handleClearCommand(ctx); break;
      case "nowplaying": handleNowPlayingCommand(ctx); break;
      case "help": handleHelpCommand(ctx); break;
      default:
        interaction.reply({ content: "❌ Unknown command.", flags: 64 }).catch(() => {});
    }
  } catch (e) {
    console.error("Interaction error:", e);
    const payload = { content: "❌ Something went wrong running that command.", flags: 64 };
    if (interaction.deferred || interaction.replied) interaction.followUp(payload).catch(() => {});
    else interaction.reply(payload).catch(() => {});
  }
}

function applyPresence() {
  if (!client.isReady()) return;
  try {
    client.user.setPresence({
      activities: [{ name: "Music | /play", type: ActivityType.Listening }],
      status: "online",
    });
  } catch (err) {
    console.error("Presence update failed:", err);
  }
}

let loginAttempts = 0;

function login() {
  if (!TOKEN) {
    console.error("DISCORD_TOKEN is not set. Add it to your .env file (see .env.example).");
    return;
  }
  client.login(TOKEN).catch((err) => {
    console.error("Login failed:", err);
    loginAttempts += 1;
    setTimeout(login, Math.min(15000 * loginAttempts, 60000));
  });
}

function relogin() {
  try {
    client.destroy();
  } catch {}
  setTimeout(login, 5000);
}

// Keeps a sleeping host (Render free tier) awake so the Discord gateway
// connection does not drop and slash commands stop answering.
function startKeepAlive() {
  const url = (process.env.KEEP_ALIVE_URL || "").trim();
  if (!url) return;
  const ping = () => {
    try {
      const lib = url.startsWith("http:") ? require("http") : https;
      const req = lib.get(url, { timeout: 10000 }, (res) => res.resume());
      req.on("error", () => {});
      req.on("timeout", () => req.destroy());
    } catch { /* ignore */ }
  };
  setInterval(ping, 10 * 60 * 1000);
  setTimeout(ping, 20 * 1000);
  console.log(`Keep-alive: pinging every 10 min -> ${url}`);
}

async function startBot() {
  // Ensure yt-dlp is available before accepting commands
  await ensureYtDlp();
  console.log(
    SPOTIFY_USE_API
      ? "Spotify metadata: official Web API"
      : "Spotify metadata: embed pages (set SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET to use the Web API)"
  );

  client.on("ready", async () => {
    console.log(`Logged in as ${client.user.tag}`);
    loginAttempts = 0;
    applyPresence();
    try {
      await client.application.commands.set(SLASH_COMMANDS);
      console.log("Global slash commands registered");
      const guildSets = [...client.guilds.cache.values()].map((g) => g.commands.set(SLASH_COMMANDS));
      await Promise.all(guildSets);
      if (guildSets.length) console.log(`Guild slash commands registered for ${guildSets.length} server(s)`);
    } catch (e) {
      console.error("Failed to register slash commands:", e);
    }
  });

  client.on("shardReady", () => applyPresence());
  client.on("shardDisconnect", (info) => console.warn("Shard disconnected:", info));
  client.on("shardReconnecting", () => console.warn("Shard reconnecting..."));
  client.on("shardError", (err) => console.error("Shard error:", err));
  client.on("error", (err) => console.error("Client error:", err));
  client.on("warn", (info) => console.warn("Client warn:", info));
  client.on("invalidated", () => {
    console.error("Session invalidated, re-logging in...");
    relogin();
  });

  client.on("interactionCreate", handleInteraction);

  setInterval(applyPresence, 30 * 60 * 1000);

  console.log(`yt-dlp: ${YTDLP} | ffmpeg: ${resolveFfmpeg()}`);
  startKeepAlive();
  login();
}

process.on("uncaughtException", (err) => console.error("Uncaught exception:", err));
process.on("unhandledRejection", (err) => console.error("Unhandled rejection:", err));

// ---------------------------------------------------------------------------
// Express dashboard
// ---------------------------------------------------------------------------
const app = express();
const ROOT = path.join(__dirname, "public");

let SESSION_SECRET = process.env.SESSION_SECRET || "";
if (!SESSION_SECRET) {
  if (process.env.NODE_ENV === "production") {
    console.warn("SESSION_SECRET is not set; using an ephemeral secret (sessions reset on restart).");
    SESSION_SECRET = crypto.randomBytes(32).toString("hex");
  } else {
    SESSION_SECRET = "notixmix-dashboard-secret";
  }
}

app.set("trust proxy", 1);
app.use(cookieParser());
app.use(express.json());
app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { secure: process.env.NODE_ENV === "production", sameSite: "lax", maxAge: 7 * 24 * 60 * 60 * 1000 },
}));

app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  next();
});

app.use(express.static(ROOT, { extensions: ["html"] }));

function getBaseUrl(req) {
  if (BASE_URL) return BASE_URL.replace(/\/$/, "");
  return `${req.protocol}://${req.get("host")}`;
}

function safeReturnPath(p) {
  if (typeof p !== "string") return "/dashboard";
  if (!p.startsWith("/") || p.startsWith("//") || p.includes("\\")) return "/dashboard";
  return p;
}

function requireAuth(req, res, next) {
  if (req.session && req.session.user) return next();
  return res.status(401).json({ error: "Not authenticated" });
}

function userGuildEntry(user, guildId) {
  return ((user && user.guilds) || []).find((g) => g.id === guildId) || null;
}

function canManageGuild(entry) {
  if (!entry) return false;
  if (entry.owner) return true;
  try {
    const perms = BigInt(entry.permissions || "0");
    return (perms & 0x20n) === 0x20n || (perms & 0x8n) === 0x8n;
  } catch {
    return false;
  }
}

// --- OAuth2 ---
app.get("/auth/login", (req, res) => {
  if (!CLIENT_SECRET) {
    return res.status(500).send("DISCORD_CLIENT_SECRET is not configured.");
  }
  const redirect = `${getBaseUrl(req)}/auth/callback`;
  const state = crypto.randomBytes(16).toString("hex");
  req.session.returnTo = safeReturnPath(req.query.return);
  req.session.oauthState = state;
  const url = `https://discord.com/api/oauth2/authorize?client_id=${CLIENT_ID}&redirect_uri=${encodeURIComponent(redirect)}&response_type=code&scope=identify%20guilds&state=${state}`;
  res.redirect(url);
});

app.get("/auth/callback", async (req, res) => {
  const { code, state } = req.query;
  if (!code || !state || !req.session.oauthState || state !== req.session.oauthState) {
    return res.redirect("/");
  }
  delete req.session.oauthState;
  const redirect = `${getBaseUrl(req)}/auth/callback`;
  try {
    const tokenRes = await new Promise((resolve, reject) => {
      const data = new URLSearchParams({
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        grant_type: "authorization_code",
        code: String(code),
        redirect_uri: redirect,
      }).toString();
      const r = https.request("https://discord.com/api/v10/oauth2/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
      }, (resp) => {
        let b = "";
        resp.on("data", (c) => (b += c));
        resp.on("end", () => resolve({ status: resp.statusCode, body: b }));
      });
      r.on("error", reject);
      r.end(data);
    });
    const tok = JSON.parse(tokenRes.body);
    if (!tok.access_token) return res.redirect("/");

    const fetchJson = (pathName, accessToken) => new Promise((resolve, reject) => {
      const r = https.get(`https://discord.com/api/v10${pathName}`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      }, (resp) => {
        let b = "";
        resp.on("data", (c) => (b += c));
        resp.on("end", () => {
          try { resolve(JSON.parse(b)); } catch (e) { reject(e); }
        });
      });
      r.on("error", reject);
    });

    const me = await fetchJson("/users/@me", tok.access_token);
    const guilds = await fetchJson("/users/@me/guilds", tok.access_token);
    req.session.user = {
      id: me.id,
      username: me.username,
      globalName: me.global_name || me.username,
      avatar: me.avatar
        ? `https://cdn.discordapp.com/avatars/${me.id}/${me.avatar}.png?size=64`
        : `https://cdn.discordapp.com/embed/avatars/${Number(BigInt(me.id) >> 22n) % 6}.png`,
      guilds: Array.isArray(guilds) ? guilds : [],
    };
    const back = safeReturnPath(req.session.returnTo);
    delete req.session.returnTo;
    res.redirect(back);
  } catch (e) {
    console.error("OAuth error:", e);
    res.redirect("/");
  }
});

app.get("/auth/logout", (req, res) => {
  req.session.destroy(() => res.redirect("/"));
});

// --- API ---
app.get("/api/status", (req, res) => {
  const ready = client.isReady();
  const mem = process.memoryUsage();
  res.json({
    online: ready,
    name: ready ? client.user.tag : BOT_NAME,
    botId: CLIENT_ID,
    latency: ready ? client.ws.ping : null,
    uptime: ready ? client.uptime : null,
    serverUptime: process.uptime(),
    guilds: ready ? client.guilds.cache.size : 0,
    users: ready ? client.guilds.cache.reduce((n, g) => n + g.memberCount, 0) : 0,
    memory: { rss: mem.rss, heapUsed: mem.heapUsed, heapTotal: mem.heapTotal },
    queues: queue.size,
    oauthConfigured: !!CLIENT_SECRET,
    startedAt: START_TIME,
  });
});

app.get("/api/me", (req, res) => {
  if (!req.session.user) return res.json({ authenticated: false });
  const { id, username, globalName, avatar, guilds } = req.session.user;
  res.json({ authenticated: true, user: { id, username, globalName, avatar, guilds } });
});

app.get("/api/servers", requireAuth, (req, res) => {
  const userGuilds = req.session.user.guilds || [];
  const botGuildIds = new Set(client.isReady() ? client.guilds.cache.map((g) => g.id) : []);
  const mapped = userGuilds
    .filter((g) => {
      const perms = BigInt(g.permissions || "0");
      const manage = (perms & 0x20n) === 0x20n || (perms & 0x8n) === 0x8n;
      return botGuildIds.has(g.id) && (manage || !!g.owner);
    })
    .map((g) => {
      const perms = BigInt(g.permissions || "0");
      const manage = (perms & 0x20n) === 0x20n || (perms & 0x8n) === 0x8n;
      const botGuild = client.guilds.cache.get(g.id);
      return {
        id: g.id,
        name: g.name,
        icon: g.icon ? `https://cdn.discordapp.com/icons/${g.id}/${g.icon}.png?size=64` : null,
        owner: !!g.owner,
        canManage: manage,
        inBot: true,
        members: botGuild ? botGuild.memberCount : null,
        playing: queue.has(g.id) && queue.get(g.id).songs.length > 0,
      };
    });
  res.json({ servers: mapped });
});

app.get("/api/queue/:guildId", requireAuth, (req, res) => {
  const { guildId } = req.params;
  const entry = userGuildEntry(req.session.user, guildId);
  if (!entry) return res.status(403).json({ error: "Not your server" });
  if (!canManageGuild(entry)) return res.status(403).json({ error: "You don't have permission to manage this server" });
  const q = getQueue(guildId);
  if (!q) return res.json({ queue: [], nowPlaying: null, volume: 5, loop: false, voiceChannel: null });
  const nowPlaying = q.songs[0] || null;
  res.json({
    queue: q.songs.map((s, i) => ({ index: i, title: s.title, artist: s.artist || null, source: s.source || "youtube", url: s.url || null })),
    nowPlaying,
    volume: q.volume,
    loop: q.loop,
    voiceChannel: q.voiceChannel ? { id: q.voiceChannel.id, name: q.voiceChannel.name } : null,
    playerState: q.player ? q.player.state.status : null,
  });
});

app.post("/api/control/:guildId/:action", requireAuth, async (req, res) => {
  const { guildId, action } = req.params;
  const entry = userGuildEntry(req.session.user, guildId);
  if (!entry) return res.status(403).json({ error: "Not your server" });
  if (!canManageGuild(entry)) return res.status(403).json({ error: "You don't have permission to manage this server" });
  const q = getQueue(guildId);

  switch (action) {
    case "pause":
      if (!q || !q.player) return res.status(400).json({ error: "Nothing playing" });
      if (!q.player.pause()) return res.status(400).json({ error: "Playback is not active right now" });
      break;
    case "resume":
      if (!q || !q.player) return res.status(400).json({ error: "Nothing playing" });
      if (!q.player.unpause()) return res.status(400).json({ error: "Playback is not paused" });
      break;
    case "skip":
      if (!q || !q.player || q.songs.length === 0 || q.player.state.status === AudioPlayerStatus.Idle) {
        return res.status(400).json({ error: "Nothing playing" });
      }
      q._advanceMode = "force";
      q.player.stop(true);
      break;
    case "stop":
      if (!q) return res.status(400).json({ error: "Nothing playing" });
      q.songs = [];
      queue.delete(guildId);
      if (q.player) q.player.stop(true);
      destroyVoice(q);
      break;
    case "loop":
      if (!q) return res.status(400).json({ error: "No queue" });
      q.loop = !q.loop;
      break;
    case "remove": {
      if (!q) return res.status(400).json({ error: "No queue" });
      const idx = parseInt(req.body && req.body.index, 10);
      if (isNaN(idx) || idx < 0 || idx >= q.songs.length) return res.status(400).json({ error: "Invalid index" });
      q.songs.splice(idx, 1);
      if (idx === 0) {
        const active = q.player && q.player.state.status !== AudioPlayerStatus.Idle;
        if (active) q._advanceMode = "keep";
        if (q.player) q.player.stop(true);
        if (q.songs.length === 0) destroyQueue(guildId, q);
        else if (!active && !q._starting) play(guildId).catch(() => {});
      }
      break;
    }
    case "clear":
      if (!q) return res.status(400).json({ error: "No queue" });
      q.songs = [];
      queue.delete(guildId);
      if (q.player) q.player.stop(true);
      destroyVoice(q);
      break;
    case "volume": {
      if (!q) return res.status(400).json({ error: "No queue" });
      const vol = parseInt(req.body && req.body.volume, 10);
      if (isNaN(vol) || vol < 0 || vol > 10) return res.status(400).json({ error: "Volume 0-10" });
      q.volume = vol;
      if (q.player && q.resource && q.resource.volume) q.resource.volume.setVolume(vol / 10);
      break;
    }
    case "play": {
      if (!q || q.songs.length === 0) return res.status(400).json({ error: "Queue empty" });
      if (q.player) {
        const st = q.player.state.status;
        if (st === AudioPlayerStatus.Paused) {
          q.player.unpause();
          break;
        }
        if (st === AudioPlayerStatus.Playing || st === AudioPlayerStatus.Buffering) break;
      }
      play(guildId).catch(() => {});
      break;
    }
    case "add": {
      if (!q || !q.connection) {
        return res.status(400).json({ error: "Bot is not in a voice channel here. Use /play in Discord first." });
      }
      const query = typeof (req.body && req.body.query) === "string" ? req.body.query.trim() : "";
      if (!query) return res.status(400).json({ error: "Missing query" });
      const spotify = isSpotifyLink(query);
      try {
        let entries;
        let label = query;
        if (spotify) {
          const sp = await resolveSpotify(query);
          label = sp.title;
          entries = sp.tracks.map((t) => ({
            url: null,
            title: t.title,
            artist: t.artist,
            search: spotifySearchQuery(t),
            source: "spotify",
          }));
        } else {
          const resolved = await resolveVideo(query);
          label = resolved.title;
          entries = [{ url: resolved.url, title: resolved.title, source: resolved.source || "youtube", client: resolved.client }];
        }
        const qq = getQueue(guildId);
        if (!qq) return res.status(400).json({ error: "Queue was cleared while resolving — try again" });
        for (const entry of entries) qq.songs.push(entry);
        if (qq.player && qq.player.state.status === AudioPlayerStatus.Idle && !qq._starting) {
          play(guildId).catch(() => {});
        }
        return res.json({ ok: true, title: label, count: entries.length });
      } catch (e) {
        return res.status(502).json({ error: spotify ? e.message : describeYtDlpError(e.message) });
      }
    }
    default:
      return res.status(400).json({ error: "Unknown action" });
  }
  res.json({ ok: true });
});

app.get("/health", (req, res) => {
  res.status(200).json({ status: "ok", discord: client.isReady() ? "online" : "offline" });
});

app.get("/robots.txt", (req, res) => {
  res.type("text/plain").send("User-agent: *\nAllow: /\nDisallow: /dashboard\nDisallow: /api\nDisallow: /auth\n");
});

app.use((req, res) => {
  if (req.path.startsWith("/api/")) return res.status(404).json({ error: "Not found" });
  if (req.method !== "GET" && req.method !== "HEAD") return res.status(404).send("Not found");
  const file = path.join(ROOT, "index.html");
  if (fs.existsSync(file)) return res.sendFile(file);
  res.status(404).send("Not found");
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Dashboard running on port ${PORT}`));

module.exports = {
  createClient, startBot, getQueue, createQueue, play, addSongToQueue,
  resolveSpotify, isSpotifyLink, spotifySearchQuery,
  resolveVideo, getStreamUrl, withYtClients, isTransientYtError,
  app, client,
};

startBot();
