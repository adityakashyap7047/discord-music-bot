require("dotenv").config();
const {
  Client, GatewayIntentBits, ActivityType, ApplicationCommandOptionType, ChannelType,
  EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, PermissionsBitField, escapeMarkdown,
  StringSelectMenuBuilder, StringSelectMenuOptionBuilder, ComponentType,
} = require("discord.js");
const { joinVoiceChannel, createAudioPlayer, createAudioResource, entersState, VoiceConnectionStatus, AudioPlayerStatus, StreamType } = require("@discordjs/voice");
const { execFile, spawn } = require("child_process");
const https = require("https");
const path = require("path");
const os = require("os");
const fs = require("fs");
const crypto = require("crypto");
const express = require("express");
const session = require("express-session");
const cookieParser = require("cookie-parser");
const { find: findLyrics } = require("llyrics");

const TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.DISCORD_CLIENT_ID || "1552647926780534874";
const CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET || "";
const BASE_URL = process.env.BASE_URL || "";
const BOT_NAME = "NOTIXMIX";
const START_TIME = Date.now();
const EMBED_COLOR = parseInt(process.env.EMBED_COLOR || "5865F2", 16) || 0x5865f2;
const LEAVE_TIMEOUT = Math.max(10000, parseInt(process.env.LEAVE_TIMEOUT || "", 10) || 60000);

// ---------------------------------------------------------------------------
// Per-guild settings (24/7 mode + autoplay) persisted to a JSON file.
// Point DATA_DIR at a persistent disk (e.g. /var/data on Render) to keep the
// settings across redeploys.
// ---------------------------------------------------------------------------
const SETTINGS_FILE = path.join(process.env.DATA_DIR || __dirname, "guild-settings.json");
let guildSettings = {};
try {
  guildSettings = JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf8"));
} catch {
  guildSettings = {};
}
if (!guildSettings || typeof guildSettings !== "object" || Array.isArray(guildSettings)) guildSettings = {};

let settingsSaveTimer = null;

function getGuildSettings(guildId) {
  if (!guildSettings[guildId] || typeof guildSettings[guildId] !== "object") guildSettings[guildId] = {};
  const s = guildSettings[guildId];
  if (typeof s.autoplay !== "boolean") s.autoplay = false;
  if (!s.reconnect || typeof s.reconnect !== "object") s.reconnect = { status: false, text: null, voice: null };
  if (typeof s.reconnect.status !== "boolean") s.reconnect.status = false;
  if (s.reconnect.text === undefined) s.reconnect.text = null;
  if (s.reconnect.voice === undefined) s.reconnect.voice = null;
  return s;
}

function saveGuildSettings() {
  clearTimeout(settingsSaveTimer);
  settingsSaveTimer = setTimeout(() => {
    try {
      fs.writeFileSync(SETTINGS_FILE, JSON.stringify(guildSettings, null, 2));
    } catch (e) {
      console.error("Failed to save guild settings:", e.message);
    }
  }, 500);
}

function isAutoplayOn(guildId) {
  return !!(guildSettings[guildId] && guildSettings[guildId].autoplay);
}

function is247On(guildId) {
  return !!(guildSettings[guildId] && guildSettings[guildId].reconnect && guildSettings[guildId].reconnect.status);
}

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
  { name: "volume", description: "Set the playback volume", options: [{ type: ApplicationCommandOptionType.Integer, name: "level", description: "Volume from 0 to 200", required: true, min_value: 0, max_value: 200 }] },
  { name: "remove", description: "Remove a song from the queue", options: [{ type: ApplicationCommandOptionType.Integer, name: "number", description: "Queue position (1-based)", required: true, min_value: 1 }] },
  { name: "clear", description: "Clear the queue" },
  { name: "nowplaying", description: "Show the currently playing song" },
  { name: "shuffle", description: "Shuffle the queue" },
  { name: "previous", description: "Play the previous song" },
  { name: "join", description: "Join your voice channel" },
  { name: "leave", description: "Leave the voice channel" },
  { name: "autoplay", description: "Toggle autoplay (auto-queue similar tracks)" },
  { name: "247", description: "Toggle 24/7 mode (stay in voice when idle)" },
  { name: "lyric", description: "Show lyrics for the current song" },
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
    const cmdArgs = [
      "--no-warnings",
      "--geo-bypass",
      "--geo-bypass-country", "US",
      ...ytCookieArgs(),
      ...args
    ];
    console.log(`[yt-dlp] Running: ${YTDLP} ${cmdArgs.join(" ")}`);
    execFile(YTDLP, cmdArgs, { maxBuffer: 10 * 1024 * 1024, timeout }, (err, stdout, stderr) => {
      if (err) {
        console.error(`[yt-dlp] Error:`, stderr || err.message);
        reject(new Error(stderr || err.message));
      } else {
        console.log(`[yt-dlp] Success`);
        resolve(stdout.trim());
      }
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
  const fallback = process.env.YTDLP_CLIENTS || "android,android_vr,android_music,web_embedded,web_music,mweb,tv_embedded,tv";
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
    return { url, title: entry.title || info.title || "Unknown", duration: entry.duration || info.duration || null };
  }

  if (!info.webpage_url) throw new Error("No results");
  return { url: info.webpage_url, title: info.title || "Unknown", duration: info.duration || null };
}

function parseYtDlpSearchResults(json, maxResults = 5) {
  const info = JSON.parse(json);
  if (!info) throw new Error("No results");

  if (info._type === "playlist" && Array.isArray(info.entries)) {
    return info.entries
      .filter((e) => e && e.webpage_url)
      .slice(0, maxResults)
      .map((entry) => ({
        url: entry.webpage_url,
        title: entry.title || "Unknown",
        duration: entry.duration || null,
        uploader: entry.uploader || entry.channel || null,
        viewCount: entry.view_count || null,
      }));
  }

  if (info.webpage_url) {
    return [{
      url: info.webpage_url,
      title: info.title || "Unknown",
      duration: info.duration || null,
      uploader: info.uploader || info.channel || null,
      viewCount: info.view_count || null,
    }];
  }

  throw new Error("No results");
}

// SoundCloud has no "not a bot" checks, so it doubles as a free fallback
// source when YouTube blocks this server's IP.
async function resolveSoundCloud(query) {
  const json = await runYtDlp(["-J", "--no-playlist", `scsearch1:${query}`]);
  const parsed = parseYtDlpInfo(json);
  return { ...parsed, source: "soundcloud", client: null };
}

async function searchVideo(query, maxResults = 5) {
  const q = String(query || "").trim();
  const isYtUrl = isYouTubeUrl(q);
  const isScUrl = isSoundCloudUrl(q);
  if (isYtUrl || isScUrl) {
    const resolved = await resolveVideo(q);
    return [resolved];
  }
  const target = `ytsearch${maxResults}:${q}`;
  try {
    const { out, client } = await withYtClients(["-J", "--flat-playlist", target]);
    const results = parseYtDlpSearchResults(out, maxResults);
    return results.map((r) => ({ ...r, source: "youtube", client }));
  } catch (e) {
    if (isTransientYtError(e.message)) {
      try {
        console.warn(`YouTube blocked the search (${e.message.split("\n")[0]}) — falling back to SoundCloud`);
        const scResult = await resolveSoundCloud(q);
        return [scResult];
      } catch (scErr) {
        console.error("SoundCloud fallback failed:", scErr.message);
      }
    }
    throw e;
  }
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
      duration: typeof t.duration_ms === "number" ? Math.round(t.duration_ms / 1000) : null,
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
  if (pipe.titleFile) {
    try { fs.unlinkSync(pipe.titleFile); } catch { /* never written */ }
    pipe.titleFile = null;
  }
}

// What yt-dlp is asked to stream: a pasted URL as-is, otherwise a one-result
// search. Queuing a search target directly removes the separate metadata
// extraction that used to run before playback (~7s of "thinking…" per track).
function songTarget(song, sourceName) {
  const q = song.search || song.title;
  if (sourceName === "soundcloud") return `scsearch1:${q}`;
  if (song.url) return song.url;
  return `ytsearch1:${q}`;
}

