# sinning

A private hangout site with three parts:

- **Home**: the landing page. Pick Chat or Games, or swap between them any time from the bar at the top.
- **Chat**: username + password accounts, friend requests, one-to-one chats and **group chats**,
  a site-wide **news channel**, replies, reactions, editing, read receipts, images, voice messages,
  GIFs, emoji, disappearing messages, your own colour and background per chat, **voice calls**
  (one-to-one and group) with mute, blocking, and profiles with a picture and banner.
- **Games**: the whole DuckMath library, loaded through this site's own server.

Plus a **tab cloak** (make the tab look like Gmail, Google Classroom, Docs or Drive), profiles with
a picture and a banner, changeable usernames, sounds and desktop notifications.

There is nothing to install except Node.js. The whole site is this folder.

## 1. Run it on your own computer

1. Install Node.js 22 or newer from https://nodejs.org (the LTS download).
2. Windows: double-click `start.bat`. Mac/Linux: run `node server.js` in this folder.
3. The site opens at http://localhost:3000

## 2. Use it from other computers, phones and Wi-Fi networks

### Fastest: your PC is the server (free, about one minute)

Double-click `go-online.bat`. It starts the chat and opens a secure tunnel to the internet.
A link that ends in `.trycloudflare.com` appears in the window. Anyone with that link can open the
site from anywhere, on any Wi-Fi or mobile data, with https (so voice messages work too).

- The site is online only while that window is open and your PC is on.
- The link changes every time you run it, so send friends the new one.
- Accounts and messages are kept in the `data` folder between runs.
- Mac/Linux: install cloudflared, then run `sh go-online.sh`.

### Same Wi-Fi only

Run `start.bat`. The window prints an address like `http://192.168.1.20:3000`. Other devices on the
same Wi-Fi can open that. Voice messages are off this way because browsers only allow the
microphone on https.

### Always on, with your own domain (sinning.wtf)

For a site that stays up when your PC is off, put this folder on a host that runs Node.js
and keeps a disk (Railway, Render, Fly.io, or any VPS). GoDaddy's website builder cannot run it,
but the domain can stay at GoDaddy.

1. Put this folder in a GitHub repo.
2. Create a web service on the host from that repo. Start command: `node server.js`.
   Node version 22 or newer (a `Dockerfile` is included if the host asks for one).
3. Add a persistent disk/volume and set the environment variable `DATA_DIR` to where it is mounted
   (for example `/data`). Without a disk, accounts and messages are wiped on every restart.
4. In the host's custom domain settings, add your domain. It shows a DNS record (usually a CNAME).
   Add that record in GoDaddy under My Products > your domain > DNS.

## Games

The Games page shows https://duckmath.org, but your visitors' browsers never talk to duckmath.org.
They ask *your* site, and your server fetches the page and passes it along. So the address bar
stays on your site the whole time.

- **Where games come from** is one setting, `GAMES_UPSTREAM`. It defaults to `https://duckmath.org`.
  If you made your own DuckMath link with the FreeDNS guide, you can point it there instead, for
  example `GAMES_UPSTREAM=https://yourname.strangled.net`.
- **Games are kept in a locked box.** Game pages run inside a sandbox so their code cannot read
  your chats or act as the logged-in user. Game saves still work (the site stores them for the
  games, in the browser).
- **Speed.** Every game file travels games site -> your server -> the player, so your server's
  internet speed is the limit. Two things help:
  - *The file cache (on by default).* The first time anyone loads a game, its files are also saved
    in `data/games-cache`. After that they are sent straight from your disk. It keeps files for a
    day and uses up to 2 GB; change that with `GAMES_CACHE_MB` (0 turns it off).
  - *Turning the sandbox off* (`GAMES_ISOLATE=0`). Inside the sandbox a browser is not allowed to
    remember game files, so every visit downloads the whole game again. With the sandbox off, the
    browser keeps them and a game you have played before starts much faster. Some games also only
    work with it off. The cost: game code then runs with the same access as the chat itself, so
    only do it if you trust the games site. To turn it off on Windows, open `start.bat` and
    `go-online.bat` in Notepad and delete the word `rem` in front of `set GAMES_ISOLATE=0`.
- DuckMath keeps the games themselves on side addresses (`db.duckmath.org`, `db2.duckmath.org`
  and so on). Your site handles those too: they are loaded through addresses that start with
  `/~s/db/`, `/~s/db2/` on your own site, so you do not need a `db.` version of your domain.
- Game pages are never kept in the browser's cache, so after you update the site nobody is left
  with an old copy.
- A game that pulls files from some *other* website (not DuckMath) still loads those straight
  from that website, so those can be blocked on networks that block that website.
- Your server has to be able to reach the games site. If the server itself is on a network that
  blocks it, the Games page says so.

## Group chats, profiles and chat settings

- **Groups**: press "New group" above the chat list, name it and tick the friends to put in it.
  Anyone in a group can add their own friends later. The person who made it is the **master**:
  only they can kick people, rename the group, or hand the master role to someone else (all in
  chat settings, the gear at the top). Anyone can leave. If the master leaves, the
  longest-standing member takes over. New members do not see messages from before they joined.
