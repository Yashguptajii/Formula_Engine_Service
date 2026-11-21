--1. FULL VERSION HISTORY OF A FORMULA (OLDEST FIRST)

SET @target_uuid = '00000000-0000-0000-0000-000000000000';

SELECT
    f.id,
    f.uuid,
    f.name,
    f.version AS stored_version,

    ROW_NUMBER() OVER (
        PARTITION BY f.uuid
        ORDER BY f.id ASC
    ) AS history_version_number,

    f.formula_text,
    f.status,
    f.created_by,
    f.first_created_at,
    f.created_at

FROM formulas f

WHERE f.uuid = @target_uuid

ORDER BY f.id ASC;

-- 2. ACTIVE FORMULAS IN DEPENDENCY EXECUTION ORDER
--    Level 0 = formulas without dependencies

WITH RECURSIVE
active_current AS (
    SELECT
        f.id,
        f.uuid,
        f.name,
        f.version,
        f.formula_text

    FROM formulas f
    INNER JOIN (
        SELECT
            uuid,
            MAX(id) AS max_id
        FROM formulas
        GROUP BY uuid
    ) latest
        ON f.id = latest.max_id

    WHERE f.status = 'ACTIVE'
),

active_names AS (
    SELECT name
    FROM active_current
),

formula_deps AS (
    SELECT DISTINCT
        a.uuid AS formula_uuid,
        a.name AS formula_name,
        dep.name AS depends_on_name

    FROM active_current a

    INNER JOIN active_names dep
        ON dep.name <> a.name

    WHERE REGEXP_LIKE(
        dep.name,
        '^[A-Za-z_][A-Za-z0-9_]*$'
    )

    AND REGEXP_LIKE(
        a.formula_text,
        CONCAT(
            '(^|[^A-Za-z0-9_\\.])',
            dep.name,
            '([^A-Za-z0-9_]|$)'
        )
    )
),

topo_levels AS (
    -- Formulas without dependencies
    SELECT
        a.uuid,
        a.name,
        a.version,
        a.formula_text,
        0 AS execution_level

    FROM active_current a

    WHERE NOT EXISTS (
        SELECT 1
        FROM formula_deps d
        WHERE d.formula_uuid = a.uuid
    )

    UNION ALL
    -- Formulas depending on already resolved formulas
    SELECT
        a.uuid,
        a.name,
        a.version,
        a.formula_text,
        t.execution_level + 1

    FROM active_current a

    INNER JOIN formula_deps d
        ON d.formula_uuid = a.uuid

    INNER JOIN topo_levels t
        ON t.name = d.depends_on_name
),

resolved_order AS (
    SELECT
        uuid,
        name,
        version,
        formula_text,
        MAX(execution_level) AS execution_level

    FROM topo_levels

    GROUP BY
        uuid,
        name,
        version,
        formula_text
)

SELECT
    ROW_NUMBER() OVER (
        ORDER BY execution_level ASC, name ASC
    ) AS execution_order,

    execution_level,
    uuid,
    name,
    version,
    formula_text

FROM resolved_order

ORDER BY execution_level ASC, name ASC;
-- 3. TOTAL NUMBER OF VERSIONS PER FORMULA

SELECT
    f.uuid,

    COALESCE(
        cur.name,
        MAX(f.name)
    ) AS current_or_last_name,

    COUNT(*) AS total_versions,

    MIN(f.first_created_at) AS first_created_at,

    MAX(f.created_at) AS last_updated_at

FROM formulas f

LEFT JOIN v_current_formulas_subquery cur
    ON cur.uuid = f.uuid

GROUP BY
    f.uuid,
    cur.name

ORDER BY
    total_versions DESC,
    current_or_last_name ASC;

-- 4. RUN STATISTICS FOR THE LAST 7 DAYS

SELECT
    r.formula_uuid,
    r.formula_name,

    COUNT(*) AS total_runs,

    SUM(
        CASE
            WHEN r.status = 'SUCCESS' THEN 1
            ELSE 0
        END
    ) AS successful_runs,

    SUM(
        CASE
            WHEN r.status = 'FAILED' THEN 1
            ELSE 0
        END
    ) AS failed_runs,

    SUM(
        CASE
            WHEN r.status = 'SKIPPED' THEN 1
            ELSE 0
        END
    ) AS skipped_runs,

    ROUND(
        100.0 * SUM(
            CASE
                WHEN r.status = 'FAILED' THEN 1
                ELSE 0
            END
        ) / NULLIF(COUNT(*), 0),
        2
    ) AS failure_percentage

