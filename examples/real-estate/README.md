# Real Estate Listings Example

Extract property listings with structured location, pricing, and feature data.

## Highlights

- **Fuzzy entity matching** — matches listings even when addresses differ slightly ("123 Main St" vs "123 Main Street")
- **Array fields** — captures multiple image URLs per property
- **Enum fields** — constrains property type and listing status to known values
- **SQLite export** — outputs a queryable database for analysis
- **Low concurrency** — polite crawling at 3 concurrent requests

## Usage

```bash
cp spatula.yaml /path/to/my-project/
cd /path/to/my-project
spatula init
spatula run
spatula export --format sqlite --output properties.db
```

## Querying the Export

```bash
sqlite3 properties.db "SELECT address, price, bedrooms FROM entities WHERE bedrooms >= 3 ORDER BY price"
```
