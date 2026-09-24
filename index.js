require("dotenv").config();
const { Client, GatewayIntentBits, ActivityType } = require("discord.js");
const { joinVoiceChannel, createAudioPlayer, createAudioResource, entersState, VoiceConnectionStatus, AudioPlayerStatus, StreamType } = require("@discordjs/voice");
const ytdl = require("ytdl-core");

const TOKEN = process.env.DISCORD_TOKEN;
const PREFIX = "!";

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates, GatewayIntentBits.GuildMessages] });

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

client.on("ready", () => {
  console.log(`Logged in as ${client.user.tag}`);
  client.user.setActivity("Music | !play", { type: ActivityType.Listening });
});

client.on("messageCreate", async (message) => {
  if (message.author.bot || !message.content.startsWith(PREFIX)) return;

  const args = message.content.slice(PREFIX.length).trim().split(/ +/);
  const command = args.shift().toLowerCase();
  const guildId = message.guild.id;
  const textChannel = message.channel;
  const voiceChannel = message.member.voice.channel;

  if (!voiceChannel && ["play", "stop", "skip", "queue", "loop", "volume", "remove", "clear", "pause", "resume"].includes(command)) {
    return message.reply("❌ You need to be in a voice channel to use this command!");
  }

  switch (command) {
    case "play": {
      if (!args[0]) {
        return message.reply("❌ Please provide a YouTube URL or search query!");
      }

      let url = args.join(" ");
      if (ytdl.validateURL(url)) {
        try {
          const info = await ytdl.getInfo(url);
          url = info.videoDetails.video_url;
        } catch (e) {
          return message.reply("❌ Could not fetch video info!");
        }
      } else {
        try {
          const info = await ytdl.getInfo(url);
          const video = info.videoDetails;
          url = video.video_url;
        } catch (e) {
          return message.reply("❌ Could not find any results!");
        }
      }

      const info = await ytdl.getInfo(url);
      const title = info.videoDetails.title;

      const q = addSongToQueue(guildId, url, title, textChannel);

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
          return message.reply("❌ Could not join the voice channel!");
        }
      }

      if (q.songs.length === 1) {
        play(guildId);
      } else {
        textChannel.send({ content: `🎶 Added to queue: **${title}** (${q.songs.length - 1} more in queue)` }).catch(() => {});
      }
      break;
    }

    case "skip": {
      const qSkip = getQueue(guildId);
      if (!qSkip || !qSkip.player) {
        return message.reply("❌ Nothing is playing!");
      }
      qSkip.player.stop();
      message.reply("⏭️ Skipped!").catch(() => {});
      break;
    }

    case "stop": {
      const qStop = getQueue(guildId);
      if (!qStop || !qStop.player) {
        return message.reply("❌ Nothing is playing!");
      }
      qStop.songs = [];
      qStop.player.stop();
      if (qStop.connection) {
        qStop.connection.destroy();
      }
      queue.delete(guildId);
      message.reply("⏹️ Stopped!").catch(() => {});
      break;
    }

    case "pause": {
      const qPause = getQueue(guildId);
      if (!qPause || !qPause.player) {
        return message.reply("❌ Nothing is playing!");
      }
      qPause.player.pause();
      message.reply("⏸️ Paused!").catch(() => {});
      break;
    }

    case "resume": {
      const qResume = getQueue(guildId);
      if (!qResume || !qResume.player) {
        return message.reply("❌ Nothing is playing!");
      }
      qResume.player.unpause();
      message.reply("▶️ Resumed!").catch(() => {});
      break;
    }

    case "queue": {
      const qQue = getQueue(guildId);
      if (!qQue || qQue.songs.length === 0) {
        return message.reply("❌ The queue is empty!");
      }
      const list = qQue.songs.map((s, i) => `${i + 1}. ${s.title}`).join("\n");
      textChannel.send({ content: `📋 Queue:\n${list}` }).catch(() => {});
      break;
    }

    case "loop": {
      const qLoop = getQueue(guildId);
      if (!qLoop || qLoop.songs.length === 0) {
        return message.reply("❌ Nothing is playing!");
      }
      qLoop.loop = !qLoop.loop;
      message.reply(qLoop.loop ? "🔁 Loop enabled!" : "🔁 Loop disabled!").catch(() => {});
      break;
    }

    case "volume": {
      const qVol = getQueue(guildId);
      if (!qVol) {
        return message.reply("❌ Nothing is playing!");
      }
      const vol = parseInt(args[0]);
      if (isNaN(vol) || vol < 0 || vol > 10) {
        return message.reply("❌ Volume must be between 0 and 10!");
      }
      qVol.volume = vol;
      if (qVol.player && qVol.resource && qVol.resource.volume) {
        qVol.resource.volume.setVolume(vol / 10);
      }
      message.reply(`🔊 Volume set to ${vol}`).catch(() => {});
      break;
    }

    case "remove": {
      const qRem = getQueue(guildId);
      if (!qRem || qRem.songs.length === 0) {
        return message.reply("❌ Nothing to remove!");
      }
      const index = parseInt(args[0]) - 1;
      if (isNaN(index) || index < 0 || index >= qRem.songs.length) {
        return message.reply("❌ Invalid song number!");
      }
      const removed = qRem.songs.splice(index, 1)[0];
      message.reply(`🗑️ Removed: ${removed.title}`).catch(() => {});
      break;
    }

    case "clear": {
      const qClear = getQueue(guildId);
      if (!qClear || qClear.songs.length === 0) {
        return message.reply("❌ Nothing in the queue!");
      }
      qClear.songs = [];
      if (qClear.connection) {
        qClear.connection.destroy();
      }
      queue.delete(guildId);
      message.reply("🗑️ Queue cleared!").catch(() => {});
      break;
    }

    case "nowplaying":
    case "np": {
      const qNp = getQueue(guildId);
      if (!qNp || qNp.songs.length === 0 || !qNp.player) {
        return message.reply("❌ Nothing is playing!");
      }
      const song = qNp.songs[0];
      textChannel.send({ content: `🎵 Now playing: **${song.title}**` }).catch(() => {});
      break;
    }

    default:
      message.reply("❌ Unknown command! Available commands: `play`, `skip`, `stop`, `pause`, `resume`, `queue`, `loop`, `volume`, `remove`, `clear`, `nowplaying`").catch(() => {});
  }
});

client.login(TOKEN);
