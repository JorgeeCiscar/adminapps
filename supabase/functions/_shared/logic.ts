/**
 * Lógica pura del servidor de licencias: sin base de datos ni red, para poder probarla en Node
 * (`npm test`) y ejecutarla en las funciones de Supabase (Deno). Solo usa WebCrypto.
 */

export type LicenseStatus = 'trial' | 'active' | 'past_due' | 'cancelled' | 'expired'

export interface SubscriptionRow {
  status: string
  paddle_price_id: string | null
  paddle_customer_id: string | null
  paddle_subscription_id: string | null
  current_period_end: Date | string | null
  cancel_at: Date | string | null
}

export interface TrialRow {
  ends_at: Date | string
}

export interface ComputedStatus {
  status: LicenseStatus
  trial_end: string | null
  period_end: string | null
}

/** Días de margen tras el fin del periodo por si el aviso de renovación de Paddle se retrasa. */
export const RENEWAL_GRACE_DAYS = 3
const DAY = 86_400_000

const iso = (v: Date | string | null): string | null => v === null ? null : new Date(v).toISOString()
const time = (v: Date | string | null): number => v === null ? 0 : new Date(v).getTime()

const LIVE = new Set(['active', 'trialing', 'past_due', 'manual'])

/** Elige la suscripción que manda: primero las vigentes, y entre ellas la que dura más. */
export function pickSubscription<T extends SubscriptionRow>(subs: T[], now = new Date()): T | null {
  const live = (s: T) => LIVE.has(s.status) && (s.status !== 'manual' || time(s.current_period_end) > now.getTime())
  return [...subs].sort((a, b) =>
    Number(live(b)) - Number(live(a)) || time(b.current_period_end) - time(a.current_period_end))[0] ?? null
}

/**
 * Estado de la licencia a partir de la suscripción y la prueba. Sin ninguna de las dos, se
 * devuelve una prueba ya terminada (la app muestra «La prueba gratuita ha terminado»).
 */
export function computeStatus(sub: SubscriptionRow | null, trial: TrialRow | null, now = new Date()): ComputedStatus {
  if (sub) {
    if (sub.status === 'active' || sub.status === 'trialing') {
      if (sub.cancel_at) return { status: 'cancelled', trial_end: null, period_end: iso(sub.cancel_at) }
      const end = sub.current_period_end ? new Date(time(sub.current_period_end) + RENEWAL_GRACE_DAYS * DAY).toISOString() : null
      return { status: 'active', trial_end: null, period_end: end }
    }
    if (sub.status === 'past_due') return { status: 'past_due', trial_end: null, period_end: null }
    if (sub.status === 'manual' && time(sub.current_period_end) > now.getTime()) {
      return { status: 'active', trial_end: null, period_end: iso(sub.current_period_end) }
    }
    return { status: 'expired', trial_end: null, period_end: iso(sub.cancel_at ?? sub.current_period_end) }
  }
  if (trial) return { status: 'trial', trial_end: iso(trial.ends_at), period_end: null }
  return { status: 'trial', trial_end: now.toISOString(), period_end: null }
}

// ---------------------------------------------------------------------------
// Codificación y firma del token de licencia (Ed25519)
// ---------------------------------------------------------------------------

function base64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  const bin = atob(b64.replace(/-/g, '+').replace(/_/g, '/').replace(/\s+/g, ''))
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

export function base64url(bytes: Uint8Array): string {
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** Clave privada Ed25519 en PKCS#8 (DER en base64, o PEM). */
export function importPrivateKey(key: string): Promise<CryptoKey> {
  const b64 = key.replace(/-----(BEGIN|END) PRIVATE KEY-----/g, '')
  return crypto.subtle.importKey('pkcs8', base64ToBytes(b64), { name: 'Ed25519' }, false, ['sign'])
}

export interface LicenseClaims {
  v: 1
  app: string
  sub: string
  email: string
  device: string
  status: LicenseStatus
  plan: string | null
  trial_end: string | null
  period_end: string | null
  features: string[]
  min_version: string | null
  iat: number
  exp: number
}

/** Validez del token: la app vuelve a comprobar cada hora. */
export const TOKEN_TTL_SECONDS = 6 * 3600

/** `base64url(JSON).base64url(firma)`, firmando la primera parte tal cual. */
export async function signLicense(claims: LicenseClaims, key: CryptoKey): Promise<string> {
  const body = base64url(new TextEncoder().encode(JSON.stringify(claims)))
  const sig = new Uint8Array(await crypto.subtle.sign('Ed25519', key, new TextEncoder().encode(body)))
  return `${body}.${base64url(sig)}`
}

// ---------------------------------------------------------------------------
// Paddle
// ---------------------------------------------------------------------------

/** Tiempo máximo entre la firma del aviso y su recepción. */
const PADDLE_TOLERANCE_S = 300

function hex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')
}

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

/**
 * Comprueba la cabecera `Paddle-Signature: ts=…;h1=…` (HMAC-SHA256 de `ts:cuerpo` con el
 * secreto del webhook).
 */
export async function verifyPaddleSignature(raw: string, header: string | null, secret: string, nowS = Math.floor(Date.now() / 1000)): Promise<boolean> {
  if (!header || !secret) return false
  const parts = Object.fromEntries(header.split(';').map((p) => p.split('=', 2) as [string, string]))
  const ts = Number(parts.ts)
  if (!Number.isFinite(ts) || Math.abs(nowS - ts) > PADDLE_TOLERANCE_S) return false
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const mac = hex(new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${parts.ts}:${raw}`))))
  // Durante un cambio de secreto Paddle puede enviar varias firmas h1.
  return header.split(';').filter((p) => p.startsWith('h1=')).some((p) => safeEqual(p.slice(3), mac))
}

export interface PaddleSubscription {
  paddle_subscription_id: string
  paddle_customer_id: string | null
  paddle_price_id: string | null
  status: string
  current_period_end: string | null
  cancel_at: string | null
  user_id: string | null
  app_id: string | null
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Datos que guardamos de una suscripción de Paddle (objeto `data` de los avisos subscription.*). */
export function subscriptionFromPaddle(d: Record<string, any>): PaddleSubscription {
  if (typeof d?.id !== 'string') throw new Error('Aviso de Paddle sin id de suscripción')
  const custom = (d.custom_data ?? {}) as Record<string, unknown>
  const userId = typeof custom.user_id === 'string' && UUID_RE.test(custom.user_id) ? custom.user_id : null
  const scheduled = d.scheduled_change?.action === 'cancel' ? d.scheduled_change.effective_at ?? null : null
  return {
    paddle_subscription_id: d.id,
    paddle_customer_id: d.customer_id ?? null,
    paddle_price_id: d.items?.[0]?.price?.id ?? null,
    status: String(d.status ?? 'active'),
    current_period_end: d.current_billing_period?.ends_at ?? null,
    cancel_at: d.status === 'canceled' ? (d.canceled_at ?? scheduled) : scheduled,
    user_id: userId,
    app_id: typeof custom.app === 'string' ? custom.app : null
  }
}

/** Página de pago con la app y el usuario ya identificados. */
export function checkoutLink(base: string | undefined, app: string, userId: string, email: string): string | null {
  if (!base) return null
  const u = new URL(base)
  u.searchParams.set('app', app)
  u.searchParams.set('uid', userId)
  u.searchParams.set('email', email)
  return u.toString()
}
