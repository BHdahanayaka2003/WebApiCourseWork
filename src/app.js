import http from 'node:http';
import crypto from 'node:crypto';
import { signJwt, verifyJwt, verifyPassword, deviceKey } from './auth.js';
import { buildSpec } from './openapi.js';

const BASE = '/api/v1';
const iso = (d) => new Date(d).toISOString().replace(/\.\d{3}Z$/, 'Z');
const num = (v) => typeof v === 'number' && Number.isFinite(v);

export class ApiError extends Error {
  constructor(status, code, message, details = [], headers = {}) {
    super(message); Object.assign(this, { status, code, details, headers });
  }
}
const invalid = (details) => new ApiError(400, 'validation_failed', 'Request validation failed', details);
const notFound = (what) => new ApiError(404, 'not_found', `${what} not found`);
const forbidden = (msg = 'You do not have access to this resource') => new ApiError(403, 'forbidden', msg);

export function createApp(db) {
  const routes = [];
  const route = (method, path, auth, handler, opts = {}) => {
    const keys = [];
    const re = new RegExp('^' + path.replace(/:(\w+)/g, (_, k) => (keys.push(k), '([^/]+)')) + '$');
    routes.push({ method, re, keys, auth, handler, ...opts });
  };
  const q = (sql) => db.prepare(sql);

 
  const etagOf = (body) => `"${crypto.createHash('sha1').update(body).digest('hex').slice(0, 24)}"`;
  const intParam = (v, field, { min = 1, max = Infinity } = {}) => {
    if (v === undefined || v === null || v === '') return null;
    if (!/^\d+$/.test(String(v)) || +v < min || +v > max) throw invalid([{ field, issue: `must be an integer between ${min} and ${max === Infinity ? 'infinity' : max}` }]);
    return +v;
  };
  const idParam = (v, field = 'id') => { const n = intParam(v, field); if (n === null) throw invalid([{ field, issue: 'required' }]); return n; };
  const tsParam = (v, field) => {
    if (v === undefined || v === null || v === '') return null;
    const d = new Date(v);
    if (Number.isNaN(d.getTime())) throw invalid([{ field, issue: 'must be an ISO-8601 timestamp' }]);
    return iso(d);
  };
 
  const scope = (u, provCol, distCol) =>
    u.role === 'national' ? ['1=1', []]
    : u.role === 'provincial' ? [`${provCol} = ?`, [u.province_id]]
    : [`${distCol} = ?`, [u.district_id]];
  const assertScope = (u, row) => {
    if (u.role === 'national') return;
    if (u.role === 'provincial' && row.province_id === u.province_id) return;
    if (u.role === 'district' && row.district_id === u.district_id) return;
    throw forbidden('Resource is outside your jurisdiction');
  };

  function listQuery(ctx, { cols, from, where = [], params = [], sorts, defaultSort, tie }) {
    const sp = ctx.url.searchParams;
    const page = intParam(sp.get('page'), 'page') ?? 1;
    const size = intParam(sp.get('page_size'), 'page_size', { max: 500 }) ?? 100;
    let sort = sp.get('sort') || defaultSort, dir = 'ASC';
    if (sort.startsWith('-')) { dir = 'DESC'; sort = sort.slice(1); }
    if (!sorts[sort]) throw invalid([{ field: 'sort', issue: `must be one of: ${Object.keys(sorts).join(', ')} (prefix with - for descending)` }]);
    const w = where.length ? 'WHERE ' + where.join(' AND ') : '';
    const total = q(`SELECT COUNT(*) c FROM ${from} ${w}`).get(...params).c;
    const rows = q(`SELECT ${cols} FROM ${from} ${w} ORDER BY ${sorts[sort]} ${dir}, ${tie} ${dir} LIMIT ? OFFSET ?`)
      .all(...params, size, (page - 1) * size);
    const pages = Math.max(1, Math.ceil(total / size));
    const link = (p) => { const u = new URL(ctx.url); u.searchParams.set('page', p); u.searchParams.set('page_size', size); return ctx.origin + u.pathname + u.search; };
    const links = { self: link(page), first: link(1), last: link(pages), prev: page > 1 ? link(Math.min(page - 1, pages)) : null, next: page < pages ? link(page + 1) : null };
    const linkHdr = Object.entries(links).filter(([, v]) => v).map(([k, v]) => `<${v}>; rel="${k}"`).join(', ');
    return {
      status: 200,
      body: { data: rows, pagination: { page, page_size: size, total_count: total, total_pages: pages }, links },
      headers: { Link: linkHdr, 'X-Total-Count': String(total) },
    };
  }

  const instRep = (r) => ({ id: r.id, meter_id: r.meter_id, name: r.name, owner_name: r.owner_name, capacity_kw: r.capacity_kw,
    latitude: r.latitude, longitude: r.longitude, status: r.status, substation_id: r.substation_id, district_id: r.district_id,
    province_id: r.province_id, installed_on: r.installed_on, created_at: r.created_at, updated_at: r.updated_at });
  const readRep = (r) => ({ id: r.id, installation_id: r.installation_id, timestamp: r.ts, power_kw: r.power_kw, energy_kwh: r.energy_kwh, voltage_v: r.voltage_v });
  const INST_COLS = 'g.id,g.meter_id,g.name,g.owner_name,g.capacity_kw,g.latitude,g.longitude,g.status,g.substation_id,g.district_id,g.province_id,g.installed_on,g.created_at,g.updated_at';
  const INST_SORTS = { id: 'g.id', name: 'g.name', capacity_kw: 'g.capacity_kw', installed_on: 'g.installed_on' };

  const getInst = (id) => { const r = q('SELECT * FROM installation_geo WHERE id=?').get(id); if (!r) throw notFound('Installation'); return r; };
  const getInstScoped = (ctx) => { const r = getInst(idParam(ctx.params.id)); assertScope(ctx.user, r); return r; };
  const getProvince = (id) => { const r = q('SELECT * FROM provinces WHERE id=?').get(id); if (!r) throw notFound('Province'); return r; };
  const getDistrict = (id) => { const r = q('SELECT * FROM districts WHERE id=?').get(id); if (!r) throw notFound('District'); return { ...r, district_id: r.id }; };
  const getSub = (id) => { const r = q('SELECT * FROM substation_geo WHERE id=?').get(id); if (!r) throw notFound('Grid substation'); return r; };

  
  function geoFilters(ctx, alias, where, params, noSub = false) {
    const sp = ctx.url.searchParams;
    for (const [k, col] of [['province', 'province_id'], ['district', 'district_id'], ['substation', 'substation_id']].filter((x) => !(noSub && x[0] === 'substation'))) {
      const v = intParam(sp.get(k), k);
      if (v !== null) { where.push(`${alias}.${col} = ?`); params.push(v); }
    }
  }
  function timeFilters(ctx, col, where, params) {
    const from = tsParam(ctx.url.searchParams.get('from'), 'from'), to = tsParam(ctx.url.searchParams.get('to'), 'to');
    if (from && to && from > to) throw invalid([{ field: 'from', issue: 'must not be later than "to"' }]);
    if (from) { where.push(`${col} >= ?`); params.push(from); }
    if (to) { where.push(`${col} <= ?`); params.push(to); }
  }

  
  const str = (min, max) => (v) => typeof v === 'string' && v.trim().length >= min && v.length <= max;
  const rangeNum = (lo, hi) => (v) => num(v) && v >= lo && v <= hi;
  function validate(body, rules, { required = [], partial = false } = {}) {
    if (typeof body !== 'object' || body === null || Array.isArray(body)) throw invalid([{ field: '(body)', issue: 'must be a JSON object' }]);
    const d = [];
    for (const k of Object.keys(body)) if (!rules[k]) d.push({ field: k, issue: 'unknown field' });
    for (const [k, [fn, msg]] of Object.entries(rules)) {
      if (body[k] === undefined) { if (required.includes(k)) d.push({ field: k, issue: 'required' }); }
      else if (!fn(body[k])) d.push({ field: k, issue: msg });
    }
    if (partial && Object.keys(body).length === 0) d.push({ field: '(body)', issue: 'at least one field required' });
    if (d.length) throw invalid(d);
    return body;
  }
  const INST_RULES = {
    meter_id: [(v) => typeof v === 'string' && /^[A-Z0-9-]{6,32}$/.test(v), 'must match ^[A-Z0-9-]{6,32}$'],
    name: [str(1, 120), 'string 1-120 chars'], owner_name: [str(1, 120), 'string 1-120 chars'],
    capacity_kw: [rangeNum(0.1, 1000), 'number 0.1-1000'],
    latitude: [rangeNum(5.8, 9.9), 'number 5.8-9.9 (Sri Lanka)'], longitude: [rangeNum(79.4, 82.0), 'number 79.4-82.0 (Sri Lanka)'],
    status: [(v) => v === 'active' || v === 'inactive', 'active | inactive'],
  };
  const INST_REQ = ['meter_id', 'name', 'owner_name', 'capacity_kw', 'latitude', 'longitude'];
  const SUB_RULE = { substation_id: [(v) => Number.isInteger(v) && v > 0, 'positive integer'] };
  const READ_RULES = {
    timestamp: [(v) => typeof v === 'string' && !Number.isNaN(Date.parse(v)), 'ISO-8601 timestamp'],
    power_kw: [rangeNum(0, 1000), 'number 0-1000'], energy_kwh: [(v) => num(v) && v >= 0, 'number >= 0'],
    voltage_v: [rangeNum(150, 300), 'number 150-300'],
  };

  
  const checkIfMatch = (ctx, currentRep) => {
    const im = ctx.req.headers['if-match'];
    if (im && im !== '*' && !im.split(',').map((s) => s.trim()).includes(etagOf(JSON.stringify(currentRep))))
      throw new ApiError(412, 'precondition_failed', 'Resource was modified since you last fetched it (ETag mismatch)');
  };
  const dupMeter = (e) => (/UNIQUE constraint failed: installations.meter_id/.test(e.message)
    ? new ApiError(409, 'conflict', 'An installation with this meter_id already exists', [{ field: 'meter_id', issue: 'duplicate' }]) : e);

  
  const rateHits = new Map();
  const rateLimit = (ctx) => {
    const key = ctx.req.socket.remoteAddress + ctx.url.pathname, now = Date.now();
    const rec = (rateHits.get(key) || []).filter((t) => now - t < 60000);
    if (rec.length >= 30) throw new ApiError(429, 'rate_limited', 'Too many authentication attempts', [], { 'Retry-After': '60' });
    rec.push(now); rateHits.set(key, rec);
  };
  const authFail = () => new ApiError(401, 'invalid_credentials', 'Invalid credentials', [], { 'WWW-Authenticate': 'Bearer realm="slsea"' });

  route('GET', '/', 'public', () => ({ redirect: '/docs' }));
  route('GET', '/health', 'public', () => ({ status: 200, body: { status: 'ok', time: iso(Date.now()),
    counts: { installations: q('SELECT COUNT(*) c FROM installations').get().c, readings: q('SELECT COUNT(*) c FROM readings').get().c } }, noCache: true }));
  route('GET', '/openapi.json', 'public', (ctx) => ({ status: 200, body: buildSpec(ctx.origin), noEtag: false }), { anyAccept: true });
  route('GET', '/docs', 'public', () => ({ status: 200, html: SWAGGER_HTML }), { anyAccept: true });

  route('POST', `${BASE}/auth/token`, 'public', (ctx) => {
    rateLimit(ctx);
    const b = validate(ctx.body, { email: [str(3, 120), 'string'], password: [str(1, 200), 'string'] }, { required: ['email', 'password'] });
    const u = q('SELECT * FROM users WHERE email=?').get(b.email.toLowerCase());
    if (!u || !verifyPassword(b.password, u.password_hash)) throw authFail();
    const token = signJwt({ sub: `user:${u.id}`, role: u.role, province_id: u.province_id, district_id: u.district_id }, 3600);
    return { status: 200, body: { access_token: token, token_type: 'Bearer', expires_in: 3600, role: u.role }, noCache: true };
  }, { body: true });

  route('POST', `${BASE}/auth/device-token`, 'public', (ctx) => {
    rateLimit(ctx);
    const b = validate(ctx.body, { meter_id: [str(1, 40), 'string'], device_key: [str(1, 100), 'string'] }, { required: ['meter_id', 'device_key'] });
    const inst = q('SELECT id,status FROM installations WHERE meter_id=?').get(b.meter_id);
    const expected = Buffer.from(deviceKey(b.meter_id)), given = Buffer.from(b.device_key);
    if (!inst || given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) throw authFail();
    const token = signJwt({ sub: `installation:${inst.id}`, role: 'device', installation_id: inst.id }, 3600);
    return { status: 200, body: { access_token: token, token_type: 'Bearer', expires_in: 3600, role: 'device', installation_id: inst.id }, noCache: true };
  }, { body: true });

  
  route('GET', `${BASE}/provinces`, 'read', (ctx) => {
    const [w, p] = ctx.user.role === 'national' ? ['1=1', []] : ['p.id = ?', [ctx.user.province_id]];
    return listQuery(ctx, { cols: 'p.id,p.code,p.name', from: 'provinces p', where: [w], params: p, sorts: { id: 'p.id', name: 'p.name' }, defaultSort: 'id', tie: 'p.id' });
  });
  route('GET', `${BASE}/provinces/:id`, 'read', (ctx) => {
    const r = getProvince(idParam(ctx.params.id));
    if (ctx.user.role !== 'national' && r.id !== ctx.user.province_id) throw forbidden('Resource is outside your jurisdiction');
    return { status: 200, body: { ...r, district_count: q('SELECT COUNT(*) c FROM districts WHERE province_id=?').get(r.id).c } };
  });
  route('GET', `${BASE}/provinces/:id/districts`, 'read', (ctx) => {
    const p = getProvince(idParam(ctx.params.id));
    if (ctx.user.role !== 'national' && p.id !== ctx.user.province_id) throw forbidden('Resource is outside your jurisdiction');
    const [w, pr] = scope(ctx.user, 'd.province_id', 'd.id');
    return listQuery(ctx, { cols: 'd.id,d.province_id,d.name', from: 'districts d', where: ['d.province_id = ?', w], params: [p.id, ...pr], sorts: { id: 'd.id', name: 'd.name' }, defaultSort: 'name', tie: 'd.id' });
  });
  route('GET', `${BASE}/districts`, 'read', (ctx) => {
    const where = [], params = [], [w, pr] = scope(ctx.user, 'd.province_id', 'd.id');
    where.push(w); params.push(...pr);
    const pv = intParam(ctx.url.searchParams.get('province'), 'province');
    if (pv !== null) { where.push('d.province_id = ?'); params.push(pv); }
    return listQuery(ctx, { cols: 'd.id,d.province_id,d.name', from: 'districts d', where, params, sorts: { id: 'd.id', name: 'd.name' }, defaultSort: 'name', tie: 'd.id' });
  });
  route('GET', `${BASE}/districts/:id`, 'read', (ctx) => {
    const r = getDistrict(idParam(ctx.params.id)); assertScope(ctx.user, r);
    return { status: 200, body: { id: r.id, province_id: r.province_id, name: r.name,
      substation_count: q('SELECT COUNT(*) c FROM substations WHERE district_id=?').get(r.id).c } };
  });
  route('GET', `${BASE}/districts/:id/substations`, 'read', (ctx) => {
    const d = getDistrict(idParam(ctx.params.id)); assertScope(ctx.user, d);
    return listQuery(ctx, { cols: 's.id,s.district_id,s.name,s.voltage_level_kv,s.capacity_mva', from: 'substations s', where: ['s.district_id = ?'], params: [d.id],
      sorts: { id: 's.id', name: 's.name' }, defaultSort: 'name', tie: 's.id' });
  });
  route('GET', `${BASE}/substations`, 'read', (ctx) => {
    const where = [], params = [], [w, pr] = scope(ctx.user, 'g.province_id', 'g.district_id');
    where.push(w); params.push(...pr); geoFilters(ctx, 'g', where, params, true);
    return listQuery(ctx, { cols: 'g.id,g.district_id,g.name,g.voltage_level_kv,g.capacity_mva', from: 'substation_geo g', where, params,
      sorts: { id: 'g.id', name: 'g.name' }, defaultSort: 'name', tie: 'g.id' });
  });
  route('GET', `${BASE}/substations/:id`, 'read', (ctx) => {
    const r = getSub(idParam(ctx.params.id)); assertScope(ctx.user, r);
    return { status: 200, body: { id: r.id, district_id: r.district_id, name: r.name, voltage_level_kv: r.voltage_level_kv, capacity_mva: r.capacity_mva,
      installation_count: q('SELECT COUNT(*) c FROM installations WHERE substation_id=?').get(r.id).c } };
  });

  
  const instList = (ctx, extraWhere = [], extraParams = []) => {
    const where = [...extraWhere], params = [...extraParams], [w, pr] = scope(ctx.user, 'g.province_id', 'g.district_id');
    where.push(w); params.push(...pr); geoFilters(ctx, 'g', where, params);
    const st = ctx.url.searchParams.get('status');
    if (st) { if (!['active', 'inactive'].includes(st)) throw invalid([{ field: 'status', issue: 'active | inactive' }]); where.push('g.status = ?'); params.push(st); }
    return listQuery(ctx, { cols: INST_COLS, from: 'installation_geo g', where, params, sorts: INST_SORTS, defaultSort: 'id', tie: 'g.id' });
  };
  route('GET', `${BASE}/installations`, 'read', (ctx) => instList(ctx));
  route('GET', `${BASE}/substations/:id/installations`, 'read', (ctx) => {
    const s = getSub(idParam(ctx.params.id)); assertScope(ctx.user, s);
    return instList(ctx, ['g.substation_id = ?'], [s.id]);
  });
  route('GET', `${BASE}/installations/:id`, 'read', (ctx) => {
    const r = getInstScoped(ctx); return { status: 200, body: instRep(r), lastModified: r.updated_at };
  });

  
  route('GET', `${BASE}/installations/:id/overview`, 'read', (ctx) => {
    const r = getInstScoped(ctx);
    const sub = q('SELECT id,name FROM substations WHERE id=?').get(r.substation_id);
    const dist = q('SELECT id,name FROM districts WHERE id=?').get(r.district_id);
    const prov = q('SELECT id,name FROM provinces WHERE id=?').get(r.province_id);
    const last = q('SELECT * FROM readings WHERE installation_id=? ORDER BY ts DESC LIMIT 1').get(r.id);
    const since = iso(Date.now() - 86400000);
    const st = q('SELECT COUNT(*) n, MAX(power_kw) peak, MAX(energy_kwh)-MIN(energy_kwh) kwh, AVG(voltage_v) v FROM readings WHERE installation_id=? AND ts>=?').get(r.id, since);
    return { status: 200, lastModified: last && last.ts > r.updated_at ? last.ts : r.updated_at, body: {
      installation: instRep(r), substation: sub, district: dist, province: prov, last_reading: last ? readRep(last) : null,
      last_24h: { reading_count: st.n, peak_power_kw: st.peak, energy_kwh: st.kwh === null ? null : Math.round(st.kwh * 1000) / 1000, avg_voltage_v: st.v === null ? null : Math.round(st.v * 10) / 10 } } };
  });

  
  route('GET', `${BASE}/installations/:id/last-reading`, 'read', (ctx) => {
    const r = getInstScoped(ctx);
    const l = q('SELECT * FROM readings WHERE installation_id=? ORDER BY ts DESC LIMIT 1').get(r.id);
    if (!l) throw new ApiError(404, 'no_readings', 'This installation has not reported any readings yet');
    return { status: 200, body: readRep(l), lastModified: l.ts };
  });

  
  route('GET', `${BASE}/installations/:id/readings`, 'read', (ctx) => {
    const r = getInstScoped(ctx), where = ['r.installation_id = ?'], params = [r.id];
    timeFilters(ctx, 'r.ts', where, params);
    return readList(ctx, where, params);
  });
  route('GET', `${BASE}/installations/:id/readings/:rid`, 'read', (ctx) => {
    const r = getInstScoped(ctx);
    const row = q('SELECT * FROM readings WHERE id=? AND installation_id=?').get(idParam(ctx.params.rid, 'rid'), r.id);
    if (!row) throw notFound('Reading');
    return { status: 200, body: readRep(row), lastModified: row.ts };
  });
  const RSORT = { timestamp: 'r.ts', power_kw: 'r.power_kw', energy_kwh: 'r.energy_kwh' };
  const readList = (ctx, where, params) => {
    const out = listQuery(ctx, { cols: 'r.id,r.installation_id,r.ts,r.power_kw,r.energy_kwh,r.voltage_v', from: 'readings r', where, params,
      sorts: RSORT, defaultSort: '-timestamp', tie: 'r.id' });
    out.body.data = out.body.data.map(readRep); return out;
  };
  
  route('GET', `${BASE}/readings`, 'read', (ctx) => {
    const where = [], params = [], [w, pr] = scope(ctx.user, 'g.province_id', 'g.district_id');
    where.push(w); params.push(...pr); geoFilters(ctx, 'g', where, params);
    const inst = intParam(ctx.url.searchParams.get('installation'), 'installation');
    if (inst !== null) { where.push('r.installation_id = ?'); params.push(inst); }
    timeFilters(ctx, 'r.ts', where, params);
    const sp = ctx.url.searchParams, page = intParam(sp.get('page'), 'page') ?? 1, size = intParam(sp.get('page_size'), 'page_size', { max: 500 }) ?? 100;
    let sort = sp.get('sort') || '-timestamp', dir = 'ASC'; if (sort.startsWith('-')) { dir = 'DESC'; sort = sort.slice(1); }
    if (!RSORT[sort]) throw invalid([{ field: 'sort', issue: `must be one of: ${Object.keys(RSORT).join(', ')} (prefix with - for descending)` }]);
    const from = 'readings r JOIN installation_geo g ON g.id = r.installation_id', W = 'WHERE ' + where.join(' AND ');
    const total = q(`SELECT COUNT(*) c FROM ${from} ${W}`).get(...params).c;
    const rows = q(`SELECT r.id,r.installation_id,r.ts,r.power_kw,r.energy_kwh,r.voltage_v FROM ${from} ${W} ORDER BY ${RSORT[sort]} ${dir}, r.id ${dir} LIMIT ? OFFSET ?`).all(...params, size, (page - 1) * size);
    const pages = Math.max(1, Math.ceil(total / size));
    const link = (p) => { const u = new URL(ctx.url); u.searchParams.set('page', p); u.searchParams.set('page_size', size); return ctx.origin + u.pathname + u.search; };
    const links = { self: link(page), first: link(1), last: link(pages), prev: page > 1 ? link(Math.min(page - 1, pages)) : null, next: page < pages ? link(page + 1) : null };
    return { status: 200, body: { data: rows.map(readRep), pagination: { page, page_size: size, total_count: total, total_pages: pages }, links },
      headers: { Link: Object.entries(links).filter(([, v]) => v).map(([k, v]) => `<${v}>; rel="${k}"`).join(', '), 'X-Total-Count': String(total) } };
  });

  
  route('GET', `${BASE}/districts/:id/generation-summary`, 'read', (ctx) => {
    const d = getDistrict(idParam(ctx.params.id)); assertScope(ctx.user, d);
    const now = Date.now(), recent = iso(now - 30 * 60000);
    const dayStart = iso(Math.floor((now + 19800000) / 86400000) * 86400000 - 19800000);   // local midnight (UTC+5:30)
    const cap = q('SELECT COUNT(*) n, COALESCE(SUM(capacity_kw),0) cap FROM installation_geo WHERE district_id=? AND status=\'active\'').get(d.id);
    const cur = q(`SELECT COUNT(x.p) reporting, COALESCE(SUM(x.p),0) kw FROM (SELECT (SELECT power_kw FROM readings r WHERE r.installation_id=g.id AND r.ts>=? ORDER BY r.ts DESC LIMIT 1) p
                   FROM installation_geo g WHERE g.district_id=? AND g.status='active') x`).get(recent, d.id);
    const en = q(`SELECT COALESCE(SUM(e.maxe - COALESCE(e.base, e.mine)),0) kwh FROM (SELECT
      (SELECT MAX(energy_kwh) FROM readings r WHERE r.installation_id=g.id AND r.ts>=?) maxe,
      (SELECT MIN(energy_kwh) FROM readings r WHERE r.installation_id=g.id AND r.ts>=?) mine,
      (SELECT energy_kwh FROM readings r WHERE r.installation_id=g.id AND r.ts<? ORDER BY r.ts DESC LIMIT 1) base
      FROM installation_geo g WHERE g.district_id=?) e WHERE e.maxe IS NOT NULL`).get(dayStart, dayStart, dayStart, d.id);
    const kw = Math.round(cur.kw * 1000) / 1000;
    return { status: 200, noCache: true, body: { district: { id: d.id, name: d.name }, as_of: iso(now), local_day_start_utc: dayStart,
      active_installations: cap.n, reporting_installations: cur.reporting, installed_capacity_kw: Math.round(cap.cap * 10) / 10,
      current_power_kw: kw, utilisation_pct: cap.cap ? Math.round((kw / cap.cap) * 1000) / 10 : 0, today_energy_kwh: Math.round(en.kwh * 100) / 100 } };
  });

  
  route('POST', `${BASE}/substations/:id/installations`, 'national', (ctx) => {
    const s = getSub(idParam(ctx.params.id));
    const b = validate(ctx.body, INST_RULES, { required: INST_REQ }), now = iso(Date.now());
    let id;
    try {
      id = Number(q(`INSERT INTO installations(substation_id,meter_id,name,owner_name,capacity_kw,latitude,longitude,status,installed_on,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(s.id, b.meter_id, b.name, b.owner_name, b.capacity_kw, b.latitude, b.longitude, b.status || 'active', now.slice(0, 10), now, now).lastInsertRowid);
    } catch (e) { throw dupMeter(e); }
    const rep = instRep(getInst(id));
    return { status: 201, body: { ...rep, device_key: deviceKey(rep.meter_id) }, headers: { Location: `${ctx.origin}${BASE}/installations/${id}`, ETag: etagOf(JSON.stringify(rep)) }, noCache: true };
  }, { body: true });

  route('PUT', `${BASE}/installations/:id`, 'national', (ctx) => {
    const cur = getInst(idParam(ctx.params.id)); checkIfMatch(ctx, instRep(cur));
    const b = validate(ctx.body, { ...INST_RULES, ...SUB_RULE }, { required: [...INST_REQ, 'substation_id', 'status'] });
    if (!q('SELECT 1 FROM substations WHERE id=?').get(b.substation_id)) throw invalid([{ field: 'substation_id', issue: 'does not exist' }]);
    try {
      q('UPDATE installations SET substation_id=?,meter_id=?,name=?,owner_name=?,capacity_kw=?,latitude=?,longitude=?,status=?,updated_at=? WHERE id=?')
        .run(b.substation_id, b.meter_id, b.name, b.owner_name, b.capacity_kw, b.latitude, b.longitude, b.status, iso(Date.now()), cur.id);
    } catch (e) { throw dupMeter(e); }
    const r = getInst(cur.id); return { status: 200, body: instRep(r), lastModified: r.updated_at, noCache: true };
  }, { body: true });

  route('PATCH', `${BASE}/installations/:id`, 'national', (ctx) => {
    const cur = getInst(idParam(ctx.params.id)); checkIfMatch(ctx, instRep(cur));
    const b = validate(ctx.body, { ...INST_RULES, ...SUB_RULE }, { partial: true });
    if (b.substation_id && !q('SELECT 1 FROM substations WHERE id=?').get(b.substation_id)) throw invalid([{ field: 'substation_id', issue: 'does not exist' }]);
    const m = { ...cur, ...b };
    try {
      q('UPDATE installations SET substation_id=?,meter_id=?,name=?,owner_name=?,capacity_kw=?,latitude=?,longitude=?,status=?,updated_at=? WHERE id=?')
        .run(m.substation_id, m.meter_id, m.name, m.owner_name, m.capacity_kw, m.latitude, m.longitude, m.status, iso(Date.now()), cur.id);
    } catch (e) { throw dupMeter(e); }
    const r = getInst(cur.id); return { status: 200, body: instRep(r), lastModified: r.updated_at, noCache: true };
  }, { body: true });

  route('DELETE', `${BASE}/installations/:id`, 'national', (ctx) => {
    const cur = getInst(idParam(ctx.params.id)); checkIfMatch(ctx, instRep(cur));
    q('DELETE FROM installations WHERE id=?').run(cur.id);
    return { status: 204 };
  });

  
  route('POST', `${BASE}/installations/:id/readings`, 'device', (ctx) => {
    const id = idParam(ctx.params.id);
    if (ctx.user.installation_id !== id) throw forbidden('A device may only write readings for its own installation');
    const inst = getInst(id);
    if (inst.status !== 'active') throw new ApiError(409, 'installation_inactive', 'Inactive installations cannot report readings');
    const b = validate(ctx.body, READ_RULES, { required: ['power_kw', 'energy_kwh', 'voltage_v'] });
    const ts = iso(b.timestamp ? new Date(b.timestamp) : new Date());
    const details = [];
    if (Date.parse(ts) > Date.now() + 5 * 60000) details.push({ field: 'timestamp', issue: 'must not be more than 5 minutes in the future' });
    if (b.power_kw > inst.capacity_kw * 1.25) details.push({ field: 'power_kw', issue: `exceeds installed capacity (${inst.capacity_kw} kW)` });
    if (details.length) throw invalid(details);
    const loc = (rid) => `${ctx.origin}${BASE}/installations/${id}/readings/${rid}`;
    const existing = q('SELECT * FROM readings WHERE installation_id=? AND ts=?').get(id, ts);
    if (existing) {   // idempotent replay of an identical reading -> 200; conflicting data -> 409
      if (existing.power_kw === b.power_kw && existing.energy_kwh === b.energy_kwh && existing.voltage_v === b.voltage_v)
        return { status: 200, body: readRep(existing), headers: { Location: loc(existing.id) }, noCache: true };
      throw new ApiError(409, 'duplicate_reading', 'A different reading already exists for this timestamp (readings are append-only)', [{ field: 'timestamp', issue: 'already recorded' }], { Location: loc(existing.id) });
    }
    const rid = Number(q('INSERT INTO readings(installation_id,ts,power_kw,energy_kwh,voltage_v) VALUES (?,?,?,?,?)').run(id, ts, b.power_kw, b.energy_kwh, b.voltage_v).lastInsertRowid);
    const rep = readRep(q('SELECT * FROM readings WHERE id=?').get(rid));
    return { status: 201, body: rep, headers: { Location: loc(rid), ETag: etagOf(JSON.stringify(rep)) }, noCache: true };
  }, { body: true });

  
  function authenticate(req) {
    const h = req.headers.authorization || '';
    const m = /^Bearer (.+)$/i.exec(h);
    const p = m && verifyJwt(m[1]);
    if (!p) throw new ApiError(401, 'unauthenticated', 'A valid bearer token is required', [], { 'WWW-Authenticate': 'Bearer realm="slsea"' });
    return p;
  }
  const acceptsJson = (a) => !a || a.split(',').some((s) => { const t = s.split(';')[0].trim().toLowerCase(); return t === '*/*' || t === 'application/*' || t === 'application/json' || t.endsWith('+json'); });
  async function readBody(req) {
    const ct = (req.headers['content-type'] || '').toLowerCase();
    if (!/application\/(json|[\w.+-]+\+json)/.test(ct)) throw new ApiError(415, 'unsupported_media_type', 'Content-Type must be application/json');
    let size = 0; const chunks = [];
    for await (const c of req) { size += c.length; if (size > 1e6) throw new ApiError(413, 'payload_too_large', 'Body exceeds 1 MB'); chunks.push(c); }
    try { return JSON.parse(Buffer.concat(chunks).toString() || 'null'); }
    catch { throw new ApiError(400, 'invalid_json', 'Request body is not valid JSON'); }
  }
  const stripCtl = (s) => s.replace(/[\r\n]/g, ' ');

  async function handle(req, res) {
    const rid = crypto.randomUUID();
    const h = { 'X-Request-Id': rid, 'X-Content-Type-Options': 'nosniff', 'Access-Control-Allow-Origin': '*',
      'Access-Control-Expose-Headers': 'ETag, Location, Link, X-Total-Count, Last-Modified', Vary: 'Authorization, Accept' };
    const out = (status, headers, body, ctype = 'application/json; charset=utf-8') => {
      const hh = { ...h, ...headers }; if (body !== undefined) { hh['Content-Type'] = ctype; hh['Content-Length'] = Buffer.byteLength(body); }
      res.writeHead(status, hh); res.end(req.method === 'HEAD' ? undefined : body);
    };
    try {
      const url = new URL(req.url, 'http://localhost');
      const origin = `${req.headers['x-forwarded-proto'] || 'http'}://${req.headers.host}`;
      const path = url.pathname.length > 1 ? url.pathname.replace(/\/+$/, '') : url.pathname;
      if (req.method === 'OPTIONS') return out(204, { 'Access-Control-Allow-Methods': 'GET, HEAD, POST, PUT, PATCH, DELETE', 'Access-Control-Allow-Headers': 'Authorization, Content-Type, If-Match, If-None-Match, If-Modified-Since' });
      const method = req.method === 'HEAD' ? 'GET' : req.method;
      let hit = null;
      for (const r of routes) { const m = r.re.exec(path); if (m && r.method === method) { hit = { r, params: Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])])) }; break; } }
      if (!hit) {
        const allow = [...new Set(routes.filter((r) => r.re.test(path)).map((r) => r.method))];
        if (allow.length) throw new ApiError(405, 'method_not_allowed', `${req.method} is not supported on this resource`, [], { Allow: [...new Set([...allow, ...(allow.includes('GET') ? ['HEAD'] : [])])].join(', ') });
        throw notFound('Route');
      }
      const { r, params } = hit;
      if (!r.anyAccept && !acceptsJson(req.headers.accept)) throw new ApiError(406, 'not_acceptable', 'This API only produces application/json');
      let user = null;
      if (r.auth !== 'public') {
        user = authenticate(req);
        if (r.auth === 'device' && user.role !== 'device') throw forbidden('Only metering devices may write readings');
        if (r.auth === 'read' && user.role === 'device') throw forbidden('Devices are write-only and cannot read data');
        if (r.auth === 'national' && user.role !== 'national') throw forbidden('National administrator role required');
      }
      const body = r.body ? await readBody(req) : undefined;
      const result = await r.handler({ req, url, origin, params, user, body });
      if (result.redirect) return out(302, { Location: result.redirect });
      if (result.html) return out(200, { 'Cache-Control': 'no-cache' }, result.html, 'text/html; charset=utf-8');
      const hdr = { ...(result.headers || {}) };
      if (result.status === 204) return out(204, hdr);
      const payload = JSON.stringify(result.body);
      if (req.method === 'GET' || req.method === 'HEAD') {
        const et = etagOf(payload); hdr.ETag = et; hdr['Cache-Control'] = result.noCache ? 'no-store' : 'private, no-cache';
        if (result.lastModified) hdr['Last-Modified'] = new Date(result.lastModified).toUTCString();
        const inm = req.headers['if-none-match'], ims = req.headers['if-modified-since'];
        const fresh = inm ? inm.split(',').some((t) => t.trim().replace(/^W\//, '') === et || t.trim() === '*')
          : ims && result.lastModified && Math.floor(Date.parse(result.lastModified) / 1000) <= Math.floor(Date.parse(ims) / 1000);
        if (result.status === 200 && fresh) return out(304, hdr);
      }
      return out(result.status, hdr, payload);
    } catch (e) {
      if (!(e instanceof ApiError)) { console.error(`[${rid}]`, e); e = new ApiError(500, 'internal_error', 'Unexpected server error'); }
      const hh = {}; for (const [k, v] of Object.entries(e.headers)) hh[k] = stripCtl(String(v));
      return out(e.status, hh, JSON.stringify({ error: { code: e.code, message: e.message, details: e.details, status: e.status, request_id: rid } }));
    }
  }
  return http.createServer(handle);
}

const SWAGGER_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>SLSEA Solar API - Swagger UI</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/swagger-ui-dist@5/swagger-ui.css"></head>
<body><div id="ui"></div>
<script src="https://cdn.jsdelivr.net/npm/swagger-ui-dist@5/swagger-ui-bundle.js"></script>
<script>SwaggerUIBundle({url:'/openapi.json',dom_id:'#ui',deepLinking:true,persistAuthorization:true,tryItOutEnabled:true,displayRequestDuration:true});</script>
</body></html>`;
