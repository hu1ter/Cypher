require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Client, GatewayIntentBits: I, Partials, Collection, PermissionsBitField, ActivityType } = require('discord.js');
const db = require('./db');
const { Ctx, UsageError, tokenize, parseArgs, slashOpts, toSlash, usage } = require('./context');
const { isOwner } = require('./util');

const client = new Client({
  intents: [I.Guilds, I.GuildMembers, I.GuildModeration, I.GuildMessages, I.MessageContent, I.GuildVoiceStates, I.GuildWebhooks],
  partials: [Partials.Message, Partials.Channel],
});
client.commands = new Collection();
client.aliases = new Collection();

// ---- load modules (each exports { commands, init? }) ----
const modules = [];
for (const f of fs.readdirSync(path.join(__dirname, 'modules')).filter(f => f.endsWith('.js'))) {
  const mod = require('./modules/' + f);
  modules.push(mod);
  for (const c of mod.commands || []) {
    c.category ??= mod.category || f.replace('.js', '');
    client.commands.set(c.name, c);
    (c.aliases || []).forEach(a => client.aliases.set(a, c.name));
  }
}
const getCommand = n => client.commands.get(n) || client.commands.get(client.aliases.get(n));

async function execute(cmd, ctx) {
  try {
    if (!ctx.guild) return ctx.reply('Commands only work inside servers.');
    const owner = isOwner(ctx.user.id);
    if (cmd.ownerOnly && !owner) return ctx.reply('❌ Only the bot owner can use this.');
    if (cmd.guildOwnerOnly && !owner && ctx.guild.ownerId !== ctx.user.id) return ctx.reply('❌ Only the server owner can use this.');
    if (cmd.perms && !owner && !ctx.member.permissions.has(cmd.perms))
      return ctx.reply(`❌ You need: **${new PermissionsBitField(cmd.perms).toArray().join(', ')}**`);
    const botPerms = cmd.botPerms || cmd.perms;
    if (botPerms && !ctx.guild.members.me.permissions.has(botPerms))
      return ctx.reply(`❌ I need: **${new PermissionsBitField(botPerms).toArray().join(', ')}**`);
    await cmd.run(ctx);
  } catch (e) {
    if (e instanceof UsageError) return ctx.reply(e.message).catch(() => {});
    console.error(`[${cmd.name}]`, e);
    ctx.reply(`⚠️ Something went wrong: ${e.message}`).catch(() => {});
  }
}

// ---- prefix + no-prefix handler ----
client.on('messageCreate', async msg => {
  if (msg.author.bot || !msg.guild) return;
  const prefix = db.guild(msg.guild.id).prefix || process.env.PREFIX || '!';
  const c = msg.content;
  const mention = c.match(new RegExp(`^<@!?${client.user.id}>\\s*`));
  let body = null;
  if (c.startsWith(prefix)) body = c.slice(prefix.length);
  else if (mention) body = c.slice(mention[0].length);
  else if (db.data.noprefix.includes(msg.author.id)) body = c;   // no-prefix users
  if (body === null) return;
  if (mention && !body.trim()) return msg.reply({ content: `My prefix here is \`${prefix}\` — try \`${prefix}help\``, allowedMentions: { parse: [] } });

  const [name, ...rest] = tokenize(body);
  const cmd = name && getCommand(name.toLowerCase());
  if (!cmd) return;
  const ctx = new Ctx(client, msg, { prefix });
  try { ctx.opts = await parseArgs(cmd, ctx, rest); }
  catch (e) {
    if (e instanceof UsageError) return ctx.reply(`${e.message}\nUsage: \`${prefix}${cmd.name} ${usage(cmd)}\``).catch(() => {});
    return console.error(e);
  }
  execute(cmd, ctx);
});

// ---- slash handler ----
client.on('interactionCreate', async i => {
  if (!i.isChatInputCommand()) return;
  const cmd = client.commands.get(i.commandName);
  if (!cmd) return;
  const ctx = new Ctx(client, i);
  ctx.opts = slashOpts(cmd, i);
  execute(cmd, ctx);
});

client.once('clientReady', async () => {
  console.log(`Logged in as ${client.user.tag}`);
  client.user.setActivity('/help | !help', { type: ActivityType.Playing });
  try {
    await client.application.commands.set([...client.commands.values()].map(toSlash));
    console.log(`Registered ${client.commands.size} slash commands`);
  } catch (e) { console.error('Slash registration failed:', e.message); }
});

for (const m of modules) m.init?.(client);
process.on('unhandledRejection', e => console.error('Unhandled:', e));
client.login(process.env.TOKEN);
