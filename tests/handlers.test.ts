// Prueba las funciones del servidor contra un PostgreSQL local con la migración aplicada.
// Base de datos: DATABASE_URL (por defecto postgres://postgres:postgres@localhost:5432/pruebas).
// ¡Borra y recrea los esquemas public y auth de esa base de datos!
import assert from 'node:assert/strict'
import { createHmac, createPublicKey, verify, webcrypto } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { after, before, test } from 'node:test'
import postgres from 'postgres'
import { deviceDeactivate, licenseCheck, paddleWebhook, portalSession, type Deps } from '../supabase/functions/_shared/handlers.ts'

const URL_DB = process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/pruebas'
const sql = postgres(URL_DB, { onnotice: () => {} })
const SECRET = 'whsec_pruebas'
let now = new Date('2026-11-26T12:00:00Z')
const users = new Map<string, { id: string; email: string }>()
const paddleCalls: { method: string; path: string; body: unknown }[] = []
let publicKey: ReturnType<typeof createPublicKey>
let deps: Deps

async function newUser(email: string): Promise<string> {
  const [u] = await sql`insert into auth.users (email) values (${email}) returning id`
  users.set(`token-${email}`, { id: u.id, email })
  return u.id
}

function post(body: unknown, token?: string, headers: Record<string, string> = {}): Request {
  return new Request('http://localhost/', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body)
  })
}

async function check(email: string, device: string, app = 'fotogestor') {
  const res = await licenseCheck(post({ app, version: '0.17.0', device_id: device, device_name: `PC ${device}`, os: 'win32' }, `token-${email}`), deps)
  const body = await res.json()
  let claims: any = null
  if (body.token) {
    const [b, s] = body.token.split('.')
    assert.ok(verify(null, Buffer.from(b, 'ascii'), publicKey, Buffer.from(s, 'base64url')), 'firma de la licencia')
    claims = JSON.parse(Buffer.from(b, 'base64url').toString())
  }
  return { status: res.status, body, claims }
}

function webhook(evt: Record<string, unknown>, secret = SECRET) {
  const raw = JSON.stringify(evt)
  const ts = Math.floor(Date.now() / 1000)
  const h1 = createHmac('sha256', secret).update(`${ts}:${raw}`).digest('hex')
  return paddleWebhook(post(raw, undefined, { 'paddle-signature': `ts=${ts};h1=${h1}` }), deps)
}

const subEvent = (id: string, type: string, occurred: string, data: Record<string, unknown>) =>
  ({ event_id: id, event_type: type, occurred_at: occurred, notification_id: 'ntf', data })

before(async () => {
  await sql.unsafe('drop schema if exists public cascade; drop schema if exists auth cascade; create schema public;')
  await sql.file('tests/auth-stub.sql')
  await sql.file('supabase/migrations/20261126000000_licencias.sql')
  await sql`update public.plans set paddle_price_id = 'pri_mensual' where id = 'fotogestor-mensual'`
  const pair = await webcrypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']) as CryptoKeyPair
  publicKey = createPublicKey({ key: Buffer.from(await webcrypto.subtle.exportKey('spki', pair.publicKey)), format: 'der', type: 'spki' })
  deps = {
    sql,
    getUser: async (jwt) => users.get(jwt) ?? null,
    privateKey: async () => pair.privateKey,
    paddle: async (method, path, body) => {
      paddleCalls.push({ method, path, body })
      return { data: { urls: { general: { overview: 'https://customer-portal.paddle.com/sesion' } } } }
    },
    paddleWebhookSecret: SECRET,
    checkoutUrl: 'https://ejemplo.github.io/adminapps/pagar.html',
    now: () => now
  }
})

after(() => sql.end())

test('rechaza peticiones sin sesión o con otro método', async () => {
  assert.equal((await licenseCheck(post({ app: 'fotogestor', device_id: 'x' }), deps)).status, 401)
  assert.equal((await licenseCheck(new Request('http://localhost/'), deps)).status, 405)
})

