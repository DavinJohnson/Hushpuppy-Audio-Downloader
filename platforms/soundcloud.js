'use strict';

const { get, download } = require('../lib');

const SC_HOME = 'https://soundcloud.com';
const API = 'https://api-v2.soundcloud.com';
const SC_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36',
  'Origin': 'https://soundcloud.com',
  'Referer': 'https://soundcloud.com/',
  'Accept': 'application/json',
};

// Cache the client_id for the session — it rotates infrequently
let _clientId = null;

async function getClientId() {
  if (_clientId) return _clientId;

  const { body: html } = await get(SC_HOME, { headers: { 'Accept': 'text/html' } });

  // Pull client_id from the apiClient hydration object embedded in the page
  const hydrationMatch = html.match(/__sc_hydration = (\[[\s\S]+?\]);\s*<\/script>/);
  if (hydrationMatch) {
    try {
      const hydration = JSON.parse(hydrationMatch[1]);
      const apiClient = hydration.find((d) => d.hydratable === 'apiClient');
      if (apiClient?.data?.id) {
        _clientId = apiClient.data.id;
        return _clientId;
      }
    } catch {}
  }

  // Fallback: scrape JS bundles
  const scripts = [...html.matchAll(/src="(https:\/\/a-v2\.sndcdn\.com\/assets\/[^"]+\.js)"/g)].map((m) => m[1]);
  for (const scriptUrl of scripts) {
    const { body } = await get(scriptUrl);
    const match = body.match(/client_id:"([a-zA-Z0-9]{32})"/);
    if (match) {
      _clientId = match[1];
      return _clientId;
    }
  }

  throw new Error('Could not extract SoundCloud client_id');
}

/**
 * Extract secret_token from private share links.
 * Private URLs look like: /track-slug/s-XXXXXXXX or ?secret_token=s-XXXXXXXX
 */
function extractSecretToken(url) {
  // Query param form: ?secret_token=s-XXXX
  const qMatch = url.match(/[?&]secret_token=(s-[a-zA-Z0-9]+)/);
  if (qMatch) return qMatch[1];
  // Path form: /s-XXXX at end of path (before any query)
  const pathMatch = url.match(/\/(s-[a-zA-Z0-9]+)(?:[/?#]|$)/);
  if (pathMatch) return pathMatch[1];
  return null;
}

function detect(url) {
  return /soundcloud\.com/i.test(url);
}

async function getInfo(input) {
  const clientId = await getClientId();
  const secretToken = extractSecretToken(input.trim());

  let resolveUrl = `${API}/resolve?url=${encodeURIComponent(input.trim())}&client_id=${clientId}`;
  if (secretToken) resolveUrl += `&secret_token=${secretToken}`;

  const { status, body } = await get(resolveUrl, { headers: SC_HEADERS });

  if (status === 401) throw new Error('SoundCloud returned 401 — track is private or the share link is invalid');
  if (status === 404) throw new Error('Track not found on SoundCloud (may be private or deleted)');
  if (status !== 200) throw new Error(`SoundCloud API returned HTTP ${status}`);

  let track;
  try { track = JSON.parse(body); } catch { throw new Error('Invalid JSON from SoundCloud API'); }

  if (track.kind !== 'track') throw new Error('URL does not point to a SoundCloud track');

  // Check if the track has a direct WAV/original download available
  const hasDownload = track.downloadable && track.has_downloads_left;
  const downloadUrl = hasDownload ? track.download_url : null;

  // Prefer progressive (direct MP3), fall back to HLS
  const progressive = track.media?.transcodings?.find((t) => t.format?.protocol === 'progressive');
  const hls = track.media?.transcodings?.find((t) => t.format?.protocol === 'hls' && !t.format?.mime_type?.includes('encrypted'));

  const transcoding = progressive || hls;
  if (!transcoding && !downloadUrl) throw new Error('No playable stream found for this SoundCloud track');

  // Use WAV download if available, otherwise stream
  const ext = downloadUrl ? (track.original_format || 'wav') : 'mp3';

  return {
    title: track.title || 'Unknown',
    artist: track.user?.username || 'Unknown',
    bpm: null,
    _downloadUrl: downloadUrl,
    _transcodingUrl: transcoding?.url || null,
    _clientId: clientId,
    _secretToken: secretToken,
    _isHls: !progressive && !downloadUrl,
    ext,
  };
}

async function downloadTrack(input, destPath) {
  const info = await getInfo(input);

  // If track has a direct download (WAV/original), use that first
  if (info._downloadUrl) {
    let dlUrl = `${info._downloadUrl}?client_id=${info._clientId}`;
    if (info._secretToken) dlUrl += `&secret_token=${info._secretToken}`;

    const { status, body } = await get(dlUrl, { headers: SC_HEADERS });
    if (status === 200) {
      // Response is JSON with a redirect URL
      try {
        const data = JSON.parse(body);
        if (data.redirectUri) {
          await download(data.redirectUri, destPath);
          return info;
        }
      } catch {}
    }
    // Fall through to stream if direct download fails
  }

  // Resolve the stream URL (transcoding endpoint gives a temp signed URL)
  if (!info._transcodingUrl) throw new Error('No stream available for this track');

  let streamResolveUrl = `${info._transcodingUrl}?client_id=${info._clientId}`;
  if (info._secretToken) streamResolveUrl += `&secret_token=${info._secretToken}`;

  const { status, body } = await get(streamResolveUrl, { headers: SC_HEADERS });
  if (status !== 200) throw new Error(`SoundCloud stream resolve returned HTTP ${status}`);

  let streamData;
  try { streamData = JSON.parse(body); } catch { throw new Error('Invalid stream response from SoundCloud'); }

  if (!streamData.url) throw new Error('SoundCloud did not return a stream URL');

  await download(streamData.url, destPath);
  return info;
}

module.exports = { detect, getInfo, downloadTrack };
