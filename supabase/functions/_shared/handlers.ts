/**
 * Funciones del servidor de licencias. Reciben sus dependencias (base de datos, login, Paddle)
 * para poder probarlas en Node contra un PostgreSQL local (tests/handlers.test.ts).
 * Contrato con las apps: docs/contrato.md.
 */
import {
  checkoutLink, computeStatus, pickSubscription, signLicense, subscriptionFromPaddle,
  TOKEN_TTL_SECONDS, verifyPaddleSignature, type SubscriptionRow
} from './logic.ts'

/** Cliente de postgres.js (mismo uso en Deno y en Node). */
// deno-lint-ignore no-explicit-any
export type Sql = any

export interface Deps {
  sql: Sql
  /** Usuario de un token de acceso de Supabase Auth, o null si no es válido. */
  getUser(jwt: string): Promise<{ id: string; email: string } | null>
  /** Clave privada Ed25519 para firmar las licencias. */
  privateKey(): Promise<CryptoKey>
  /** Llamada a la API de Paddle. */
  paddle(method: string, path: string, body?: unknown): Promise<Record<string, any>>
  paddleWebhookSecret: string
  /** Página de pago (web/pagar.html publicada). */
  checkoutUrl?: string
  now?: () => Date
  log?: (msg: string) => void
}

/** Cambios de ordenador permitidos cada 30 días. */
export const DEVICE_SWAP_LIMIT = 3

const json = (status: number, body?: unknown) =>
  new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

const text = (v: unknown, max = 200) => typeof v === 'string' ? v.trim().slice(0, max) : ''

async function readBody(req: Request): Promise<Record<string, unknown>> {
  try { return (await req.json()) ?? {} } catch { return {} }
}

async function authUser(req: Request, d: Deps) {
  const m = /^Bearer\s+(.+)$/i.exec(req.headers.get('authorization') ?? '')
  return m ? await d.getUser(m[1]) : null
}

/** Envuelve una función: solo POST y errores inesperados como 500 sin detalles internos. */
function endpoint(fn: (req: Request, d: Deps) => Promise<Response>) {
  return async (req: Request, d: Deps): Promise<Response> => {
    if (req.method !== 'POST') return json(405, { message: 'Método no permitido' })
    try {
      return await fn(req, d)
    } catch (e) {
      d.log?.(`error: ${e instanceof Error ? e.stack ?? e.message : String(e)}`)
      return json(500, { message: 'Error interno del servidor' })
    }
  }
}

// ---------------------------------------------------------------------------
// license-check
// ---------------------------------------------------------------------------