// Reads the title/duration pair yt-dlp wrote before the first audio byte and
// cleans the temp file up. Fields are joined with an ASCII unit separator.
function takePipeInfo(pipe) {
  if (!pipe || !pipe.titleFile) return null;
  let raw = null;
  try { raw = fs.readFileSync(pipe.titleFile, "utf8"); } catch { raw = null; }
  try { fs.unlinkSync(pipe.titleFile); } catch { /* never written */ }
  pipe.titleFile = null;
  if (!raw) return null;
  const line = raw.split(/\r?\n/)[0];
  const sep = line.lastIndexOf("\x1f");
  const title = (sep >= 0 ? line.slice(0, sep) : line).trim();
  const durStr = sep >= 0 ? line.slice(sep + 1).trim() : "";
  return {
    title: title || null,
    duration: /^\d+$/.test(durStr) ? Number(durStr) : null,
  };
}

// Spawns yt-dlp writing audio to stdout, piped through ffmpeg into raw PCM
// (48kHz stereo) that @discordjs/voice encodes to opus. `started` resolves once
// audio actually flows, so a failed extraction surfaces as an error we can
// report instead of leaving the channel in silence.
function createPipedResource(song, target, client) {
  const titleFile = path.join(
    os.tmpdir(),
    `notixmix-title-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.txt`
  );

  const ytdlp = spawn(YTDLP, [
    "--no-warnings",
    ...ytCookieArgs(),
    "-f", "bestaudio/best",
    "--no-playlist",
    "-o", "-",
    "--print-to-file", "before_dl:%(title)s\x1f%(duration)s", titleFile,
    ...ytClientArgs(client || null),
    target,
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

  return { ytdlp, ffmpeg, resource, started, titleFile, target };
}

async function attemptPipe(song, target, client) {
  const pipe = createPipedResource(song, target, client);
  try {
    await pipe.started;
  } catch (e) {
    stopPipe(pipe);
    throw e;
  }
  // Swap the queued search term for the real track name (and fill in the
  // duration) while the queue still shows it — Spotify entries keep their
  // Spotify title but still learn the duration.
  const info = takePipeInfo(pipe);
  if (info) {
    if (info.title && song.source !== "spotify") song.title = info.title;
    if (info.duration && !song.duration) song.duration = info.duration;
  }
  return pipe;
}

// Last stream-start measurement, surfaced through /health so the deployed bot
// can be timed without guessing (playback used to take 15-40s end to end).
let lastStreamStart = null;

// Resolves a queue entry to a live pipe. One yt-dlp process does the whole job
// (search + extraction + transfer), with the player-client fallback chain and a
// SoundCloud retry when YouTube bot-checks a search query.
async function startSongPipe(song) {
  const t0 = Date.now();
  let failed = null;
  try {
    const isUrl = !!song.url;
    const clients = [null, ...resolveYtClients()];
    let firstErr = null;
    let lastErr = null;
    let triedSoundCloud = false;

    for (let i = 0; i < clients.length; i++) {
      try {
        return await attemptPipe(song, songTarget(song, "youtube"), clients[i]);
      } catch (e) {
        firstErr = firstErr || e;
        lastErr = e;
        if (!isTransientYtError(e.message)) throw e;

        // Searches (and Spotify matches) can move to SoundCloud, which has no
        // bot checks — try it before burning the remaining client fallbacks.
        if (!isUrl && !triedSoundCloud) {
          triedSoundCloud = true;
          try {
            const pipe = await attemptPipe(song, songTarget(song, "soundcloud"), null);
            song.source = "soundcloud";
            return pipe;
          } catch (scErr) {
            lastErr = scErr;
          }
        }

        if (i < clients.length - 1) await new Promise((r) => setTimeout(r, 400));
      }
    }
    throw lastErr || firstErr;
  } catch (e) {
    failed = e;
    throw e;
  } finally {
    lastStreamStart = {
      ms: Date.now() - t0,
      ok: !failed,
      source: song.source || null,
      at: new Date().toISOString(),
    };
    if (!failed) console.log(`Stream ready in ${lastStreamStart.ms}ms (${lastStreamStart.source}) — ${song.title}`);
  }
}

// Extraction is the slow part of playback (~5s), so the next track is started
// while the current one is still playing: /play overlaps it with the voice
// join, and the queue hand-off becomes instant.
function prewarmNext(guildId) {
  const q = getQueue(guildId);
  if (!q || !q.songs.length) return;
  if (q._starting && !q._pipe) return; // play() is already fetching songs[0]
  const song = q.songs[q._pipe ? 1 : 0];
  if (!song) return;
  if (q._prewarm && q._prewarm.song === song) return;
  stopPrewarm(q);
  const promise = startSongPipe(song).catch(() => {});
  q._prewarm = { song, promise };
}

function stopPrewarm(q) {
  if (!q || !q._prewarm) return;
  const entry = q._prewarm;
  q._prewarm = null;
  entry.promise.then((pipe) => stopPipe(pipe), () => {});
}

function takePrewarm(q, song) {
  if (q && q._prewarm && q._prewarm.song === song) {
    const entry = q._prewarm;
    q._prewarm = null;
    return entry.promise;
  }
  stopPrewarm(q);
  return null;
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
    history: [],                 // recently played tracks (for /previous)
    volume: 100,
    loop: false,
    textChannel: null,
    voiceChannel: null,
    connection: null,
    player: null,
    resource: null,
    npMessage: null,             // now-playing controller message
    npCollector: null,
    npSong: null,
    _starting: false,
    _announceNext: false,
    _advanceMode: null, // null = default advance, "keep" = songs already adjusted, "force" = advance even when looping
    _emptyHandled: false,
  };
  queue.set(guildId, q);
  return q;
}

function pushHistory(q, song) {
  if (!song) return;
  q.history.push(song);
  if (q.history.length > 25) q.history.shift();
}

function destroyVoice(q) {
  try {
    stopPipe(q && q._pipe);
    if (q) q._pipe = null;
  } catch (e) {
    console.error("Pipe destroy failed:", e);
  }
  try {
    stopPrewarm(q);
  } catch (e) {
    console.error("Prewarm destroy failed:", e);
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
  clearNowPlaying(q);
  cancelAutoLeave(guildId);
  destroyVoice(q);
  queue.delete(guildId);
}

// Runs when the queue runs dry: tries autoplay first, then falls back to
// 24/7 mode (stay connected) or a plain disconnect, mirroring Lunox's
// queueEmpty event.
function handleQueueEmpty(guildId, q) {
  if (q._emptyHandled) return;
  q._emptyHandled = true;
  (async () => {
    try {
      if (isAutoplayOn(guildId)) {
        const song = await resolveAutoplaySong(q);
        if (getQueue(guildId) !== q) return;
        q._emptyHandled = false;
        if (song && q.songs.length === 0) {
          q.songs.push(song);
          if (q.textChannel) safeSend(q.textChannel, { content: `🔁 Autoplay: queued **${song.title}**` });
          play(guildId).catch(() => {});
          return;
        }
        if (song) return; // someone queued a track while we were resolving
        getGuildSettings(guildId).autoplay = false;
        saveGuildSettings();
        if (q.textChannel) safeSend(q.textChannel, "🔁 Autoplay couldn't find similar tracks — turning it off.");
      }
    } catch (e) {
      console.error("Autoplay error:", e.message);
      if (getQueue(guildId) === q) q._emptyHandled = false;
    }
    if (getQueue(guildId) !== q || q.songs.length > 0) return;
    q._emptyHandled = false;
    if (is247On(guildId)) {
      if (q.textChannel) safeSend(q.textChannel, "🌙 Queue finished — staying connected (24/7 mode).");
      return;
    }
    destroyQueue(guildId, q);
  })();
}

function youtubeIdFromUrl(url) {
  const m = String(url || "").match(/(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/shorts\/)([\w-]{11})/);
  return m ? m[1] : null;
}

// Picks the next track when autoplay is on. Uses the YouTube "mix" radio of
// the last played track (the same trick Lunox uses with list=RD<id>), and
// falls back to a plain search when the mix lookup fails.
async function resolveAutoplaySong(q) {
  const last = q.history.length ? q.history[q.history.length - 1] : q.songs[0];
  const id = last && last.url ? youtubeIdFromUrl(last.url) : null;

  if (id) {
    try {
      const json = await runYtDlp(
        ["-J", "--flat-playlist", "--playlist-end", "25", `https://music.youtube.com/watch?v=${id}&list=RD${id}`],
        45000
      );
      const info = JSON.parse(json);
      const entries = (info && Array.isArray(info.entries)) ? info.entries : [];
      const candidates = entries.filter((e) => e && e.id && e.id !== id);
      if (candidates.length) {
        const pick = candidates[Math.floor(Math.random() * candidates.length)];
        return {
          url: `https://www.youtube.com/watch?v=${pick.id}`,
          title: pick.title || "Unknown",
          source: "youtube",
          client: null,
          duration: typeof pick.duration === "number" ? pick.duration : null,
          requester: "Autoplay",
          requesterId: null,
        };
      }
    } catch (e) {
      console.warn("Autoplay mix lookup failed:", String(e.message).split("\n")[0]);
    }
  }

  if (!last || !last.title) return null;
  const query = last.artist ? `${last.artist} - ${last.title}` : last.title;
  try {
    const resolved = await resolveVideo(query);
    return {
      url: resolved.url,
      title: resolved.title,
      source: resolved.source || "youtube",
      client: resolved.client,
      duration: resolved.duration || null,
      requester: "Autoplay",
      requesterId: null,
    };
  } catch (e) {
    console.warn("Autoplay search failed:", String(e.message).split("\n")[0]);
    return null;
  }
}

async function play(guildId) {
  const q = getQueue(guildId);
  if (!q) return;
  if (q.songs.length === 0) {
    handleQueueEmpty(guildId, q);
    return;
  }
  if (q._starting) return;
  q._starting = true;
  q._emptyHandled = false;

  if (!q.connection || q.connection.state.status === VoiceConnectionStatus.Destroyed) {
    q._starting = false;
    destroyQueue(guildId, q);
    if (q.textChannel) {
      safeSend(q.textChannel, "❌ Lost the voice connection — stopped playback.");
    }
    return;
  }
  const song = q.songs[0];

  // Extraction is the slow part (~5s): start it now so it overlaps the voice
  // connection coming up instead of running after it. A prewarmed pipe for this
  // exact track is reused, which is what makes queue hand-offs instant.
  const pipePromise = takePrewarm(q, song) || startSongPipe(song);
  pipePromise.catch(() => {}); // may be abandoned before we await it
  const voiceReady = entersState(q.connection, VoiceConnectionStatus.Ready, 20000)
    .then(() => true, () => false);

  let pipe = null;
  try {
    pipe = await pipePromise;

    if (!(await voiceReady)) {
      stopPipe(pipe);
      q._starting = false;
      if (getQueue(guildId) === q) {
        destroyQueue(guildId, q);
        if (q.textChannel) {
          safeSend(q.textChannel, "❌ Could not connect to the voice channel — stopped playback.");
        }
      }
      return;
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
        pushHistory(q, q.songs.shift());
        play(guildId).catch(() => {});
      } else {
        play(guildId).catch(() => {});
      }
    });

    q.player.on(AudioPlayerStatus.Playing, () => {
      if (!q._announceNext) return;
      q._announceNext = false;
      sendNowPlaying(guildId, q, song);
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
      q.resource.volume.setVolume(q.volume / 200);
    }
  } catch (e) {
    console.error("Play error:", e.message, e.stack);
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
  // This track is streaming — start fetching the next one now so the hand-off
  // does not wait for another extraction.
  prewarmNext(guildId);
}

function addSongToQueue(guildId, songs, textChannel) {
  const q = getQueue(guildId) || createQueue(guildId);
  if (!q.textChannel) q.textChannel = textChannel;
  for (const song of songs) q.songs.push(song);
  return q;
}

function attachDisconnectHandler(guildId, q) {
  if (!q.connection || q.connection._notixmixGuard) return;
  q.connection._notixmixGuard = true;
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
        destroyQueue(guildId, q);
      }
    }
  });
}

