const { PermissionFlagsBits: P } = require('discord.js');
const db = require('../db');
const { embed } = require('../util');

const commands = [
  { name: 'help', description: 'Show all commands',
    run(ctx) {
      const cats = {};
      for (const c of ctx.client.commands.values()) (cats[c.category] ||= []).push(c.name);
      const e = embed().setTitle('📖 Commands').setDescription(`Prefix: \`${ctx.prefix}\` • slash commands work too.\nUse \`${ctx.prefix}<command>\` with no arguments to see its usage.`);
      for (const [k, v] of Object.entries(cats)) e.addFields({ name: k, value: v.map(n => `\`${n}\``).join(' ').slice(0, 1024) });
      ctx.reply({ embeds: [e] });
    } },
  { name: 'ping', description: 'Bot latency', run: ctx => ctx.reply(`🏓 ${ctx.client.ws.ping}ms`) },
  { name: 'prefix', description: 'Change the server prefix', perms: P.ManageGuild,
    options: [{ name: 'prefix', type: 'string', description: 'New prefix (max 5 chars)', required: true }],
    run(ctx) {
      if (ctx.opts.prefix.length > 5) return ctx.reply('❌ Max 5 characters.');
      db.guild(ctx.guild.id).prefix = ctx.opts.prefix; db.save(); ctx.reply(`✅ Prefix is now \`${ctx.opts.prefix}\``);
    } },
  { name: 'avatar', aliases: ['av'], description: "Show a user's avatar", options: [{ name: 'user', type: 'user', description: 'User' }],
    run(ctx) { const u = ctx.opts.user || ctx.user; ctx.reply({ embeds: [embed().setTitle(u.username).setImage(u.displayAvatarURL({ size: 1024 }))] }); } },
  { name: 'userinfo', aliases: ['ui'], description: 'Info about a user', options: [{ name: 'user', type: 'user', description: 'User' }],
    async run(ctx) {
      const u = ctx.opts.user || ctx.user, m = await ctx.guild.members.fetch(u.id).catch(() => null);
      ctx.reply({ embeds: [embed().setTitle(u.username).setThumbnail(u.displayAvatarURL()).addFields(
        { name: 'ID', value: u.id, inline: true },
        { name: 'Created', value: `<t:${Math.floor(u.createdTimestamp / 1000)}:R>`, inline: true },
        ...(m ? [{ name: 'Joined', value: `<t:${Math.floor(m.joinedTimestamp / 1000)}:R>`, inline: true },
          { name: 'Roles', value: m.roles.cache.filter(r => r.id !== ctx.guild.id).map(r => r.toString()).join(' ').slice(0, 1024) || 'None' }] : []))] });
    } },
  { name: 'serverinfo', aliases: ['si'], description: 'Info about this server',
    async run(ctx) {
      const g = ctx.guild;
      ctx.reply({ embeds: [embed().setTitle(g.name).setThumbnail(g.iconURL()).addFields(
        { name: 'Owner', value: `<@${g.ownerId}>`, inline: true }, { name: 'Members', value: String(g.memberCount), inline: true },
        { name: 'Channels', value: String(g.channels.cache.size), inline: true }, { name: 'Roles', value: String(g.roles.cache.size), inline: true },
        { name: 'Boosts', value: String(g.premiumSubscriptionCount || 0), inline: true }, { name: 'Created', value: `<t:${Math.floor(g.createdTimestamp / 1000)}:R>`, inline: true })] });
    } },
];

module.exports = { category: 'Utility', commands };
