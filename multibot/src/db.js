const fs = require('fs');
const path = require('path');
const FILE = path.join(__dirname, '..', 'data', 'db.json');
fs.mkdirSync(path.dirname(FILE), { recursive: true });

const data = { guilds: {}, noprefix: [], giveaways: {} };
try { Object.assign(data, JSON.parse(fs.readFileSync(FILE, 'utf8'))); } catch {}

let timer;
function save() {
  clearTimeout(timer);
  timer = setTimeout(() => {
    fs.writeFile(FILE + '.tmp', JSON.stringify(data), err => { if (!err) fs.rename(FILE + '.tmp', FILE, () => {}); });
  }, 400);
}

const defaults = () => ({
  prefix: null,
  logs: {},
  warnings: {},
  antinuke: { enabled: false, whitelist: [], punishment: 'ban', limit: 3, window: 10 },
  automod: { enabled: false, links: false, invites: false, spam: false, caps: false, mentions: 0, badwords: [] },
});

function fill(obj, def) {
  for (const k of Object.keys(def)) {
    if (obj[k] === undefined) obj[k] = def[k];
    else if (def[k] && typeof def[k] === 'object' && !Array.isArray(def[k])) fill(obj[k], def[k]);
  }
  return obj;
}

function guild(id) {
  data.guilds[id] = fill(data.guilds[id] || {}, defaults());
  return data.guilds[id];
}

process.on('SIGINT', () => { fs.writeFileSync(FILE, JSON.stringify(data)); process.exit(0); });
module.exports = { data, save, guild };
