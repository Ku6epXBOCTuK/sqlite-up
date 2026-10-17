import { EventEmitter } from 'node:events';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { MigrationError, MigrationExecutionError, MigrationFileError, MigrationLockError } from './errors.js';
import { createSqliteProvider, type SqliteProvider } from './providers/index.js';
import type {
  ContextArg,
  MaybePromise,
  Migration,
  MigrationPlan,
  MigrationRecord,
  MigrationResult,
  MigrationStatus,
  MigratorOptions,
  SqliteDatabase,
} from './types.js';

/**
 * Migration provider for SQLite databases.
 * @example
 * const db = new DatabaseSync('database.db');
 * const migrator = new Migrator({ db, migrationsDir: 'migrations' });
 * await migrator.apply();
 */
export class Migrator<T = undefined> extends EventEmitter {
  /**
   * Driver-specific provider normalized to the sqlite-up database surface.
   */
  private provider: SqliteProvider;

  /**
   * Database handle used by migrations and internal bookkeeping queries.
   */
  private db: SqliteDatabase;

  /**
   * Directory where migration modules are loaded from.
   */
  private migrationsDir: string;

  /**
   * Table that records successfully applied migrations.
   */
  private migrationsTable: string;

  /**
   * Table that stores the single-row migration lock.
   */
  private lockTable: string;

  /**
   * Migration modules loaded from disk in execution order.
   */
  private migrations: Migration<T>[] = [];

  /**
   * Whether internal tables and migration files have already been initialized.
   */
  private initialized = false;

  /**
   * File extensions considered when loading migration modules.
   */
  private fileExtensions: string[];

  constructor(options: MigratorOptions) {
    super();

    this.provider = createSqliteProvider(options.db);
    this.db = this.provider.db;
    this.migrationsDir = options.migrationsDir;
    this.migrationsTable = options.migrationsTable ?? 'schema_migrations';
    this.lockTable = options.migrationsLockTable ?? 'schema_migrations_lock';
    this.fileExtensions = options.fileExtensions ?? ['ts', 'js'];
  }

  /**
   * Ensures the `schema_migrations` and `schema_migrations_lock` tables exist,
   * and loads migration files from the migrations directory.
   */
  private async init(): Promise<void> {
    if (this.initialized) {
      return;
    }

    await this.initTables();
    await this.loadMigrationsFromDirectory();

    this.initialized = true;
  }

  /**
   * Initializes the `schema_migrations` and `schema_migrations_lock` tables.
   */
  private async initTables(): Promise<void> {
    try {
      // Create the migrations table if it doesn't exist
      await this.db.exec(`
        CREATE TABLE IF NOT EXISTS ${this.migrationsTable} (
          name TEXT PRIMARY KEY,
          executed_at TEXT NOT NULL,   -- ISO string
          batch INTEGER NOT NULL
        )
      `);

      // Create the lock table if it doesn't exist
      await this.db.exec(`
        CREATE TABLE IF NOT EXISTS ${this.lockTable} (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          locked INTEGER NOT NULL DEFAULT 0
        )
      `);

      // Ensure exactly one row in the lock table (id=1)
      await this.db.exec(`
        INSERT OR IGNORE INTO ${this.lockTable} (id, locked) VALUES (1, 0)
      `);

      // Load all migration files
    } catch (err) {
      throw new MigrationError('Failed to initialize migrator', err as Error);
    }
  }

  /**
   * Load migration files from the `migrationsDir`.
   * Migration files must export { up, down }.
   * The migrations are loaded in alphabetical order.
   */
  private async loadMigrationsFromDirectory(): Promise<void> {
    try {
      const entries = await fs.readdir(this.migrationsDir);
      // Filter and sort migration files alphabetically
      const migrationFiles = entries
        .filter((file) => {
          // Ignore .d.ts files
          if (file.endsWith('.d.ts')) {
            return false;
          }
          // Check if file has one of the allowed extensions
          return this.fileExtensions.some((ext) => file.endsWith(`.${ext}`));
        })
        .sort();

      const loadedMigrations: Migration<T>[] = [];
      for (const file of migrationFiles) {
        const fullPath = path.join(this.migrationsDir, file);

        let imported: {
          up: Migration<T>['up'];
          down: Migration<T>['down'];
        };

        try {
          imported = await import(pathToFileURL(fullPath).href);
        } catch (err) {
          throw new MigrationFileError(`Error loading migration "${file}": ${String(err)}`, err as Error);
        }

        const { up, down } = imported;
        if (typeof up !== 'function' || typeof down !== 'function') {
          throw new MigrationFileError(`Migration "${file}" must export "up" and "down" functions.`);
        }

        loadedMigrations.push({ name: file, up, down });
      }

      // Only update migrations array after all files are loaded successfully
      this.migrations = loadedMigrations;
    } catch (err) {
      throw err instanceof MigrationFileError ? err : new MigrationFileError('Failed to load migrations', err as Error);
    }
  }

