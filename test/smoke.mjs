import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { seedIfEmpty } from '../src/seed.js';
import { createApp } from '../src/app.js';
import { deviceKey } from '../src/auth.js';

const db = openDb(':memory:');
const t0 = Date.now(); const n = seedIfEmpty(db);
console.log(`seeded ${n} readings in ${Date.now() - t0}ms`);
const srv = createApp(db).listen(0); const base = `http://127.0.0.1:${srv.address().port}`;
const api = async (m, p, { token, body, headers = {} } = {}) => {
  const r = await fetch(base + p, { method: m, headers: { ...(token && { Authorization: `Bearer ${token}` }), ...(body && { 'Content-Type': 'application/json' }), ...headers }, body: body && JSON.stringify(body) });
  const t = await r.text(); return { s: r.status, h: r.headers, j: t ? JSON.parse(t) : null, raw: t };
};
let pass = 0; const ok = (c, m) => { assert.ok(c, m); pass++; console.log('  ok', m); };

const login = async (e) => (await api('POST', '/api/v1/auth/token', { body: { email: e, password: 'SolarLK#2026' } })).j.access_token;
const nat = await login('national@slsea.lk'), colombo = await login('colombo.district@slsea.lk'), west = await login('western.provincial@slsea.lk');
const c = await api('GET', '/health'); console.log('  counts', c.j.counts);
ok(c.j.counts.installations >= 200 && c.j.counts.readings > 100000, 'seed scale (>=200 installations, >100k readings)');
ok((await api('GET', '/api/v1/provinces', { token: nat })).j.pagination.total_count === 9, '9 provinces');
ok((await api('GET', '/api/v1/districts', { token: nat })).j.pagination.total_count === 25, '25 districts');
ok((await api('GET', '/api/v1/substations', { token: nat })).j.pagination.total_count >= 20, '>=20 substations');

// pagination / sort / filter
const p = await api('GET', '/api/v1/installations/1/readings?page_size=10&sort=timestamp', { token: nat });
ok(p.j.data.length === 10 && p.j.pagination.total_count >= 672 && p.j.links.next && !p.j.links.prev, 'pagination: total_count + next link, no prev on page 1');
ok(p.h.get('link').includes('rel="next"') && p.h.get('x-total-count'), 'Link + X-Total-Count headers');
ok(p.j.data[0].timestamp < p.j.data[9].timestamp, 'sort ascending');
const d = await api('GET', '/api/v1/installations/1/readings?page_size=2&sort=-timestamp', { token: nat });
ok(d.j.data[0].timestamp > d.j.data[1].timestamp, 'sort descending');
const w = await api('GET', `/api/v1/readings?district=1&from=${d.j.data[1].timestamp}&page_size=5`, { token: nat });
ok(w.s === 200 && w.j.data.every((r) => r.timestamp >= d.j.data[1].timestamp), 'jurisdiction + time-window filter');
ok((await api('GET', '/api/v1/installations/1/readings?sort=bogus', { token: nat })).s === 400, '400 on bad sort');

// conditional GET
const a = await api('GET', '/api/v1/installations/1', { token: nat }); const et = a.h.get('etag');
const nm = await api('GET', '/api/v1/installations/1', { token: nat, headers: { 'If-None-Match': et } });
ok(nm.s === 304 && nm.raw === '', '304 with empty body via If-None-Match');
ok((await api('GET', '/api/v1/installations/1', { token: nat, headers: { 'If-Modified-Since': new Date(Date.now() + 1e6).toUTCString() } })).s === 304, '304 via If-Modified-Since');

// derived + composite + summary
const lr = await api('GET', '/api/v1/installations/1/last-reading', { token: nat });
ok(lr.s === 200 && lr.j.installation_id === 1, 'last-known reading');
const ov = await api('GET', '/api/v1/installations/1/overview', { token: nat });
ok(ov.j.province && ov.j.last_24h.reading_count > 0, 'composite overview');
const sm = await api('GET', '/api/v1/districts/1/generation-summary', { token: nat }); console.log('  summary', JSON.stringify(sm.j));
ok(sm.s === 200 && sm.j.active_installations > 0, 'district generation summary');

// content negotiation + errors
ok((await api('GET', '/api/v1/provinces', { token: nat, headers: { Accept: 'text/xml' } })).s === 406, '406 for Accept: text/xml');
const e404 = await api('GET', '/api/v1/installations/99999', { token: nat });
ok(e404.s === 404 && e404.j.error.code && e404.j.error.message && Array.isArray(e404.j.error.details), 'consistent error body (404)');
ok((await api('GET', '/api/v1/installations/abc', { token: nat })).j.error.code === 'validation_failed', 'consistent error body (400)');
const m405 = await api('DELETE', '/api/v1/installations/1/readings/1', { token: nat }); ok(m405.s === 405 && m405.h.get('allow'), '405 + Allow (readings immutable)');

