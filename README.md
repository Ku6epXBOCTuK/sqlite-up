# sqlite-up

[![npm version](https://badge.fury.io/js/@ku6epxboctuk%2Fsqlite-up.svg)](https://badge.fury.io/js/@ku6epxboctuk%2Fsqlite-up)
[![TypeScript](https://img.shields.io/badge/%3C%2F%3E-TypeScript-%230074c1.svg)](https://www.typescriptlang.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

A lightweight SQLite migration system for Node.js and Bun, built with TypeScript. Manage your SQLite database schema changes with ease and confidence.

> **Fork notice** — published as `@ku6epxboctuk/sqlite-up`, forked from [sandrinodimattia/sqlite-up](https://github.com/sandrinodimattia/sqlite-up) at 0.6.0.
> Change vs upstream: migration modules are loaded through `pathToFileURL(...)`, so `migrationsDir` can be an absolute Windows path
> (`C:\...`). Upstream fails with `ERR_UNSUPPORTED_ESM_URL_SCHEME` on Windows. No API changes.

## Features

- 🚀 Modern TypeScript-first API
- 🔒 Concurrency-safe with database locking
- ⚡️ Lightweight and fast
- 🔄 Supports migrations and rollbacks
- 📊 Migration status tracking
- 🔐 Transaction-safe migrations
- 🧩 Works with Node 24+ `node:sqlite`, Bun `bun:sqlite`, Bun `SQL`, optional `better-sqlite3`, and compatible SQLite clients

## Installation

Requires Node.js 24+ or Bun.

```bash
npm install @ku6epxboctuk/sqlite-up
# or
yarn add @ku6epxboctuk/sqlite-up
# or
pnpm add @ku6epxboctuk/sqlite-up
```

## Quick Start

1. Create a migrations directory:

```bash
mkdir migrations
```

2. Create your first migration file `migrations/001_create_users.ts`:

```typescript
import type { SqliteDatabase } from '@ku6epxboctuk/sqlite-up';

export const up = async (db: SqliteDatabase): Promise<void> => {
  await db.exec(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
};

export const down = async (db: SqliteDatabase): Promise<void> => {
  await db.exec('DROP TABLE users');
};
```

3. Use the migrator in your code:

```typescript
import { DatabaseSync } from 'node:sqlite';
import { Migrator } from '@ku6epxboctuk/sqlite-up';

async function main() {
  const db = new DatabaseSync('myapp.db');

  const migrator = new Migrator({
    db,
    migrationsDir: './migrations',
  });

  // Run all pending migrations
  const result = await migrator.apply();
  if (result.success) {
    console.log('Applied migrations:', result.appliedMigrations);
  } else {
    console.error('Migration failed:', result.error);
  }
}

main().catch(console.error);
```

### Bun

The same migrator accepts Bun's synchronous `bun:sqlite` database:

```typescript
import { Database } from 'bun:sqlite';
import { Migrator } from '@ku6epxboctuk/sqlite-up';

const db = new Database('myapp.db', { create: true });
const migrator = new Migrator({
  db,
  migrationsDir: './migrations',
});

await migrator.apply();
```

It also accepts Bun's Promise-based `SQL` SQLite client:

```typescript
import { SQL } from 'bun';
import { Migrator } from '@ku6epxboctuk/sqlite-up';

const sql = new SQL('sqlite://myapp.db');
const migrator = new Migrator({
  db: sql,
  migrationsDir: './migrations',
});

await migrator.apply();
```

When using Bun `SQL`, write migration files as `async` functions and `await` database calls.

### better-sqlite3

If your project already uses `better-sqlite3`, pass its database instance directly. `@ku6epxboctuk/sqlite-up` does not install it or require it as a peer dependency, so install `better-sqlite3` in your application if you use this provider.

```typescript
import Database from 'better-sqlite3';
import { Migrator } from '@ku6epxboctuk/sqlite-up';

const db = new Database('myapp.db');
const migrator = new Migrator({
  db,
  migrationsDir: './migrations',
});

await migrator.apply();
```

## API Reference

### `Migrator`

The main class for managing migrations.

#### Constructor Options

```typescript
interface MigratorOptions {
  db: MigratorDatabase; // Node DatabaseSync, Bun Database, Bun SQL, better-sqlite3, or compatible SQLite instance
  migrationsDir: string; // Directory containing migration files
  migrationsTable?: string; // Optional: Table name for tracking migrations (default: 'schema_migrations')
  migrationsLockTable?: string; // Optional: Table name for migration locks (default: 'schema_migrations_lock')
  fileExtensions?: string[]; // Optional: File extensions to look for (default: ['ts', 'js']). Note: .d.ts files are always ignored
}
```

#### Methods

##### `apply()`

Apply all pending migrations.

```typescript
const migrator = new Migrator({
  db,
  migrationsDir: './migrations',
});

// Run all pending migrations
const result = await migrator.apply();
if (result.success) {
  console.log('Applied migrations:', result.appliedMigrations);
} else {
  console.error('Migration failed:', result.error);
}
```

##### `rollback()`

Rollback the most recent batch of migrations.

```typescript
// Rollback the last batch of migrations
const result = await migrator.rollback();
if (result.success) {
  console.log('Rolled back:', result.appliedMigrations);
} else {
  console.error('Rollback failed:', result.error);
}
```

##### `status()`

Get the status of all migrations. Shows which migrations have been applied and which are pending.

```typescript
const status = await migrator.status();
console.log('Migration Status:', status);
// Example output:
// Migration Status: {
//   currentBatch: 1,
//   pending: 0,
//   applied: [
//     {
//       name: '001_users_table.ts',
//       executed_at: '2025-01-22T12:29:22.402Z',
//       batch: 1
//     },
//     {
//       name: '002_add_age.ts',
//       executed_at: '2025-01-22T12:29:22.406Z',
//       batch: 1
//     }
//   ]
// }
```

##### `plan()`

Plan the pending migrations without applying them. Returns the next batch number and the list of pending migration names in order.

```typescript
const plan = await migrator.plan();
console.log('Migration Plan:', plan);
// Example output:
// Migration Plan: {
//   nextBatch: 2,
//   pendingMigrations: ['003_add_email_index.ts']
// }
```

##### Events

The migrator extends EventEmitter and emits events during migration:

```typescript
// Listen for migration events
migrator.on('migration:applied', function (name: string, batch: number): void {
  console.log(`✅ Migration Applied: "${name}" in batch ${batch}`);
});
migrator.on('migration:rollback', function (name: string, batch: number): void {
  console.log(`🔄 Migration Rolled Back: "${name}" from batch ${batch}`);
});

// Run migrations after setting up listeners
await migrator.apply();
```

##### Transaction Safety

All pending migrations in one `apply()` call run in a single transaction. If any part of a migration fails, the entire batch is rolled back:

```typescript
import type { SqliteDatabase } from '@ku6epxboctuk/sqlite-up';

export const up = async (db: SqliteDatabase): Promise<void> => {
  // Both operations will be in the same transaction
  await db.exec('CREATE TABLE users (id INTEGER PRIMARY KEY)');
  await db.exec('CREATE INDEX idx_user_id ON users(id)');

  // If any operation fails, the entire migration is rolled back
  // and the database remains in its previous state
};
```

For synchronous SQLite clients such as Node `DatabaseSync`, Bun `Database`, `better-sqlite3`, and compatible `exec`/`prepare` clients, `@ku6epxboctuk/sqlite-up` uses explicit `BEGIN IMMEDIATE` transactions so async migration functions are still awaited before commit or rollback. For Bun `SQL`, `@ku6epxboctuk/sqlite-up` uses Bun SQL's native async transaction support when available.

## Migration Files

Migration files should be TypeScript or JavaScript files that export `up` and `down` functions:

```typescript
import type { SqliteDatabase } from '@ku6epxboctuk/sqlite-up';

export const up = async (db: SqliteDatabase): Promise<void> => {
  // Migration code here
};

export const down = async (db: SqliteDatabase): Promise<void> => {
  // Rollback code here
};
```

Files should be named using the format: `XXX_description.ts` where XXX is a sequence number (e.g., `001_`, `002_`).

The migrator loads migration files with dynamic `import()`. Bun can load TypeScript migrations directly. In Node.js, run your migration script with a TypeScript runtime such as `tsx`, or compile migrations to JavaScript and use `.js` migration files. You can also customize loaded extensions with `fileExtensions`; `.d.ts` files are always ignored.

### Providing Context

A second argument can be provided to migration file functions in order to supply your own context. Context should be passed in `apply` or `rollback`.

To enforce type correctness, type the `Migrator` and use `satisfies` in your migration files:

```typescript
import type { SqliteDatabase, Migration } from '@ku6epxboctuk/sqlite-up';

interface MyContext {
  foo: string;
}

export const up: Migration<MyContext>['up'] = async (db: SqliteDatabase, ctx: MyContext): Promise<void> => {
  // Migration code here
  // context is passed as ctx
};

export const down: Migration<MyContext>['down'] = async (db: SqliteDatabase, ctx: MyContext): Promise<void> => {
  // Rollback code here
  // context is passed as ctx
};
```

```typescript
import { DatabaseSync } from 'node:sqlite';
import { Migrator } from '@ku6epxboctuk/sqlite-up';

async function main() {
  const db = new DatabaseSync('myapp.db');

  const migrator = new Migrator<MyContext>({
    db,
    migrationsDir: './migrations',
  });

  const result = await migrator.apply({ foo: 'bar' });
}

main().catch(console.error);
```

## Error Handling

```typescript
import {
  MigrationError, // Base error class
  MigrationFileError, // Issues with migration files
  MigrationLockError, // Locking-related errors
  MigrationExecutionError, // Errors during migration execution
} from '@ku6epxboctuk/sqlite-up';

const result = await migrator.apply();

if (!result.success) {
  if (result.error instanceof MigrationLockError) {
    console.error('Migration failed, a different process is holding the lock:', result.error.message);
  } else {
    console.error('Migration failed:', result.error?.message);
  }
}
```

The library provides specific error classes for different scenarios:

- `MigrationError` - Base error class
- `MigrationFileError` - Issues with migration files
- `MigrationExecutionError` - Errors during migration execution
- `MigrationLockError` - Lock-related errors

## Examples

Check out the [examples directory](https://github.com/Ku6epXBOCTuK/sqlite-up/tree/main/examples) for complete working examples.

## FAQ

### When running migrations as part of Vitest I get `TypeError: Unknown file extension ".ts"`

This happens when a migration file is dynamically imported at runtime but the process loading it is not configured to handle TypeScript. Vitest can transform test files, but dynamically imported migration files may still need to be inside Vitest's transform path or loaded through a TypeScript-aware runtime.

If your tests use TypeScript migration files, run the tests with Vitest as the test runner and keep the migrations in a location Vitest can transform. If the migrations are generated into a temporary directory or loaded by a helper process that runs plain Node.js, either write the test migrations as `.js` files or run that helper through a TypeScript loader such as `tsx` or `ts-node/esm`.

```bash
pnpm exec vitest run

# or, for a standalone migration helper used by tests
pnpm exec tsx migrate.ts

# or, with ts-node's ESM loader
node --loader ts-node/esm migrate.ts
```

If you prefer to register the ESM loader from Vitest setup, add a setup file:

```typescript
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    setupFiles: ['./vitest.setup.ts'],
  },
});
```

Then register the TypeScript loader in `vitest.setup.ts`:

```typescript
import { register } from 'node:module';
import { pathToFileURL } from 'node:url';

register('ts-node/esm', pathToFileURL('./'));
```

### Why do I get `TypeError: Unknown file extension ".ts"` in Node.js?

`@ku6epxboctuk/sqlite-up` loads migrations with dynamic `import()`, so Node.js needs a loader that understands TypeScript migration files. Run your migration entry point with a TypeScript runtime such as `tsx`, use an ESM loader such as `ts-node/esm`, or compile migrations to JavaScript before running them with plain Node.js.

```bash
pnpm exec tsx migrate.ts
# or
node --loader ts-node/esm migrate.ts
```

For production deployments that run plain Node.js, prefer compiled `.js` migrations and point `migrationsDir` at the compiled migration output.

## Contributing

### Development

```bash
# Install dependencies
pnpm install

# Run tests
pnpm test

# Run Bun provider tests
pnpm test:bun

# Run tests with coverage
pnpm test:coverage

# Type check
pnpm typecheck

# Build the project
pnpm build

# Check formatting and lint rules
pnpm check

# Apply safe and unsafe Biome fixes locally
pnpm check:fix

# Lint the code
pnpm lint

# Format the code
pnpm format
```

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.
