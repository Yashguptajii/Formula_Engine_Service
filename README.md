# Formula Engine Service

A versioned formula execution backend built using **Node.js, Express, and MySQL 8.4**. It provides APIs for creating, updating, evaluating, managing, and versioning business formulas.

The service follows an **append-only storage model** for business data. Formula creation, updates, deactivation, and rollback are recorded as new rows, preserving the existing formula history instead of modifying previous versions.

It also supports formula dependency resolution, cycle detection, execution ordering, timeouts, failure propagation, execution logs, single and bulk previews, dependency impact analysis, and SQL reporting.

---

## Features

- **Append-only formula versioning** — preserves every formula version.
- **Formula creation and updates** — creates and modifies formulas through new version records.
- **Optimistic version checking** — uses `baseVersion` to detect stale edits.
- **Formula deactivation** — deactivates formulas by creating a new version.
- **Formula rollback** — restores historical formula content by inserting a new version.
- **Dependency resolution** — detects references to other formulas and builds an execution graph.
- **Cycle detection** — detects circular formula dependencies.
- **Dependency-based execution** — evaluates formulas in dependency order.
- **Concurrent evaluation** — evaluates independent formulas at the same dependency level concurrently.
- **Timeout handling** — applies execution time limits to formula evaluation.
- **Failure propagation** — failed formulas are marked `FAILED` and dependent formulas are marked `SKIPPED`.
- **Independent execution continuation** — formulas independent of a failed formula can continue executing.
- **Single-record preview** — evaluates formulas against one input record.
- **Bulk preview** — processes multiple records with configurable concurrency.
- **Execution logging** — stores inputs, results, errors, duration, formula version, and run identifiers.
- **Dependency impact analysis** — identifies active formulas directly or indirectly dependent on a target formula.
- **Formula history** — retrieves the complete version history for a formula.
- **SQL reporting** — provides seven reporting queries for formula management and execution analytics.
- **Current formula views** — demonstrates aggregate subquery and window-function approaches for retrieving the latest version.

---

## Tech Stack

| Technology | Purpose |
|---|---|
| Node.js 20+ | Backend runtime |
| Express.js | REST API framework |
| MySQL 8.4 | Relational database |
| Docker Compose | Database container setup |
| JavaScript | Backend and formula evaluation logic |
| npm | Package management |

---

## Requirements

Make sure the following are installed:

- Node.js 20 or later
- npm
- Docker Desktop or Docker Engine with Docker Compose

Alternatively, you can use a local MySQL 8.4 server.

---

## Project Structure

```text
Formula_engine_service/
│
├── controllers/
│   └── formulaController.js
│
├── db/
│   ├── pool.js
│   └── saveRecord.js
│
├── routes/
│   └── formulaRoutes.js
│
├── scripts/
│   └── enable-global-...
│
├── services/
│   ├── dependency-...
│   ├── evaluationS...
│   └── formulaServ...
│
├── sql/
│   ├── queries.sql
│   ├── schema.sql
│   ├── views_v1.sql
│   └── views_v2.sql
│
├── tests/
│   └── formulaEngi...
│
├── validation/
│   └── formulaVali...
│
├── .env
├── .env.example
├── .gitignore
├── app.js
├── docker-compose.yml
├── index.js
├── package.json
├── package-lock.json
└── README.md
```

### Directory responsibilities

| Directory/File | Responsibility |
|---|---|
| `controllers/` | Handles incoming HTTP requests and responses |
| `db/` | Database connection pool and shared persistence helper |
| `routes/` | Defines API routes and controller mappings |
| `scripts/` | Supporting runtime scripts |
| `services/` | Formula business logic, evaluation, and dependency processing |
| `sql/` | Schema, views, and reporting queries |
| `tests/` | Automated tests |
| `validation/` | Request and formula validation |
| `app.js` | Express application setup |
| `index.js` | Application startup entry point |
| `docker-compose.yml` | Docker service configuration |
| `package.json` | Project dependencies and npm scripts |
| `.env.example` | Environment configuration template |
| `.gitignore` | Files excluded from version control |
| `README.md` | Project documentation |

---

# Setup and Installation

## 1. Clone the repository

```bash
git clone <your-github-repository-url>
cd Formula_engine_service
```

Replace `<your-github-repository-url>` with the repository's actual URL.

## 2. Configure environment variables

Create a local `.env` file using `.env.example`.

### Windows PowerShell

```powershell
Copy-Item .env.example .env
```

### Linux/macOS

```bash
cp .env.example .env
```

Open `.env` and configure the database credentials and application settings.

Do not commit `.env` or actual database credentials.

