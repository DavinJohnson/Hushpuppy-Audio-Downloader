'use strict';

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const os = require('os');
const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder, AttachmentBuilder } = require('discord.js');
const { sanitizeFilename } = require('./lib');
const { detectPlatform } = require('./platforms');
const { checkDemucs, splitStems, VALID_STEMS } = require('./lib/stems');

const TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.DISCORD_CLIENT_ID;

if (!TOKEN || !CLIENT_ID) {
  console.error('Missing DISCORD_TOKEN or DISCORD_CLIENT_ID in environment.');
  console.error('Copy .env.example to .env and fill in your values, then run: node bot.js');
  process.exit(1);
}

const DISCORD_MAX_BYTES = 8 * 1024 * 1024;

const SUPPORTED_URL_RE = /https?:\/\/(?:www\.)?(beatstars\.com\/beat\/|soundcloud\.com\/|traktrain\.com\/|(?:www\.)?youtube\.com\/watch|youtu\.be\/)[^\s]*/gi;

const PLATFORM_LABELS = {
  beatstars: 'BeatStars',
  soundcloud: 'SoundCloud',
  traktrain: 'TrakTrain',
  youtube: 'YouTube',
};

async function registerCommands() {
  const STEM_CHOICES = VALID_STEMS.filter((s) => s !== 'all').map((s) => ({ name: s, value: s }));

  const commands = [
    new SlashCommandBuilder()
      .setName('dl')
      .setDescription('Download a beat from BeatStars, SoundCloud, TrakTrain, or YouTube')
      .addStringOption((opt) =>
        opt.setName('url').setDescription('URL to download').setRequired(true)
      ),
    new SlashCommandBuilder()
      .setName('stems')
      .setDescription('Download a track and split it into stems (requires Demucs on host)')
      .addStringOption((opt) =>
        opt.setName('url').setDescription('URL to download').setRequired(true)
      )
      .addStringOption((opt) =>
        opt
          .setName('stem')
          .setDescription('Which stem to get (default: vocals)')
          .setRequired(false)
          .addChoices(...STEM_CHOICES)
      ),
  ].map((c) => c.toJSON());

  const rest = new REST({ version: '10' }).setToken(TOKEN);
  await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });
  console.log('Slash commands registered.');
}

async function handleDownload(input, replyFn) {
  const trimmed = input.trim();
  const platform = detectPlatform(trimmed);

  if (!platform) {
    await replyFn({ content: `❌ Unsupported URL. Paste a link from BeatStars, SoundCloud, TrakTrain, or YouTube.`, ephemeral: true });
    return;
  }

  const platformName = Object.keys(PLATFORM_LABELS).find((k) => require('./platforms')[k] === platform);
  const label = PLATFORM_LABELS[platformName] || 'Unknown';

  await replyFn({ content: `🔍 Looking up track on **${label}**...` });

  let info;
  try {
    info = await platform.getInfo(trimmed);
  } catch (err) {
    await replyFn({ content: `❌ Failed to fetch track info: ${err.message}` });
    return;
  }

  const bpmSuffix = info.bpm ? ` • ${info.bpm} BPM` : '';
  const displayName = `**${info.artist} - ${info.title}**${bpmSuffix}`;
  await replyFn({ content: `⬇️ Downloading ${displayName} from ${label}...` });

  const filenameBpm = info.bpm ? ` (${info.bpm} BPM)` : '';
  const filename = sanitizeFilename(`${info.artist} - ${info.title}${filenameBpm}.${info.ext}`);
  const tempPath = path.join(os.tmpdir(), `dq-${Date.now()}.${info.ext}`);

  try {
    await platform.downloadTrack(trimmed, tempPath);
  } catch (err) {
    await replyFn({ content: `❌ Download failed: ${err.message}` });
    return;
  }

  const fileSize = fs.statSync(tempPath).size;

  if (fileSize > DISCORD_MAX_BYTES) {
    fs.unlinkSync(tempPath);
    const sizeMB = (fileSize / 1024 / 1024).toFixed(1);
    await replyFn({
      content: `❌ ${displayName} is **${sizeMB} MB** — over Discord's 8 MB limit. Can't attach it here.`,
    });
    return;
  }

  try {
    const attachment = new AttachmentBuilder(tempPath, { name: filename });
    await replyFn({ content: `✅ ${displayName}`, files: [attachment] });
  } finally {
    if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
  }
}

