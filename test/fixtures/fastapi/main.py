from fastapi import FastAPI, Header, Query, Depends
from pydantic import BaseModel
from typing import Optional
from .routers import items

app = FastAPI()
app.include_router(items.router, prefix="/api")

class User(BaseModel):
    name: str
    email: str
    age: Optional[int] = None

@app.get("/users/{user_id}")
async def get_user(user_id: int, q: Optional[str] = None, x_token: str = Header(...), db = Depends(get_db)):
    return {}

@app.post("/users", status_code=201)
def create_user(user: User):
    return user
