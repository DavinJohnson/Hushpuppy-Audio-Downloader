# Hushpuppy Audio Downloader

A Discord bot that downloads audio from BeatStars, SoundCloud, TrakTrain, and YouTube and sends the file directly in chat.

## Features

- `/dl <url>` slash command — paste any supported URL and get the file
- Auto-detects supported links posted in chat and downloads them automatically
- Supports BeatStars, SoundCloud, TrakTrain, and YouTube
- Attaches audio directly to Discord (up to 8 MB)

## Setup

```bash
git clone https://github.com/DavinJohnson/beatstars-dq.git
cd beatstars-dq
npm install
cp .env.example .env
# fill in DISCORD_TOKEN and DISCORD_CLIENT_ID
node bot.js
```

## Environment Variables

| Variable | Description |
|---|---|
| `DISCORD_TOKEN` | Your bot token from the Discord Developer Portal |
| `DISCORD_CLIENT_ID` | Your application's client ID |

## Running with PM2

```bash
pm2 start bot.js --name hushpuppy
pm2 save
```

## License

ISC
