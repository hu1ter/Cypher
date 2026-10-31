const { PermissionFlagsBits: P } = require('discord.js');
const db = require('../db');

const spam = new Map();
const FEATURES = ['status', 'enable', 'disable', 'links', 'invites', 'spam', 'caps', 'mentions', 'addword', 'removeword'];
const LINK = /(https?:\/\/|www\.)\S+/i;
const INVITE = /(discord\.gg|discord(?:app)?\.com\/invite)\/\S+/i;

const commands = [{
  name: 'automod', description: 'Configure automod', perms: P.ManageGuild,
  options: [
    { name: 'feature', type: 'string', description: FEATURES.join(', '), required: true, choices: FEATURES },
    { name: 'value', type: 'string', description: 'on/off, a number (mentions) or a word' },
  ],
  run(ctx) {
    const cfg = db.guild(ctx.guild.id).automod, { feature, value } = ctx.opts;
    const flag = v => ['on', 'true', 'yes', 'enable'].includes((v || 'on').toLowerCase());
    const done = m => { db.save(); return ctx.reply(m); };
    switch (feature) {
      case 'enable': cfg.enabled = true; return done('🤖 Automod **enabled**.');
      case 'disable': cfg.enabled = false; return done('🤖 Automod **disabled**.');
      case 'links': case 'invites': case 'spam': case 'caps': cfg[feature] = flag(value); return done(`✅ **${feature}** filter: ${cfg[feature] ? 'on' : 'off'}`);
      case 'mentions': cfg.mentions = Math.max(0, parseInt(value) || 0); return done(`✅ Max mentions per message: ${cfg.mentions || 'unlimited'}`);
      case 'addword': if (!value) return ctx.reply('❌ Provide a word.'); cfg.badwords.push(value.toLowerCase()); return done('✅ Word added.');
      case 'removeword': cfg.badwords = cfg.badwords.filter(w => w !== (value || '').toLowerCase()); return done('✅ Word removed.');
      default: return ctx.reply(`**Automod** — ${cfg.enabled ? '🟢 on' : '🔴 off'}\nLinks: ${cfg.links} • Invites: ${cfg.invites} • Spam: ${cfg.spam} • Caps: ${cfg.caps} • Max mentions: ${cfg.mentions || 'off'}\nBad words: ${cfg.badwords.length}\nMembers with **Manage Messages** are exempt.`);
    }
  },
}];

function init(client) {
  client.on('messageCreate', async msg => {
    if (!msg.guild || msg.author.bot || !msg.member) return;
    const cfg = db.guild(msg.guild.id).automod;
    if (!cfg.enabled || msg.member.permissions.has(P.ManageMessages)) return;
    const c = msg.content;
    let why = null;
    if (cfg.invites && INVITE.test(c)) why = 'invite links';
    else if (cfg.links && LINK.test(c)) why = 'links';
    else if (cfg.badwords.length && cfg.badwords.some(w => new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(c))) why = 'blocked words';
    else if (cfg.caps && c.length >= 10 && c.replace(/[^a-z]/gi, '').length >= 8 && c.replace(/[^A-Z]/g, '').length / c.replace(/[^a-z]/gi, '').length > 0.7) why = 'excessive caps';
    else if (cfg.mentions && msg.mentions.users.size + msg.mentions.roles.size > cfg.mentions) why = 'mass mentions';
    let timeout = false;
    if (!why && cfg.spam) {
      const k = `${msg.guild.id}:${msg.author.id}`, now = Date.now();
      const arr = (spam.get(k) || []).filter(t => now - t < 5000); arr.push(now); spam.set(k, arr);
      if (arr.length >= 5) { why = 'spamming'; timeout = true; spam.delete(k); }
    }
    if (!why) return;
    msg.delete().catch(() => {});
    const note = await msg.channel.send(`🚫 ${msg.author}, no ${why} here.`).catch(() => null);
    if (note) setTimeout(() => note.delete().catch(() => {}), 5000);
    if (timeout) msg.member.timeout(5 * 60000, 'Automod: spam [mod:' + client.user.id + ']').catch(() => {});
  });
}

module.exports = { category: 'Automod', commands, init };
