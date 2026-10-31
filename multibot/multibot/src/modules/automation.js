const { PermissionFlagsBits: P, ChannelType, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const db = require('../db');
const { embed, parseDuration, formatDuration, isOwner } = require('../util');

const MODES = ['contains', 'exact', 'word', 'startswith', 'endswith', 'wildcard', 'regex'];
const MODE_HELP = 'contains | exact | word | startswith | endswith | wildcard | regex';

// All automation data lives under guild.auto and heals itself, so it works with any version of db.js.
function store(gid) {
  const a = (db.guild(gid).auto ||= {});
  a.responders ||= []; a.reactions ||= []; a.stickies ||= {}; a.planner ||= []; a.tz ??= 0;
  return a;
}
const nextId = list => list.reduce((m, x) => Math.max(m, x.id), 0) + 1;
const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const nl = s => (s || '').replace(/\\n/g, '\n');
const isText = ch => ch && [ChannelType.GuildText, ChannelType.GuildAnnouncement].includes(ch.type);
const trunc = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s).replace(/\n/g, ' ');

// ------------------------------------------------------------ matching
function build(mode, trig) {
  const q = trig.toLowerCase();
  if (trig === '*') return () => true;
  switch (mode) {
    case 'exact': return t => t.trim().toLowerCase() === q;
    case 'startswith': return t => t.toLowerCase().startsWith(q);
    case 'endswith': return t => t.trim().toLowerCase().endsWith(q);
    case 'word': { const re = new RegExp(`(?<![\\p{L}\\p{N}_])${esc(trig)}(?![\\p{L}\\p{N}_])`, 'iu'); return t => re.test(t); }
    case 'wildcard': { const re = new RegExp('^' + esc(trig).replace(/\\\*/g, '.*').replace(/\\\?/g, '.') + '$', 'is'); return t => re.test(t.trim()); }
    case 'regex': { const re = new RegExp(trig, 'i'); return t => re.test(t.slice(0, 500)); }
    default: return t => t.toLowerCase().includes(q);
  }
}
const cache = new WeakMap();
function matches(rule, text) {
  let f = cache.get(rule);
  if (!f) { try { f = build(rule.mode, rule.trigger); } catch { f = () => false; } cache.set(rule, f); }
  try { return f(text); } catch { return false; }
}
function validateTrigger(mode, trig) {
  if (trig.length > 150) return 'Trigger is too long (max 150 characters).';
  if (mode === 'regex') {
    if (/\([^)]*[+*][^)]*\)[+*{]/.test(trig)) return 'That regex looks like it could freeze the bot (nested repeats). Simplify it.';
    try { new RegExp(trig, 'i'); } catch (e) { return `Invalid regex: ${e.message}`; }
  } else if (mode === 'wildcard' || mode === 'word') {
    try { build(mode, trig); } catch (e) { return `Invalid trigger: ${e.message}`; }
  }
  return null;
}
const fill = (text, msg) => text
  .replace(/\{user\}/gi, `<@${msg.author.id}>`).replace(/\{username\}/gi, msg.author.username)
  .replace(/\{server\}/gi, msg.guild.name).replace(/\{channel\}/gi, `<#${msg.channelId}>`).replace(/\{members\}/gi, String(msg.guild.memberCount));

// ------------------------------------------------------------ shared command helpers
const MODE_OPT = { name: 'mode', type: 'string', description: `Match mode: ${MODE_HELP}`, choices: MODES };
const CH_OPT = { name: 'channel', type: 'channel', description: 'Only in this channel (default: everywhere)' };
const ACTIONS = (...a) => ({ name: 'action', type: 'string', description: a.join(' | '), required: true, choices: a });

function listEmbed(title, lines, color) {
  return { embeds: [embed(color).setTitle(title).setDescription(lines.join('\n').slice(0, 4000))] };
}

// ------------------------------------------------------------ sticky
const stickyPayload = s => (s.embed ? { embeds: [embed(0x5865f2).setDescription(s.content).setFooter({ text: '📌 Sticky message' })] } : { content: s.content });
const pendingSticky = new Set();
function scheduleSticky(client, gid, cid) {
  if (pendingSticky.has(cid)) return;
  pendingSticky.add(cid);
  setTimeout(async () => {
    pendingSticky.delete(cid);
    const s = store(gid).stickies[cid], ch = client.channels.cache.get(cid);
    if (!s || !ch) return;
    if (s.lastId) await ch.messages.delete(s.lastId).catch(() => {});
    const sent = await ch.send({ ...stickyPayload(s), allowedMentions: { parse: [] } }).catch(() => null);
    s.lastId = sent?.id || null; db.save();
  }, 3000);
}

