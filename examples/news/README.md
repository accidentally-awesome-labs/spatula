# News Article Aggregation Example

Extract structured article data from news websites.

## Highlights

- **Schema discovery** — starts with basic fields, lets the LLM discover additional metadata
- **Cautious safety** — most schema changes require manual review via `spatula review`
- **Exact name matching** — articles are matched by headline (no fuzzy dedup needed)
- **Most recent wins** — when the same article is found multiple times, the latest version is kept

## Usage

This is a template configuration. Replace the placeholder seed URL with a site
you own or have permission to crawl before running it.

```bash
cp spatula.yaml /path/to/my-project/
cd /path/to/my-project
spatula init
spatula run
spatula review   # Review discovered schema changes
spatula export --format csv
```
