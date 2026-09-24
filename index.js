require("dotenv").config();
process.env.FFMPEG_PATH = process.env.FFMPEG_PATH || require("ffmpeg-static");
const { Client, GatewayIntentBits, ActivityType } = require("discord.js");
const { joinVoiceChannel, createAudioPlayer, createAudioResource, entersState, VoiceConnectionStatus, AudioPlayerStatus, demuxProbe } = require("@discordjs/voice");
const { execFile } = require("child_process");
const https = require("https");
const http = require("http");
const path = require("path");
const fs = require("fs");

const TOKEN = process.env.DISCORD_TOKEN;
const PREFIX = "!";

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
  return runYtDlp(["-f", "bestaudio/best", "--get-url", url], 45000);
}

function openRemoteStream(url, redirects = 5) {
  return new Promise((resolve, reject) => {
    if (redirects <= 0) return reject(new Error("Too many redirects"));
    const lib = url.startsWith("http:") ? http : https;
    const req = lib.get(url, { headers: { "User-Agent": "Mozilla/5.0" } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return openRemoteStream(res.headers.location, redirects - 1).then(resolve, reject);
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
  };
  queue.set(guildId, q);
  return q;
}

async function play(guildId) {
  const q = getQueue(guildId);
  if (!q || q.songs.length === 0) {
    if (q && q.connection) {
      q.connection.destroy();
      queue.delete(guildId);
    }
    return;
  }

  const song = q.songs[0];

  try {
    const streamUrl = await getStreamUrl(song.url);
    const remote = await openRemoteStream(streamUrl);
    const probe = await demuxProbe(remote);
    const resource = createAudioResource(probe.stream, {
      inputType: probe.type,
      inlineVolume: true,
    });
    q.resource = resource;

    if (!q.player) {
      q.player = createAudioPlayer();
    }

    q.player.removeAllListeners();
    q.player.on(AudioPlayerStatus.Idle, () => {
      if (q.loop) {
        play(guildId).catch(() => {});
      } else {
        q.songs.shift();
        play(guildId).catch(() => {});
      }
    });

    q.player.on(AudioPlayerStatus.Playing, () => {
      q.textChannel.send({ content: `🎵 Now playing: **${song.title}**` }).catch(() => {});
    });

    q.player.on("error", (error) => {
      console.error("Player error:", error);
      q.songs.shift();
      play(guildId).catch(() => {});
    });

    if (!q.connection) {
      console.error("No voice connection available");
      return;
    }
    q.connection.subscribe(q.player);
    q.player.play(resource);
    if (q.resource && q.resource.volume) {
      q.resource.volume.setVolume(q.volume / 10);
    }
  } catch (e) {
    console.error("Play error:", e);
    q.songs.shift();
    play(guildId).catch(() => {});
  }
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
        if (!queue.has(guildId)) return;
        try {
          await Promise.race([
            entersState(q.connection, VoiceConnectionStatus.Signalling, 5000),
            entersState(q.connection, VoiceConnectionStatus.Connecting, 5000),
            entersState(q.connection, VoiceConnectionStatus.Ready, 5000),
          ]);
        } catch {
          try {
            await entersState(q.connection, VoiceConnectionStatus.Ready, 20000);
          } catch {
            if (queue.has(guildId)) {
              q.connection.destroy();
              queue.delete(guildId);
            }
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
            message.reply("❌ Could not join voice channel!").catch(() => {});
            return;
          }
          await entersState(q.connection, VoiceConnectionStatus.Ready, 20000);
          play(guildId).catch(() => {});
        } catch {
          if (q.connection) {
            q.connection.destroy();
          }
          queue.delete(guildId);
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
  if (!q || !q.player) {
    return message.reply("❌ Nothing is playing!");
  }
  q.player.stop();
  message.reply("⏭️ Skipped!").catch(() => {});
}

function handleStopCommand(message) {
  const q = getQueue(message.guild.id);
  if (!q || !q.player) {
    return message.reply("❌ Nothing is playing!");
  }
  q.songs = [];
  q.player.stop();
  if (q.connection) q.connection.destroy();
  queue.delete(message.guild.id);
  message.reply("⏹️ Stopped!").catch(() => {});
}

function handlePauseCommand(message) {
  const q = getQueue(message.guild.id);
  if (!q || !q.player) {
    return message.reply("❌ Nothing is playing!");
  }
  q.player.pause();
  message.reply("⏸️ Paused!").catch(() => {});
}

function handleResumeCommand(message) {
  const q = getQueue(message.guild.id);
  if (!q || !q.player) {
    return message.reply("❌ Nothing is playing!");
  }
  q.player.unpause();
  message.reply("▶️ Resumed!").catch(() => {});
}

function handleQueueCommand(message) {
  const q = getQueue(message.guild.id);
  if (!q || q.songs.length === 0) {
    return message.reply("❌ The queue is empty!");
  }
  const list = q.songs.map((s, i) => `${i + 1}. ${s.title}`).join("\n");
  message.channel.send({ content: `📋 Queue:\n${list}` }).catch(() => {});
}

function handleLoopCommand(message) {
  const q = getQueue(message.guild.id);
  if (!q || !q.player || q.songs.length === 0) {
    return message.reply("❌ Nothing is playing!");
  }
  q.loop = !q.loop;
  message.reply(q.loop ? "🔁 Loop enabled!" : "🔁 Loop disabled!").catch(() => {});
}

function handleVolumeCommand(message, args) {
  const q = getQueue(message.guild.id);
  if (!q) {
    return message.reply("❌ Nothing is playing!");
  }
  const vol = parseInt(args[0]);
  if (isNaN(vol) || vol < 0 || vol > 10) {
    return message.reply("❌ Volume must be between 0 and 10!");
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
    return message.reply("❌ Nothing to remove!");
  }
  const index = parseInt(args[0]) - 1;
  if (isNaN(index) || index < 0 || index >= q.songs.length) {
    return message.reply("❌ Invalid song number!");
  }
  const removed = q.songs.splice(index, 1)[0];
  message.reply(`🗑️ Removed: ${removed.title}`).catch(() => {});
}

function handleClearCommand(message) {
  const q = getQueue(message.guild.id);
  if (!q || q.songs.length === 0) {
    return message.reply("❌ Nothing in the queue!");
  }
  q.songs = [];
  if (q.connection) q.connection.destroy();
  queue.delete(message.guild.id);
  message.reply("🗑️ Queue cleared!").catch(() => {});
}

function handleNowPlayingCommand(message) {
  const q = getQueue(message.guild.id);
  if (!q || q.songs.length === 0 || !q.player) {
    return message.reply("❌ Nothing is playing!");
  }
  message.channel.send({ content: `🎵 Now playing: **${q.songs[0].title}**` }).catch(() => {});
}

const VOICE_COMMANDS = ["play", "stop", "skip", "queue", "loop", "volume", "remove", "clear", "pause", "resume"];

function handleMessageCreate(message) {
  if (message.author.bot || !message.content.startsWith(PREFIX) || !message.guild) return;

  const args = message.content.slice(PREFIX.length).trim().split(/ +/);
  const command = args.shift().toLowerCase();

  if (!message.member || !message.member.voice || !message.member.voice.channel) {
    if (VOICE_COMMANDS.includes(command)) {
      return message.reply("❌ You need to be in a voice channel to use this command!");
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
    case "nowplaying":
    case "np": handleNowPlayingCommand(message); break;
    default: message.reply("❌ Unknown command! Available commands: `play`, `skip`, `stop`, `pause`, `resume`, `queue`, `loop`, `volume`, `remove`, `clear`, `nowplaying`").catch(() => {});
  }
}

function applyPresence() {
  if (!client.isReady()) return;
  client.user.setActivity("Music | !play", { type: ActivityType.Listening }).catch(() => {});
  client.user.setStatus("online").catch(() => {});
}

let loginAttempts = 0;

function login() {
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

module.exports = { createClient, startBot, getQueue, createQueue, play, addSongToQueue };

const server = http.createServer((req, res) => {
  if (client.isReady() && client.ws.status === 0) {
    res.writeHead(200);
    res.end("Bot is running");
  } else {
    res.writeHead(503);
    res.end("Bot offline");
  }
});
server.listen(process.env.PORT || 3000);

startBot();
