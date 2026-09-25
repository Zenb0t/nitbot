# Register: data (migrations, schemas, queries, models)

Data changes are the hardest to undo. Weigh reversibility and deploy order above style.

- **Deploy order:** during a rolling deploy, old code runs against the new schema and new code against the old one. A dropped or renamed column, or a new NOT NULL column without a default, breaks whichever side comes first.
- **Locks and duration:** adding an index without `CONCURRENTLY` (Postgres), rewriting a large table, or a backfill inside the migration transaction. Estimate against production-sized tables, not fixtures.
- **Reversibility:** a down migration that loses data or does not exist; a destructive step in the same migration as an additive one.
- **Backfills:** existing rows that do not satisfy a new constraint; defaults applied only to new rows.
- **Queries:** N+1 access from a new loop, a new filter without an index, unbounded result sets, missing pagination, string-built SQL.
- **Transactions:** multi-step writes that can half-complete; reads that assume a consistency level the database is not giving.
- **Model/schema drift:** the ORM model, the migration, and the generated types disagree. The map's co-change section often catches the missing partner.
- **Personal data:** new columns holding personal data without the retention, masking, or access rules the rest of the schema uses.
