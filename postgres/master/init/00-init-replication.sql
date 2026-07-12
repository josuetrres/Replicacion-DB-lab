-- =============================================================
--  PostgreSQL Master — Initialization Script
--  Runs once when the container is first created.
-- =============================================================

-- 1. Create the replication role.
--    REPLICATION: allows the role to open WAL streaming connections.
--    LOGIN:       allows it to authenticate.
--    The password is read from the PG_REPL_PASSWORD env var at runtime via pg_hba.conf.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT FROM pg_catalog.pg_roles WHERE rolname = 'replicator'
    ) THEN
        CREATE ROLE replicator
            WITH REPLICATION
                 LOGIN
                 PASSWORD 'repl_secure_pass123';
    END IF;
END
$$;

-- 2. Create a physical replication slot for each replica.
--    Replication slots guarantee the master retains WAL segments until
--    each connected replica has consumed them, preventing data loss on
--    slow or temporarily disconnected replicas.
SELECT pg_create_physical_replication_slot('replica1_slot')
WHERE NOT EXISTS (
    SELECT 1 FROM pg_replication_slots WHERE slot_name = 'replica1_slot'
);

SELECT pg_create_physical_replication_slot('replica2_slot')
WHERE NOT EXISTS (
    SELECT 1 FROM pg_replication_slots WHERE slot_name = 'replica2_slot'
);

-- 3. Create the sample application schema.
CREATE TABLE IF NOT EXISTS students (
    id         SERIAL PRIMARY KEY,
    name       VARCHAR(100)  NOT NULL,
    email      VARCHAR(150)  NOT NULL UNIQUE,
    course     VARCHAR(100)  DEFAULT 'Computer Science',
    enrolled_at TIMESTAMPTZ  DEFAULT NOW()
);

-- 4. Seed a few rows so replicas have data immediately after cloning.
INSERT INTO students (name, email, course) VALUES
    ('Alice Reyes',    'alice@universidad.edu',  'Distributed Systems'),
    ('Bruno Ferreira', 'bruno@universidad.edu',  'Database Engineering'),
    ('Clara Mendez',   'clara@universidad.edu',  'Cloud Computing')
ON CONFLICT (email) DO NOTHING;
