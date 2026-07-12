"""
=================================================================
  Failover Router  —  /pg/failover/*
  Provides API-driven failover operations so the wizard never
  needs docker exec commands:

    GET  /pg/failover/recovery-status/{node}
         → pg_is_in_recovery() on any node

    POST /pg/failover/stop-master
         → Stops the pg-master Docker container via Docker SDK

    POST /pg/failover/promote/{node}
         → Calls SELECT pg_promote() on replica1 or replica2

    POST /pg/write/{node}
         → Attempts an INSERT on the given node.
           Replicas fail with a clear read-only error while in
           recovery mode, but SUCCEED after pg_promote().
=================================================================
"""

from __future__ import annotations

import asyncio
from typing import Literal

import asyncpg
import docker as docker_sdk
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

import state

router = APIRouter(tags=["Failover"])


# ─────────────────────────────────────────────────────────────
#  Schema (reused from main)
# ─────────────────────────────────────────────────────────────

class StudentIn(BaseModel):
    name:   str
    email:  str
    course: str = "Computer Science"


# ─────────────────────────────────────────────────────────────
#  Write to ANY node  (main lab feature)
#
#  While a replica is in recovery:
#    → PostgreSQL raises "cannot execute INSERT in a read-only
#      transaction" → we surface it as HTTP 409 with explanation.
#
#  After pg_promote():
#    → The same replica accepts the INSERT → HTTP 201 success.
#
#  This endpoint is the core of the failover demonstration.etc
# ─────────────────────────────────────────────────────────────

@router.post(
    "/pg/write/{node}",
    status_code=201,
    summary="Attempt to write to any node (master, replica1, or replica2)",
)
async def write_to_node(
    node: Literal["master", "replica1", "replica2"],
    student: StudentIn,
):
    """
    **Try an INSERT on the specified node.**

    - **master**: succeeds (when up).
    - **replica1 / replica2**: fails with `409 Read-Only` while in
      WAL recovery mode; **succeeds after** `POST /pg/failover/promote/{node}`.

    This is the key endpoint for the failover demo — showing that
    replicas reject writes until promoted.
    """
    host = state.pg_host(node)
    pool = state.get_pg_pool(host)
    role_label = "MASTER" if node == "master" else f"REPLICA ({node})"

    try:
        async with pool.acquire() as conn:
            row = await conn.fetchrow(
                """
                INSERT INTO students (name, email, course)
                VALUES ($1, $2, $3)
                RETURNING id, name, email, course, enrolled_at
                """,
                student.name, student.email, student.course,
            )
    except asyncpg.UniqueViolationError:
        raise HTTPException(status_code=409, detail="Email already exists.")
    except asyncpg.exceptions.ReadOnlySQLTransactionError:
        raise HTTPException(
            status_code=409,
            detail=(
                f"Node '{host}' is in READ-ONLY mode (WAL recovery / standby). "
                "This is the expected behaviour while the master is running. "
                "Stop the master, then call POST /pg/failover/promote/{node} "
                "to promote this replica — after that, this endpoint will succeed."
            ),
        )
    except Exception as exc:
        # Could be: "cannot execute INSERT in a read-only transaction" (older PG msg)
        msg = str(exc)
        if "read-only" in msg.lower():
            raise HTTPException(
                status_code=409,
                detail=(
                    f"Node '{host}' rejected the write: {msg}. "
                    "Promote this replica first via POST /pg/failover/promote/{node}."
                ),
            )
        raise HTTPException(status_code=503, detail=msg)

    return {
        "message":     f"Student inserted via {role_label}.",
        "source_node": host,
        "role":        role_label,
        "promoted_write": node != "master",   # True when a replica accepted the write
        "student":     dict(row),
    }


# ─────────────────────────────────────────────────────────────
#  Recovery Status — pg_is_in_recovery()
# ─────────────────────────────────────────────────────────────

