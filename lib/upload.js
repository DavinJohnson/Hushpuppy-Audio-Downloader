'use strict';

/**
 * Upload a file to Litterbox (litterbox.catbox.moe) when it's too large for Discord.
 * Free, no API key, up to 1 GB, links expire after 72 hours.
 * Uses only Node built-ins (https + multipart/form-data).
 */

const fs = require('fs');
const https = require('https');
const path = require('path');

const LITTERBOX_URL = 'https://litterbox.catbox.moe/resources/internals/api.php';
const EXPIRY = '72h';

/**
 * Upload filePath to Litterbox and return the CDN URL string.
 */
function uploadToLitterbox(filePath) {
  return new Promise((resolve, reject) => {
    const boundary = `----HushpuppyBoundary${Date.now()}`;
    const filename = path.basename(filePath);
    const fileData = fs.readFileSync(filePath);

    // Build multipart/form-data body
    const parts = [];

    // reqtype field
    parts.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="reqtype"\r\n\r\nfileupload\r\n`
      )
    );

    // time field
    parts.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="time"\r\n\r\n${EXPIRY}\r\n`
      )
    );

    // file field
    parts.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="fileToUpload"; filename="${filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`
      )
    );
    parts.push(fileData);
    parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));

    const body = Buffer.concat(parts);

    const options = {
      method: 'POST',
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': body.length,
        'User-Agent': 'hushpuppy/1.0',
      },
    };

    const req = https.request(LITTERBOX_URL, options, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        if (res.statusCode !== 200) {
          return reject(new Error(`Litterbox upload failed: HTTP ${res.statusCode} — ${data.trim()}`));
        }
        const url = data.trim();
        if (!url.startsWith('https://')) {
          return reject(new Error(`Litterbox returned unexpected response: ${url}`));
        }
        resolve(url);
      });
    });

    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

module.exports = { uploadToLitterbox };
