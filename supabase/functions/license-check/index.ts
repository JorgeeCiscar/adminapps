import { deps } from '../_shared/deps.ts'
import { licenseCheck } from '../_shared/handlers.ts'

Deno.serve((req) => licenseCheck(req, deps))
