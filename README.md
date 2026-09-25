# Discord Music Bot

A Discord music bot with a web dashboard, built with discord.js, yt-dlp, and FFmpeg.

## Features
- Play YouTube videos (URL or search query) via yt-dlp
- Play SoundCloud tracks (URL or `scsearch` query)
- Automatic SoundCloud fallback when YouTube bot-checks the server's IP
- Play Spotify links — tracks, albums, and playlists (up to 50 tracks per link)
- Resilient playback: yt-dlp is piped straight through FFmpeg, so a stream hiccup never leaves the channel silent
- Queue management
- Skip, stop, pause, resume
- Volume control
- Loop mode
- Remove songs from queue
- Interactive now-playing message with control buttons (pause, volume, loop, shuffle, previous, skip, stop)
- Paginated `/queue` with button navigation
- `/shuffle` and `/previous`
- Autoplay — auto-queues similar tracks when the queue runs dry
- 24/7 mode — stays in voice when idle and reconnects after a restart
- `/lyric` lookup for the current song
- Auto-leave after inactivity (disabled while 24/7 mode is on)
- Command permission checks (voice channel, same-VC-as-bot, Manage Guild, missing bot permissions)
- Web dashboard with Discord OAuth2 login
- Real-time status API and health endpoint

## Requirements
- Node.js 22.12+
- A Discord bot token (from the [Discord Developer Portal](https://discord.com/developers/applications))
- `yt-dlp` (a `yt-dlp.exe` is bundled for Windows; on Linux/macOS install it or set `YTDLP_PATH`)
- FFmpeg is bundled via `ffmpeg-static` — no system install needed

## Installation

```bash
npm install
```

## Start

```bash
# Set up .env file
cp .env.example .env
# Edit .env with your bot token and OAuth credentials

npm start
```

For development with auto-restart:

```bash
npm run dev
```

## Environment variables

| Variable | Description |
|----------|-------------|
| `DISCORD_TOKEN` | Bot token (required) |
| `DISCORD_CLIENT_ID` | Application ID (for OAuth login) |
| `DISCORD_CLIENT_SECRET` | OAuth2 client secret (for dashboard login) |
| `SESSION_SECRET` | Random string used to sign dashboard sessions |
| `BASE_URL` | Public URL of the dashboard (for OAuth redirects) |
| `YTDLP_PATH` | Optional path to a yt-dlp binary |
| `SPOTIFY_CLIENT_ID` | Optional — Spotify app client ID, enables official Web API metadata |
| `SPOTIFY_CLIENT_SECRET` | Optional — Spotify app client secret (with `SPOTIFY_CLIENT_ID`) |
| `YTDLP_COOKIES` | Optional — path to a `cookies.txt` that fixes YouTube bot checks |
| `YTDLP_COOKIES_FROM_BROWSER` | Optional — e.g. `chrome`, logs yt-dlp in with browser cookies (local use) |
| `YTDLP_CLIENTS` | Optional — comma-separated yt-dlp player clients tried on bot checks |
| `KEEP_ALIVE_URL` | Optional — public URL of this bot; pinged every 10 min so a free host never sleeps |
| `LEAVE_TIMEOUT` | Optional — ms of inactivity before the bot leaves voice (default `60000`; ignored while `/247` is on) |
| `EMBED_COLOR` | Optional — embed accent colour as hex without `#` (default `5865F2`) |
| `DATA_DIR` | Optional — folder for `guild-settings.json` (24/7 + autoplay state); point at a persistent disk to survive redeploys |

## Commands

Slash commands (type `/` in Discord):

| Command | Description |
|---------|-------------|
| `/play <URL/query>` | Play a YouTube video, Spotify track/album/playlist, or search |
| `/skip` | Skip current song |
| `/stop` | Stop and clear queue |
| `/pause` | Pause playback |
| `/resume` | Resume playback |
| `/queue` | Show queue |
| `/loop` | Toggle loop |
| `/volume <0-10>` | Set volume |
| `/remove <number>` | Remove song from queue |
| `/clear` | Clear queue |
| `/nowplaying` | Show currently playing |
| `/shuffle` | Shuffle the queue (keeps the current song first) |
| `/previous` | Play the previous song |
| `/join` | Join your voice channel |
| `/leave` | Leave voice and stop playback (Manage Server) |
| `/autoplay` | Toggle autoplay — auto-queue similar tracks when the queue empties |
| `/247` | Toggle 24/7 mode — stay in voice when idle, reconnect on restart (Manage Server) |
| `/lyric` | Lyrics for the current song |
| `/help` | List all commands |

Playback-control commands (`/skip`, `/stop`, `/pause`, `/resume`, `/loop`, `/volume`, `/remove`, `/clear`, `/shuffle`, `/previous`, `/lyric`, …) require you to be in the **same voice channel as the bot**, matching the permission model in [Lunox](https://github.com/adh319/Lunox). `/leave` and `/247` additionally require **Manage Server**.

The now-playing message has buttons for pause/resume, volume up/down, loop, shuffle, previous, skip, and stop — only the requester of the current song (or a member with Manage Server) can press them.

## Spotify

Paste any Spotify link into `/play` (or the dashboard's quick-play box):

```
/play https://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT
/play https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M
/play spotify:track:4cOdK2wGLETKBW3PvgPWqT
```

How it works:

- With `SPOTIFY_CLIENT_ID` + `SPOTIFY_CLIENT_SECRET` set, metadata (title, artist, playlist contents) comes from **Spotify's official Web API** using the client-credentials flow — no Premium account required. Create an app at [developer.spotify.com/dashboard](https://developer.spotify.com/dashboard); no redirect URI is needed.
- Without those keys the bot falls back to Spotify's public embed pages (**no API key required**), so Spotify links keep working out of the box.
- Spotify doesn't expose audio streams to bots, so each track is matched against YouTube via yt-dlp and streamed from there.
- Playlists/albums queue up to 50 tracks instantly; each track is resolved to its YouTube match lazily, right before it plays.
- Podcasts (`episode`/`show` links) are not supported.

## YouTube bot checks ("Sign in to confirm you're not a bot")

YouTube rate-limits IPs it considers automated — especially datacenter IPs (Render, VPS). The bot handles this in four layers:

1. **SoundCloud fallback** — when a *search query* is bot-checked, the same query is retried on SoundCloud, which never asks for bot verification. The track is queued with `source: "soundcloud"` and announced as such, so playback keeps going instead of failing. (A pasted YouTube URL is never silently redirected.)
2. **Automatic player-client fallback** — every yt-dlp call tries the default client first, then each client in `YTDLP_CLIENTS` (default `android_vr,web_embedded,mweb,tv_embedded`) whenever YouTube returns a bot-check or 429. Private/unavailable videos fail immediately without burning fallbacks.
3. **Request throttling** — yt-dlp calls are serialized with a cooldown to avoid triggering rate limits in the first place.
4. **Cookies (most reliable)** — set `YTDLP_COOKIES` to the path of a `cookies.txt` exported from a browser where you're logged into YouTube:

   ```bash
   # In .env
   YTDLP_COOKIES=./cookies.txt
   ```

   Locally you can instead use `YTDLP_COOKIES_FROM_BROWSER=chrome` (or `firefox`, `edge`). **Never commit `cookies.txt`** — it contains your session.

   On Render's **free plan** there is no persistent disk, so a cookie file cannot survive redeploys: leave `YTDLP_COOKIES` unset there and rely on the SoundCloud fallback.

If the error persists, wait a few minutes — YouTube usually lifts the block on its own.

## Playback pipeline

`yt-dlp -o -` writes the audio to stdout, FFmpeg decodes it to raw 48 kHz stereo PCM, and `@discordjs/voice` encodes it to opus in-process. Nothing is downloaded to disk, the transfer is retried by yt-dlp itself, and the first audio byte has to arrive before the track is considered "started" — so a failed extraction skips the track with an error message instead of silently stalling the channel.

## Deployment (Render)

The included `render.yaml` deploys the bot + dashboard to Render. The build step installs npm dependencies and downloads the Linux `yt-dlp` binary (FFmpeg comes bundled via `ffmpeg-static`). Set `DISCORD_TOKEN`, `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET`, and `BASE_URL` in the service environment.

Notes:

- The blueprint targets the **Free** plan and declares no disks — disks are a paid-plan feature and would make the deploy fail.
- `KEEP_ALIVE_URL` is pre-filled with this service's own URL (`https://discord-music-bot-rhed.onrender.com/health`). The bot pings it every 10 minutes so the free instance never sleeps; a sleeping instance drops the Discord gateway and every slash command answers *"The application did not respond"* until something wakes the service.
- `autoDeployTrigger: commit` redeploys on every push to `master`. GitHub shows no build status for this repo, so if the Render dashboard shows no new deployment after a push, run **Manual Deploy → Clear build cache & deploy** once and check that the repo is actually connected under *Settings → Source*.
