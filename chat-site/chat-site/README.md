# Chat site

A blacked-out private chat site. Username + password accounts, add friends by username, real-time
messages, replies, reactions, editing, read receipts, images, voice messages, GIPHY GIFs, emoji,
profile pictures, sounds and desktop notifications.

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

## How things work

- Hover a message (tap it on a phone) to react, reply, edit or delete.
- Enter sends, Shift+Enter makes a new line, Up arrow edits your last message.
- Paste or drag an image into the chat to send it.
- "Delete" on a message removes it for both people. "Delete chat" clears the chat on your side only.
- Adding someone by username makes you friends instantly on both sides.
- Settings (top left) has sound, desktop notifications, change password and log out.
- Passwords are stored hashed (scrypt), never in plain text. There is no password reset, since
  accounts have no email.
- Uploads are limited to 10 MB. Images: JPG, PNG, GIF, WEBP.

## Changing the look

- Site name: search for `sinning` in `public/index.html` and `public/app.js`.
- Colors and animations: `public/style.css` (the variables at the top control the palette).
