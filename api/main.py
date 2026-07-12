"""
=================================================================
  lab_replica — FastAPI REST API  (PostgreSQL WAL replication)
=================================================================
"""

from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager
from datetime import datetime
from typing import Any, Literal

import asyncpg
from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

# Shared pool state and helpers (also used by failover.py)
import state
from state import (
    pg_pools,
    PG_MASTER_HOST, PG_REPLICA1_HOST, PG_REPLICA2_HOST, ALL_PG_HOSTS,
    pg_host as _pg_host,
    get_pg_pool as _get_pg_pool,
    probe_pg_pool,
)

# Failover router (separate file — /pg/write/{node}, /pg/failover/*)
from failover import router as failover_router


# ─────────────────────────────────────────────────────────────
#  Connection helpers
# ─────────────────────────────────────────────────────────────

async def _create_pg_pool(host: str) -> asyncpg.Pool:
    return await asyncpg.create_pool(
        host=host,
        port=state.PG_PORT,
        database=state.PG_DB,
        user=state.PG_USER,
        password=state.PG_PASS,
        min_size=1,
        max_size=5,
        command_timeout=10,
    )


async def _try_connect(host: str, retries: int = 10, delay: float = 3.0) -> asyncpg.Pool | None:
    for attempt in range(1, retries + 1):
        try:
            pool = await _create_pg_pool(host)
            print(f"[PG] Connected to {host} (attempt {attempt})")
            return pool
        except Exception as exc:
            print(f"[PG] {host} not ready ({attempt}/{retries}): {exc}")
            if attempt < retries:
                await asyncio.sleep(delay)
    print(f"[PG] WARNING: could not connect to {host} after {retries} attempts.")
    return None


# ─────────────────────────────────────────────────────────────
#  Lifespan
# ─────────────────────────────────────────────────────────────

@asynccontextmanager
async def lifespan(app: FastAPI):
    print("=== lab_replica API starting ===")
    results = await asyncio.gather(
        _try_connect(PG_MASTER_HOST),
        _try_connect(PG_REPLICA1_HOST),
        _try_connect(PG_REPLICA2_HOST),
    )
    for host, pool in zip(ALL_PG_HOSTS, results):
        if pool:
            pg_pools[host] = pool   # ← written into state.pg_pools (same dict)
    print(f"=== PG pools ready: {list(pg_pools.keys())} ===")
    yield
    print("=== lab_replica API shutting down ===")
    for pool in pg_pools.values():
        await pool.close()


# ─────────────────────────────────────────────────────────────
#  App
# ─────────────────────────────────────────────────────────────

