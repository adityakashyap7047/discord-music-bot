require("dotenv").config();
const { Client, GatewayIntentBits, ActivityType } = require("discord.js");
const { joinVoiceChannel, createAudioPlayer, createAudioResource, entersState, VoiceConnectionStatus, AudioPlayerStatus, StreamType } = require("@discordjs/voice");
const ytdl = require("ytdl-core");

const TOKEN = process.env.DISCORD_TOKEN;
const PREFIX = "!";

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

function getQueueData(guildId) {
  return { getQueue, createQueue, queue };
}

function play(guildId) {
  const q = getQueue(guildId);
  if (!q || q.songs.length === 0) {
    if (q && q.connection) {
      q.connection.destroy();
      queue.delete(guildId);
    }
    return;
  }

  const song = q.songs[0];
  const stream = ytdl(song.url, { filter: "audioonly", highWaterMark: 1 << 25 });
  const resource = createAudioResource(stream, { inputType: StreamType.Arbitrary, inlineVolume: true });
  q.resource = resource;

  if (!q.player) {
    q.player = createAudioPlayer();
  }

  q.player.removeAllListeners();
  q.player.on(AudioPlayerStatus.Idle, () => {
    if (q.loop) {
      play(guildId);
    } else {
      q.songs.shift();
      play(guildId);
    }
  });

  q.player.on(AudioPlayerStatus.Playing, () => {
    q.textChannel.send({ content: `🎵 Now playing: **${song.title}**` }).catch(() => {});
  });

  q.player.on("error", (error) => {
    console.error("Player error:", error);
    q.songs.shift();
    play(guildId);
  });

  q.connection.subscribe(q.player);
  q.player.play(resource);
  if (q.resource && q.resource.volume) {
    q.resource.volume.setVolume(q.volume / 10);
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
    q.voiceChannel = voiceChannel;
    try {
      q.connection = joinVoiceChannel({
        channelId: voiceChannel.id,
        guildId: guildId,
        adapterCreator: message.guild.voiceAdapterCreator,
      });
      q.connection.on(VoiceConnectionStatus.Disconnected, async () => {
        try {
          await entersState(q.connection, VoiceConnectionStatus.Signalling, 5000);
        } catch {
          q.connection.destroy();
          queue.delete(guildId);
        }
      });
      q.connection.on(VoiceConnectionStatus.Signalling, async () => {
        try {
          await entersState(q.connection, VoiceConnectionStatus.Ready, 5000);
        } catch {
          q.connection.destroy();
          queue.delete(guildId);
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
  const voiceChannel = message.member.voice.channel;

  if (!args[0]) {
    return message.reply("❌ Please provide a YouTube URL or search query!");
  }

  const command = async () => {
    let url;
    let title;
    if (ytdl.validateURL(args.join(" "))) {
      try {
        const info = await ytdl.getInfo(args.join(" "));
        url = info.videoDetails.video_url;
        title = info.videoDetails.title;
      } catch (e) {
        return message.reply("❌ Could not fetch video info!");
      }
    } else {
      try {
        const searchUrl = `https://www.youtube.com/results?search_query=${encodeURIComponent(args.join(" "))}`;
        const info = await ytdl.getInfo(searchUrl);
        url = info.videoDetails.video_url;
        title = info.videoDetails.title;
      } catch (e) {
        return message.reply("❌ Could not find any results!");
      }
    }

    const q = addSongToQueue(guildId, url, title, textChannel);

    if (q.songs.length === 1) {
      setupVoiceConnection(guildId, voiceChannel, message);
      play(guildId);
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
  if (!q || q.songs.length === 0) {
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
  if (message.author.bot || !message.content.startsWith(PREFIX)) return;

  const args = message.content.slice(PREFIX.length).trim().split(/ +/);
  const command = args.shift().toLowerCase();
  const guildId = message.guild.id;

  if (!message.member.voice.channel && VOICE_COMMANDS.includes(command)) {
    return message.reply("❌ You need to be in a voice channel to use this command!");
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

function startBot() {
  client.on("ready", () => {
    console.log(`Logged in as ${client.user.tag}`);
    client.user.setActivity("Music | !play", { type: ActivityType.Listening });
  });

  client.on("messageCreate", handleMessageCreate);
  client.login(TOKEN);
}

module.exports = { createClient, startBot, getQueue, createQueue, play, addSongToQueue };

const http = require("http");
const server = http.createServer((req, res) => {
  res.writeHead(200);
  res.end("Bot is running");
});
server.listen(process.env.PORT || 3000);

startBot();
