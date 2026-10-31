const { PermissionFlagsBits } = require('discord.js');
const db = require('./db');
const { sleep } = require('./util');

const fmtUser = u => (u ? `${u} (\`${u.username}\` • ${u.id})${u.bot ? ' 🤖 bot' : ''}` : 'Unknown');
const logChannelId = (guild, type) => { const l = db.guild(guild.id).logs; return l[type] || l.all; };
const logEnabled = (guild, type) => !!logChannelId(guild, type);

async function sendLog(guild, type, embed) {
  const id = logChannelId(guild, type);
  const ch = id && guild.channels.cache.get(id);
  if (ch) ch.send({ embeds: [embed] }).catch(() => {});
}

/**
 * Finds who performed an action using the audit log.
 * If the bot itself did it on behalf of a moderator (reason has [mod:ID]), that moderator is returned as `user`.
 * `raw` is always the actual Discord executor.
 */
async function getExecutor(guild, type, targetId, opt = {}) {
  const { check, limit = 8, delay = 1000, maxAge = 15000, retries = 0 } = opt;
  if (!guild.members.me?.permissions.has(PermissionFlagsBits.ViewAuditLog)) return null;
  for (let a = 0; a <= retries; a++) {
    await sleep(a === 0 ? delay : 1500);
    const logs = await guild.fetchAuditLogs({ type, limit }).catch(() => null);
    if (!logs) return null;
    const e = logs.entries.find(e =>
      (targetId == null || e.targetId === targetId || e.target?.id === targetId) &&
      Date.now() - e.createdTimestamp < maxAge && (!check || check(e)));
    if (!e) continue;
    let user = e.executor;
    const m = e.reason?.match(/\[mod:(\d+)\]/);
    if (user?.id === guild.client.user.id && m) user = await guild.client.users.fetch(m[1]).catch(() => user);
    return { user, raw: e.executor, reason: e.reason?.replace(/\s*\[mod:\d+\]/, '') || null, entry: e };
  }
  return null;
}

module.exports = { fmtUser, sendLog, logEnabled, getExecutor };
