const db = require('../db');
const { embed } = require('../util');

// Access is checked by the main command dispatcher using OWNER_IDS.
// Do not replace ownerOnly with a Discord server permission check.
const commands = [{
  name: 'noprefix',
  aliases: ['np'],
  description: 'Manage users who can run commands without the prefix',
  ownerOnly: true,
  options: [
    {
      name: 'action',
      type: 'string',
      description: 'Add, remove, or list no-prefix users',
      required: true,
      choices: ['add', 'remove', 'list'],
    },
    {
      name: 'user',
      type: 'user',
      description: 'The user to add or remove',
    },
  ],

  run(ctx) {
    const { action, user } = ctx.opts;
    const users = db.data.noprefix;

    if (action === 'list') {
      const description = users.length
        ? users.map(id => `<@${id}> (\`${id}\`)`).join('\n')
        : 'No users currently have no-prefix access.';

      return ctx.reply({
        embeds: [
          embed()
            .setTitle(`No-prefix users (${users.length})`)
            .setDescription(description),
        ],
      });
    }

    if (!user) return ctx.reply('❌ Please provide a user mention or ID.');
    if (user.bot) return ctx.reply('❌ Bots cannot be given no-prefix access.');

    if (action === 'add') {
      if (users.includes(user.id)) {
        return ctx.reply(`ℹ️ **${user.username}** already has no-prefix access.`);
      }

      users.push(user.id);
      db.save();
      return ctx.reply(`✅ **${user.username}** can now use commands without a prefix.`);
    }

    if (action === 'remove') {
      if (!users.includes(user.id)) {
        return ctx.reply(`ℹ️ **${user.username}** does not have no-prefix access.`);
      }

      db.data.noprefix = users.filter(id => id !== user.id);
      db.save();
      return ctx.reply(`✅ Removed no-prefix access from **${user.username}**.`);
    }
  },
}];

module.exports = { category: 'Owner', commands };
