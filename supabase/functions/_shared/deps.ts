// Dependencias reales de las funciones en Supabase (Deno). Las pruebas usan otras (tests/).
import postgres from 'npm:postgres@3.4.5'
import type { Deps } from './handlers.ts'
import { importPrivateKey } from './logic.ts'

const env = (k: string) => Deno.env.get(k) ?? ''

// Conexión directa a la base de datos: las tablas tienen RLS sin políticas y solo se acceden desde aquí.
const sql = postgres(env('SUPABASE_DB_URL'), { prepare: false, max: 3, idle_timeout: 20 })

let key: Promise<CryptoKey> | null = null
const publishable = () => env('APP_PUBLISHABLE_KEY') || env('SUPABASE_ANON_KEY')
const paddleBase = () => env('PADDLE_ENV') === 'production' ? 'https://api.paddle.com' : 'https://sandbox-api.paddle.com'

export const deps: Deps = {
  sql,
  async getUser(jwt) {
    const res = await fetch(`${env('SUPABASE_URL')}/auth/v1/user`, {
      headers: { apikey: publishable(), authorization: `Bearer ${jwt}` }
    })
    if (!res.ok) return null
    const u = await res.json()
    return typeof u?.id === 'string' ? { id: u.id, email: String(u.email ?? '') } : null
  },
  privateKey() {
    if (!env('LICENSE_PRIVATE_KEY')) throw new Error('Falta el secreto LICENSE_PRIVATE_KEY')
    return (key ??= importPrivateKey(env('LICENSE_PRIVATE_KEY')))
  },
  async paddle(method, path, body) {
    const res = await fetch(paddleBase() + path, {
      method,
      headers: { authorization: `Bearer ${env('PADDLE_API_KEY')}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body)
    })
    const j = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(`Paddle ${res.status}: ${j?.error?.detail ?? j?.error?.code ?? 'error'}`)
    return j
  },
  paddleWebhookSecret: env('PADDLE_WEBHOOK_SECRET'),
  checkoutUrl: env('CHECKOUT_URL') || undefined,
  log: (m) => console.error(m)
}