## 3. Install dependencies

```bash
npm install
```

## 4. Start MySQL using Docker Compose

```bash
docker compose up -d mysql
```

Check container status:

```bash
docker compose ps
```

Wait for the MySQL container to become healthy.

The schema is installed automatically during the first initialization of the MySQL Docker volume.

> **Important:** MySQL initialization scripts are not automatically executed again when the volume has already been initialized. If you modify `sql/schema.sql`, apply the changes manually or reset only a disposable development database.

## 5. Start the API server

Development mode:

```bash
npm run dev
```

Start mode:

```bash
npm start
```

## 6. Verify the application

Send a GET request to:

```http
GET http://localhost:3000/health
```

The health endpoint should return a successful response when the application is running.

---

# Configuration

The application uses environment variables for configuration.

| Variable | Description | Default |
|---|---|---|
| `PORT` | HTTP server port | `3000` |
| `DB_HOST` | MySQL hostname | `127.0.0.1` |
| `DB_PORT` | MySQL port | `3306` |
| `DB_NAME` | Database name | `formula_engine` |
| `DB_USER` | Database username | `formula_user` |
| `DB_PASSWORD` | Database password | Empty |
| `DB_CONNECTION_LIMIT` | MySQL connection pool size | `15` |
| `FORMULA_TIMEOUT_MS` | Per-formula execution timeout | `2000` |
| `BULK_PREVIEW_CONCURRENCY` | Bulk preview worker concurrency | `10` |

These values can be adjusted in `.env` according to the local environment.

---

# Formula Syntax

Formulas use JavaScript-style syntax and return their result through a `return` statement.

Input data is accessed through `EXTERNAL_VAR`.

### Example

```javascript
return EXTERNAL_VAR.amount * EXTERNAL_VAR.rate / 100;
```

The service also accepts bare identifiers and rewrites them to the interpreter's `EXTERNAL_VAR.CODE.<name>` representation.

For example:

```javascript
return amount * rate / 100;
```

This formula calculates a commission using the provided amount and rate.

### Formula dependencies

Formulas can reference other active formulas.

The formula engine:

1. Detects formula references.
2. Builds a dependency graph.
3. Checks for circular dependencies.
4. Determines the dependency execution order.
5. Evaluates independent formulas concurrently.
6. Propagates failures to dependent formulas.
7. Continues execution of formulas that are independent of failed formulas.

Missing required input fields are rejected before evaluation.

---

# API Documentation

Base URL:

```text
http://localhost:3000
```

## 1. Health Check

**Endpoint**

```http
GET /health
```

Checks the application's health/status.

---

## 2. Create a Formula

**Endpoint**

```http
POST /formulas
```

**Request body**

```json
{
  "name": "commission",
  "formula_text": "return amount * rate / 100;",
  "created_by": "admin",
  "sampleData": {
    "amount": 2000,
    "rate": 10
  }
}
```

**Expected behavior**

- Creates a new formula.
- Generates a UUID for formula identification.
- Starts the formula version history.
- Validates the formula using sample data when provided.
- Returns HTTP `201` when creation succeeds.

A dependent formula may be created before the formula it references. Unknown references are treated as provisional sample inputs during save validation. Preview execution still requires dependencies to be available as active formulas or supplied input fields.

---

## 3. Update a Formula

**Endpoint**

```http
POST /formulas
```

**Request body**

```json
{
  "uuid": "<formula-uuid>",
  "baseVersion": 1,
  "formula_text": "return amount * rate / 100 * 1.05;",
  "created_by": "admin"
}
```

**Expected behavior**

- Requires the formula UUID and `baseVersion`.
- Creates a new formula version.
- Preserves the previous formula version.
- Fields omitted from the request retain their current values.
- Checks the current version before inserting.
- Returns `409 Conflict` when a stale version conflict is detected.

---

## 4. Deactivate a Formula

**Endpoint**

```http
POST /formulas/:uuid/deactivate
```

**Request body**

```json
{
  "baseVersion": 2,
  "created_by": "admin",
  "force": false
}
```

**Expected behavior**

- Creates a new `INACTIVE` formula version.
- Preserves previous versions.
- Checks whether active formulas depend on the target.
- Rejects deactivation when active dependencies exist unless `force` is explicitly enabled.

---

## 5. Roll Back a Formula

**Endpoint**

```http
POST /formulas/:uuid/rollback
```

**Request body**

```json
{
  "version": 1,
  "baseVersion": 3,
  "created_by": "admin"
}
```

**Expected behavior**

- Selects a previous formula version.
- Copies its historical values into a new version.
- Preserves the entire version history.
- Does not modify the historical row being restored.

