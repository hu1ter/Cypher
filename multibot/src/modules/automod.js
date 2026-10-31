const {
  PermissionFlagsBits: P, ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder, RoleSelectMenuBuilder,
  ChannelSelectMenuBuilder, ChannelType, ModalBuilder, TextInputBuilder, TextInputStyle,
} = require('discord.js');
const db = require('../db');
const { embed, parseDuration, formatDuration } = require('../util');
const { sendLog, fmtUser } = require('../audit');

const LINK = /(https?:\/\/|www\.)\S+/i;
const INVITE = /(discord\.gg|discord(?:app)?\.com\/invite)\/\S+/i;
const MAX_TIMEOUT = 28 * 864e5;

// Defaults live here too, so automod keeps working even if db.js is an older version.
const DEFAULT_RULES = {
  spam: { enabled: false, action: 'timeout', duration: 300000, messages: 5, seconds: 5 },
  links: { enabled: false, action: 'delete', duration: 300000 },
  invites: { enabled: false, action: 'delete', duration: 300000 },
  caps: { enabled: false, action: 'delete', duration: 300000, percent: 70, minLength: 10 },
  mentions: { enabled: false, action: 'delete', duration: 300000, max: 5 },
  badwords: { enabled: false, action: 'delete', duration: 300000, words: [] },
};
function getCfg(guildId) {
  const cfg = db.guild(guildId).automod;
  cfg.enabled ??= false;
  if (!Array.isArray(cfg.ignoredRoles)) cfg.ignoredRoles = [];
  if (!Array.isArray(cfg.ignoredChannels)) cfg.ignoredChannels = [];
  if (!cfg.rules || typeof cfg.rules !== 'object') cfg.rules = {};
  for (const [k, def] of Object.entries(DEFAULT_RULES)) {
    cfg.rules[k] = { ...JSON.parse(JSON.stringify(def)), ...cfg.rules[k] };
    if (!Array.isArray(cfg.rules[k].words) && k === 'badwords') cfg.rules[k].words = [];
  }
  return cfg;
}


const RULES = {
  spam: { emoji: '💬', label: 'Spam', desc: 'Too many messages in a short time',
    fields: [{ key: 'messages', label: 'Messages that count as spam', min: 2, max: 20 }, { key: 'seconds', label: 'Within how many seconds', min: 1, max: 60 }],
    sum: r => `${r.messages} messages in ${r.seconds}s` },
  links: { emoji: '🔗', label: 'Links', desc: 'Any http(s):// or www. link', fields: [], sum: () => 'Any link' },
  invites: { emoji: '📨', label: 'Invites', desc: 'Discord server invite links', fields: [], sum: () => 'Discord invites' },
  caps: { emoji: '🔠', label: 'Caps', desc: 'Too many capital letters',
    fields: [{ key: 'percent', label: 'Max % of capital letters', min: 30, max: 100 }, { key: 'minLength', label: 'Minimum message length to check', min: 5, max: 200 }],
    sum: r => `over ${r.percent}% caps (${r.minLength}+ chars)` },
  mentions: { emoji: '📣', label: 'Mass mentions', desc: 'Too many user/role mentions in one message',
    fields: [{ key: 'max', label: 'Max mentions per message', min: 1, max: 50 }], sum: r => `over ${r.max} mentions` },
  badwords: { emoji: '🤬', label: 'Bad words', desc: 'Messages containing blocked words',
    fields: [{ key: 'words', label: 'Blocked words (comma separated)', list: true }], sum: r => `${r.words.length} blocked words` },
};
const ACTIONS = {
  delete: 'Only delete the message', warn: 'Delete + add a warning', timeout: 'Delete + timeout the member',
  kick: 'Delete + kick the member', ban: 'Delete + ban the member',
};
const actionText = r => (r.action === 'timeout' ? `timeout ${formatDuration(r.duration)}` : r.action);

