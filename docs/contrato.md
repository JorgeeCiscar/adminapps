# Contrato entre las apps y el servidor

La referencia es el **apéndice A** de la especificación, en el repositorio de FotoGestor:
<https://github.com/JorgeeCiscar/fotogestor/blob/main/docs/licencias-y-adminapps.md>.

Resumen de las funciones (todas `POST` con JSON, cabecera `apikey: <clave publicable>` y,
salvo el webhook, `Authorization: Bearer <token del usuario>`):

| Función | Cuerpo | Respuestas |
|---|---|---|
| `license-check` | `{ app, version, device_id, device_name, os }` | 200 `{ token, checkout_url, can_manage }` · 401 · 403 `blocked` / `maintenance` · 409 `device_limit` |
| `device-deactivate` | `{ app, device_id }` | 200 · 401 · 404 · 429 `device_swap_limit` |
| `portal-session` | `{ app }` | 200 `{ url }` · 401 · 404 |
| `paddle-webhook` | Aviso de Paddle (firma en `Paddle-Signature`) | 200 · 401 firma no válida · 500 (Paddle reintenta) |

Reglas del servidor:
- Prueba de 7 días (`apps.trial_days`) al primer `license-check`, una por cuenta y app, y ninguna
  nueva en un ordenador que ya tuvo prueba con otra cuenta.
- Máximo `apps.max_devices` ordenadores activos; 3 desactivaciones cada 30 días.
- Suscripción activa: `period_end` = fin del periodo de Paddle + 3 días de margen.
- `apps.min_version` obliga a actualizar; `apps.maintenance_message` y `accounts.blocked_reason`
  impiden entrar con ese mensaje.