Rollback is performed through a new insert rather than changing an old version.

---

## 6. List Current Formulas

**Endpoint**

```http
GET /formulas
```

Returns the current version of each formula.

### Include inactive formulas

```http
GET /formulas
```

By default, current active and inactive formula versions are included.

### Active formulas only

```http
GET /formulas?includeInactive=false
```

Returns only active current formulas.

---

## 7. Formula Version History

**Endpoint**

```http
GET /formulas/:uuid/history
```

**Example**

```http
GET /formulas/00000000-0000-4000-8000-000000000001/history
```

Returns the version history for the specified formula, ordered from oldest to newest.

Historical versions are preserved and can be used for auditing and rollback.

---

## 8. Dependency Impact

**Endpoint**

```http
GET /formulas/:uuid/impact
```

**Example**

```http
GET /formulas/00000000-0000-4000-8000-000000000001/impact
```

Returns the target formula and active formulas that directly or indirectly depend on it.

This endpoint helps identify which formulas may be affected when a formula is changed or deactivated.

---

## 9. Single Preview

**Endpoint**

```http
POST /formulas/preview
```

**Request body**

```json
{
  "record": {
    "amount": 2000,
    "rate": 10
  },
  "formulaUuids": [],
  "asOf": "2026-11-20T12:00:00.000Z",
  "timeoutMs": 2000
}
```

### Parameters

| Parameter | Description |
|---|---|
| `record` | Input record used for formula evaluation |
| `formulaUuids` | Optional list of formula UUIDs to evaluate |
| `asOf` | Optional historical version selection timestamp |
| `timeoutMs` | Optional execution timeout |

Omit `formulaUuids` or provide an empty array to preview all active formulas.

Omit `asOf` to use the current versions.

Each preview creates a `run_uuid`. One execution log row is inserted per formula using a batch insert for the run.

---

## 10. Bulk Preview

**Endpoint**

```http
POST /formulas/preview/bulk
```

**Request body**

```json
{
  "records": [
    {
      "amount": 2000,
      "rate": 10
    },
    {
      "amount": 5000,
      "rate": 12
    }
  ],
  "concurrency": 10,
  "timeoutMs": 2000
}
```

### Expected behavior

- Accepts a maximum of 500 records.
- Processes records with configurable concurrency.
- Returns individual record results.
- A failure in one record does not discard other record results.
- Provides total execution time, average time per record, and failure count.

The bulk preview functionality is implemented. However, processing 500 records currently takes approximately 62 seconds in the tested environment, which exceeds the target of under 30 seconds.

---

# Versioning and Concurrency

## Append-only versioning

The `formulas` table stores every formula version as a separate row.

For each formula UUID:

- The highest auto-increment ID determines the current version.
- Existing versions are preserved.
- Editing inserts a new version.
- Deactivation inserts a new inactive version.
- Rollback creates a new version containing the selected historical formula configuration.

The service does not update or delete existing formula business records.

## Current formula selection

The latest version is determined by the highest ID for each formula UUID.

Two MySQL views are provided:

- `v_current_formulas_subquery` — uses an aggregate subquery.
- `v_current_formulas_window` — uses `ROW_NUMBER()` window function.

The service uses the aggregate-subquery view to retrieve current formula versions.

## Optimistic version checking

Formula updates require a `baseVersion`.

The submitted version is compared against the current version before inserting a new row. This is designed to prevent stale updates from silently overwriting newer versions.

A detected version conflict returns:

```http
409 Conflict
```

The current version is included in:

```text
error.details.currentVersion
```

Concurrent conflict handling is covered by the automated test suite, although the concurrency test currently has an unresolved failure involving the expected `409` response.

## Active formula name synchronization

A MySQL named lock is used to serialize active formula-name checks during create and rename operations. The lock is released in a `finally` block.

## Generic insert-only persistence

Database writes use `saveRecord()`.

The helper:

- Discovers the target table's columns.
- Merges an existing logical record when a UUID is supplied.
- Increments the version when the target table supports versioning.
- Performs an INSERT instead of updating an existing business record.

For formula run logs, `uuidColumn: null` is used because `run_uuid` groups multiple execution-log rows and does not represent a versioned formula identity.

---

# Execution Logging

Formula execution results are stored in the `formula_run_logs` table.

Execution logs include relevant information such as:

- Run UUID
- Formula UUID
- Formula name
- Formula version
- Execution status
- Input data
- Result
- Error information
- Execution duration
- Timestamp

### Execution statuses

