FROM node:22-alpine
WORKDIR /app
COPY package.json server.js games-shim.js migrate-to-firebase.js ./
COPY public ./public
ENV DATA_DIR=/data
EXPOSE 3000
# runs the one-time Firebase mover first (it does nothing unless FIREBASE_SERVICE_ACCOUNT is set), then the site
CMD ["sh", "-c", "node migrate-to-firebase.js; exec node server.js"]
