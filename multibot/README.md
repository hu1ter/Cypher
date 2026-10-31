# Multipurpose Discord Bot (discord.js v14)

## Setup
1. Create an app at https://discord.com/developers/applications → Bot → copy the token.
2. Enable **all three Privileged Gateway Intents** (Presence not needed): *Server Members* and *Message Content* are required.
3. `cp .env.example .env` and fill in `TOKEN` and `OWNER_IDS` (your user ID).
4. `npm install` then `npm start`.
5. Invite with scopes `bot applications.commands` and the **Administrator** permission (needed for anti-nuke, backups, roles).
   Put the bot's role **at the top** of the role list.

Every command works as a prefix command (`!ban @user spam`) and a slash command (`/ban`).
Flags for prefix commands: `!gstart 1h 2 Nitro --role @Member --norole @Muted`

## Son 😭 command
`!son` searches Reddit for Son-meme images (needs `REDDIT_CLIENT_ID` / `REDDIT_CLIENT_SECRET` in `.env`).
Without those it falls back to your own list: `!sonadd <image url>` (bot owner only).
