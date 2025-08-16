# AutoStatsCan

Lightweight Node.js utility that downloads one or more Statistics Canada (or any CSV) datasets and ingests them into a local SQLite database. Tables and column names are auto-created from CSV headers with safe name sanitization. Optionally keeps the raw CSVs for auditing. Can be used to autogenerate reports and graphs.

> **Version:** 1 (2024‑11‑09)\
> **Author:** Slyke

---

## Features

- **Zero-setup ingestion**: streams CSV → SQLite in one pass.
- **Auto table creation**: one SQLite table per CSV; columns derived from headers.
- **Safe naming**: table & column names sanitized to `[A‑Za‑z0‑9_]`.
- **Streaming parser**: handles large CSVs without loading into RAM.
- **WAL mode**: enables concurrent readers while ingesting.
- **Optional CSV retention**: keep CSVs under a date‑stamped directory for provenance.

---

## How it works

1. Opens/creates `./autostatscan.db` and enables `PRAGMA journal_mode = WAL`.
2. For each entry in `urls.json5`:
   - Downloads the CSV via `fetch(url)`.
   - Saves a temporary copy in `./csvtmp/YYYY‑MM‑DD/<index>.csv` (if retention enabled).
   - Creates a SQLite table named after the dataset (sanitized).
   - Streams rows with `csv-parser`, inserting each non-empty row as `TEXT` fields.
3. Writes `./csvtmp/YYYY‑MM‑DD/index.json` mapping numeric index → dataset name (if retention enabled).
4. Closes the DB.

---

## Requirements

- **Node.js ≥ 18** (uses built‑in `fetch`).
- **npm** to install dependencies.
- Build tools may be required for `sqlite3` native module (Linux: `build-essential`, Python 3).

**Dependencies**

- [`sqlite3`](https://www.npmjs.com/package/sqlite3)
- [`csv-parser`](https://www.npmjs.com/package/csv-parser)
- [`json5`](https://www.npmjs.com/package/json5)

---

## Installation

```bash
# clone / copy your project files first
npm install
# or
npm install sqlite3 csv-parser json5
```

Project files expected in the same directory:

- `index.js` (this script; name can vary)
- `urls.json5` (list of dataset names + URLs)

---

## Configure datasets (`urls.json5`)

`urls.json5` is read with JSON5, so comments and trailing commas are allowed.

Two valid formats are supported. Pick **one**.

### A) Array of `[name, url]` pairs (recommended)

```json5
[
  ["Census_Population_2021", "https://www150.statcan.gc.ca/.../pop2021.csv"],
  ["CPI_All_Items", "https://www150.statcan.gc.ca/.../cpi.csv"],
]
```

### B) Object mapping `name → url`

```json5
{
  Census_Population_2021: "https://www150.statcan.gc.ca/.../pop2021.csv",
  CPI_All_Items: "https://www150.statcan.gc.ca/.../cpi.csv",
}
```

**Notes**

- `name` becomes the **table name** (after sanitization).
- Use concise, unique names; the script will create one SQLite table per entry.

---

## Usage

```bash
node index.js
```

On first run you should see logs like:

```
Database connected successfully
Fetching CSV (0) for: Census_Population_2021
CSV data inserted into Census_Population_2021 table successfully.
...
Database connection closed
```

---

## Outputs

- **SQLite DB**: `./autostatscan.db`
  - One table per dataset; all columns stored as `TEXT`.
- **CSV retention (default: on)**: `./csvtmp/YYYY‑MM‑DD/`
  - `<index>.csv`: raw CSVs as fetched.
  - `index.json`: maps numeric index → dataset name for traceability.

To disable CSV retention, set `keepCsv = false` in the script.

---

## Table & column naming (sanitization)

- Table names: `sanitizeTableName(name)` → replace any character not in `[A‑Za‑z0‑9_]` with `_`.
- Column names: header strings are sanitized the same way.
- Implication: headers like `"Ref Date"` become `Ref_Date`.

---

## Data typing & schema

- Every column is created as `TEXT`.
- There is **no primary key**, **no type inference**, and **no deduplication**.
- If the same CSV is ingested multiple times, duplicate rows may accumulate.

> If you need typed columns, keys, or upserts, extend `createTableIfNotExists` and use `INSERT OR REPLACE` with a suitable key.

---

## Error handling (current behavior)

- **Network errors / non‑200 responses**: logged; that dataset is skipped; ingestion continues.
- **Empty headers**: aborts that dataset with an error.
- **Row insert errors**: logs the SQL and error; continues with subsequent rows.
- **Parser errors**: logged; dataset is aborted.

All other datasets continue processing.

---

## Performance notes

- Inserts are executed row‑by‑row. With large CSVs, this can be slow.
- WAL mode helps readers but does **not** batch writes.

**Ideas for heavy loads (not implemented):**

- Wrap inserts in explicit transactions per file for major speedups.
- Use prepared statements (`db.prepare`) with `run` in a tight loop.
- Add simple type inference (e.g., INTEGER/REAL detection).
- Parallel downloads with a concurrency limit.

---

## Troubleshooting

- `Error opening database`: ensure the process has write permissions in the working directory.
- `Failed to create table for <table>`: check for conflicting sanitized names; two different headers may sanitize to the same column name.
- `No headers found in CSV`: the CSV may be empty or not comma‑separated; inspect the saved CSV in `csvtmp/...`.
- `sqlite3 build errors`** build errors**: install build tools (Linux: `sudo apt-get install -y build-essential python3 make g++`).
- **Slow ingestion**: see performance notes; consider adding transaction batching.

---

## Optional: Docker

A minimal container for reproducible runs.

```dockerfile
# Dockerfile
FROM node:22-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates python3 make g++ sqlite3 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --production
COPY . .
CMD ["node", "index.js"]
```

Build & run:

```bash
docker build -t autostatscan:latest .
# mount a host folder if you want the DB and csvtmp persisted outside the container
docker run --rm -v "$PWD:/app" autostatscan:latest
```

---

## Security & privacy

- This tool fetches remote CSVs you specify; review URLs before running.
- Saved CSVs may contain sensitive data; treat `csvtmp/` and `autostatscan.db` accordingly.

---

## Verifying authorship (optional)

The source includes a **BlockChain Verify** stanza:

```
Message:   "AutoStatsCan by Slyke 2024-11-09"
Signature: "IMRf+BGj+RHCHOrpNBvgax2PX+YJPzJ3qIpsQF5hmtRGR9+dNyZ7jNyeI5cD9jZWMZ0hfL+Iq4dLUpQg4cJYfyU="
Address:   "bc1qvrk40pj4canfuqzcjt7g8ksxtjau2zzsq2lfjm"
```

To verify, use a wallet/tool that supports **BIP‑322 message verification** for Bech32 addresses and check that the message, signature, and address match.

- BIP‑322 spec: [https://github.com/bitcoin/bips/blob/master/bip-0322.mediawiki](https://github.com/bitcoin/bips/blob/master/bip-0322.mediawiki)

> Many wallets only support legacy `signmessage` with base58 addresses; use a BIP‑322‑aware tool for Bech32 verification.

---

## License

MIT