// Joins a voice channel for an existing queue and wires up reconnection.
function connectVoice(guildId, voiceChannel, adapterCreator) {
  const q = getQueue(guildId);
  if (!q) return null;
  if (q.connection && q.connection.state.status !== VoiceConnectionStatus.Destroyed) return q.connection;
  try {
    q.connection = joinVoiceChannel({
      channelId: voiceChannel.id,
      guildId: guildId,
      adapterCreator,
    });
    q.voiceChannel = voiceChannel;
    attachDisconnectHandler(guildId, q);
    return q.connection;
  } catch (e) {
    console.error(e);
    return null;
  }
}

function setupVoiceConnection(guildId, voiceChannel, message) {
  const q = getQueue(guildId);
  if (!q.voiceChannel) {
    connectVoice(guildId, voiceChannel, message.guild.voiceAdapterCreator);
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
  const directUrl = isYouTubeUrl(query) || isSoundCloudUrl(query);

  // For direct URLs and Spotify links, add directly to queue (existing behavior)
  if (spotify || directUrl) {
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
        duration: t.duration || null,
        search: spotifySearchQuery(t),
        source: "spotify",
        requester: message.author?.tag || "Unknown",
        requesterId: message.author?.id || null,
      }));
      if (sp.total > sp.tracks.length) {
        container = `${sp.title} (first ${sp.tracks.length} of ${sp.total})`;
      }
    } else {
      songs = [{
        url: query,
        search: null,
        title: query,
        source: isSoundCloudUrl(query) ? "soundcloud" : "youtube",
        requester: message.author?.tag || "Unknown",
        requesterId: message.author?.id || null,
      }];
    }

    const existing = getQueue(guildId);
    const wasEmpty = !existing || existing.songs.length === 0;
    const q = addSongToQueue(guildId, songs, textChannel);
    const first = songs[0];
    prewarmNext(guildId);

    if (wasEmpty) {
      message.reply(
        songs.length > 1
          ? `🎶 Queued **${songs.length}** tracks from **${container}** — joining voice…`
          : `🎶 **${first.title}** — joining voice…`
      ).catch(() => {});
      setupVoiceConnection(guildId, voiceChannel, message);
      try {
        if (!q.connection) {
          destroyQueue(guildId, q);
          message.reply("❌ Could not join voice channel!").catch(() => {});
          return;
        }
        await entersState(q.connection, VoiceConnectionStatus.Ready, 20000);
        play(guildId).catch(() => {});
      } catch {
        destroyQueue(guildId, q);
        message.reply("❌ Could not join voice channel!").catch(() => {});
      }
    } else if (songs.length > 1) {
      safeSend(textChannel, { content: `🎶 Added **${songs.length}** tracks from **${container}** (${q.songs.length - songs.length} already in queue)` });
    } else {
      safeSend(textChannel, { content: `🎶 Added to queue: **${first.title}** (${q.songs.length - 1} more in queue)` });
    }
    return;
  }

  // For search queries, show selection menu
  try {
    const results = await searchVideo(query, 5);
    if (!results.length) {
      return message.reply("❌ No results found for that search.").catch(() => {});
    }

    if (results.length === 1) {
      // Only one result, play it directly
      const song = {
        url: results[0].url,
        title: results[0].title,
        duration: results[0].duration,
        source: results[0].source,
        client: results[0].client,
        requester: message.author?.tag || "Unknown",
        requesterId: message.author?.id || null,
      };
      const existing = getQueue(guildId);
      const wasEmpty = !existing || existing.songs.length === 0;
      const q = addSongToQueue(guildId, [song], textChannel);
      prewarmNext(guildId);

      if (wasEmpty) {
        message.reply(`🎶 **${song.title}** — joining voice…`).catch(() => {});
        setupVoiceConnection(guildId, voiceChannel, message);
        try {
          if (!q.connection) {
            destroyQueue(guildId, q);
            message.reply("❌ Could not join voice channel!").catch(() => {});
            return;
          }
          await entersState(q.connection, VoiceConnectionStatus.Ready, 20000);
          play(guildId).catch(() => {});
        } catch {
          destroyQueue(guildId, q);
          message.reply("❌ Could not join voice channel!").catch(() => {});
        }
      } else {
        safeSend(textChannel, { content: `🎶 Added to queue: **${song.title}** (${q.songs.length - 1} more in queue)` });
      }
      return;
    }

    // Multiple results - show selection menu
    const selectMenu = new StringSelectMenuBuilder()
      .setCustomId(`play_select_${guildId}_${message.author.id}`)
      .setPlaceholder("Select a song to play")
      .addOptions(
        results.slice(0, 5).map((r, i) => new StringSelectMenuOptionBuilder()
          .setLabel(`${i + 1}. ${r.title}`.slice(0, 100))
          .setDescription(`${r.uploader ? `${r.uploader} • ` : ""}${r.duration ? formatDuration(r.duration) : ""}${r.viewCount ? ` • ${formatViewCount(r.viewCount)} views` : ""}`.slice(0, 100))
          .setValue(`${i}`)
        )
      );

    const row = new ActionRowBuilder().addComponents(selectMenu);
    const replyMsg = await message.reply({
      content: `🔍 Found **${results.length}** results for "**${escapeMarkdown(query)}**" — pick one:`,
      components: [row],
    });

    // Store results for selection handler
    if (!global.playSearchResults) global.playSearchResults = new Map();
    global.playSearchResults.set(`${guildId}_${message.author.id}`, { results, voiceChannel, textChannel, replyMsg });

    // Cleanup after 30 seconds
    setTimeout(() => {
      global.playSearchResults?.delete(`${guildId}_${message.author.id}`);
      replyMsg.edit({ components: [] }).catch(() => {});
    }, 30000);

  } catch (e) {
    console.error("Play search error:", e.message);
    message.reply("❌ " + describeYtDlpError(e.message)).catch(() => {});
  }
}

