"""Live, read-only REST adapter."""
from app.servicenow.read_client import ServiceNowReadClient

def get_sn_read_client():
    return ServiceNowReadClient()

async def get_sn_client():
    async with ServiceNowReadClient() as client:
        yield client
