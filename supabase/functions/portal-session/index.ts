import { deps } from '../_shared/deps.ts'
import { portalSession } from '../_shared/handlers.ts'

Deno.serve((req) => portalSession(req, deps))
