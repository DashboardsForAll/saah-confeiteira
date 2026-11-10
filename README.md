# Saah Confeiteira · Painel de Gestão

Painel da confeitaria: cardápio (receitas), produtos prontos, vendas e encomendas, estoque de ingredientes com custo médio ponderado, custos de produção e controle financeiro.

Site estático (HTML, CSS e JavaScript, sem build), publicado pelo GitHub Pages. Cada alteração enviada para a branch `main` entra no ar automaticamente.

## Onde ficam os dados

| Onde o painel é aberto | Dados |
| --- | --- |
| Site publicado com `config.js` preenchido | Banco Supabase compartilhado: todos veem, só quem faz login edita |
| `config.js` vazio, ou o arquivo aberto no computador | `localStorage` do navegador |
| Versão publicada no claude.ai (`artifact.html`) | Banco do próprio claude.ai |

## Configurar o Supabase

1. Crie um projeto em [supabase.com](https://supabase.com).
2. No **SQL Editor**, rode `supabase/setup.sql`.
3. Em **Authentication → Users**, crie o usuário que vai editar (e-mail e senha). Em **Authentication → Sign In / Providers**, desligue "Allow new users to sign up".
4. Cadastre esse e-mail como editor: `insert into public.editores (email) values ('seu-email@exemplo.com');`
5. Em **Project Settings → API**, copie a *Project URL* e a chave *anon/publishable* para `config.js`.

## Arquivos

- `index.html`: página do site
- `styles.css`: estilos (cores iguais à versão original)
- `app.js`: regras de negócio e telas
- `config.js`: conexão com o Supabase
- `supabase/setup.sql`: tabelas e regras de acesso do banco
- `artifact.html`: versão publicada no claude.ai