test('la primera comprobación crea la prueba de 7 días, el ordenador y la cuenta', async () => {
  const uid = await newUser('ana@example.com')
  const r = await check('ana@example.com', 'pc-1')
  assert.equal(r.status, 200)
  assert.equal(r.claims.status, 'trial')
  assert.equal(r.claims.sub, uid)
  assert.equal(r.claims.device, 'pc-1')
  assert.equal(r.claims.trial_end, new Date(now.getTime() + 7 * 86_400_000).toISOString())
  assert.equal(r.claims.exp - r.claims.iat, 6 * 3600)
  assert.equal(r.body.can_manage, false)
  assert.match(r.body.checkout_url, /pagar\.html\?app=fotogestor&uid=.+&email=ana%40example\.com/)
  const [dev] = await sql`select * from public.devices where user_id = ${uid}`
  assert.equal(dev.name, 'PC pc-1')
  assert.equal((await sql`select count(*)::int as n from public.license_checks where user_id = ${uid}`)[0].n, 1)
  // La segunda comprobación no alarga la prueba.
  now = new Date(now.getTime() + 86_400_000)
  assert.equal((await check('ana@example.com', 'pc-1')).claims.trial_end, r.claims.trial_end)
})

test('otra cuenta en un ordenador que ya tuvo prueba no tiene prueba nueva', async () => {
  await newUser('ana2@example.com')
  const r = await check('ana2@example.com', 'pc-1')
  assert.equal(r.claims.status, 'trial')
  assert.equal(r.claims.trial_end, now.toISOString())
})

test('límite de 2 ordenadores, desactivar uno y límite de cambios al mes', async () => {
  const email = 'bea@example.com'
  await newUser(email)
  assert.equal((await check(email, 'b-1')).status, 200)
  assert.equal((await check(email, 'b-2')).status, 200)
  const full = await check(email, 'b-3')
  assert.equal(full.status, 409)
  assert.equal(full.body.error, 'device_limit')
  assert.equal(full.body.max, 2)
  assert.deepEqual(full.body.devices.map((x: { id: string }) => x.id).sort(), ['b-1', 'b-2'])

  const deactivate = (id: string) => deviceDeactivate(post({ app: 'fotogestor', device_id: id }, `token-${email}`), deps)
  assert.equal((await deactivate('b-1')).status, 200)
  assert.equal((await deactivate('b-1')).status, 404)
  assert.equal((await check(email, 'b-3')).status, 200)
  assert.equal((await deactivate('b-2')).status, 200)
  assert.equal((await check(email, 'b-4')).status, 200)
  assert.equal((await deactivate('b-3')).status, 200)
  const r = await deactivate('b-4')
  assert.equal(r.status, 429)
  assert.equal((await r.json()).error, 'device_swap_limit')
})

test('cuenta bloqueada y modo mantenimiento', async () => {
  const uid = await newUser('carlos@example.com')
  await check('carlos@example.com', 'c-1')
  await sql`update public.accounts set blocked_reason = 'Cuenta suspendida' where user_id = ${uid}`
  let r = await check('carlos@example.com', 'c-1')
  assert.equal(r.status, 403)
  assert.deepEqual(r.body, { error: 'blocked', message: 'Cuenta suspendida' })
  await sql`update public.accounts set blocked_reason = null where user_id = ${uid}`
  await sql`update public.apps set maintenance_message = 'Volvemos en una hora', min_version = '0.18.0' where id = 'fotogestor'`
  r = await check('carlos@example.com', 'c-1')
  assert.deepEqual(r.body, { error: 'maintenance', message: 'Volvemos en una hora' })
  await sql`update public.apps set maintenance_message = null where id = 'fotogestor'`
  assert.equal((await check('carlos@example.com', 'c-1')).claims.min_version, '0.18.0')
  await sql`update public.apps set min_version = null where id = 'fotogestor'`
})

