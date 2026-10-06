FROM node:22-alpine
WORKDIR /app
COPY package.json ./
COPY src ./src
ENV NODE_ENV=production DB_PATH=/data/slsea.db PORT=3000
RUN mkdir -p /data
EXPOSE 3000
CMD ["node", "src/index.js"]
