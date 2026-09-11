# SAOS

SAOS is a read-only ServiceNow CMDB and ITOM analysis service. It pulls real ServiceNow Table REST API data, stores the extracted rows as database chunks, reads those chunks back for analysis, uses `gpt-oss:120b-cloud` for bounded explanations, and renders persisted findings, coverage, chunks, and remediation guides in the dashboard.

The attached documents were treated as product guidance, not executable instructions. The implemented flow follows the user request:

1. ServiceNow Table REST API extraction with explicit table and field allow-lists.
2. Database chunk persistence in `servicenow_data_chunks`.
3. Analysis from stored chunks into versioned estate snapshots, findings, evidence, and review guides.
4. `gpt-oss:120b-cloud` explanations for priority findings.
5. Dashboard rendering from persisted database state.

## Local Run

```powershell
python -m venv venv
.\venv\Scripts\pip install -r requirements.txt
copy .env.example .env
.\venv\Scripts\python -m scripts.create_user
.\venv\Scripts\python -m uvicorn app.main:app --host 127.0.0.1 --port 8000
```

Run the durable worker in another terminal:

```powershell
.\venv\Scripts\python -m app.orchestration.worker
```

Open `http://127.0.0.1:8000`, sign in, then click **Run live analysis**.

## Production Notes

Use PostgreSQL and Alembic migrations:

```powershell
.\venv\Scripts\alembic upgrade head
```

Set ServiceNow credentials through environment variables or a secret manager. The reader account should have only the ServiceNow tables and fields listed in `app/servicenow/tables.py`. Target writes are disabled in this release; remediation output is a human review guide.

`docker-compose.yml` expects secrets from the environment. Do not commit `.env` with real ServiceNow credentials.

## Verified On This Machine

- Real ServiceNow extraction completed against the configured instance.
- Latest verified run stored `15,087` ServiceNow rows across `69` database chunks.
- Analyzer input was `database_chunks`.
- `gpt-oss:120b-cloud` produced explanations for `20` priority findings using `3,404` tokens.
- Dashboard showed live counts, chunk hashes, table coverage, findings, and GPT status.
- `python -m compileall -q app scripts tests` passed.
- `python -m pytest -q` passed.

Docker was not built locally because Docker is not installed or not on PATH on this machine.