// ---------------------------------------------------------------- menu UI
function render(guild, cfg, page) {
  const e = embed(cfg.enabled ? 0x57f287 : 0xed4245);
  const rows = [];
  const btn = (id, label, style = ButtonStyle.Secondary) => new ButtonBuilder().setCustomId(id).setLabel(label).setStyle(style);

  if (page === 'home') {
    e.setTitle('🤖 Automod settings').setDescription(`Master switch: **${cfg.enabled ? '🟢 ON' : '🔴 OFF'}**\nPick a rule from the dropdown to configure it. Members with **Manage Messages** are always exempt.`);
    for (const [k, d] of Object.entries(RULES)) {
      const r = cfg.rules[k];
      e.addFields({ name: `${d.emoji} ${d.label} — ${r.enabled ? '🟢 ON' : '⚫ OFF'}`, value: `${d.sum(r)} → **${actionText(r)}**` });
    }
    e.addFields({ name: '🛡️ Exemptions', value: `Roles: ${cfg.ignoredRoles.map(i => `<@&${i}>`).join(' ') || 'none'}\nChannels: ${cfg.ignoredChannels.map(i => `<#${i}>`).join(' ') || 'none'}` });
    rows.push(new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId('am_rule').setPlaceholder('Configure a rule…')
      .addOptions(Object.entries(RULES).map(([k, d]) => ({ label: d.label, value: k, description: d.desc, emoji: d.emoji })))));
    rows.push(new ActionRowBuilder().addComponents(
      btn('am_master', cfg.enabled ? 'Turn automod OFF' : 'Turn automod ON', cfg.enabled ? ButtonStyle.Danger : ButtonStyle.Success),
      btn('am_exempt', '🛡️ Exemptions'), btn('am_close', 'Close')));
  } else if (page === 'exempt') {
    e.setTitle('🛡️ Automod exemptions').setDescription('Members with these roles, and messages in these channels, are ignored by automod.\nSelect nothing to clear the list.');
    const roles = cfg.ignoredRoles.filter(i => guild.roles.cache.has(i)), chans = cfg.ignoredChannels.filter(i => guild.channels.cache.has(i));
    const rs = new RoleSelectMenuBuilder().setCustomId('am_roles').setPlaceholder('Exempt roles').setMinValues(0).setMaxValues(10);
    if (roles.length) rs.setDefaultRoles(...roles);
    const cs = new ChannelSelectMenuBuilder().setCustomId('am_chans').setPlaceholder('Exempt channels').setMinValues(0).setMaxValues(10)
      .setChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement, ChannelType.GuildVoice);
    if (chans.length) cs.setDefaultChannels(...chans);
    rows.push(new ActionRowBuilder().addComponents(rs), new ActionRowBuilder().addComponents(cs), new ActionRowBuilder().addComponents(btn('am_back', '← Back')));
  } else {
    const d = RULES[page], r = cfg.rules[page];
    e.setColor(r.enabled ? 0x57f287 : 0x747f8d).setTitle(`${d.emoji} ${d.label}`).setDescription(d.desc).addFields(
      { name: 'Status', value: r.enabled ? '🟢 Enabled' : '⚫ Disabled', inline: true },
      { name: 'Punishment', value: `**${r.action}**`, inline: true },
      { name: 'Timeout length', value: `${formatDuration(r.duration)}${r.action === 'timeout' ? '' : ' (only used for timeout)'}`, inline: true });
    if (d.fields.length) e.addFields({ name: 'Settings', value: d.fields.map(f => `${f.label}: **${f.list ? (r[f.key].length ? r[f.key].join(', ').slice(0, 300) : 'none') : r[f.key]}**`).join('\n') });
    rows.push(new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId('am_action').setPlaceholder('Punishment')
      .addOptions(Object.entries(ACTIONS).map(([k, desc]) => ({ label: k, value: k, description: desc, default: r.action === k })))));
    rows.push(new ActionRowBuilder().addComponents(
      btn('am_toggle', r.enabled ? 'Disable rule' : 'Enable rule', r.enabled ? ButtonStyle.Danger : ButtonStyle.Success),
      btn('am_edit', '✏️ Edit values', ButtonStyle.Primary), btn('am_back', '← Back')));
  }
  return { embeds: [e], components: rows };
}

