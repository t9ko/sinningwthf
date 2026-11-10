FROM node:22-alpine
WORKDIR /app
COPY package.json server.js games-shim.js ./
COPY public ./public
ENV DATA_DIR=/data
EXPOSE 3000
CMD ["node", "server.js"]
