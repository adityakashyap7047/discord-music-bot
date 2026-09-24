require("dotenv").config();
const { Client, GatewayIntentBits, ActivityType } = require("discord.js");
const { joinVoiceChannel, createAudioPlayer, createAudioResource, entersState, VoiceConnectionStatus, AudioPlayerStatus, demuxProbe } = require("@discordjs/voice");
const { execFile } = require("child_process");
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
const PREFIX = "!";
const BOT_NAME = "NOTIXMIX";
const START_TIME = Date.now();

function resolveYtDlp() {
  if (process.env.YTDLP_PATH && fs.existsSync(process.env.YTDLP_PATH)) return process.env.YTDLP_PATH;
  const local = path.join(__dirname, process.platform === "win32" ? "yt-dlp.exe" : "yt-dlp");
  if (fs.existsSync(local)) return local;
  return "yt-dlp";
}
const YTDLP = resolveYtDlp();

function runYtDlp(args, timeout = 30000) {
  return new Promise((resolve, reject) => {
    execFile(YTDLP, ["--no-warnings", ...args], { maxBuffer: 10 * 1024 * 1024, timeout }, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr || err.message));
      else resolve(stdout.trim());
    });
  });
}

function isYouTubeUrl(s) {
  return /^https?:\/\/(www\.)?(youtube\.com|youtu\.be)\//i.test(s);
}

async function resolveVideo(query) {
  const target = isYouTubeUrl(query) ? query : `ytsearch1:${query}`;
  const json = await runYtDlp(["-J", "--no-playlist", target]);
  const info = JSON.parse(json);
  if (!info || !info.webpage_url) throw new Error("No results");
  return { url: info.webpage_url, title: info.title || "Unknown" };
}

async function getStreamUrl(url) {
  const out = await runYtDlp(["-f", "bestaudio/best", "--get-url", url], 45000);
  return out.split(/\r?\n/)[0] || out;
}

function openRemoteStream(url, redirects = 5) {
  return new Promise((resolve, reject) => {
    if (redirects <= 0) return reject(new Error("Too many redirects"));
    const lib = url.startsWith("http:") ? require("http") : https;
    const req = lib.get(url, { headers: { "User-Agent": "Mozilla/5.0" } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        const next = new URL(res.headers.location, url).toString();
        return openRemoteStream(next, redirects - 1).then(resolve, reject);
      }
      if (res.statusCode !== 200 && res.statusCode !== 206) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      resolve(res);
    });
    req.on("error", reject);
    req.setTimeout(30000, () => { req.destroy(new Error("Stream timeout")); });
  });
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
      q.textChannel.send("❌ Lost the voice connection — stopped playback.").catch(() => {});
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
        q.textChannel.send("❌ Could not connect to the voice channel — stopped playback.").catch(() => {});
      }
    }
    return;
  }

  const song = q.songs[0];
  let remote = null;

  try {
    const streamUrl = await getStreamUrl(song.url);
    if (getQueue(guildId) !== q) {
      q._starting = false;
      return;
    }
    remote = await openRemoteStream(streamUrl);
    const probe = await demuxProbe(remote);
    const resource = createAudioResource(probe.stream, {
      inputType: probe.type,
      inlineVolume: true,
    });

    if (getQueue(guildId) !== q) {
      if (remote && !remote.destroyed) remote.destroy();
      q._starting = false;
      return;
    }

    if (q.songs[0] !== song) {
      if (remote && !remote.destroyed) remote.destroy();
      q._starting = false;
      play(guildId).catch(() => {});
      return;
    }

    q.resource = resource;

    if (!q.player) {
      q.player = createAudioPlayer();
    }

    q.player.removeAllListeners();
    q.player.on(AudioPlayerStatus.Idle, () => {
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
        q.textChannel.send({ content: `🎵 Now playing: **${song.title}**` }).catch(() => {});
      }
    });

    q.player.on("error", (error) => {
      console.error("Player error:", error);
      // The player transitions to Idle right after emitting "error";
      // flag the advance so the Idle handler drops the broken track
      // even when loop is enabled (and does not advance twice).
      if (!q._advanceMode) q._advanceMode = "force";
    });

    if (!q.connection || getQueue(guildId) !== q) {
      if (remote && !remote.destroyed) remote.destroy();
      q._starting = false;
      return;
    }
    q._announceNext = true;
    q.connection.subscribe(q.player);
    q.player.play(resource);
    if (q.resource && q.resource.volume) {
      q.resource.volume.setVolume(q.volume / 10);
    }
  } catch (e) {
    console.error("Play error:", e);
    if (remote && !remote.destroyed) remote.destroy();
    if (getQueue(guildId) !== q) {
      q._starting = false;
      return;
    }
    if (q.songs[0] === song) q.songs.shift();
    q._advanceMode = null;
    q._starting = false;
    return play(guildId);
  }
  q._starting = false;
}

