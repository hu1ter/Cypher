const { AuditLogEvent: A, PermissionFlagsBits: P, ChannelType, ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder, UserSelectMenuBuilder } = require('discord.js');
const { runMenu, askModal } = require('../menu');
const db = require('../db');
const { embed, isOwner } = require('../util');
const { getExecutor, sendLog, fmtUser } = require('../audit');

const DANGEROUS = [P.Administrator, P.ManageGuild, P.ManageRoles, P.ManageChannels, P.BanMembers, P.KickMembers, P.ManageWebhooks, P.MentionEveryone];
const hits = new Map();       // "guild:user:action" -> timestamps
const punished = new Map();   // "guild:user" -> expiry

function record(key, windowMs) {
  const now = Date.now();
  const arr = (hits.get(key) || []).filter(t => now - t < windowMs);
  arr.push(now); hits.set(key, arr);
  return arr.length;
}
const isExempt = (g, id, cfg) => id === g.ownerId || id === g.client.user.id || isOwner(id) || cfg.whitelist.includes(id);

async function punish(guild, uid, why) {
  const key = `${guild.id}:${uid}`;
  if ((punished.get(key) || 0) > Date.now()) return;
  punished.set(key, Date.now() + 60000);
  const cfg = db.guild(guild.id).antinuke;
  const m = await guild.members.fetch(uid).catch(() => null);
  let result = '✅ Punished';
  try {
    if (cfg.punishment === 'ban') await guild.members.ban(uid, { reason: why });
    else if (cfg.punishment === 'kick') await m?.kick(why);
    else if (m) await m.roles.remove(m.roles.cache.filter(r => r.id !== guild.id && !r.managed && r.editable), why);
  } catch (e) { result = `⚠️ Could not punish (${e.message}) — check my role position`; }
  const e = embed(0xed4245).setTitle('🛡️ Anti-nuke triggered').setDescription(why)
    .addFields({ name: 'User', value: fmtUser(m?.user || { id: uid, toString: () => `<@${uid}>`, username: 'unknown' }) }, { name: 'Action', value: `${cfg.punishment} — ${result}` });
  sendLog(guild, 'antinuke', e);
  guild.fetchOwner().then(o => o.send({ embeds: [e.setFooter({ text: guild.name })] })).catch(() => {});
}

/** Returns null if antinuke is off / actor is trusted. Otherwise { user, count, tripped, entry } */
async function detect(guild, type, targetId, action, { check, instant } = {}) {
  const cfg = db.guild(guild.id).antinuke;
  if (!cfg.enabled) return null;
  const ex = await getExecutor(guild, type, targetId, { check, limit: 20, delay: 700, retries: 1 });
  if (!ex?.raw || isExempt(guild, ex.raw.id, cfg)) return null;
  const uid = ex.raw.id;
  const count = instant ? cfg.limit : record(`${guild.id}:${uid}:${action}`, cfg.window * 1000);
  const tripped = count >= cfg.limit || (punished.get(`${guild.id}:${uid}`) || 0) > Date.now();
  if (count >= cfg.limit) await punish(guild, uid, `Anti-nuke: **${action}** ×${count} within ${cfg.window}s`);
  return { user: ex.raw, count, tripped, entry: ex.entry };
}

const overwrites = c => c.permissionOverwrites?.cache.map(o => ({ id: o.id, type: o.type, allow: o.allow, deny: o.deny })) || [];

