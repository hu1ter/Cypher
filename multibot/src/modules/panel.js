const { PermissionFlagsBits: P, ActionRowBuilder, ButtonBuilder, ButtonStyle, UserSelectMenuBuilder, RoleSelectMenuBuilder } = require('discord.js');
const db = require('../db');
const { embed, parseDuration, formatDuration } = require('../util');
const { runMenu, askModal } = require('../menu');
const { helpers } = require('./moderation');

const commands = [{
  name: 'modpanel', aliases: ['mod', 'panel'], description: 'Interactive moderation panel (warn, timeout, kick, ban, roles)',
  async run(ctx) {
    const { guild, client } = ctx;
    const st = { target: null, role: null, page: 'home', note: '' };
    const actor = async i => ({ user: i.user, member: await guild.members.fetch(i.user.id), guild, client });
    const b = (id, label, style = ButtonStyle.Secondary, disabled = false) => new ButtonBuilder().setCustomId(id).setLabel(label).setStyle(style).setDisabled(disabled);

    const view = async () => {
      const e = embed(0xed4245).setTitle('🔨 Moderation panel');
      const user = st.target && await client.users.fetch(st.target).catch(() => null);
      const tm = user && await guild.members.fetch(user.id).catch(() => null);
      const lines = [];
      if (user) {
        lines.push(`**Target:** ${user} \`${user.username}\` (${user.id})`);
        if (tm) {
          lines.push(`**Joined:** <t:${Math.floor(tm.joinedTimestamp / 1000)}:R>`, `**Roles:** ${tm.roles.cache.filter(r => r.id !== guild.id).map(r => r.toString()).join(' ') || 'none'}`);
          if (tm.communicationDisabledUntilTimestamp > Date.now()) lines.push(`**Timed out until:** <t:${Math.floor(tm.communicationDisabledUntilTimestamp / 1000)}:R>`);
        } else lines.push('*Not in this server*');
        lines.push(`**Warnings:** ${db.guild(guild.id).warnings[user.id]?.length || 0}`);
        e.setThumbnail(user.displayAvatarURL());
      } else lines.push('Select a member below to get started.');
      if (st.note) lines.push('', `**Last action:** ${st.note}`);
      e.setDescription(lines.join('\n'));
      const none = !user, rows = [];
      if (st.page === 'home') {
        const us = new UserSelectMenuBuilder().setCustomId('mp_user').setPlaceholder('Select a member').setMinValues(1).setMaxValues(1);
        if (user) us.setDefaultUsers(user.id);
        rows.push(new ActionRowBuilder().addComponents(us),
          new ActionRowBuilder().addComponents(b('mp_warn', '⚠️ Warn', ButtonStyle.Secondary, none), b('mp_timeout', '🔇 Timeout', ButtonStyle.Secondary, none), b('mp_kick', '👢 Kick', ButtonStyle.Primary, none), b('mp_ban', '🔨 Ban', ButtonStyle.Danger, none), b('mp_roles', '🎭 Roles', ButtonStyle.Secondary, none || !tm)),
          new ActionRowBuilder().addComponents(b('mp_untimeout', '🔊 Remove timeout', ButtonStyle.Secondary, !tm), b('mp_unban', '🔓 Unban by ID'), b('mp_close', 'Close')));
      } else {
        const rs = new RoleSelectMenuBuilder().setCustomId('mp_role').setPlaceholder('Select a role').setMinValues(1).setMaxValues(1);
        if (st.role && guild.roles.cache.has(st.role)) rs.setDefaultRoles(st.role);
        rows.push(new ActionRowBuilder().addComponents(rs), new ActionRowBuilder().addComponents(b('mp_radd', '➕ Add role', ButtonStyle.Success, !st.role), b('mp_rrem', '➖ Remove role', ButtonStyle.Danger, !st.role), b('mp_back', '← Back')));
      }
      return { embeds: [e], components: rows };
    };

    await runMenu(ctx, view, async (i, col) => {
      const need = async (flag, name) => {
        if (i.memberPermissions.has(flag)) return true;
        await i.reply({ content: `❌ You need the **${name}** permission for that.`, flags: 64 }); return false;
      };
      const a = await actor(i);
      const tag = r => helpers.tag(a, r);
      const targetMember = () => guild.members.fetch(st.target).catch(() => null);
      /** modal -> run -> update. fn returns a note string or throws a string/Error to show to the user */
      const withModal = async (title, fields, fn) => {
        const m = await askModal(i, title, fields);
        if (!m) return 'handled';
        try { st.note = await fn(m.fields); await m.update(await view()); }
        catch (e) { await m.reply({ content: `❌ ${e.message || e}`, flags: 64 }).catch(() => {}); }
        return 'handled';
      };
      const reasonField = { id: 'reason', label: 'Reason', long: true, required: false, max: 400 };
      const get = (f, id) => f.getTextInputValue(id).trim();

      switch (i.customId) {
        case 'mp_user': st.target = i.values[0]; st.note = ''; break;
        case 'mp_roles': st.page = 'roles'; break;
        case 'mp_back': st.page = 'home'; break;
        case 'mp_role': st.role = i.values[0]; break;
        case 'mp_close': await i.update({ components: [] }); col.stop(); return 'handled';

        case 'mp_warn':
          if (!(await need(P.ModerateMembers, 'Timeout Members'))) return 'handled';
          return withModal('Warn member', [reasonField], async f => {
            const reason = get(f, 'reason') || 'No reason provided';
            (db.guild(guild.id).warnings[st.target] ||= []).push({ reason, mod: i.user.id, at: Date.now() }); db.save();
            client.users.fetch(st.target).then(u => u.send(`⚠️ You were warned in **${guild.name}**: ${reason}`)).catch(() => {});
            return `⚠️ Warned <@${st.target}> — ${reason}`;
          });
        case 'mp_timeout':
          if (!(await need(P.ModerateMembers, 'Timeout Members'))) return 'handled';
          return withModal('Timeout member', [{ id: 'duration', label: 'Duration (e.g. 10m, 2h, 1d)', value: '10m', max: 20 }, reasonField], async f => {
            const ms = parseDuration(get(f, 'duration'));
            if (!ms || ms > 28 * 864e5) throw new Error('Duration must be between 1s and 28d.');
            const m = await targetMember(); if (!m) throw new Error('That member is not in the server.');
            const err = helpers.hierarchy(a, m); if (err) throw new Error(err);
            await m.timeout(ms, tag(get(f, 'reason')));
            return `🔇 Timed out <@${m.id}> for ${formatDuration(ms)}`;
          });
        case 'mp_untimeout': {
          if (!(await need(P.ModerateMembers, 'Timeout Members'))) return 'handled';
          const m = await targetMember(); if (!m) { st.note = '❌ Not in the server.'; break; }
          await m.timeout(null, tag('Timeout removed via panel')); st.note = `🔊 Removed timeout from <@${m.id}>`; break;
        }
        case 'mp_kick':
          if (!(await need(P.KickMembers, 'Kick Members'))) return 'handled';
          return withModal('Kick member', [reasonField], async f => {
            const m = await targetMember(); if (!m) throw new Error('That member is not in the server.');
            const err = helpers.hierarchy(a, m); if (err) throw new Error(err);
            await m.user.send(`You were kicked from **${guild.name}**. Reason: ${get(f, 'reason') || 'none'}`).catch(() => {});
            await m.kick(tag(get(f, 'reason')));
            return `👢 Kicked **${m.user.username}**`;
          });
        case 'mp_ban':
          if (!(await need(P.BanMembers, 'Ban Members'))) return 'handled';
          return withModal('Ban member', [reasonField], async f => {
            const m = await targetMember();
            if (m) { const err = helpers.hierarchy(a, m); if (err) throw new Error(err); await m.user.send(`You were banned from **${guild.name}**. Reason: ${get(f, 'reason') || 'none'}`).catch(() => {}); }
            await guild.members.ban(st.target, { reason: tag(get(f, 'reason')) });
            return `🔨 Banned <@${st.target}>`;
          });
        case 'mp_unban':
          if (!(await need(P.BanMembers, 'Ban Members'))) return 'handled';
          return withModal('Unban user', [{ id: 'id', label: 'User ID', max: 20 }, reasonField], async f => {
            const id = get(f, 'id').replace(/\D/g, '');
            if (!id) throw new Error('Enter a valid user ID.');
            await guild.members.unban(id, tag(get(f, 'reason')));
            return `🔓 Unbanned <@${id}>`;
          });
        case 'mp_radd': case 'mp_rrem': {
          if (!(await need(P.ManageRoles, 'Manage Roles'))) return 'handled';
          const m = await targetMember(), role = guild.roles.cache.get(st.role);
          if (!m || !role) { st.note = '❌ Member or role not found.'; break; }
          const err = helpers.roleCheck(a, role); if (err) { st.note = '❌ ' + err; break; }
          if (i.customId === 'mp_radd') await m.roles.add(role, tag('Role added via panel')); else await m.roles.remove(role, tag('Role removed via panel'));
          st.note = `🎭 ${i.customId === 'mp_radd' ? 'Added' : 'Removed'} **${role.name}** ${i.customId === 'mp_radd' ? 'to' : 'from'} <@${m.id}>`; break;
        }
      }
    });
  },
}];

module.exports = { category: 'Moderation', commands };