function buildModal(key, r) {
  const d = RULES[key];
  const m = new ModalBuilder().setCustomId('am_modal').setTitle(`${d.label} settings`);
  const input = (id, label, value, long) => new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId(id).setLabel(label)
    .setStyle(long ? TextInputStyle.Paragraph : TextInputStyle.Short).setValue(String(value).slice(0, 4000)).setRequired(!long).setMaxLength(4000));
  for (const f of d.fields) m.addComponents(input(f.key, f.label, f.list ? r[f.key].join(', ') : r[f.key], f.list));
  m.addComponents(input('duration', 'Timeout length (e.g. 10m, 2h)', formatDuration(r.duration), false));
  return m;
}

function applyModal(key, r, fields) {
  const errors = [], next = {};
  for (const f of RULES[key].fields) {
    const v = fields.getTextInputValue(f.key);
    if (f.list) next[f.key] = [...new Set(v.split(/[,\n]/).map(s => s.trim().toLowerCase()).filter(Boolean))].slice(0, 200);
    else {
      const n = parseInt(v);
      if (isNaN(n) || n < f.min || n > f.max) errors.push(`**${f.label}** must be a number from ${f.min} to ${f.max}.`);
      else next[f.key] = n;
    }
  }
  const dur = parseDuration(fields.getTextInputValue('duration'));
  if (!dur || dur > MAX_TIMEOUT) errors.push('**Timeout length** must be between 1s and 28d (e.g. `10m`).');
  else next.duration = dur;
  if (!errors.length) Object.assign(r, next);
  return errors;
}

const commands = [{
  name: 'automod', aliases: ['am'], description: 'Open the interactive automod settings menu', perms: P.ManageGuild,
  async run(ctx) {
    const cfg = getCfg(ctx.guild.id);
    let page = 'home';
    const view = () => render(ctx.guild, cfg, page);
    const msg = await ctx.reply(view());
    const col = msg.createMessageComponentCollector({ time: 15 * 60000 });
    col.on('collect', async i => {
      try {
        if (i.user.id !== ctx.user.id) return i.reply({ content: '❌ This menu belongs to someone else. Run the command yourself.', flags: 64 });
        const r = RULES[page] && cfg.rules[page];
        switch (i.customId) {
          case 'am_rule': page = i.values[0]; break;
          case 'am_master': cfg.enabled = !cfg.enabled; break;
          case 'am_exempt': page = 'exempt'; break;
          case 'am_back': page = 'home'; break;
          case 'am_close': await i.update({ components: [] }); return col.stop();
          case 'am_toggle': r.enabled = !r.enabled; break;
          case 'am_action': r.action = i.values[0]; break;
          case 'am_roles': cfg.ignoredRoles = i.values; break;
          case 'am_chans': cfg.ignoredChannels = i.values; break;
          case 'am_edit': {
            await i.showModal(buildModal(page, r));
            const m = await i.awaitModalSubmit({ time: 180000, filter: x => x.user.id === i.user.id && x.customId === 'am_modal' }).catch(() => null);
            if (!m) return;
            const errors = applyModal(page, r, m.fields);
            if (errors.length) return m.reply({ content: '❌ ' + errors.join('\n'), flags: 64 });
            db.save();
            return m.update(view());
          }
        }
        db.save();
        await i.update(view());
      } catch (e) { console.error('automod menu:', e.message); }
    });
    col.on('end', () => msg.edit({ components: [] }).catch(() => {}));
  },
}];

// ---------------------------------------------------------------- enforcement
const tracker = new Map();   // "guild:user" -> [{ t, id, ch }]

function findViolation(msg, R) {
  const c = msg.content;
  if (R.invites.enabled && INVITE.test(c)) return ['invites', 'posting invite links'];
  if (R.links.enabled && LINK.test(c)) return ['links', 'posting links'];
  if (R.badwords.enabled && R.badwords.words.some(w => new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(c))) return ['badwords', 'using blocked words'];
  if (R.caps.enabled && c.length >= R.caps.minLength) {
    const letters = c.replace(/[^a-z]/gi, '').length;
    if (letters >= 5 && c.replace(/[^A-Z]/g, '').length / letters * 100 > R.caps.percent) return ['caps', 'excessive caps'];
  }
  if (R.mentions.enabled && msg.mentions.users.size + msg.mentions.roles.size > R.mentions.max) return ['mentions', 'mass mentions'];
  return null;
}

