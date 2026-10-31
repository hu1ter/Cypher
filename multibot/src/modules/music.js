const { joinVoiceChannel, createAudioPlayer, createAudioResource, AudioPlayerStatus, VoiceConnectionStatus, entersState, NoSubscriberBehavior } = require('@discordjs/voice');
const play = require('play-dl');
const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { embed, shuffle } = require('../util');
const { UsageError } = require('../context');

const queues = new Map();

function destroy(guildId) {
  const q = queues.get(guildId);
  if (!q) return;
  clearTimeout(q.timer);
  q.npMsg?.edit({ components: [] }).catch(() => {});
  q.songs = [];
  try { q.player.stop(true); q.connection.destroy(); } catch {}
  queues.delete(guildId);
}


const cbtn = (id, emoji, label, style = ButtonStyle.Secondary) => { const b = new ButtonBuilder().setCustomId(id).setStyle(style); if (emoji) b.setEmoji(emoji); if (label) b.setLabel(label); return b; };
const controls = () => [
  new ActionRowBuilder().addComponents(cbtn('music_pause', '⏯️'), cbtn('music_skip', '⏭️'), cbtn('music_stop', '⏹️', null, ButtonStyle.Danger), cbtn('music_loop', '🔁'), cbtn('music_shuffle', '🔀')),
  new ActionRowBuilder().addComponents(cbtn('music_vdown', '🔉'), cbtn('music_vup', '🔊'), cbtn('music_queue', '📜', 'Queue')),
];
const queueEmbed = q => embed(0x1db954).setTitle(`Queue (${q.songs.length}) • loop: ${q.loop}`)
  .setDescription(q.songs.slice(0, 15).map((s, i) => `${i ? i + '.' : '▶️'} [${s.title}](${s.url}) \`${s.duration}\``).join('\n') + (q.songs.length > 15 ? `\n…and ${q.songs.length - 15} more` : '') || 'Empty');

async function playNext(q) {
  clearTimeout(q.timer);
  const song = q.songs[0];
  if (!song) {
    q.playing = false;
    q.timer = setTimeout(() => destroy(q.guildId), 120000);   // leave after 2 min idle
    return;
  }
  try {
    const s = await play.stream(song.url);
    const res = createAudioResource(s.stream, { inputType: s.type, inlineVolume: true });
    res.volume.setVolume(q.volume);
    q.resource = res; q.playing = true;
    q.player.play(res);
    q.npMsg?.edit({ components: [] }).catch(() => {});
    q.npMsg = await q.text.send({ embeds: [embed(0x1db954).setTitle('🎶 Now playing').setDescription(`[${song.title}](${song.url})`).setFooter({ text: `${song.duration} • requested by ${song.by}` })], components: controls() }).catch(() => null);
  } catch (e) {
    console.error('music:', e.message);
    q.text.send(`⚠️ Couldn't play **${song.title}** (${e.message}). Skipping.`).catch(() => {});
    q.songs.shift();
    playNext(q);
  }
}

function create(ctx, vc) {
  const connection = joinVoiceChannel({ channelId: vc.id, guildId: ctx.guild.id, adapterCreator: ctx.guild.voiceAdapterCreator, selfDeaf: true });
  const player = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Pause } });
  connection.subscribe(player);
  const q = { guildId: ctx.guild.id, connection, player, songs: [], loop: 'off', volume: 0.5, text: ctx.channel, playing: false, forceNext: false };
  connection.on(VoiceConnectionStatus.Disconnected, async () => {
    try { await Promise.race([entersState(connection, VoiceConnectionStatus.Signalling, 5000), entersState(connection, VoiceConnectionStatus.Connecting, 5000)]); }
    catch { destroy(q.guildId); }
  });
  player.on(AudioPlayerStatus.Idle, () => {
    const done = q.songs[0];
    if (q.loop !== 'song' || q.forceNext) { q.songs.shift(); if (q.loop === 'queue' && done) q.songs.push(done); }
    q.forceNext = false;
    playNext(q);
  });
  player.on('error', e => console.error('player error:', e.message));
  queues.set(ctx.guild.id, q);
  return q;
}

const toSong = (v, by) => ({ title: v.title || 'Unknown', url: v.url, duration: v.durationRaw || '?', by });

async function resolve(query, by) {
  const kind = play.yt_validate(query);
  if (kind === 'video') return [toSong((await play.video_info(query)).video_details, by)];
  if (kind === 'playlist') {
    const pl = await play.playlist_info(query, { incomplete: true });
    return (await pl.all_videos()).slice(0, 50).map(v => toSong(v, by));
  }
  return (await play.search(query, { limit: 1, source: { youtube: 'video' } })).map(v => toSong(v, by));
}

function need(ctx) {
  const vc = ctx.member.voice?.channel;
  if (!vc) throw new UsageError('❌ Join a voice channel first.');
  const q = queues.get(ctx.guild.id);
  if (q && q.connection.joinConfig.channelId !== vc.id) throw new UsageError('❌ You must be in my voice channel.');
  return { vc, q };
}
const needQueue = ctx => { const r = need(ctx); if (!r.q) throw new UsageError('❌ Nothing is playing.'); return r.q; };

