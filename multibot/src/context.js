const { ApplicationCommandOptionType: T, PermissionsBitField } = require('discord.js');

class UsageError extends Error {}
const TYPES = { string: T.String, integer: T.Integer, boolean: T.Boolean, user: T.User, role: T.Role, channel: T.Channel };

/** One context object for both prefix messages and slash interactions. */
class Ctx {
  constructor(client, source, extra = {}) {
    this.client = client;
    this.source = source;
    this.isSlash = typeof source.isChatInputCommand === 'function';
    this.guild = source.guild;
    this.channel = source.channel;
    this.user = this.isSlash ? source.user : source.author;
    this.member = source.member;
    this.prefix = extra.prefix || '/';
    this.opts = {};
  }

  async defer() {
    if (this.isSlash) { if (!this.source.deferred && !this.source.replied) await this.source.deferReply(); }
    else this.channel.sendTyping().catch(() => {});
  }

  async reply(p) {
    if (typeof p === 'string') p = { content: p };
    p = { allowedMentions: { parse: [] }, ...p };
    if (this.isSlash) {
      const s = this.source;
      if (s.deferred && !s.replied) return s.editReply(p);
      if (s.replied) return s.followUp(p);
      await s.reply(p);
      return s.fetchReply();
    }
    return this.source.reply({ ...p, failIfNotExists: false }).catch(() => this.channel.send(p));
  }
}

function tokenize(str) {
  const out = [], re = /"([^"]*)"|(\S+)/g;
  let m;
  while ((m = re.exec(str))) out.push(m[1] ?? m[2]);
  return out;
}

async function resolveValue(d, raw, ctx) {
  const { guild, client } = ctx;
  const id = raw.match(/\d{17,20}/)?.[0];
  switch (d.type) {
    case 'integer': {
      const n = parseInt(raw);
      if (isNaN(n)) throw new UsageError(`❌ **${d.name}** must be a number.`);
      return n;
    }
    case 'boolean': return ['true', 'yes', 'y', 'on', '1'].includes(raw.toLowerCase());
    case 'user': {
      if (id) return client.users.fetch(id).catch(() => { throw new UsageError('❌ User not found.'); });
      const found = (await guild.members.search({ query: raw.replace(/^@/, ''), limit: 1 }).catch(() => null))?.first();
      if (found) return found.user;
      throw new UsageError('❌ User not found. Use a mention or ID.');
    }
    case 'role': {
      const r = (id && guild.roles.cache.get(id)) || guild.roles.cache.find(x => x.name.toLowerCase() === raw.replace(/^@/, '').toLowerCase());
      if (!r) throw new UsageError('❌ Role not found.');
      return r;
    }
    case 'channel': {
      const c = (id && guild.channels.cache.get(id)) || guild.channels.cache.find(x => x.name.toLowerCase() === raw.replace(/^#/, '').toLowerCase());
      if (!c) throw new UsageError('❌ Channel not found.');
      return c;
    }
    default: return d.choices ? raw.toLowerCase() : raw;
  }
}

async function parseArgs(cmd, ctx, tokens) {
  const defs = cmd.options || [], flags = {}, rest = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.startsWith('--') && defs.some(o => o.name === t.slice(2))) flags[t.slice(2)] = tokens[++i];
    else rest.push(t);
  }
  const opts = {};
  let idx = 0;
  for (const d of defs) {
    let raw;
    if (flags[d.name] !== undefined) raw = flags[d.name];
    else if (d.rest) { raw = rest.slice(idx).join(' ') || undefined; idx = rest.length; }
    else raw = rest[idx++];
    if (raw === undefined || raw === '') {
      if (d.required) throw new UsageError(`❌ Missing **${d.name}**.`);
      continue;
    }
    if (d.choices && !d.choices.includes(raw.toLowerCase())) throw new UsageError(`❌ **${d.name}** must be one of: ${d.choices.join(', ')}`);
    opts[d.name] = await resolveValue(d, raw, ctx);
  }
  return opts;
}

function slashOpts(cmd, i) {
  const o = {};
  for (const d of cmd.options || []) {
    let v;
    switch (d.type) {
      case 'user': v = i.options.getUser(d.name); break;
      case 'role': v = i.options.getRole(d.name); if (v) v = i.guild.roles.cache.get(v.id) || v; break;
      case 'channel': v = i.options.getChannel(d.name); if (v) v = i.guild.channels.cache.get(v.id) || v; break;
      case 'integer': v = i.options.getInteger(d.name); break;
      case 'boolean': v = i.options.getBoolean(d.name); break;
      default: v = i.options.getString(d.name);
    }
    if (v !== null && v !== undefined) o[d.name] = v;
  }
  return o;
}

const usage = cmd => (cmd.options || []).map(o => (o.required ? `<${o.name}>` : `[${o.name}]`)).join(' ');

function toSlash(cmd) {
  return {
    name: cmd.name,
    description: (cmd.description || cmd.name).slice(0, 100),
    dm_permission: false,
    default_member_permissions: cmd.perms ? new PermissionsBitField(cmd.perms).bitfield.toString() : undefined,
    options: (cmd.options || []).map(o => ({
      name: o.name,
      description: (o.description || o.name).slice(0, 100),
      type: TYPES[o.type] || T.String,
      required: !!o.required,
      choices: o.choices?.map(c => ({ name: c, value: c })),
    })),
  };
}

module.exports = { Ctx, UsageError, tokenize, parseArgs, slashOpts, toSlash, usage };