export const licenseCheck = endpoint(async (req, d) => {
  const user = await authUser(req, d)
  if (!user) return json(401, { message: 'Sesión no válida' })
  const body = await readBody(req)
  const appId = text(body.app, 40)
  const deviceId = text(body.device_id, 128)
  if (!appId || !deviceId) return json(400, { message: 'Faltan la app o el ordenador' })
  const { sql } = d
  const now = d.now?.() ?? new Date()

  const [app] = await sql`select * from public.apps where id = ${appId}`
  if (!app) return json(400, { message: 'Aplicación desconocida' })
  if (app.maintenance_message) return json(403, { error: 'maintenance', message: app.maintenance_message })

  const [account] = await sql`
    insert into public.accounts (user_id, email) values (${user.id}, ${user.email})
    on conflict (user_id) do update set email = excluded.email
    returning blocked_reason`
  if (account.blocked_reason) return json(403, { error: 'blocked', message: account.blocked_reason })

  // Límite de ordenadores.
  const devices = await sql`
    select device_id, name, last_seen from public.devices
    where user_id = ${user.id} and app_id = ${appId} and active
    order by last_seen desc`
  if (!devices.some((x: { device_id: string }) => x.device_id === deviceId) && devices.length >= app.max_devices) {
    return json(409, {
      error: 'device_limit', max: app.max_devices,
      devices: devices.map((x: { device_id: string; name: string | null; last_seen: Date }) =>
        ({ id: x.device_id, name: x.name ?? 'Ordenador', last_seen: new Date(x.last_seen).toISOString() }))
    })
  }
  await sql`
    insert into public.devices (user_id, app_id, device_id, name, os, version, last_seen)
    values (${user.id}, ${appId}, ${deviceId}, ${text(body.device_name, 100) || null}, ${text(body.os, 100) || null},
            ${text(body.version, 40) || null}, ${now})
    on conflict (user_id, app_id, device_id) do update set
      active = true, name = excluded.name, os = excluded.os, version = excluded.version, last_seen = excluded.last_seen`

  // Suscripción o prueba.
  const subs = await sql`select * from public.subscriptions where user_id = ${user.id} and app_id = ${appId}` as SubscriptionRow[]
  const sub = pickSubscription(subs, now)
  let [trial] = await sql`select ends_at from public.trials where user_id = ${user.id} and app_id = ${appId}`
  if (!trial && subs.length === 0) {
    // Una prueba por ordenador: si este ya la usó con otra cuenta, no hay prueba nueva.
    const [used] = await sql`select 1 from public.trials where app_id = ${appId} and device_id = ${deviceId} and user_id <> ${user.id} limit 1`
    if (!used) {
      const ends = new Date(now.getTime() + app.trial_days * 86_400_000)
      await sql`
        insert into public.trials (user_id, app_id, device_id, started_at, ends_at)
        values (${user.id}, ${appId}, ${deviceId}, ${now}, ${ends}) on conflict do nothing`
      ;[trial] = await sql`select ends_at from public.trials where user_id = ${user.id} and app_id = ${appId}`
    }
  }
  const st = computeStatus(sub, trial ?? null, now)

  let plan: string | null = null
  if (sub?.paddle_price_id) {
    const [p] = await sql`select name from public.plans where paddle_price_id = ${sub.paddle_price_id}`
    plan = p?.name ?? null
  }

  await sql`
    insert into public.license_checks (user_id, app_id, device_id, version, status)
    values (${user.id}, ${appId}, ${deviceId}, ${text(body.version, 40) || null}, ${st.status})`

  const iat = Math.floor(now.getTime() / 1000)
  const token = await signLicense({
    v: 1, app: appId, sub: user.id, email: user.email, device: deviceId,
    status: st.status, plan, trial_end: st.trial_end, period_end: st.period_end,
    features: [], min_version: app.min_version ?? null, iat, exp: iat + TOKEN_TTL_SECONDS
  }, await d.privateKey())

  return json(200, {
    token,
    checkout_url: checkoutLink(d.checkoutUrl, appId, user.id, user.email),
    can_manage: !!sub?.paddle_customer_id
  })
})

// ---------------------------------------------------------------------------
// device-deactivate
// ---------------------------------------------------------------------------

export const deviceDeactivate = endpoint(async (req, d) => {
  const user = await authUser(req, d)
  if (!user) return json(401, { message: 'Sesión no válida' })
  const body = await readBody(req)
  const appId = text(body.app, 40)
  const deviceId = text(body.device_id, 128)
  const { sql } = d
  const [{ count }] = await sql`
    select count(*)::int as count from public.device_deactivations
    where user_id = ${user.id} and app_id = ${appId} and not by_admin and created_at > now() - interval '30 days'`
  if (count >= DEVICE_SWAP_LIMIT) return json(429, { error: 'device_swap_limit', message: 'Demasiados cambios de ordenador este mes' })
  const done = await sql`
    update public.devices set active = false
    where user_id = ${user.id} and app_id = ${appId} and device_id = ${deviceId} and active
    returning device_id`
  if (!done.length) return json(404, { message: 'Ese ordenador no está activo' })
  await sql`insert into public.device_deactivations (user_id, app_id, device_id) values (${user.id}, ${appId}, ${deviceId})`
  return json(200, { ok: true })
})

// ---------------------------------------------------------------------------
// portal-session
// ---------------------------------------------------------------------------

export const portalSession = endpoint(async (req, d) => {
  const user = await authUser(req, d)
  if (!user) return json(401, { message: 'Sesión no válida' })
  const appId = text((await readBody(req)).app, 40)
  const subs = await d.sql`
    select * from public.subscriptions
    where user_id = ${user.id} and app_id = ${appId} and paddle_customer_id is not null` as SubscriptionRow[]
  const sub = pickSubscription(subs, d.now?.() ?? new Date())
  if (!sub?.paddle_customer_id) return json(404, { message: 'No hay ninguna suscripción de Paddle' })
  const res = await d.paddle('POST', `/customers/${encodeURIComponent(sub.paddle_customer_id)}/portal-sessions`,
    { subscription_ids: sub.paddle_subscription_id ? [sub.paddle_subscription_id] : [] })
  const url = res?.data?.urls?.general?.overview
  if (typeof url !== 'string') throw new Error('Paddle no ha devuelto el enlace del portal')
  return json(200, { url })
})

