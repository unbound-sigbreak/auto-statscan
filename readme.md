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

`urls.json5` is read with JSON5, so comments and trailing commas are allowed:

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

## License

MIT

---

# Added functionality

> This section documents new components that build on the ingestion core without changing the instructions above. You can adopt them piecemeal.

## 1) Column auto-migrations (`table-migrations.json5`)

- Optional file to remap incoming column names → your preferred schema **on the fly** during ingest.
- Format: a JSON5 object where keys are incoming header names and values are target header names.
- Example:
  ```json5
  {
    "REF DATE": "REF_DATE",
    "Ref_Date": "REF_DATE",
    "VALUE ($)": "VALUE"
  }
  ```
- When present, the ingester will:
  - Ensure all **target** columns exist (adds missing columns).
  - Copy values from incoming → target, suppressing duplicate notifications after the first row.
  - Log total rows remapped per column pair at end of file.

## 2) Bank of Canada CSV metadata stripping

Some Bank of Canada CSVs contain a metadata preamble and an `OBSERVATIONS` section. The ingester auto-detects this pattern and parses only the `OBSERVATIONS` block. Logs show:
```
[BoC] Detected metadata-wrapped CSV; using OBSERVATIONS block only.
```

## 3) Local CSV ingestion

Entries in `urls.json5` may point to **local paths** as well as HTTP/HTTPS URLs. Local files are validated and ingested exactly like remote CSVs. Example:
```json5
[
  ["My_Local_File", "./crea_hpi_not_seasonally_adjusted_m.csv"]
]
```

## 4) Optional overwrite mode (per-table reset)

The ingester supports an internal toggle that, when turned on in the script, clears the target table before loading a CSV (wrapped in a transaction). This can help avoid duplicate accumulation across repeated runs.

- If **disabled**, the original behavior from the core docs remains: repeated ingests can accumulate duplicates.
- If **enabled**, you'll see logs like:
  ```
  [Overwrite] Cleared table My_Table before load.
  ```
> Note: This is a code-level toggle. Pick the mode that fits your workflow.

---

## 5) Dataset export + dashboard generator (`update.js` + `docs/`)

`update.js` turns SQL queries into compact JSON series for a simple client-side dashboard located at `docs/index.html` (Chart.js).

### 5.1 Manifest-driven export

Create `docs/data/manifest.json5` describing the series to export:

```json5
{
  datasets: [
    {
      id: "cpi_yoy",
      label: "CPI YoY (%)",
      unit: "percent",
      freq: "monthly",
      color: "#67b0ff",
      axis: "yRight",
      path: "cpi_yoy.json",
      source: {
        db: "./autostatscan.db",
        // Use named placeholders like {$q_series}; update.js will inject both raw and SQL-quoted variants
        query: "SELECT REF_DATE, VALUE, SCALAR_FACTOR FROM \"CPI_All_Items\" WHERE SERIES = {$q_series} ORDER BY REF_DATE ASC",
        params: { series: "CPI, all-items, % change" },
        // Optional: rescale VALUES to a common unit name ("units", "thousand", "million", "billion")
        scale_to: "units"
      }
    }
  ]
}
```

**Notes**

- `id`, `label`, `unit` (`"absolute"` or `"percent"`), `freq` (`"monthly" | "quarterly" | "yearly"`), and `path` are required for the front-end to display properly.
- `source.db` defaults to `./autostatscan.db` if omitted.
- `source.query` must select columns named **`REF_DATE`**, **`VALUE`**, and (optionally) **`SCALAR_FACTOR`**. The exporter will:
  - Parse `VALUE` as a number (tolerates commas).
  - Convert using `SCALAR_FACTOR` if present (`unit`, `thousand`, `million`, `billion`).
  - Optionally rescale to `scale_to` (e.g., convert millions → units for consistent charting).
- Placeholders:
  - **Named**: `{$name}` comes from `params: { name: "X" }`. The exporter also provides an auto-quoted twin `{$q_name}` for SQL (safe single-quoting).
  - **Positional (advanced)**: `{#1}`, `{#2}`, … or `{#n}` for array-style replacements.

Run the exporter:

```bash
node update.js               # will read ./docs/data/manifest.json5 by default
# or
node update.js ./docs/data/manifest.json5
```

Each dataset writes to `docs/data/<path>` with the shape:

```json5
{
  "id": "cpi_yoy",
  "label": "CPI YoY (%)",
  "labels": ["2000-01", "2000-02", "..."],
  "data": [2.1, 2.3, null, ...]
}
```

### 5.2 Dashboard (Chart.js, client-only)

