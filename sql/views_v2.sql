
-- View Version 2: Current formula using a window function
-- ROW_NUMBER assigns a rank to each version within its UUID.

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