function init(client) {
  client.on('channelDelete', async ch => {
    if (!ch.guild || ch.isThread?.()) return;
    if (!(await detect(ch.guild, A.ChannelDelete, ch.id, 'channelDelete'))) return;
    const parent = ch.parentId && ch.guild.channels.cache.get(ch.parentId);
    ch.guild.channels.create({
      name: ch.name, type: ch.type, parent: parent || undefined, topic: ch.topic || undefined, nsfw: ch.nsfw,
      rateLimitPerUser: ch.rateLimitPerUser, bitrate: ch.bitrate, userLimit: ch.userLimit,
      permissionOverwrites: overwrites(ch), reason: 'Anti-nuke: restoring deleted channel',
    }).catch(() => {});
  });

  client.on('channelCreate', async ch => {
    if (!ch.guild) return;
    const r = await detect(ch.guild, A.ChannelCreate, ch.id, 'channelCreate');
    if (r?.tripped) ch.delete('Anti-nuke: mass channel creation').catch(() => {});
  });

  client.on('roleDelete', async role => {
    if (!(await detect(role.guild, A.RoleDelete, role.id, 'roleDelete'))) return;
    role.guild.roles.create({ name: role.name, color: role.color, hoist: role.hoist, mentionable: role.mentionable, permissions: role.permissions, position: role.position, reason: 'Anti-nuke: restoring deleted role' }).catch(() => {});
  });

  client.on('roleCreate', async role => {
    const r = await detect(role.guild, A.RoleCreate, role.id, 'roleCreate');
    if (r?.tripped) role.delete('Anti-nuke: mass role creation').catch(() => {});
  });

  client.on('roleUpdate', async (o, n) => {
    if (!DANGEROUS.some(p => !o.permissions.has(p) && n.permissions.has(p))) return;
    if (await detect(n.guild, A.RoleUpdate, n.id, 'dangerousRolePerms')) n.setPermissions(o.permissions, 'Anti-nuke: reverting dangerous permissions').catch(() => {});
  });

  client.on('guildMemberUpdate', async (o, n) => {
    if (o.partial) return;
    const bad = n.roles.cache.filter(r => !o.roles.cache.has(r.id) && DANGEROUS.some(p => r.permissions.has(p)));
    for (const role of bad.values()) {
      const r = await detect(n.guild, A.MemberRoleUpdate, n.id, 'dangerousRoleGrant', { check: e => e.changes.some(c => c.key === '$add' && c.new?.some(x => x.id === role.id)) });
      if (r) n.roles.remove(role, 'Anti-nuke: dangerous role granted by untrusted user').catch(() => {});
    }
  });

  client.on('guildBanAdd', ban => detect(ban.guild, A.MemberBanAdd, ban.user.id, 'ban'));
  client.on('guildMemberRemove', m => detect(m.guild, A.MemberKick, m.id, 'kick', { check: e => Date.now() - e.createdTimestamp < 8000 }));

  client.on('guildMemberAdd', async m => {
    if (!m.user.bot) return;
    const r = await detect(m.guild, A.BotAdd, m.id, 'botAdd', { instant: true });
    if (r) m.kick('Anti-nuke: bot added by untrusted user').catch(() => {});
  });

  client.on('webhooksUpdate', async ch => {
    if (!ch.guild) return;
    const r = await detect(ch.guild, A.WebhookCreate, null, 'webhookCreate');
    if (r?.entry?.target?.id) (await ch.fetchWebhooks().catch(() => null))?.get(r.entry.target.id)?.delete('Anti-nuke').catch(() => {});
  });
}


async function anMenu(ctx) {
  const cfg = db.guild(ctx.guild.id).antinuke;
  const view = () => {
    const e = embed(cfg.enabled ? 0x57f287 : 0xed4245).setTitle('🛡️ Anti-nuke').addFields(
      { name: 'Status', value: cfg.enabled ? '🟢 Enabled' : '🔴 Disabled', inline: true },
      { name: 'Punishment', value: `**${cfg.punishment}**`, inline: true },
      { name: 'Trigger', value: `${cfg.limit} actions in ${cfg.window}s`, inline: true },
      { name: 'Whitelist (trusted users)', value: cfg.whitelist.map(i => `<@${i}>`).join(' ') || 'Nobody — the server owner and bot owners are always trusted' },
      { name: 'Protects against', value: 'Channel/role deletion (auto-restored) • mass channel/role creation • mass bans/kicks • dangerous permission grants • unauthorised bot adds • webhook creation' });
    const wl = new UserSelectMenuBuilder().setCustomId('an_wl').setPlaceholder('Whitelisted (trusted) users').setMinValues(0).setMaxValues(25);
    if (cfg.whitelist.length) wl.setDefaultUsers(...cfg.whitelist.slice(0, 25));
    const pun = new StringSelectMenuBuilder().setCustomId('an_pun').setPlaceholder('Punishment').addOptions(
      { label: 'ban', value: 'ban', description: 'Ban the offender', default: cfg.punishment === 'ban' },
      { label: 'kick', value: 'kick', description: 'Kick the offender', default: cfg.punishment === 'kick' },
      { label: 'strip', value: 'strip', description: 'Remove all their roles', default: cfg.punishment === 'strip' });
    const b = (id, label, style = ButtonStyle.Secondary) => new ButtonBuilder().setCustomId(id).setLabel(label).setStyle(style);
    return { embeds: [e], components: [new ActionRowBuilder().addComponents(wl), new ActionRowBuilder().addComponents(pun),
      new ActionRowBuilder().addComponents(b('an_toggle', cfg.enabled ? 'Disable anti-nuke' : 'Enable anti-nuke', cfg.enabled ? ButtonStyle.Danger : ButtonStyle.Success), b('an_limit', '✏️ Edit trigger'), b('an_close', 'Close'))] };
  };
  await runMenu(ctx, view, async (i, col) => {
    switch (i.customId) {
      case 'an_wl': cfg.whitelist = i.values; break;
      case 'an_pun': cfg.punishment = i.values[0]; break;
      case 'an_toggle': cfg.enabled = !cfg.enabled; break;
      case 'an_close': await i.update({ components: [] }); col.stop(); return 'handled';
      case 'an_limit': {
        const m = await askModal(i, 'Anti-nuke trigger', [
          { id: 'limit', label: 'Actions allowed before punishment (1-20)', value: cfg.limit }, { id: 'window', label: 'Within how many seconds (3-60)', value: cfg.window }]);
        if (!m) return 'handled';
        const l = parseInt(m.fields.getTextInputValue('limit')), w = parseInt(m.fields.getTextInputValue('window'));
        if (!(l >= 1 && l <= 20 && w >= 3 && w <= 60)) { await m.reply({ content: '❌ Limit must be 1-20 and seconds 3-60.', flags: 64 }); return 'handled'; }
        cfg.limit = l; cfg.window = w; db.save();
        await m.update(view()); return 'handled';
      }
    }
    db.save();
  });
}

