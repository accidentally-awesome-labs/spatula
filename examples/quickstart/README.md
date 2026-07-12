# Quickstart Example

Extract book data from [books.toscrape.com](https://books.toscrape.com) — a practice site for web scraping.

## Local Mode (recommended for getting started)

```bash
# Install Spatula
npm install -g @spatula/cli

# Initialize from this example
cp spatula.yaml /path/to/my-project/
cd /path/to/my-project
spatula init

# Configure your LLM provider
spatula setup

# Run the crawl
spatula run

# Explore results
spatula explore

# Export data
spatula export --format json
```

## Server Mode

```bash
# Start database services
docker compose up -d

# Copy .env.example from repo root and configure
cp ../../.env.example .env

# Run migrations
pnpm --filter @spatula/db db:migrate

# Start the API server
pnpm --filter @spatula/api start
```

## What This Extracts

| Field          | Type     | Example                |
| -------------- | -------- | ---------------------- |
| `title`        | string   | "A Light in the Attic" |
| `price`        | currency | 51.77                  |
| `availability` | string   | "In stock"             |
| `rating`       | number   | 3                      |