  /**
   * Acquire a lock to prevent concurrent migrations.
   * Throws an error if the lock is already held.
   */
  private async acquireLock(): Promise<void> {
    try {
      await this.runTransaction(async () => {
        const row = (await this.db.prepare(`SELECT locked FROM ${this.lockTable} WHERE id = 1`).get()) as {
          locked: number;
        };

        if (row.locked === 1) {
          throw new MigrationLockError('Migration lock already held by another process.');
        }

        await this.db.prepare(`UPDATE ${this.lockTable} SET locked = 1 WHERE id = 1`).run();
      });
    } catch (err) {
      if (err instanceof MigrationLockError) {
        throw err;
      }

      throw new MigrationLockError('Failed to acquire migration lock', err as Error);
    }
  }

  /**
   * Release the migration lock.
   */
  private async releaseLock(): Promise<void> {
    try {
      await this.db.prepare(`UPDATE ${this.lockTable} SET locked = 0 WHERE id = 1`).run();
    } catch (err) {
      throw new MigrationLockError('Failed to release migration lock', err as Error);
    }
  }

  /**
   * Get the highest batch number.
   */
  private async getCurrentBatch(): Promise<number> {
    const row = (await this.db.prepare(`SELECT MAX(batch) as batch FROM ${this.migrationsTable}`).get()) as {
      batch: number | null;
    };
    return row?.batch ?? 0;
  }

  /**
   * Insert a record for an applied migration.
   */
  private async recordMigration(name: string, batch: number): Promise<void> {
    const executedAt = new Date().toISOString();
    await this.db
      .prepare(
        `
        INSERT INTO ${this.migrationsTable} (name, executed_at, batch)
        VALUES (?, ?, ?)
      `
      )
      .run(name, executedAt, batch);
  }

  /**
   * Delete a record for a migration that is being rolled back.
   */
  private async removeMigration(name: string, batch: number): Promise<void> {
    await this.db
      .prepare(
        `
        DELETE FROM ${this.migrationsTable}
        WHERE name = ? AND batch = ?
      `
      )
      .run(name, batch);
  }

  /**
   * Run SQL operations in a transaction.
   * @param fn The function to run in the transaction.
   */
  private async runTransaction(fn: () => MaybePromise<void>): Promise<void> {
    await this.provider.transaction(fn);
  }

  /**
   * Apply all pending migrations in a single batch.
   * Returns the names of applied migrations.
   */
  async apply(...args: ContextArg<T>): Promise<MigrationResult> {
    // Initialize the migrator
    try {
      await this.init();
    } catch (err) {
      return {
        success: false,
        error: err as Error,
        appliedMigrations: [],
      };
    }

    // Acquire lock
    try {
      await this.acquireLock();
    } catch (err) {
      return {
        success: false,
        error: err as Error,
        appliedMigrations: [],
      };
    }

    const appliedMigrations: string[] = [];
    try {
      const currentBatch = await this.getCurrentBatch();
      const nextBatch = currentBatch + 1;

      // Determine pending migrations: not present in schema_migrations
      const appliedNames = new Set(
        (await this.db.prepare(`SELECT name FROM ${this.migrationsTable}`).all()).map(
          (row) => (row as { name: string }).name
        )
      );

      // Get pending migrations, if any
      const pendingMigrations = this.migrations.filter((m) => !appliedNames.has(m.name));
      if (pendingMigrations.length === 0) {
        return { success: true, appliedMigrations };
      }

      // Perform the migration
      await this.runTransaction(async () => {
        for (const migration of pendingMigrations) {
          try {
            // Apply migration
            await migration.up(this.db, ...args);

            // Record migration
            await this.recordMigration(migration.name, nextBatch);
            appliedMigrations.push(migration.name);
          } catch (err) {
            throw new MigrationExecutionError(`Failed to apply migration "${migration.name}"`, err as Error);
          }
        }
      });

      for (const migrationName of appliedMigrations) {
        this.emit('migration:applied', migrationName, nextBatch);
      }

      return { success: true, appliedMigrations };
    } catch (error) {
      const err =
        error instanceof MigrationExecutionError
          ? error
          : new MigrationExecutionError('Migration failed', error as Error);
      return { success: false, error: err, appliedMigrations: [] };
    } finally {
      await this.releaseLock();
    }
  }