- **Group calls**: the phone button at the top of a group starts a voice call and rings everyone
  in the group who is online. Anyone in the group can join or leave while it is going (the button
  turns green when a call is on). Up to 8 people. Like one-to-one calls, audio goes directly
  between browsers, so each person connects to every other person in the call.
- **Profiles**: someone's picture shows next to what they send. Click it (or the name at the top
  of a chat) to see their profile: picture, banner, username and when the account was made. You
  can send a friend request from there to someone you only know through a group.
- **Banner**: click your name (top right) and use "Change banner".
- **Chat settings** (the gear at the top of a chat):
  - *Disappearing messages*: off, 1 minute, 1 hour, 24 hours or 7 days. It applies to everyone in
    the chat and to messages sent after it is turned on. They are deleted from the server too.
  - *Your bubble colour* and *Background*: only you see these. You can upload your own background
    picture.
  - Delete chat, unfriend or leave group are in here as well.

## The admin account, news channel, and stats

One account runs the site. It is **`kolton`** by default (change it with the `ADMIN_USER`
setting). That account, and only that account, gets:

- A **Stats** button at the top: total users, how many are online and offline right now, the
  newest sign-up, and the full list of every username that has signed up with their online state.
- The **news channel**, a chat that everyone is put into automatically when they sign up. Only
  the admin can post in it; everyone else can only read it and gets a notification when the admin
  posts. It always sits pinned at the top of the chat list.

The news channel is created automatically the first time the server starts with the admin account
already in the database (or the moment that account signs up). Rename it with `NEWS_NAME`.

## Blocking

Open someone's profile (tap their picture or the name at the top of a chat) and press **Block**.
Blocking removes them from your friends, cancels any pending requests, and stops them adding you
again. Unblock from the same profile.

## Recently added

When you accept or make a new friend, that chat jumps to the top of your list, so the newest
people are easy to find.

## Voice calls

Open a chat and press the green phone button. The other person gets a ringing card with accept and
decline. During a call you can mute, leave, and keep using chat or games.

- Calls need the microphone, and browsers only allow that on `https://` (the online link) or on
  `localhost`. They do not work on the plain `http://192.168...` same-Wi-Fi address.
- Audio goes directly between the two browsers. On some strict networks (some schools and offices)
  a direct connection is not possible and the call will say it could not connect. Fixing that needs
  a relay ("TURN") server, which you can add with the `ICE_SERVERS` setting, for example
  `ICE_SERVERS=[{"urls":"turn:your.turn.host:3478","username":"u","credential":"p"}]`.

## Tab cloak

The first time someone opens the site it offers to cloak the tab as Gmail or Google Classroom, or
skip. It only changes the tab's name and little icon. Change it later with the mask button at the
top. The choice is remembered per browser. The icons are fetched once by your server from Google,
so the server needs internet access for them to show.

## Turn on GIFs

1. Make a free account at https://developers.giphy.com and create an API key.
2. Windows: open `start.bat` and `go-online.bat` in Notepad and add this line under `cd /d "%~dp0"`:

```
set GIPHY_API_KEY=your_key_here
```

On a host, add `GIPHY_API_KEY` as an environment variable in its dashboard instead.

## Settings (environment variables)

| Name            | What it does                              | Default  |
| --------------- | ----------------------------------------- | -------- |
| `PORT`          | Port the server listens on                | `3000`   |
| `DATA_DIR`      | Where the database and uploads are stored | `./data` |
| `GIPHY_API_KEY` | Enables GIF search                        | off      |
| `GAMES_UPSTREAM`| Site the Games page loads from            | `https://duckmath.org` |
| `GAMES_ISOLATE` | `0` turns off the games sandbox           | on       |
| `GAMES_CACHE_MB`| Disk space for saved game files, in MB    | `2048`   |
| `ADMIN_USER`    | The username that runs the site           | `kolton` |
| `NEWS_NAME`     | Name of the news channel                  | `News`   |
| `ICE_SERVERS`   | JSON list of STUN/TURN servers for calls  | public STUN |

## How things work

- Hover a message (tap it on a phone) to react, reply, edit or delete.
- Enter sends, Shift+Enter makes a new line, Up arrow edits your last message.
- Paste or drag an image into the chat to send it.
- "Delete" on a message removes it for both people. "Delete chat" clears the chat on your side only.
- Adding someone by username sends them a friend request. You become friends when they accept it.
  They can also decline, and you can cancel a request you sent.
- Click your name (top right) to change your picture or username, and for sound, notifications,
  tab cloak, change password and log out. Your username is also what you log in with.
- Everything that belongs to this site lives under addresses starting with `/~/`. Every other
  address is passed to the games site. That is how the two share one website without clashing.
- Passwords are stored hashed (scrypt), never in plain text. There is no password reset, since
  accounts have no email.
- Uploads are limited to 10 MB. Images: JPG, PNG, GIF, WEBP.

## Changing the look

- Site name: search for `sinning` in `public/index.html` and `public/app.js`.
- Tab cloak choices: the `CLOAKS` list in `public/app.js` and the `ICONS` list in `server.js`.
- Colors and animations: `public/style.css` (the variables at the top control the palette).