async function enforce(client, msg, key, why, rule, extra) {
  const { guild, member, author } = msg;
  const reason = `Automod: ${why} [mod:${client.user.id}]`;
  if (extra?.length) {
    const byCh = {};
    for (const x of extra) (byCh[x.ch] ||= []).push(x.id);
    for (const [ch, ids] of Object.entries(byCh)) guild.channels.cache.get(ch)?.bulkDelete(ids, true).catch(() => {});
  } else msg.delete().catch(() => {});

  let applied = 'message deleted';
  try {
    if (rule.action === 'warn') {
      (db.guild(guild.id).warnings[author.id] ||= []).push({ reason: `Automod: ${why}`, mod: client.user.id, at: Date.now() });
      db.save(); applied = 'warned';
      author.send(`⚠️ Automod warning in **${guild.name}**: ${why}.`).catch(() => {});
    } else if (rule.action === 'timeout' && member.moderatable) {
      await member.timeout(Math.min(rule.duration, MAX_TIMEOUT), reason); applied = `timed out ${formatDuration(rule.duration)}`;
    } else if (rule.action === 'kick' && member.kickable) {
      await author.send(`You were kicked from **${guild.name}** by automod: ${why}.`).catch(() => {});
      await member.kick(reason); applied = 'kicked';
    } else if (rule.action === 'ban' && member.bannable) {
      await author.send(`You were banned from **${guild.name}** by automod: ${why}.`).catch(() => {});
      await guild.members.ban(author.id, { reason }); applied = 'banned';
    } else if (rule.action !== 'delete') applied += ` (can't ${rule.action} this member)`;
  } catch (e) { applied += ` (punishment failed: ${e.message})`; }

  const note = await msg.channel.send({ content: `🚫 ${author}, no ${why} here. → ${applied}`, allowedMentions: { users: [author.id] } }).catch(() => null);
  if (note) setTimeout(() => note.delete().catch(() => {}), 6000);
  sendLog(guild, 'automod', embed(0xffa500).setTitle(`🤖 Automod: ${RULES[key].label}`).addFields(
    { name: 'User', value: fmtUser(author) }, { name: 'Channel', value: `<#${msg.channelId}>`, inline: true },
    { name: 'Action', value: applied, inline: true }, { name: 'Content', value: (msg.content || '—').slice(0, 1000) }));
}

function init(client) {
  client.on('messageCreate', async msg => {
    if (!msg.guild || msg.author.bot || !msg.member) return;
    const cfg = getCfg(msg.guild.id);
    if (!cfg.enabled || msg.member.permissions.has(P.ManageMessages)) return;
    if (cfg.ignoredChannels.includes(msg.channelId) || (msg.channel.parentId && cfg.ignoredChannels.includes(msg.channel.parentId))) return;
    if (msg.member.roles.cache.some(r => cfg.ignoredRoles.includes(r.id))) return;
    const R = cfg.rules;

    let extra = null, hit = findViolation(msg, R);
    if (R.spam.enabled) {
      const k = `${msg.guild.id}:${msg.author.id}`, now = Date.now();
      const arr = (tracker.get(k) || []).filter(x => now - x.t < R.spam.seconds * 1000);
      arr.push({ t: now, id: msg.id, ch: msg.channelId });
      tracker.set(k, arr);
      if (!hit && arr.length >= R.spam.messages) { hit = ['spam', `spamming (${R.spam.messages}+ messages in ${R.spam.seconds}s)`]; extra = arr; tracker.delete(k); }
    }
    if (hit) enforce(client, msg, hit[0], hit[1], R[hit[0]], extra).catch(e => console.error('automod:', e.message));
  });
  setInterval(() => { const now = Date.now(); for (const [k, v] of tracker) if (!v.length || now - v[v.length - 1].t > 120000) tracker.delete(k); }, 60000);
}

module.exports = { category: 'Automod', commands, init, _test: { render, buildModal, applyModal } };
