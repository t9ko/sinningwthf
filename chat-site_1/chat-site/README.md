# sinning

A private hangout site with three parts:

- **Home**: the landing page. Pick Chat or Games, or swap between them any time from the bar at the top.
- **Chat**: username + password accounts, friend requests, real-time messages, replies, reactions,
  editing, read receipts, images, voice messages, GIFs, emoji, and **voice calls** with mute.
- **Games**: the whole DuckMath library, loaded through this site's own server.

Plus a **tab cloak** (make the tab look like Gmail, Google Classroom, Docs or Drive), profile
pictures, changeable usernames, sounds and desktop notifications.

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
- **If a game will not load or will not save**, the sandbox is the first thing to try turning off:
  set `GAMES_ISOLATE=0` and restart. Only do that if you trust the games site, because with it off,
  game code runs with the same access as the chat itself.
- A game that pulls files from some *other* website (not DuckMath) still loads those straight
  from that website, so those can be blocked on networks that block that website.
- Your server has to be able to reach the games site. If the server itself is on a network that
  blocks it, the Games page says so.

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
