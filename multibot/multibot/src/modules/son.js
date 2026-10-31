const db = require('../db');
const { embed } = require('../util');

const UA = 'multibot/1.0 (discord bot)';
let token = null, expires = 0;

// Reddit "app-only" OAuth (needs REDDIT_CLIENT_ID / REDDIT_CLIENT_SECRET in .env)
async function getToken() {
  const id = process.env.REDDIT_CLIENT_ID, secret = process.env.REDDIT_CLIENT_SECRET;
  if (!id || !secret) return null;
  if (token && Date.now() < expires) return token;
  const r = await fetch('https://www.reddit.com/api/v1/access_token', {
    method: 'POST', signal: AbortSignal.timeout(8000),
    headers: { Authorization: 'Basic ' + Buffer.from(`${id}:${secret}`).toString('base64'), 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': UA },
    body: 'grant_type=client_credentials',
  });
  const d = await r.json();
  if (!d.access_token) return null;
  token = d.access_token; expires = Date.now() + (d.expires_in - 60) * 1000;
  return token;
}

async function searchReddit(query, nsfwOk) {
  const t = await getToken();
  if (!t) return [];
  const sort = ['relevance', 'top', 'new', 'comments'][Math.floor(Math.random() * 4)];
  const params = new URLSearchParams({ q: query, sort, t: 'all', type: 'link', limit: '100', include_over_18: nsfwOk ? 'on' : 'off' });
  const r = await fetch(`https://oauth.reddit.com/search?${params}`, { headers: { Authorization: `Bearer ${t}`, 'User-Agent': UA }, signal: AbortSignal.timeout(8000) });
  if (!r.ok) return [];
  const d = await r.json();
  return (d.data?.children || []).map(c => c.data)
    .filter(p => /\.(png|jpe?g|gif|webp)(\?|$)/i.test(p.url) && (nsfwOk || !p.over_18) && !/kirk/i.test(p.title));   // skip the Kirk-face-swap variants
}

const commands = [
  { name: 'son', description: 'Random "Son 😭" meme image', aliases: ['son😭'],
    options: [{ name: 'query', type: 'string', description: 'Search terms (default: anthony mackie son meme)', rest: true }],
    async run(ctx) {
      await ctx.defer();
      const nsfwOk = !!ctx.channel.nsfw;
      let posts = [];
      try { posts = await searchReddit(ctx.opts.query || 'anthony mackie son meme', nsfwOk); } catch (e) { console.error('son search:', e.message); }
      if (posts.length) {
        const p = posts[Math.floor(Math.random() * posts.length)];
        return ctx.reply({ embeds: [embed(0xff4500).setTitle(p.title.slice(0, 250)).setURL('https://reddit.com' + p.permalink).setImage(p.url).setFooter({ text: `r/${p.subreddit} • 👍 ${p.score}` })] });
      }
      const list = db.data.son || [];
      if (list.length) return ctx.reply({ embeds: [embed(0xff4500).setImage(list[Math.floor(Math.random() * list.length)])] });
      ctx.reply('😭 No images yet. The bot owner needs to set `REDDIT_CLIENT_ID`/`REDDIT_CLIENT_SECRET` in `.env` or add images with `sonadd <image url>`.');
    } },
  { name: 'sonadd', description: 'Bot owner: add an image URL to the local Son list', ownerOnly: true,
    options: [{ name: 'url', type: 'string', description: 'Direct image URL', required: true }],
    run(ctx) {
      if (!/^https?:\/\/\S+$/i.test(ctx.opts.url)) return ctx.reply('❌ Provide a direct http(s) image URL.');
      (db.data.son ||= []).push(ctx.opts.url); db.save(); ctx.reply(`✅ Added (${db.data.son.length} saved).`);
    } },
  { name: 'sonremove', description: 'Bot owner: remove an image URL from the local Son list', ownerOnly: true,
    options: [{ name: 'url', type: 'string', description: 'URL to remove', required: true }],
    run(ctx) { db.data.son = (db.data.son || []).filter(u => u !== ctx.opts.url); db.save(); ctx.reply('✅ Removed.'); } },
];

module.exports = { category: 'Fun', commands };
