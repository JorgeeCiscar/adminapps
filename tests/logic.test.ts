import assert from 'node:assert/strict'
import { createHmac, createPublicKey, verify, webcrypto } from 'node:crypto'
import { test } from 'node:test'
import {
  checkoutLink, computeStatus, importPrivateKey, pickSubscription, RENEWAL_GRACE_DAYS, signLicense,
  subscriptionFromPaddle, verifyPaddleSignature, type SubscriptionRow
} from '../supabase/functions/_shared/logic.ts'

const NOW = new Date('2026-11-26T12:00:00Z')
const days = (n: number) => new Date(NOW.getTime() + n * 86_400_000)
const sub = (p: Partial<SubscriptionRow>): SubscriptionRow => ({
  status: 'active', paddle_price_id: null, paddle_customer_id: null, paddle_subscription_id: null,
  current_period_end: null, cancel_at: null, ...p
})

test('estado: prueba, sin nada, activa, cancelada, impago, terminada y regalada', () => {
  assert.deepEqual(computeStatus(null, { ends_at: days(7) }, NOW), { status: 'trial', trial_end: days(7).toISOString(), period_end: null })
  assert.deepEqual(computeStatus(null, null, NOW), { status: 'trial', trial_end: NOW.toISOString(), period_end: null })
  assert.equal(computeStatus(sub({ current_period_end: days(10) }), null, NOW).period_end, days(10 + RENEWAL_GRACE_DAYS).toISOString())
  assert.deepEqual(computeStatus(sub({ current_period_end: days(10), cancel_at: days(10) }), null, NOW),
    { status: 'cancelled', trial_end: null, period_end: days(10).toISOString() })
  assert.equal(computeStatus(sub({ status: 'past_due' }), null, NOW).status, 'past_due')
  assert.equal(computeStatus(sub({ status: 'canceled', cancel_at: days(-1) }), { ends_at: days(-30) }, NOW).status, 'expired')
  assert.equal(computeStatus(sub({ status: 'paused' }), null, NOW).status, 'expired')
  assert.equal(computeStatus(sub({ status: 'manual', current_period_end: days(60) }), null, NOW).status, 'active')
  assert.equal(computeStatus(sub({ status: 'manual', current_period_end: days(-1) }), null, NOW).status, 'expired')
})

test('elige la suscripción vigente aunque haya otras más recientes terminadas', () => {
  const old = sub({ status: 'canceled', current_period_end: days(90), paddle_subscription_id: 'viejo' })
  const live = sub({ status: 'active', current_period_end: days(5), paddle_subscription_id: 'vigente' })
  assert.equal(pickSubscription([old, live], NOW)?.paddle_subscription_id, 'vigente')
  assert.equal(pickSubscription([], NOW), null)
})

test('firma licencias que se verifican con la clave pública (mismo formato que la app)', async () => {
  const pair = await webcrypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']) as CryptoKeyPair
  const pkcs8 = Buffer.from(await webcrypto.subtle.exportKey('pkcs8', pair.privateKey)).toString('base64')
  const spki = Buffer.from(await webcrypto.subtle.exportKey('spki', pair.publicKey))
  const token = await signLicense({
    v: 1, app: 'fotogestor', sub: 'u', email: 'a@b.es', device: 'd', status: 'trial', plan: null,
    trial_end: null, period_end: null, features: [], min_version: null, iat: 1, exp: 2
  }, await importPrivateKey(pkcs8))
  const [body, sig] = token.split('.')
  const pub = createPublicKey({ key: spki, format: 'der', type: 'spki' })
  assert.ok(verify(null, Buffer.from(body, 'ascii'), pub, Buffer.from(sig, 'base64url')))
  assert.equal(JSON.parse(Buffer.from(body, 'base64url').toString()).app, 'fotogestor')
  // También acepta la clave en PEM.
  const pem = `-----BEGIN PRIVATE KEY-----\n${pkcs8}\n-----END PRIVATE KEY-----\n`
  assert.ok(await importPrivateKey(pem))
})

test('verifica la firma de los avisos de Paddle', async () => {
  const raw = '{"event_id":"evt_1"}'
  const ts = 1_800_000_000
  const h1 = createHmac('sha256', 'secreto').update(`${ts}:${raw}`).digest('hex')
  assert.equal(await verifyPaddleSignature(raw, `ts=${ts};h1=${h1}`, 'secreto', ts + 10), true)
  assert.equal(await verifyPaddleSignature(raw, `ts=${ts};h1=otra;h1=${h1}`, 'secreto', ts), true)
  assert.equal(await verifyPaddleSignature(raw + ' ', `ts=${ts};h1=${h1}`, 'secreto', ts), false)
  assert.equal(await verifyPaddleSignature(raw, `ts=${ts};h1=${h1}`, 'otro', ts), false)
  assert.equal(await verifyPaddleSignature(raw, `ts=${ts};h1=${h1}`, 'secreto', ts + 3600), false)
  assert.equal(await verifyPaddleSignature(raw, null, 'secreto', ts), false)
})

test('interpreta las suscripciones de Paddle', () => {
  const uid = '6a1f3c2e-1b2c-4d5e-8f90-123456789abc'
  const s = subscriptionFromPaddle({
    id: 'sub_1', status: 'active', customer_id: 'ctm_1', items: [{ price: { id: 'pri_1' } }],
    current_billing_period: { ends_at: '2026-12-26T00:00:00Z' },
    scheduled_change: { action: 'cancel', effective_at: '2026-12-26T00:00:00Z' },
    custom_data: { user_id: uid, app: 'fotogestor' }
  })
  assert.deepEqual(s, {
    paddle_subscription_id: 'sub_1', paddle_customer_id: 'ctm_1', paddle_price_id: 'pri_1', status: 'active',
    current_period_end: '2026-12-26T00:00:00Z', cancel_at: '2026-12-26T00:00:00Z', user_id: uid, app_id: 'fotogestor'
  })
  assert.equal(subscriptionFromPaddle({ id: 'sub_2', custom_data: { user_id: 'no-es-uuid' } }).user_id, null)
  assert.throws(() => subscriptionFromPaddle({}))
})

test('enlace de pago con la app y el usuario', () => {
  assert.equal(checkoutLink(undefined, 'fotogestor', 'u', 'a@b.es'), null)
  assert.equal(checkoutLink('https://x.github.io/adminapps/pagar.html', 'fotogestor', 'u1', 'a+b@c.es'),
    'https://x.github.io/adminapps/pagar.html?app=fotogestor&uid=u1&email=a%2Bb%40c.es')
})