function formatViewCount(count) {
  if (!count) return "";
  const num = Number(count);
  if (num >= 1e9) return (num / 1e9).toFixed(1) + "B";
  if (num >= 1e6) return (num / 1e6).toFixed(1) + "M";
  if (num >= 1e3) return (num / 1e3).toFixed(1) + "K";
  return num.toString();
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
  const guildId = message.guild.id;
  const q = getQueue(guildId);
  if (!q) {
    return message.reply("❌ Nothing is playing!").catch(() => {});
  }
  // Reply before tearing down: from the now-playing buttons the reply is tied
  // to this interaction, so it must not race the message deletion below.
  message.reply("⏹️ Stopped!").catch(() => {});
  q.songs = [];
  destroyQueue(guildId, q);
  if (q.player) q.player.stop(true);
}

function handlePauseCommand(message) {
  const q = getQueue(message.guild.id);
  if (!q || !q.player) {
    return message.reply("❌ Nothing is playing!").catch(() => {});
  }
  if (!q.player.pause()) {
    return message.reply("⚠️ Playback is not active right now!").catch(() => {});
  }
  refreshNowPlaying(q);
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
  refreshNowPlaying(q);
  message.reply("▶️ Resumed!").catch(() => {});
}

function handleQueueCommand(message) {
  const q = getQueue(message.guild.id);
  if (!q || q.songs.length === 0) {
    return message.reply("❌ The queue is empty!").catch(() => {});
  }
  const lines = q.songs.map((s, i) => {
    const title = escapeMarkdown(String(s.title || "Unknown"));
    const artist = s.artist ? ` — ${escapeMarkdown(s.artist)}` : "";
    const duration = s.duration ? `\`${formatDuration(s.duration)}\`` : "`--:--`";
    return `\`${i + 1}.\` **${title}**${artist}  •  ${duration}`;
  });
  const pages = chunk(lines, 10).map((p) => p.join("\n"));
  const totalSeconds = q.songs.reduce((sum, s) => sum + (Number(s.duration) || 0), 0);
  const embed = new EmbedBuilder()
    .setColor(EMBED_COLOR)
    .setAuthor({ name: "Queue List", iconURL: client.user.displayAvatarURL() })
    .setFooter({
      text: `Total songs: ${q.songs.length}${totalSeconds ? `  •  Total duration: ${formatDuration(totalSeconds)}` : ""}${q.loop ? "  •  Loop on" : ""}`,
    });
  sendPaginated(message, embed, pages).catch((e) => {
    console.error("Queue pagination failed:", e);
    message.reply("❌ Couldn't show the queue — try again.").catch(() => {});
  });
}

function handleLoopCommand(message) {
  const q = getQueue(message.guild.id);
  if (!q || q.songs.length === 0) {
    return message.reply("❌ Nothing is playing!").catch(() => {});
  }
  q.loop = !q.loop;
  refreshNowPlaying(q);
  message.reply(q.loop ? "🔁 Loop enabled!" : "🔁 Loop disabled!").catch(() => {});
}

function handleVolumeCommand(message, args) {
  const q = getQueue(message.guild.id);
  if (!q) {
    return message.reply("❌ Nothing is playing!").catch(() => {});
  }
  const vol = parseInt(args[0]);
  if (isNaN(vol) || vol < 0 || vol > 200) {
    return message.reply("❌ Volume must be between 0 and 200!").catch(() => {});
  }
  q.volume = vol;
  if (q.player && q.resource && q.resource.volume) {
    q.resource.volume.setVolume(vol / 200);
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
    if (q.songs.length === 0) {
      // Tearing the player down first means the Idle handler can't kick in
      // autoplay for a queue the user just emptied on purpose.
      destroyQueue(message.guild.id, q);
      if (q.player) q.player.stop(true);
    } else {
      // Current track was removed: advance without letting the Idle
      // handler shift again (that would drop the next song too).
      // stop() emits Idle synchronously, so flag first — but only when the
      // player is actually active (a no-op stop would leave the flag stale
      // and make the next song replay instead of advancing).
      const active = q.player && q.player.state.status !== AudioPlayerStatus.Idle;
      if (active) q._advanceMode = "keep";
      if (q.player) q.player.stop(true);
      else if (!q._starting) play(message.guild.id).catch(() => {});
    }
  }
  message.reply(`🗑️ Removed: ${removed.title}`).catch(() => {});
}

function handleClearCommand(message) {
  const guildId = message.guild.id;
  const q = getQueue(guildId);
  if (!q || q.songs.length === 0) {
    return message.reply("❌ Nothing in the queue!").catch(() => {});
  }
  message.reply("🗑️ Queue cleared!").catch(() => {});
  q.songs = [];
  destroyQueue(guildId, q);
  if (q.player) q.player.stop(true);
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
    "`/previous` — Play the previous song",
    "`/stop` — Stop playback and clear the queue",
    "`/pause` / `/resume` — Pause or resume playback",
    "`/queue` — Show the queue (paginated)",
    "`/nowplaying` — Show the current song with control buttons",
    "`/shuffle` — Shuffle the queue",
    "`/loop` — Toggle loop mode",
    "`/volume <0-200>` — Set volume",
    "`/remove <n>` — Remove a song by number",
    "`/clear` — Clear the queue",
    "`/join` / `/leave` — Join or leave your voice channel",
    "`/autoplay` — Toggle autoplay (auto-queue similar tracks)",
    "`/247` — Toggle 24/7 mode (stay connected when idle)",
    "`/lyric` — Lyrics for the current song",
    "`/help` — Show this message",
  ];
  message.reply({ content: lines.join("\n") }).catch(() => {});
}

