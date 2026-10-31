const { ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder } = require('discord.js');

/**
 * Generic interactive menu. `render()` returns a message payload, `handle(i, collector, message)` reacts to a component.
 * Return 'handled' from `handle` if you already responded to the interaction yourself; otherwise the menu re-renders.
 */
async function runMenu(ctx, render, handle, time = 15 * 60000) {
  const msg = await ctx.reply(await render());
  const col = msg.createMessageComponentCollector({ time });
  col.on('collect', async i => {
    try {
      if (i.user.id !== ctx.user.id) return await i.reply({ content: '❌ This menu belongs to someone else. Run the command yourself.', flags: 64 });
      if ((await handle(i, col, msg)) === 'handled') return;
      await i.update(await render());
    } catch (e) {
      console.error('menu error:', e);
      const p = { content: `⚠️ ${e.message}`, flags: 64 };
      (i.deferred || i.replied ? i.followUp(p) : i.reply(p)).catch(() => {});
    }
  });
  col.on('end', () => msg.edit({ components: [] }).catch(() => {}));
  return msg;
}

/** Shows a pop-up form for component interaction `i`; resolves with the submit interaction (or null on timeout). */
async function askModal(i, title, fields) {
  const id = 'md_' + i.id;
  const m = new ModalBuilder().setCustomId(id).setTitle(title.slice(0, 45));
  for (const f of fields) {
    const t = new TextInputBuilder().setCustomId(f.id).setLabel(f.label.slice(0, 45))
      .setStyle(f.long ? TextInputStyle.Paragraph : TextInputStyle.Short).setRequired(f.required !== false).setMaxLength(f.max || 1000);
    if (f.value !== undefined && f.value !== null && String(f.value) !== '') t.setValue(String(f.value).slice(0, f.max || 1000));
    m.addComponents(new ActionRowBuilder().addComponents(t));
  }
  await i.showModal(m);
  return i.awaitModalSubmit({ time: 180000, filter: x => x.customId === id && x.user.id === i.user.id }).catch(() => null);
}

module.exports = { runMenu, askModal };
