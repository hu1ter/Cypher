const { PermissionFlagsBits: P, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const db = require('../db');
const { embed, parseDuration, shuffle } = require('../util');

const ts = ms => Math.floor(ms / 1000);
const button = disabled => new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('gw_enter').setLabel('Enter').setEmoji('🎉').setStyle(ButtonStyle.Primary).setDisabled(disabled));

function gwEmbed(g, ended = false) {
  const lines = [
    `Hosted by: <@${g.hostId}>`, `Winners: **${g.winners}**`,
    ended ? `Ended: <t:${ts(g.endsAt)}:R>` : `Ends: <t:${ts(g.endsAt)}:R> (<t:${ts(g.endsAt)}:f>)`,
    `Entries: **${g.entries.length}**`,
  ];
  if (g.requiredRole || g.blockedRole) {
    lines.push('', '**Requirements**');
    if (g.requiredRole) lines.push(`✅ Must have <@&${g.requiredRole}>`);
    if (g.blockedRole) lines.push(`🚫 Must NOT have <@&${g.blockedRole}>`);
  }
  if (ended) lines.push('', g.winnerIds.length ? `🏆 **Winner(s):** ${g.winnerIds.map(i => `<@${i}>`).join(', ')}` : '😢 No valid entries.');
  return embed(ended ? 0x747f8d : 0xf1c40f).setTitle(`🎉 ${g.prize}`).setDescription(lines.join('\n')).setFooter({ text: `ID: ${g.id}` });
}

async function pick(guild, g, count, exclude = []) {
  const winners = [];
  for (const id of shuffle(g.entries.filter(i => !exclude.includes(i)))) {
    if (winners.length >= count) break;
    const m = await guild.members.fetch(id).catch(() => null);
    if (!m) continue;
    if (g.requiredRole && !m.roles.cache.has(g.requiredRole)) continue;   // re-validate at draw time
    if (g.blockedRole && m.roles.cache.has(g.blockedRole)) continue;
    winners.push(id);
  }
  return winners;
}

async function announce(channel, g, winners, reroll) {
  const text = winners.length
    ? `🎉 ${reroll ? 'New winner(s)' : 'Congratulations'} ${winners.map(i => `<@${i}>`).join(', ')}! You won **${g.prize}**!`
    : `😢 No valid entries for **${g.prize}**.`;
  await channel.send({ content: text, allowedMentions: { users: winners }, reply: { messageReference: g.id, failIfNotExists: false } }).catch(() => {});
}

async function endGiveaway(client, g) {
  g.ended = true;
  const guild = client.guilds.cache.get(g.guildId);
  const channel = await client.channels.fetch(g.channelId).catch(() => null);
  if (!guild || !channel) return db.save();
  g.winnerIds = await pick(guild, g, g.winners);
  db.save();
  const msg = await channel.messages.fetch(g.id).catch(() => null);
  await msg?.edit({ embeds: [gwEmbed(g, true)], components: [button(true)] }).catch(() => {});
  await announce(channel, g, g.winnerIds, false);
}

const find = (ctx, id) => { const g = db.data.giveaways[id]; return g && g.guildId === ctx.guild.id ? g : null; };
const idOpt = { name: 'message_id', type: 'string', description: 'Giveaway message ID', required: true };

