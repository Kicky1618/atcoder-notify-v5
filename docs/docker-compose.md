# Docker Compose

Docker Compose で Web アプリ、スクレイピング用プロキシ、MariaDB、Redis をまとめて起動できます。

## 初回セットアップ

```bash
cp .env.example .env
```

必要に応じて `.env` の値を変更してください。特に `MARIADB_ROOT_PASSWORD` を変更した場合は、`DATABASE_URL` のパスワードも同じ値にしてください。

## 起動と停止

```bash
npm run compose:up
```

Web アプリは既定で <http://localhost:4080>、スクレイピング用プロキシは <http://localhost:4082>、MariaDB は `localhost:3306`、Redis は `localhost:6379` に公開されます。

```bash
npm run compose:logs
npm run compose:ps
npm run compose:down
```

## データベーススキーマ

コンテナ起動後、必要に応じて Prisma のスキーマを反映してください。

```bash
docker compose exec app npx prisma db push
```