// ---------------------------------------------------------------------------
// Small formatting helpers (ported from Lunox functions/timeFormat.js)
// ---------------------------------------------------------------------------
function formatDuration(totalSeconds) {
  const s = Math.max(0, Math.floor(Number(totalSeconds) || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const p = (n) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${p(m)}:${p(sec)}` : `${m}:${p(sec)}`;
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function capitalize(str) {
  const s = String(str || "");
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function applyVolume(q, vol) {
  q.volume = vol;
  if (q.player && q.resource && q.resource.volume) {
    q.resource.volume.setVolume(vol / 200);
  }
}

// ---------------------------------------------------------------------------
// Now-playing controller (ported from Lunox events/rainlink/player/trackStart.js)
// Sends an embed with playback buttons whenever a track starts and keeps it in
// sync while the track is playing.
// ---------------------------------------------------------------------------
function buildNowPlayingEmbed(q, song) {
  const clip = (str, max) => {
    const s = String(str || "Unknown");
    return s.length > max ? s.slice(0, max - 3) + "..." : s;
  };
  const paused = !!(q.player && q.player.state.status === AudioPlayerStatus.Paused);
  const title = clip(String(song.title || "Unknown").replace(/ - Topic$/, ""), 40);
  const artist = song.artist ? clip(song.artist, 30) : null;
  const label = artist ? `${title} - ${artist}` : title;
  const embed = new EmbedBuilder()
    .setColor(EMBED_COLOR)
    .setAuthor({ name: paused ? "Song Paused" : "Now Playing", iconURL: client.user.displayAvatarURL() })
    .setFields(
      { name: "Source", value: capitalize(song.source || "youtube"), inline: true },
      { name: "Duration", value: `\`${song.duration ? formatDuration(song.duration) : "LIVE/—"}\``, inline: true },
      { name: "Requested by", value: escapeMarkdown(String(song.requester || "Unknown")), inline: true },
    );
  if (song.url) embed.setDescription(`**[${escapeMarkdown(label)}](${song.url})**`);
  else embed.setDescription(`**${escapeMarkdown(label)}**`);
  return embed;
}

function nowPlayingRows(q) {
  const paused = !!(q.player && q.player.state.status === AudioPlayerStatus.Paused);
  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("np_pause").setEmoji(paused ? "▶️" : "⏸️")
      .setStyle(paused ? ButtonStyle.Primary : ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("np_voldown").setEmoji("🔉").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("np_volup").setEmoji("🔊").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("np_loop").setEmoji("🔁").setStyle(q.loop ? ButtonStyle.Success : ButtonStyle.Secondary),
  );
  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("np_shuffle").setEmoji("🔀").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("np_prev").setEmoji("⏮️").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("np_skip").setEmoji("⏭️").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("np_stop").setEmoji("⏹️").setStyle(ButtonStyle.Danger),
  );
  return [row1, row2];
}

function clearNowPlaying(q) {
  if (!q) return;
  if (q.npCollector) {
    try { q.npCollector.stop("cleanup"); } catch { /* already stopped */ }
    q.npCollector = null;
  }
  const msg = q.npMessage;
  q.npMessage = null;
  q.npSong = null;
  if (msg) {
    try { msg.delete().catch(() => {}); } catch { /* already gone */ }
  }
}

function refreshNowPlaying(q) {
  if (!q || !q.npMessage || !q.npSong) return;
  try {
    q.npMessage.edit({ embeds: [buildNowPlayingEmbed(q, q.npSong)], components: nowPlayingRows(q) }).catch(() => {});
  } catch { /* message gone */ }
}

async function sendNowPlaying(guildId, q, song) {
  clearNowPlaying(q);
  const channel = q.textChannel;
  if (!channel || typeof channel.send !== "function") return;
  try {
    const msg = await channel.send({ embeds: [buildNowPlayingEmbed(q, song)], components: nowPlayingRows(q) });
    q.npMessage = msg;
    q.npSong = song;
    if (!msg || typeof msg.createMessageComponentCollector !== "function") return;
    const collector = msg.createMessageComponentCollector();
    q.npCollector = collector;
    collector.on("collect", (btn) => handleNowPlayingButton(btn, guildId, q, song));
  } catch (e) {
    console.error("Now-playing message failed:", e.message);
  }
}

// Wraps a button interaction so the existing slash command handlers can be
// reused — replies become ephemeral, matching Lunox's controller feedback.
function buttonCtx(btn, guildId) {
  const reply = (payload) => {
    const data = typeof payload === "string" ? { content: payload, flags: 64 } : { ...payload, flags: 64 };
    return btn.reply(data).catch(() => {});
  };
  return {
    guild: btn.guild,
    member: btn.member,
    author: btn.user,
    user: btn.user,
    channel: btn.channel || { send: () => Promise.resolve() },
    reply,
    _guildId: guildId,
  };
}

