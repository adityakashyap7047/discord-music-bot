# Discord Music Bot

A Discord music bot with a web dashboard, built with discord.js, yt-dlp, and FFmpeg.

## Features
- Play YouTube videos (URL or search query) via yt-dlp
- Play Spotify links — tracks, albums, and playlists (up to 50 tracks per link)
- Queue management
- Skip, stop, pause, resume
- Volume control
- Loop mode
- Remove songs from queue
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
| `/help` | List all commands |

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

YouTube rate-limits IPs it considers automated — especially datacenter IPs (Render, VPS). The bot handles this in three layers:

1. **Automatic player-client fallback** — every yt-dlp call tries the default client first, then each client in `YTDLP_CLIENTS` (default `android_vr,web_embedded,mweb,tv_embedded`) whenever YouTube returns a bot-check or 429. Private/unavailable videos fail immediately without burning fallbacks.
2. **Request throttling** — yt-dlp calls are serialized with a cooldown to avoid triggering rate limits in the first place.
3. **Cookies (most reliable)** — set `YTDLP_COOKIES` to the path of a `cookies.txt` exported from a browser where you're logged into YouTube:

   ```bash
   # In .env
   YTDLP_COOKIES=./cookies.txt
   ```

   Locally you can instead use `YTDLP_COOKIES_FROM_BROWSER=chrome` (or `firefox`, `edge`). **Never commit `cookies.txt`** — it contains your session.

   On Render this is already wired up: `render.yaml` mounts a persistent disk at `/var/data` and sets `YTDLP_COOKIES=/var/data/cookies.txt`. Upload your `cookies.txt` to that disk (Render dashboard → Disks → Files, or `render disk` CLI) and it survives redeploys. Until the file exists the bot just runs without cookies.

If the error persists, wait a few minutes — YouTube usually lifts the block on its own.

## Deployment (Render)

The included `render.yaml` deploys the bot + dashboard to Render. The build step installs npm dependencies and downloads the Linux `yt-dlp` binary (FFmpeg comes bundled via `ffmpeg-static`). Set `DISCORD_TOKEN`, `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET`, and `BASE_URL` in the service environment.
