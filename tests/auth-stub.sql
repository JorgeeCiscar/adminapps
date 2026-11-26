-- Solo para pruebas locales: lo mínimo de Supabase Auth que usa la migración.
create schema if not exists auth;
create table if not exists auth.users (id uuid primary key default gen_random_uuid(), email text);
