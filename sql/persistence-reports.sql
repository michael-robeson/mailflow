-- These aggregate reports contain sensitive metadata. Run only on the Mailflow database.
SELECT count(*) AS message_count FROM mailflow.messages;

SELECT category, count(*) AS classifications
FROM mailflow.classifications GROUP BY category ORDER BY category;

SELECT action, count(*) AS decisions
FROM mailflow.policy_decisions GROUP BY action ORDER BY action;

SELECT date_trunc('day', processed_at) AS processing_day, count(*) AS runs
FROM mailflow.workflow_runs GROUP BY 1 ORDER BY 1;
