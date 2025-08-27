/*
  Name: AutoStatsCan
  Author: Slyke
  Version: 1 (2024-11-09)
  BlockChain Verify:
    Message: "AutoStatsCan by Slyke 2024-11-09"
    Signature: "IMRf+BGj+RHCHOrpNBvgax2PX+YJPzJ3qIpsQF5hmtRGR9+dNyZ7jNyeI5cD9jZWMZ0hfL+Iq4dLUpQg4cJYfyU="
    Address: "bc1qvrk40pj4canfuqzcjt7g8ksxtjau2zzsq2lfjm"
*/

require('json5/lib/register')
const fs = require('fs');
const path = require('path');
const csvParser = require('csv-parser');
const sqlite3 = require('sqlite3').verbose();
const listToGet = require('./urls.json5');
const automigrations = require('./table-migrations.json5');

const dbFilePath = './autostatscan.db';
let db;
let keepCsv = true;
const overWriteMode = true;

const execSQL = (sql) => new Promise((resolve, reject) => {
  db.run(sql, (err) => (err ? reject(err) : resolve()));
});

const isRemoteUrl = (s) => typeof s === 'string' && s.includes('://');

const initializeDatabase = () => {
  db = new sqlite3.Database(dbFilePath, sqlite3.OPEN_READWRITE | sqlite3.OPEN_CREATE, (err) => {
    if (err) {
      console.error('Error opening database:', err);
    } else {
      console.log('Database connected successfully');
      db.run('PRAGMA journal_mode = WAL;', (err) => {
        if (err) {
          console.error('Failed to set WAL journal mode:', err);
        }
      });
    }
  });
};

const sanitizeTableName = (name) => {
  return name.replace(/[^a-zA-Z0-9_]/g, '_');
};

const createTableIfNotExists = (sanitizedTableName, headers) => {
  return new Promise((resolve, reject) => {
    const sanitizedHeaders = headers.map(header => header.replace(/[^a-zA-Z0-9_]/g, '_'));
    const columns = sanitizedHeaders.map((header) => `${header} TEXT`).join(', ');
    const createTableQuery = `CREATE TABLE IF NOT EXISTS "${sanitizedTableName}" (${columns})`;
    db.run(createTableQuery, (err) => {
      if (err) {
        console.log(`Executing SQL: ${createTableQuery}`);
        console.error(`Failed to create table for ${sanitizedTableName}:`, err);
        reject(err);
      } else {
        resolve();
      }
    });
  });
};

const getExistingColumns = (sanitizedTableName) => new Promise((resolve, reject) => {
  db.all(`PRAGMA table_info("${sanitizedTableName}")`, (err, rows) => {
    if (err) return reject(err);
    resolve(new Set(rows.map(r => r.name)));
  });
});

const extractObservationsCSV = (fullText) => {
  const text = fullText.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  const m = text.match(/^[ \t]*"?OBSERVATIONS"?[ \t]*\n/im);
  if (!m || m.index == null) return null;

  const start = m.index + m[0].length;
  const tail = text.slice(start).trimStart();

  const nl = tail.indexOf('\n');
  if (nl === -1) return null;

  return tail;
}

const ensureTableSchema = async (sanitizedTableName, incomingHeaders) => {
  const sanitizedIncoming = incomingHeaders.map(h => h.replace(/[^a-zA-Z0-9_]/g, '_'));
  await new Promise((resolve, reject) => {
    const cols = sanitizedIncoming.map(h => `"${h}" TEXT`).join(', ');
    const sql = `CREATE TABLE IF NOT EXISTS "${sanitizedTableName}" (${cols})`;
    db.run(sql, (err) => (err ? reject(err) : resolve()));
  });

  const existingCols = await getExistingColumns(sanitizedTableName);
  for (const col of sanitizedIncoming) {
    if (!existingCols.has(col)) {
      console.log(`[Schema Change] Adding new column "${col}" to table ${sanitizedTableName}`);
      await new Promise((resolve, reject) => {
        const sql = `ALTER TABLE "${sanitizedTableName}" ADD COLUMN "${col}" TEXT`;
        db.run(sql, (err) => (err ? reject(err) : resolve()));
      });
      existingCols.add(col);
    }
  }

  return existingCols;
};

