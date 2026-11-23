#!/usr/bin/env bash
# Publica o painel da Saah Confeiteira nos dois lugares:
#   1) este repositório (DashboardsForAll/saah-confeiteira) — fonte do código; o endereço do GitHub encaminha para o oficial
#   2) a pasta saah-confeiteira/ do site (DashboardsForAll/dashboardsforall-site) — endereço oficial:
#      https://www.dashboardsforall.com.br/saah-confeiteira/
# Uso: ./publicar.sh "mensagem do commit"
set -euo pipefail

MSG="${1:?Informe a mensagem do commit}"
AQUI="$(cd "$(dirname "$0")" && pwd)"
SITE="$AQUI/../dashboardsforall-site-repo"
DESTINO="$SITE/saah-confeiteira"
ARQUIVOS=(index.html styles.css app.js config.js logo-saah.jpg)

# 1) repositório do painel
cd "$AQUI"
git add -A
git diff --cached --quiet || git commit -q -m "$MSG"
git push -q

# 2) cópia no site
cd "$SITE"
git pull -q --ff-only
mkdir -p "$DESTINO"
for f in "${ARQUIVOS[@]}"; do cp "$AQUI/$f" "$DESTINO/$f"; done
git add saah-confeiteira
if git diff --cached --quiet; then
  echo "Site já estava atualizado."
else
  git -c user.name="DashboardsForAll" -c user.email="$(git log -1 --format=%ae)" commit -q -m "Painel Saah Confeiteira: $MSG"
  git push -q
fi
echo "Publicado: https://www.dashboardsforall.com.br/saah-confeiteira/"
