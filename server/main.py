import asyncio
import logging
import os
import secrets
import time
from contextlib import asynccontextmanager

import asyncpg
import httpx
from fastapi import Depends, FastAPI, HTTPException, Response
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from pydantic import BaseModel, Field, HttpUrl

DATABASE_URL = os.environ["DATABASE_URL"]
API_TOKEN = os.environ["API_TOKEN"]
CHECK_INTERVAL = int(os.environ.get("CHECK_INTERVAL", "30"))

SCHEMA = """
create table if not exists services (
    id serial primary key,
    name text not null unique,
    url text not null,
    status text not null default 'unknown'
);
create table if not exists checks (
    id bigserial primary key,
    service_id int not null references services on delete cascade,
    at timestamptz not null default now(),
    ok boolean not null,
    code int,
    ms int,
    error text
);
create index if not exists checks_service_id on checks (service_id, id desc);
create table if not exists incidents (
    id serial primary key,
    service_id int not null references services on delete cascade,
    title text not null,
    auto boolean not null default false,
    opened_at timestamptz not null default now(),
    closed_at timestamptz
);
"""

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
db: asyncpg.Pool


async def probe(client, url):
    start = time.monotonic()
    try:
        r = await client.get(url)
    except httpx.HTTPError as e:
        return False, None, None, type(e).__name__
    return r.status_code < 400, r.status_code, int((time.monotonic() - start) * 1000), None


async def check(client, service):
    ok, code, ms, error = await probe(client, service["url"])
    status = "up" if ok else "down"
    async with db.acquire() as c, c.transaction():
        await c.execute("insert into checks (service_id, ok, code, ms, error) values ($1, $2, $3, $4, $5)", service["id"], ok, code, ms, error)
        await c.execute("update services set status = $2 where id = $1", service["id"], status)
        if status == "down" and service["status"] != "down":
            await c.execute("insert into incidents (service_id, title, auto) values ($1, $2, true)", service["id"], f"{service['name']} не работает")
            logging.info("incident opened: %s", service["name"])
        if ok and await c.fetchval("update incidents set closed_at = now() where service_id = $1 and auto and closed_at is null returning id", service["id"]):
            logging.info("incident closed: %s", service["name"])


async def checker():
    async with httpx.AsyncClient(timeout=5, follow_redirects=True) as client:
        while True:
            try:
                services = await db.fetch("select * from services")
                for result in await asyncio.gather(*(check(client, s) for s in services), return_exceptions=True):
                    if isinstance(result, Exception):
                        logging.error("check failed: %r", result)
            except Exception:
                logging.exception("checker failed")
            await asyncio.sleep(CHECK_INTERVAL)


@asynccontextmanager
async def lifespan(app):
    global db
    db = await asyncpg.create_pool(DATABASE_URL)
    await db.execute(SCHEMA)
    task = asyncio.create_task(checker())
    yield
    task.cancel()
    await db.close()


app = FastAPI(title="Status Page", lifespan=lifespan)
bearer = HTTPBearer(auto_error=False)


def operator(creds: HTTPAuthorizationCredentials | None = Depends(bearer)):
    if creds is None or not secrets.compare_digest(creds.credentials, API_TOKEN):
        raise HTTPException(401, "Нужен токен оператора")


class ServiceIn(BaseModel):
    name: str = Field(min_length=1, max_length=100)
    url: HttpUrl


class IncidentIn(BaseModel):
    service_id: int
    title: str = Field(min_length=3, max_length=200)


def rows(records):
    return [dict(r) for r in records]


def found(record, what):
    if record is None:
        raise HTTPException(404, f"{what} не найден")
    return dict(record)


@app.get("/status")
async def status():
    services = await db.fetch("select id, name, status from services order by name")
    incidents = await db.fetch("select * from incidents where closed_at is null order by id desc")
    statuses = {s["status"] for s in services}
    overall = next((s for s in ("down", "up") if s in statuses), "unknown")
    return {"status": overall, "services": rows(services), "incidents": rows(incidents)}


@app.get("/services")
async def list_services():
    return rows(await db.fetch("select * from services order by id"))


@app.post("/services", status_code=201, dependencies=[Depends(operator)])
async def create_service(data: ServiceIn):
    try:
        return dict(await db.fetchrow("insert into services (name, url) values ($1, $2) returning *", data.name, str(data.url)))
    except asyncpg.UniqueViolationError:
        raise HTTPException(409, "Сервис с таким названием уже есть")


@app.put("/services/{service_id}", dependencies=[Depends(operator)])
async def update_service(service_id: int, data: ServiceIn):
    try:
        record = await db.fetchrow("update services set name = $2, url = $3 where id = $1 returning *", service_id, data.name, str(data.url))
    except asyncpg.UniqueViolationError:
        raise HTTPException(409, "Сервис с таким названием уже есть")
    return found(record, "Сервис")


@app.delete("/services/{service_id}", status_code=204, dependencies=[Depends(operator)])
async def delete_service(service_id: int):
    found(await db.fetchrow("delete from services where id = $1 returning id", service_id), "Сервис")
    return Response(status_code=204)


@app.get("/services/{service_id}/checks")
async def history(service_id: int):
    found(await db.fetchrow("select id from services where id = $1", service_id), "Сервис")
    checks = await db.fetch("select at, ok, code, ms, error from checks where service_id = $1 order by id desc limit 100", service_id)
    uptime = round(100 * sum(c["ok"] for c in checks) / len(checks), 1) if checks else None
    return {"uptime": uptime, "checks": rows(checks)}


@app.get("/incidents")
async def list_incidents():
    return rows(await db.fetch("select * from incidents order by id desc limit 100"))


@app.post("/incidents", status_code=201, dependencies=[Depends(operator)])
async def create_incident(data: IncidentIn):
    try:
        return dict(await db.fetchrow("insert into incidents (service_id, title) values ($1, $2) returning *", data.service_id, data.title))
    except asyncpg.ForeignKeyViolationError:
        raise HTTPException(404, "Сервис не найден")


@app.post("/incidents/{incident_id}/close", dependencies=[Depends(operator)])
async def close_incident(incident_id: int):
    record = await db.fetchrow("update incidents set closed_at = now() where id = $1 and closed_at is null returning *", incident_id)
    return found(record, "Открытый инцидент")


@app.get("/health")
async def health():
    try:
        await db.fetchval("select 1")
    except Exception:
        raise HTTPException(503, "База недоступна")
    return {"status": "ok"}