const ingestLocalCsv = async (tableName, csvPath) => {
  const sanitizedTableName = sanitizeTableName(tableName);

  let raw = fs.readFileSync(csvPath, 'utf8');
  const obs = extractObservationsCSV(raw);
  if (obs) {
    console.log('[Ingest] Detected metadata-wrapped CSV; using OBSERVATIONS block only.');
    raw = obs;
  }

  const tmpDir = './csvtmp/manual';
  fs.mkdirSync(tmpDir, { recursive: true });
  const tmpCsvFilePath = path.join(tmpDir, path.basename(csvPath));
  fs.writeFileSync(tmpCsvFilePath, raw);

  await new Promise((resolve, reject) => {
    const parserStream = fs.createReadStream(tmpCsvFilePath).pipe(csvParser());

    parserStream.on('headers', async (headers) => {
      if (!headers || headers.length === 0) {
        reject(new Error(`No headers found in CSV: ${csvPath}`));
        return;
      }

      try {
        const existingCols = await ensureTableSchema(sanitizedTableName, headers);

        if (overWriteMode) {
          await execSQL('BEGIN IMMEDIATE');
          try {
            await execSQL(`DELETE FROM "${sanitizedTableName}"`);
            console.log(`[Overwrite] Cleared table ${sanitizedTableName} before load.`);
          } catch (e) {
            await execSQL('ROLLBACK');
            throw e;
          }
        }

        const remapLoggedOnce = new Set();
        const remapCounts = Object.create(null);
        const remapKey = (a, b) => `${a}>${b}`;

        parserStream.on('data', (row) => {
          const rawEntries = Object.entries(row).reduce((acc, [key, value]) => {
            const v = (value ?? '').toString();
            if (v.trim() !== '') acc[key.replace(/[^a-zA-Z0-9_]/g, '_')] = v;
            return acc;
          }, {});

          for (const [incoming, target] of Object.entries(automigrations)) {
            const inKey = incoming.replace(/[^a-zA-Z0-9_]/g, '_');
            const tgtKey = target.replace(/[^a-zA-Z0-9_]/g, '_');
            if (rawEntries[inKey] !== undefined && existingCols.has(tgtKey)) {
              const k = remapKey(inKey, tgtKey);
              remapCounts[k] = (remapCounts[k] || 0) + 1;
              if (!remapLoggedOnce.has(k)) {
                console.log(`[Schema Migration] ${sanitizedTableName}: remapping "${inKey}" → "${tgtKey}" (subsequent rows notifications suppressed)`);
                remapLoggedOnce.add(k);
              }
              if (rawEntries[tgtKey] === undefined) rawEntries[tgtKey] = rawEntries[inKey];
              delete rawEntries[inKey];
            }
          }

          if (Object.keys(rawEntries).length === 0) return;

          const keys = Object.keys(rawEntries);
          const placeholders = keys.map(() => '?').join(', ');
          const insertQuery = `INSERT INTO "${sanitizedTableName}" (${keys.map(k => `"${k}"`).join(', ')}) VALUES (${placeholders})`;
          db.run(insertQuery, Object.values(rawEntries), (err) => {
            if (err) {
              console.log(`Executing SQL: ${insertQuery}`);
              console.error(`Failed to insert row for ${sanitizedTableName}:`, err);
            }
          });
        });

        parserStream.on('end', async () => {
          if (overWriteMode) await execSQL('COMMIT');
          for (const [k, count] of Object.entries(remapCounts)) {
            console.log(`[Schema Migration] ${sanitizedTableName}: total rows remapped ${k} = ${count}`);
          }
          console.log(`[Ingest] CSV data inserted into ${sanitizedTableName} successfully.`);
          resolve();
        });
      } catch (e) {
        reject(e);
      }
    });

    parserStream.on('error', (err) => reject(err));
  });
};