  /**
   * Roll back the most recent batch of migrations.
   * Returns the names of rolled back migrations.
   */
  async rollback(...args: ContextArg<T>): Promise<MigrationResult> {
    // Initialize the migrator
    try {
      await this.init();
    } catch (err) {
      return {
        success: false,
        error: err as Error,
        appliedMigrations: [],
      };
    }

    // Acquire lock
    try {
      await this.acquireLock();
    } catch (err) {
      return {
        success: false,
        error: err as Error,
        appliedMigrations: [],
      };
    }

    const appliedMigrations: string[] = [];
    try {
      // Check if there are migrations to rollback
      const currentBatch = await this.getCurrentBatch();
      if (currentBatch === 0) {
        return { success: true, appliedMigrations };
      }

      // Get migrations in the last batch, sorted descending
      const rows = (await this.db
        .prepare(
          `
          SELECT name
          FROM ${this.migrationsTable}
          WHERE batch = ?
          ORDER BY name DESC
        `
        )
        .all(currentBatch)) as { name: string }[];

      // No migrations found in the last batch
      if (rows.length === 0) {
        return { success: true, appliedMigrations };
      }

      // Perform the rollback
      await this.runTransaction(async () => {
        for (const row of rows) {
          const migration = this.migrations.find((m) => m.name === row.name);
          if (!migration) {
            throw new MigrationFileError(`Migration "${row.name}" not found.`);
          }

          try {
            // Revert migration
            await migration.down(this.db, ...args);

            // Remove migration record
            await this.removeMigration(migration.name, currentBatch);

            appliedMigrations.push(migration.name);
          } catch (err) {
            throw new MigrationExecutionError(`Failed to rollback migration "${migration.name}"`, err as Error);
          }
        }
      });

      for (const migrationName of appliedMigrations) {
        this.emit('migration:rollback', migrationName, currentBatch);
      }

      return { success: true, appliedMigrations };
    } catch (error) {
      const err =
        error instanceof MigrationExecutionError
          ? error
          : new MigrationExecutionError('Rollback failed', error as Error);
      return { success: false, error: err, appliedMigrations: [] };
    } finally {
      await this.releaseLock();
    }
  }

  /**
   * Get the status of migrations.
   * Returns:
   * - currentBatch: the highest batch number applied
   * - pending: number of migrations not yet applied
   * - applied: list of all applied migrations
   */
  async status(): Promise<MigrationStatus> {
    await this.init();

    try {
      const currentBatch = await this.getCurrentBatch();

      // Get all applied migrations
      const rows = (await this.db
        .prepare(
          `
          SELECT name, executed_at, batch
          FROM ${this.migrationsTable}
          ORDER BY batch ASC, name ASC
        `
        )
        .all()) as MigrationRecord[];

      // Determine pending migrations
      const appliedNames = new Set(rows.map((r) => r.name));
      const pending = this.migrations.length - appliedNames.size;

      return {
        currentBatch,
        pending,
        applied: rows,
      };
    } catch (err) {
      throw new MigrationError('Failed to get migration status', err as Error);
    }
  }

  /**
   * Plan the pending migrations without applying them.
   * Returns the next batch number and the list of pending migration names in order.
   */
  async plan(): Promise<MigrationPlan> {
    await this.init();

    try {
      const currentBatch = await this.getCurrentBatch();
      const nextBatch = currentBatch + 1;

      // Determine pending migrations: not present in schema_migrations
      const appliedNames = new Set(
        (await this.db.prepare(`SELECT name FROM ${this.migrationsTable}`).all()).map(
          (row) => (row as { name: string }).name
        )
      );

      const pendingMigrations = this.migrations.filter((m) => !appliedNames.has(m.name)).map((m) => m.name);

      return {
        nextBatch,
        pendingMigrations,
      };
    } catch (err) {
      throw new MigrationError('Failed to create migration plan', err as Error);
    }
  }
}

export {
  MigrationError,
  MigrationExecutionError,
  MigrationFileError,
  MigrationLockError,
} from './errors.js';
export type {
  BunSqliteDatabase,
  ContextArg,
  MaybePromise,
  Migration,
  MigrationPlan,
  MigrationRecord,
  MigrationResult,
  MigrationStatus,
  MigratorDatabase,
  MigratorOptions,
  SqliteDatabase,
  SqliteRunResult,
  SqliteStatement,
  SqliteTransaction,
} from './types.js';
