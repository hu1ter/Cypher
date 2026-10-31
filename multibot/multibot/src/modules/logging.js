const {
  AuditLogEvent: A, PermissionFlagsBits: P, ActionRowBuilder, ButtonBuilder, ButtonStyle,
  StringSelectMenuBuilder, ChannelSelectMenuBuilder, ChannelType,
} = require('discord.js');
const db = require('../db');
const { embed } = require('../util');
const { getExecutor, sendLog, logEnabled, fmtUser } = require('../audit');

const LOGS = {
  message: { emoji: '💬', label: 'Message logs', desc: 'Edited and deleted messages' },
  mod: { emoji: '🔨', label: 'Mod logs', desc: 'Bans, kicks, timeouts, unbans' },
  automod: { emoji: '🤖', label: 'Automod logs', desc: 'Everything automod catches and punishes' },
  roles: { emoji: '🎭', label: 'Role logs', desc: 'Member role changes + role create/delete/edit' },
  voice: { emoji: '🔊', label: 'Voice logs', desc: 'Joins, leaves and moves in voice channels' },
  member: { emoji: '👤', label: 'Member logs', desc: 'Joins, leaves, nickname changes' },
  channel: { emoji: '📁', label: 'Channel logs', desc: 'Channel create/delete/edit' },
  server: { emoji: '🏠', label: 'Server logs', desc: 'Server name, icon and setting changes' },
  antinuke: { emoji: '🛡️', label: 'Anti-nuke logs', desc: 'Anti-nuke triggers and punishments' },
  all: { emoji: '📥', label: 'Default', desc: 'Used for any log type that has no channel of its own' },
};
const TYPES = Object.keys(LOGS);

async function log(guild, type, { title, color = 0x5865f2, desc, fields = [], ex }) {
  const e = embed(color).setTitle(title);
  if (desc) e.setDescription(String(desc).slice(0, 4000));
  if (fields.length) e.addFields(fields.map(f => ({ name: f[0], value: String(f[1] || '—').slice(0, 1024), inline: f[2] ?? false })));
  if (ex !== undefined) e.addFields({ name: 'Executed by', value: ex?.user ? fmtUser(ex.user) : 'Unknown (self action or no audit entry)' });
  if (ex?.reason) e.addFields({ name: 'Reason', value: ex.reason.slice(0, 1024) });
  sendLog(guild, type, e);
}

const validCh = (guild, id) => id && guild.channels.cache.has(id);

function render(guild, logs, page) {
  const e = embed(0x5865f2);
  const rows = [];
  const btn = (id, label, style = ButtonStyle.Secondary, disabled = false) => new ButtonBuilder().setCustomId(id).setLabel(label).setStyle(style).setDisabled(disabled);
  if (page === 'home') {
    const fallback = validCh(guild, logs.all) ? logs.all : null;
    e.setTitle('📜 Log settings').setDescription(
      'Choose where each kind of log goes. Types without a channel use **Default** if you set one.\n\n' +
      Object.entries(LOGS).map(([k, d]) => {
        const own = validCh(guild, logs[k]) ? `<#${logs[k]}>` : (k !== 'all' && fallback ? `*default* → <#${fallback}>` : '*not set*');
        return `${d.emoji} **${d.label}** — ${own}\n┗ ${d.desc}`;
      }).join('\n'));
    rows.push(new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId('lg_type').setPlaceholder('Choose a log type to configure…')
      .addOptions(Object.entries(LOGS).map(([k, d]) => ({ label: d.label, value: k, description: d.desc, emoji: d.emoji })))));
    rows.push(new ActionRowBuilder().addComponents(btn('lg_auto', '⚡ Auto-create all log channels', ButtonStyle.Primary), btn('lg_close', 'Close')));
  } else {
    const d = LOGS[page], cur = validCh(guild, logs[page]) ? logs[page] : null;
    e.setTitle(`${d.emoji} ${d.label}`).setDescription(`${d.desc}\n\nCurrent channel: ${cur ? `<#${cur}>` : '*not set*'}`);
    const cs = new ChannelSelectMenuBuilder().setCustomId('lg_chan').setPlaceholder('Pick a channel for these logs')
      .setChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement).setMinValues(1).setMaxValues(1);
    if (cur) cs.setDefaultChannels(cur);
    rows.push(new ActionRowBuilder().addComponents(cs));
    rows.push(new ActionRowBuilder().addComponents(btn('lg_create', '➕ Create a channel for me', ButtonStyle.Success), btn('lg_remove', 'Remove', ButtonStyle.Danger, !cur), btn('lg_back', '← Back')));
  }
  return { embeds: [e], components: rows };
}