async function handleStems(url, stem, replyFn) {
  const trimmed = url.trim();
  const platform = detectPlatform(trimmed);

  if (!platform) {
    await replyFn({ content: `❌ Unsupported URL. Paste a link from BeatStars, SoundCloud, TrakTrain, or YouTube.`, ephemeral: true });
    return;
  }

  // Check Demucs availability first
  const demucsCheck = await checkDemucs();
  if (!demucsCheck.ok) {
    await replyFn({
      content: `❌ Stem splitting unavailable on this host.\n\`\`\`${demucsCheck.message}\`\`\``,
    });
    return;
  }

  const wantedStem = stem || 'vocals';

  await replyFn({ content: `🔍 Looking up track...` });

  let info;
  try {
    info = await platform.getInfo(trimmed);
  } catch (err) {
    await replyFn({ content: `❌ Failed to fetch track info: ${err.message}` });
    return;
  }

  const bpmSuffix = info.bpm ? ` • ${info.bpm} BPM` : '';
  const displayName = `**${info.artist} - ${info.title}**${bpmSuffix}`;
  await replyFn({ content: `⬇️ Downloading ${displayName}...` });

  const tempAudio = path.join(os.tmpdir(), `dq-${Date.now()}.${info.ext}`);

  try {
    await platform.downloadTrack(trimmed, tempAudio);
  } catch (err) {
    await replyFn({ content: `❌ Download failed: ${err.message}` });
    return;
  }

  await replyFn({ content: `🎛️ Splitting **${wantedStem}** stem from ${displayName}...\n*This may take a few minutes on first run (downloads model ~80MB)*` });

  const tempStemDir = path.join(os.tmpdir(), `dq-stems-${Date.now()}`);

  try {
    const wantedStems = wantedStem === 'all'
      ? ['vocals', 'drums', 'bass', 'other']
      : [wantedStem];

    const stemPaths = await splitStems(tempAudio, tempStemDir, wantedStems);

    const entries = Object.entries(stemPaths);
    const bpmFile = info.bpm ? ` (${info.bpm} BPM)` : '';
    const baseLabel = sanitizeFilename(`${info.artist} - ${info.title}${bpmFile}`);

    // For single stem, send directly
    if (entries.length === 1) {
      const [stemName, stemPath] = entries[0];
      const fileSize = fs.statSync(stemPath).size;
      if (fileSize > DISCORD_MAX_BYTES) {
        const sizeMB = (fileSize / 1024 / 1024).toFixed(1);
        await replyFn({ content: `❌ ${displayName} **[${stemName}]** is **${sizeMB} MB** — over Discord's 8 MB limit.` });
        return;
      }
      const filename = `${baseLabel} [${stemName}].wav`;
      const attachment = new AttachmentBuilder(stemPath, { name: filename });
      await replyFn({ content: `✅ ${displayName} — **${stemName}** stem`, files: [attachment] });

    } else {
      // Multiple stems: send each that fits, warn about oversized ones
      const attachments = [];
      const oversized = [];
      for (const [stemName, stemPath] of entries) {
        const fileSize = fs.statSync(stemPath).size;
        if (fileSize > DISCORD_MAX_BYTES) {
          oversized.push(`${stemName} (${(fileSize / 1024 / 1024).toFixed(1)} MB)`);
        } else {
          attachments.push(new AttachmentBuilder(stemPath, { name: `${baseLabel} [${stemName}].wav` }));
        }
      }
      let content = `✅ ${displayName} — stems`;
      if (oversized.length) content += `\n⚠️ Couldn't attach (over 8 MB): ${oversized.join(', ')}`;

      // Discord allows up to 10 attachments per message
      await replyFn({ content, files: attachments });
    }

  } catch (err) {
    await replyFn({ content: `❌ Stem splitting failed: ${err.message}` });
  } finally {
    if (fs.existsSync(tempAudio)) fs.unlinkSync(tempAudio);
    if (fs.existsSync(tempStemDir)) fs.rmSync(tempStemDir, { recursive: true, force: true });
  }
}

async function main() {
  await registerCommands();

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
  });

  client.once('ready', () => {
    console.log(`Logged in as ${client.user.tag}`);
    console.log('Listening for /dl and links from BeatStars, SoundCloud, TrakTrain, YouTube...');
  });

  // Slash commands
  client.on('interactionCreate', async (interaction) => {
    if (!interaction.isChatInputCommand()) return;

    if (interaction.commandName === 'dl') {
      const input = interaction.options.getString('url');
      await interaction.deferReply();
      await handleDownload(input, async ({ content, files }) => {
        try {
          await interaction.editReply({ content, files: files || [] });
        } catch (err) {
          console.error('editReply failed:', err.message);
        }
      });

    } else if (interaction.commandName === 'stems') {
      const url = interaction.options.getString('url');
      const stem = interaction.options.getString('stem') || 'vocals';
      await interaction.deferReply();
      await handleStems(url, stem, async ({ content, files }) => {
        try {
          await interaction.editReply({ content, files: files || [] });
        } catch (err) {
          console.error('editReply failed:', err.message);
        }
      });
    }
  });

  // Auto-detect supported links in chat
  client.on('messageCreate', async (message) => {
    if (message.author.bot) return;
    // Ignore messages that start with a bot command prefix (e.g. m!, !, ., $, ?)
    if (/^[a-zA-Z0-9]?[!?.$/\\]/.test(message.content.trimStart())) return;
    const urls = message.content.match(SUPPORTED_URL_RE);
    if (!urls) return;

    const toProcess = [...new Set(urls)].slice(0, 3);
    for (const url of toProcess) {
      let replied = false;
      await handleDownload(url, async (payload) => {
        if (!replied) {
          replied = true;
          await message.reply(payload);
        } else {
          await message.channel.send(payload);
        }
      });
    }
  });

  client.login(TOKEN);
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
