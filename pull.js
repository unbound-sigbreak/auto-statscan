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

const dbFilePath = './autostatscan.db';
let db;
let keepCsv = true;

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

    fs.writeFileSync(tmpCsvFilePath, data);
  } catch (err) {
    console.error(`Failed to fetch CSV for ${name}:`, err);
    return;
  }

  return new Promise((resolve, reject) => {
    try {
      const parserStream = fs.createReadStream(tmpCsvFilePath).pipe(csvParser());

      parserStream.on('headers', (headers) => {
        if (headers.length === 0) {
          console.error(`No headers found in CSV for ${name}`);
          reject(new Error('No headers found in CSV'));
          return;
        }

        createTableIfNotExists(sanitizedTableName, headers)
          .then(() => {
            parserStream.on('data', (row) => {
              const filteredRow = Object.entries(row).reduce((acc, [key, value]) => {
                if (value.trim() !== '') {
                  acc[key.replace(/[^a-zA-Z0-9_]/g, '_')] = value;
                }
                return acc;
              }, {});

              if (Object.keys(filteredRow).length === 0) {
                console.log(`Skipping empty row for ${sanitizedTableName}`);
                return;
              }

              const keys = Object.keys(filteredRow);
              const placeholders = keys.map(() => '?').join(', ');
              const insertQuery = `INSERT INTO "${sanitizedTableName}" (${keys.join(', ')}) VALUES (${placeholders})`;
              db.run(insertQuery, Object.values(filteredRow), (err) => {
                if (err) {
                  console.log(`Executing SQL: ${insertQuery}`);
                  console.error(`Failed to insert row for ${sanitizedTableName}:`, err);
                }
              });
            });

            parserStream.on('end', () => {
              console.log(`CSV data inserted into ${sanitizedTableName} table successfully.`);
              if (!keepCsv) {
                fs.unlinkSync(tmpCsvFilePath);
              }
              resolve();
            });
          })
          .catch((err) => {
            reject(err);
          });
      });

      parserStream.on('error', (err) => {
        console.error(`Error while parsing CSV for ${sanitizedTableName}:`, err);
        reject(err);
      });

    } catch (err) {
      console.error(`Failed to insert CSV for ${sanitizedTableName}:`, err);
      reject(err);
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

  for (const [index, [name, url]] of Object.entries(listToGet).entries()) {
    indexMap[index] = name;
    await downloadCsvToSqlite(name, url, index, outputDir).catch((err) => {
      console.error(`Error processing ${name}:`, err);
    });
  }

  if (keepCsv) {
    const indexFilePath = path.join(outputDir, 'index.json');
    fs.writeFileSync(indexFilePath, JSON.stringify(indexMap, null, 2));
  }

  db.close(() => {
    console.log('Database connection closed');
  });
})();