const privateOverwrites = guild => [
  { id: guild.id, deny: [P.ViewChannel] },
  { id: guild.members.me.id, allow: [P.ViewChannel, P.SendMessages, P.EmbedLinks] },
];
const chName = t => `${t === 'all' ? 'bot' : t}-logs`;

async function autoSetup(guild, logs) {
  const cat = await guild.channels.create({ name: '📜 Logs', type: ChannelType.GuildCategory, permissionOverwrites: privateOverwrites(guild), reason: 'Log auto-setup' });
  for (const t of TYPES) {
    if (t === 'all' || validCh(guild, logs[t])) continue;
    const ch = await guild.channels.create({ name: chName(t), type: ChannelType.GuildText, parent: cat.id, reason: 'Log auto-setup' });
    logs[t] = ch.id;
  }
}

const commands = [
  { name: 'logs', aliases: ['logmenu', 'logsettings'], description: 'Open the interactive log settings menu', perms: P.ManageGuild,
    async run(ctx) {
      const logs = db.guild(ctx.guild.id).logs;
      let page = 'home';
      const view = () => render(ctx.guild, logs, page);
      const msg = await ctx.reply(view());
      const col = msg.createMessageComponentCollector({ time: 15 * 60000 });
      col.on('collect', async i => {
        try {
          if (i.user.id !== ctx.user.id) return i.reply({ content: '❌ This menu belongs to someone else. Run the command yourself.', flags: 64 });
          switch (i.customId) {
            case 'lg_type': page = i.values[0]; break;
            case 'lg_back': page = 'home'; break;
            case 'lg_chan': logs[page] = i.values[0]; break;
            case 'lg_remove': delete logs[page]; break;
            case 'lg_close': await i.update({ components: [] }); return col.stop();
            case 'lg_create': {
              try {
                const ch = await ctx.guild.channels.create({ name: chName(page), type: ChannelType.GuildText, permissionOverwrites: privateOverwrites(ctx.guild), reason: 'Log channel' });
                logs[page] = ch.id;
              } catch (e) { return i.reply({ content: `❌ Couldn't create the channel: ${e.message} (I need Manage Channels)`, flags: 64 }); }
              break;
            }
            case 'lg_auto': {
              await i.deferUpdate();
              try { await autoSetup(ctx.guild, logs); }
              catch (e) { i.followUp({ content: `❌ Auto-setup stopped: ${e.message} (I need Manage Channels)`, flags: 64 }).catch(() => {}); }
              db.save();
              return i.editReply(view());
            }
          }
          db.save();
          await i.update(view());
        } catch (e) { console.error('logs menu:', e.message); }
      });
      col.on('end', () => msg.edit({ components: [] }).catch(() => {}));
    } },
  { name: 'setlog', description: `Quickly set a log channel (${TYPES.join(', ')})`, perms: P.ManageGuild,
    options: [{ name: 'type', type: 'string', description: TYPES.join(', '), required: true, choices: TYPES }, { name: 'channel', type: 'channel', description: 'Log channel', required: true }],
    run(ctx) {
      db.guild(ctx.guild.id).logs[ctx.opts.type] = ctx.opts.channel.id; db.save();
      ctx.reply(`✅ **${ctx.opts.type}** logs → ${ctx.opts.channel}`);
    } },
  { name: 'removelog', description: 'Disable a log type', perms: P.ManageGuild,
    options: [{ name: 'type', type: 'string', description: 'Log type', required: true, choices: TYPES }],
    run(ctx) { delete db.guild(ctx.guild.id).logs[ctx.opts.type]; db.save(); ctx.reply(`🗑️ Removed **${ctx.opts.type}** log.`); } },
];

