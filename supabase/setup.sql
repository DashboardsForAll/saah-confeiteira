-- Banco do painel Saah Confeiteira (rodar uma vez no SQL Editor do Supabase).
-- Todos leem; só os e-mails cadastrados em public.editores (e logados) alteram.

create table if not exists public.registros (
  colecao    text        not null,   -- receitas | compras | produtos | vendas | config
  id         text        not null,
  dados      jsonb       not null,
  updated_at timestamptz not null default now(),
  primary key (colecao, id)
);

create table if not exists public.editores (
  email text primary key
);

alter table public.registros enable row level security;
alter table public.editores  enable row level security;   -- sem políticas: ninguém lê pela API

create or replace function public.is_editor()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.editores
    where lower(email) = lower(coalesce(auth.jwt() ->> 'email', ''))
  );
$$;

drop policy if exists "leitura publica"  on public.registros;
drop policy if exists "editores inserem" on public.registros;
drop policy if exists "editores alteram" on public.registros;
drop policy if exists "editores excluem" on public.registros;

create policy "leitura publica"  on public.registros for select using (true);
create policy "editores inserem" on public.registros for insert to authenticated with check (public.is_editor());
create policy "editores alteram" on public.registros for update to authenticated using (public.is_editor()) with check (public.is_editor());
create policy "editores excluem" on public.registros for delete to authenticated using (public.is_editor());

-- atualizações ao vivo
do $$
begin
  alter publication supabase_realtime add table public.registros;
exception when duplicate_object then null;
end $$;

-- Cadastre quem pode editar (o mesmo e-mail do usuário criado em Authentication → Users):
-- insert into public.editores (email) values ('seu-email@exemplo.com');