// security: jurisdiction scoping
const inst = (await api('GET', '/api/v1/installations?page_size=500', { token: nat })).j.data;
const colInst = inst.find((i) => i.district_id === 1), otherInst = inst.find((i) => i.province_id !== 1);
ok((await api('GET', `/api/v1/installations/${colInst.id}`, { token: colombo })).s === 200, 'district user reads own district');
ok((await api('GET', `/api/v1/installations/${otherInst.id}`, { token: colombo })).s === 403, 'district user blocked from other jurisdiction (403)');
ok((await api('GET', '/api/v1/districts/2', { token: colombo })).s === 403, 'district user cannot read another district');
const own = await api('GET', '/api/v1/installations?page_size=500', { token: colombo });
ok(own.j.data.every((i) => i.district_id === 1), 'list auto-scoped to jurisdiction');
ok((await api('GET', '/api/v1/installations?page_size=500', { token: west })).j.data.every((i) => i.province_id === 1), 'provincial user scoped to province');
ok((await api('GET', '/api/v1/installations/1')).s === 401, '401 without token');
ok((await api('POST', '/api/v1/auth/token', { body: { email: 'national@slsea.lk', password: 'wrong' } })).s === 401, '401 bad credentials');

// write-read split: device
const dev = async (id) => { const m = db.prepare('SELECT meter_id FROM installations WHERE id=?').get(id).meter_id; return (await api('POST', '/api/v1/auth/device-token', { body: { meter_id: m, device_key: deviceKey(m) } })).j.access_token; };
const d1 = await dev(1);
ok((await api('POST', '/api/v1/auth/device-token', { body: { meter_id: 'SLM-000001', device_key: 'nope' } })).s === 401, 'bad device key rejected');
const reading = { power_kw: 1.5, energy_kwh: 9999.5, voltage_v: 231.2, timestamp: new Date(Date.now() + 60000).toISOString() };
const cr = await api('POST', '/api/v1/installations/1/readings', { token: d1, body: reading });
ok(cr.s === 201 && cr.h.get('location')?.includes('/installations/1/readings/'), '201 + Location on ingest');
ok((await api('GET', new URL(cr.h.get('location')).pathname, { token: nat })).s === 200, 'Location resolves to the new reading');
ok((await api('POST', '/api/v1/installations/1/readings', { token: d1, body: reading })).s === 200, 'identical retry is idempotent (200)');
ok((await api('POST', '/api/v1/installations/1/readings', { token: d1, body: { ...reading, power_kw: 2 } })).s === 409, 'conflicting duplicate -> 409');
ok((await api('POST', '/api/v1/installations/2/readings', { token: d1, body: reading })).s === 403, 'device cannot write another installation');
ok((await api('GET', '/api/v1/installations/1', { token: d1 })).s === 403, 'device cannot READ (write-only)');
ok((await api('POST', '/api/v1/installations/1/readings', { token: nat, body: reading })).s === 403, 'SLSEA user cannot write readings');
ok((await api('POST', '/api/v1/installations/1/readings', { token: d1, body: { power_kw: -1 } })).j.error.details.length >= 2, 'validation details');

// CRUD on installation
const newI = await api('POST', '/api/v1/substations/1/installations', { token: nat, body: { meter_id: 'SLM-900001', name: 'Test Roof', owner_name: 'T. Tester', capacity_kw: 5, latitude: 6.9, longitude: 79.8 } });
ok(newI.s === 201 && newI.j.device_key && newI.h.get('location'), 'create installation 201 + Location + device_key');
const nid = newI.j.id, loc = new URL(newI.h.get('location')).pathname;
ok((await api('POST', '/api/v1/substations/1/installations', { token: nat, body: { meter_id: 'SLM-900001', name: 'x', owner_name: 'y', capacity_kw: 5, latitude: 6.9, longitude: 79.8 } })).s === 409, 'duplicate meter_id -> 409');
ok((await api('POST', '/api/v1/substations/1/installations', { token: colombo, body: {} })).s === 403, 'non-national cannot create');
const cur = await api('GET', loc, { token: nat });
const full = { meter_id: 'SLM-900001', name: 'Renamed', owner_name: 'T. Tester', capacity_kw: 6, latitude: 6.9, longitude: 79.8, status: 'active', substation_id: 1 };
ok((await api('PUT', loc, { token: nat, headers: { 'If-Match': '"stale"' }, body: full })).s === 412, '412 on stale If-Match');
const put1 = await api('PUT', loc, { token: nat, headers: { 'If-Match': cur.h.get('etag') }, body: full });
ok(put1.s === 200 && put1.j.name === 'Renamed', 'PUT with matching ETag');
ok((await api('PATCH', loc, { token: nat, body: { capacity_kw: 7 } })).j.capacity_kw === 7, 'PATCH partial update');
ok((await api('DELETE', loc, { token: nat })).s === 204 && (await api('GET', loc, { token: nat })).s === 404, 'DELETE 204 then 404');
ok((await api('GET', '/openapi.json')).j.openapi === '3.0.3', 'OpenAPI served');
ok((await fetch(base + '/docs')).status === 200, 'Swagger UI served');
console.log(`\nALL ${pass} CHECKS PASSED`); srv.close(); process.exit(0);
