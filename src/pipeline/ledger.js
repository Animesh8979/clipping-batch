/**
 * src/pipeline/ledger.js
 * Crash-safe SQLite WAL Job Queue & Ledger for Clipping Batch
 * Powered by better-sqlite3 with atomic state transitions
 */
'use strict';

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DB_DIR = path.join(__dirname, '..', '..', 'workspace');
const DB_PATH = path.join(DB_DIR, 'pipeline_ledger.db');

class StateLedger {
  constructor() {
    if (!fs.existsSync(DB_DIR)) {
      fs.mkdirSync(DB_DIR, { recursive: true });
    }

    this.db = new Database(DB_PATH, { timeout: 5000 });
    this.init();
  }

  init() {
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.db.pragma('temp_store = MEMORY');

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY,
        source_url TEXT,
        aroll_path TEXT,
        broll_path TEXT,
        transcript_json TEXT,
        ass_path TEXT,
        output_path TEXT,
        status TEXT NOT NULL,
        metadata TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);
    `);
  }

  createJob(id, sourceUrl = '') {
    const now = Date.now();
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO jobs (id, source_url, status, created_at, updated_at)
      VALUES (?, ?, 'pending', ?, ?)
    `);
    stmt.run(id, sourceUrl, now, now);
    return id;
  }

  updateJob(id, updates = {}) {
    const fields = Object.keys(updates);
    if (fields.length === 0) return;

    const setClauses = fields.map(f => `${f} = ?`).join(', ');
    const values = fields.map(f => updates[f]);
    values.push(Date.now(), id);

    const stmt = this.db.prepare(`
      UPDATE jobs 
      SET ${setClauses}, updated_at = ?
      WHERE id = ?
    `);
    stmt.run(...values);
  }

  getNextPendingJob() {
    const getStmt = this.db.prepare(`SELECT * FROM jobs WHERE status = 'pending' ORDER BY created_at ASC LIMIT 1`);
    const lockTx = this.db.transaction(() => {
      const job = getStmt.get();
      if (job) {
        this.updateJob(job.id, { status: 'processing' });
        job.status = 'processing';
        return job;
      }
      return null;
    });
    return lockTx();
  }

  recoverCrashedJobs() {
    const stmt = this.db.prepare(`
      UPDATE jobs 
      SET status = 'pending', updated_at = ?
      WHERE status IN ('processing', 'rendering', 'transcribing')
    `);
    const info = stmt.run(Date.now());
    return info.changes;
  }

  close() {
    this.db.close();
  }
}

module.exports = new StateLedger();
