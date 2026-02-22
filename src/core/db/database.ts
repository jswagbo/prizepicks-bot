/**
 * The Fund — Database Connection Manager
 * 
 * Manages SQLite database connection and provides query utilities.
 */

import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { getSchemaSQL, SCHEMA_VERSION } from './schema';

let db: Database.Database | null = null;

export interface DatabaseConfig {
  path: string;
  verbose?: boolean;
}

/**
 * Initialize and return the database connection
 */
export function getDatabase(config?: DatabaseConfig): Database.Database {
  if (db) {
    return db;
  }

  const dbPath = config?.path || process.env.DATABASE_PATH || './data/fund.db';
  
  // Ensure data directory exists
  const dataDir = path.dirname(dbPath);
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }

  // Open database connection
  db = new Database(dbPath, {
    verbose: config?.verbose ? console.log : undefined,
  });

  // Enable foreign keys
  db.pragma('foreign_keys = ON');
  
  // Enable WAL mode for better concurrency
  db.pragma('journal_mode = WAL');

  // Auto-run migrations on first connection
  ensureMigrations(db);

  return db;
}

let migrationsRun = false;

/**
 * Ensure all migrations have been applied.
 * Runs automatically on first getDatabase() call.
 */
function ensureMigrations(database: Database.Database): void {
  if (migrationsRun) return;
  migrationsRun = true;

  // Check if schema_version table exists
  const tableCheck = database.prepare(`
    SELECT name FROM sqlite_master WHERE type='table' AND name='schema_version'
  `).get();

  if (!tableCheck) {
    // Fresh DB — create everything
    console.log('Initializing database schema...');
    database.exec(getSchemaSQL());
    database.prepare(`INSERT INTO schema_version (version) VALUES (?)`).run(SCHEMA_VERSION);
    database.prepare(`
      INSERT OR IGNORE INTO treasury (id, total_capital, available_capital, allocated_capital, reserve_minimum)
      VALUES ('main', 0, 0, 0, 100)
    `).run();
    console.log(`Database initialized with schema version ${SCHEMA_VERSION}`);
    return;
  }

  // Existing DB — check version and run migrations
  const version = database.prepare(`SELECT MAX(version) as version FROM schema_version`).get() as { version: number } | undefined;
  const currentVersion = version?.version || 0;

  if (currentVersion < SCHEMA_VERSION) {
    console.log(`Database schema version ${currentVersion} → ${SCHEMA_VERSION}. Running migrations...`);

    // v5 → v6: Add shooting stat columns
    if (currentVersion < 6) {
      const cols = [
        'three_pointers_attempted REAL DEFAULT 0',
        'field_goals_made REAL DEFAULT 0',
        'field_goals_attempted REAL DEFAULT 0',
        'free_throws_made REAL DEFAULT 0',
        'free_throws_attempted REAL DEFAULT 0',
      ];
      for (const col of cols) {
        try { database.exec(`ALTER TABLE player_game_logs ADD COLUMN ${col}`); } catch (_) { /* already exists */ }
      }
    }

    database.prepare(`INSERT INTO schema_version (version) VALUES (?)`).run(SCHEMA_VERSION);
    console.log(`Migrated to schema version ${SCHEMA_VERSION}`);
  }
}

/**
 * Initialize database schema if not exists.
 * @deprecated Migrations now run automatically via getDatabase(). Kept for backward compatibility.
 */
export function initializeDatabase(config?: DatabaseConfig): void {
  getDatabase(config); // triggers ensureMigrations
}

/**
 * Close database connection
 */
export function closeDatabase(): void {
  if (db) {
    db.close();
    db = null;
  }
}

/**
 * Run a transaction
 */
export function runTransaction<T>(fn: (db: Database.Database) => T): T {
  const database = getDatabase();
  return database.transaction(fn)(database);
}

/**
 * Utility: Convert JS Date to SQLite datetime string
 */
export function toSqliteDateTime(date: Date): string {
  return date.toISOString().replace('T', ' ').replace('Z', '');
}

/**
 * Utility: Convert SQLite datetime string to JS Date
 */
export function fromSqliteDateTime(dateStr: string): Date {
  // Handle both formats: with 'T' separator and with space
  const normalized = dateStr.includes('T') ? dateStr : dateStr.replace(' ', 'T') + 'Z';
  return new Date(normalized);
}

