const { embed, fetchJson } = require('../util');
const { redditAliases } = require('../config');

const image = (ctx, e) => ctx.reply({ embeds: [e] });

async function redditPost(ctx, sub) {
  if (!/^[A-Za-z0-9_]{2,21}$/.test(sub)) return ctx.reply('❌ Invalid subreddit name.');
  await ctx.defer();
  let d;
  try { d = await fetchJson(`https://meme-api.com/gimme/${sub}`); } catch { return ctx.reply(`❌ Couldn't fetch from r/${sub} (it may be private/unsupported).`); }
  if (d.code || !d.url) return ctx.reply(`❌ ${d.message || 'No image found.'}`);
  if (d.nsfw && !ctx.channel.nsfw) return ctx.reply('🔞 That post is NSFW — use an age-restricted channel.');
  image(ctx, embed(0xff4500).setTitle(d.title.slice(0, 250)).setURL(d.postLink).setImage(d.url).setFooter({ text: `r/${d.subreddit} • 👍 ${d.ups} • u/${d.author}` }));
}

const animal = (name, emoji, url, pick) => ({ name, description: `Random ${name} picture`, async run(ctx) {
  await ctx.defer();
  const d = await fetchJson(url);
  image(ctx, embed(0xf5a623).setTitle(`${emoji} ${name}`).setImage(pick(d)));
} });

const BALL = ['Yes.', 'No.', 'Maybe.', 'Definitely!', 'Absolutely not.', 'Ask again later.', 'Signs point to yes.', 'Very doubtful.', 'Without a doubt.', "Don't count on it."];
const RPS = ['rock', 'paper', 'scissors'];

const commands = [
  animal('cat', '🐱', 'https://api.thecatapi.com/v1/images/search', d => d[0].url),
  animal('dog', '🐶', 'https://dog.ceo/api/breeds/image/random', d => d.message),
  animal('fox', '🦊', 'https://randomfox.ca/floof/', d => d.image),
  { name: 'meme', description: 'Random meme', run: ctx => redditPost(ctx, 'memes') },
  { name: 'reddit', description: 'Random image post from any subreddit', options: [{ name: 'subreddit', type: 'string', description: 'Subreddit name', required: true }],
    run: ctx => redditPost(ctx, ctx.opts.subreddit.replace(/^r\//, '')) },
  ...Object.entries(redditAliases).map(([name, sub]) => ({ name, description: `Random post from r/${sub}`, run: ctx => redditPost(ctx, sub) })),
  { name: '8ball', description: 'Ask the magic 8-ball', options: [{ name: 'question', type: 'string', description: 'Your question', required: true, rest: true }],
    run: ctx => ctx.reply(`🎱 **${ctx.opts.question}**\n${BALL[Math.floor(Math.random() * BALL.length)]}`) },
  { name: 'coinflip', aliases: ['flip'], description: 'Flip a coin', run: ctx => ctx.reply(Math.random() < 0.5 ? '🪙 Heads!' : '🪙 Tails!') },
  { name: 'roll', aliases: ['dice'], description: 'Roll a die', options: [{ name: 'sides', type: 'integer', description: 'Sides (default 6)' }],
    run: ctx => { const s = Math.min(Math.max(ctx.opts.sides || 6, 2), 1000000); ctx.reply(`🎲 You rolled **${1 + Math.floor(Math.random() * s)}** (d${s})`); } },
  { name: 'rps', description: 'Rock paper scissors', options: [{ name: 'choice', type: 'string', description: 'rock, paper or scissors', required: true, choices: RPS }],
    run(ctx) {
      const me = RPS[Math.floor(Math.random() * 3)], you = ctx.opts.choice;
      const res = me === you ? "It's a tie!" : (RPS.indexOf(you) + 1) % 3 === RPS.indexOf(me) ? 'I win! 😎' : 'You win! 🎉';
      ctx.reply(`You: **${you}** • Me: **${me}**\n${res}`);
    } },
  { name: 'joke', description: 'Random joke',
    async run(ctx) { const d = await fetchJson('https://official-joke-api.appspot.com/random_joke'); ctx.reply(`${d.setup}\n||${d.punchline}||`); } },
];

module.exports = { category: 'Fun', commands };
