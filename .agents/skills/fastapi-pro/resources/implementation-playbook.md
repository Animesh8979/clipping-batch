# FastAPI Pro Implementation Playbook (2026 Production Standard)

This playbook provides copy-pasteable, verified patterns for FastAPI 0.115+, Pydantic v2, and modern async Python on Windows and Linux.

---

## 1. Application Lifespan Pattern (Replacing Deprecated `@app.on_event`)

Modern FastAPI uses `@asynccontextmanager` for application lifespan management (startup & shutdown).

```python
from contextlib import asynccontextmanager
from typing import AsyncGenerator
from fastapi import FastAPI
import logging

logger = logging.getLogger("uvicorn.info")

@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncGenerator[None, None]:
    # --- STARTUP LOGIC ---
    logger.info("Initializing connection pools and background resources...")
    # e.g., await db.init_pool()
    
    yield  # Application serves requests here
    
    # --- SHUTDOWN LOGIC ---
    logger.info("Closing connection pools and flushing queues...")
    # e.g., await db.close_pool()

app = FastAPI(
    title="High-Performance Microservice",
    version="2.0.0",
    lifespan=lifespan
)
```

---

## 2. Pydantic v2 Modern Schemas & Validation

Always use Pydantic v2 idioms:
- `ConfigDict` instead of inner `class Config:`
- `model_dump()` instead of `.dict()`
- `model_validate()` instead of `.parse_obj()`
- `@field_validator` instead of `@validator`

```python
from pydantic import BaseModel, Field, ConfigDict, field_validator
from datetime import datetime
from typing import Optional

class UserCreate(BaseModel):
    model_config = ConfigDict(strict=True, from_attributes=True)

    username: str = Field(..., min_length=3, max_length=50, pattern=r"^[a-zA-Z0-9_-]+$")
    email: str = Field(..., max_length=255)
    full_name: Optional[str] = Field(None, max_length=100)

    @field_validator("email")
    @classmethod
    def validate_email(cls, v: str) -> str:
        if "@" not in v or "." not in v.split("@")[-1]:
            raise ValueError("Invalid email format")
        return v.lower().strip()

class UserResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    username: str
    email: str
    full_name: Optional[str] = None
    created_at: datetime
```

---

## 3. Type-Safe Dependency Injection with `Annotated`

FastAPI recommends using `typing.Annotated` for clean, reusable dependencies.

```python
from typing import Annotated
from fastapi import Depends, HTTPException, status, Header

async def verify_api_key(x_api_key: Annotated[str, Header(...)]) -> str:
    if x_api_key != "secret-token":
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid or missing API Key"
        )
    return x_api_key

ApiKeyDep = Annotated[str, Depends(verify_api_key)]

@app.get("/api/v1/secure-data")
async def get_secure_data(token: ApiKeyDep):
    return {"status": "ok", "authenticated": True}
```

---

## 4. Windows File Lock & Async Process Safety

When running FastAPI background processes on Windows:
1. Always handle `KeyboardInterrupt` cleanly.
2. Use `uvicorn.run(app, host="127.0.0.1", port=8000, reload=False)` in production/test scripts.
3. If hot-reloading with static files, always restart the uvicorn process after frontend builds to avoid stale chunk caching (FastAPI StaticFiles caches directory manifests at boot).
