'use strict';

const path = require('path');
const os = require('os');
const fs = require('fs');
const YTDlpWrap = require('yt-dlp-wrap').default;

// Store the yt-dlp binary next to the project
const BINARY_DIR = path.join(__dirname, '..', '.bin');
const BINARY_PATH = path.join(BINARY_DIR, process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp');

let _ytdlp = null;

async function getYtDlp() {
  if (_ytdlp) return _ytdlp;

  if (!fs.existsSync(BINARY_PATH)) {
    fs.mkdirSync(BINARY_DIR, { recursive: true });
    console.log('  Downloading yt-dlp binary (first run only)...');
    await YTDlpWrap.downloadFromGithub(BINARY_PATH);
    console.log('  yt-dlp ready.');
  }

  _ytdlp = new YTDlpWrap(BINARY_PATH);

  // Auto-update yt-dlp in the background — old versions get throttled by YouTube
  _ytdlp.exec(['--update']).on('close', () => {}).on('error', () => {});

  return _ytdlp;
}

function detect(url) {
  return /youtube\.com|youtu\.be/i.test(url);
}

async function getInfo(input) {
  const ytdlp = await getYtDlp();

  // getVideoInfo uses "-f best" internally which breaks — use --dump-json directly
  const raw = await new Promise((resolve, reject) => {
    let out = '';
    ytdlp.exec([
      input.trim(),
      '--dump-json',
      '--no-playlist',
      '--js-runtimes', 'nodejs',
      '--quiet',
      '--no-warnings',
    ])
      .on('ytDlpEvent', (event, data) => { if (event === 'stdout') out += data; })
      .on('error', reject)
      .on('close', () => {
        try { resolve(JSON.parse(out)); } catch { reject(new Error('Could not parse yt-dlp metadata')); }
      });
  });

  return {
    title: raw.title || 'Unknown',
    artist: raw.uploader || raw.channel || 'Unknown',
    bpm: null,
    ext: 'mp3',
    _url: input.trim(),
  };
}

async function downloadTrack(input, destPath) {
  const ytdlp = await getYtDlp();

  // yt-dlp outputs to a path — strip the .mp3 extension since yt-dlp adds its own
  const destNoExt = destPath.replace(/\.mp3$/, '');

  await new Promise((resolve, reject) => {
    ytdlp.exec([
      input.trim(),
      '--format', 'bestaudio[ext=m4a]/bestaudio/best',  // audio-only stream, no video download
      '--extract-audio',
      '--audio-format', 'mp3',
      '--audio-quality', '0',
      '--no-playlist',
      '--output', destNoExt + '.%(ext)s',
      '--quiet',
      '--no-warnings',
      '--no-check-certificates',
      '--js-runtimes', 'nodejs',
    ])
      .on('ytDlpEvent', () => {})
      .on('error', reject)
      .on('close', resolve);
  });

  // yt-dlp names the file itself — confirm it exists
  if (!fs.existsSync(destPath)) {
    throw new Error('yt-dlp finished but output file not found');
  }

  const info = await getInfo(input);
  return info;
}

module.exports = { detect, getInfo, downloadTrack };
