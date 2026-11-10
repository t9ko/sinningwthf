#!/bin/sh
# Mac / Linux: needs cloudflared installed (Mac: brew install cloudflared)
cd "$(dirname "$0")"
node server.js &
SERVER=$!
trap 'kill $SERVER' EXIT
sleep 2
echo "Your link (ends in .trycloudflare.com) appears below. Keep this window open."
cloudflared tunnel --url http://localhost:3000
