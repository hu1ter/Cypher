const { EmbedBuilder } = require('discord.js');

const sleep = ms => new Promise(r => setTimeout(r, ms));
const embed = (color = 0x5865f2) => new EmbedBuilder().setColor(color).setTimestamp();
const owners = () => (process.env.OWNER_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
const isOwner = id => owners().includes(id);

function parseDuration(s) {
  if (!s) return null;
  const u = { s: 1e3, m: 6e4, h: 36e5, d: 864e5, w: 6048e5 };
  const re = /(\d+)\s*(s|m|h|d|w)/gi;
  let ms = 0, m, found = false;
  while ((m = re.exec(s))) { found = true; ms += parseInt(m[1]) * u[m[2].toLowerCase()]; }
  return found ? ms : null;
}

function formatDuration(ms) {
  const parts = [];
  for (const [n, v] of [['d', 864e5], ['h', 36e5], ['m', 6e4], ['s', 1e3]]) {
    if (ms >= v) { parts.push(Math.floor(ms / v) + n); ms %= v; }
  }
  return parts.join(' ') || '0s';
}

async function fetchJson(url) {
  const r = await fetch(url, { headers: { 'User-Agent': 'multibot/1.0' }, signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new Error(`API returned ${r.status}`);
  return r.json();
}

const shuffle = a => { a = [...a]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };

module.exports = { sleep, embed, owners, isOwner, parseDuration, formatDuration, fetchJson, shuffle };
