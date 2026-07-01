# Build image for AtCoder Notify V5 except scraping
FROM node:20

WORKDIR /app

# Install root dependencies
COPY package.json ./
COPY package-lock.json ./
RUN npm cache clean --force
RUN npm ci --verbose

# Install dependencies for subprojects
COPY frontend/package.json frontend/package.json
RUN npm install --prefix frontend

COPY backend/package.json backend/package.json
RUN npm install --prefix backend

COPY backend/web/package.json backend/web/package.json
RUN npm install --prefix backend/web

COPY judgement/package.json judgement/package.json
RUN npm install --prefix judgement

COPY status/package.json status/package.json
RUN npm install --prefix status

RUN apt-get update && \
    apt-get install -y --no-install-recommends \
      wget \
      unzip \
      fontconfig \
      fonts-lato \
      fonts-noto-cjk && \
    rm -rf /var/lib/apt/lists/*
# Squada One を Google Fonts からダウンロードして配置
RUN mkdir -p /usr/share/fonts/truetype/squadaone && \
    wget -qO /usr/share/fonts/truetype/squadaone/SquadaOne-Regular.ttf \
      https://github.com/google/fonts/raw/main/ofl/squadaone/SquadaOne-Regular.ttf

# フォントキャッシュを強制更新
RUN fc-cache -f -v

# Copy project source excluding scraping
COPY backend ./backend
COPY backend/web ./backend/web
COPY frontend ./frontend
COPY status ./status
COPY fonts ./fonts
COPY docs ./docs
COPY prisma ./prisma
RUN npx prisma generate

# Build subprojects except scraping
RUN npm run build:frontend:release && npm run build:backend

EXPOSE 4080
CMD ["npm", "start"]