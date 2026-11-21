# Formula Engine Service

A versioned formula engine built with Node.js, Express and MySQL 8.4. Formula changes are append-only: the application inserts a new row for every create, edit, deactivation and rollback. It does not update or delete rows in the `formulas` or `formula_run_logs` business tables.

## Requirements

- Node.js 20 or later
- npm
- Docker Desktop / Docker Engine with Compose, or a local MySQL 8.4 server

## Setup

1. Copy `.env.example` to `.env`.
2. Change `DB_PASSWORD` and `MYSQL_ROOT_PASSWORD` to local secrets.
3. Install packages: `npm install`.
4. Start MySQL: `docker compose up -d mysql`.
5. Wait until MySQL is healthy. The schema is installed automatically on the first initialization of the named Docker volume.
6. Start the API: `npm run dev` (development) or `npm start`.
7. Check `GET http://localhost:3000/health`.

If you change `sql/schema.sql` after the Docker volume has already been initialized, MySQL's entrypoint will not re-run it automatically. Apply the SQL migration manually or reset only your disposable development volume.

## Configuration

| Variable | Purpose | Default |
|---|---|---|
| `PORT` | HTTP port | `3000` |
| `DB_HOST` | MySQL host | `127.0.0.1` |
| `DB_PORT` | MySQL port | `3306` |
| `DB_NAME` | Database | `formula_engine` |
| `DB_USER` | Database user | `formula_user` |
| `DB_PASSWORD` | Database password | empty |
| `DB_CONNECTION_LIMIT` | MySQL pool size | `15` |
| `FORMULA_TIMEOUT_MS` | Per-formula timeout | `2000` |
| `BULK_PREVIEW_CONCURRENCY` | Bulk record workers | `10` |

## Formula syntax

The interpreter reads input values through `EXTERNAL_VAR.<name>`. The service also accepts bare identifiers and rewrites them to the interpreter's `EXTERNAL_VAR.CODE.<name>` form. A formula is JavaScript-style text ending in `return`.

```javascript
return EXTERNAL_VAR.amount * EXTERNAL_VAR.rate / 100;
```

The service detects references to other formula names, builds a dependency graph, checks cycles, and evaluates independent formulas at the same dependency level concurrently. Missing input fields are rejected before evaluation. A failed formula is marked `FAILED`; formulas that depend on it become `SKIPPED`; independent formulas continue.

## API examples

Base URL: `http://localhost:3000`

### 1. Create a formula — `POST /formulas`

```json
{
  "name": "commission",
  "formula_text": "return amount * rate / 100;",
  "created_by": "admin",
  "sampleData": { "amount": 2000, "rate": 10 }
}
```

A create returns HTTP 201. A dependent formula may be created before the formula it references; unknown references are treated as provisional sample inputs during save validation. Preview still requires every dependency to be present as an active formula or input field.

### 2. Change a formula — `POST /formulas`

```json
{
  "uuid": "<formula-uuid>",
  "baseVersion": 1,
  "formula_text": "return amount * rate / 100 * 1.05;",
  "created_by": "admin"
}
```

`baseVersion` is mandatory. Fields omitted from a change retain their current values. A stale version returns HTTP 409 with the current version in `error.details.currentVersion`.

### 3. Deactivate — `POST /formulas/:uuid/deactivate`

```json
{
  "baseVersion": 2,
  "created_by": "admin",
  "force": false
}
```

The request is rejected if active formulas depend on the target, unless `force` is explicitly true. Deactivation inserts an `INACTIVE` version.

### 4. Roll back — `POST /formulas/:uuid/rollback`

```json
{
  "version": 1,
  "baseVersion": 3,
  "created_by": "admin"
}
```

Rollback copies the selected historical values into a new version. It never makes an old row current by modifying it.

### 5. List current formulas — `GET /formulas`

```text
GET /formulas?includeInactive=false
```

