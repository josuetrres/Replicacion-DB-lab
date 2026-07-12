"""
Shared database state — imported by both main.py and failover.py.
Keeps the pg_pools dict as a single mutable object so both modules
always reference the same live state.
"""

from __future__ import annotations

import asyncio
import os

import asyncpg

# ─── Connection config ─────────────────────────────────────────────────

PG_MASTER_HOST   = os.getenv("PG_MASTER_HOST",   "pg-master")
PG_REPLICA1_HOST = os.getenv("PG_REPLICA1_HOST", "pg-replica1")
PG_REPLICA2_HOST = os.getenv("PG_REPLICA2_HOST", "pg-replica2")
PG_PORT          = int(os.getenv("PG_PORT",       "5432"))
PG_DB            = os.getenv("POSTGRES_DB",       "university")
PG_USER          = os.getenv("POSTGRES_USER",     "postgres")
PG_PASS          = os.getenv("POSTGRES_PASSWORD", "pg_master_pass")

ALL_PG_HOSTS = [PG_MASTER_HOST, PG_REPLICA1_HOST, PG_REPLICA2_HOST]

# ─── Shared pool dict ──────────────────────────────────────────────────
# This dict is populated at startup (lifespan in main.py) and
# referenced from failover.py without copying.

pg_pools: dict[str, asyncpg.Pool] = {}

# ─── Helpers ───────────────────────────────────────────────────────────

NODE_LABELS = {
    PG_MASTER_HOST:   "pg-master",
    PG_REPLICA1_HOST: "pg-replica1",
    PG_REPLICA2_HOST: "pg-replica2",
}


def pg_host(node: str) -> str:
    """Convert a node alias ('master', 'replica1', 'replica2') to a hostname."""
    return {
        "master":   PG_MASTER_HOST,
        "replica1": PG_REPLICA1_HOST,
        "replica2": PG_REPLICA2_HOST,
    }.get(node, PG_MASTER_HOST)


def get_pg_pool(host: str) -> asyncpg.Pool:
    """Retrieve a pool or raise HTTP 503 if not initialised."""
    from fastapi import HTTPException
    pool = pg_pools.get(host)
    if pool is None:
        raise HTTPException(
            status_code=503,
            detail=f"Node '{host}' pool not initialised (never connected or never started).",
        )
    return pool


async def probe_pg_pool(host: str) -> str:
    """
    Returns 'connected' or 'disconnected' by running a live SELECT 1
    with a tight timeout.  The pool object existing in memory is NOT
    enough — we must make a real network round-trip.
    """
    pool = pg_pools.get(host)
    if pool is None:
        return "disconnected"
    try:
        async with asyncio.timeout(3):
            async with pool.acquire() as conn:
                await conn.fetchval("SELECT 1")
        return "connected"
    except Exception:
        return "disconnected"
