-- Insert-only schema for Formula Engine Service (MySQL 8.4)
-- Rule: Never execute UPDATE or DELETE on business tables. Every change inserts a new row.

CREATE TABLE IF NOT EXISTS formulas (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  uuid CHAR(36) NOT NULL,
  name VARCHAR(100) NOT NULL,
  version INT UNSIGNED NOT NULL DEFAULT 1,
  formula_text TEXT NOT NULL,
  status ENUM('ACTIVE', 'INACTIVE') NOT NULL DEFAULT 'ACTIVE',
  created_by VARCHAR(100) NOT NULL,
  first_created_at DATETIME(6) NOT NULL,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  INDEX idx_formulas_uuid_id (uuid, id),
  INDEX idx_formulas_uuid_created_at (uuid, created_at, id),
  INDEX idx_formulas_status_uuid_id (status, uuid, id),
  INDEX idx_formulas_name_id (name, id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS formula_run_logs (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  run_uuid CHAR(36) NOT NULL,
  formula_uuid CHAR(36) NOT NULL,
  formula_id BIGINT UNSIGNED NOT NULL,
  formula_name VARCHAR(100) NOT NULL,
  formula_version INT UNSIGNED NOT NULL,
  status ENUM('SUCCESS', 'FAILED', 'SKIPPED') NOT NULL,
  input_payload JSON NULL,
  result_value DECIMAL(18, 2) NULL,
  raw_result_text TEXT NULL,
  calculation_text MEDIUMTEXT NULL,
  error_message TEXT NULL,
  duration_ms INT UNSIGNED NULL,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  INDEX idx_run_logs_run_uuid (run_uuid),
  INDEX idx_run_logs_formula_uuid_created (formula_uuid, created_at),
  INDEX idx_run_logs_formula_name_status_created (formula_name, status, created_at),
  INDEX idx_run_logs_created_at (created_at),
  CONSTRAINT fk_run_logs_formula_row
    FOREIGN KEY (formula_id) REFERENCES formulas (id)
    ON DELETE RESTRICT ON UPDATE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- View 1: Current formulas using an aggregate subquery (MAX(id) per uuid)
CREATE OR REPLACE VIEW v_current_formulas_subquery AS
SELECT
  f.id,
  f.uuid,
  f.name,
  f.version,
  f.formula_text,
  f.status,
  f.created_by,
  f.first_created_at,
  f.created_at
FROM formulas f
INNER JOIN (
  SELECT uuid, MAX(id) AS max_id
  FROM formulas
  GROUP BY uuid
) latest
  ON f.uuid = latest.uuid
 AND f.id = latest.max_id;

-- View 2: Current formulas using a window function (ROW_NUMBER())
CREATE OR REPLACE VIEW v_current_formulas_window AS
WITH ranked_formulas AS (
  SELECT
    f.id,
    f.uuid,
    f.name,
    f.version,
    f.formula_text,
    f.status,
    f.created_by,
    f.first_created_at,
    f.created_at,
    ROW_NUMBER() OVER (
      PARTITION BY f.uuid
      ORDER BY f.id DESC
    ) AS rn
  FROM formulas f
)
SELECT
  id,
  uuid,
  name,
  version,
  formula_text,
  status,
  created_by,
  first_created_at,
  created_at
FROM ranked_formulas
WHERE rn = 1;