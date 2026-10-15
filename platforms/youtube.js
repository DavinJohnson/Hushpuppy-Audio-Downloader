'use strict';

const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');
const YTDlpWrap = require('yt-dlp-wrap').default;

const BINARY_DIR = path.join(__dirname, '..', '.bin');
const BINARY_PATH = path.join(BINARY_DIR, process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp');

let _ready = false;

async function ensureYtDlp() {
  if (_ready) return;

  if (!fs.existsSync(BINARY_PATH)) {
    fs.mkdirSync(BINARY_DIR, { recursive: true });
    console.log('  Downloading yt-dlp binary (first run only)...');
    await YTDlpWrap.downloadFromGithub(BINARY_PATH);
    console.log('  yt-dlp ready.');
  }

  _ready = true;
}

// Run yt-dlp directly via execFile — avoids yt-dlp-wrap quirks
function ytdlp(args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(BINARY_PATH, args, { maxBuffer: 10 * 1024 * 1024, ...opts }, (err, stdout, stderr) => {
      if (err) return reject(new Error(stderr || err.message));
      resolve(stdout);
    });
  });
}

function detect(url) {
  return /youtube\.com|youtu\.be/i.test(url);
}

async function getInfo(input) {
  await ensureYtDlp();

  const stdout = await ytdlp([
    input.trim(),
    '--dump-json',
    '--no-playlist',
    '--quiet',
    '--no-warnings',
  ]);

  let raw;
  try { raw = JSON.parse(stdout); } catch { throw new Error('Could not parse YouTube metadata'); }

  return {
    title: raw.title || 'Unknown',
    artist: raw.uploader || raw.channel || 'Unknown',
    bpm: null,
    ext: 'mp3',
    _url: input.trim(),
  };
}

async function downloadTrack(input, destPath) {
  await ensureYtDlp();

  const destNoExt = destPath.replace(/\.mp3$/i, '');

  const result = await ytdlp([
    input.trim(),
    '--format', 'bestaudio/best',
    '--extract-audio',
    '--audio-format', 'mp3',
    '--audio-quality', '0',
    '--no-playlist',
    '--output', destNoExt + '.%(ext)s',
  ]);
  if (result) console.log('[yt-dlp]', result.slice(0, 500));

  // yt-dlp writes destNoExt.mp3 after conversion
  if (!fs.existsSync(destPath)) {
    // check for any audio file with this base in case ext differs
    const exts = ['mp3', 'm4a', 'webm', 'ogg', 'opus'];
    for (const ext of exts) {
      const candidate = destNoExt + '.' + ext;
      if (fs.existsSync(candidate)) {
        fs.renameSync(candidate, destPath);
        break;
      }
    }
  }

  if (!fs.existsSync(destPath)) throw new Error('yt-dlp finished but output file not found');
}

module.exports = { detect, getInfo, downloadTrack };
