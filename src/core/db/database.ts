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

  return db;
}

/**
 * Initialize database schema if not exists
 */
export function initializeDatabase(config?: DatabaseConfig): void {
  const database = getDatabase(config);
  
  // Check if schema is already initialized
  const tableCheck = database.prepare(`
    SELECT name FROM sqlite_master 
    WHERE type='table' AND name='schema_version'
  `).get();

  if (!tableCheck) {
    console.log('Initializing database schema...');
    database.exec(getSchemaSQL());
    
    // Record schema version
    database.prepare(`
      INSERT INTO schema_version (version) VALUES (?)
    `).run(SCHEMA_VERSION);
    
    // Initialize treasury with default state
    database.prepare(`
      INSERT OR IGNORE INTO treasury (id, total_capital, available_capital, allocated_capital, reserve_minimum)
      VALUES ('main', 0, 0, 0, 100)
    `).run();
    
    console.log(`Database initialized with schema version ${SCHEMA_VERSION}`);
  } else {
    // Check schema version
    const version = database.prepare(`
      SELECT MAX(version) as version FROM schema_version
    `).get() as { version: number } | undefined;
    
    if (version && version.version < SCHEMA_VERSION) {
      console.log(`Database schema version ${version.version} is outdated. Current: ${SCHEMA_VERSION}`);
      // Future: Run migrations here
    }
  }
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

