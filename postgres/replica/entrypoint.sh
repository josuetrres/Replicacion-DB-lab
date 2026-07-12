#!/bin/bash
# =============================================================
#  PostgreSQL Replica — Entrypoint Script
#
#  This script runs inside the replica container at startup.
#  It waits for the master to be healthy, clones its data using
#  pg_basebackup with the -R flag (which automatically creates
#  standby.signal and writes primary_conninfo into
#  postgresql.auto.conf), then starts PostgreSQL in standby mode.
#
#  Environment variables consumed:
#    PGPASSWORD          — password for the replication user
#    PG_MASTER_HOST      — hostname of the master (default: pg-master)
#    PG_REPL_USER        — replication username (default: replicator)
#    PG_REPLICA_SLOT     — replication slot name on the master
#    PGDATA              — PostgreSQL data directory (default: /var/lib/postgresql/data)
# =============================================================

set -e

PG_MASTER_HOST="${PG_MASTER_HOST:-pg-master}"
PG_REPL_USER="${PG_REPL_USER:-replicator}"
PGDATA="${PGDATA:-/var/lib/postgresql/data}"
REPLICA_SLOT="${PG_REPLICA_SLOT:-replica1_slot}"

echo "======================================================"
echo "  PostgreSQL Replica Starting"
echo "  Master host : ${PG_MASTER_HOST}"
echo "  Repl user   : ${PG_REPL_USER}"
echo "  Data dir    : ${PGDATA}"
echo "  Slot name   : ${REPLICA_SLOT}"
echo "======================================================"

# ------------------------------------------------------------------
# Step 1: Wait for the master to accept connections.
# ------------------------------------------------------------------
echo "[replica] Waiting for master at ${PG_MASTER_HOST}:5432 ..."
until pg_isready -h "${PG_MASTER_HOST}" -p 5432 -U "${PG_REPL_USER}"; do
    echo "[replica] Master not ready yet — sleeping 2s ..."
    sleep 2
done
echo "[replica] Master is ready. Proceeding with base backup."

# ------------------------------------------------------------------
# Step 2: Clean the data directory so pg_basebackup can write to it.
# ------------------------------------------------------------------
if [ -d "${PGDATA}" ] && [ "$(ls -A "${PGDATA}")" ]; then
    echo "[replica] Data directory ${PGDATA} is not empty — removing old data."
    rm -rf "${PGDATA:?}"/*
fi

# ------------------------------------------------------------------
# Step 3: Clone the master using pg_basebackup.
#   -h  : master hostname
#   -U  : replication user
#   -D  : target data directory
#   -Fp : plain format (copy files as-is)
#   -Xs : include WAL via streaming during backup (avoids WAL gap)
#   -P  : show progress
#   -R  : write standby.signal + primary_conninfo automatically
#         (this is the key flag that makes the replica know it is a standby)
#   --slot : use the pre-created replication slot so master holds WAL for us
# ------------------------------------------------------------------
echo "[replica] Running pg_basebackup ..."
PGPASSWORD="${PGPASSWORD}" pg_basebackup \
    -h "${PG_MASTER_HOST}" \
    -p 5432 \
    -U "${PG_REPL_USER}" \
    -D "${PGDATA}" \
    -Fp \
    -Xs \
    -P \
    -R \
    --slot="${REPLICA_SLOT}"

echo "[replica] pg_basebackup complete."

# ------------------------------------------------------------------
# Step 4: Append the replication slot name to postgresql.auto.conf
#   pg_basebackup -R writes primary_conninfo but does NOT write
#   primary_slot_name, so we add it manually.
# ------------------------------------------------------------------
echo "primary_slot_name = '${REPLICA_SLOT}'" >> "${PGDATA}/postgresql.auto.conf"
echo "hot_standby = on"                       >> "${PGDATA}/postgresql.auto.conf"
echo "hot_standby_feedback = on"              >> "${PGDATA}/postgresql.auto.conf"

echo "[replica] Configured replication slot: ${REPLICA_SLOT}"

# ------------------------------------------------------------------
# Step 5: Fix permissions — PostgreSQL is strict about data dir perms.
# ------------------------------------------------------------------
chmod 0700 "${PGDATA}"
chown -R postgres:postgres "${PGDATA}" 2>/dev/null || true

# ------------------------------------------------------------------
# Step 6: Hand off to the standard postgres entrypoint to start the
#   server in hot standby (streaming replication) mode.
# ------------------------------------------------------------------
echo "[replica] Starting PostgreSQL in hot standby mode ..."
exec gosu postgres postgres -D "${PGDATA}"