const downloadCsvToSqlite = async (name, url, index, outputDir) => {
  const tmpCsvFilePath = path.join(outputDir, `${index}.csv`);
  const sanitizedTableName = sanitizeTableName(name);

  try {
    console.log(`Fetching CSV (${index}) for: ${name}`);
    
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Failed to fetch '${url}' (${response.status})`);
    }
    const data = await response.text();

    let toParse = data;
    const obsOnly = extractObservationsCSV(data);
    if (obsOnly) {
      console.log('[BoC] Detected metadata-wrapped CSV; using OBSERVATIONS block only.');
      toParse = obsOnly;
    }

    fs.writeFileSync(tmpCsvFilePath, toParse);
  } catch (err) {
    console.error(`Failed to fetch CSV for ${name}:`, err);
    return;
  }

  return new Promise((resolve, reject) => {
    try {
      const parserStream = fs.createReadStream(tmpCsvFilePath).pipe(csvParser());

      parserStream.on('headers', async (headers) => {
        if (headers.length === 0) {
          console.error(`No headers found in CSV for ${name}`);
          reject(new Error('No headers found in CSV'));
          return;
        }

        try {
          const existingCols = await ensureTableSchema(sanitizedTableName, headers);
          const remapLoggedOnce = new Set();
          const remapCounts = Object.create(null);
          const remapKey = (a, b) => `${a}>${b}`;

          if (overWriteMode) {
            await execSQL('BEGIN IMMEDIATE');
            try {
              await execSQL(`DELETE FROM "${sanitizedTableName}"`);
              console.log(`[Overwrite] Cleared table ${sanitizedTableName} before load.`);
            } catch (e) {
              await execSQL('ROLLBACK');
              throw e;
            }
          }

          parserStream.on('data', (row) => {
            const rawEntries = Object.entries(row).reduce((acc, [key, value]) => {
              const v = (value ?? '').toString();
              if (v.trim() !== '') acc[key.replace(/[^a-zA-Z0-9_]/g, '_')] = v;
              return acc;
            }, {});

            for (const [incoming, target] of Object.entries(automigrations)) {
              const inKey = incoming.replace(/[^a-zA-Z0-9_]/g, '_');
              const tgtKey = target.replace(/[^a-zA-Z0-9_]/g, '_');
              if (rawEntries[inKey] !== undefined && existingCols.has(tgtKey)) {
                const key = remapKey(inKey, tgtKey);
                remapCounts[key] = (remapCounts[key] || 0) + 1;
                if (!remapLoggedOnce.has(key)) {
                  console.log(`[Schema Migration] ${sanitizedTableName}: remapping "${inKey}" → "${tgtKey}" (subsequent rows notifications suppressed)`);
                  remapLoggedOnce.add(key);
                }

                if (rawEntries[tgtKey] === undefined) rawEntries[tgtKey] = rawEntries[inKey];
                delete rawEntries[inKey];
              }
            }

            if (Object.keys(rawEntries).length === 0) return;

            const keys = Object.keys(rawEntries);
            const placeholders = keys.map(() => '?').join(', ');
            const insertQuery = `INSERT INTO "${sanitizedTableName}" (${keys.map(k => `"${k}"`).join(', ')}) VALUES (${placeholders})`;

            db.run(insertQuery, Object.values(rawEntries), (err) => {
              if (err) {
                console.log(`Executing SQL: ${insertQuery}`);
                console.error(`Failed to insert row for ${sanitizedTableName}:`, err);
              }
            });
          });

          parserStream.on('end', async () => {
            if (overWriteMode) {
              await execSQL('COMMIT');
            }
            console.log(`CSV data inserted into ${sanitizedTableName} table successfully.`);
            if (!keepCsv) fs.unlinkSync(tmpCsvFilePath);
            resolve();
          });
        } catch (err) {
          return reject(err);
        }
      });

      parserStream.on('error', (err) => {
        console.error(`Error while parsing CSV for ${sanitizedTableName}:`, err);
        return reject(err);
      });

    } catch (err) {
      console.error(`Failed to insert CSV for ${sanitizedTableName}:`, err);
      return reject(err);
    }
  });
};

(async () => {
  initializeDatabase();

  let outputDir = './csvtmp';
  if (keepCsv) {
    const currentDate = new Date().toISOString().split('T')[0];
    outputDir = path.join(outputDir, currentDate);
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }
  }

  const indexMap = {};

  for (const [index, [name, urlOrPath]] of Object.entries(listToGet).entries()) {
    indexMap[index] = name;

    if (isRemoteUrl(urlOrPath)) {
      await downloadCsvToSqlite(name, urlOrPath, index, outputDir).catch((err) => {
        console.error(`Error processing ${name}:`, err);
      });
    } else {
      const localPath = path.resolve(String(urlOrPath));
      if (!fs.existsSync(localPath)) {
        console.error(`[Ingest] Local file not found: ${localPath} (from urls.json5 entry "${name}")`);
        continue;
      }
      console.log(`[Ingest] Using local CSV for ${name}: ${localPath}`);
      await ingestLocalCsv(name, localPath);
    }
  }

  if (keepCsv) {
    const indexFilePath = path.join(outputDir, 'index.json');
    fs.writeFileSync(indexFilePath, JSON.stringify(indexMap, null, 2));
  }

  db.close(() => {
    console.log('Database connection closed');
  });
})();