| Status | Description |
|---|---|
| `SUCCESS` | Formula executed successfully |
| `FAILED` | Formula execution failed |
| `SKIPPED` | Formula was skipped because a required dependency failed |

Each preview run has a run UUID that groups the executions belonging to the same run.

Run logs are insert-only and are preserved for auditing and troubleshooting.

---

# Database Design

## `formulas`

Stores formula definitions and their historical versions.

Each row represents a particular version of a formula.

Relevant fields include:

- ID
- UUID
- Name
- Version
- Formula text
- Status
- Created by
- First creation timestamp
- Version creation timestamp

## `formula_run_logs`

Stores formula evaluation records.

Each row records the execution of a formula, including run identifiers, formula identity, execution status, inputs, results, errors, and duration.

## Current formula views

### `v_current_formulas_subquery`

Uses a grouped subquery and `MAX(id)` to select the latest version for each formula UUID.

### `v_current_formulas_window`

Uses the `ROW_NUMBER()` window function, partitioning by formula UUID and ordering versions by ID descending to select the latest version.

Both views demonstrate different approaches for retrieving current formula versions.

---

# SQL Reporting

The project includes seven reporting queries in `sql/queries.sql`.

| # | Report | Purpose |
|---|---|---|
| 1 | Full version history | Retrieves every version of a formula |
| 2 | Active formulas in dependency execution order | Lists active formulas in dependency order |
| 3 | Total number of versions per formula | Summarizes version counts and timestamps |
| 4 | Run statistics for the last 7 days | Summarizes successful, failed, and skipped runs |
| 5 | Top 5 most failing formulas | Identifies formulas with the highest failure counts |
| 6 | Deactivated and never reactivated formulas | Finds formulas that remain deactivated |
| 7 | Time between consecutive versions | Calculates time intervals between formula changes |

All seven SQL reports were executed and validated against the local MySQL database.

The SQL dependency-order report uses text matching and is intended for operational reporting. The JavaScript dependency parser is authoritative for dependency resolution and cycle validation during formula execution.

---

# SQL Files

| File | Description |
|---|---|
| `sql/schema.sql` | Creates business tables, indexes, and initial views |
| `sql/views_v1.sql` | Current formula view using aggregate subquery |
| `sql/views_v2.sql` | Current formula view using window function |
| `sql/queries.sql` | Seven required SQL reporting queries |
| `SQL_TESTING.md` | SQL validation results and testing documentation |

---

# Testing

Run the automated test suite:

```bash
npm test
```

The tests include unit and database integration coverage for:

- Formula evaluation
- Rounding
- Dependency order
- Cycle detection
- Formula timeout handling
- Failure propagation
- Skipped dependent formulas
- Insert-only persistence
- Version conflict handling
- Dependency impact
- Rollback
- Bulk preview throughput

## Database testing safety

The integration suite truncates database tables for test isolation.

**Run integration tests only against a disposable test database. Never run them against a production database or one containing important data.**

A successful syntax check alone is not a substitute for running the integration tests against MySQL.

## Known limitations

- The concurrent formula edit test currently has an unresolved failure involving the expected `409 Conflict` response.
- Bulk preview of 500 records currently takes approximately 62 seconds in the tested environment, exceeding the target of under 30 seconds.
- The SQL dependency-order report uses text matching and is less reliable for complex formula syntax than the application's dependency parser.

These are known areas for further improvement.

---

# Insert-only Storage: Trade-offs

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
14. Monitor query plans, index size, table growth, and buffer-pool hit rates.
15. If scale requires it, introduce read replicas or a separately maintained read model without changing the append-only source of truth.

---

# Security Notes

- Do not commit `.env` files.
- Never commit database passwords or production credentials.
- `.env.example` should contain placeholders only.
- Use a dedicated database for automated testing.
- Avoid exposing sensitive database information through API errors.
- Validate incoming formula requests and input records.
- Keep database credentials and configuration outside source code.

---

# Future Improvements

- Improve concurrent version conflict handling and ensure consistent `409 Conflict` behavior.
- Optimize bulk preview to meet the 500-record, under-30-second requirement.
- Improve formula execution isolation and resource control.
- Improve dependency parsing for complex formula expressions.
- Add additional integration tests for concurrent writes and edge cases.
- Add performance monitoring and query-plan analysis.
- Introduce archival strategies for large execution-log datasets.

---

# Author
Developed as a backend formula engine assignment demonstrating versioned business logic, insert-only persistence, formula dependency management, execution logging, API design, MySQL reporting, and containerized development.
Developed as a backend formula engine assignment demonstrating versioned business logic, insert-only persistence, formula dependency management, execution logging, API design, MySQL reporting, and containerized development.
