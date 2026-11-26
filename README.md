# AdminApps

Servidor de licencias por suscripción de **FotoGestor** y **AppClase**, y (próximamente) el panel
de control para gestionarlas.

Especificación completa: `docs/licencias-y-adminapps.md` del repositorio
[fotogestor](https://github.com/JorgeeCiscar/fotogestor/blob/main/docs/licencias-y-adminapps.md).
El contrato entre las apps y el servidor es su **apéndice A** (ver también [docs/contrato.md](docs/contrato.md)).

## Qué hay aquí

| Carpeta | Contenido |
|---|---|
| `supabase/migrations/` | Tablas: apps, planes, cuentas, suscripciones, pruebas, ordenadores, comprobaciones, avisos de Paddle, auditoría |
| `supabase/functions/` | Funciones: `license-check`, `device-deactivate`, `portal-session`, `paddle-webhook` |
| `web/` | Página de pago (Paddle.js) que se publica en GitHub Pages |
| `tests/` | Pruebas de la lógica y de las funciones contra un PostgreSQL local |
| `.github/workflows/` | Despliegue del servidor, generación de claves y publicación de la página de pago |

Proyecto de Supabase: `dvqgknryosgdmriplmim` (`https://dvqgknryosgdmriplmim.supabase.co`).

## Puesta en marcha

Los secretos se guardan en **GitHub → este repositorio → Settings → Secrets and variables → Actions →
New repository secret**. No se escriben nunca en el código ni en el chat.

1. **Token de Supabase.** En supabase.com → tu avatar → *Account preferences* → *Access tokens* →
   *Generate new token*. Guárdalo como secreto `SUPABASE_ACCESS_TOKEN`.
2. **Contraseña de la base de datos.** La que pusiste al crear el proyecto (si no la recuerdas:
   *Project Settings → Database → Reset database password*). Secreto `SUPABASE_DB_PASSWORD`.
3. **Clave de API de Paddle** (sandbox). *Developer tools → Authentication → API keys → New API key*,
   con permiso de escritura en *Customer portal sessions* y lectura en *Customers* y *Subscriptions*.
   Secreto `PADDLE_API_KEY`.
4. **Avisos (webhook) de Paddle.** *Developer tools → Notifications → New destination*:
   - URL: `https://dvqgknryosgdmriplmim.supabase.co/functions/v1/paddle-webhook`
   - Eventos: todos los `subscription.*` y `transaction.completed`.
   - Copia la *secret key* del destino y guárdala como secreto `PADDLE_WEBHOOK_SECRET`.
5. **Página de pago.** *Settings → Pages → Source: GitHub Actions* (el repositorio tiene que ser
   público, o tener GitHub Pro). Quedará en `https://jorgeeciscar.github.io/adminapps/pagar.html`.
   En Paddle: *Checkout → Checkout settings → Default payment link* con esa misma dirección.
6. **Claves de las licencias.** *Actions → Generar claves de licencia → Run workflow*. La clave
   privada se guarda sola en Supabase; la **pública** aparece en el resumen de la ejecución.
7. **Desplegar.** *Actions → Desplegar servidor → Run workflow*. Pasa las pruebas, crea las tablas,
   guarda los secretos de las funciones y publica las funciones. Después se repite sola con cada
   cambio en `supabase/`.
8. **Emails de Supabase.** *Authentication → Sign In / Providers → Email*: deja activado
   *Confirm email*. Antes de vender, configura un SMTP propio (*Authentication → Emails → SMTP*):
   el servidor de correo incluido en Supabase solo envía unos pocos emails por hora.

Datos públicos que necesita la app (se pueden compartir): la URL del proyecto, la clave
publicable (`sb_publishable_…`), la clave pública de licencias del paso 6, los ids de precio de
Paddle (`pri_…`) y el *client-side token* de Paddle (`test_…`), que va en `web/config.js`.

## Variables opcionales

En *Settings → Secrets and variables → Actions → Variables*:

| Variable | Por defecto | Para qué |
|---|---|---|
| `PADDLE_ENV` | `sandbox` | `production` al empezar a cobrar de verdad |
| `CHECKOUT_URL` | `https://jorgeeciscar.github.io/adminapps/pagar.html` | Si la página de pago se publica en otro sitio |

## Pruebas

```bash
npm install
npm test   # necesita PostgreSQL; usa DATABASE_URL (por defecto postgres://postgres:postgres@localhost:5432/pruebas)
```

¡Las pruebas borran y recrean los esquemas `public` y `auth` de esa base de datos! Úsala solo para pruebas.
