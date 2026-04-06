# Ecommerce Product Catalog Example

Extract and reconcile product listings across multiple online stores.

## Highlights

- **Multi-site seeds** — crawls two stores and reconciles products across them
- **Composite key matching** — identifies the same product listed on different sites
- **Hybrid schema** — starts with defined fields, discovers new ones automatically
- **Model routing** — uses fast models for page classification, accurate models for extraction
- **Provenance tracking** — every field records which source it came from

## Usage

```bash
cp spatula.yaml /path/to/my-project/
cd /path/to/my-project
spatula init
spatula run
```

## Configuration Notes

- `safety: balanced` auto-approves low-risk schema changes, queues high-risk ones for `spatula review`
- `reconciliation.strategy: composite_key` uses product name + brand + category to match entities
- `depth: 3` follows product pages 3 levels deep from seed URLs