async function handleNowPlayingButton(btn, guildId, q, song) {
  const member = btn.member;
  const vc = member && member.voice ? member.voice.channel : null;
  const botVcId = q.voiceChannel ? q.voiceChannel.id : null;
  if (!vc || vc.id !== botVcId) {
    return btn.reply({ content: "❌ You must be in the same voice channel as the bot.", flags: 64 }).catch(() => {});
  }
  const isRequester = !!(song.requesterId && btn.user.id === song.requesterId);
  const canManage = !!(member.permissions && member.permissions.has("ManageGuild"));
  if (!isRequester && !canManage) {
    return btn.reply({ content: "❌ Only the requester can use these controls.", flags: 64 }).catch(() => {});
  }
  if (getQueue(guildId) !== q) {
    return btn.reply({ content: "⚠️ This player has expired — use a slash command instead.", flags: 64 }).catch(() => {});
  }

  switch (btn.customId) {
    case "np_pause": {
      if (!q.player) return btn.reply({ content: "❌ Nothing is playing!", flags: 64 }).catch(() => {});
      const paused = q.player.state.status === AudioPlayerStatus.Paused;
      if (paused) q.player.unpause();
      else q.player.pause();
      btn.deferUpdate().catch(() => {});
      refreshNowPlaying(q);
      return;
    }
    case "np_voldown": {
      const v = Math.max(0, q.volume - 10);
      applyVolume(q, v);
      return btn.reply({ content: `🔉 Volume set to ${v}`, flags: 64 }).catch(() => {});
    }
    case "np_volup": {
      const v = Math.min(200, q.volume + 10);
      applyVolume(q, v);
      return btn.reply({ content: `🔊 Volume set to ${v}`, flags: 64 }).catch(() => {});
    }
    case "np_loop": return handleLoopCommand(buttonCtx(btn, guildId));
    case "np_shuffle": return handleShuffleCommand(buttonCtx(btn, guildId));
    case "np_prev": return handlePreviousCommand(buttonCtx(btn, guildId));
    case "np_skip": return handleSkipCommand(buttonCtx(btn, guildId));
    case "np_stop": return handleStopCommand(buttonCtx(btn, guildId));
    default:
      return btn.reply({ content: "❌ Unknown button.", flags: 64 }).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Paginated messages (ported from Lunox functions/createPage.js)
// ---------------------------------------------------------------------------
async function sendPaginated(ctx, embed, pages) {
  let page = 0;
  const render = () => embed.setDescription(pages[page] || "No data found.");
  render();

  if (pages.length <= 1) return ctx.reply({ embeds: [embed] });

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("page_first").setEmoji("⏮").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("page_back").setEmoji("◀").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("page_close").setEmoji("✖").setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId("page_next").setEmoji("▶").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("page_last").setEmoji("⏭").setStyle(ButtonStyle.Secondary),
  );

  const msg = await ctx.reply({ embeds: [embed], components: [row] });
  if (!msg || typeof msg.createMessageComponentCollector !== "function") return msg;

  const ownerId = (ctx.user || ctx.author || {}).id;
  const collector = msg.createMessageComponentCollector({ time: 60000 });

  collector.on("collect", async (btn) => {
    if (btn.user.id !== ownerId) {
      return btn.reply({ content: "❌ You are not allowed to use these buttons.", flags: 64 }).catch(() => {});
    }
    await btn.deferUpdate().catch(() => {});
    switch (btn.customId) {
      case "page_first": page = 0; break;
      case "page_back": page = Math.max(0, page - 1); break;
      case "page_close": collector.stop("closed"); return;
      case "page_next": page = Math.min(pages.length - 1, page + 1); break;
      case "page_last": page = pages.length - 1; break;
    }
    render();
    msg.edit({ embeds: [embed], components: [row] }).catch(() => {});
  });

  collector.on("end", () => msg.edit({ components: [] }).catch(() => {}));
  return msg;
}

// ---------------------------------------------------------------------------
// New commands: /shuffle, /previous, /join, /leave, /autoplay, /247, /lyric
// ---------------------------------------------------------------------------
function handleShuffleCommand(message) {
  const q = getQueue(message.guild.id);
  if (!q || q.songs.length === 0) {
    return message.reply("❌ Queue is empty. Shuffle not possible.").catch(() => {});
  }
  if (q.songs.length <= 1) {
    return message.reply("❌ Only one song in the queue. Shuffle not possible.").catch(() => {});
  }
  const current = q.songs[0];
  const rest = q.songs.slice(1);
  for (let i = rest.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [rest[i], rest[j]] = [rest[j], rest[i]];
  }
  q.songs = [current, ...rest];
  message.reply("🔀 Shuffled the queue!").catch(() => {});
}

function handlePreviousCommand(message) {
  const guildId = message.guild.id;
  const q = getQueue(guildId);
  if (!q) return message.reply("❌ Nothing is playing!").catch(() => {});
  if (!q.history.length) return message.reply("❌ Previous song not found.").catch(() => {});

  const prev = q.history.pop();
  q.songs.unshift(prev);
  // Reply first: this can also run from the now-playing buttons, and starting
  // the previous track deletes that message.
  message.reply(`⏮️ Playing the previous song: **${escapeMarkdown(prev.title)}**`).catch(() => {});
  const active = q.player && q.player.state.status !== AudioPlayerStatus.Idle;
  if (active) {
    // "keep" stops the player without shifting the songs array, so play()
    // restarts from the track we just moved to the front.
    q._advanceMode = "keep";
    q.player.stop(true);
  } else if (!q._starting) {
    play(guildId).catch(() => {});
  }
}

async function handleJoinCommand(message) {
  const guildId = message.guild.id;
  const voiceChannel = message.member?.voice?.channel;
  if (!voiceChannel) {
    return message.reply("❌ You need to be in a voice channel first!").catch(() => {});
  }
  const existing = getQueue(guildId);
  if (existing && existing.connection && existing.connection.state.status !== VoiceConnectionStatus.Destroyed) {
    return message.reply(`✅ I'm already connected to **${escapeMarkdown(existing.voiceChannel ? existing.voiceChannel.name : "a voice channel")}**.`).catch(() => {});
  }

  const q = existing || createQueue(guildId);
  if (!q.textChannel) q.textChannel = message.channel;
  const conn = connectVoice(guildId, voiceChannel, message.guild.voiceAdapterCreator);
  if (!conn) {
    if (!existing) destroyQueue(guildId, q);
    return message.reply("❌ Could not join the voice channel!").catch(() => {});
  }
  try {
    await entersState(conn, VoiceConnectionStatus.Ready, 20000);
    cancelAutoLeave(guildId);
    message.reply(`✅ Joined **${escapeMarkdown(voiceChannel.name)}**.`).catch(() => {});
  } catch {
    if (getQueue(guildId) === q && q.songs.length === 0) destroyQueue(guildId, q);
    message.reply("❌ Could not connect to the voice channel!").catch(() => {});
  }
}

function handleLeaveCommand(message) {
  const guildId = message.guild.id;
  const q = getQueue(guildId);
  if (!q) return message.reply("❌ I'm not connected to a voice channel.").catch(() => {});
  q.songs = [];
  destroyQueue(guildId, q);
  message.reply("👋 Left the voice channel.").catch(() => {});
}

function handle247Command(message) {
  const guildId = message.guild.id;
  const s = getGuildSettings(guildId);
  const q = getQueue(guildId);
  s.reconnect.status = !s.reconnect.status;
  s.reconnect.voice = (q && q.voiceChannel ? q.voiceChannel.id : message.member?.voice?.channelId) || s.reconnect.voice;
  s.reconnect.text = (q && q.textChannel && q.textChannel.id ? q.textChannel.id : message.channel?.id) || s.reconnect.text;
  saveGuildSettings();

  if (s.reconnect.status) {
    cancelAutoLeave(guildId);
    // Not connected yet: join straight away so 24/7 mode does something.
    if (!q) {
      const voiceChannel = message.member?.voice?.channel;
      if (voiceChannel) {
        const nq = createQueue(guildId);
        nq.textChannel = message.channel;
        if (!connectVoice(guildId, voiceChannel, message.guild.voiceAdapterCreator)) {
          destroyQueue(guildId, nq);
          return message.reply("❌ Could not join the voice channel!").catch(() => {});
        }
      }
    }
    return message.reply("🌙 24/7 mode **enabled** — I'll stay in the voice channel even when the queue is empty.").catch(() => {});
  }
  message.reply("☀️ 24/7 mode **disabled** — I'll leave after inactivity.").catch(() => {});
}

function handleAutoplayCommand(message) {
  const guildId = message.guild.id;
  const s = getGuildSettings(guildId);
  s.autoplay = !s.autoplay;
  saveGuildSettings();
  message.reply(s.autoplay
    ? "🔁 Autoplay **enabled** — I'll queue similar tracks when the queue runs dry."
    : "🔁 Autoplay **disabled**.").catch(() => {});
}

function splitSongTitle(song) {
  const raw = String(song.title || "").replace(/ - Topic$/i, "").trim();
  if (song.artist) return { title: raw, artist: song.artist };
  const m = raw.match(/^(.+?)\s+[-–—]\s+(.+)$/);
  if (m) return { title: m[2], artist: m[1] };
  return { title: raw, artist: "" };
}

async function handleLyricCommand(message) {
  const q = getQueue(message.guild.id);
  if (!q || q.songs.length === 0) {
    return message.reply("❌ Nothing is playing!").catch(() => {});
  }
  const song = q.songs[0];
  const { title, artist } = splitSongTitle(song);

  let lyrics = null;
  try {
    const res = await findLyrics({ song: title, artist, engine: "youtube", forceSearch: true });
    lyrics = res && res.lyrics ? String(res.lyrics).trim() : null;
  } catch (e) {
    console.error("Lyrics lookup failed:", e.message);
  }

  if (!lyrics) {
    return message.reply({ content: `❌ No lyrics found for **${escapeMarkdown(song.title)}**.` }).catch(() => {});
  }

  const embed = new EmbedBuilder()
    .setColor(EMBED_COLOR)
    .setAuthor({ name: `${BOT_NAME} Lyrics`, iconURL: client.user.displayAvatarURL() })
    .setThumbnail(song.artwork || null);

  if (lyrics.length <= 4096) {
    embed.setDescription(lyrics);
    return message.reply({ embeds: [embed] }).catch(() => {});
  }

  embed.setDescription(lyrics.slice(0, 4000) + "\n…");
  const query = encodeURIComponent(`${artist} ${title} lyrics`.trim());
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setURL(`https://www.google.com/search?q=${query}`).setLabel("Full Lyrics").setStyle(ButtonStyle.Link),
  );
  return message.reply({ embeds: [embed], components: [row] }).catch(() => {});
}

// ---------------------------------------------------------------------------
// Auto-leave when the bot is alone / idle (ported from Lunox
// events/bot/guild/voiceStateUpdate.js). Disabled while 24/7 mode is on.
// ---------------------------------------------------------------------------
const autoLeaveTimers = new Map();

function cancelAutoLeave(guildId) {
  const t = autoLeaveTimers.get(guildId);
  if (t) {
    clearTimeout(t);
    autoLeaveTimers.delete(guildId);
  }
}

