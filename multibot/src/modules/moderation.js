const { PermissionFlagsBits: P } = require('discord.js');
const db = require('../db');
const { parseDuration, formatDuration, embed, sleep } = require('../util');

const tag = (ctx, reason) => `${reason || 'No reason provided'} [mod:${ctx.user.id}]`;
const user = { name: 'user', type: 'user', description: 'Target user', required: true };
const reason = { name: 'reason', type: 'string', description: 'Reason', rest: true };

const getMember = (ctx, u) => ctx.guild.members.fetch(u.id).catch(() => null);
const dm = (u, text) => u.send(text).catch(() => {});

function hierarchy(ctx, m) {
  if (m.id === ctx.user.id) return "You can't do that to yourself.";
  if (m.id === ctx.guild.ownerId) return "That's the server owner.";
  if (m.id === ctx.client.user.id) return "I can't do that to myself.";
  if (ctx.guild.ownerId !== ctx.user.id && ctx.member.roles.highest.comparePositionTo(m.roles.highest) <= 0)
    return 'Their top role is equal to or higher than yours.';
  if (ctx.guild.members.me.roles.highest.comparePositionTo(m.roles.highest) <= 0)
    return 'Their top role is equal to or higher than mine.';
  return null;
}
function roleCheck(ctx, role) {
  if (role.managed || role.id === ctx.guild.id) return 'That role cannot be assigned manually.';
  if (ctx.guild.ownerId !== ctx.user.id && ctx.member.roles.highest.comparePositionTo(role) <= 0) return 'That role is equal to or higher than your top role.';
  if (ctx.guild.members.me.roles.highest.comparePositionTo(role) <= 0) return 'That role is equal to or higher than my top role.';
  return null;
}

async function bulkRole(ctx, add) {
  const role = ctx.opts.role;
  const err = roleCheck(ctx, role);
  if (err) return ctx.reply('❌ ' + err);
  const filter = ctx.opts.filter || 'all';
  await ctx.defer();
  const members = await ctx.guild.members.fetch();
  const targets = members.filter(m =>
    (filter === 'all' || (filter === 'bots') === m.user.bot) &&
    (add ? !m.roles.cache.has(role.id) : m.roles.cache.has(role.id)) && m.manageable);
  const status = await ctx.reply(`⏳ ${add ? 'Adding' : 'Removing'} **${role.name}** ${add ? 'to' : 'from'} **${targets.size}** members (${filter})… this can take a while.`);
  let ok = 0, fail = 0;
  for (const m of targets.values()) {
    try { await (add ? m.roles.add(role, tag(ctx, 'Bulk role')) : m.roles.remove(role, tag(ctx, 'Bulk role'))); ok++; }
    catch { fail++; }
  }
  const text = `✅ Done. ${ok} updated, ${fail} failed.`;
  status.edit(text).catch(() => ctx.channel.send(text));
}

