
-- View Version 1: Current formula using aggregate subquery
-- Selects the row with the highest ID for each formula UUID.

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
    SELECT
        uuid,
        MAX(id) AS max_id
    FROM formulas
    GROUP BY uuid
) latest
    ON f.uuid = latest.uuid
   AND f.id = latest.max_id;
