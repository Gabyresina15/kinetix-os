FROM node:22-slim

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
COPY fixtures ./fixtures

EXPOSE 4000

ENV PORT=4000
ENV ORCHESTRATOR_MODE=REPLAY

CMD ["npm", "start"]