const commands = [
  { name: 'gstart', aliases: ['giveaway'], description: 'Start a giveaway', perms: P.ManageGuild,
    options: [
      { name: 'duration', type: 'string', description: 'e.g. 10m, 2h, 1d', required: true },
      { name: 'winners', type: 'integer', description: 'Number of winners', required: true },
      { name: 'prize', type: 'string', description: 'Prize', required: true, rest: true },
      { name: 'role', type: 'role', description: 'Role required to enter' },
      { name: 'norole', type: 'role', description: 'Role that may NOT enter' },
      { name: 'channel', type: 'channel', description: 'Channel (default: current)' },
    ],
    async run(ctx) {
      const ms = parseDuration(ctx.opts.duration);
      if (!ms || ms < 10000 || ms > 60 * 864e5) return ctx.reply('❌ Duration must be between 10s and 60d (e.g. `1h30m`).');
      if (ctx.opts.winners < 1 || ctx.opts.winners > 25) return ctx.reply('❌ Winners must be 1-25.');
      const ch = ctx.opts.channel || ctx.channel;
      if (!ch.isTextBased()) return ctx.reply('❌ Pick a text channel.');
      const g = { id: null, guildId: ctx.guild.id, channelId: ch.id, prize: ctx.opts.prize, hostId: ctx.user.id, winners: ctx.opts.winners,
        endsAt: Date.now() + ms, requiredRole: ctx.opts.role?.id || null, blockedRole: ctx.opts.norole?.id || null, entries: [], ended: false, winnerIds: [] };
      const m = await ch.send({ embeds: [gwEmbed(g)], components: [button(false)] });
      g.id = m.id;
      m.edit({ embeds: [gwEmbed(g)] }).catch(() => {});
      db.data.giveaways[g.id] = g; db.save();
      ctx.reply(`✅ Giveaway started in ${ch}`);
    } },
  { name: 'gend', description: 'End a giveaway now', perms: P.ManageGuild, options: [idOpt],
    async run(ctx) {
      const g = find(ctx, ctx.opts.message_id);
      if (!g) return ctx.reply('❌ Giveaway not found.');
      if (g.ended) return ctx.reply('❌ Already ended. Use `greroll`.');
      await endGiveaway(ctx.client, g); ctx.reply('✅ Giveaway ended.');
    } },
  { name: 'greroll', description: 'Reroll winners (optionally choose how many)', perms: P.ManageGuild,
    options: [idOpt, { name: 'count', type: 'integer', description: 'How many new winners (default: original amount)' }],
    async run(ctx) {
      const g = find(ctx, ctx.opts.message_id);
      if (!g) return ctx.reply('❌ Giveaway not found.');
      if (!g.ended) return ctx.reply('❌ That giveaway has not ended yet.');
      const n = Math.min(Math.max(ctx.opts.count || g.winners, 1), 25);
      let winners = await pick(ctx.guild, g, n, g.winnerIds);
      if (!winners.length) winners = await pick(ctx.guild, g, n);   // everyone already won → allow repeats
      g.winnerIds = winners; db.save();
      const ch = await ctx.client.channels.fetch(g.channelId).catch(() => ctx.channel);
      (await ch.messages.fetch(g.id).catch(() => null))?.edit({ embeds: [gwEmbed(g, true)] }).catch(() => {});
      await announce(ch, g, winners, true);
      if (ch.id !== ctx.channel.id) ctx.reply('✅ Rerolled.');
    } },
  { name: 'glist', description: 'List active giveaways', perms: P.ManageGuild,
    run(ctx) {
      const list = Object.values(db.data.giveaways).filter(g => g.guildId === ctx.guild.id && !g.ended);
      ctx.reply(list.length ? list.map(g => `**${g.prize}** — <#${g.channelId}> • ends <t:${ts(g.endsAt)}:R> • ${g.entries.length} entries • ID \`${g.id}\``).join('\n').slice(0, 1900) : 'No active giveaways.');
    } },
  { name: 'gdelete', aliases: ['gcancel'], description: 'Cancel and delete a giveaway', perms: P.ManageGuild, options: [idOpt],
    async run(ctx) {
      const g = find(ctx, ctx.opts.message_id);
      if (!g) return ctx.reply('❌ Giveaway not found.');
      const ch = await ctx.client.channels.fetch(g.channelId).catch(() => null);
      (await ch?.messages.fetch(g.id).catch(() => null))?.delete().catch(() => {});
      delete db.data.giveaways[g.id]; db.save(); ctx.reply('🗑️ Giveaway deleted.');
    } },
];

function init(client) {
  client.on('interactionCreate', async i => {
    if (!i.isButton() || i.customId !== 'gw_enter') return;
    const g = db.data.giveaways[i.message.id];
    const deny = content => i.reply({ content, flags: 64 });
    if (!g || g.ended) return deny('❌ This giveaway has ended.');
    if (g.requiredRole && !i.member.roles.cache.has(g.requiredRole)) return deny(`❌ You need the <@&${g.requiredRole}> role to enter.`);
    if (g.blockedRole && i.member.roles.cache.has(g.blockedRole)) return deny(`❌ Members with <@&${g.blockedRole}> cannot enter.`);
    const left = g.entries.includes(i.user.id);
    g.entries = left ? g.entries.filter(x => x !== i.user.id) : [...g.entries, i.user.id];
    db.save();
    await i.update({ embeds: [gwEmbed(g)] }).catch(() => {});
    i.followUp({ content: left ? '👋 You left the giveaway.' : '✅ You entered the giveaway. Good luck! Click again to leave.', flags: 64 }).catch(() => {});
  });

  client.once('clientReady', () => {
    setInterval(() => {
      for (const g of Object.values(db.data.giveaways))
        if (!g.ended && g.endsAt <= Date.now()) endGiveaway(client, g).catch(e => console.error('giveaway end', e));
    }, 5000);
  });
}

module.exports = { category: 'Giveaways', commands, init };
