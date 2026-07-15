# Quickstart Example

Extract book data from [books.toscrape.com](https://books.toscrape.com) — a practice site for web scraping.

## Local Mode (recommended for getting started)

```bash
# Install Spatula
npm install -g @accidentally-awesome-labs/spatula --allow-scripts=better-sqlite3

# Guided setup + this same safe sample crawl
mkdir my-first-crawl && cd my-first-crawl
spatula
```

Press Enter when offered `books.toscrape.com`. Spatula configures the LLM and
browser, displays the 10-page plan and estimated cost, then previews results.

To use the checked-in configuration manually, copy `spatula.yaml` into a new
folder and run `spatula setup`, `spatula estimate`, and `spatula run`.

## Server Mode

```bash
# Start database services
docker compose up -d

# Copy .env.example from repo root and configure
cp ../../.env.example .env

# Run migrations
pnpm --filter @accidentally-awesome-labs/spatula-db db:migrate

# Start the API server
pnpm --filter @accidentally-awesome-labs/spatula-api start
```

## What This Extracts

| Field          | Type     | Example                |
| -------------- | -------- | ---------------------- |
| `title`        | string   | "A Light in the Attic" |
| `price`        | currency | 51.77                  |
| `availability` | string   | "In stock"             |
| `rating`       | number   | 3                      |
