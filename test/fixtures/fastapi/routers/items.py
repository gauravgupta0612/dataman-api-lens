from fastapi import APIRouter
router = APIRouter(prefix="/items", tags=["items"])

@router.get("/")
def list_items(skip: int = 0, limit: int = 10):
    return []

@router.put("/{item_id}")
def update_item(item_id: str, item: "Item"):
    return {}