function scheduleAutoLeave(guildId) {
  if (autoLeaveTimers.has(guildId)) return;
  const timer = setTimeout(() => {
    autoLeaveTimers.delete(guildId);
    const gq = getQueue(guildId);
    const guild = client.guilds.cache.get(guildId);
    const botMember = guild && guild.members ? guild.members.me : null;
    const channel = botMember && botMember.voice ? botMember.voice.channel : null;
    if (!channel || is247On(guildId)) return;

    const alone = channel.members.filter((m) => !m.user.bot).size === 0;
    const notPlaying = !gq || gq.songs.length === 0;
    if (!alone && !notPlaying) return;

    const textChannel = gq ? gq.textChannel : null;
    if (gq) destroyQueue(guildId, gq);
    else botMember.voice.disconnect("Inactivity").catch(() => {});

    if (textChannel) {
      safeSend(textChannel, { content: "🔌 Left the voice channel due to inactivity — use `/247` to keep me connected." });
    }
  }, LEAVE_TIMEOUT);
  autoLeaveTimers.set(guildId, timer);
}

function handleVoiceStateUpdate(oldState, newState) {
  try {
    const guild = oldState.guild || newState.guild;
    const guildId = guild.id;
    const botMember = guild.members ? guild.members.me : null;
    if (!botMember) return;
    const botChannelId = botMember.voice ? botMember.voice.channelId : null;

    // Stage channels: ask to speak automatically (ported from Lunox).
    if (newState.channelId && newState.channel && newState.channel.type === ChannelType.GuildStageVoice && botMember.voice.suppress) {
      try {
        const perms = newState.channel.permissionsFor(botMember);
        if (tryHas(botMember.permissions, "Speak") || (perms && perms.has("Speak"))) {
          botMember.voice.setSuppressed(false).catch(() => {});
        }
      } catch { /* ignore */ }
    }

    // The bot itself was disconnected (kicked or moved out) — drop its state.
    if (oldState.id === client.user?.id && !newState.channelId) {
      const q = getQueue(guildId);
      if (q) destroyQueue(guildId, q);
      cancelAutoLeave(guildId);
      return;
    }

    if (!botChannelId) {
      cancelAutoLeave(guildId);
      return;
    }

    const touches = oldState.channelId === botChannelId || newState.channelId === botChannelId;
    if (!touches) return;
    if (is247On(guildId)) {
      cancelAutoLeave(guildId);
      return;
    }

    const q = getQueue(guildId);
    const alone = botMember.voice.channel
      ? botMember.voice.channel.members.filter((m) => !m.user.bot).size === 0
      : true;
    const notPlaying = !q || q.songs.length === 0;

    if (alone || notPlaying) scheduleAutoLeave(guildId);
    else cancelAutoLeave(guildId);
  } catch (e) {
    console.error("voiceStateUpdate error:", e);
  }
}

// Reconnects to the saved voice channel on startup while 24/7 mode is on.
async function rejoin247Guilds() {
  for (const [guildId, settings] of Object.entries(guildSettings)) {
    if (!settings || !settings.reconnect || !settings.reconnect.status) continue;
    try {
      const guild = client.guilds.cache.get(guildId);
      if (!guild || (guild.members.me && guild.members.me.voice.channelId)) continue;
      const vc = settings.reconnect.voice ? guild.channels.cache.get(settings.reconnect.voice) : null;
      if (!vc || (vc.type !== ChannelType.GuildVoice && vc.type !== ChannelType.GuildStageVoice)) continue;
      const q = getQueue(guildId) || createQueue(guildId);
      const textCh = settings.reconnect.text ? guild.channels.cache.get(settings.reconnect.text) : null;
      if (textCh) q.textChannel = textCh;
      const conn = connectVoice(guildId, vc, guild.voiceAdapterCreator);
      if (!conn) continue;
      await entersState(conn, VoiceConnectionStatus.Ready, 20000);
      console.log(`24/7: reconnected to ${guild.name} → ${vc.name}`);
    } catch (e) {
      console.error(`24/7 rejoin failed for ${guildId}:`, e.message);
    }
  }
}

// ---------------------------------------------------------------------------
// Command permissions (ported from Lunox functions/getPermission.js)
// ---------------------------------------------------------------------------
const BOT_CHANNEL_PERMS = ["ViewChannel", "SendMessages", "EmbedLinks", "ReadMessageHistory"];

// voice: user must be in a voice channel
// player: a queue must exist and the user must be in the bot's voice channel
// current: something must be queued
// user: Discord permissions the invoker needs
const COMMAND_RULES = {
  play: { voice: true },
  skip: { voice: true, player: true, current: true },
  stop: { voice: true, player: true },
  pause: { voice: true, player: true, current: true },
  resume: { voice: true, player: true, current: true },
  queue: {},
  loop: { voice: true, player: true, current: true },
  volume: { voice: true, player: true },
  remove: { voice: true, player: true },
  clear: { voice: true, player: true },
  nowplaying: {},
  shuffle: { voice: true, player: true, current: true },
  previous: { voice: true, player: true, current: true },
  join: { voice: true },
  leave: { voice: true, player: true, user: ["ManageGuild"] },
  autoplay: { voice: true, player: true },
  "247": { voice: true, user: ["ManageGuild"] },
  lyric: { voice: true, player: true, current: true },
  help: {},
};

function tryHas(perms, flag) {
  try {
    return perms ? perms.has(flag) : false;
  } catch {
    return false;
  }
}

function denyPermission(ctx, text) {
  ctx.reply({ content: text, flags: 64 }).catch(() => {});
  return false;
}

// Returns true when the command may run, otherwise replies ephemerally and
// returns false.
function checkCommandPermission(ctx, name) {
  const rule = COMMAND_RULES[name] || {};
  const guild = ctx.guild;
  const member = ctx.member;
  const botMember = guild && guild.members ? guild.members.me : null;

  if (guild && botMember && ctx.channel && typeof ctx.channel.permissionsFor === "function") {
    const perms = ctx.channel.permissionsFor(botMember);
    if (perms) {
      const missing = BOT_CHANNEL_PERMS.filter((p) => !perms.has(p));
      if (missing.length) {
        return denyPermission(ctx, `❌ I'm missing \`${missing.join(", ")}\` in this channel — check my role and channel overwrites.`);
      }
    }
  }

  if (rule.user && rule.user.length && member) {
    const missing = rule.user.filter((p) => !tryHas(member.permissions, p));
    if (missing.length) {
      return denyPermission(ctx, `❌ You need the \`${missing.join(", ")}\` permission to use this command.`);
    }
  }

  if (rule.voice) {
    const vc = member && member.voice ? member.voice.channel : null;
    if (!vc) return denyPermission(ctx, "❌ You need to join a voice channel first.");

    if (botMember) {
      let channelPerms = null;
      try { channelPerms = botMember.permissionsIn(vc.id); } catch { channelPerms = null; }
      const has = (flag) => tryHas(botMember.permissions, flag) && (channelPerms ? tryHas(channelPerms, flag) : true);

      for (const flag of ["Connect", "Speak"]) {
        if (!has(flag)) return denyPermission(ctx, `❌ I don't have the \`${flag}\` permission in your voice channel.`);
      }
      if (vc.type === ChannelType.GuildStageVoice) {
        for (const flag of ["RequestToSpeak", "PrioritySpeaker"]) {
          if (!has(flag)) return denyPermission(ctx, `❌ I don't have the \`${flag}\` permission in your stage channel.`);
        }
      }
    }
  }

  if (rule.player || rule.current) {
    const q = guild ? getQueue(guild.id) : null;
    if (!q) return denyPermission(ctx, "❌ There is no player in this server.");
    if (rule.player && member && member.voice && member.voice.channelId !== (q.voiceChannel ? q.voiceChannel.id : null)) {
      return denyPermission(ctx, "❌ You need to join the same voice channel as the bot.");
    }
    if (rule.current && q.songs.length === 0) {
      return denyPermission(ctx, "❌ There is no song currently playing in this server.");
    }
  }

  return true;
}

