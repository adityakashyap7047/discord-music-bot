# Discord Music Bot

A Discord music bot built with discord.js and ytdl-core.

## Features
- Play YouTube videos
- Queue management
- Skip, stop, pause, resume
- Volume control
- Loop mode
- Remove songs from queue

## Setup

1. **Install Node.js** from https://nodejs.org/
2. **Install FFmpeg** and add it to your PATH (https://ffmpeg.org/download.html)
3. **Create a Discord Bot** at https://discord.com/developers/applications
4. **Copy the bot token** to `.env` file

## Installation

```bash
npm install
```

## Start

```bash
# Set up .env file
cp .env.example .env
# Edit .env with your bot token

npm start
```

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
| `!nowplaying` | Show currently playing |

## Requirements
- Node.js 16+
- FFmpeg
- Discord bot with voice permissions