The default includes active and inactive current rows. `includeInactive=false` returns only active current formulas.

### 6. Formula history — `GET /formulas/:uuid/history`

```text
GET /formulas/00000000-0000-4000-8000-000000000001/history
```

Returns all versions oldest first.

### 7. Dependency impact — `GET /formulas/:uuid/impact`

```text
GET /formulas/00000000-0000-4000-8000-000000000001/impact
```

Returns the target formula and active formulas that directly or indirectly depend on it.

### 8. Single preview — `POST /formulas/preview`

```json
{
  "record": { "amount": 2000, "rate": 10 },
  "formulaUuids": [],
  "asOf": "2026-11-20T12:00:00.000Z",
  "timeoutMs": 2000
}
```

Omit `formulaUuids` or pass an empty array to preview all active formulas. Omit `asOf` to use the current versions. Each preview creates one `run_uuid`; one run-log row is inserted per formula in a single batch insert.

### 9. Bulk preview — `POST /formulas/preview/bulk`

```json
{
  "records": [
    { "amount": 2000, "rate": 10 },
    { "amount": 5000, "rate": 12 }
  ],
  "concurrency": 10,
  "timeoutMs": 2000
}
```

A maximum of 500 records is accepted. A record-level failure is returned for that record and does not discard other results. The response includes total time, average time per record and failure count.

## Versioning and concurrency decisions

- The row with the highest auto-increment `id` for a UUID is current. The aggregate-subquery view `v_current_formulas_subquery` is used by the service because it expresses this rule directly and can use the `(uuid, id)` index. The window-function alternative `v_current_formulas_window` is also included for comparison.
- Formula edits lock the current row with `SELECT ... FOR UPDATE` and compare the submitted `baseVersion` before inserting. Two edits based on the same version cannot both commit successfully.
- A MySQL named lock serializes active-name checks for create/rename operations. It is released in a `finally` block.
- Every write uses `saveRecord()`. It discovers the target table's columns, merges an existing logical record when a UUID is supplied, increments the version only when that column exists, and performs an INSERT. For run logs, `uuidColumn: null` is used because `run_uuid` groups multiple log rows; it is not the identity of a versioned log record.

## SQL files

- `sql/schema.sql`: business tables, indexes, and both current-row views.
- `sql/queries.sql`: the seven required reporting queries.

The SQL dependency-order report uses text matching and is intended as an operational report. The JavaScript dependency parser is authoritative for preview execution and cycle validation.

## Tests

Run `npm test` after MySQL is running and the schema is installed. The current suite contains unit and database integration tests for rounding, dependency order, cycle detection, timeout/failure propagation, insert-only save behavior, version conflicts, impact checks, rollback and bulk throughput.

The integration suite truncates tables for test isolation. Run it only against a disposable test database, never a production database. A successful syntax check is not a substitute for running the integration suite against MySQL.

## Insert-only storage: trade-offs (15 lines)

1. Insert-only storage preserves every business-rule change as an auditable event.
2. A previous formula version is never overwritten or lost.
3. Historical previews can select the version that was current at a requested time.
4. Rollback is safe because it creates a new version rather than rewriting history.
5. The approach makes debugging and compliance reviews easier.
6. It also makes the write path simple: every change is an INSERT.
7. The main cost is that the formulas table grows continuously.
8. Indexes consume additional disk space and increase insert work.
9. History and current-version queries can become slower as versions accumulate.
10. Run logs may grow even faster than formula definitions.
11. Keep the current-row view and history queries supported by targeted indexes.
12. Archive or partition old run logs according to retention requirements.
13. Keep immutable formula history in durable storage for audit requirements.
14. Monitor query plans, index size, table growth and buffer-pool hit rates.
15. If scale requires it, introduce read replicas or a separately maintained read model without changing the append-only source of truth.

## Security notes

Do not commit `.env`, database passwords, or production credentials. `.env.example` contains placeholders only. Use a dedicated test database for automated tests.
