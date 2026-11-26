import { deps } from '../_shared/deps.ts'
import { paddleWebhook } from '../_shared/handlers.ts'

Deno.serve((req) => paddleWebhook(req, deps))
