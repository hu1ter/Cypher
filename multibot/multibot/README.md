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

## Interactive menus
`/help`, `/logs`, `/automod`, `/antinuke`, `/giveaway`, `/backup` (with no arguments) and `/modpanel` open button/dropdown menus.
Music has playback buttons on every "Now playing" message. All commands also still work with arguments, e.g. `!ban @user spam`.


## No-prefix command (bot owner only)

Set `OWNER_IDS` in `.env` to your Discord user ID. Only IDs in `OWNER_IDS` can manage no-prefix access; server ownership and administrator permissions do not grant access.

- `!noprefix add @user` — grant no-prefix access.
- `!noprefix remove @user` — remove no-prefix access.
- `!noprefix list` — list users with access.
- The equivalent `/noprefix` slash command is also available.

Users on the list can run existing bot commands without the configured prefix. Access is saved in `data/db.json`.