const commands = [
  { name: 'ban', aliases: ['b'], description: 'Ban a user (works with IDs too)', perms: P.BanMembers, options: [user, reason],
    async run(ctx) {
      const m = await getMember(ctx, ctx.opts.user);
      if (m) { const e = hierarchy(ctx, m); if (e) return ctx.reply('❌ ' + e); }
      await dm(ctx.opts.user, `You were banned from **${ctx.guild.name}**. Reason: ${ctx.opts.reason || 'none'}`);
      await ctx.guild.members.ban(ctx.opts.user.id, { reason: tag(ctx, ctx.opts.reason) });
      ctx.reply(`🔨 Banned **${ctx.opts.user.username}** — ${ctx.opts.reason || 'no reason'}`);
    } },
  { name: 'unban', description: 'Unban a user by ID', perms: P.BanMembers, options: [user, reason],
    async run(ctx) {
      await ctx.guild.members.unban(ctx.opts.user.id, tag(ctx, ctx.opts.reason));
      ctx.reply(`✅ Unbanned **${ctx.opts.user.username}**`);
    } },
  { name: 'kick', aliases: ['k'], description: 'Kick a member', perms: P.KickMembers, options: [user, reason],
    async run(ctx) {
      const m = await getMember(ctx, ctx.opts.user);
      if (!m) return ctx.reply('❌ Member not in this server.');
      const e = hierarchy(ctx, m); if (e) return ctx.reply('❌ ' + e);
      await dm(m.user, `You were kicked from **${ctx.guild.name}**. Reason: ${ctx.opts.reason || 'none'}`);
      await m.kick(tag(ctx, ctx.opts.reason));
      ctx.reply(`👢 Kicked **${m.user.username}**`);
    } },
  { name: 'timeout', aliases: ['mute', 'to'], description: 'Timeout a member (e.g. 10m, 2h, 1d)', perms: P.ModerateMembers,
    options: [user, { name: 'duration', type: 'string', description: 'e.g. 10m, 2h, 1d', required: true }, reason],
    async run(ctx) {
      const ms = parseDuration(ctx.opts.duration);
      if (!ms || ms > 28 * 864e5) return ctx.reply('❌ Duration must be between 1s and 28d (e.g. `10m`, `2h`).');
      const m = await getMember(ctx, ctx.opts.user);
      if (!m) return ctx.reply('❌ Member not in this server.');
      const e = hierarchy(ctx, m); if (e) return ctx.reply('❌ ' + e);
      await m.timeout(ms, tag(ctx, ctx.opts.reason));
      ctx.reply(`🔇 Timed out **${m.user.username}** for ${formatDuration(ms)}`);
    } },
  { name: 'untimeout', aliases: ['unmute'], description: 'Remove a timeout', perms: P.ModerateMembers, options: [user, reason],
    async run(ctx) {
      const m = await getMember(ctx, ctx.opts.user);
      if (!m) return ctx.reply('❌ Member not in this server.');
      await m.timeout(null, tag(ctx, ctx.opts.reason));
      ctx.reply(`🔊 Removed timeout from **${m.user.username}**`);
    } },
  { name: 'warn', description: 'Warn a member', perms: P.ModerateMembers, options: [user, reason],
    async run(ctx) {
      const w = db.guild(ctx.guild.id).warnings;
      (w[ctx.opts.user.id] ||= []).push({ reason: ctx.opts.reason || 'No reason', mod: ctx.user.id, at: Date.now() });
      db.save();
      await dm(ctx.opts.user, `⚠️ You were warned in **${ctx.guild.name}**: ${ctx.opts.reason || 'no reason'}`);
      ctx.reply(`⚠️ Warned **${ctx.opts.user.username}** (total: ${w[ctx.opts.user.id].length})`);
    } },
  { name: 'warnings', aliases: ['warns'], description: "Show a user's warnings", perms: P.ModerateMembers, options: [user],
    async run(ctx) {
      const list = db.guild(ctx.guild.id).warnings[ctx.opts.user.id] || [];
      if (!list.length) return ctx.reply('✅ No warnings.');
      ctx.reply({ embeds: [embed(0xffa500).setTitle(`Warnings for ${ctx.opts.user.username}`)
        .setDescription(list.map((w, i) => `**${i + 1}.** ${w.reason} — <@${w.mod}> <t:${Math.floor(w.at / 1000)}:R>`).join('\n').slice(0, 4000))] });
    } },
  { name: 'clearwarns', description: "Clear a user's warnings", perms: P.ModerateMembers, options: [user],
    async run(ctx) { delete db.guild(ctx.guild.id).warnings[ctx.opts.user.id]; db.save(); ctx.reply('🧹 Warnings cleared.'); } },
  { name: 'purge', aliases: ['clear'], description: 'Delete messages (1-100)', perms: P.ManageMessages,
    options: [{ name: 'amount', type: 'integer', description: '1-100', required: true }],
    async run(ctx) {
      const n = Math.min(Math.max(ctx.opts.amount, 1), 100);
      if (!ctx.isSlash) await ctx.source.delete().catch(() => {});
      const del = await ctx.channel.bulkDelete(n, true);
      const m = await ctx.reply(`🧹 Deleted **${del.size}** messages.`);
      setTimeout(() => m.delete().catch(() => {}), 4000);
    } },
  { name: 'lock', description: 'Lock a channel', perms: P.ManageChannels, options: [{ name: 'channel', type: 'channel', description: 'Channel (default: current)' }],
    async run(ctx) {
      const ch = ctx.opts.channel || ctx.channel;
      await ch.permissionOverwrites.edit(ctx.guild.id, { SendMessages: false }, { reason: tag(ctx, 'Channel locked') });
      ctx.reply(`🔒 Locked ${ch}`);
    } },
  { name: 'unlock', description: 'Unlock a channel', perms: P.ManageChannels, options: [{ name: 'channel', type: 'channel', description: 'Channel (default: current)' }],
    async run(ctx) {
      const ch = ctx.opts.channel || ctx.channel;
      await ch.permissionOverwrites.edit(ctx.guild.id, { SendMessages: null }, { reason: tag(ctx, 'Channel unlocked') });
      ctx.reply(`🔓 Unlocked ${ch}`);
    } },
  { name: 'slowmode', description: 'Set slowmode in seconds (0 = off)', perms: P.ManageChannels,
    options: [{ name: 'seconds', type: 'integer', description: '0-21600', required: true }],
    async run(ctx) {
      await ctx.channel.setRateLimitPerUser(Math.min(Math.max(ctx.opts.seconds, 0), 21600), tag(ctx, 'Slowmode'));
      ctx.reply(`🐢 Slowmode set to ${ctx.opts.seconds}s`);
    } },
  { name: 'nick', description: 'Change a nickname (empty = reset)', perms: P.ManageNicknames,
    options: [user, { name: 'nickname', type: 'string', description: 'New nickname', rest: true }],
    async run(ctx) {
      const m = await getMember(ctx, ctx.opts.user);
      if (!m) return ctx.reply('❌ Member not in this server.');
      const e = hierarchy(ctx, m); if (e && m.id !== ctx.user.id) return ctx.reply('❌ ' + e);
      await m.setNickname(ctx.opts.nickname || null, tag(ctx, 'Nickname changed'));
      ctx.reply(`✏️ Nickname updated for **${m.user.username}**`);
    } },

  // ---------- roles ----------
  { name: 'addrole', aliases: ['role', 'ar'], description: 'Add a role to a member', perms: P.ManageRoles,
    options: [user, { name: 'role', type: 'role', description: 'Role', required: true }],
    async run(ctx) {
      const m = await getMember(ctx, ctx.opts.user);
      if (!m) return ctx.reply('❌ Member not in this server.');
      const e = roleCheck(ctx, ctx.opts.role); if (e) return ctx.reply('❌ ' + e);
      await m.roles.add(ctx.opts.role, tag(ctx, 'Role added'));
      ctx.reply(`✅ Added **${ctx.opts.role.name}** to **${m.user.username}**`);
    } },
  { name: 'removerole', aliases: ['rr'], description: 'Remove a role from a member', perms: P.ManageRoles,
    options: [user, { name: 'role', type: 'role', description: 'Role', required: true }],
    async run(ctx) {
      const m = await getMember(ctx, ctx.opts.user);
      if (!m) return ctx.reply('❌ Member not in this server.');
      const e = roleCheck(ctx, ctx.opts.role); if (e) return ctx.reply('❌ ' + e);
      await m.roles.remove(ctx.opts.role, tag(ctx, 'Role removed'));
      ctx.reply(`✅ Removed **${ctx.opts.role.name}** from **${m.user.username}**`);
    } },
  { name: 'inrole', aliases: ['roleusers'], description: 'List members that have a role', perms: P.ManageRoles,
    options: [{ name: 'role', type: 'role', description: 'Role', required: true }],
    async run(ctx) {
      await ctx.defer();
      await ctx.guild.members.fetch();
      const list = ctx.opts.role.members.map(m => `${m} \`${m.user.username}\``);
      let text = list.join('\n'), shown = list.length;
      while (text.length > 3900) { shown--; text = list.slice(0, shown).join('\n'); }
      ctx.reply({ embeds: [embed(ctx.opts.role.color || 0x5865f2).setTitle(`Members in ${ctx.opts.role.name} (${list.length})`)
        .setDescription(text || 'Nobody.').setFooter({ text: shown < list.length ? `Showing ${shown} of ${list.length}` : ' ' })] });
    } },
  { name: 'addroleall', aliases: ['raall'], description: 'Add a role to everyone (all/humans/bots)', perms: P.ManageRoles,
    options: [{ name: 'role', type: 'role', description: 'Role', required: true }, { name: 'filter', type: 'string', description: 'all, humans or bots', choices: ['all', 'humans', 'bots'] }],
    run: ctx => bulkRole(ctx, true) },
  { name: 'removeroleall', aliases: ['rrall'], description: 'Remove a role from everyone (all/humans/bots)', perms: P.ManageRoles,
    options: [{ name: 'role', type: 'role', description: 'Role', required: true }, { name: 'filter', type: 'string', description: 'all, humans or bots', choices: ['all', 'humans', 'bots'] }],
    run: ctx => bulkRole(ctx, false) },
];

module.exports = { category: 'Moderation', commands };