// ------------------------------------------------------------ planner time parsing
function parseTz(str) {
  if (/^(utc|gmt)$/i.test(str)) return 0;
  const m = str.match(/^(?:utc|gmt)?([+-])?(\d{1,2})(?::?(\d{2}))?$/i);
  if (!m) return null;
  const mins = (parseInt(m[2]) * 60 + parseInt(m[3] || '0')) * (m[1] === '-' ? -1 : 1);
  return mins >= -720 && mins <= 840 ? mins : null;
}
const fmtTz = mins => `UTC${mins < 0 ? '-' : '+'}${Math.floor(Math.abs(mins) / 60)}:${String(Math.abs(mins) % 60).padStart(2, '0')}`;
function parseWhen(str, tzMin, now = Date.now()) {
  if (/^(\d+\s*[smhdw])+$/i.test(str)) return now + parseDuration(str);
  const off = tzMin * 60000;
  let m = str.match(/^(\d{1,2}):(\d{2})$/);
  if (m) {
    const h = +m[1], mi = +m[2];
    if (h > 23 || mi > 59) return null;
    const l = new Date(now + off);
    let t = Date.UTC(l.getUTCFullYear(), l.getUTCMonth(), l.getUTCDate(), h, mi) - off;
    if (t <= now + 1000) t += 864e5;
    return t;
  }
  m = str.match(/^(\d{4})-(\d{1,2})-(\d{1,2})[T@ _](\d{1,2}):(\d{2})$/);
  if (m) {
    const [y, mo, d, h, mi] = m.slice(1).map(Number);
    const chk = new Date(Date.UTC(y, mo - 1, d, h, mi));
    if (h > 23 || mi > 59 || chk.getUTCMonth() !== mo - 1 || chk.getUTCDate() !== d) return null;
    return chk.getTime() - off;
  }
  return null;
}
function parseRepeat(str) {
  const named = { hourly: 36e5, daily: 864e5, weekly: 6048e5 };
  return named[str.toLowerCase()] || parseDuration(str);
}

// ------------------------------------------------------------ nuke helpers
function moveRefs(gid, oldId, newId) {
  const g = db.guild(gid), a = store(gid);
  for (const k of Object.keys(g.logs || {})) if (g.logs[k] === oldId) g.logs[k] = newId;
  if (a.stickies[oldId]) { a.stickies[newId] = { ...a.stickies[oldId], lastId: null }; delete a.stickies[oldId]; }
  for (const r of [...a.responders, ...a.reactions]) if (r.channel === oldId) r.channel = newId;
  for (const p of a.planner) if (p.channelId === oldId) p.channelId = newId;
  if (g.automod?.ignoredChannels) g.automod.ignoredChannels = g.automod.ignoredChannels.map(c => (c === oldId ? newId : c));
  for (const [id, gw] of Object.entries(db.data.giveaways)) if (gw.channelId === oldId) delete db.data.giveaways[id];
  db.save();
}

