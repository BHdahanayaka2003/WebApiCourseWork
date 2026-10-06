const ref = (n) => ({ $ref: `#/components/schemas/${n}` });
const json = (schema) => ({ 'application/json': { schema } });
const ERR = { 400: 'Validation failed / malformed request', 401: 'Missing or invalid bearer token', 403: 'Authenticated but not permitted (role or jurisdiction)',
  404: 'Resource not found', 405: 'Method not allowed', 406: 'Not acceptable (only application/json)', 409: 'Conflict', 412: 'Precondition failed (stale ETag)', 415: 'Unsupported media type', 429: 'Rate limited' };
const errs = (...c) => Object.fromEntries(c.map((k) => [k, { description: ERR[k], content: json(ref('Error')) }]));
const pid = (name, d = 'Resource id') => ({ name, in: 'path', required: true, description: d, schema: { type: 'integer', minimum: 1 } });
const qp = (name, schema, description) => ({ name, in: 'query', description, schema });
const PAGING = [qp('page', { type: 'integer', minimum: 1, default: 1 }, 'Page number'), qp('page_size', { type: 'integer', minimum: 1, maximum: 500, default: 100 }, 'Items per page')];
const sortP = (vals, def) => qp('sort', { type: 'string', enum: vals.flatMap((v) => [v, '-' + v]), default: def }, 'Sort field; prefix - for descending');
const GEO = [qp('province', { type: 'integer' }, 'Filter by province id'), qp('district', { type: 'integer' }, 'Filter by district id'), qp('substation', { type: 'integer' }, 'Filter by grid substation id')];
const TIME = [qp('from', { type: 'string', format: 'date-time' }, 'Window start (inclusive)'), qp('to', { type: 'string', format: 'date-time' }, 'Window end (inclusive)')];
const CACHE = { 304: { description: 'Not modified - empty body; client copy is current (If-None-Match / If-Modified-Since)' } };
const HDR = { ETag: { schema: { type: 'string' } }, 'Last-Modified': { schema: { type: 'string' } } };
const page = (item) => ({ type: 'object', properties: { data: { type: 'array', items: ref(item) }, pagination: ref('Pagination'), links: ref('PageLinks') } });
const ok = (schema, d = 'OK') => ({ description: d, headers: HDR, content: json(schema) });
const get = (tag, summary, parameters, schema, extra = {}) => ({ get: { tags: [tag], summary, security: [{ bearer: [] }], parameters,
  responses: { 200: ok(schema), ...CACHE, ...errs(400, 401, 403, 404, 406), ...extra } } });
const list = (tag, summary, item, params) => get(tag, summary, [...PAGING, ...params], page(item));

