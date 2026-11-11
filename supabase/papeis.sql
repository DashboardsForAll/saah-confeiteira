-- Papéis de acesso (rodar depois de setup.sql).
--   admin   : acesso total (inclui excluir qualquer registro, restaurar/importar dados e gerenciar acessos)
--   cliente : usa o painel no dia a dia (lança e edita tudo; só exclui vendas)

alter table public.editores add column if not exists papel text not null default 'cliente';
alter table public.editores drop constraint if exists editores_papel_check;
alter table public.editores add constraint editores_papel_check check (papel in ('admin', 'cliente'));

create or replace function public.meu_papel()
returns text
language sql
stable
security definer
set search_path = public
as $$
  select papel from public.editores
  where lower(email) = lower(coalesce(auth.jwt() ->> 'email', ''))
  limit 1;
$$;

create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(public.meu_papel() = 'admin', false);
$$;

-- exclusão: admin exclui tudo; cliente só vendas
drop policy if exists "editores excluem" on public.registros;
create policy "editores excluem" on public.registros for delete to authenticated
  using (public.is_admin() or (public.is_editor() and colecao = 'vendas'));

-- tabela de acessos: cada pessoa vê o próprio papel; admin gerencia todos
drop policy if exists "ver proprio acesso" on public.editores;
drop policy if exists "admin gerencia acessos" on public.editores;
create policy "ver proprio acesso" on public.editores for select to authenticated
  using (lower(email) = lower(coalesce(auth.jwt() ->> 'email', '')) or public.is_admin());
create policy "admin gerencia acessos" on public.editores for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

-- emails sempre em minúsculas
create or replace function public.editores_normaliza() returns trigger
language plpgsql as $$
begin
  new.email := lower(trim(new.email));
  return new;
end $$;
drop trigger if exists editores_normaliza on public.editores;
create trigger editores_normaliza before insert or update on public.editores
  for each row execute function public.editores_normaliza();

-- primeiro administrador:
-- update public.editores set papel = 'admin' where email = 'seu-email@exemplo.com';
