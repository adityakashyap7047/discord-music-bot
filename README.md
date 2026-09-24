# Discord Music Bot

A Discord music bot with a web dashboard, built with discord.js, yt-dlp, and FFmpeg.

## Features
- Play YouTube videos (URL or search query) via yt-dlp
- Queue management
- Skip, stop, pause, resume
- Volume control
- Loop mode
- Remove songs from queue
- Web dashboard with Discord OAuth2 login
- Real-time status API and health endpoint

## Requirements
- Node.js 18+
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

## Commands

| Command | Description |
|---------|-------------|
| `!play <URL/query>` | Play a song |
| `!skip` | Skip current song |
| `!stop` | Stop and clear queue |
| `!pause` | Pause playback |
| `!resume` | Resume playback |
| `!queue` | Show queue |
| `!loop` | Toggle loop |
| `!volume <0-10>` | Set volume |
| `!remove <number>` | Remove song from queue |
| `!clear` | Clear queue |
| `!nowplaying` / `!np` | Show currently playing |
| `!help` | List all commands |

## Deployment (Render)

The included `render.yaml` deploys the bot + dashboard to Render. It installs FFmpeg and the Linux `yt-dlp` binary automatically. Set `DISCORD_TOKEN`, `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET`, and `BASE_URL` in the service environment.
