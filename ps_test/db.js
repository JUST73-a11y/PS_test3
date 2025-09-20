const Database = require("better-sqlite3");

const db = new Database("messages.db");

// Agar jadval yo‘q bo‘lsa, yaratib qo‘yadi
db.prepare(`
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    text TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`).run();

module.exports = db;