app = FastAPI(
    title="lab_replica — PostgreSQL Replication API",
    description=(
        "Write-to-master / read-from-replica demo for PostgreSQL WAL physical replication. "
        "Includes API-driven failover (stop master, promote replica) — no `docker exec` needed."
    ),
    version="3.0.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# Mount the failover router (provides /pg/write/{node} and /pg/failover/*)
app.include_router(failover_router)


# ─────────────────────────────────────────────────────────────
#  Schemas
# ─────────────────────────────────────────────────────────────

class StudentIn(BaseModel):
    name:   str
    email:  str
    course: str = "Computer Science"


# ─────────────────────────────────────────────────────────────
#  Health  — live SELECT 1 probe per node
# ─────────────────────────────────────────────────────────────

@app.get("/health", tags=["System"], summary="API health check (live probes)")
async def health():
    """
    Runs **SELECT 1** on every node with a 3-second timeout.
    Reports the *real* connection state — not cached pool existence.
    """
    statuses = await asyncio.gather(
        probe_pg_pool(PG_MASTER_HOST),
        probe_pg_pool(PG_REPLICA1_HOST),
        probe_pg_pool(PG_REPLICA2_HOST),
    )
    pg_status = {
        PG_MASTER_HOST:   statuses[0],
        PG_REPLICA1_HOST: statuses[1],
        PG_REPLICA2_HOST: statuses[2],
    }
    return {
        "status":     "ok" if any(s == "connected" for s in statuses) else "degraded",
        "timestamp":  datetime.utcnow().isoformat(),
        "postgresql": pg_status,
    }


# ─────────────────────────────────────────────────────────────
#  Write  — always to master (original endpoint)
# ─────────────────────────────────────────────────────────────

@app.post(
    "/pg/students",
    tags=["PostgreSQL"],
    status_code=201,
    summary="Insert a student → pg-master",
)
async def pg_create_student(student: StudentIn):
    """Inserts into pg-master. WAL propagates the change to replicas."""
    pool = _get_pg_pool(PG_MASTER_HOST)
    try:
        async with pool.acquire() as conn:
            row = await conn.fetchrow(
                "INSERT INTO students (name, email, course) VALUES ($1,$2,$3) "
                "RETURNING id, name, email, course, enrolled_at",
                student.name, student.email, student.course,
            )
    except asyncpg.UniqueViolationError:
        raise HTTPException(status_code=409, detail="Email already exists.")
    except Exception as exc:
        raise HTTPException(status_code=503, detail=str(exc))

    return {
        "message":     "Student created.",
        "source_node": PG_MASTER_HOST,
        "role":        "MASTER (write)",
        "student":     dict(row),
    }


# ─────────────────────────────────────────────────────────────
#  Read  — any node
# ─────────────────────────────────────────────────────────────

@app.get(
    "/pg/students",
    tags=["PostgreSQL"],
    summary="List students from Master or Replica",
)
async def pg_list_students(
    from_node: Literal["master", "replica1", "replica2"] = Query(
        default="replica1",
        description="Which node to read from.",
    )
):
    host = _pg_host(from_node)
    pool = _get_pg_pool(host)
    try:
        async with pool.acquire() as conn:
            rows = await conn.fetch(
                "SELECT id, name, email, course, enrolled_at FROM students ORDER BY id"
            )
    except Exception as exc:
        raise HTTPException(status_code=503, detail=str(exc))

    return {
        "source_node": host,
        "role": "MASTER (read)" if from_node == "master" else f"REPLICA ({from_node})",
        "count":       len(rows),
        "students":    [dict(r) for r in rows],
    }


# ─────────────────────────────────────────────────────────────
#  Replication Status
# ─────────────────────────────────────────────────────────────

@app.get("/pg/status", tags=["PostgreSQL"], summary="pg_stat_replication (master)")
async def pg_replication_status():
    pool = _get_pg_pool(PG_MASTER_HOST)
    try:
        async with pool.acquire() as conn:
            stream = await conn.fetch(
                "SELECT client_addr, application_name, state, "
                "sent_lsn::text, write_lsn::text, flush_lsn::text, "
                "replay_lsn::text, sync_state FROM pg_stat_replication"
            )
            slots = await conn.fetch(
                "SELECT slot_name, slot_type, active, restart_lsn::text "
                "FROM pg_replication_slots"
            )
    except Exception as exc:
        raise HTTPException(status_code=503, detail=str(exc))

    return {
        "source_node":        PG_MASTER_HOST,
        "replication_stream": [dict(r) for r in stream],
        "replication_slots":  [dict(r) for r in slots],
    }


@app.get("/pg/replica-status", tags=["PostgreSQL"], summary="pg_stat_wal_receiver (replica)")
async def pg_replica_status(
    from_node: Literal["replica1", "replica2"] = Query(default="replica1")
):
    host = _pg_host(from_node)
    pool = _get_pg_pool(host)
    try:
        async with pool.acquire() as conn:
            rows = await conn.fetch("SELECT * FROM pg_stat_wal_receiver")
    except Exception as exc:
        raise HTTPException(status_code=503, detail=str(exc))

    return {"source_node": host, "wal_receiver": [dict(r) for r in rows]}


# ─────────────────────────────────────────────────────────────
#  Consistency Demo
# ─────────────────────────────────────────────────────────────

@app.post("/demo/consistency", tags=["Demo"], summary="Write master → read replica1 (50ms gap)")
async def demo_consistency(student: StudentIn):
    """Inserts into pg-master, waits 50 ms, reads from pg-replica1."""
    results: dict[str, Any] = {}

    master_pool = _get_pg_pool(PG_MASTER_HOST)
    try:
        async with master_pool.acquire() as conn:
            row = await conn.fetchrow(
                "INSERT INTO students (name, email, course) VALUES ($1,$2,$3) "
                "RETURNING id, name, email, course, enrolled_at",
                student.name, student.email, student.course,
            )
        results["pg_write"] = {"node": PG_MASTER_HOST, "student": dict(row)}
    except asyncpg.UniqueViolationError:
        raise HTTPException(status_code=409, detail="Email already exists.")
    except Exception as exc:
        results["pg_write"] = {"node": PG_MASTER_HOST, "error": str(exc)}

    await asyncio.sleep(0.05)

    r1_pool = pg_pools.get(PG_REPLICA1_HOST)
    if r1_pool:
        try:
            async with r1_pool.acquire() as conn:
                rows = await conn.fetch(
                    "SELECT id, name, email, enrolled_at FROM students ORDER BY id DESC LIMIT 5"
                )
            results["pg_replica1_read"] = {"node": PG_REPLICA1_HOST, "latest_5": [dict(r) for r in rows]}
        except Exception as exc:
            results["pg_replica1_read"] = {"node": PG_REPLICA1_HOST, "error": str(exc)}

    results["demo_note"] = (
        "If the new record appears in pg_replica1_read, replication lag is <50 ms. "
        "Otherwise call GET /pg/students?from_node=replica1 a moment later."
    )
    return results
