const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { PermissionFlagsBits: P, ChannelType: C, OverwriteType, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { embed, isOwner } = require('../util');

const DIR = path.join(__dirname, '..', '..', 'data', 'backups');
fs.mkdirSync(DIR, { recursive: true });
const file = code => path.join(DIR, code.replace(/[^a-z0-9]/gi, '') + '.json');
const load = code => { try { return JSON.parse(fs.readFileSync(file(code), 'utf8')); } catch { return null; } };

function serialize(guild, creatorId) {
  const ow = c => c.permissionOverwrites.cache.filter(o => o.type === OverwriteType.Role)
    .map(o => ({ id: o.id, allow: o.allow.bitfield.toString(), deny: o.deny.bitfield.toString() }));
  return {
    version: 1, guildId: guild.id, name: guild.name, creatorId, createdAt: Date.now(),
    settings: { verificationLevel: guild.verificationLevel, defaultMessageNotifications: guild.defaultMessageNotifications, explicitContentFilter: guild.explicitContentFilter },
    everyone: guild.roles.everyone.permissions.bitfield.toString(),
    roles: guild.roles.cache.filter(r => !r.managed && r.id !== guild.id).sort((a, b) => b.position - a.position)
      .map(r => ({ id: r.id, name: r.name, color: r.color, hoist: r.hoist, mentionable: r.mentionable, permissions: r.permissions.bitfield.toString() })),
    channels: guild.channels.cache.filter(c => !c.isThread()).sort((a, b) => a.rawPosition - b.rawPosition)
      .map(c => ({ id: c.id, name: c.name, type: c.type, parentId: c.parentId, pos: c.rawPosition, topic: c.topic || null, nsfw: !!c.nsfw,
        rateLimit: c.rateLimitPerUser || 0, bitrate: c.bitrate || null, userLimit: c.userLimit || 0, overwrites: ow(c) })),
  };
}

async function mkChannel(guild, c, parentId, roleMap) {
  const base = {
    name: c.name, type: c.type, parent: parentId || undefined,
    permissionOverwrites: c.overwrites.map(o => ({ id: roleMap.get(o.id), allow: BigInt(o.allow), deny: BigInt(o.deny), type: OverwriteType.Role })).filter(o => o.id),
  };
  const textish = [C.GuildText, C.GuildAnnouncement, C.GuildForum].includes(c.type);
  if (textish) Object.assign(base, { topic: c.topic || undefined, nsfw: c.nsfw, rateLimitPerUser: c.rateLimit });
  else if (c.type !== C.GuildCategory) Object.assign(base, { bitrate: Math.min(c.bitrate || 64000, 96000), userLimit: c.userLimit });
  try { return await guild.channels.create(base); }
  catch {
    if (c.type === C.GuildCategory) return null;
    base.type = textish ? C.GuildText : C.GuildVoice;   // fallback when Community features are missing
    return guild.channels.create(base).catch(() => null);
  }
}

async function restore(guild, b, wipe, keepChannelId, progress) {
  const roleMap = new Map([[b.guildId, guild.id]]);
  if (wipe) {
    await progress('🧹 Deleting existing channels and roles…');
    for (const ch of guild.channels.cache.values()) if (ch.id !== keepChannelId) await ch.delete('Backup load').catch(() => {});
    for (const r of guild.roles.cache.values()) if (!r.managed && r.id !== guild.id && r.editable) await r.delete('Backup load').catch(() => {});
  }
  await guild.roles.everyone.setPermissions(BigInt(b.everyone)).catch(() => {});
  await progress(`🎭 Creating ${b.roles.length} roles…`);
  for (const r of b.roles) {   // highest first so order is preserved
    const nr = await guild.roles.create({ name: r.name, color: r.color, hoist: r.hoist, mentionable: r.mentionable, permissions: BigInt(r.permissions), reason: 'Backup load' }).catch(() => null);
    if (nr) roleMap.set(r.id, nr.id);
  }
  const cats = b.channels.filter(c => c.type === C.GuildCategory).sort((a, b) => a.pos - b.pos);
  const rest = b.channels.filter(c => c.type !== C.GuildCategory).sort((a, b) => a.pos - b.pos);
  const catMap = new Map();
  await progress(`📁 Creating ${cats.length} categories and ${rest.length} channels…`);
  for (const c of cats) { const n = await mkChannel(guild, c, null, roleMap); if (n) catMap.set(c.id, n.id); }
  for (const c of rest) await mkChannel(guild, c, c.parentId && catMap.get(c.parentId), roleMap);
  await guild.edit({ name: b.name, ...b.settings, reason: 'Backup load' }).catch(() => {});
}

const commands = [{
  name: 'backup', description: 'Server backup: create, load, add, list, info, delete', perms: P.Administrator,
  options: [
    { name: 'action', type: 'string', description: 'create | load (wipes!) | add (keeps existing) | list | info | delete', required: true, choices: ['create', 'load', 'add', 'list', 'info', 'delete'] },
    { name: 'code', type: 'string', description: 'Backup code' },
  ],
  async run(ctx) {
    const { action, code } = ctx.opts;
    if (action === 'create') {
      await ctx.defer();
      await ctx.guild.channels.fetch(); await ctx.guild.roles.fetch();
      const id = crypto.randomBytes(4).toString('hex');
      const data = serialize(ctx.guild, ctx.user.id);
      fs.writeFileSync(file(id), JSON.stringify(data));
      return ctx.reply({ embeds: [embed(0x57f287).setTitle('✅ Backup created').setDescription(`Code: \`${id}\`\nLoad it anywhere with \`${ctx.prefix}backup load ${id}\`\n**Keep this code private** — anyone with it (and Administrator in their server) can clone this layout.`)
        .addFields({ name: 'Contains', value: `${data.roles.length} roles • ${data.channels.length} channels` })] });
    }
    if (action === 'list') {
      const list = fs.readdirSync(DIR).map(f => ({ code: f.replace('.json', ''), ...JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8')) }))
        .filter(b => b.creatorId === ctx.user.id || isOwner(ctx.user.id));
      return ctx.reply(list.length ? list.map(b => `\`${b.code}\` — **${b.name}** • <t:${Math.floor(b.createdAt / 1000)}:R>`).join('\n').slice(0, 1900) : 'You have no backups.');
    }
    if (!code) return ctx.reply('❌ Provide a backup code.');
    const b = load(code);
    if (!b) return ctx.reply('❌ Backup not found.');
    if (action === 'info') return ctx.reply({ embeds: [embed().setTitle(`Backup of ${b.name}`).addFields(
      { name: 'Roles', value: String(b.roles.length), inline: true }, { name: 'Channels', value: String(b.channels.length), inline: true },
      { name: 'Created', value: `<t:${Math.floor(b.createdAt / 1000)}:R>`, inline: true })] });
    if (action === 'delete') {
      if (b.creatorId !== ctx.user.id && !isOwner(ctx.user.id)) return ctx.reply('❌ Only the creator can delete this backup.');
      fs.unlinkSync(file(code)); return ctx.reply('🗑️ Backup deleted.');
    }
    // load / add
    const wipe = action === 'load';
    const me = ctx.guild.members.me;
    if (!me.permissions.has([P.ManageRoles, P.ManageChannels, P.ManageGuild])) return ctx.reply('❌ I need Manage Roles, Manage Channels and Manage Server.');
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('bk_yes').setLabel(wipe ? 'Wipe & load' : 'Add to server').setStyle(wipe ? ButtonStyle.Danger : ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('bk_no').setLabel('Cancel').setStyle(ButtonStyle.Secondary));
    const msg = await ctx.reply({ content: wipe ? `⚠️ This will **delete all channels and roles** in this server and rebuild them from **${b.name}**. Continue?` : `This will add the roles/channels from **${b.name}** to this server. Continue?`, components: [row] });
    const i = await msg.awaitMessageComponent({ filter: x => x.user.id === ctx.user.id, time: 60000 }).catch(() => null);
    if (!i || i.customId === 'bk_no') return (i ? i.update : msg.edit).call(i || msg, { content: 'Cancelled.', components: [] });
    await i.update({ content: '⏳ Starting…', components: [] });
    await restore(ctx.guild, b, wipe, ctx.channel.id, t => msg.edit(t).catch(() => {}));
    ctx.channel.send('✅ Backup loaded. You can delete this channel if it is a leftover.').catch(() => {});
  },
}];

module.exports = { category: 'Backup', commands };