const commands = [
  { name: 'play', aliases: ['p'], description: 'Play a song (YouTube URL, playlist or search)', botPerms: ['Connect', 'Speak'],
    options: [{ name: 'query', type: 'string', description: 'Song name or URL', required: true, rest: true }],
    async run(ctx) {
      const { vc } = need(ctx);
      await ctx.defer();
      const songs = await resolve(ctx.opts.query, ctx.user.username);
      if (!songs.length) return ctx.reply('❌ Nothing found.');
      const q = queues.get(ctx.guild.id) || create(ctx, vc);
      q.songs.push(...songs);
      ctx.reply(songs.length > 1 ? `➕ Added **${songs.length}** songs to the queue.` : `➕ Queued **${songs[0].title}**`);
      if (!q.playing) playNext(q);
    } },
  { name: 'skip', aliases: ['s'], description: 'Skip the current song', run(ctx) { const q = needQueue(ctx); q.forceNext = true; q.player.stop(); ctx.reply('⏭️ Skipped.'); } },
  { name: 'stop', description: 'Stop and clear the queue', run(ctx) { needQueue(ctx); destroy(ctx.guild.id); ctx.reply('⏹️ Stopped.'); } },
  { name: 'leave', aliases: ['disconnect', 'dc'], description: 'Leave the voice channel', run(ctx) { needQueue(ctx); destroy(ctx.guild.id); ctx.reply('👋 Left.'); } },
  { name: 'pause', description: 'Pause', run(ctx) { needQueue(ctx).player.pause(); ctx.reply('⏸️ Paused.'); } },
  { name: 'resume', description: 'Resume', run(ctx) { needQueue(ctx).player.unpause(); ctx.reply('▶️ Resumed.'); } },
  { name: 'queue', aliases: ['q'], description: 'Show the queue',
    run(ctx) {
      const q = needQueue(ctx);
      ctx.reply({ embeds: [embed(0x1db954).setTitle(`Queue (${q.songs.length}) • loop: ${q.loop}`)
        .setDescription(q.songs.slice(0, 15).map((s, i) => `${i ? i + '.' : '▶️'} [${s.title}](${s.url}) \`${s.duration}\``).join('\n') + (q.songs.length > 15 ? `\n…and ${q.songs.length - 15} more` : ''))] });
    } },
  { name: 'nowplaying', aliases: ['np2', 'current'], description: 'Show the current song',
    run(ctx) { const s = needQueue(ctx).songs[0]; ctx.reply(s ? `🎶 [${s.title}](${s.url}) \`${s.duration}\`` : 'Nothing playing.'); } },
  { name: 'volume', aliases: ['vol'], description: 'Set volume 0-200', options: [{ name: 'percent', type: 'integer', description: '0-200', required: true }],
    run(ctx) {
      const q = needQueue(ctx); q.volume = Math.min(Math.max(ctx.opts.percent, 0), 200) / 100;
      q.resource?.volume?.setVolume(q.volume); ctx.reply(`🔊 Volume: ${Math.round(q.volume * 100)}%`);
    } },
  { name: 'loop', description: 'Loop off / song / queue', options: [{ name: 'mode', type: 'string', description: 'off, song or queue', required: true, choices: ['off', 'song', 'queue'] }],
    run(ctx) { needQueue(ctx).loop = ctx.opts.mode; ctx.reply(`🔁 Loop: **${ctx.opts.mode}**`); } },
  { name: 'shuffle', description: 'Shuffle the queue',
    run(ctx) { const q = needQueue(ctx); q.songs = [q.songs[0], ...shuffle(q.songs.slice(1))].filter(Boolean); ctx.reply('🔀 Shuffled.'); } },
];

function init(client) {
  client.on('interactionCreate', async i => {
    if (!i.isButton() || !i.customId.startsWith('music_')) return;
    const q = queues.get(i.guildId);
    const say = content => i.reply({ content, flags: 64 });
    if (!q) return say('❌ Nothing is playing.');
    if (i.member.voice?.channelId !== q.connection.joinConfig.channelId) return say('❌ Join my voice channel to use the controls.');
    switch (i.customId) {
      case 'music_pause': q.player.state.status === AudioPlayerStatus.Paused ? q.player.unpause() : q.player.pause(); return i.deferUpdate();
      case 'music_skip': q.forceNext = true; q.player.stop(); return i.deferUpdate();
      case 'music_stop': destroy(i.guildId); return i.deferUpdate();
      case 'music_shuffle': q.songs = [q.songs[0], ...shuffle(q.songs.slice(1))].filter(Boolean); return say('🔀 Shuffled.');
      case 'music_loop': q.loop = { off: 'song', song: 'queue', queue: 'off' }[q.loop]; return say(`🔁 Loop: **${q.loop}**`);
      case 'music_vdown': case 'music_vup':
        q.volume = Math.min(Math.max(q.volume + (i.customId === 'music_vup' ? 0.1 : -0.1), 0), 2);
        q.resource?.volume?.setVolume(q.volume); return say(`🔊 Volume: ${Math.round(q.volume * 100)}%`);
      case 'music_queue': return i.reply({ embeds: [queueEmbed(q)], flags: 64 });
    }
  });
  client.on('voiceStateUpdate', (o, n) => {
    if (n.id === client.user.id && !n.channelId) destroy(n.guild.id);   // bot was disconnected manually
  });
}

module.exports = { category: 'Music', commands, init };