@router.get(
    "/pg/failover/recovery-status/{node}",
    summary="Check if a node is primary or standby (pg_is_in_recovery)",
)
async def recovery_status(
    node: Literal["master", "replica1", "replica2"],
):
    """
    Runs `SELECT pg_is_in_recovery()` on the chosen node.
    - `false` → the node is a **primary** (accepts writes).
    - `true`  → the node is a **standby** (read-only, following master).
    """
    host = state.pg_host(node)
    pool = state.get_pg_pool(host)
    try:
        async with pool.acquire() as conn:
            in_recovery = await conn.fetchval("SELECT pg_is_in_recovery()")
    except Exception as exc:
        raise HTTPException(status_code=503, detail=str(exc))

    return {
        "node":        host,
        "in_recovery": in_recovery,
        "role":        "STANDBY — read-only (WAL recovery)" if in_recovery else "PRIMARY — read-write",
        "can_write":   not in_recovery,
    }


# ─────────────────────────────────────────────────────────────
#  Stop Master — Docker SDK
# ─────────────────────────────────────────────────────────────

@router.post(
    "/pg/failover/stop-master",
    summary="Stop the pg-master container (simulates a server crash)",
)
async def stop_master():
    """
    Stops the **pg-master** Docker container via the Docker SDK
    (requires `/var/run/docker.sock` to be mounted in the API container).

    This simulates a primary server failure without requiring
    any `docker exec` or CLI commands.
    """
    try:
        client = docker_sdk.from_env()
        container = client.containers.get("pg-master")
        status_before = container.status
        container.stop(timeout=5)
        return {
            "message":        "pg-master stopped successfully.",
            "container":      "pg-master",
            "status_before":  status_before,
            "status_after":   "exited",
            "next_step":      "Call POST /pg/failover/promote/replica1 to elect a new primary.",
        }
    except docker_sdk.errors.NotFound:
        raise HTTPException(
            status_code=404,
            detail="Container 'pg-master' not found. Is the stack running?",
        )
    except docker_sdk.errors.DockerException as exc:
        raise HTTPException(
            status_code=500,
            detail=f"Docker SDK error: {exc}",
        )


# ─────────────────────────────────────────────────────────────
#  Promote Replica  — pg_promote()
# ─────────────────────────────────────────────────────────────

@router.post(
    "/pg/failover/promote/{node}",
    summary="Promote a replica to primary via SELECT pg_promote()",
)
async def promote_node(
    node: Literal["replica1", "replica2"],
):
    """
    Calls `SELECT pg_promote(wait := true, wait_seconds := 10)` on
    the chosen replica.  This is equivalent to `pg_ctl promote` but
    runs **entirely through SQL** — no `docker exec` needed.

    - If the replica is already primary, returns 200 with `promoted = false`.
    - On success the replica becomes the new primary and accepts writes.
    """
    host = state.pg_host(node)
    pool = state.get_pg_pool(host)

    # 1. Check current state
    try:
        async with pool.acquire() as conn:
            in_recovery = await conn.fetchval("SELECT pg_is_in_recovery()")
    except Exception as exc:
        raise HTTPException(status_code=503, detail=f"Cannot reach {host}: {exc}")

    if not in_recovery:
        return {
            "message":   f"{host} is already a primary — no promotion needed.",
            "node":      host,
            "promoted":  False,
            "in_recovery_after": False,
        }

    # 2. Call pg_promote()
    try:
        async with pool.acquire() as conn:
            result = await conn.fetchval(
                "SELECT pg_promote(wait := true, wait_seconds := 10)"
            )
    except Exception as exc:
        raise HTTPException(
            status_code=500,
            detail=f"pg_promote() failed on {host}: {exc}",
        )

    # 3. Wait 1 s for the promotion to settle then re-check
    await asyncio.sleep(1.2)
    try:
        async with pool.acquire() as conn:
            in_recovery_after = await conn.fetchval("SELECT pg_is_in_recovery()")
    except Exception:
        in_recovery_after = None   # node may be briefly restarting

    return {
        "message":           f"{host} promoted to PRIMARY." if not in_recovery_after else f"Promotion signal sent to {host} (check recovery-status to confirm).",
        "node":              host,
        "promoted":          True,
        "pg_promote_result": result,
        "in_recovery_after": in_recovery_after,
        "can_write_now":     not in_recovery_after if in_recovery_after is not None else "unknown",
        "next_step":         f"Call POST /pg/write/{node} to prove this node now accepts writes.",
    }
