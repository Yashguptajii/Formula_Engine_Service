# SQL Validation Results

Database: MySQL 8.4  
Database name: `service`

## 1. Schema Validation
- `formulas` table exists.
- `formula_run_logs` table exists.
- Both current-formula views exist.

## 2. Current Formula Views

### View 1: Aggregate Subquery
`v_current_formulas_subquery` executed successfully and returned the latest formula version.

### View 2: Window Function
`v_current_formulas_window` executed successfully and returned the same latest formula version as View 1.

**Result:** PASS — Both views returned consistent results.

## 3. SQL Reports

| Report | Description | Status |
|---|---|---|
| 1 | Full version history | PASS |
| 2 | Active formulas in dependency execution order | PASS |
| 3 | Total versions per formula | PASS |
| 4 | Run statistics for last 7 days | PASS |
| 5 | Top 5 failing formulas with latest error | PASS |
| 6 | Deactivated formulas never reactivated | PASS |
| 7 | Time between consecutive versions | PASS |

## 4. Environment

- MySQL version: 8.4
- Database runs through Docker Compose.
- SQL validation performed against the project database.