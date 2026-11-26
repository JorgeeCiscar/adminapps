import { deps } from '../_shared/deps.ts'
import { deviceDeactivate } from '../_shared/handlers.ts'

Deno.serve((req) => deviceDeactivate(req, deps))
