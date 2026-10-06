# SLSEA Real-Time Solar Generation Data API (NB6007CEM)

Node.js 22 · zero runtime dependencies (built-in `node:http`, `node:sqlite`, `node:crypto`) · REST, Richardson Level 2 · OpenAPI 3 + Swagger UI.

## Run
```
npm start            # http://localhost:3000/docs  (seeds on first boot, ~1 s)
npm test             # 40+ end-to-end checks against a seeded in-memory DB
npm run device-key -- SLM-000001   # derive a device credential (JWT_SECRET must match)
```
Env: `PORT`, `DB_PATH`, `JWT_SECRET` (required in production), `DEMO_PASSWORD`, `SIMULATE=false` to disable the 15-minute device simulator.

## Demo credentials (password `SolarLK#2026`)
`national@slsea.lk` · `western.provincial@slsea.lk` · `colombo.district@slsea.lk` (one per province / district: `<slug>.provincial@slsea.lk`, `<slug>.district@slsea.lk`).
Devices: `POST /api/v1/auth/device-token {meter_id:"SLM-000001", device_key:<npm run device-key>}`.

## Surface (all under /api/v1, JSON)
| Capability | Endpoint |
|---|---|
| Hierarchy | `/provinces`, `/provinces/{id}/districts`, `/districts`, `/districts/{id}/substations`, `/substations`, `/substations/{id}/installations`, `/installations` |
| Composite | `GET /installations/{id}/overview` |
| Derived (operational) | `GET /installations/{id}/last-reading` |
| History (analytical) | `GET /installations/{id}/readings`, `GET /readings` (page, page_size, sort, from, to, province, district, substation) |
| Device ingest | `POST /installations/{id}/readings` → 201 + `Location` (replay of identical reading → 200; conflicting → 409) |
| Installation CRUD | `POST /substations/{id}/installations`, `PUT/PATCH/DELETE /installations/{id}` (national role; `If-Match` → 412) |
| Processing (stretch) | `GET /districts/{id}/generation-summary` |
| Auth | `POST /auth/token`, `POST /auth/device-token` |
Also: ETag / Last-Modified / 304, 406, 415, 405+Allow, one error schema `{error:{code,message,details[],status,request_id}}`.

## Deploy (public HTTPS)
Render: push to GitHub → New Web Service → Docker (uses `render.yaml`). Fly/Railway/any Docker host works; mount `/data` for persistence, otherwise the DB reseeds on each boot (fine for the demo).
Then add the module leader as a repository collaborator and commit incrementally.

## AI disclosure (appendix template - fill with your real prompts)
Record: tool/model, each prompt used, what you changed after reviewing it against the guidelines.
