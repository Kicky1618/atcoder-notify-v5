# Build image for the scraping service
FROM node:20

WORKDIR /app

# Install dependencies from the monorepo
COPY package.json ./
COPY package-lock.json ./
RUN npm ci --verbose

# Copy scraping sources
COPY scraping ./scraping
COPY prisma ./prisma

RUN apt-get update && \
    apt-get install -y --no-install-recommends \
      wget \
      unzip \
      fontconfig \
      fonts-lato \
      fonts-noto-cjk && \
    rm -rf /var/lib/apt/lists/*

RUN npx prisma generate
# Build scraping project
RUN npm run build:scraping

# Run scraping service
EXPOSE 4082
CMD ["node", "scraping/dist/index.js"]
