require('json5/lib/register');
const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const baseDataDir = './docs/data';

const interpolate = (template, values, fallback = "") => {
  const isArr = Array.isArray(values);
  const pattern = isArr ? /{#([1-9][0-9]*|n)}/g : /{\$([a-zA-Z_][a-zA-Z0-9_]*)}/g;

  let idx = 0;

  return template.replace(pattern, (match, key) => {
    let val;

    if (isArr) {
      if (key === "n") {
        val = values[idx];
        idx++;
      } else {
        val = values[Number.parseInt(key, 10) - 1];
      }
    } else {
      val = values[key];
    }

    if (val !== undefined) {
      return val;
    }

    return fallback === true ? match : fallback;
  });
};

const readJson5 = (p) => require(path.resolve(p));

const ensureDir = (filePath) => {
  const dir = path.dirname(path.resolve(filePath));
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
};

const writeJson5 = (filePath, obj) => {
  ensureDir(filePath);
  const text = JSON.stringify(obj, null, 2);
  fs.writeFileSync(filePath, text + '\n', 'utf8');
};

const sqlQuote = (s) => `'${String(s).replace(/'/g, "''")}'`;
const withQuotedVariants = (params = {}) => {
  const out = { ...params };
  for (const [k, v] of Object.entries(params)) {
    out[`q_${k}`] = sqlQuote(v);
  }
  return out;
};

const coerceNum = (v) => {
  if (v === null || v === undefined) return null;
  const n = Number(String(v).replace(/[, ]+/g, ''));
  return Number.isFinite(n) ? n : null;
};

const scalarFactorToMultiplier = (factor) => {
  const f = String(factor || '').trim().toLowerCase();
  if (f.startsWith('unit')) return 1;
  if (f.startsWith('thousand')) return 1e3;
  if (f.startsWith('million')) return 1e6;
  if (f.startsWith('billion')) return 1e9;
  return 1;
};

const scaleNameToDivisor = (scaleName) => {
  if (!scaleName) return 1;
  const s = scaleName.toLowerCase();
  if (s === 'units') return 1;
  if (s.startsWith('thousand')) return 1e3;
  if (s.startsWith('million')) return 1e6;
  if (s.startsWith('billion')) return 1e9;
  return 1;
};

(async function main() {
  const manifestPath = process.argv[2] || `${baseDataDir}/manifest.json5`;
  const manifests = readJson5(manifestPath);

  if (!manifests || !Array.isArray(manifests.datasets)) {
    console.error('manifest.json5 must have { datasets: [...] }');
    process.exit(1);
  }

  const byDb = new Map();
  for (const ds of manifests.datasets) {
    if (!ds?.source?.query) continue;
    const dbFile = ds.source.db || './autostatscan.db';
    if (!byDb.has(dbFile)) byDb.set(dbFile, []);
    byDb.get(dbFile).push(ds);
  }

  for (const [dbFile, datasets] of byDb.entries()) {
    await new Promise((resolveDb) => {
      const db = new sqlite3.Database(dbFile, sqlite3.OPEN_READONLY, (err) => {
        if (err) {
          console.error(`Failed to open DB ${dbFile}:`, err.message);
          resolveDb();
        }
      });

      const runOne = (ds) => new Promise((resolveDs) => {
        const { query, params = {}, scale_to } = ds.source;

        const vals = withQuotedVariants(params);

        const sql = interpolate(query, vals, true);

        const unresolved = sql.match(/{\$[a-zA-Z_][a-zA-Z0-9_]*}/g);
        if (unresolved) {
          console.warn(`[${ds.id}] Warning: unresolved placeholders in SQL: ${unresolved.join(', ')}`);
        }

        db.all(sql, [], (err, rows) => {
          if (err) {
            console.error(`[${ds.id}] SQL error:`, err.message);
            return resolveDs();
          }

          const labels = [];
          const data = [];
          const divisor = scaleNameToDivisor(scale_to || null);

          for (const r of rows) {
            const dateStr = r.REF_DATE != null ? String(r.REF_DATE).trim() : null;
            const raw = coerceNum(r.VALUE);
            if (!dateStr || raw === null) continue;

            const mul = scalarFactorToMultiplier(r.SCALAR_FACTOR);
            const normalised = (raw * mul) / divisor;

            labels.push(dateStr);
            data.push(Number(normalised.toFixed(3)));
          }

          const out = {
            id: ds.id,
            label: ds.label,
            ...(ds.output || {}),
            labels,
            data
          };

          try {
            const outPath = path.join(baseDataDir, ds.path);
            writeJson5(outPath, out);
            console.log(`[OK] ${ds.id} → ${ds.path} (${labels.length} points)`);
          } catch (e) {
            console.error(`[${ds.id}] write failed:`, e.message);
          }

          return resolveDs();
        });
      });

      (async () => {
        for (const ds of datasets) {
          await runOne(ds);
        }
        db.close(() => resolveDb());
      })();
    });
  }
})();