test('avisos de Paddle: alta, duplicados, desorden, cancelación y fin', async () => {
  const email = 'dani@example.com'
  const uid = await newUser(email)
  await check(email, 'd-1')
  const base = {
    id: 'sub_dani', status: 'active', customer_id: 'ctm_dani', items: [{ price: { id: 'pri_mensual' } }],
    current_billing_period: { ends_at: '2026-12-27T12:00:00Z' }, scheduled_change: null,
    custom_data: { user_id: uid, app: 'fotogestor' }
  }

  assert.equal((await webhook(subEvent('evt_1', 'subscription.created', '2026-11-27T12:00:00Z', base), 'otro')).status, 401)
  assert.equal((await webhook(subEvent('evt_1', 'subscription.created', '2026-11-27T12:00:00Z', base))).status, 200)
  let r = await check(email, 'd-1')
  assert.equal(r.claims.status, 'active')
  assert.equal(r.claims.plan, 'mensual')
  assert.equal(r.claims.period_end, '2026-12-30T12:00:00.000Z')
  assert.equal(r.body.can_manage, true)
  assert.equal((await sql`select paddle_customer_id from public.accounts where user_id = ${uid}`)[0].paddle_customer_id, 'ctm_dani')

  // El mismo aviso otra vez no se procesa.
  assert.deepEqual(await (await webhook(subEvent('evt_1', 'subscription.created', '2026-11-27T12:00:00Z', base))).json(), { ok: true, duplicate: true })

  // Cancelación programada.
  const cancel = { ...base, scheduled_change: { action: 'cancel', effective_at: '2026-12-27T12:00:00Z' } }
  await webhook(subEvent('evt_2', 'subscription.updated', '2026-11-28T12:00:00Z', cancel))
  r = await check(email, 'd-1')
  assert.equal(r.claims.status, 'cancelled')
  assert.equal(r.claims.period_end, '2026-12-27T12:00:00.000Z')

  // Un aviso anterior que llega tarde no deshace la cancelación.
  await webhook(subEvent('evt_0', 'subscription.updated', '2026-11-27T13:00:00Z', { ...base, status: 'past_due' }))
  assert.equal((await check(email, 'd-1')).claims.status, 'cancelled')

  // Fin de la suscripción.
  await webhook(subEvent('evt_3', 'subscription.canceled', '2026-12-27T12:00:00Z',
    { ...base, status: 'canceled', canceled_at: '2026-12-27T12:00:00Z', scheduled_change: null }))
  r = await check(email, 'd-1')
  assert.equal(r.claims.status, 'expired')
  assert.equal(r.body.can_manage, true)
})

test('un aviso sin usuario queda guardado con el error y Paddle lo reintenta', async () => {
  const evt = subEvent('evt_huerfano', 'subscription.created', '2026-11-27T12:00:00Z', { id: 'sub_x', status: 'active', custom_data: {} })
  assert.equal((await webhook(evt)).status, 500)
  const [row] = await sql`select processed_at, error from public.paddle_events where event_id = 'evt_huerfano'`
  assert.equal(row.processed_at, null)
  assert.match(row.error, /sin usuario/)
  // El reintento se vuelve a procesar (no se toma por duplicado).
  assert.equal((await webhook(evt)).status, 500)
  // Otros tipos de aviso se guardan sin más.
  assert.equal((await webhook({ event_id: 'evt_tx', event_type: 'transaction.completed', occurred_at: '2026-11-27T12:00:00Z', data: {} })).status, 200)
})

test('portal de cliente: enlace de Paddle o 404 sin suscripción', async () => {
  const res = await portalSession(post({ app: 'fotogestor' }, 'token-dani@example.com'), deps)
  assert.equal(res.status, 200)
  assert.equal((await res.json()).url, 'https://customer-portal.paddle.com/sesion')
  assert.deepEqual(paddleCalls.at(-1), { method: 'POST', path: '/customers/ctm_dani/portal-sessions', body: { subscription_ids: ['sub_dani'] } })
  assert.equal((await portalSession(post({ app: 'fotogestor' }, 'token-ana@example.com'), deps)).status, 404)
})