function addSongToQueue(guildId, url, title, textChannel) {
  const q = getQueue(guildId) || createQueue(guildId);
  if (!q.textChannel) q.textChannel = textChannel;
  q.songs.push({ url, title });
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

function handlePlayCommand(message, args) {
  const guildId = message.guild.id;
  const textChannel = message.channel;
  const voiceChannel = message.member?.voice?.channel;
  if (!voiceChannel) {
    return message.reply("❌ You need to be in a voice channel to use this command!").catch(() => {});
  }

  if (!args[0]) {
    return message.reply("❌ Please provide a YouTube URL or search query!").catch(() => {});
  }

  const command = async () => {
    const query = args.join(" ");
    let url;
    let title;
    try {
      const resolved = await resolveVideo(query);
      url = resolved.url;
      title = resolved.title;
    } catch (e) {
      return message.reply("❌ Could not find any results!").catch(() => {});
    }

    const q = addSongToQueue(guildId, url, title, textChannel);

    if (q.songs.length === 1) {
      setupVoiceConnection(guildId, voiceChannel, message);
      const waitForConnection = async () => {
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
      };
      waitForConnection().catch(() => {});
    } else {
      textChannel.send({ content: `🎶 Added to queue: **${title}** (${q.songs.length - 1} more in queue)` }).catch(() => {});
    }
  };

  command().catch(() => {});
}

function handleSkipCommand(message) {
  const q = getQueue(message.guild.id);
  if (!q || !q.player || q.songs.length === 0 || q.player.state.status === AudioPlayerStatus.Idle) {
    return message.reply("❌ Nothing is playing!").catch(() => {});
  }
  q._advanceMode = "force";
  q.player.stop(true);
  message.reply(q.songs.length === 0 ? "⏭️ Skipped — the queue has finished!" : "⏭️ Skipped!").catch(() => {});
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
  const list = q.songs.map((s, i) => `${i + 1}. ${s.title}`).join("\n");
  message.channel.send({ content: `📋 Queue:\n${list}` }).catch(() => {});
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
    q._advanceMode = "keep";
    if (q.player) q.player.stop(true);
    if (q.songs.length === 0) destroyQueue(message.guild.id, q);
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
  message.channel.send({ content: `🎵 Now playing: **${q.songs[0].title}**` }).catch(() => {});
}

function handleHelpCommand(message) {
  const lines = [
    `**${BOT_NAME} Commands**`,
    "`!play <url/query>` — Play a YouTube video or search",
    "`!skip` — Skip the current song",
    "`!stop` — Stop playback and clear the queue",
    "`!pause` — Pause playback",
    "`!resume` — Resume playback",
    "`!queue` — Show the queue",
    "`!loop` — Toggle loop mode",
    "`!volume <0-10>` — Set volume",
    "`!remove <n>` — Remove a song by number",
    "`!clear` — Clear the queue",
    "`!nowplaying` (`!np`) — Show the current song",
    "`!help` — Show this message",
  ];
  message.channel.send({ content: lines.join("\n") }).catch(() => {});
}

const VOICE_COMMANDS = ["play", "stop", "skip", "loop", "volume", "pause", "resume"];

function handleMessageCreate(message) {
  if (message.author.bot || !message.content.startsWith(PREFIX) || !message.guild) return;

  const args = message.content.slice(PREFIX.length).trim().split(/ +/);
  const command = args.shift().toLowerCase();

  if (!message.member || !message.member.voice || !message.member.voice.channel) {
    if (VOICE_COMMANDS.includes(command)) {
      return message.reply("❌ You need to be in a voice channel to use this command!").catch(() => {});
    }
  }

  switch (command) {
    case "play": handlePlayCommand(message, args); break;
    case "skip": handleSkipCommand(message); break;
    case "stop": handleStopCommand(message); break;
    case "pause": handlePauseCommand(message); break;
    case "resume": handleResumeCommand(message); break;
    case "queue": handleQueueCommand(message); break;
    case "loop": handleLoopCommand(message); break;
    case "volume": handleVolumeCommand(message, args); break;
    case "remove": handleRemoveCommand(message, args); break;
    case "clear": handleClearCommand(message); break;
    case "help": handleHelpCommand(message); break;
    case "nowplaying":
    case "np": handleNowPlayingCommand(message); break;
    default: message.reply("❌ Unknown command! Available commands: `play`, `skip`, `stop`, `pause`, `resume`, `queue`, `loop`, `volume`, `remove`, `clear`, `nowplaying`, `help`").catch(() => {});
  }
}

function applyPresence() {
  if (!client.isReady()) return;
  try {
    Promise.resolve(client.user.setActivity("Music | !play", { type: ActivityType.Listening }))
      .catch((err) => console.error("Presence update failed:", err));
    Promise.resolve(client.user.setStatus("online"))
      .catch((err) => console.error("Status update failed:", err));
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

function startBot() {
  client.on("ready", () => {
    console.log(`Logged in as ${client.user.tag}`);
    loginAttempts = 0;
    applyPresence();
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

  client.on("messageCreate", handleMessageCreate);

  setInterval(applyPresence, 30 * 60 * 1000);

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

function userHasGuild(guildId) {
  if (!client.isReady()) return false;
  const guild = client.guilds.cache.get(guildId);
  if (!guild) return false;
  return true;
}

function getUserGuilds(user) {
  if (!client.isReady() || !user || !user.guilds) return [];
  const botGuildIds = new Set(client.guilds.cache.map((g) => g.id));
  return user.guilds.filter((g) => botGuildIds.has(g.id));
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
    ytDlp: YTDLP,
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
  const inUserGuilds = (req.session.user.guilds || []).some((g) => g.id === guildId);
  if (!inUserGuilds) return res.status(403).json({ error: "Not your server" });
  const q = getQueue(guildId);
  if (!q) return res.json({ queue: [], nowPlaying: null, volume: 5, loop: false, voiceChannel: null });
  const nowPlaying = q.songs[0] || null;
  res.json({
    queue: q.songs.map((s, i) => ({ index: i, title: s.title, url: s.url })),
    nowPlaying,
    volume: q.volume,
    loop: q.loop,
    voiceChannel: q.voiceChannel ? { id: q.voiceChannel.id, name: q.voiceChannel.name } : null,
    playerState: q.player ? q.player.state.status : null,
  });
});

app.post("/api/control/:guildId/:action", requireAuth, async (req, res) => {
  const { guildId, action } = req.params;
  const inUserGuilds = (req.session.user.guilds || []).some((g) => g.id === guildId);
  if (!inUserGuilds) return res.status(403).json({ error: "Not your server" });
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
        q._advanceMode = "keep";
        if (q.player) q.player.stop(true);
        if (q.songs.length === 0) destroyQueue(guildId, q);
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
        return res.status(400).json({ error: "Bot is not in a voice channel here. Use !play in Discord first." });
      }
      const query = typeof (req.body && req.body.query) === "string" ? req.body.query.trim() : "";
      if (!query) return res.status(400).json({ error: "Missing query" });
      try {
        const resolved = await resolveVideo(query);
        const qq = getQueue(guildId);
        if (!qq) return res.status(400).json({ error: "Queue was cleared while resolving — try again" });
        qq.songs.push({ url: resolved.url, title: resolved.title });
        if (qq.player && qq.player.state.status === AudioPlayerStatus.Idle && !qq._starting) {
          play(guildId).catch(() => {});
        }
        return res.json({ ok: true, title: resolved.title });
      } catch (e) {
        return res.status(502).json({ error: "Could not find that track" });
      }
    }
    default:
      return res.status(400).json({ error: "Unknown action" });
  }
  res.json({ ok: true });
});

app.get("/health", (req, res) => {
  if (client.isReady() && client.ws.status === 0) {
    res.status(200).send("ok");
  } else {
    res.status(503).send("offline");
  }
});

app.get("/robots.txt", (req, res) => {
  res.type("text/plain").send("User-agent: *\nAllow: /\nDisallow: /dashboard\nDisallow: /api\nDisallow: /auth\n");
});

app.use((req, res) => {
  if (req.method !== "GET" && req.method !== "HEAD") return res.status(404).send("Not found");
  const file = path.join(ROOT, "index.html");
  if (fs.existsSync(file)) return res.sendFile(file);
  res.status(404).send("Not found");
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Dashboard running on port ${PORT}`));

module.exports = { createClient, startBot, getQueue, createQueue, play, addSongToQueue, app, client };

startBot();
