const db = require('../db');
const { embed } = require('../util');

const commands = [{
  name: 'noprefix', aliases: ['np'], description: 'Bot owner only: manage no-prefix users', ownerOnly: true,
  options: [
    { name: 'action', type: 'string', description: 'add, remove or list', required: true, choices: ['add', 'remove', 'list'] },
    { name: 'user', type: 'user', description: 'User' },
  ],
  run(ctx) {
    const { action, user } = ctx.opts, list = db.data.noprefix;
    if (action === 'list')
      return ctx.reply({ embeds: [embed().setTitle(`No-prefix users (${list.length})`).setDescription(list.map(i => `<@${i}> \`${i}\``).join('\n') || 'None')] });
    if (!user) return ctx.reply('❌ Provide a user.');
    if (action === 'add') { if (!list.includes(user.id)) list.push(user.id); db.save(); return ctx.reply(`✅ **${user.username}** can now use commands without a prefix.`); }
    db.data.noprefix = list.filter(i => i !== user.id); db.save();
    ctx.reply(`✅ **${user.username}** no longer has no-prefix access.`);
  },
}];

module.exports = { category: 'Owner', commands };