// ---------------------------------------------------------------------------
// paddle-webhook
// ---------------------------------------------------------------------------

async function applySubscription(d: Deps, data: Record<string, unknown>, occurredAt: string | null) {
  const s = subscriptionFromPaddle(data)
  const { sql } = d
  const [prev] = await sql`select user_id, app_id from public.subscriptions where paddle_subscription_id = ${s.paddle_subscription_id}`
  const userId = s.user_id ?? prev?.user_id
  if (!userId) throw new Error(`Suscripción ${s.paddle_subscription_id} sin usuario (falta custom_data.user_id)`)
  let appId = s.app_id ?? prev?.app_id
  if (!appId && s.paddle_price_id) {
    const [p] = await sql`select app_id from public.plans where paddle_price_id = ${s.paddle_price_id}`
    appId = p?.app_id
  }
  if (!appId) throw new Error(`Suscripción ${s.paddle_subscription_id} sin app`)
  const at = occurredAt ? new Date(occurredAt) : new Date()
  // Solo se aplica si el aviso es más reciente que el último guardado (pueden llegar desordenados).
  await sql`
    insert into public.subscriptions
      (user_id, app_id, paddle_subscription_id, paddle_customer_id, paddle_price_id, status,
       current_period_end, cancel_at, last_event_at, updated_at)
    values (${userId}, ${appId}, ${s.paddle_subscription_id}, ${s.paddle_customer_id}, ${s.paddle_price_id}, ${s.status},
       ${s.current_period_end}, ${s.cancel_at}, ${at}, now())
    on conflict (paddle_subscription_id) do update set
      paddle_customer_id = excluded.paddle_customer_id, paddle_price_id = excluded.paddle_price_id,
      status = excluded.status, current_period_end = excluded.current_period_end, cancel_at = excluded.cancel_at,
      last_event_at = excluded.last_event_at, updated_at = now()
    where public.subscriptions.last_event_at is null or public.subscriptions.last_event_at <= excluded.last_event_at`
  if (s.paddle_customer_id) {
    await sql`update public.accounts set paddle_customer_id = ${s.paddle_customer_id} where user_id = ${userId}`
  }
}

export const paddleWebhook = endpoint(async (req, d) => {
  const raw = await req.text()
  if (!(await verifyPaddleSignature(raw, req.headers.get('paddle-signature'), d.paddleWebhookSecret))) {
    return json(401, { message: 'Firma no válida' })
  }
  let evt: Record<string, any>
  try { evt = JSON.parse(raw) } catch { return json(400, { message: 'JSON no válido' }) }
  if (typeof evt.event_id !== 'string' || typeof evt.event_type !== 'string') return json(400, { message: 'Aviso incompleto' })

  const { sql } = d
  // Si ya se procesó, no se repite; si falló, se reintenta.
  const fresh = await sql`
    insert into public.paddle_events (event_id, event_type, occurred_at, payload)
    values (${evt.event_id}, ${evt.event_type}, ${evt.occurred_at ?? null}, ${sql.json(evt)})
    on conflict (event_id) do update set received_at = now()
    where public.paddle_events.processed_at is null
    returning event_id`
  if (!fresh.length) return json(200, { ok: true, duplicate: true })

  try {
    if (evt.event_type.startsWith('subscription.')) await applySubscription(d, evt.data ?? {}, evt.occurred_at ?? null)
    await sql`update public.paddle_events set processed_at = now(), error = null where event_id = ${evt.event_id}`
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    await sql`update public.paddle_events set error = ${msg} where event_id = ${evt.event_id}`
    d.log?.(`paddle-webhook ${evt.event_id}: ${msg}`)
    // Paddle reintentará el aviso.
    return json(500, { message: 'No se pudo procesar el aviso' })
  }
  return json(200, { ok: true })
})