export function buildSpec(origin) {
  const I = pid('id');
  return {
    openapi: '3.0.3',
    info: { title: 'SLSEA Real-Time Solar Generation Data API', version: '1.0.0',
      description: 'REST API (Richardson Level 2) serving real-time and historical rooftop-solar generation. **Write-read split:** metering devices authenticate as one installation and may only POST readings; SLSEA users are read-only and scoped to their jurisdiction.\n\nGet a token via `POST /api/v1/auth/token` (users) or `POST /api/v1/auth/device-token` (devices), then click **Authorize**.' },
    servers: [{ url: origin }],
    tags: ['Auth', 'Provinces', 'Districts', 'Substations', 'Installations', 'Readings', 'Summary'].map((name) => ({ name })),
    components: {
      securitySchemes: { bearer: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' } },
      schemas: {
        Error: { type: 'object', required: ['error'], properties: { error: { type: 'object', required: ['code', 'message', 'details', 'status', 'request_id'],
          properties: { code: { type: 'string', example: 'validation_failed' }, message: { type: 'string' }, status: { type: 'integer' }, request_id: { type: 'string', format: 'uuid' },
            details: { type: 'array', items: { type: 'object', properties: { field: { type: 'string' }, issue: { type: 'string' } } } } } } } },
        Pagination: { type: 'object', properties: { page: { type: 'integer' }, page_size: { type: 'integer' }, total_count: { type: 'integer' }, total_pages: { type: 'integer' } } },
        PageLinks: { type: 'object', properties: { self: { type: 'string' }, first: { type: 'string' }, last: { type: 'string' }, prev: { type: 'string', nullable: true }, next: { type: 'string', nullable: true } } },
        Province: { type: 'object', properties: { id: { type: 'integer' }, code: { type: 'string' }, name: { type: 'string' } } },
        District: { type: 'object', properties: { id: { type: 'integer' }, province_id: { type: 'integer' }, name: { type: 'string' } } },
        Substation: { type: 'object', properties: { id: { type: 'integer' }, district_id: { type: 'integer' }, name: { type: 'string' }, voltage_level_kv: { type: 'integer' }, capacity_mva: { type: 'number' } } },
        Installation: { type: 'object', properties: { id: { type: 'integer' }, meter_id: { type: 'string', example: 'SLM-000001' }, name: { type: 'string' }, owner_name: { type: 'string' },
          capacity_kw: { type: 'number' }, latitude: { type: 'number' }, longitude: { type: 'number' }, status: { type: 'string', enum: ['active', 'inactive'] },
          substation_id: { type: 'integer' }, district_id: { type: 'integer' }, province_id: { type: 'integer' }, installed_on: { type: 'string' }, created_at: { type: 'string' }, updated_at: { type: 'string' } } },
        InstallationInput: { type: 'object', required: ['meter_id', 'name', 'owner_name', 'capacity_kw', 'latitude', 'longitude'], properties: {
          meter_id: { type: 'string', example: 'SLM-900001' }, name: { type: 'string', example: 'Lakmal Rooftop' }, owner_name: { type: 'string', example: 'Lakmal Perera' },
          capacity_kw: { type: 'number', example: 5.5 }, latitude: { type: 'number', example: 6.9271 }, longitude: { type: 'number', example: 79.8612 }, status: { type: 'string', enum: ['active', 'inactive'] } } },
        InstallationReplace: { allOf: [ref('InstallationInput'), { type: 'object', required: ['substation_id', 'status'], properties: { substation_id: { type: 'integer' } } }] },
        InstallationPatch: { type: 'object', minProperties: 1, properties: { meter_id: { type: 'string' }, name: { type: 'string' }, owner_name: { type: 'string' }, capacity_kw: { type: 'number' },
          latitude: { type: 'number' }, longitude: { type: 'number' }, status: { type: 'string' }, substation_id: { type: 'integer' } } },
        InstallationCreated: { allOf: [ref('Installation'), { type: 'object', properties: { device_key: { type: 'string', description: 'Shown once at provisioning' } } }] },
        Reading: { type: 'object', properties: { id: { type: 'integer' }, installation_id: { type: 'integer' }, timestamp: { type: 'string', format: 'date-time' }, power_kw: { type: 'number' }, energy_kwh: { type: 'number', description: 'Cumulative' }, voltage_v: { type: 'number' } } },
        ReadingInput: { type: 'object', required: ['power_kw', 'energy_kwh', 'voltage_v'], properties: { timestamp: { type: 'string', format: 'date-time', description: 'Defaults to server time' },
          power_kw: { type: 'number', example: 3.2 }, energy_kwh: { type: 'number', example: 4210.5 }, voltage_v: { type: 'number', example: 231.4 } } },
        Overview: { type: 'object', properties: { installation: ref('Installation'), substation: { type: 'object' }, district: { type: 'object' }, province: { type: 'object' }, last_reading: { ...ref('Reading'), nullable: true },
          last_24h: { type: 'object', properties: { reading_count: { type: 'integer' }, peak_power_kw: { type: 'number' }, energy_kwh: { type: 'number' }, avg_voltage_v: { type: 'number' } } } } },
        GenerationSummary: { type: 'object', properties: { district: { type: 'object' }, as_of: { type: 'string' }, active_installations: { type: 'integer' }, reporting_installations: { type: 'integer' },
          installed_capacity_kw: { type: 'number' }, current_power_kw: { type: 'number' }, utilisation_pct: { type: 'number' }, today_energy_kwh: { type: 'number' } } },
        Token: { type: 'object', properties: { access_token: { type: 'string' }, token_type: { type: 'string' }, expires_in: { type: 'integer' }, role: { type: 'string' } } },
      },
    },
    paths: {
      '/api/v1/auth/token': { post: { tags: ['Auth'], summary: 'SLSEA user login (read client)', requestBody: { required: true, content: json({ type: 'object', required: ['email', 'password'], properties: { email: { type: 'string', example: 'national@slsea.lk' }, password: { type: 'string' } } }) },
        responses: { 200: ok(ref('Token')), ...errs(400, 401, 415, 429) } } },
      '/api/v1/auth/device-token': { post: { tags: ['Auth'], summary: 'Device login - authenticates AS its installation (write client)', requestBody: { required: true, content: json({ type: 'object', required: ['meter_id', 'device_key'], properties: { meter_id: { type: 'string', example: 'SLM-000001' }, device_key: { type: 'string' } } }) },
        responses: { 200: ok(ref('Token')), ...errs(400, 401, 415, 429) } } },
      '/api/v1/provinces': list('Provinces', 'List provinces (scoped to caller)', 'Province', [sortP(['id', 'name'], 'id')]),
      '/api/v1/provinces/{id}': get('Provinces', 'Get a province', [I], ref('Province')),
      '/api/v1/provinces/{id}/districts': list('Provinces', 'Districts of a province (scoped collection)', 'District', [I, sortP(['id', 'name'], 'name')]),
      '/api/v1/districts': list('Districts', 'List districts (scoped to caller)', 'District', [qp('province', { type: 'integer' }, 'Filter by province'), sortP(['id', 'name'], 'name')]),
      '/api/v1/districts/{id}': get('Districts', 'Get a district', [I], ref('District')),
      '/api/v1/districts/{id}/substations': list('Districts', 'Grid substations of a district', 'Substation', [I, sortP(['id', 'name'], 'name')]),
      '/api/v1/districts/{id}/generation-summary': get('Summary', 'District generation summary (processing resource)', [I], ref('GenerationSummary')),
      '/api/v1/substations': list('Substations', 'List grid substations', 'Substation', [GEO[0], GEO[1], sortP(['id', 'name'], 'name')]),
      '/api/v1/substations/{id}': get('Substations', 'Get a grid substation', [I], ref('Substation')),
      '/api/v1/substations/{id}/installations': {
        ...list('Substations', 'Installations connected to a substation', 'Installation', [I, qp('status', { type: 'string', enum: ['active', 'inactive'] }, 'Filter by status'), sortP(['id', 'name', 'capacity_kw', 'installed_on'], 'id')]),
        post: { tags: ['Installations'], summary: 'Provision an installation under a substation (national admin)', security: [{ bearer: [] }], parameters: [I],
          requestBody: { required: true, content: json(ref('InstallationInput')) },
          responses: { 201: { description: 'Created', headers: { Location: { schema: { type: 'string' } }, ETag: { schema: { type: 'string' } } }, content: json(ref('InstallationCreated')) }, ...errs(400, 401, 403, 404, 409, 415) } } },
      '/api/v1/installations': list('Installations', 'List installations (filter by jurisdiction)', 'Installation', [...GEO, qp('status', { type: 'string', enum: ['active', 'inactive'] }, 'Filter by status'), sortP(['id', 'name', 'capacity_kw', 'installed_on'], 'id')]),
      '/api/v1/installations/{id}': {
        ...get('Installations', 'Get an installation', [I], ref('Installation')),
        put: { tags: ['Installations'], summary: 'Replace an installation (idempotent; honours If-Match)', security: [{ bearer: [] }], parameters: [I, { name: 'If-Match', in: 'header', schema: { type: 'string' } }],
          requestBody: { required: true, content: json(ref('InstallationReplace')) }, responses: { 200: ok(ref('Installation')), ...errs(400, 401, 403, 404, 409, 412, 415) } },
        patch: { tags: ['Installations'], summary: 'Partially update an installation', security: [{ bearer: [] }], parameters: [I, { name: 'If-Match', in: 'header', schema: { type: 'string' } }],
          requestBody: { required: true, content: json(ref('InstallationPatch')) }, responses: { 200: ok(ref('Installation')), ...errs(400, 401, 403, 404, 409, 412, 415) } },
        delete: { tags: ['Installations'], summary: 'Delete an installation and its history', security: [{ bearer: [] }], parameters: [I, { name: 'If-Match', in: 'header', schema: { type: 'string' } }],
          responses: { 204: { description: 'Deleted, no body' }, ...errs(401, 403, 404, 412) } } },
      '/api/v1/installations/{id}/overview': get('Installations', 'Composite: installation + hierarchy + last reading + 24h stats', [I], ref('Overview')),
      '/api/v1/installations/{id}/last-reading': get('Readings', 'Last-known reading (derived resource, operational view)', [I], ref('Reading')),
      '/api/v1/installations/{id}/readings': {
        ...list('Readings', 'Generation history of one installation (analytical view)', 'Reading', [I, ...TIME, sortP(['timestamp', 'power_kw', 'energy_kwh'], '-timestamp')]),
        post: { tags: ['Readings'], summary: 'Ingest a reading (device token for THIS installation only)', security: [{ bearer: [] }], parameters: [I],
          requestBody: { required: true, content: json(ref('ReadingInput')) },
          responses: { 201: { description: 'Created', headers: { Location: { schema: { type: 'string' } }, ETag: { schema: { type: 'string' } } }, content: json(ref('Reading')) },
            200: { description: 'Identical reading already stored (idempotent replay)', content: json(ref('Reading')) }, ...errs(400, 401, 403, 404, 409, 415) } } },
      '/api/v1/installations/{id}/readings/{rid}': get('Readings', 'Get one reading (target of the Location header)', [I, pid('rid', 'Reading id')], ref('Reading')),
      '/api/v1/readings': list('Readings', 'History across installations, filtered by jurisdiction and time window', 'Reading', [...GEO, qp('installation', { type: 'integer' }, 'Filter by installation id'), ...TIME, sortP(['timestamp', 'power_kw', 'energy_kwh'], '-timestamp')]),
    },
  };
}
