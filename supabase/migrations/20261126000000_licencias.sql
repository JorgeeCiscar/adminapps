-- Licencias por suscripción de FotoGestor y AppClase.
-- Contrato con las apps: docs/contrato.md (copia del apéndice A de la especificación).
-- Todas las tablas tienen Row Level Security sin políticas: solo las funciones del servidor
-- (conexión directa a la base de datos) pueden leerlas y escribirlas.

create table public.apps (
  id text primary key,
  name text not null,
  max_devices int not null default 2 check (max_devices > 0),
  trial_days int not null default 7 check (trial_days >= 0),
  -- Versión mínima: las anteriores tienen que actualizar para entrar.
  min_version text,
  -- Si tiene texto, nadie puede entrar y se muestra este mensaje (mantenimiento).
  maintenance_message text,
  created_at timestamptz not null default now()
);

insert into public.apps (id, name) values
  ('fotogestor', 'FotoGestor'),
  ('appclase', 'AppClase');

-- Precios de Paddle de cada app.
create table public.plans (
  id text primary key,
  app_id text not null references public.apps (id),
  name text not null,
  billing_interval text not null check (billing_interval in ('month', 'year')),
  paddle_price_id text unique,
  price_cents int,
  currency text not null default 'EUR',
  active boolean not null default true
);

insert into public.plans (id, app_id, name, billing_interval, price_cents) values
  ('fotogestor-mensual', 'fotogestor', 'mensual', 'month', 999),
  ('fotogestor-anual', 'fotogestor', 'anual', 'year', 9900),
  ('appclase-mensual', 'appclase', 'mensual', 'month', 299),
  ('appclase-anual', 'appclase', 'anual', 'year', 2499);

-- Datos propios de cada usuario (las cuentas están en auth.users).
create table public.accounts (
  user_id uuid primary key references auth.users (id) on delete cascade,
  email text,
  -- Si tiene texto, la cuenta está bloqueada y se muestra este mensaje.
  blocked_reason text,
  notes text,
  paddle_customer_id text,
  country text,
  created_at timestamptz not null default now()
);

create function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  insert into public.accounts (user_id, email) values (new.id, new.email)
  on conflict (user_id) do update set email = excluded.email;
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert or update of email on auth.users
  for each row execute function public.handle_new_user();

-- Suscripciones de Paddle (y meses regalados desde AdminApps, con status 'manual').
create table public.subscriptions (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  app_id text not null references public.apps (id),
  paddle_subscription_id text unique,
  paddle_customer_id text,
  paddle_price_id text,
  -- Estado de Paddle: active, trialing, past_due, paused, canceled; o 'manual'.
  status text not null,
  current_period_end timestamptz,
  -- Cancelación programada: sigue activa hasta esta fecha.
  cancel_at timestamptz,
  last_event_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index subscriptions_user_app on public.subscriptions (user_id, app_id);

-- Una prueba por cuenta y app; el ordenador se guarda para no repetir pruebas con otra cuenta.
create table public.trials (
  user_id uuid not null references auth.users (id) on delete cascade,
  app_id text not null references public.apps (id),
  device_id text not null,
  started_at timestamptz not null default now(),
  ends_at timestamptz not null,
  primary key (user_id, app_id)
);
create index trials_app_device on public.trials (app_id, device_id);

create table public.devices (
  user_id uuid not null references auth.users (id) on delete cascade,
  app_id text not null references public.apps (id),
  device_id text not null,
  name text,
  os text,
  version text,
  active boolean not null default true,
  first_seen timestamptz not null default now(),
  last_seen timestamptz not null default now(),
  primary key (user_id, app_id, device_id)
);

-- Para limitar los cambios de ordenador al mes.
create table public.device_deactivations (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  app_id text not null references public.apps (id),
  device_id text not null,
  by_admin boolean not null default false,
  created_at timestamptz not null default now()
);
create index device_deactivations_user on public.device_deactivations (user_id, app_id, created_at);

-- Cada comprobación de licencia (estadísticas y detección de abusos).
create table public.license_checks (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  app_id text not null,
  device_id text not null,
  version text,
  status text not null,
  created_at timestamptz not null default now()
);
create index license_checks_created on public.license_checks (created_at);
create index license_checks_user on public.license_checks (user_id, created_at);

-- Copia de cada aviso (webhook) de Paddle, para depurar y no procesar dos veces.
create table public.paddle_events (
  event_id text primary key,
  event_type text not null,
  occurred_at timestamptz,
  payload jsonb not null,
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  error text
);

-- Acciones hechas desde AdminApps.
create table public.admin_audit_log (
  id bigint generated always as identity primary key,
  admin_email text not null,
  action text not null,
  target text,
  details jsonb,
  created_at timestamptz not null default now()
);

alter table public.apps enable row level security;
alter table public.plans enable row level security;
alter table public.accounts enable row level security;
alter table public.subscriptions enable row level security;
alter table public.trials enable row level security;
alter table public.devices enable row level security;
alter table public.device_deactivations enable row level security;
alter table public.license_checks enable row level security;
alter table public.paddle_events enable row level security;
alter table public.admin_audit_log enable row level security;