- File: `docs/index.html`
- Loads `docs/data/manifest.json5` and each referenced dataset JSON file.
- Supports:
  - **Absolute / Percent / Mixed** unit modes.
  - Dual Y axes with per-axis **Linear/Log** scales.
  - Per-series **Left/Right** axis selection (when compatible).
  - Per-series **offset (months)** for alignment experiments.
  - Style controls (color, width, point radius), **export/import** style to JSON.
  - **Span gaps** toggle (connects across nulls for sparse series).
  - Manual Y min/max bounds per axis.
  - Series **error badges** (“Failed to load”) and **incompatibility** indicators.
- Hosting:
  - Any static web server works. Example:
    ```bash
    npx serve docs
    # then open http://localhost:3000 and ensure "Base URL" points to http://localhost:3000/data/
    ```
  - GitHub Pages: publish `docs/` and set Base URL to your site's `/data/` path via the control panel in the UI.

---

## 6) CREA HPI data (manual workflow, licensing-restricted)

**CREA's redistribution rules forbid committing their derived HPI data to this repository.** You must fetch and preprocess it locally before running the exporter and dashboard.

**Steps**

1. Visit **https://www.crea.ca/housing-market-stats/mls-home-price-index/hpi-tool/**.
2. Download the ZIP.
3. Open **`Not Seasonally Adjusted (M).xlsx`** from the ZIP.
4. Save that sheet as a **CSV** into this project directory (e.g., `./Not Seasonally Adjusted (M).csv`).  
   - Keep commas as separators; ensure the first row contains headers.
5. In your workflow, **run `pull.js`**, then **run `update.js`** to render the chart.
   - If you are using `urls.json5`, you can point an entry at the local CSV:
     ```json5
     [
       ["Not Seasonally Adjusted (M)", "./Not Seasonally Adjusted (M).csv"]
     ]
     ```
   - After ingestion, configure a dataset in `docs/data/manifest.json5` that selects `REF_DATE`, `VALUE`, and (optionally) `SCALAR_FACTOR` from the table created by your CSV.
6. Reload the dashboard (`docs/index.html`), ensure the **Base URL** points to your `docs/data/` directory.

> Reminder: Do **not** commit CREA CSVs or exported series derived from CREA data to a public repo unless your license permits it.

I have manually reconstructed prices that are close to CREA's data using the following datasources (mix of population growth, new home constructions, home prices and aggregations) and comitted these:
* https://www150.statcan.gc.ca/n1/pub/62f0014m/62f0014m2024007-eng.htm
* https://www150.statcan.gc.ca/n1/pub/71-607-x/71-607-x2019013-eng.htm
* https://www150.statcan.gc.ca/n1/daily-quotidien/250530/dq250530a-eng.htm
* https://www.statcan.gc.ca/en/subjects-start/prices_and_price_indexes/consumer_price_indexes
* https://www.crea.ca/housing-market-stats/canadian-housing-market-stats/quarterly-forecasts
* https://www.statcan.gc.ca/en/data-science/network/data-decision
* https://www.cmhc-schl.gc.ca/professionals/housing-markets-data-and-research/market-reports/housing-market/housing-market-outlook
* https://www150.statcan.gc.ca/t1/tbl1/en/tv.action?pid=1810005401
* https://www150.statcan.gc.ca/t1/tbl1/en/tv.action?pid=1810005201

---

## 7) Quickstart (end‑to‑end)

1. **Configure** CSV sources in `urls.json5` (StatsCan / BoC URLs or local CSV files).  
2. **Ingest** into SQLite:
   ```bash
   node index.js   # or: node pull.js, if you've split workflows
   ```
3. **Describe datasets** for the dashboard in `docs/data/manifest.json5` (see example above).  
4. **Export** chart series to `docs/data/*.json`:
   ```bash
   node update.js
   ```
5. **Serve** the dashboard:
   ```bash
   npx serve docs
   # set Base URL to http://localhost:3000/data/ (or your host)
   ```
6. **(CREA only)**: follow the licensing-safe steps in the “CREA HPI data” section before steps 2–5.

---

## 8) Tips & conventions for SQL

- Always **order** by `REF_DATE ASC` for consistent label sorting.
- Normalize category filters via `params` and use `{$q_name}` for safe quoting.
- Keep `REF_DATE` as one of:
  - `YYYY` (yearly), `YYYY-Q#` (quarterly), or `YYYY-MM` (monthly).
  - Year ranges like `YYYY/YYYY` will be normalized client-side to a mid-year anchor for display.
- Prefer returning **one series per dataset**; if you need composites, build them in SQL or export multiple series and align/offset in the UI.

---