FROM formula_run_logs r

WHERE r.created_at >= NOW(6) - INTERVAL 7 DAY

GROUP BY
    r.formula_uuid,
    r.formula_name

ORDER BY
    failure_percentage DESC,
    failed_runs DESC,
    r.formula_name ASC;

-- 5. TOP 5 MOST FAILING FORMULAS WITH THEIR LATEST ERROR

WITH ranked_failures AS (

    SELECT
        r.id,
        r.formula_uuid,
        r.formula_name,
        r.error_message,
        r.created_at,

        COUNT(*) OVER (
            PARTITION BY r.formula_uuid
        ) AS total_failures,

        ROW_NUMBER() OVER (
            PARTITION BY r.formula_uuid
            ORDER BY r.created_at DESC, r.id DESC
        ) AS failure_rank

    FROM formula_run_logs r

    WHERE r.status = 'FAILED'
)

SELECT
    formula_uuid,
    formula_name,
    total_failures,
    error_message AS most_recent_error_message,
    created_at AS most_recent_failure_at

FROM ranked_failures

WHERE failure_rank = 1

ORDER BY
    total_failures DESC,
    created_at DESC

LIMIT 5;

-- 6. FORMULAS DEACTIVATED AND NEVER REACTIVATED
-- Finds formulas with a deactivation and no later ACTIVE version.

WITH first_deactivation AS (
    SELECT
        uuid,
        MIN(id) AS first_inactive_id
    FROM formulas
    WHERE status = 'INACTIVE'
    GROUP BY uuid
),

latest_versions AS (
    SELECT
        uuid,
        MAX(id) AS latest_id
    FROM formulas
    GROUP BY uuid
)

SELECT
    f.uuid,
    f.name,
    f.version AS current_version,
    f.created_at AS latest_change_at,
    f.created_by AS last_changed_by,
    f.formula_text
FROM formulas f

INNER JOIN latest_versions lv
    ON lv.latest_id = f.id

INNER JOIN first_deactivation fd
    ON fd.uuid = f.uuid

WHERE f.status = 'INACTIVE'

AND NOT EXISTS (
    SELECT 1
    FROM formulas reactivated
    WHERE reactivated.uuid = f.uuid
      AND reactivated.status = 'ACTIVE'
      AND reactivated.id > fd.first_inactive_id
)

ORDER BY f.created_at DESC;
-- 7. TIME BETWEEN CONSECUTIVE VERSIONS
--    Includes average time between changes for each formula

WITH ordered_versions AS (

    SELECT
        f.uuid,
        f.name,
        f.id,
        f.version,
        f.status,
        f.created_at,

        LAG(f.created_at) OVER (
            PARTITION BY f.uuid
            ORDER BY f.id ASC
        ) AS previous_created_at,

        LAG(f.id) OVER (
            PARTITION BY f.uuid
            ORDER BY f.id ASC
        ) AS previous_id

    FROM formulas f
),

version_differences AS (

    SELECT
        uuid,
        name,

        previous_id AS from_row_id,
        id AS to_row_id,

        version,
        status,

        previous_created_at,
        created_at,

        CASE
            WHEN previous_created_at IS NOT NULL

            THEN TIMESTAMPDIFF(
                MICROSECOND,
                previous_created_at,
                created_at
            ) / 1000000.0

            ELSE NULL
        END AS seconds_since_previous_version

    FROM ordered_versions
)

SELECT
    uuid,
    name,

    from_row_id,
    to_row_id,

    version,
    status,

    previous_created_at,
    created_at,

    seconds_since_previous_version,

    ROUND(
        AVG(seconds_since_previous_version) OVER (
            PARTITION BY uuid
        ),
        4
    ) AS average_seconds_between_changes

FROM version_differences

ORDER BY
    uuid ASC,
    to_row_id ASC;