const VOICE_COMMANDS = new Set(Object.keys(COMMAND_RULES).filter((k) => COMMAND_RULES[k].voice));

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
    user: interaction.user,
    reply,
    // Real channel object when available (so permission checks and sends work),
    // falling back to a reply-based shim for channels we can't see.
    channel: interaction.channel || {
      id: interaction.channelId,
      send: (payload) => {
        const data = typeof payload === "string" ? { content: payload } : payload;
        return reply(data);
      },
    },
  };
}

async function handleInteraction(interaction) {
  if (interaction.isButton()) return handleForeignButton(interaction);
  if (interaction.isStringSelectMenu()) return handleSelectMenu(interaction);
  if (!interaction.isChatInputCommand()) return;
  const name = interaction.commandName;

  if (!interaction.guild) {
    return interaction.reply({ content: "❌ This command only works in a server.", flags: 64 }).catch(() => {});
  }

  const ctx = interactionCtx(interaction);

  // Permission checks (channel perms, voice, player state, required roles).
  if (!checkCommandPermission(ctx, name)) return;

  if (name === "play" || name === "lyric") {
    try {
      await interaction.deferReply();
    } catch (e) {
      console.error("deferReply failed:", e);
      return;
    }
  }

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
      case "shuffle": handleShuffleCommand(ctx); break;
      case "previous": handlePreviousCommand(ctx); break;
      case "join": await handleJoinCommand(ctx); break;
      case "leave": handleLeaveCommand(ctx); break;
      case "autoplay": handleAutoplayCommand(ctx); break;
      case "247": handle247Command(ctx); break;
      case "lyric": await handleLyricCommand(ctx); break;
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

// Buttons owned by a message collector (now-playing controls, queue pages)
// are answered by that collector. If nothing answers — because the collector
// expired along with the message — reply so Discord doesn't show a failure.
function handleForeignButton(interaction) {
  const id = interaction.customId || "";
  if (!id.startsWith("np_") && !id.startsWith("page_")) {
    return interaction.reply({ content: "❌ That button has expired.", flags: 64 }).catch(() => {});
  }
  setTimeout(() => {
    if (!interaction.replied && !interaction.deferred) {
      interaction.reply({ content: "⚠️ This control has expired — use a slash command instead.", flags: 64 }).catch(() => {});
    }
  }, 2500);
}

async function handleSelectMenu(interaction) {
  const customId = interaction.customId || "";
  if (!customId.startsWith("play_select_")) {
    return interaction.reply({ content: "❌ This menu has expired.", flags: 64 }).catch(() => {});
  }

  const [, , guildId, userId] = customId.split("_");
  if (interaction.user.id !== userId) {
    return interaction.reply({ content: "❌ Only the command user can select from this menu.", flags: 64 }).catch(() => {});
  }

  const searchData = global.playSearchResults?.get(`${guildId}_${userId}`);
  if (!searchData) {
    return interaction.reply({ content: "❌ This menu has expired. Please search again.", flags: 64 }).catch(() => {});
  }

  const selectedIndex = parseInt(interaction.values[0], 10);
  const result = searchData.results[selectedIndex];
  if (!result) {
    return interaction.reply({ content: "❌ Invalid selection.", flags: 64 }).catch(() => {});
  }

  // Clean up
  global.playSearchResults.delete(`${guildId}_${userId}`);
  await interaction.update({ content: `🎶 Selected: **${escapeMarkdown(result.title)}** — joining voice…`, components: [] });

  // Add to queue and play
  const song = {
    url: result.url,
    title: result.title,
    duration: result.duration,
    source: result.source,
    client: result.client,
    requester: interaction.user?.tag || "Unknown",
    requesterId: interaction.user?.id || null,
  };

  const q = addSongToQueue(guildId, [song], searchData.textChannel);
  prewarmNext(guildId);

  const wasEmpty = q.songs.length === 1;
  if (wasEmpty) {
    setupVoiceConnection(guildId, searchData.voiceChannel, { guild: interaction.guild, channel: searchData.textChannel });
    try {
      if (!q.connection) {
        destroyQueue(guildId, q);
        searchData.textChannel.send("❌ Could not join voice channel!").catch(() => {});
        return;
      }
      await entersState(q.connection, VoiceConnectionStatus.Ready, 20000);
      play(guildId).catch(() => {});
    } catch {
      destroyQueue(guildId, q);
      searchData.textChannel.send("❌ Could not join voice channel!").catch(() => {});
    }
  } else {
    safeSend(searchData.textChannel, { content: `🎶 Added to queue: **${song.title}** (${q.songs.length - 1} more in queue)` });
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
    rejoin247Guilds().catch((e) => console.error("24/7 rejoin failed:", e));
  });

  client.on("voiceStateUpdate", handleVoiceStateUpdate);

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

// ---------------------------------------------------------------------------
// Anticrash (ported from Lunox handlers/anticrash.js): log fatal errors with
// their origin instead of letting the process die silently.
// ---------------------------------------------------------------------------
function setupAnticrash() {
  const log = (label, err, origin) => {
    console.error(`[anticrash] ${label}:`, err instanceof Error ? err.stack || err.message : err, origin ? `(origin: ${origin})` : "");
  };
  process.on("uncaughtException", (err, origin) => log("uncaughtException", err, origin));
  process.on("uncaughtExceptionMonitor", (err, origin) => log("uncaughtExceptionMonitor", err, origin));
  process.on("unhandledRejection", (reason) => log("unhandledRejection", reason));
  process.on("rejectionHandled", (promise) => log("rejectionHandled", promise));
}

setupAnticrash();

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
      destroyQueue(guildId, q);
      if (q.player) q.player.stop(true);
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
        if (q.songs.length === 0) {
          destroyQueue(guildId, q);
          if (q.player) q.player.stop(true);
        } else {
          const active = q.player && q.player.state.status !== AudioPlayerStatus.Idle;
          if (active) q._advanceMode = "keep";
          if (q.player) q.player.stop(true);
          else if (!q._starting) play(guildId).catch(() => {});
        }
      }
      break;
    }
    case "clear":
      if (!q) return res.status(400).json({ error: "No queue" });
      q.songs = [];
      destroyQueue(guildId, q);
      if (q.player) q.player.stop(true);
      break;
    case "volume": {
      if (!q) return res.status(400).json({ error: "No queue" });
      const vol = parseInt(req.body && req.body.volume, 10);
      if (isNaN(vol) || vol < 0 || vol > 200) return res.status(400).json({ error: "Volume 0-200" });
      q.volume = vol;
      if (q.player && q.resource && q.resource.volume) q.resource.volume.setVolume(vol / 200);
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
            duration: t.duration || null,
            search: spotifySearchQuery(t),
            source: "spotify",
            requester: "Dashboard",
            requesterId: null,
          }));
        } else {
          // Enqueue the raw query — no yt-dlp round-trip before responding.
          // The title and duration arrive with the stream itself.
          const direct = isYouTubeUrl(query) || isSoundCloudUrl(query);
          entries = [{
            url: direct ? query : null,
            search: direct ? null : query,
            title: query,
            source: isSoundCloudUrl(query) ? "soundcloud" : "youtube",
            requester: "Dashboard",
            requesterId: null,
          }];
        }
        const qq = getQueue(guildId);
        if (!qq) return res.status(400).json({ error: "Queue was cleared while resolving — try again" });
        for (const entry of entries) qq.songs.push(entry);
        prewarmNext(guildId);
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
  const discordOk = client.isReady() && client.ws.status === 0;
  res.status(discordOk ? 200 : 503).json({
    status: discordOk ? "ok" : "discord_disconnected",
    discord: discordOk ? "online" : "offline",
    lastStreamStart,
    uptimeSec: Math.round(process.uptime()),
  });
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

process.on('SIGTERM', async () => {
  console.log('SIGTERM received, shutting down...');
  client.destroy();
  for (const [guildId, q] of queue) destroyQueue(guildId, q);
  process.exit(0);
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

setInterval(() => {
  const now = Date.now();
  for (const [guildId, ts] of guildPlayCooldowns) {
    if (now - ts > 60000) guildPlayCooldowns.delete(guildId);
  }
}, 5 * 60 * 1000);