const commands = [{
  name: 'antinuke', aliases: ['an'], description: 'Anti-nuke: enable, disable, status, whitelist, unwhitelist, punishment, limit', guildOwnerOnly: true,
  options: [
    { name: 'action', type: 'string', description: 'What to do (leave empty for the menu)', choices: ['enable', 'disable', 'status', 'whitelist', 'unwhitelist', 'punishment', 'limit'] },
    { name: 'user', type: 'user', description: 'User (for whitelist / unwhitelist)' },
    { name: 'value', type: 'string', description: 'ban|kick|strip (punishment) or number (limit)' },
  ],
  run(ctx) {
    const cfg = db.guild(ctx.guild.id).antinuke, { action, user, value } = ctx.opts;
    if (!action) return anMenu(ctx);
    const done = msg => { db.save(); return ctx.reply(msg); };
    switch (action) {
      case 'enable': cfg.enabled = true; return done('🛡️ Anti-nuke **enabled**. Keep my role **above** other roles so I can punish and restore.');
      case 'disable': cfg.enabled = false; return done('Anti-nuke **disabled**.');
      case 'whitelist':
        if (!user) return ctx.reply('❌ Provide a user.');
        if (!cfg.whitelist.includes(user.id)) cfg.whitelist.push(user.id);
        return done(`✅ Whitelisted **${user.username}**`);
      case 'unwhitelist':
        if (!user) return ctx.reply('❌ Provide a user.');
        cfg.whitelist = cfg.whitelist.filter(i => i !== user.id);
        return done(`✅ Removed **${user.username}** from whitelist`);
      case 'punishment':
        if (!['ban', 'kick', 'strip'].includes(value)) return ctx.reply('❌ Use `ban`, `kick` or `strip` (removes roles).');
        cfg.punishment = value; return done(`✅ Punishment: **${value}**`);
      case 'limit': {
        const n = parseInt(value);
        if (!n || n < 1 || n > 20) return ctx.reply('❌ Limit must be 1-20 actions (per 10s window).');
        cfg.limit = n; return done(`✅ Limit: **${n}** actions / ${cfg.window}s`);
      }
      default:
        return ctx.reply({ embeds: [embed(cfg.enabled ? 0x57f287 : 0xed4245).setTitle('🛡️ Anti-nuke status').addFields(
          { name: 'Enabled', value: cfg.enabled ? 'Yes' : 'No', inline: true },
          { name: 'Punishment', value: cfg.punishment, inline: true },
          { name: 'Limit', value: `${cfg.limit} / ${cfg.window}s`, inline: true },
          { name: 'Whitelist', value: cfg.whitelist.map(i => `<@${i}>`).join(' ') || 'None (server owner & bot owners are always trusted)' },
          { name: 'Protects against', value: 'Channel/role deletion (auto-restored) • mass channel/role creation • mass bans/kicks • dangerous permission grants • unauthorised bot adds • webhook creation' })] });
    }
  },
}];

module.exports = { category: 'Security', commands, init };
