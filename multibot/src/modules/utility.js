const { PermissionFlagsBits: P, PermissionsBitField, ActionRowBuilder, StringSelectMenuBuilder } = require('discord.js');
const db = require('../db');
const { embed, isOwner } = require('../util');
const { runMenu } = require('../menu');
const { usage } = require('../context');

const ICONS = { Moderation: '🔨', Logging: '📜', Security: '🛡️', Backup: '💾', Automod: '🤖', Giveaways: '🎉', Fun: '🎮', Music: '🎵', Utility: '🧰', Owner: '👑', Automation: '⚙️' };

const commands = [
  { name: 'help', aliases: ['h', 'commands'], description: 'Interactive help menu (or help <command> for details)',
    options: [{ name: 'command', type: 'string', description: 'Command name for details' }],
    async run(ctx) {
      const client = ctx.client, prefix = ctx.prefix;
      const all = [...client.commands.values()].filter(c => !c.ownerOnly || isOwner(ctx.user.id));
      if (ctx.opts.command) {
        let n = ctx.opts.command.toLowerCase();
        if (n.startsWith(prefix)) n = n.slice(prefix.length);
        n = n.replace(/^\//, '');
        const c = client.commands.get(n) || client.commands.get(client.aliases.get(n));
        if (!c || (c.ownerOnly && !isOwner(ctx.user.id))) return ctx.reply(`❌ No command called \`${n}\`.`);
        const e = embed().setTitle(`${ICONS[c.category] || '•'} ${prefix}${c.name}`).setDescription(c.description || 'No description.')
          .addFields({ name: 'Usage', value: `\`${prefix}${c.name} ${usage(c)}\`  •  \`/${c.name}\`` });
        if (c.aliases?.length) e.addFields({ name: 'Aliases', value: c.aliases.map(a => `\`${prefix}${a}\``).join(' ') });
        if (c.options?.length) e.addFields({ name: 'Options', value: c.options.map(o => `${o.required ? `\`<${o.name}>\`` : `\`[${o.name}]\``} — ${o.description || ''}`).join('\n').slice(0, 1000) });
        if (c.perms) e.addFields({ name: 'Permissions needed', value: new PermissionsBitField(c.perms).toArray().join(', ') });
        if (c.ownerOnly) e.addFields({ name: 'Restricted', value: 'Bot owner only' });
        return ctx.reply({ embeds: [e] });
      }
      const cats = {};
      for (const c of all) (cats[c.category] ||= []).push(c);
      let page = 'home';
      const view = () => {
        const e = embed();
        if (page === 'home') {
          e.setTitle('📖 Help menu').setDescription(`Prefix: \`${prefix}\` • slash commands work too.\nPick a category below. For details on one command use \`${prefix}help <command>\`.\n\n` +
            Object.entries(cats).map(([k, v]) => `${ICONS[k] || '•'} **${k}** — ${v.length} commands`).join('\n'));
        } else {
          e.setTitle(`${ICONS[page] || '•'} ${page}`).setDescription(cats[page].map(c => `**${prefix}${c.name}** ${usage(c)}\n┗ ${c.description || ''}`).join('\n').slice(0, 4000));
        }
        const menu = new StringSelectMenuBuilder().setCustomId('help_cat').setPlaceholder('Choose a category…').addOptions(
          { label: 'Overview', value: 'home', emoji: '🏠', default: page === 'home' },
          ...Object.entries(cats).map(([k, v]) => ({ label: k, value: k, description: `${v.length} commands`, emoji: ICONS[k] || undefined, default: page === k })));
        return { embeds: [e], components: [new ActionRowBuilder().addComponents(menu)] };
      };
      await runMenu(ctx, view, async i => { page = i.values[0]; });
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