function init(client) {
  client.on('guildMemberUpdate', async (o, n) => {
    if (o.partial) return;
    const g = n.guild;
    const added = n.roles.cache.filter(r => !o.roles.cache.has(r.id));
    const removed = o.roles.cache.filter(r => !n.roles.cache.has(r.id));
    if ((added.size || removed.size) && logEnabled(g, 'roles')) {
      const ex = await getExecutor(g, A.MemberRoleUpdate, n.id);
      log(g, 'roles', { title: 'Member roles updated', color: added.size ? 0x57f287 : 0xed4245, ex,
        fields: [['Member', fmtUser(n.user)], ...(added.size ? [['➕ Added', added.map(r => r.toString()).join(' ')]] : []), ...(removed.size ? [['➖ Removed', removed.map(r => r.toString()).join(' ')]] : [])] });
    }
    if (o.nickname !== n.nickname && logEnabled(g, 'member')) {
      const ex = await getExecutor(g, A.MemberUpdate, n.id, { check: e => e.changes.some(c => c.key === 'nick') });
      log(g, 'member', { title: 'Nickname changed', color: 0xfee75c, ex,
        fields: [['Member', fmtUser(n.user)], ['Before', o.nickname || '*none*', true], ['After', n.nickname || '*none*', true]] });
    }
    if (o.communicationDisabledUntilTimestamp !== n.communicationDisabledUntilTimestamp && logEnabled(g, 'mod')) {
      const ex = await getExecutor(g, A.MemberUpdate, n.id, { check: e => e.changes.some(c => c.key === 'communication_disabled_until') });
      const until = n.communicationDisabledUntilTimestamp;
      log(g, 'mod', { title: until && until > Date.now() ? 'Member timed out' : 'Timeout removed', color: 0xffa500, ex,
        fields: [['Member', fmtUser(n.user)], ...(until && until > Date.now() ? [['Until', `<t:${Math.floor(until / 1000)}:f>`]] : [])] });
    }
  });

  client.on('guildMemberAdd', m => {
    if (!logEnabled(m.guild, 'member')) return;
    log(m.guild, 'member', { title: 'Member joined', color: 0x57f287, fields: [['Member', fmtUser(m.user)], ['Account created', `<t:${Math.floor(m.user.createdTimestamp / 1000)}:R>`]] });
  });

  client.on('guildMemberRemove', async m => {
    if (!logEnabled(m.guild, 'member') && !logEnabled(m.guild, 'mod')) return;
    const ex = await getExecutor(m.guild, A.MemberKick, m.id, { maxAge: 8000 });
    if (ex) log(m.guild, 'mod', { title: 'Member kicked', color: 0xed4245, ex, fields: [['Member', fmtUser(m.user)]] });
    else log(m.guild, 'member', { title: 'Member left', color: 0xed4245, fields: [['Member', fmtUser(m.user)], ['Roles', m.roles?.cache.filter(r => r.id !== m.guild.id).map(r => r.toString()).join(' ')]] });
  });

  client.on('guildBanAdd', async b => {
    if (!logEnabled(b.guild, 'mod')) return;
    log(b.guild, 'mod', { title: 'Member banned', color: 0xed4245, ex: await getExecutor(b.guild, A.MemberBanAdd, b.user.id), fields: [['User', fmtUser(b.user)]] });
  });
  client.on('guildBanRemove', async b => {
    if (!logEnabled(b.guild, 'mod')) return;
    log(b.guild, 'mod', { title: 'Member unbanned', color: 0x57f287, ex: await getExecutor(b.guild, A.MemberBanRemove, b.user.id), fields: [['User', fmtUser(b.user)]] });
  });

  client.on('messageDelete', async msg => {
    if (!msg.guild || !logEnabled(msg.guild, 'message') || msg.author?.id === client.user.id) return;
    const ex = msg.author ? await getExecutor(msg.guild, A.MessageDelete, msg.author.id, { maxAge: 6000, check: e => e.extra?.channel?.id === msg.channelId }) : undefined;
    log(msg.guild, 'message', { title: 'Message deleted', color: 0xed4245, ex,
      fields: [['Author', msg.author ? fmtUser(msg.author) : 'Unknown (uncached)'], ['Channel', `<#${msg.channelId}>`], ['Content', msg.content || '*no text / uncached*']] });
  });
  client.on('messageUpdate', (o, n) => {
    if (!n.guild || !logEnabled(n.guild, 'message') || n.author?.bot || o.content === n.content || !o.content) return;
    log(n.guild, 'message', { title: 'Message edited', color: 0xfee75c, desc: `[Jump to message](${n.url})`,
      fields: [['Author', fmtUser(n.author)], ['Channel', `<#${n.channelId}>`], ['Before', o.content], ['After', n.content || '—']] });
  });

  client.on('roleCreate', async r => {
    if (!logEnabled(r.guild, 'roles')) return;
    log(r.guild, 'roles', { title: 'Role created', color: 0x57f287, ex: await getExecutor(r.guild, A.RoleCreate, r.id), fields: [['Role', `${r} (${r.name})`]] });
  });
  client.on('roleDelete', async r => {
    if (!logEnabled(r.guild, 'roles')) return;
    log(r.guild, 'roles', { title: 'Role deleted', color: 0xed4245, ex: await getExecutor(r.guild, A.RoleDelete, r.id), fields: [['Role', r.name]] });
  });
  client.on('roleUpdate', async (o, n) => {
    if (!logEnabled(n.guild, 'roles')) return;
    const f = [];
    if (o.name !== n.name) f.push(['Name', `${o.name} → ${n.name}`]);
    if (o.color !== n.color) f.push(['Color', `#${o.color.toString(16)} → #${n.color.toString(16)}`]);
    const add = o.permissions.missing(n.permissions), rem = n.permissions.missing(o.permissions);
    if (add.length) f.push(['➕ Permissions added', add.join(', ')]);
    if (rem.length) f.push(['➖ Permissions removed', rem.join(', ')]);
    if (!f.length) return;
    log(n.guild, 'roles', { title: 'Role updated', color: 0xfee75c, ex: await getExecutor(n.guild, A.RoleUpdate, n.id), fields: [['Role', `${n}`], ...f] });
  });

  client.on('channelCreate', async c => {
    if (!c.guild || !logEnabled(c.guild, 'channel')) return;
    log(c.guild, 'channel', { title: 'Channel created', color: 0x57f287, ex: await getExecutor(c.guild, A.ChannelCreate, c.id), fields: [['Channel', `${c} (${c.name})`]] });
  });
  client.on('channelDelete', async c => {
    if (!c.guild || !logEnabled(c.guild, 'channel')) return;
    log(c.guild, 'channel', { title: 'Channel deleted', color: 0xed4245, ex: await getExecutor(c.guild, A.ChannelDelete, c.id), fields: [['Channel', c.name]] });
  });
  client.on('channelUpdate', async (o, n) => {
    if (!n.guild || !logEnabled(n.guild, 'channel')) return;
    const f = [];
    if (o.name !== n.name) f.push(['Name', `${o.name} → ${n.name}`]);
    if (o.topic !== n.topic) f.push(['Topic', `${o.topic || 'none'} → ${n.topic || 'none'}`]);
    if (o.rateLimitPerUser !== n.rateLimitPerUser) f.push(['Slowmode', `${o.rateLimitPerUser}s → ${n.rateLimitPerUser}s`]);
    if (o.permissionOverwrites?.cache.size !== n.permissionOverwrites?.cache.size) f.push(['Permission overwrites', 'Changed']);
    if (!f.length) return;
    log(n.guild, 'channel', { title: 'Channel updated', color: 0xfee75c, ex: await getExecutor(n.guild, A.ChannelUpdate, n.id).then(x => x || getExecutor(n.guild, A.ChannelOverwriteUpdate, n.id, { delay: 0 })), fields: [['Channel', `${n}`], ...f] });
  });

  client.on('voiceStateUpdate', (o, n) => {
    const g = n.guild;
    if (o.channelId === n.channelId || !logEnabled(g, 'voice')) return;
    const title = !o.channelId ? 'Joined voice' : !n.channelId ? 'Left voice' : 'Moved voice channel';
    log(g, 'voice', { title, color: 0x5865f2, fields: [['Member', fmtUser(n.member.user)], ...(o.channelId ? [['From', `<#${o.channelId}>`, true]] : []), ...(n.channelId ? [['To', `<#${n.channelId}>`, true]] : [])] });
  });

  client.on('guildUpdate', async (o, n) => {
    if (!logEnabled(n, 'server')) return;
    const f = [];
    if (o.name !== n.name) f.push(['Name', `${o.name} → ${n.name}`]);
    if (o.icon !== n.icon) f.push(['Icon', 'Changed']);
    if (o.verificationLevel !== n.verificationLevel) f.push(['Verification level', `${o.verificationLevel} → ${n.verificationLevel}`]);
    if (!f.length) return;
    log(n, 'server', { title: 'Server updated', color: 0xfee75c, ex: await getExecutor(n, A.GuildUpdate, null), fields: f });
  });
}

module.exports = { category: 'Logging', commands, init, _test: { render } };