// ------------------------------------------------------------ commands
const commands = [
  { name: 'autoresponder', aliases: ['ar'], perms: P.ManageGuild,
    description: 'Auto replies: add "<trigger>" <response> [--mode ..] [--cooldown s] [--channel #c] | remove <id> | list | clear',
    options: [ACTIONS('add', 'remove', 'list', 'clear'),
      { name: 'trigger', type: 'string', description: 'Trigger text (add) or rule ID (remove). Use quotes for spaces' },
      { name: 'response', type: 'string', description: 'Reply text. Variables: {user} {username} {server} {channel} {members}; \\n = new line', rest: true },
      MODE_OPT, { name: 'cooldown', type: 'integer', description: 'Seconds between replies (default 5)' }, CH_OPT],
    run(ctx) {
      const a = store(ctx.guild.id), o = ctx.opts;
      switch (o.action) {
        case 'add': {
          if (!o.trigger || !o.response) return ctx.reply(`❌ Usage: \`${ctx.prefix}ar add "<trigger>" <response> [--mode ${MODES.join('|')}] [--cooldown 5] [--channel #channel]\``);
          const mode = o.mode || 'contains', cd = o.cooldown ?? 5;
          if (a.responders.length >= 100) return ctx.reply('❌ Limit reached (100 autoresponders).');
          if (cd < 0 || cd > 3600) return ctx.reply('❌ Cooldown must be 0-3600 seconds.');
          if (o.channel && !o.channel.isTextBased()) return ctx.reply('❌ Pick a text channel.');
          const bad = validateTrigger(mode, o.trigger); if (bad) return ctx.reply('❌ ' + bad);
          const rule = { id: nextId(a.responders), trigger: o.trigger, mode, response: nl(o.response).slice(0, 2000), cooldown: cd, channel: o.channel?.id || null, uses: 0 };
          a.responders.push(rule); db.save();
          return ctx.reply(`✅ Autoresponder **#${rule.id}** added — \`${mode}\` \`${rule.trigger}\`${rule.channel ? ` in <#${rule.channel}>` : ''}`);
        }
        case 'remove': {
          const id = parseInt(o.trigger), i = a.responders.findIndex(r => r.id === id);
          if (i < 0) return ctx.reply('❌ No autoresponder with that ID. See `ar list`.');
          a.responders.splice(i, 1); db.save(); return ctx.reply(`🗑️ Removed autoresponder **#${id}**.`);
        }
        case 'clear': a.responders = []; db.save(); return ctx.reply('🗑️ All autoresponders removed.');
        default:
          if (!a.responders.length) return ctx.reply('No autoresponders yet. Add one with `ar add "hello" Hi {user}!`');
          return ctx.reply(listEmbed(`Autoresponders (${a.responders.length})`, a.responders.map(r =>
            `**#${r.id}** \`${r.mode}\` \`${trunc(r.trigger, 40)}\` → ${trunc(r.response, 60)}${r.channel ? ` • <#${r.channel}>` : ''} • ${r.cooldown}s cd • used ${r.uses}×`), 0x5865f2));
      }
    } },

  { name: 'autoreact', aliases: ['areact', 'autoreaction'], perms: P.ManageGuild,
    description: 'Auto reactions: add "<trigger>" <emojis> [--mode ..] [--channel #c] | remove <id> | list | clear. Trigger * = every message',
    options: [ACTIONS('add', 'remove', 'list', 'clear'),
      { name: 'trigger', type: 'string', description: 'Trigger text, * for every message (add), or rule ID (remove)' },
      { name: 'emojis', type: 'string', description: 'Up to 5 emojis, separated by spaces', rest: true }, MODE_OPT, CH_OPT],
    run(ctx) {
      const a = store(ctx.guild.id), o = ctx.opts;
      switch (o.action) {
        case 'add': {
          if (!o.trigger || !o.emojis) return ctx.reply(`❌ Usage: \`${ctx.prefix}autoreact add "<trigger>" 👍 🔥 [--mode word] [--channel #channel]\`  (trigger \`*\` = every message)`);
          const mode = o.mode || 'contains';
          const emojis = [...new Set(o.emojis.match(/<a?:\w+:\d+>|\p{Regional_Indicator}{2}|\p{Extended_Pictographic}(?:\uFE0F|\u200D\p{Extended_Pictographic})*/gu) || [])].slice(0, 5);
          if (!emojis.length) return ctx.reply('❌ No valid emojis found. Use normal emojis or custom emojis from a server I am in.');
          if (a.reactions.length >= 50) return ctx.reply('❌ Limit reached (50 auto reactions).');
          if (o.channel && !o.channel.isTextBased()) return ctx.reply('❌ Pick a text channel.');
          const bad = validateTrigger(mode, o.trigger); if (bad) return ctx.reply('❌ ' + bad);
          const rule = { id: nextId(a.reactions), trigger: o.trigger, mode, emojis, channel: o.channel?.id || null };
          a.reactions.push(rule); db.save();
          return ctx.reply(`✅ Auto reaction **#${rule.id}** added — \`${mode}\` \`${rule.trigger}\` → ${emojis.join(' ')}${rule.channel ? ` in <#${rule.channel}>` : ''}`);
        }
        case 'remove': {
          const id = parseInt(o.trigger), i = a.reactions.findIndex(r => r.id === id);
          if (i < 0) return ctx.reply('❌ No auto reaction with that ID. See `autoreact list`.');
          a.reactions.splice(i, 1); db.save(); return ctx.reply(`🗑️ Removed auto reaction **#${id}**.`);
        }
        case 'clear': a.reactions = []; db.save(); return ctx.reply('🗑️ All auto reactions removed.');
        default:
          if (!a.reactions.length) return ctx.reply('No auto reactions yet. Add one with `autoreact add "gm" ☀️`');
          return ctx.reply(listEmbed(`Auto reactions (${a.reactions.length})`, a.reactions.map(r =>
            `**#${r.id}** \`${r.mode}\` \`${trunc(r.trigger, 40)}\` → ${r.emojis.join(' ')}${r.channel ? ` • <#${r.channel}>` : ''}`), 0xfee75c));
      }
    } },

  { name: 'sticky', aliases: ['stick'], perms: P.ManageMessages,
    description: 'Sticky message that stays at the bottom: set <text> [--channel #c] [--embed true] | remove | list',
    options: [ACTIONS('set', 'remove', 'list'),
      { name: 'message', type: 'string', description: 'Sticky text (\\n = new line)', rest: true },
      { name: 'channel', type: 'channel', description: 'Channel (default: current)' },
      { name: 'embed', type: 'boolean', description: 'Post as an embed' }],
    async run(ctx) {
      const a = store(ctx.guild.id), o = ctx.opts, ch = o.channel || ctx.channel;
      if (o.action === 'list') {
        const entries = Object.entries(a.stickies);
        if (!entries.length) return ctx.reply('No sticky messages set.');
        return ctx.reply(listEmbed('Sticky messages', entries.map(([cid, s]) => `<#${cid}> ${s.embed ? '(embed) ' : ''}— ${trunc(s.content, 80)}`), 0x5865f2));
      }
      if (!isText(ch)) return ctx.reply('❌ Pick a text channel.');
      const old = a.stickies[ch.id];
      if (o.action === 'remove') {
        if (!old) return ctx.reply('❌ That channel has no sticky message.');
        if (old.lastId) await ch.messages.delete(old.lastId).catch(() => {});
        delete a.stickies[ch.id]; db.save(); return ctx.reply(`🗑️ Sticky removed from ${ch}.`);
      }
      if (!o.message) return ctx.reply(`❌ Usage: \`${ctx.prefix}sticky set <text> [--channel #channel] [--embed true]\``);
      const s = { content: nl(o.message).slice(0, o.embed ? 4000 : 2000), embed: !!o.embed, lastId: null };
      if (old?.lastId) await ch.messages.delete(old.lastId).catch(() => {});
      const sent = await ch.send({ ...stickyPayload(s), allowedMentions: { parse: [] } }).catch(e => e);
      if (sent instanceof Error) return ctx.reply(`❌ I can't post in ${ch}: ${sent.message}`);
      s.lastId = sent.id; a.stickies[ch.id] = s; db.save();
      ctx.reply(`📌 Sticky message set in ${ch}. It re-posts at the bottom after new messages.`);
    } },

  { name: 'schedule', aliases: ['planner', 'sched'], perms: P.ManageGuild,
    description: 'Message planner: add <when> <text> [--channel #c] [--repeat daily] | list | remove <id> | clear | timezone [+5:45]',
    options: [ACTIONS('add', 'list', 'remove', 'clear', 'timezone'),
      { name: 'value', type: 'string', description: 'add: 30m / 2h / 18:30 / "2026-12-25 09:00" • remove: ID • timezone: offset like +5:45' },
      { name: 'message', type: 'string', description: 'Message to send. Variables {server} {members}; \\n = new line', rest: true },
      { name: 'channel', type: 'channel', description: 'Channel to send in (default: current)' },
      { name: 'repeat', type: 'string', description: 'Repeat: hourly | daily | weekly | or a duration like 6h' }],
    run(ctx) {
      const a = store(ctx.guild.id), o = ctx.opts;
      switch (o.action) {
        case 'timezone': {
          if (!o.value) return ctx.reply(`🕒 Planner timezone: **${fmtTz(a.tz)}**. Change it with \`${ctx.prefix}schedule timezone +5:45\`.`);
          const tz = parseTz(o.value);
          if (tz === null) return ctx.reply('❌ Use an offset like `+5:45`, `-8` or `UTC`.');
          a.tz = tz; db.save(); return ctx.reply(`🕒 Planner timezone set to **${fmtTz(tz)}**. Clock times (like \`18:30\`) now use it.`);
        }
        case 'add': {
          if (!o.value || !o.message) return ctx.reply(`❌ Usage: \`${ctx.prefix}schedule add <when> <message> [--channel #channel] [--repeat daily]\`\n\`when\` can be \`30m\`, \`2h30m\`, \`18:30\` (next time it's 18:30), or \`"2026-12-25 09:00"\` (quotes needed). Times use **${fmtTz(a.tz)}**; change with \`schedule timezone\`.`);
          if (a.planner.length >= 25) return ctx.reply('❌ Limit reached (25 scheduled messages).');
          const at = parseWhen(o.value, a.tz);
          if (!at) return ctx.reply('❌ I could not read that time. Try `30m`, `18:30` or `"2026-12-25 09:00"`.');
          if (at < Date.now() + 5000) return ctx.reply('❌ That time is in the past.');
          const ch = o.channel || ctx.channel;
          if (!isText(ch)) return ctx.reply('❌ Pick a text channel.');
          if (!ch.permissionsFor(ctx.guild.members.me)?.has([P.ViewChannel, P.SendMessages])) return ctx.reply(`❌ I can't send messages in ${ch}.`);
          let repeatMs = null;
          if (o.repeat && !/^(none|off|no)$/i.test(o.repeat)) {
            repeatMs = parseRepeat(o.repeat);
            if (!repeatMs || repeatMs < 300000) return ctx.reply('❌ Repeat must be `hourly`, `daily`, `weekly` or a duration of at least 5 minutes (e.g. `6h`).');
          }
          const p = { id: nextId(a.planner), channelId: ch.id, content: nl(o.message).slice(0, 2000), at, repeatMs, by: ctx.user.id };
          a.planner.push(p); db.save();
          return ctx.reply(`📅 Scheduled **#${p.id}** in ${ch} for <t:${Math.floor(at / 1000)}:F> (<t:${Math.floor(at / 1000)}:R>)${repeatMs ? ` • repeats every ${formatDuration(repeatMs)}` : ''}.`);
        }
        case 'remove': {
          const id = parseInt(o.value), i = a.planner.findIndex(p => p.id === id);
          if (i < 0) return ctx.reply('❌ No scheduled message with that ID. See `schedule list`.');
          a.planner.splice(i, 1); db.save(); return ctx.reply(`🗑️ Removed scheduled message **#${id}**.`);
        }
        case 'clear': a.planner = []; db.save(); return ctx.reply('🗑️ All scheduled messages removed.');
        default:
          if (!a.planner.length) return ctx.reply(`No scheduled messages. Add one with \`${ctx.prefix}schedule add 18:30 Hello!\` (timezone: ${fmtTz(a.tz)})`);
          return ctx.reply(listEmbed(`Scheduled messages (${a.planner.length}) • ${fmtTz(a.tz)}`, [...a.planner].sort((x, y) => x.at - y.at).map(p =>
            `**#${p.id}** <t:${Math.floor(p.at / 1000)}:F> (<t:${Math.floor(p.at / 1000)}:R>) → <#${p.channelId}>${p.repeatMs ? ` 🔁 ${formatDuration(p.repeatMs)}` : ''}\n┗ ${trunc(p.content, 80)}`), 0x57f287));
      }
    } },

  { name: 'nuke', aliases: ['nukechannel'], perms: P.ManageChannels,
    description: 'Wipe a channel by cloning it and deleting the original (keeps permissions & settings)',
    options: [{ name: 'channel', type: 'channel', description: 'Channel to nuke (default: current)' }],
    async run(ctx) {
      const ch = ctx.opts.channel || ctx.channel, guild = ctx.guild;
      if (!isText(ch)) return ctx.reply('❌ Only text and announcement channels can be nuked.');
      if (ch.id === guild.rulesChannelId || ch.id === guild.publicUpdatesChannelId) return ctx.reply('❌ That is a Community rules/updates channel — Discord does not allow deleting it.');
      // Only bot owners (OWNER_IDS) skip the confirmation step.
      let msg;
      if (isOwner(ctx.user.id)) {
        msg = await ctx.reply('💥 Nuking…');
      } else {
        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId('nuke_yes').setLabel('💥 Nuke it').setStyle(ButtonStyle.Danger),
          new ButtonBuilder().setCustomId('nuke_no').setLabel('Cancel').setStyle(ButtonStyle.Secondary));
        msg = await ctx.reply({ content: `⚠️ This will **delete every message** in ${ch} by cloning the channel and deleting the old one. This cannot be undone.`, components: [row] });
        const i = await msg.awaitMessageComponent({ filter: x => x.user.id === ctx.user.id, time: 30000 }).catch(() => null);
        if (!i) return msg.edit({ content: '⌛ Nuke cancelled (no response).', components: [] }).catch(() => {});
        if (i.customId === 'nuke_no') return i.update({ content: 'Cancelled.', components: [] });
        await i.update({ content: '💥 Nuking…', components: [] });
      }

      const reason = `Channel nuked [mod:${ctx.user.id}]`, pos = ch.rawPosition;
      let clone;
      try { clone = await ch.clone({ name: ch.name, reason }); }
      catch (e) { return msg.edit(`❌ Couldn't clone the channel: ${e.message}`).catch(() => {}); }
      try { await ch.delete(reason); }
      catch (e) { await clone.delete('Rollback').catch(() => {}); return msg.edit(`❌ Couldn't delete the old channel: ${e.message}`).catch(() => {}); }
      await clone.setPosition(pos).catch(() => {});
      moveRefs(guild.id, ch.id, clone.id);
      const st = store(guild.id).stickies[clone.id];
      if (st) { const sent = await clone.send({ ...stickyPayload(st), allowedMentions: { parse: [] } }).catch(() => null); st.lastId = sent?.id || null; db.save(); }
      await clone.send({ embeds: [embed(0xed4245).setTitle('💥 Channel nuked').setDescription(`This channel was nuked by ${ctx.user}.`).setImage('https://media.giphy.com/media/oe33xf3B50fsc/giphy.gif')] }).catch(() => {});
      if (ch.id !== ctx.channel.id) msg.edit(`✅ Nuked ${clone}.`).catch(() => {});
    } },
];

// ------------------------------------------------------------ runtime listeners
async function tick(client) {
  const now = Date.now();
  for (const [gid, g] of Object.entries(db.data.guilds)) {
    const list = g.auto?.planner;
    if (!list?.length) continue;
    const guild = client.guilds.cache.get(gid);
    if (!guild) continue;
    for (const p of [...list]) {
      if (p.at > now) continue;
      const fresh = now - p.at < 6 * 36e5;   // don't send things that are more than 6h late (bot was offline)
      if (p.repeatMs) { while (p.at <= now) p.at += p.repeatMs; } else list.splice(list.indexOf(p), 1);
      db.save();
      const ch = guild.channels.cache.get(p.channelId);
      if (fresh && ch?.isTextBased()) {
        const text = p.content.replace(/\{server\}/gi, guild.name).replace(/\{members\}/gi, String(guild.memberCount));
        await ch.send({ content: text, allowedMentions: { parse: ['users', 'roles', 'everyone'] } }).catch(() => {});
      }
    }
  }
}

function init(client) {
  const lastReply = new Map();
  client.on('messageCreate', async msg => {
    if (!msg.guild || msg.author.bot) return;
    const a = store(msg.guild.id);
    if (a.stickies[msg.channelId]) scheduleSticky(client, msg.guild.id, msg.channelId);
    const text = msg.content || '';
    const prefix = db.guild(msg.guild.id).prefix || process.env.PREFIX || '!';
    if (text.startsWith(prefix)) return;   // never react/reply to command invocations

    for (const r of a.reactions) {
      if ((r.channel && r.channel !== msg.channelId) || !matches(r, text)) continue;
      for (const e of r.emojis) await msg.react(e).catch(() => {});
    }
    for (const r of a.responders) {
      if ((r.channel && r.channel !== msg.channelId) || !matches(r, text)) continue;
      const key = `${msg.guild.id}:${r.id}:${msg.channelId}`, now = Date.now();
      if (now - (lastReply.get(key) || 0) < r.cooldown * 1000) break;
      lastReply.set(key, now); r.uses = (r.uses || 0) + 1; db.save();
      await msg.reply({ content: fill(r.response, msg).slice(0, 2000), allowedMentions: { parse: [], users: [msg.author.id], repliedUser: false }, failIfNotExists: false }).catch(() => {});
      break;   // first matching autoresponder only
    }
  });

  client.once('clientReady', () => {
    const run = () => tick(client).catch(e => console.error('planner:', e.message));
    run(); setInterval(run, 15000);
  });
}

module.exports = { category: 'Automation', commands, init, _test: { build, parseWhen, parseTz, validateTrigger, matches } };
