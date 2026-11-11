'use strict';

/* =========================================================
   Saah Confeiteira — Painel de Gestão
   Dados em localStorage. Estoque de ingredientes calculado
   por movimentações (compras − baixas) com custo médio ponderado.
   ========================================================= */

const KEY = 'saah-confeiteira-v1';
const PHOTO_KEY = 'saah-confeiteira-foto';
const ALIASES = { 'leite ninho': 'leite em po' }; // nomes de receita que usam outro item do estoque

/* ---------- utilidades ---------- */
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const pad = n => String(n).padStart(2, '0');
const isoDate = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const hoje = () => isoDate(new Date());
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const norm = s => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
const ingKey = name => { const n = norm(name); return ALIASES[n] || n; };
const EPS = 1e-9;

function num(v) {
  if (typeof v === 'number') return v;
  if (v == null || v === '') return NaN;
  let s = String(v).trim().replace(/\s/g, '').replace(/^R\$/i, '');
  if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
  return parseFloat(s);
}
const fmtNum = n => (isFinite(n) ? n.toLocaleString('pt-BR', { maximumFractionDigits: 2 }) : '—');
const brl = n => (isFinite(n) ? n.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }) : '—');
const pct = n => (isFinite(n) ? n.toLocaleString('pt-BR', { maximumFractionDigits: 1 }) + '%' : '—');
const fmtDate = iso => (iso ? iso.split('-').reverse().join('/') : '—');
/* Encomendas: ingredientes baixados no dia anterior à entrega */
function diaAnterior(iso) {
  if (!iso) return '';
  const [y, m, d] = iso.split('-').map(Number);
  return isoDate(new Date(y, m - 1, d - 1));
}
const round2 = n => Math.round(n * 100) / 100;
/* Encomenda só vale (baixa ingredientes, conta como confirmada) depois da entrada paga */
const encomendaValidada = v => v.tipo !== 'encomenda' || !!v.entradaPaga || v.status === 'entregue';
/* Quanto ainda falta receber de uma venda pendente */
const aReceber = v => (v.status === 'entregue' ? 0 : num(v.valor) - (v.tipo === 'encomenda' && v.entradaPaga ? num(v.entrada) || 0 : 0));
const inputNum = n => (n == null || n === '' || !isFinite(n) ? '' : String(n).replace('.', ','));
function fmtLong(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('pt-BR', { day: 'numeric', month: 'long' });
}
const sum = (arr, f) => arr.reduce((a, x) => a + (f(x) || 0), 0);

/* ---------- vendas: plataforma e pagamento ---------- */
const PLATAFORMAS = ['Presencial', 'WhatsApp', 'iFood'];
const PAGAMENTOS = ['Dinheiro', 'Pix', 'Crédito', 'Débito', 'Vale-alimentação', 'Vale-refeição'];
const BANDEIRAS_CARTAO = ['Visa', 'Mastercard', 'Elo', 'American Express', 'Hipercard'];
const BANDEIRAS_VALE = ['Alelo', 'Pluxee (Sodexo)', 'Ticket', 'VR', 'Ben', 'Flash', 'Caju', 'Swile'];
const bandeirasDe = pg => (pg === 'Crédito' || pg === 'Débito' ? BANDEIRAS_CARTAO : /^Vale/.test(pg || '') ? BANDEIRAS_VALE : []);
const pagamentoLabel = v => (v.pagamento ? v.pagamento + (v.bandeira ? ` · ${v.bandeira}` : '') : '—');
const plural = (n, s, p) => (Math.abs(n - 1) < EPS ? s : p);
const unidadeLabel = (u, n) => (u === 'fatia' ? plural(n, 'fatia', 'fatias') : plural(n, 'bolo', 'bolos'));

/* ---------- unidades ---------- */
const UNITS = {
  un: { fam: 'un', f: 1 },
  ml: { fam: 'vol', f: 1 }, l: { fam: 'vol', f: 1000 },
  xicara: { fam: 'vol', f: 240 }, csopa: { fam: 'vol', f: 15 }, ccha: { fam: 'vol', f: 5 },
  g: { fam: 'massa', f: 1 }, kg: { fam: 'massa', f: 1000 },
  caixa: { fam: 'caixa', f: 1 }, lata: { fam: 'lata', f: 1 }, pacote: { fam: 'pacote', f: 1 },
};
function unitKey(m) {
  const s = norm(m).replace(/\./g, '');
  if (/^(u|un|und|unid|unidades?)$/.test(s)) return 'un';
  if (/^(ml|mililitros?)$/.test(s)) return 'ml';
  if (/^(l|lt|lts|litros?)$/.test(s)) return 'l';
  if (/^(g|gr|gramas?)$/.test(s)) return 'g';
  if (/^(kg|kgs|quilos?|quilogramas?)$/.test(s)) return 'kg';
  if (/^xic/.test(s)) return 'xicara';
  if (/^(colher(es)?( de)? sopa|cs|csopa)$/.test(s)) return 'csopa';
  if (/^(colher(es)?( de)? cha|cc|ccha)$/.test(s)) return 'ccha';
  if (/^caixa/.test(s)) return 'caixa';
  if (/^lata/.test(s)) return 'lata';
  if (/^(pacote|pct)/.test(s)) return 'pacote';
  return s.replace(/s$/, '');
}
function convert(q, from, to) {
  if (from === to) return q;
  const a = UNITS[from], b = UNITS[to];
  if (!a || !b || a.fam !== b.fam) return null;
  return (q * a.f) / b.f;
}

/* ---------- dados ---------- */
function seed() {
  const d = hoje();
  const compra = (ingrediente, quantidade, medida, valor) => ({ id: uid(), ingrediente, quantidade, medida, valor, data: d });
  const massa = () => [
    { qtd: 3, medida: 'unidade', ingrediente: 'Ovo' },
    { qtd: 4, medida: 'xícara', ingrediente: 'Farinha de trigo' },
    { qtd: 1, medida: 'xícara', ingrediente: 'Açúcar' },
    { qtd: 150, medida: 'ml', ingrediente: 'Água' },
    { qtd: 2, medida: 'colher sopa', ingrediente: 'Óleo' },
    { qtd: 5, medida: 'ml', ingrediente: 'Essência de baunilha' },
    { qtd: 0.5, medida: 'colher sopa', ingrediente: 'Fermento' },
  ];
  return {
    receitas: [
      { id: uid(), nome: 'Bolo Brigadeiro', rendimento: 2, partes: [
        { nome: 'Massa', itens: massa() },
        { nome: 'Recheio', itens: [
          { qtd: 1, medida: 'caixa', ingrediente: 'Leite condensado' },
          { qtd: 2, medida: 'caixa', ingrediente: 'Creme de leite' },
          { qtd: 2, medida: 'colher sopa', ingrediente: 'Chocolate em pó 55%' },
        ] },
      ] },
      { id: uid(), nome: 'Bolo Brigadeiro de Ninho', rendimento: 2, partes: [
        { nome: 'Massa', itens: massa() },
        { nome: 'Recheio', itens: [
          { qtd: 1, medida: 'caixa', ingrediente: 'Leite condensado' },
          { qtd: 2, medida: 'caixa', ingrediente: 'Creme de leite' },
          { qtd: 2, medida: 'colher sopa', ingrediente: 'Leite Ninho' },
        ] },
      ] },
    ],
    compras: [
      compra('Ovo', 60, 'Unidades', 36),
      compra('Açucar', 80, 'Xícaras', 45),
      compra('Água', 10, 'litros', 5),
      compra('Óleo', 200, 'colher sopa', 21),
      compra('Fermento', 25, 'colher sopa', 12),
      compra('Leite Condensado', 12, 'caixas', 35),
      compra('Creme de leite', 12, 'caixas', 30),
      compra('Chocolate em Pó 55%', 200, 'colher sopa', 41),
      compra('Leite em Pó', 81, 'colher sopa', 52),
      compra('Essência de baunilha', 30, 'ml', 8),
    ],
    produtos: [],
    vendas: [],
  };
}
/* ---------- armazenamento ----------
   Publicado no claude.ai: banco compartilhado (capability `db`), um documento por registro
   em receitas/, compras/, produtos/, vendas/ e a foto em config/perfil.
   Fora do claude.ai (ou sem login): localStorage deste navegador. */
const COLS = ['receitas', 'compras', 'produtos', 'vendas'];
let db = { receitas: [], compras: [], produtos: [], vendas: [] };
const sync = { mode: 'local', store: null, synced: {}, chains: {}, loaded: false, readonly: false, status: 'Carregando dados…', foto: null, pendingRender: false };

/* JSON com chaves ordenadas, para comparar registros sem depender da ordem dos campos */
function canon(v) {
  if (Array.isArray(v)) return '[' + v.map(canon).join(',') + ']';
  if (v && typeof v === 'object') return '{' + Object.keys(v).filter(k => v[k] !== undefined).sort().map(k => JSON.stringify(k) + ':' + canon(v[k])).join(',') + '}';
  return JSON.stringify(v === undefined ? null : v);
}
function loadLocal() {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const d = JSON.parse(raw);
      return { receitas: d.receitas || [], compras: d.compras || [], produtos: d.produtos || [], vendas: d.vendas || [] };
    }
  } catch (e) { /* sem storage */ }
  return seed();
}
function saveLocal() { try { localStorage.setItem(KEY, JSON.stringify(db)); } catch (e) { /* ignore */ } }
function save() {
  if (sync.mode !== 'db') return saveLocal();
  if (sync.readonly) { toast('Você tem acesso só para visualizar. As alterações não foram salvas.', true); return; }
  for (const col of COLS) {
    const seen = new Set();
    for (const rec of db[col]) {
      const key = `${col}/${rec.id}`;
      seen.add(key);
      const c = canon(rec);
      if (sync.synced[key] !== c) { sync.synced[key] = c; writeDoc(key, JSON.parse(JSON.stringify(rec))); }
    }
    Object.keys(sync.synced).forEach(key => {
      if (key.startsWith(col + '/') && !seen.has(key)) { delete sync.synced[key]; writeDoc(key, null); }
    });
  }
}
/* Uma escrita por vez em cada documento; uma nova tentativa em falha transitória */
function writeDoc(key, data) {
  const ref = sync.store.doc(key);
  const op = () => (data ? ref.set(data) : ref.delete());
  const run = () => op().catch(e => (e && e.code === 'unavailable'
    ? new Promise(r => setTimeout(r, 600 + Math.random() * 800)).then(op) : Promise.reject(e)));
  sync.chains[key] = (sync.chains[key] || Promise.resolve()).then(run).catch(onWriteError);
}
function onWriteError(e) {
  const code = e && e.code;
  if (code === 'invalid_argument') { setReadonly(true); toast('Você tem acesso só para visualizar. As alterações não foram salvas.', true); }
  else if (code === 'quota_exceeded') toast('O espaço de dados está cheio. Exclua vendas ou compras antigas para continuar.', true);
  else if (code === 'revoked' || code === 'not_granted') toast('O acesso aos dados foi encerrado. Recarregue a página.', true);
  else toast('Não foi possível salvar agora. Verifique a conexão e tente de novo.', true);
}
function setReadonly(v) {
  sync.readonly = v;
  document.body.classList.toggle('readonly', v);
  if (v) {
    sync.status = sync.kind === 'supabase'
      ? (sync.session ? 'Somente visualização: este e-mail ainda não tem acesso. Peça ao administrador para liberar em Acessos.' : 'Somente visualização. Entre para lançar dados.')
      : 'Somente visualização: peça acesso de edição à dona do painel para lançar dados.';
    renderFooter();
  }
}
const FOTO_PADRAO = 'foto-saah.jpg';
function getPhoto() {
  if (sync.mode === 'db') return sync.foto || FOTO_PADRAO;
  try { return localStorage.getItem(PHOTO_KEY) || FOTO_PADRAO; } catch (e) { return FOTO_PADRAO; }
}
function setPhoto(url) {
  if (sync.mode === 'db') {
    if (sync.readonly) return toast('Você tem acesso só para visualizar.', true);
    sync.foto = url; writeDoc('config/perfil', { foto: url });
  } else {
    try { localStorage.setItem(PHOTO_KEY, url); } catch (err) { toast('Não foi possível salvar a foto.', true); }
  }
}
/* Re-render vindo de outra pessoa/aba sem tirar o foco de quem está digitando */
function scheduleRender() {
  const a = document.activeElement;
  const typing = a && (a.matches('input, textarea, select')) && (a.closest('#app') || a.closest('.modal-backdrop'));
  if (typing || document.querySelector('.modal-backdrop')) { sync.pendingRender = true; return; }
  render();
}
document.addEventListener('focusout', () => setTimeout(() => {
  if (sync.pendingRender && !document.querySelector('.modal-backdrop')) {
    const a = document.activeElement;
    if (!(a && a.matches('input, textarea, select') && a.closest('#app'))) { sync.pendingRender = false; render(); }
  }
}, 0));

function startLocal(msg) {
  sync.mode = 'local';
  db = loadLocal(); saveLocal();
  sync.loaded = true;
  sync.status = msg || 'Dados salvos neste navegador.';
  render();
}
/* Onde ficam os dados:
   - dentro do claude.ai: banco do artifact (window.claude.use('db'))
   - site publicado (GitHub Pages) com config.js preenchido: Supabase
   - qualquer outro caso: localStorage */
async function initStore() {
  if (window.claude && typeof window.claude.use === 'function') return initClaude();
  const cfg = window.SAAH_SUPABASE;
  if (cfg && cfg.url && cfg.anonKey && window.supabase && window.supabase.createClient) return initSupabase(cfg);
  return startLocal();
}
async function initClaude() {
  render();
  let store = null, user = null;
  try { [store, user] = await Promise.all([window.claude.use('db'), window.claude.use('user')]); } catch (e) { /* sem capability */ }
  if (!store) return startLocal('Dados salvos só neste navegador. Entre na sua conta claude.ai para usar os dados compartilhados.');
  sync.mode = 'db'; sync.kind = 'claude'; sync.store = store;
  if (user) {
    try { if ((await user.can('data.write')) === false) setReadonly(true); } catch (e) { /* sem informação: mantém edição */ }
  }
  attachStore(store);
}
async function initSupabase(cfg) {
  const client = window.supabase.createClient(cfg.url, cfg.anonKey);
  sync.mode = 'db'; sync.kind = 'supabase'; sync.supa = client;
  sync.store = supabaseStore(client);
  let session = null;
  try { session = (await client.auth.getSession()).data.session; } catch (e) { /* sem sessão */ }
  sync.session = session;
  await aplicarSessao();
  client.auth.onAuthStateChange((evt, s) => {
    if (evt === 'PASSWORD_RECOVERY') setTimeout(() => ACTIONS['nova-senha'](), 0);
    const antes = sync.session && sync.session.user && sync.session.user.email;
    const depois = s && s.user && s.user.email;
    sync.session = s;
    if (antes !== depois) setTimeout(() => aplicarSessao().then(render), 0);
  });
  render();
  attachStore(sync.store);
}
/* Papel do usuário logado: 'admin' (acesso total), 'cliente' (dia a dia) ou null (só visualiza) */
async function aplicarSessao() {
  sync.papel = null; sync.acessos = null;
  const email = sync.session && sync.session.user && (sync.session.user.email || '').toLowerCase();
  if (email) {
    try {
      const { data } = await sync.supa.from('editores').select('papel').eq('email', email).maybeSingle();
      sync.papel = data ? data.papel : null;
    } catch (e) { sync.papel = null; }
  }
  document.body.classList.toggle('papel-admin', sync.papel === 'admin');
  document.body.classList.toggle('papel-cliente', sync.papel === 'cliente');
  setReadonly(!sync.papel);
  if (sync.papel && sync.loaded) sync.status = STATUS_OK.supabase;
  if (sync.papel === 'admin') await carregarAcessos();
}
async function carregarAcessos() {
  const { data, error } = await sync.supa.from('editores').select('email,papel').order('email');
  sync.acessos = error ? [] : data;
}
const PAPEL_LABEL = { admin: 'Administrador', cliente: 'Cliente' };
const STATUS_OK = {
  claude: 'Dados compartilhados: salvos no claude.ai e atualizados ao vivo.',
  supabase: 'Dados compartilhados: salvos online e atualizados ao vivo.',
};
/* Adaptador Supabase com a mesma interface usada do banco do claude.ai:
   doc(caminho).set/delete/onSnapshot e collection(nome).onSnapshot.
   Tabela: registros (colecao, id, dados jsonb) — ver supabase/setup.sql. */
function supabaseStore(client) {
  const cache = {};            // colecao -> Map(id -> dados)
  const colListeners = {};     // colecao -> [fn]
  const docListeners = {};     // "colecao/id" -> [fn]
  const errListeners = [];
  let loaded = false, started = false;
  const meta = { fromCache: false, hasPendingWrites: false };
  const toErr = e => ({
    code: e && (e.code === '42501' || /row-level security|permission|not allowed|JWT/i.test(e.message || '')) ? 'invalid_argument' : 'unavailable',
    message: (e && e.message) || 'erro',
  });
  const docSnap = (col, id) => { const d = cache[col] && cache[col].get(id); return { id, exists: !!d, data: () => d, metadata: meta }; };
  const colSnap = col => {
    const m = cache[col] || new Map();
    const docs = [...m.keys()].sort().map(id => docSnap(col, id));
    return { docs, size: docs.length, empty: !docs.length, metadata: meta, docChanges: () => [] };
  };
  const emit = col => {
    if (!loaded) return;
    (colListeners[col] || []).forEach(fn => fn(colSnap(col)));
    Object.keys(docListeners).forEach(k => {
      if (k.startsWith(col + '/')) docListeners[k].forEach(fn => fn(docSnap(col, k.slice(col.length + 1))));
    });
  };
  const emitAll = () => {
    const cols = new Set([...Object.keys(colListeners), ...Object.keys(docListeners).map(k => k.split('/')[0])]);
    cols.forEach(emit);
  };
  async function loadAll() {
    const rows = [];
    for (let from = 0; ; from += 1000) {
      const { data, error } = await client.from('registros').select('colecao,id,dados').range(from, from + 999);
      if (error) throw error;
      rows.push(...data);
      if (data.length < 1000) break;
    }
    Object.keys(cache).forEach(k => cache[k].clear());
    rows.forEach(r => { (cache[r.colecao] ||= new Map()).set(r.id, r.dados); });
    loaded = true;
    emitAll();
  }
  function start() {
    if (started) return;
    started = true;
    loadAll().catch(e => errListeners.forEach(fn => fn(toErr(e))));
    client.channel('registros-mudancas')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'registros' }, p => {
        const r = p.eventType === 'DELETE' ? p.old : p.new;
        if (!r || !r.colecao) return;
        if (p.eventType === 'DELETE') { if (cache[r.colecao]) cache[r.colecao].delete(r.id); }
        else (cache[r.colecao] ||= new Map()).set(r.id, r.dados);
        emit(r.colecao);
      })
      .subscribe();
    // garante atualização mesmo se o tempo real estiver desligado no projeto
    window.addEventListener('focus', () => loadAll().catch(() => {}));
    setInterval(() => { if (document.visibilityState === 'visible') loadAll().catch(() => {}); }, 60000);
  }
  return {
    doc(key) {
      const [col, id] = key.split('/');
      return {
        async set(data) {
          const { error } = await client.from('registros').upsert({ colecao: col, id, dados: data, updated_at: new Date().toISOString() });
          if (error) throw toErr(error);
          (cache[col] ||= new Map()).set(id, data);
          emit(col);
        },
        async delete() {
          const { data, error } = await client.from('registros').delete().match({ colecao: col, id }).select('id');
          if (error) throw toErr(error);
          if (!data.length && cache[col] && cache[col].has(id)) throw { code: 'invalid_argument', message: 'sem permissão' };
          if (cache[col]) cache[col].delete(id);
          emit(col);
        },
        onSnapshot(fn, err) {
          (docListeners[key] ||= []).push(fn);
          if (err) errListeners.push(err);
          start();
          if (loaded) fn(docSnap(col, id));
          return () => {};
        },
      };
    },
    collection(col) {
      return {
        onSnapshot(fn, err) {
          (colListeners[col] ||= []).push(fn);
          if (err) errListeners.push(err);
          start();
          if (loaded) fn(colSnap(col));
          return () => {};
        },
      };
    },
  };
}
function attachStore(store) {
  const done = new Set();
  const timer = setTimeout(() => {
    if (!sync.loaded) { sync.status = 'Os dados ainda não carregaram. Verifique a conexão; o que aparece pode estar desatualizado.'; renderFooter(); }
  }, 10000);
  const finish = () => {
    if (sync.loaded || done.size < COLS.length + 1) return;
    sync.loaded = true; clearTimeout(timer);
    if (!sync.readonly) sync.status = STATUS_OK[sync.kind] || STATUS_OK.claude;
  };
  const fail = () => { clearTimeout(timer); sync.status = 'Não foi possível carregar os dados compartilhados. Recarregue a página.'; renderFooter(); };
  COLS.forEach(col => {
    store.collection(col).onSnapshot(snap => {
      db[col] = snap.docs.map(d => JSON.parse(JSON.stringify(d.data())));
      const ids = new Set(snap.docs.map(d => `${col}/${d.id}`));
      Object.keys(sync.synced).forEach(k => { if (k.startsWith(col + '/') && !ids.has(k)) delete sync.synced[k]; });
      db[col].forEach(r => { sync.synced[`${col}/${r.id}`] = canon(r); });
      if (!snap.metadata.fromCache) done.add(col);
      finish(); scheduleRender();
    }, fail);
  });
  store.doc('config/perfil').onSnapshot(snap => {
    sync.foto = snap.exists ? snap.data().foto || null : null;
    if (!snap.metadata.fromCache) done.add('config');
    finish(); scheduleRender();
  }, fail);
}

/* ---------- regras de negócio ---------- */
const recipeById = id => db.receitas.find(r => r.id === id);
const productById = id => db.produtos.find(p => p.id === id);
const recipeItems = rec => (rec ? rec.partes.flatMap(p => p.itens) : []);
const snapshotOf = rec => ({ nome: rec.nome, rendimento: rec.rendimento, itens: JSON.parse(JSON.stringify(recipeItems(rec))) });
function factorOf(snap, peso, qtd) {
  const r = num(snap?.rendimento), p = num(peso), q = num(qtd);
  return (r > 0 && p > 0 ? p / r : 1) * (q > 0 ? q : 1);
}

/* Eventos de consumo: produção de produtos e encomendas entregues */
function consumptionEvents(opts = {}) {
  const ev = [];
  db.produtos.forEach(p => {
    if (p.id === opts.excludeProd || !p.snapshot) return;
    ev.push({ tipo: 'consumo', data: p.data, seq: p.seq || 0, ord: 1, ref: 'p:' + p.id, origem: `Produção · ${p.snapshot.nome}`, itens: p.snapshot.itens, fator: factorOf(p.snapshot, p.peso, p.quantidade) });
  });
  db.vendas.forEach(v => {
    if (v.tipo !== 'encomenda' || !encomendaValidada(v) || !v.snapshot) return;
    ev.push({ tipo: 'consumo', data: v.dataBaixa || diaAnterior(v.dataEntrega), seq: v.seqBaixa || 0, ord: 1, ref: 'v:' + v.id, origem: `Encomenda · ${v.snapshot.nome}${v.cliente ? ' (' + v.cliente + ')' : ''}`, itens: v.snapshot.itens, fator: factorOf(v.snapshot, v.peso, v.qtd) });
  });
  return ev;
}

/* Razão do estoque: replay cronológico com custo médio ponderado móvel */
function computeLedger(opts = {}) {
  const ings = new Map();
  const warnings = [];
  const custoRef = {};
  const get = (name, medida) => {
    const k = ingKey(name);
    if (!ings.has(k)) ings.set(k, { key: k, nome: String(name).trim(), unit: unitKey(medida), medida: String(medida || '').trim(), comprado: 0, valorComprado: 0, usado: 0, valorUsado: 0, saldo: 0, avg: 0, compras: 0, movs: [] });
    return ings.get(k);
  };
  const comprasOrd = [...db.compras].sort((a, b) => (a.data < b.data ? -1 : a.data > b.data ? 1 : 0));
  comprasOrd.forEach(c => get(c.ingrediente, c.medida)); // unidade do estoque = da primeira compra

  // ordem: data; no mesmo dia, a ordem em que os lançamentos foram feitos
  const events = [...comprasOrd.map(c => ({ tipo: 'compra', data: c.data, seq: c.seq || 0, ord: 0, c })), ...consumptionEvents(opts)];
  events.sort((a, b) => (a.data < b.data ? -1 : a.data > b.data ? 1 : (a.seq - b.seq) || (a.ord - b.ord)));

  for (const e of events) {
    if (e.tipo === 'compra') {
      const c = e.c, ing = get(c.ingrediente, c.medida);
      const q = convert(num(c.quantidade), unitKey(c.medida), ing.unit);
      const valor = num(c.valor) || 0;
      if (q == null || !(q > 0)) { warnings.push(`Compra de ${c.ingrediente} em "${c.medida}" não converte para "${ing.medida}".`); continue; }
      const base = Math.max(ing.saldo, 0);
      const avgAntes = ing.avg;
      ing.avg = (base * ing.avg + valor) / (base + q);
      ing.saldo += q; ing.comprado += q; ing.valorComprado += valor; ing.compras++;
      ing.movs.push({ tipo: 'entrada', data: c.data, qtd: q, valor, custoUnit: valor / q, avgAntes, avgDepois: ing.avg, saldo: ing.saldo, origem: 'Compra', compraId: c.id });
    } else {
      for (const it of e.itens) {
        if (!it.ingrediente) continue;
        const ing = get(it.ingrediente, it.medida);
        const q = convert(num(it.qtd) * e.fator, unitKey(it.medida), ing.unit);
        if (q == null || !isFinite(q)) { warnings.push(`${it.ingrediente}: "${it.medida}" não converte para "${ing.medida}" (${e.origem}).`); continue; }
        const custo = q * ing.avg;
        ing.saldo -= q; ing.usado += q; ing.valorUsado += custo;
        custoRef[e.ref] = (custoRef[e.ref] || 0) + custo;
        ing.movs.push({ tipo: 'saida', data: e.data, qtd: q, valor: custo, saldo: ing.saldo, origem: e.origem, ingNome: ing.nome });
      }
    }
  }
  db.receitas.forEach(r => recipeItems(r).forEach(it => { if (it.ingrediente && !ings.has(ingKey(it.ingrediente))) get(it.ingrediente, it.medida); }));
  return { ings, warnings, custoRef };
}

function itemCost(it, L, fator = 1) {
  const ing = L.ings.get(ingKey(it.ingrediente));
  if (!ing || !ing.compras) return { status: 'sem' };
  const q = convert(num(it.qtd) * fator, unitKey(it.medida), ing.unit);
  if (q == null || !isFinite(q)) return { status: 'unid', ing };
  return { status: 'ok', valor: q * ing.avg, q, ing };
}
function itemsCost(itens, L, fator = 1) {
  let total = 0, faltando = 0;
  itens.forEach(it => { const c = itemCost(it, L, fator); if (c.status === 'ok') total += c.valor; else faltando++; });
  return { total, faltando };
}
/* Ingredientes que ficariam negativos ao produzir */
function shortages(itens, fator, L) {
  const need = new Map();
  itens.forEach(it => {
    if (!it.ingrediente) return;
    const k = ingKey(it.ingrediente);
    const ing = L.ings.get(k);
    const unit = ing ? ing.unit : unitKey(it.medida);
    const q = convert(num(it.qtd) * fator, unitKey(it.medida), unit);
    if (q == null || !isFinite(q)) return;
    const cur = need.get(k) || { nome: ing ? ing.nome : it.ingrediente, medida: ing ? ing.medida : it.medida, q: 0, saldo: ing ? ing.saldo : 0 };
    cur.q += q; need.set(k, cur);
  });
  return [...need.values()].filter(n => n.q - n.saldo > EPS);
}

function prodInfo(p, L) {
  const porUn = p.porFatias ? num(p.fatias) || 1 : 1;
  const total = (num(p.quantidade) || 0) * porUn;
  const vs = db.vendas.filter(v => v.tipo === 'estoque' && v.produtoId === p.id);
  const vendido = sum(vs.filter(v => v.status === 'entregue'), v => num(v.qtd));
  const reservado = sum(vs.filter(v => v.status !== 'entregue'), v => num(v.qtd));
  const unidade = p.porFatias ? 'fatia' : 'bolo';
  const preco = p.porFatias ? num(p.valorFatia) : num(p.valor);
  const custoTotal = L.custoRef['p:' + p.id] ?? itemsCost(p.snapshot?.itens || [], L, factorOf(p.snapshot, p.peso, p.quantidade)).total;
  return { total, vendido, reservado, disp: total - vendido - reservado, unidade, preco, custoTotal, custoUn: total > 0 ? custoTotal / total : 0, nome: p.snapshot?.nome || '—' };
}
function saleCost(v, L) {
  if (v.tipo === 'estoque') { const p = productById(v.produtoId); return p ? prodInfo(p, L).custoUn * num(v.qtd) : 0; }
  if (v.status === 'entregue' && L.custoRef['v:' + v.id] != null) return L.custoRef['v:' + v.id];
  return itemsCost(v.snapshot?.itens || [], L, factorOf(v.snapshot, v.peso, v.qtd)).total;
}

/* ---------- estado de interface ---------- */
const now = new Date();
const ui = {
  recipeForm: null, collapsed: {},
  productForm: null, saleForm: null, compraForm: null,
  estoqueTab: 'saldo', mes: 'todos',
  cal: { y: now.getFullYear(), m: now.getMonth(), sel: hoje() },
};
function setPath(obj, path, val) {
  const ks = path.split('.');
  let o = obj;
  for (let i = 0; i < ks.length - 1; i++) o = o[ks[i]];
  o[ks[ks.length - 1]] = val;
}

/* ---------- ícones ---------- */
const ic = (p, extra = '') => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" ${extra}>${p}</svg>`;
const I = {
  plus: ic('<path d="M12 5v14M5 12h14"/>'),
  trash: ic('<path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6M10 11v6M14 11v6"/>'),
  edit: ic('<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/>'),
  up: ic('<path d="m18 15-6-6-6 6"/>'),
  down: ic('<path d="m6 9 6 6 6-6"/>'),
  left: ic('<path d="m15 18-6-6 6-6"/>'),
  right: ic('<path d="m9 18 6-6-6-6"/>'),
  bag: ic('<path d="M6 2 3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4Z"/><path d="M3 6h18M16 10a4 4 0 0 1-8 0"/>'),
  boxX: ic('<path d="M21 8 12 3 3 8v8l9 5 9-5Z"/><path d="m3 8 9 5 9-5M12 13v8"/><path d="m16 15 4 4m0-4-4 4"/>'),
  box: ic('<path d="M21 8 12 3 3 8v8l9 5 9-5Z"/><path d="m3 8 9 5 9-5M12 13v8"/>'),
  cal: ic('<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18M8 14h.01M12 14h.01M16 14h.01M8 18h.01M12 18h.01"/>'),
  chef: ic('<path d="M6 13.9A4 4 0 0 1 7 6a5 5 0 0 1 10 0 4 4 0 0 1 1 7.9V21H6Z"/><path d="M6 17h12"/>'),
  check: ic('<path d="M20 6 9 17l-5-5"/>'),
  undo: ic('<path d="M9 14 4 9l5-5"/><path d="M4 9h11a5 5 0 0 1 0 10h-1"/>'),
};

/* ---------- componentes ---------- */
const pageHead = (title, sub, action = '') => `
  <div class="page-head"><div><h1>${title}</h1><p>${sub}</p></div>${action}</div>`;
const field = (label, inner, cls = '') => `<label class="field ${cls}"><span>${label}</span>${inner}</label>`;
const inp = (bind, val, attrs = '') => `<input class="input" data-bind="${bind}" value="${esc(val)}" ${attrs}>`;
function sel(bind, val, options, attrs = '') {
  return `<select class="input" data-bind="${bind}" ${attrs}>${options.map(([v, l, dis]) => `<option value="${esc(v)}" ${v === val ? 'selected' : ''} ${dis ? 'disabled' : ''}>${esc(l)}</option>`).join('')}</select>`;
}
const chk = (bind, val, label, attrs = '') => `<label class="check"><input type="checkbox" data-bind="${bind}" ${val ? 'checked' : ''} ${attrs}> ${label}</label>`;
/* Filtro de período (mês da entrega) usado em Vendas e Controle Financeiro */
const mesLabel = ym => { const [y, m] = ym.split('-').map(Number); return new Date(y, m - 1, 1).toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' }); };
const noMes = v => ui.mes === 'todos' || String(v.dataEntrega || '').startsWith(ui.mes);
function filtroMes() {
  const meses = [...new Set(db.vendas.map(v => String(v.dataEntrega || '').slice(0, 7)).filter(m => /^\d{4}-\d{2}$/.test(m)))].sort().reverse();
  if (!meses.length) return '';
  if (ui.mes !== 'todos' && !meses.includes(ui.mes)) ui.mes = 'todos';
  return `<label class="field mes-filter"><span>Período</span>${sel('mes', ui.mes, [['todos', 'Todos os meses'], ...meses.map(m => [m, mesLabel(m)])], 'data-rerender id="filtro-mes"')}</label>`;
}
/* Quantos bolos dá para fazer com o saldo atual, e qual ingrediente limita */
function capacidade(r, L) {
  let n = Infinity, limite = null;
  const need = new Map();
  recipeItems(r).forEach(it => {
    if (!it.ingrediente) return;
    const k = ingKey(it.ingrediente), ing = L.ings.get(k);
    const unit = ing ? ing.unit : unitKey(it.medida);
    const q = convert(num(it.qtd), unitKey(it.medida), unit);
    if (q == null || !(q > 0)) return;
    need.set(k, (need.get(k) || 0) + q);
  });
  need.forEach((q, k) => {
    const ing = L.ings.get(k);
    const possivel = Math.max(ing ? ing.saldo : 0, 0) / q;
    if (possivel < n) { n = possivel; limite = ing ? ing.nome : k; }
  });
  return { n: isFinite(n) ? Math.floor(n + EPS) : 0, limite };
}
function shortageBox(list, quando) {
  if (!list.length) return '';
  return `<div class="warn-box"><b>Estoque insuficiente ${quando}:</b><ul>${list.map(s => `<li>${esc(s.nome)}: precisa ${fmtNum(s.q)} ${esc(s.medida)}, saldo ${fmtNum(Math.max(s.saldo, 0))}</li>`).join('')}</ul>O saldo ficará negativo e o item aparecerá em "Sem estoque".</div>`;
}

/* =================== INÍCIO =================== */
function viewInicio(L) {
  const disp = db.produtos.map(p => ({ p, i: prodInfo(p, L) })).filter(x => x.i.disp > EPS);
  const sem = [...L.ings.values()].filter(i => i.saldo <= EPS).sort((a, b) => a.nome.localeCompare(b.nome));
  return `
  <div class="grid grid-home">
    <section class="card">
      <h2 class="card-title">${I.bag} Produtos à venda</h2>
      ${disp.length ? `<ul class="list">${disp.map(({ p, i }) => `
        <li><div><div class="title">${esc(i.nome)}</div>
          <div class="small muted">${fmtNum(num(p.peso))} kg · ${p.porFatias ? `${fmtNum(num(p.fatias))} fatias por bolo` : 'bolo inteiro'} · produzido em ${fmtDate(p.data)}</div></div>
          <div style="text-align:right"><span class="pill ok">${fmtNum(i.disp)} ${unidadeLabel(i.unidade, i.disp)} ${plural(i.disp, 'disponível', 'disponíveis')}</span>
          <div class="small muted">${brl(i.preco)} / ${i.unidade === 'fatia' ? 'fatia' : 'bolo'}</div></div></li>`).join('')}</ul>`
        : `<p class="muted">Nenhum produto disponível. Inclua na aba <a href="#produtos">Produtos</a>.</p>`}
    </section>
    <section class="card">
      <h2 class="card-title danger">${I.boxX} Sem estoque</h2>
      ${sem.length ? `<ul class="list">${sem.map(i => `
        <li><div><div class="title">${esc(i.nome)}</div>
          <div class="small muted">${i.compras ? `Comprado ${fmtNum(i.comprado)} − usado ${fmtNum(i.usado)} ${esc(i.medida)}` : 'Nenhuma compra registrada'}</div></div>
          <span class="pill danger">${fmtNum(i.saldo)} ${esc(i.medida)}</span></li>`).join('')}</ul>`
        : `<p class="muted">Todos os ingredientes têm estoque.</p>`}
    </section>
  </div>
  ${db.receitas.length ? `<section class="card mt">
    <h2 class="card-title">${I.chef} Produção possível com o estoque atual</h2>
    <ul class="list">${db.receitas.map(r => {
      const c = capacidade(r, L);
      return `<li><div><div class="title">${esc(r.nome)}</div>
        <div class="small muted">${c.limite ? `Ingrediente que limita: ${esc(c.limite)}` : 'Receita sem ingredientes'} · ${fmtNum(num(r.rendimento))} kg por receita</div></div>
        <span class="pill ${c.n === 0 ? 'danger' : c.n <= 2 ? 'gold' : 'ok'}">${c.n === 0 ? 'Não dá para fazer' : `${c.n} ${plural(c.n, 'receita', 'receitas')}`}</span></li>`;
    }).join('')}</ul>
  </section>` : ''}
  <section class="card mt">
    <h2 class="card-title">${I.cal} Pedidos e entregas</h2>
    ${calendarHtml()}
  </section>`;
}

function orderStatus(v) {
  if (v.status === 'entregue') return ['Entregue', 'ok'];
  if (!encomendaValidada(v)) return ['Aguardando entrada', 'danger'];
  if (v.dataEntrega < hoje()) return ['Atrasada', 'danger'];
  return ['Próxima', 'gold'];
}
function orderItem(v) {
  const [st, cls] = orderStatus(v);
  return `<li><div><div class="title">${esc(v.cliente || 'Cliente')} · ${esc(v.nome)}</div>
    <div class="small muted">${fmtNum(num(v.qtd))} ${v.tipo === 'encomenda' ? unidadeLabel('bolo', num(v.qtd)) + ' · encomenda' : unidadeLabel(v.unidade, num(v.qtd)) + ' · pronta entrega'} · ${fmtDate(v.dataEntrega)}</div></div>
    <div style="text-align:right"><span class="pill ${cls}">${st}</span><div class="small muted">${brl(num(v.valor))}</div></div></li>`;
}
function calendarHtml() {
  const { y, m, sel: selDay } = ui.cal;
  const first = new Date(y, m, 1);
  const dim = new Date(y, m + 1, 0).getDate();
  const cells = Math.ceil((first.getDay() + dim) / 7) * 7;
  const start = new Date(y, m, 1 - first.getDay());
  const byDay = {};
  db.vendas.forEach(v => { (byDay[v.dataEntrega] ||= []).push(v); });
  const t = hoje();
  let days = '';
  for (let i = 0; i < cells; i++) {
    const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
    const iso = isoDate(d);
    const vs = byDay[iso] || [];
    const dots = [
      vs.some(v => v.status === 'entregue') ? '<i class="dot-done"></i>' : '',
      vs.some(v => v.status !== 'entregue' && iso >= t) ? '<i class="dot-next"></i>' : '',
      vs.some(v => v.status !== 'entregue' && iso < t) ? '<i class="dot-late"></i>' : '',
    ].join('');
    days += `<button class="cal-day ${d.getMonth() !== m ? 'out' : ''} ${iso === t ? 'today' : ''} ${iso === selDay ? 'sel' : ''}" data-action="cal-sel" data-date="${iso}">${d.getDate()}${dots ? `<span class="dots">${dots}</span>` : ''}</button>`;
  }
  const month = first.toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' });
  const doDia = (byDay[selDay] || []);
  const todos = [...db.vendas].sort((a, b) => (a.dataEntrega < b.dataEntrega ? -1 : 1));
  return `
  <div class="cal-wrap">
    <div>
      <div class="cal">
        <div class="cal-head"><button class="icon-btn" data-action="cal-move" data-d="-1" aria-label="Mês anterior">${I.left}</button>
          <span>${month.replace(' de ', ' ')}</span>
          <button class="icon-btn" data-action="cal-move" data-d="1" aria-label="Próximo mês">${I.right}</button></div>
        <div class="cal-grid">${['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sab'].map(d => `<span class="dow">${d}</span>`).join('')}${days}</div>
      </div>
      <div class="legend"><span><i class="dot-done"></i>Entregues</span><span><i class="dot-next"></i>Próximas</span><span><i class="dot-late"></i>Atrasadas</span></div>
    </div>
    <div class="day-list">
      <h4>${fmtLong(selDay)}</h4>
      ${doDia.length ? `<ul class="list">${doDia.map(orderItem).join('')}</ul>` : '<p class="muted">Nenhuma entrega neste dia.</p>'}
      <h4>Todos os pedidos</h4>
      ${todos.length ? `<ul class="list">${todos.map(orderItem).join('')}</ul>` : '<p class="muted">Nenhum pedido ainda.</p>'}
    </div>
  </div>`;
}

/* =================== CARDÁPIO =================== */
function recipeFormHtml() {
  const f = ui.recipeForm;
  return `
  <section class="card form-card ${f.id ? 'span-all' : ''}">
    <h3>${f.id ? 'Editar receita' : 'Nova receita'}</h3>
    ${inp('recipeForm.nome', f.nome, 'placeholder="Nome da receita"')}
    ${f.partes.map((p, i) => `
      <div class="part">
        <div class="part-head">${inp(`recipeForm.partes.${i}.nome`, p.nome, 'placeholder="Parte (ex.: Massa)"')}
          <button class="icon-btn danger" data-action="part-del" data-i="${i}" title="Remover parte">${I.trash}</button></div>
        <div class="ing-row head"><span>Quantidade</span><span>Medida</span><span>Ingrediente</span><span></span></div>
        ${p.itens.map((it, j) => `
          <div class="ing-row">
            ${inp(`recipeForm.partes.${i}.itens.${j}.qtd`, it.qtd, 'inputmode="decimal" placeholder="Qtd"')}
            ${inp(`recipeForm.partes.${i}.itens.${j}.medida`, it.medida, 'list="dl-medidas" placeholder="Medida"')}
            ${inp(`recipeForm.partes.${i}.itens.${j}.ingrediente`, it.ingrediente, 'list="dl-ings" placeholder="Ingrediente"')}
            <button class="icon-btn danger" data-action="item-del" data-i="${i}" data-j="${j}" title="Remover ingrediente">${I.trash}</button>
          </div>`).join('')}
        <button class="btn soft sm" data-action="item-add" data-i="${i}">${I.plus} Ingrediente</button>
      </div>`).join('')}
    <div style="margin-top:14px"><button class="btn soft sm" data-action="part-add">${I.plus} Parte da receita</button></div>
    <div class="rend">Rendimento: ${inp('recipeForm.rendimento', f.rendimento, 'inputmode="decimal"')} kg</div>
    ${f.id ? '<p class="note">As alterações valem para as próximas produções e encomendas. O que já foi produzido mantém a receita usada na época.</p>' : ''}
    <div class="form-actions">
      <button class="btn primary" data-action="recipe-save">${f.id ? 'Salvar alterações' : 'Salvar receita'}</button>
      <button class="btn ghost" data-action="recipe-cancel">Cancelar</button>
    </div>
  </section>`;
}
function recipeCard(r) {
  if (ui.recipeForm && ui.recipeForm.id === r.id) return recipeFormHtml();
  const col = ui.collapsed[r.id];
  return `
  <section class="card">
    <div class="recipe-head">
      <h2 class="card-title">${I.chef} ${esc(r.nome)}</h2>
      <div class="recipe-actions">
        <button class="btn ghost sm" data-action="recipe-edit" data-id="${r.id}">${I.edit} Editar</button>
        <button class="btn ghost sm" data-action="recipe-toggle" data-id="${r.id}">${col ? I.down + ' Expandir' : I.up + ' Recolher'}</button>
        <button class="icon-btn danger" data-action="recipe-del" data-id="${r.id}" title="Excluir receita">${I.trash}</button>
      </div>
    </div>
    ${col ? '' : r.partes.map(p => `
      <div class="part-title">${esc(p.nome)}</div>
      <div class="table-wrap"><table><thead><tr><th>Quantidade</th><th>Medida</th><th>Ingrediente</th></tr></thead>
      <tbody>${p.itens.map(it => `<tr><td>${fmtNum(num(it.qtd))}</td><td>${esc(it.medida)}</td><td>${esc(it.ingrediente)}</td></tr>`).join('')}</tbody></table></div>`).join('')}
    <div class="yield">Rendimento: <b>${fmtNum(num(r.rendimento))} kg</b></div>
  </section>`;
}
function viewCardapio() {
  const novo = ui.recipeForm && !ui.recipeForm.id;
  return pageHead('Cardápio', 'Receitas com ingredientes e rendimento.',
    novo ? '' : `<button class="btn primary" data-action="recipe-new">${I.plus} Incluir receita</button>`) +
    (novo ? recipeFormHtml() : '') +
    (db.receitas.length ? `<div class="grid grid-2 ${novo ? 'mt' : ''}">${db.receitas.map(recipeCard).join('')}</div>`
      : '<p class="empty">Nenhuma receita ainda. Clique em "Incluir receita".</p>');
}

/* =================== PRODUTOS =================== */
function productPreview() {
  const f = ui.productForm; if (!f) return '';
  const rec = recipeById(f.receitaId); if (!rec) return '';
  const L = computeLedger({ excludeProd: f.id });
  const snap = f.id && f.receitaId === productById(f.id)?.receitaId ? productById(f.id).snapshot : snapshotOf(rec);
  const fator = factorOf(snap, f.peso, f.quantidade);
  const c = itemsCost(snap.itens, L, fator);
  const q = num(f.quantidade) > 0 ? num(f.quantidade) : 1;
  const porBolo = c.total / q;
  const preco = f.porFatias ? num(f.valorFatia) * num(f.fatias) : num(f.valor);
  const margem = preco - porBolo;
  return `<div class="row"><span>Custo de produção (${fmtNum(q)} ${plural(q, 'bolo', 'bolos')})</span><b>${brl(c.total)}</b></div>
    <div class="row"><span>Custo por bolo</span><b>${brl(porBolo)}</b></div>
    ${f.porFatias && num(f.fatias) > 0 ? `<div class="row"><span>Custo por fatia</span><b>${brl(porBolo / num(f.fatias))}</b></div>` : ''}
    ${isFinite(preco) && preco > 0 ? `<div class="row"><span>Margem por bolo</span><b class="${margem < 0 ? 'warn' : ''}">${brl(margem)} (${pct((margem / preco) * 100)})</b></div>` : ''}
    ${c.faltando ? `<div class="small warn">${c.faltando} ingrediente(s) sem preço no estoque.</div>` : ''}
    ${shortageBox(shortages(snap.itens, fator, L), 'para esta produção')}`;
}
function productFormHtml() {
  const f = ui.productForm;
  return `
  <section class="card form-card">
    <h3>${f.id ? 'Editar produto' : 'Novo produto'}</h3>
    <div class="form-grid">
      ${field('Produto (do cardápio)', sel('productForm.receitaId', f.receitaId, [['', 'Selecione um item do cardápio', true], ...db.receitas.map(r => [r.id, r.nome])], 'data-rerender'))}
      ${field('Peso por bolo (kg)', inp('productForm.peso', f.peso, 'inputmode="decimal" placeholder="Ex.: 2"'))}
      ${field('Quantidade produzida (bolos)', inp('productForm.quantidade', f.quantidade, 'inputmode="decimal" placeholder="Ex.: 1"'))}
      ${field('Data da produção', inp('productForm.data', f.data, 'type="date"'))}
    </div>
    <div style="margin:16px 0 12px">${chk('productForm.porFatias', f.porFatias, 'Vender por fatias', 'data-rerender')}</div>
    <div class="form-grid">
      ${f.porFatias
        ? field('Fatias por bolo', inp('productForm.fatias', f.fatias, 'inputmode="numeric" placeholder="Ex.: 12"')) + field('Valor por fatia (R$)', inp('productForm.valorFatia', f.valorFatia, 'inputmode="decimal" placeholder="Ex.: 10,00"'))
        : field('Valor total do bolo (R$)', inp('productForm.valor', f.valor, 'inputmode="decimal" placeholder="Ex.: 80,00"'))}
    </div>
    <div class="preview" data-preview="product">${productPreview()}</div>
    <p class="note">Ao salvar, os ingredientes da receita são baixados do estoque na data da produção.</p>
    <div class="form-actions">
      <button class="btn primary" data-action="product-save">Salvar produto</button>
      <button class="btn ghost" data-action="product-cancel">Cancelar</button>
    </div>
  </section>`;
}
function viewProdutos(L) {
  const open = !!ui.productForm;
  return pageHead('Produtos', 'Itens do cardápio já feitos e disponíveis para venda.',
    open ? '' : `<button class="btn primary" data-action="product-new">${I.plus} Incluir produto</button>`) +
    (open ? productFormHtml() : '') +
    (db.produtos.length ? `<div class="grid grid-3 ${open ? 'mt' : ''}">${db.produtos.map(p => {
      const i = prodInfo(p, L);
      return `<section class="card">
        <div class="recipe-head"><h2 class="card-title">${I.bag} ${esc(i.nome)}</h2>
          <div class="recipe-actions"><button class="icon-btn" data-action="product-edit" data-id="${p.id}" title="Editar">${I.edit}</button>
          <button class="icon-btn danger" data-action="product-del" data-id="${p.id}" title="Excluir">${I.trash}</button></div></div>
        <span class="pill">${p.porFatias ? `Por fatias · ${fmtNum(num(p.fatias))} por bolo` : 'Bolo inteiro'}</span>
        <div style="margin-top:10px">
          <div class="kv"><span>Peso</span><b>${fmtNum(num(p.peso))} kg</b></div>
          <div class="kv"><span>Produzido em</span><b>${fmtDate(p.data)}</b></div>
          <div class="kv"><span>Produzidos</span><b>${fmtNum(i.total)} ${unidadeLabel(i.unidade, i.total)}</b></div>
          <div class="kv"><span>Vendidos (entregues)</span><b>${fmtNum(i.vendido)}</b></div>
          <div class="kv"><span>Reservados (a entregar)</span><b>${fmtNum(i.reservado)}</b></div>
          <div class="kv"><span>Preço</span><b>${brl(i.preco)} / ${i.unidade}</b></div>
          <div class="kv"><span>Custo (${i.unidade})</span><b>${brl(i.custoUn)}</b></div>
        </div>
        <div class="total-box"><span>Disponível</span><b>${fmtNum(i.disp)} ${unidadeLabel(i.unidade, i.disp)}</b></div>
      </section>`;
    }).join('')}</div>` : (open ? '' : '<p class="empty">Nenhum produto disponível para venda ainda. Clique em "Incluir produto" para começar.</p>'));
}

/* =================== VENDAS =================== */
function salePreview() {
  const f = ui.saleForm; if (!f || !f.encomenda) return '';
  const rec = recipeById(f.receitaId); if (!rec) return '';
  const L = computeLedger();
  const snap = snapshotOf(rec);
  const fator = factorOf(snap, f.peso, f.qtd);
  const c = itemsCost(snap.itens, L, fator);
  const v = num(f.valor);
  return `<div class="row"><span>Custo estimado dos ingredientes</span><b>${brl(c.total)}</b></div>
    ${isFinite(v) && v > 0 ? `<div class="row"><span>Lucro estimado</span><b class="${v - c.total < 0 ? 'warn' : ''}">${brl(v - c.total)} (${pct(((v - c.total) / v) * 100)})</b></div>` : ''}
    ${shortageBox(shortages(snap.itens, fator, L), 'hoje para esta encomenda')}`;
}
function saleFormHtml(L) {
  const f = ui.saleForm;
  // ao editar, a quantidade desta própria venda volta a contar como disponível
  const prods = db.produtos.map(p => {
    const i = prodInfo(p, L);
    if (f.id && f.origProdutoId === p.id) i.disp += f.origQtd || 0;
    return { p, i };
  });
  const avail = prods.filter(x => x.i.disp > EPS);
  const chosen = prods.find(x => x.p.id === f.produtoId);
  return `
  <section class="card form-card">
    <h3>${f.id ? 'Editar venda' : 'Nova venda'}</h3>
    <div style="margin-bottom:14px">${chk('saleForm.encomenda', f.encomenda, 'Ainda vai ser produzido (encomenda antecipada)', 'data-rerender')}</div>
    ${f.encomenda ? `
    <div class="form-grid">
      ${field('Produto (do cardápio)', sel('saleForm.receitaId', f.receitaId, [['', 'Selecione um item do cardápio', true], ...db.receitas.map(r => [r.id, r.nome])], 'data-rerender'))}
      ${field('Cliente', inp('saleForm.cliente', f.cliente, 'placeholder="Nome do cliente"'))}
      ${field('Peso por bolo (kg)', inp('saleForm.peso', f.peso, 'inputmode="decimal" placeholder="Ex.: 2"'))}
      ${field('Quantidade (bolos)', inp('saleForm.qtd', f.qtd, 'inputmode="decimal"'))}
      ${field('Valor da venda (R$)', inp('saleForm.valor', f.valor, 'inputmode="decimal" placeholder="Ex.: 80,00"'))}
      ${field('Data da entrega', inp('saleForm.dataEntrega', f.dataEntrega, 'type="date"'))}
      ${field('Valor de entrada (R$) · 50%', inp('saleForm.entrada', f.entrada, 'inputmode="decimal" id="sale-entrada" placeholder="Metade do valor"'))}
      ${field('Valor na retirada (R$) · 50%', inp('saleForm.retirada', f.retirada, 'inputmode="decimal" id="sale-retirada" placeholder="Metade do valor"'))}
      ${field('Baixa dos ingredientes em', `<input class="input" type="date" id="sale-baixa" value="${esc(f.dataBaixa)}" readonly tabindex="-1" title="Sempre um dia antes da entrega">`)}
    </div>
    <p class="note">Encomenda antecipada: os ingredientes são baixados do estoque sempre um dia antes da entrega. A encomenda só fica confirmada quando você marcar <b>Entrada paga</b> na lista de vendas.</p>`
    : `
    <div class="form-grid">
      ${field('Produto em estoque', sel('saleForm.produtoId', f.produtoId, avail.length
        ? [['', 'Selecione um produto', true], ...avail.map(({ p, i }) => [p.id, `${i.nome} — ${fmtNum(i.disp)} ${unidadeLabel(i.unidade, i.disp)} · ${brl(i.preco)}/${i.unidade}`])]
        : [['', 'Nenhum produto disponível', true]], 'data-rerender'))}
      ${field('Cliente', inp('saleForm.cliente', f.cliente, 'placeholder="Nome do cliente"'))}
      ${field(`Quantidade${chosen ? ` (${chosen.i.unidade === 'fatia' ? 'fatias' : 'bolos'}, máx. ${fmtNum(chosen.i.disp)})` : ''}`, inp('saleForm.qtd', f.qtd, 'inputmode="decimal"'))}
      ${field('Valor da venda (R$)', inp('saleForm.valor', f.valor, 'inputmode="decimal" placeholder="Ex.: 80,00" id="sale-valor"'))}
      ${field('Data da entrega', inp('saleForm.dataEntrega', f.dataEntrega, 'type="date"'))}
    </div>
    <p class="note">Venda de produto em estoque: a quantidade fica reservada e é baixada do produto quando você der o OK da entrega.</p>`}
    <div class="form-grid three mt">
      ${field('Plataforma de venda', sel('saleForm.plataforma', f.plataforma, PLATAFORMAS.map(p => [p, p])))}
      ${field('Forma de pagamento', sel('saleForm.pagamento', f.pagamento, PAGAMENTOS.map(p => [p, p]), 'data-rerender'))}
      ${bandeirasDe(f.pagamento).length
        ? field(/^Vale/.test(f.pagamento) ? 'Bandeira do vale' : 'Bandeira do cartão', sel('saleForm.bandeira', f.bandeira, [['', 'Selecione a bandeira', true], ...bandeirasDe(f.pagamento).map(b => [b, b])]))
        : ''}
    </div>
    <div class="preview" data-preview="sale">${salePreview()}</div>
    <div class="form-actions">
      <button class="btn primary" data-action="sale-save">${f.id ? 'Salvar alterações' : 'Salvar venda'}</button>
      <button class="btn ghost" data-action="sale-cancel">Cancelar</button>
    </div>
  </section>`;
}
function viewVendas(L) {
  const open = !!ui.saleForm;
  const doMes = db.vendas.filter(noMes);
  const vs = [...doMes].sort((a, b) => (a.status === b.status ? (a.dataEntrega < b.dataEntrega ? -1 : 1) : a.status === 'entregue' ? 1 : -1));
  const entregues = doMes.filter(v => v.status === 'entregue');
  const pend = doMes.filter(v => v.status !== 'entregue');
  return pageHead('Vendas', 'Vendas de produtos prontos e encomendas. O estoque baixa ao confirmar a entrega.',
    `<div class="head-actions">${filtroMes()}${open ? '' : `<button class="btn primary" data-action="sale-new">${I.plus} Incluir venda</button>`}</div>`) +
    (db.vendas.length ? `<div class="stats">
      <div class="stat ok"><span>Vendido (entregue)</span><b>${brl(sum(entregues, v => num(v.valor)))}</b></div>
      <div class="stat"><span>A receber (pendente)</span><b>${brl(sum(pend, aReceber))}</b></div>
      <div class="stat"><span>Encomendas aguardando entrada</span><b>${pend.filter(v => !encomendaValidada(v)).length}</b></div>
      <div class="stat"><span>Pronta entrega pendentes</span><b>${pend.filter(v => v.tipo === 'estoque').length}</b></div></div>` : '') +
    (open ? saleFormHtml(L) : '') +
    (vs.length ? `<section class="card ${open ? 'mt' : ''}"><div class="table-wrap"><table>
      <thead><tr><th>Entrega</th><th>Cliente</th><th>Produto</th><th>Tipo</th><th>Plataforma / Pagamento</th><th class="num">Qtd</th><th class="num">Valor</th><th>Status</th><th>Baixa</th><th></th></tr></thead>
      <tbody>${vs.map(v => {
        const [st, cls] = orderStatus(v);
        const baixa = v.tipo === 'encomenda'
          ? `${encomendaValidada(v) ? 'Ingredientes em' : 'Ingredientes previstos para'} ${fmtDate(v.dataBaixa || diaAnterior(v.dataEntrega))}
             <span class="sub">Entrada ${brl(num(v.entrada ?? num(v.valor) / 2))}${v.entradaPaga ? ' (paga)' : ''} · Retirada ${brl(num(v.retirada ?? num(v.valor) / 2))}</span>`
          : (v.status === 'entregue' ? `Produto em ${fmtDate(v.entregueEm)}` : '<span class="muted small">Reservado</span>');
        return `<tr>
          <td>${fmtDate(v.dataEntrega)}</td><td>${esc(v.cliente || '—')}</td><td>${esc(v.nome)}</td>
          <td><span class="pill ${v.tipo === 'encomenda' ? 'gold' : ''}">${v.tipo === 'encomenda' ? 'Encomenda' : 'Pronta entrega'}</span></td>
          <td>${esc(v.plataforma || '—')}<span class="sub">${esc(pagamentoLabel(v))}</span></td>
          <td class="num">${fmtNum(num(v.qtd))} ${v.tipo === 'encomenda' ? unidadeLabel('bolo', num(v.qtd)) : unidadeLabel(v.unidade, num(v.qtd))}</td>
          <td class="num">${brl(num(v.valor))}</td>
          <td><span class="pill ${cls}">${st}</span></td>
          <td class="small">${baixa}</td>
          <td style="white-space:nowrap">${v.status === 'entregue'
            ? `<button class="icon-btn" data-action="sale-undo" data-id="${v.id}" title="Desfazer entrega">${I.undo}</button>`
            : `${v.tipo === 'encomenda' ? `<label class="check small entrada-check" title="Marque quando a cliente pagar a entrada"><input type="checkbox" data-action="entrada-paga" data-id="${v.id}" ${v.entradaPaga ? 'checked' : ''}> Entrada paga</label>` : ''}
               <button class="btn ok sm" data-action="sale-deliver" data-id="${v.id}" ${v.tipo === 'encomenda' && !v.entradaPaga ? 'disabled title="Marque a entrada paga primeiro"' : ''}>${I.check} OK entrega</button>
               <button class="icon-btn" data-action="sale-edit" data-id="${v.id}" title="Editar venda">${I.edit}</button>`}
            <button class="icon-btn danger" data-action="sale-del" data-id="${v.id}" title="Excluir venda">${I.trash}</button></td></tr>`;
      }).join('')}</tbody></table></div></section>`
      : (open ? '' : db.vendas.length ? '<p class="empty">Nenhuma venda neste período.</p>' : '<p class="empty">Nenhuma venda ainda. Clique em "Incluir venda" para começar.</p>'));
}

/* =================== ESTOQUE =================== */
function compraPreview() {
  const f = ui.compraForm; if (!f || !f.ingrediente) return '';
  // ao editar, calcula como se a compra original não existisse
  const idx = f.id ? db.compras.findIndex(c => c.id === f.id) : -1;
  const orig = idx >= 0 ? db.compras.splice(idx, 1)[0] : null;
  try { return compraPreviewInner(f, orig); } finally { if (orig) db.compras.splice(idx, 0, orig); }
}
function compraPreviewInner(f, orig) {
  const L = computeLedger();
  const ing = L.ings.get(ingKey(f.ingrediente));
  const q0 = num(f.quantidade), v = num(f.valor);
  if (!ing || !ing.compras) return `<div class="row"><span>Novo ingrediente no estoque.</span>${q0 > 0 && v > 0 ? `<b>${brl(v / q0)} por ${esc(f.medida || 'unidade')}</b>` : ''}</div>`;
  const q = f.medida ? convert(q0, unitKey(f.medida), ing.unit) : q0;
  let out = `<div class="row"><span>Saldo atual de ${esc(ing.nome)}</span><b>${fmtNum(ing.saldo)} ${esc(ing.medida)} a ${brl(ing.avg)}</b></div>`;
  if (f.medida && q == null) return out + `<div class="small warn">A medida "${esc(f.medida)}" não converte para "${esc(ing.medida)}". Use a mesma medida do estoque.</div>`;
  if (q > 0 && v >= 0) {
    // simula a compra no razão para obter exatamente o valor que será gravado
    db.compras.push({ id: '__preview', seq: orig ? orig.seq || 0 : Date.now(), ingrediente: ing.nome, quantidade: q0, medida: f.medida || ing.medida, valor: v, data: f.data || hoje() });
    let m;
    try { m = computeLedger().ings.get(ing.key).movs.find(x => x.compraId === '__preview'); } finally { db.compras.pop(); }
    if (m) {
      const base = m.saldo - m.qtd;
      out += `<div class="row"><span>Custo desta leva</span><b>${brl(v / q)} por ${esc(ing.medida)}</b></div>
        <div class="row"><span>Novo custo médio ponderado</span><b>${brl(m.avgDepois)} por ${esc(ing.medida)}</b></div>
        <div class="small muted">(${fmtNum(Math.max(base, 0))} × ${brl(m.avgAntes)} + ${brl(v)}) ÷ ${fmtNum(Math.max(base, 0) + m.qtd)} ${esc(ing.medida)} — saldo em ${fmtDate(f.data)}</div>`;
    }
  }
  return out;
}
function compraFormHtml() {
  const f = ui.compraForm;
  return `
  <section class="card form-card">
    <h3>${f.id ? 'Editar compra' : 'Nova compra de ingrediente'}</h3>
    <div class="form-grid three">
      ${field('Ingrediente', inp('compraForm.ingrediente', f.ingrediente, 'list="dl-ings" placeholder="Ex.: Ovo"'))}
      ${field('Quantidade', inp('compraForm.quantidade', f.quantidade, 'inputmode="decimal" placeholder="Ex.: 30"'))}
      ${field('Medida', inp('compraForm.medida', f.medida, 'list="dl-medidas" placeholder="Ex.: unidades" id="compra-medida"'))}
      ${field('Valor da compra (R$)', inp('compraForm.valor', f.valor, 'inputmode="decimal" placeholder="Ex.: 18,00"'))}
      ${field('Data da compra', inp('compraForm.data', f.data, 'type="date"'))}
    </div>
    <div class="preview" data-preview="compra">${compraPreview()}</div>
    <div class="form-actions">
      <button class="btn primary" data-action="compra-save">${f.id ? 'Salvar alterações' : 'Salvar compra'}</button>
      <button class="btn ghost" data-action="compra-cancel">Cancelar</button>
    </div>
  </section>`;
}
function viewEstoque(L) {
  const open = !!ui.compraForm;
  const ings = [...L.ings.values()].sort((a, b) => a.nome.localeCompare(b.nome));
  const t = ui.estoqueTab;
  let body = '';
  if (t === 'saldo') {
    const tot = { c: sum(ings, i => i.valorComprado), u: sum(ings, i => i.valorUsado), s: sum(ings, i => Math.max(i.saldo, 0) * i.avg) };
    body = `<table><thead><tr><th>Ingrediente</th><th class="num">Comprado</th><th class="num">Consumido (baixa)</th><th class="num">Saldo</th><th class="num">Custo médio</th><th class="num">Valor em estoque</th></tr></thead>
      <tbody>${ings.map(i => `<tr class="${i.saldo <= EPS ? 'zero' : ''}">
        <td><span class="ing-name">${I.box} ${esc(i.nome)}</span>${i.compras ? '' : '<span class="sub">sem compra registrada</span>'}</td>
        <td class="num">${fmtNum(i.comprado)} ${esc(i.medida)}<span class="sub">${brl(i.valorComprado)}</span></td>
        <td class="num">${fmtNum(i.usado)} ${esc(i.medida)}<span class="sub">${brl(i.valorUsado)}</span></td>
        <td class="num"><b class="${i.saldo <= EPS ? 'warn' : ''}">${fmtNum(i.saldo)} ${esc(i.medida)}</b></td>
        <td class="num">${i.compras ? brl(i.avg) + `<span class="sub">por ${esc(i.medida)}</span>` : '—'}</td>
        <td class="num">${brl(Math.max(i.saldo, 0) * i.avg)}</td></tr>`).join('')}</tbody>
      <tfoot><tr><td>Saldo total</td><td class="num">${brl(tot.c)}</td><td class="num">${brl(tot.u)}</td><td class="num">${ings.filter(i => i.saldo > EPS).length} itens com saldo</td><td></td><td class="num">${brl(tot.s)}</td></tr></tfoot></table>`;
  } else if (t === 'compras') {
    const movs = ings.flatMap(i => i.movs.filter(m => m.tipo === 'entrada').map(m => ({ ...m, ing: i }))).sort((a, b) => (a.data < b.data ? 1 : -1));
    body = movs.length ? `<table><thead><tr><th>Data</th><th>Ingrediente</th><th class="num">Quantidade</th><th class="num">Valor da compra</th><th class="num">Custo da leva</th><th class="num">Custo médio após</th><th></th></tr></thead>
      <tbody>${movs.map(m => `<tr><td>${fmtDate(m.data)}</td><td><span class="ing-name">${I.box} ${esc(m.ing.nome)}</span></td>
        <td class="num">${fmtNum(m.qtd)} ${esc(m.ing.medida)}</td><td class="num">${brl(m.valor)}</td>
        <td class="num">${brl(m.custoUnit)}</td><td class="num">${brl(m.avgDepois)}${m.avgAntes ? `<span class="sub">antes ${brl(m.avgAntes)}</span>` : ''}</td>
        <td style="white-space:nowrap"><button class="icon-btn" data-action="compra-edit" data-id="${m.compraId}" title="Editar compra">${I.edit}</button>
          <button class="icon-btn danger" data-action="compra-del" data-id="${m.compraId}" title="Excluir compra">${I.trash}</button></td></tr>`).join('')}</tbody>
      <tfoot><tr><td colspan="3">Total comprado</td><td class="num">${brl(sum(movs, m => m.valor))}</td><td colspan="3"></td></tr></tfoot></table>`
      : '<p class="empty">Nenhuma compra registrada.</p>';
  } else {
    const movs = ings.flatMap(i => i.movs.filter(m => m.tipo === 'saida').map(m => ({ ...m, ing: i }))).sort((a, b) => (a.data < b.data ? 1 : -1));
    body = movs.length ? `<table><thead><tr><th>Data</th><th>Ingrediente</th><th class="num">Quantidade</th><th class="num">Custo (médio)</th><th>Origem</th><th class="num">Saldo após</th></tr></thead>
      <tbody>${movs.map(m => `<tr><td>${fmtDate(m.data)}</td><td><span class="ing-name">${I.box} ${esc(m.ing.nome)}</span></td>
        <td class="num">${fmtNum(m.qtd)} ${esc(m.ing.medida)}</td><td class="num">${brl(m.valor)}</td><td>${esc(m.origem)}</td>
        <td class="num ${m.saldo <= EPS ? 'warn' : ''}">${fmtNum(m.saldo)}</td></tr>`).join('')}</tbody>
      <tfoot><tr><td colspan="3">Total baixado</td><td class="num">${brl(sum(movs, m => m.valor))}</td><td colspan="2"></td></tr></tfoot></table>`
      : '<p class="empty">Nenhuma baixa ainda. As baixas acontecem ao incluir produtos e ao entregar encomendas.</p>';
  }
  return pageHead('Estoque', 'Ingredientes comprados e usados para fazer os bolos. Custo por média ponderada.',
    open ? '' : `<button class="btn primary" data-action="compra-new">${I.plus} Incluir ingrediente</button>`) +
    (open ? compraFormHtml() : '') +
    `<section class="card ${open ? 'mt' : ''}">
      <div class="subtabs">${[['saldo', 'Saldo por ingrediente'], ['compras', 'Compras (entradas)'], ['baixas', 'Baixas (consumo)']].map(([k, l]) => `<button class="${t === k ? 'active' : ''}" data-action="estoque-tab" data-t="${k}">${l}</button>`).join('')}</div>
      <div class="table-wrap">${body}</div>
      ${L.warnings.length ? `<div class="warn-box"><b>Atenção:</b><ul>${[...new Set(L.warnings)].map(w => `<li>${esc(w)}</li>`).join('')}</ul></div>` : ''}
    </section>`;
}

/* =================== CUSTOS =================== */
function viewCustos(L) {
  return pageHead('Custos', 'Custo de produção de cada item do cardápio, pela receita e pelo custo médio ponderado do estoque.') +
    (db.receitas.length ? `<div class="grid grid-2">${db.receitas.map(r => {
      const c = itemsCost(recipeItems(r), L);
      return `<section class="card">
        <h2 class="card-title">${esc(r.nome)} <span class="muted small">(${fmtNum(num(r.rendimento))} kg)</span></h2>
        <table class="compact"><tbody>${recipeItems(r).map(it => {
          const x = itemCost(it, L);
          return `<tr><td>${fmtNum(num(it.qtd))} ${esc(it.medida)} ${esc(it.ingrediente)}</td><td class="num">${x.status === 'ok' ? brl(x.valor) : `<span class="small muted">${x.status === 'sem' ? 'sem preço no estoque' : 'medida incompatível'}</span>`}</td></tr>`;
        }).join('')}</tbody></table>
        <div class="total-box"><span>Custo de produção</span><b>${brl(c.total)}</b></div>
        ${num(r.rendimento) > 0 ? `<p class="note">${brl(c.total / num(r.rendimento))} por kg${c.faltando ? ` · ${c.faltando} item(ns) sem preço` : ''}</p>` : ''}
      </section>`;
    }).join('')}</div>` : '<p class="empty">Inclua receitas no Cardápio para ver os custos.</p>');
}

/* =================== FINANCEIRO =================== */
function viewFinanceiro(L) {
  if (!db.produtos.length && !db.vendas.length) return pageHead('Controle Financeiro', 'Valor de venda, custo e margem de lucro de cada produto.') + '<p class="empty">Inclua um produto na aba Produtos para ver os valores.</p>';
  const vm = db.vendas.filter(noMes);
  const ent = vm.filter(v => v.status === 'entregue');
  const fat = sum(ent, v => num(v.valor));
  const cpv = sum(ent, v => saleCost(v, L));
  const rec = sum(vm.filter(v => v.status !== 'entregue'), aReceber);
  return pageHead('Controle Financeiro', 'Valor de venda, custo e margem de lucro de cada produto.', `<div class="head-actions">${filtroMes()}</div>`) +
    `<div class="stats">
      <div class="stat ok"><span>Faturamento (entregues)</span><b>${brl(fat)}</b></div>
      <div class="stat"><span>Custo dos vendidos</span><b>${brl(cpv)}</b></div>
      <div class="stat ok"><span>Lucro bruto</span><b>${brl(fat - cpv)}</b></div>
      <div class="stat"><span>A receber</span><b>${brl(rec)}</b></div>
    </div>` +
    (db.produtos.length ? `<section class="card"><h2 class="card-title">Margem por produto</h2><div class="table-wrap"><table>
      <thead><tr><th>Produto</th><th>Venda</th><th class="num">Valor de venda</th><th class="num">Custo</th><th class="num">Margem</th><th class="num">Margem %</th></tr></thead>
      <tbody>${db.produtos.map(p => {
        const i = prodInfo(p, L);
        const m = i.preco - i.custoUn;
        return `<tr><td>${esc(i.nome)} <span class="sub">${fmtDate(p.data)} · ${fmtNum(num(p.peso))} kg</span></td><td>${p.porFatias ? 'por fatia' : 'bolo inteiro'}</td>
          <td class="num">${brl(i.preco)}</td><td class="num">${brl(i.custoUn)}</td><td class="num ${m < 0 ? 'warn' : ''}">${brl(m)}</td><td class="num">${pct(i.preco > 0 ? (m / i.preco) * 100 : NaN)}</td></tr>`;
      }).join('')}</tbody></table></div></section>` : '') +
    (vm.length ? `<section class="card"><h2 class="card-title">Resultado das vendas${ui.mes !== 'todos' ? ` · ${mesLabel(ui.mes)}` : ''}</h2><div class="table-wrap"><table>
      <thead><tr><th>Entrega</th><th>Cliente</th><th>Produto</th><th>Status</th><th class="num">Valor</th><th class="num">Custo</th><th class="num">Lucro</th></tr></thead>
      <tbody>${[...vm].sort((a, b) => (a.dataEntrega < b.dataEntrega ? -1 : 1)).map(v => { const c = saleCost(v, L); const l = num(v.valor) - c; return `<tr><td>${fmtDate(v.dataEntrega)}</td><td>${esc(v.cliente || '—')}</td><td>${esc(v.nome)}</td>
        <td>${v.status === 'entregue' ? '<span class="pill ok">Entregue</span>' : '<span class="pill gold">Pendente</span>'}</td>
        <td class="num">${brl(num(v.valor))}</td><td class="num">${brl(c)}${v.status !== 'entregue' ? '<span class="sub">estimado</span>' : ''}</td><td class="num ${l < 0 ? 'warn' : ''}">${brl(l)}</td></tr>`; }).join('')}</tbody>
      <tfoot><tr><td colspan="4">Total</td><td class="num">${brl(sum(vm, v => num(v.valor)))}</td><td class="num">${brl(sum(vm, v => saleCost(v, L)))}</td><td class="num">${brl(sum(vm, v => num(v.valor) - saleCost(v, L)))}</td></tr></tfoot>
      </table></div></section>` : (db.vendas.length ? '<p class="empty">Nenhuma venda neste período.</p>' : '')) +
    (vm.length ? `<div class="grid grid-2 mt">${[
      ['Vendas por plataforma', v => v.plataforma || 'Não informado'],
      ['Vendas por forma de pagamento', v => pagamentoLabel(v) === '—' ? 'Não informado' : pagamentoLabel(v)],
    ].map(([titulo, chave]) => {
      const g = {};
      vm.forEach(v => { const k = chave(v); (g[k] ||= { n: 0, total: 0 }); g[k].n++; g[k].total += num(v.valor) || 0; });
      const rows = Object.entries(g).sort((a, b) => b[1].total - a[1].total);
      const tot = sum(rows, r => r[1].total);
      return `<section class="card"><h2 class="card-title">${titulo}</h2><table>
        <thead><tr><th></th><th class="num">Vendas</th><th class="num">Valor</th><th class="num">%</th></tr></thead>
        <tbody>${rows.map(([k, x]) => `<tr><td>${esc(k)}</td><td class="num">${x.n}</td><td class="num">${brl(x.total)}</td><td class="num">${pct(tot > 0 ? (x.total / tot) * 100 : NaN)}</td></tr>`).join('')}</tbody></table></section>`;
    }).join('')}</div>` : '');
}

/* =================== render =================== */
/* =================== ACESSOS (só administrador) =================== */
function viewAcessos() {
  const eu = (sync.session && sync.session.user && sync.session.user.email || '').toLowerCase();
  const lista = sync.acessos || [];
  return pageHead('Acessos', 'Quem pode lançar dados no painel. Quem não está na lista só visualiza.') +
    `<section class="card form-card">
      <h3>Liberar acesso</h3>
      <div class="form-grid">
        <label class="field"><span>E-mail</span><input class="input" type="email" id="acesso-email" placeholder="email@exemplo.com" autocomplete="off"></label>
        <label class="field"><span>Papel</span><select class="input" id="acesso-papel"><option value="cliente">Cliente: usa o painel no dia a dia</option><option value="admin">Administrador: acesso total</option></select></label>
      </div>
      <div class="form-actions"><button class="btn primary" data-action="acesso-add">${I.plus} Liberar acesso</button></div>
      <p class="note">Depois de liberar, a pessoa abre o painel, clica em <b>Entrar para editar → Primeiro acesso</b>, cria a própria senha e confirma pelo link enviado ao e-mail.</p>
    </section>
    <section class="card mt">
      <h2 class="card-title">Pessoas com acesso</h2>
      ${lista.length ? `<div class="table-wrap"><table><thead><tr><th>E-mail</th><th>Papel</th><th></th></tr></thead><tbody>
        ${lista.map(a => `<tr><td>${esc(a.email)}${a.email === eu ? ' <span class="muted small">(você)</span>' : ''}</td>
          <td>${a.email === eu ? `<span class="pill gold">${PAPEL_LABEL[a.papel]}</span>`
            : `<select class="input" style="max-width:200px" data-field="papel" data-email="${esc(a.email)}">${['cliente', 'admin'].map(p => `<option value="${p}" ${p === a.papel ? 'selected' : ''}>${PAPEL_LABEL[p]}</option>`).join('')}</select>`}</td>
          <td>${a.email === eu ? '' : `<button class="icon-btn danger" data-action="acesso-del" data-email="${esc(a.email)}" title="Remover acesso">${I.trash}</button>`}</td></tr>`).join('')}
      </tbody></table></div>` : '<p class="empty">Carregando…</p>'}
      <table class="compact mt"><tbody>
        <tr><td><b>Administrador</b></td><td class="small muted">Tudo: lança, edita e exclui qualquer registro, importa e restaura dados e libera acessos.</td></tr>
        <tr><td><b>Cliente</b></td><td class="small muted">Lança e edita receitas, produtos, vendas e compras e confirma entregas. Só exclui vendas.</td></tr>
      </tbody></table>
    </section>`;
}

const TABS = [['inicio', 'Início'], ['cardapio', 'Cardápio'], ['produtos', 'Produtos'], ['vendas', 'Vendas'], ['estoque', 'Estoque'], ['custos', 'Custos'], ['financeiro', 'Controle Financeiro'], ['acessos', 'Acessos']];
const VIEWS = { inicio: viewInicio, cardapio: viewCardapio, produtos: viewProdutos, vendas: viewVendas, estoque: viewEstoque, custos: viewCustos, financeiro: viewFinanceiro, acessos: viewAcessos };
const tabVisivel = k => k !== 'acessos' || sync.papel === 'admin';
const route = () => { const r = location.hash.replace(/^#\/?/, ''); return VIEWS[r] && tabVisivel(r) ? r : 'inicio'; };

function heroHtml() {
  const photo = getPhoto();
  return `<section class="hero"><div class="container">
    <label class="avatar" title="Clique para trocar a foto">${photo ? `<img src="${photo}" alt="Foto da Saah">` : '<span class="logo">Saah</span>'}
      <span class="hint">Trocar foto</span><input id="file-photo" type="file" accept="image/*" hidden></label>
    <div><h1>Saah Confeiteira</h1><p>Painel de receitas, despesas, custos e estoque</p></div></div></section>`;
}
function render() {
  const r = route();
  const L = computeLedger();
  document.getElementById('nav').innerHTML = TABS.filter(([k]) => tabVisivel(k)).map(([k, l]) => `<a href="#${k}" class="${k === r ? 'active' : ''}">${l}</a>`).join('');
  document.getElementById('hero').innerHTML = r === 'inicio' ? heroHtml() : '';
  document.getElementById('app').innerHTML = VIEWS[r](L);
  const names = new Set([...L.ings.values()].map(i => i.nome));
  document.getElementById('dl-ings').innerHTML = [...names].sort().map(n => `<option value="${esc(n)}">`).join('');
  renderFooter();
  document.title = (r === 'inicio' ? 'Saah Confeiteira' : `${TABS.find(t => t[0] === r)[1]} · Saah Confeiteira`);
}
function renderFooter() {
  const el = document.getElementById('sync-status');
  if (el) el.textContent = sync.status;
  const a = document.getElementById('auth-slot');
  if (a) {
    a.innerHTML = sync.kind !== 'supabase' ? ''
      : sync.session
        ? `<span>Conectado como ${esc(sync.session.user && sync.session.user.email)}${sync.papel ? ` <span class="pill ${sync.papel === 'admin' ? 'gold' : ''}">${PAPEL_LABEL[sync.papel]}</span>` : ''}</span>
           <button class="link" data-action="trocar-senha">Trocar senha</button> <button class="link" data-action="logout">Sair</button>`
        : '<button class="btn primary sm" data-action="login">Entrar para editar</button>';
  }
}
function refreshPreviews() {
  const P = { product: productPreview, sale: salePreview, compra: compraPreview };
  document.querySelectorAll('[data-preview]').forEach(el => { el.innerHTML = P[el.dataset.preview](); });
}
let toastTimer;
function toast(msg, error = false) {
  const t = document.getElementById('toast');
  t.textContent = msg; t.className = 'toast show' + (error ? ' error' : '');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.className = 'toast'; }, 3000);
}
const fail = msg => { toast(msg, true); return false; };

function importBackup(txt) {
  try {
    const d = JSON.parse(txt);
    if (!Array.isArray(d.receitas) || !Array.isArray(d.compras)) throw new Error();
    db = { receitas: d.receitas, compras: d.compras, produtos: d.produtos || [], vendas: d.vendas || [] };
    commit('Backup importado.');
    return true;
  } catch (e) { toast('Backup inválido. Confira se o texto foi copiado inteiro.', true); return false; }
}

/* Janela de confirmação própria (o confirm() nativo é bloqueado em alguns navegadores/painéis) */
function ask({ title, body = '', ok = 'Confirmar', danger = false, extra = '', cancel = true }) {
  return new Promise(resolve => {
    const wrap = document.createElement('div');
    wrap.className = 'modal-backdrop';
    wrap.innerHTML = `<div class="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title">
      <h3 id="modal-title">${esc(title)}</h3>
      ${body ? `<div class="modal-body">${body}</div>` : ''}
      ${extra ? `<form class="modal-extra">${extra}</form>` : ''}
      <div class="form-actions"><button class="btn ${danger ? 'danger' : 'primary'}" data-m="ok">${esc(ok)}</button>
      ${cancel ? '<button class="btn ghost" data-m="cancel">Cancelar</button>' : ''}</div></div>`;
    const close = res => { document.removeEventListener('keydown', onKey); wrap.remove(); resolve(res); };
    const values = () => Object.fromEntries(new FormData(wrap.querySelector('form') || document.createElement('form')));
    const onKey = e => { if (e.key === 'Escape') close(null); };
    wrap.addEventListener('click', e => {
      const copy = e.target.closest('[data-m="copy"]');
      if (copy) {
        const ta = wrap.querySelector('textarea');
        const done = () => toast('Backup copiado.');
        const manual = () => { ta.focus(); ta.select(); toast('Texto selecionado: use Ctrl+C para copiar.'); };
        try { navigator.clipboard.writeText(ta.value).then(done, manual); } catch (err) { manual(); }
        return;
      }
      const alt = e.target.closest('[data-m="alt"]');
      if (alt) { e.preventDefault(); close({ __alt: alt.dataset.alt }); return; }
      if (e.target === wrap || e.target.closest('[data-m="cancel"]')) close(null);
      else if (e.target.closest('[data-m="ok"]')) { e.preventDefault(); close(values()); }
    });
    wrap.addEventListener('submit', e => { e.preventDefault(); close(values()); });
    document.addEventListener('keydown', onKey);
    document.body.appendChild(wrap);
    (wrap.querySelector('textarea:not([readonly]), input:not([hidden])') || wrap.querySelector('[data-m="ok"]')).focus();
  });
}
const commit = msg => { save(); render(); if (msg) toast(msg); };

/* Campos derivados (valor automático, data da baixa) */
function syncDerived(path) {
  const f = ui.saleForm;
  if (f && path.startsWith('saleForm.')) {
    if (path === 'saleForm.valor') f.valorManual = true;
    const setEl = (id, val) => { const el = document.getElementById(id); if (el) el.value = val; };
    if (path === 'saleForm.dataEntrega') { f.dataBaixa = diaAnterior(f.dataEntrega); setEl('sale-baixa', f.dataBaixa); }
    // entrada e retirada: 50% cada; ao mudar um, o outro completa o valor da venda
    const total = num(f.valor);
    if (path === 'saleForm.valor' || path === 'saleForm.encomenda') {
      if (total > 0) { f.entrada = inputNum(round2(total / 2)); f.retirada = inputNum(round2(total - round2(total / 2))); }
      else { f.entrada = ''; f.retirada = ''; }
      setEl('sale-entrada', f.entrada); setEl('sale-retirada', f.retirada);
    }
    if (path === 'saleForm.entrada' && total > 0 && isFinite(num(f.entrada))) { f.retirada = inputNum(round2(total - num(f.entrada))); setEl('sale-retirada', f.retirada); }
    if (path === 'saleForm.retirada' && total > 0 && isFinite(num(f.retirada))) { f.entrada = inputNum(round2(total - num(f.retirada))); setEl('sale-entrada', f.entrada); }
    if (path === 'saleForm.produtoId') { f.qtd = '1'; f.valorManual = false; }
    if (path === 'saleForm.pagamento' && !bandeirasDe(f.pagamento).includes(f.bandeira)) f.bandeira = '';
    if (path === 'saleForm.receitaId') { const r = recipeById(f.receitaId); if (r && !f.peso) f.peso = inputNum(r.rendimento); }
    if (!f.encomenda && !f.valorManual && (path === 'saleForm.produtoId' || path === 'saleForm.qtd')) {
      const p = productById(f.produtoId);
      if (p) {
        const preco = p.porFatias ? num(p.valorFatia) : num(p.valor);
        const v = preco * num(f.qtd);
        f.valor = isFinite(v) ? inputNum(Math.round(v * 100) / 100) : '';
        const el = document.getElementById('sale-valor'); if (el) el.value = f.valor;
      }
    }
  }
  if (ui.productForm && path === 'productForm.receitaId') {
    const r = recipeById(ui.productForm.receitaId); if (r) ui.productForm.peso = inputNum(r.rendimento);
  }
  if (ui.compraForm && path === 'compraForm.ingrediente') {
    const ing = computeLedger().ings.get(ingKey(ui.compraForm.ingrediente));
    const el = document.getElementById('compra-medida');
    if (ing && ing.compras && el && !ui.compraForm.medidaManual) { ui.compraForm.medida = ing.medida; el.value = ing.medida; }
  }
  if (ui.compraForm && path === 'compraForm.medida') ui.compraForm.medidaManual = true;
}

/* =================== ações =================== */
const blankItem = () => ({ qtd: '', medida: '', ingrediente: '' });
const ACTIONS = {
  'cal-sel': d => { ui.cal.sel = d.date; const [y, m] = d.date.split('-').map(Number); ui.cal.y = y; ui.cal.m = m - 1; render(); },
  'cal-move': d => { const dt = new Date(ui.cal.y, ui.cal.m + Number(d.d), 1); ui.cal.y = dt.getFullYear(); ui.cal.m = dt.getMonth(); render(); },

  /* Cardápio */
  'recipe-new': () => { ui.recipeForm = { nome: '', rendimento: '', partes: [{ nome: 'Massa', itens: [blankItem()] }] }; render(); },
  'recipe-edit': d => {
    const r = recipeById(d.id);
    ui.recipeForm = { id: r.id, nome: r.nome, rendimento: inputNum(r.rendimento), partes: r.partes.map(p => ({ nome: p.nome, itens: p.itens.map(it => ({ qtd: inputNum(it.qtd), medida: it.medida, ingrediente: it.ingrediente })) })) };
    render();
  },
  'recipe-cancel': () => { ui.recipeForm = null; render(); },
  'recipe-toggle': d => { ui.collapsed[d.id] = !ui.collapsed[d.id]; render(); },
  'recipe-del': async d => {
    const r = recipeById(d.id);
    if (!await ask({ title: `Excluir a receita "${r.nome}"?`, body: 'Produtos já feitos continuam com a receita registrada.', ok: 'Excluir', danger: true })) return;
    db.receitas = db.receitas.filter(x => x.id !== d.id); commit('Receita excluída.');
  },
  'part-add': () => { ui.recipeForm.partes.push({ nome: '', itens: [blankItem()] }); render(); },
  'part-del': d => { ui.recipeForm.partes.splice(Number(d.i), 1); render(); },
  'item-add': d => { ui.recipeForm.partes[Number(d.i)].itens.push(blankItem()); render(); },
  'item-del': d => { ui.recipeForm.partes[Number(d.i)].itens.splice(Number(d.j), 1); render(); },
  'recipe-save': () => {
    const f = ui.recipeForm;
    if (!f.nome.trim()) return fail('Informe o nome da receita.');
    const partes = f.partes.map(p => ({
      nome: p.nome.trim() || 'Receita',
      itens: p.itens.filter(it => it.ingrediente.trim()).map(it => ({ qtd: num(it.qtd), medida: it.medida.trim(), ingrediente: it.ingrediente.trim() })),
    })).filter(p => p.itens.length);
    if (!partes.length) return fail('Inclua pelo menos um ingrediente.');
    const bad = partes.flatMap(p => p.itens).find(it => !(it.qtd > 0));
    if (bad) return fail(`Informe a quantidade de "${bad.ingrediente}".`);
    const rend = num(f.rendimento);
    if (!(rend > 0)) return fail('Informe o rendimento em kg.');
    const rec = { id: f.id || uid(), nome: f.nome.trim(), rendimento: rend, partes };
    if (f.id) db.receitas = db.receitas.map(r => (r.id === f.id ? rec : r)); else db.receitas.push(rec);
    ui.recipeForm = null; commit(f.id ? 'Receita atualizada.' : 'Receita incluída.');
  },

  /* Produtos */
  'product-new': () => {
    if (!db.receitas.length) return fail('Inclua uma receita no Cardápio primeiro.');
    ui.productForm = { receitaId: '', peso: '', quantidade: '1', data: hoje(), porFatias: false, fatias: '', valorFatia: '', valor: '' }; render();
  },
  'product-edit': d => {
    const p = productById(d.id);
    ui.productForm = { id: p.id, receitaId: p.receitaId, peso: inputNum(p.peso), quantidade: inputNum(p.quantidade), data: p.data, porFatias: !!p.porFatias, fatias: inputNum(p.fatias), valorFatia: inputNum(p.valorFatia), valor: inputNum(p.valor) };
    render(); window.scrollTo({ top: 0, behavior: 'smooth' });
  },
  'product-cancel': () => { ui.productForm = null; render(); },
  'product-del': async d => {
    if (db.vendas.some(v => v.produtoId === d.id)) return fail('Este produto tem vendas vinculadas. Exclua as vendas primeiro.');
    if (!await ask({ title: 'Excluir este produto?', body: 'Os ingredientes baixados voltam para o estoque.', ok: 'Excluir', danger: true })) return;
    db.produtos = db.produtos.filter(p => p.id !== d.id); commit('Produto excluído.');
  },
  'product-save': () => {
    const f = ui.productForm;
    const old = f.id ? productById(f.id) : null;
    const rec = recipeById(f.receitaId);
    if (!rec && !(old && old.receitaId === f.receitaId)) return fail('Selecione um item do cardápio.');
    const peso = num(f.peso), qtd = num(f.quantidade);
    if (!(peso > 0)) return fail('Informe o peso do bolo.');
    if (!(qtd > 0)) return fail('Informe a quantidade produzida.');
    if (!f.data) return fail('Informe a data da produção.');
    const p = { id: f.id || uid(), seq: old ? old.seq || 0 : Date.now(), receitaId: f.receitaId, peso, quantidade: qtd, data: f.data, porFatias: !!f.porFatias };
    if (p.porFatias) {
      p.fatias = num(f.fatias); p.valorFatia = num(f.valorFatia);
      if (!(p.fatias > 0)) return fail('Informe quantas fatias tem cada bolo.');
      if (!(p.valorFatia > 0)) return fail('Informe o valor da fatia.');
    } else {
      p.valor = num(f.valor);
      if (!(p.valor > 0)) return fail('Informe o valor do bolo.');
    }
    p.snapshot = old && old.receitaId === f.receitaId && old.snapshot ? old.snapshot : snapshotOf(rec);
    if (old) {
      const L = computeLedger();
      const i = prodInfo(old, L);
      const novoTotal = qtd * (p.porFatias ? p.fatias : 1);
      if ((p.porFatias !== !!old.porFatias) && i.vendido + i.reservado > 0) return fail('Não é possível trocar entre fatias e bolo inteiro com vendas vinculadas.');
      if (novoTotal < i.vendido + i.reservado - EPS) return fail(`Já existem ${fmtNum(i.vendido + i.reservado)} ${i.unidade}(s) vendidos/reservados deste produto.`);
      db.produtos = db.produtos.map(x => (x.id === p.id ? p : x));
    } else db.produtos.push(p);
    ui.productForm = null; commit(old ? 'Produto atualizado.' : 'Produto incluído e ingredientes baixados do estoque.');
  },

  /* Vendas */
  'sale-new': () => { ui.saleForm = { encomenda: false, produtoId: '', receitaId: '', peso: '', qtd: '1', cliente: '', valor: '', entrada: '', retirada: '', dataEntrega: hoje(), dataBaixa: diaAnterior(hoje()), plataforma: 'Presencial', pagamento: 'Pix', bandeira: '' }; render(); },
  'sale-cancel': () => { ui.saleForm = null; render(); },
  'sale-save': () => {
    const f = ui.saleForm;
    const qtd = num(f.qtd), valor = num(f.valor);
    if (!f.cliente.trim()) return fail('Informe o cliente.');
    if (!(qtd > 0)) return fail('Informe a quantidade.');
    if (!(valor >= 0)) return fail('Informe o valor da venda.');
    if (!f.dataEntrega) return fail('Informe a data da entrega.');
    if (!PLATAFORMAS.includes(f.plataforma)) return fail('Informe a plataforma de venda.');
    if (!PAGAMENTOS.includes(f.pagamento)) return fail('Informe a forma de pagamento.');
    const precisaBandeira = bandeirasDe(f.pagamento).length > 0;
    if (precisaBandeira && !bandeirasDe(f.pagamento).includes(f.bandeira)) return fail('Selecione a bandeira.');
    const old = f.id ? db.vendas.find(v => v.id === f.id) : null;
    if (f.id && !old) { ui.saleForm = null; return fail('Esta venda foi excluída por outra pessoa.'); }
    const base = { id: old ? old.id : uid(), cliente: f.cliente.trim(), qtd, valor, dataEntrega: f.dataEntrega, status: 'pendente', criadoEm: old ? old.criadoEm : hoje(),
      plataforma: f.plataforma, pagamento: f.pagamento, bandeira: precisaBandeira ? f.bandeira : '' };
    let nova;
    if (f.encomenda) {
      const rec = recipeById(f.receitaId);
      if (!rec) return fail('Selecione o produto do cardápio.');
      const peso = num(f.peso);
      if (!(peso > 0)) return fail('Informe o peso do bolo.');
      const snap = old && old.tipo === 'encomenda' && old.receitaId === rec.id && old.snapshot ? old.snapshot : snapshotOf(rec);
      const entrada = num(f.entrada), retirada = num(f.retirada);
      if (!(entrada >= 0) || !(retirada >= 0)) return fail('Informe o valor de entrada e o valor na retirada.');
      if (Math.abs(entrada + retirada - valor) > 0.009) return fail(`Entrada + retirada (${brl(entrada + retirada)}) precisa ser igual ao valor da venda (${brl(valor)}).`);
      const manter = old && old.tipo === 'encomenda';
      nova = { ...base, tipo: 'encomenda', receitaId: rec.id, nome: rec.nome, snapshot: snap, peso, entrada, retirada,
        dataBaixa: diaAnterior(f.dataEntrega),
        entradaPaga: manter ? !!old.entradaPaga : false, entradaPagaEm: manter ? old.entradaPagaEm || null : null, seqBaixa: manter ? old.seqBaixa || 0 : 0 };
    } else {
      const p = productById(f.produtoId);
      if (!p) return fail('Selecione um produto em estoque.');
      const i = prodInfo(p, computeLedger());
      const disp = i.disp + (old && old.tipo === 'estoque' && old.produtoId === p.id ? num(old.qtd) : 0);
      if (qtd > disp + EPS) return fail(`Só há ${fmtNum(disp)} ${unidadeLabel(i.unidade, disp)} disponíveis.`);
      nova = { ...base, tipo: 'estoque', produtoId: p.id, nome: i.nome, unidade: i.unidade };
    }
    if (old) db.vendas = db.vendas.map(v => (v.id === old.id ? nova : v)); else db.vendas.push(nova);
    ui.saleForm = null;
    commit(old ? 'Venda atualizada.' : nova.tipo === 'encomenda' ? 'Encomenda salva. Ela fica confirmada quando você marcar "Entrada paga".' : 'Venda incluída.');
  },
  'sale-edit': d => {
    const v = db.vendas.find(x => x.id === d.id);
    if (!v) return;
    if (v.status === 'entregue') return fail('Desfaça a entrega antes de editar esta venda.');
    ui.saleForm = {
      id: v.id, encomenda: v.tipo === 'encomenda', produtoId: v.produtoId || '', receitaId: v.receitaId || '',
      peso: inputNum(v.peso), qtd: inputNum(v.qtd), cliente: v.cliente || '', valor: inputNum(v.valor),
      dataEntrega: v.dataEntrega, dataBaixa: diaAnterior(v.dataEntrega),
      entrada: inputNum(v.entrada ?? round2(num(v.valor) / 2)), retirada: inputNum(v.retirada ?? round2(num(v.valor) - round2(num(v.valor) / 2))),
      plataforma: v.plataforma || 'Presencial', pagamento: v.pagamento || 'Pix', bandeira: v.bandeira || '',
      valorManual: true, baixaManual: true, origProdutoId: v.tipo === 'estoque' ? v.produtoId : null, origQtd: num(v.qtd),
    };
    render(); window.scrollTo({ top: 0, behavior: 'smooth' });
  },
  'sale-deliver': async d => {
    const v = db.vendas.find(x => x.id === d.id);
    if (!v) return;
    let res;
    if (v.tipo === 'encomenda') {
      if (!v.entradaPaga) return fail('Marque "Entrada paga" antes de confirmar a entrega desta encomenda.');
      res = await ask({
        title: `Confirmar a entrega para ${v.cliente}?`,
        body: `${fmtNum(v.qtd)} ${unidadeLabel('bolo', v.qtd)} de ${esc(v.nome)} (encomenda).<br>Receber na retirada: <b>${brl(num(v.retirada ?? v.valor))}</b>.<br><span class="muted">Ingredientes baixados em ${fmtDate(v.dataBaixa || diaAnterior(v.dataEntrega))}, um dia antes da entrega.</span>`,
        ok: 'OK, entregue',
      });
      if (!res) return;
    } else {
      const p = productById(v.produtoId);
      if (!p) return fail('O produto desta venda não existe mais.');
      res = await ask({
        title: `Confirmar a entrega para ${v.cliente}?`,
        body: `${fmtNum(v.qtd)} ${unidadeLabel(v.unidade, v.qtd)} de ${esc(v.nome)} serão baixados do estoque de produtos.`,
        ok: 'OK, entregue',
      });
      if (!res) return;
    }
    v.status = 'entregue'; v.entregueEm = hoje();
    if (v.tipo !== 'encomenda') v.seqBaixa = Date.now();
    commit(v.tipo === 'encomenda' ? 'Entrega confirmada.' : 'Entrega confirmada e produto baixado do estoque.');
  },
  'entrada-paga': async d => {
    const v = db.vendas.find(x => x.id === d.id);
    if (!v || v.status === 'entregue') return;
    if (!v.entradaPaga) {
      const falta = shortages(v.snapshot.itens, factorOf(v.snapshot, v.peso, v.qtd), computeLedger());
      const res = await ask({
        title: `Entrada de ${v.cliente} paga?`,
        body: `Valor de entrada: <b>${brl(num(v.entrada ?? num(v.valor) / 2))}</b>. A encomenda fica confirmada e os ingredientes são baixados do estoque em <b>${fmtDate(v.dataBaixa || diaAnterior(v.dataEntrega))}</b> (um dia antes da entrega).` +
          (falta.length ? `<div class="warn-box">Estoque insuficiente de ${falta.map(s => esc(s.nome)).join(', ')}. O saldo ficará negativo.</div>` : ''),
        ok: 'Sim, entrada paga',
      });
      if (!res) return;
      v.entradaPaga = true; v.entradaPagaEm = hoje(); v.seqBaixa = Date.now();
      v.dataBaixa = diaAnterior(v.dataEntrega);
      commit('Entrada registrada. Encomenda confirmada.');
    } else {
      if (!await ask({ title: 'Desmarcar a entrada paga?', body: 'A encomenda volta para "Aguardando entrada" e os ingredientes voltam para o estoque.', ok: 'Desmarcar' })) return;
      v.entradaPaga = false; v.entradaPagaEm = null;
      commit('Entrada desmarcada.');
    }
  },
  'sale-undo': async d => {
    const v = db.vendas.find(x => x.id === d.id);
    if (!await ask({ title: 'Desfazer a entrega?', body: 'A venda volta para pendente e o estoque é devolvido.', ok: 'Desfazer' })) return;
    v.status = 'pendente'; delete v.entregueEm; commit('Entrega desfeita.');
  },
  'sale-del': async d => {
    if (!await ask({ title: 'Excluir esta venda?', ok: 'Excluir', danger: true })) return;
    db.vendas = db.vendas.filter(v => v.id !== d.id); commit('Venda excluída.');
  },

  /* Estoque */
  'estoque-tab': d => { ui.estoqueTab = d.t; render(); },
  'compra-new': () => { ui.compraForm = { ingrediente: '', quantidade: '', medida: '', valor: '', data: hoje() }; render(); },
  'compra-cancel': () => { ui.compraForm = null; render(); },
  'compra-save': () => {
    const f = ui.compraForm;
    const q = num(f.quantidade), v = num(f.valor);
    if (!f.ingrediente.trim()) return fail('Informe o ingrediente.');
    if (!(q > 0)) return fail('Informe a quantidade.');
    if (!f.medida.trim()) return fail('Informe a medida.');
    if (!(v >= 0)) return fail('Informe o valor da compra.');
    const old = f.id ? db.compras.find(c => c.id === f.id) : null;
    if (f.id && !old) { ui.compraForm = null; return fail('Esta compra foi excluída por outra pessoa.'); }
    const outras = old ? db.compras.filter(c => c.id !== old.id) : db.compras;
    const salvo = db.compras; db.compras = outras;
    let ing;
    try { ing = computeLedger().ings.get(ingKey(f.ingrediente)); } finally { db.compras = salvo; }
    if (ing && ing.compras && convert(q, unitKey(f.medida), ing.unit) == null) return fail(`Use uma medida compatível com "${ing.medida}".`);
    const compra = { id: old ? old.id : uid(), seq: old ? old.seq || 0 : Date.now(), ingrediente: ing && ing.compras ? ing.nome : f.ingrediente.trim(), quantidade: q, medida: f.medida.trim(), valor: v, data: f.data || hoje() };
    if (old) db.compras = db.compras.map(c => (c.id === old.id ? compra : c)); else db.compras.push(compra);
    ui.compraForm = null; commit(old ? 'Compra atualizada. Custo médio recalculado.' : 'Compra incluída. Custo médio recalculado.');
  },
  'compra-edit': d => {
    const c = db.compras.find(x => x.id === d.id);
    if (!c) return;
    ui.compraForm = { id: c.id, ingrediente: c.ingrediente, quantidade: inputNum(c.quantidade), medida: c.medida, valor: inputNum(c.valor), data: c.data, medidaManual: true };
    render(); window.scrollTo({ top: 0, behavior: 'smooth' });
  },
  'compra-del': async d => {
    if (!await ask({ title: 'Excluir esta compra?', body: 'O saldo e o custo médio serão recalculados.', ok: 'Excluir', danger: true })) return;
    db.compras = db.compras.filter(c => c.id !== d.id); commit('Compra excluída.');
  },

  /* Login (site publicado com Supabase) */
  login: async () => {
    const res = await ask({
      title: 'Entrar para editar',
      body: 'Use o seu e-mail e a sua senha.',
      extra: field('E-mail', '<input class="input" type="email" name="email" autocomplete="username" required>') +
        field('Senha', '<input class="input" type="password" name="senha" autocomplete="current-password" required>') +
        `<div class="modal-links"><button type="button" class="link" data-m="alt" data-alt="primeiro">Primeiro acesso: criar minha senha</button>
          <button type="button" class="link" data-m="alt" data-alt="esqueci">Esqueci minha senha</button></div>`,
      ok: 'Entrar',
    });
    if (!res) return;
    if (res.__alt === 'primeiro') return ACTIONS['primeiro-acesso']();
    if (res.__alt === 'esqueci') return ACTIONS['esqueci-senha']();
    if (!res.email || !res.senha) return;
    const { error } = await sync.supa.auth.signInWithPassword({ email: res.email.trim(), password: res.senha });
    if (error) {
      if (/confirm/i.test(error.message || '')) return toast('Confirme seu e-mail pelo link que enviamos antes de entrar.', true);
      return toast('E-mail ou senha incorretos. Confira e tente de novo.', true);
    }
    toast('Bem-vinda(o)! Carregando seu acesso…');
  },
  'primeiro-acesso': async () => {
    const res = await ask({
      title: 'Primeiro acesso',
      body: 'Use o e-mail que o administrador liberou e crie uma senha com pelo menos 8 caracteres.',
      extra: field('E-mail', '<input class="input" type="email" name="email" autocomplete="username" required>') +
        field('Nova senha', '<input class="input" type="password" name="senha" autocomplete="new-password" minlength="8" required>') +
        field('Repita a senha', '<input class="input" type="password" name="senha2" autocomplete="new-password" minlength="8" required>'),
      ok: 'Criar senha',
    });
    if (!res || !res.email) return;
    if ((res.senha || '').length < 8) return toast('A senha precisa ter pelo menos 8 caracteres.', true);
    if (res.senha !== res.senha2) return toast('As duas senhas não são iguais.', true);
    const { data, error } = await sync.supa.auth.signUp({
      email: res.email.trim(), password: res.senha,
      options: { emailRedirectTo: location.origin + location.pathname },
    });
    if (error) {
      if (/registered|exists/i.test(error.message || '')) return toast('Este e-mail já tem senha. Use "Entrar" ou "Esqueci minha senha".', true);
      return toast('Não foi possível criar a senha: ' + error.message, true);
    }
    if (data.session) return toast('Senha criada. Você já está conectada(o).');
    await ask({
      title: 'Confirme seu e-mail',
      body: `Enviamos um link para <b>${esc(res.email.trim())}</b>. Abra o e-mail, clique no link e depois entre com a senha que você criou. Se não encontrar, olhe a caixa de spam.`,
      ok: 'Entendi', cancel: false,
    });
  },
  'esqueci-senha': async () => {
    const res = await ask({
      title: 'Esqueci minha senha',
      body: 'Enviaremos um link para você criar uma nova senha.',
      extra: field('E-mail', '<input class="input" type="email" name="email" autocomplete="username" required>'),
      ok: 'Enviar link',
    });
    if (!res || !res.email) return;
    const { error } = await sync.supa.auth.resetPasswordForEmail(res.email.trim(), { redirectTo: location.origin + location.pathname });
    if (error) return toast('Não foi possível enviar o link agora. Tente de novo em alguns minutos.', true);
    toast('Link enviado. Confira seu e-mail (e a caixa de spam).');
  },
  'nova-senha': async () => {
    const res = await ask({
      title: 'Criar nova senha',
      extra: field('Nova senha', '<input class="input" type="password" name="senha" autocomplete="new-password" minlength="8" required>') +
        field('Repita a senha', '<input class="input" type="password" name="senha2" autocomplete="new-password" minlength="8" required>'),
      ok: 'Salvar senha',
    });
    if (!res) return;
    if ((res.senha || '').length < 8) return toast('A senha precisa ter pelo menos 8 caracteres.', true);
    if (res.senha !== res.senha2) return toast('As duas senhas não são iguais.', true);
    const { error } = await sync.supa.auth.updateUser({ password: res.senha });
    if (error) return toast('Não foi possível salvar a senha: ' + error.message, true);
    toast('Senha atualizada.');
  },
  'trocar-senha': () => ACTIONS['nova-senha'](),

  /* Acessos (administrador) */
  'acesso-add': async () => {
    const email = (document.getElementById('acesso-email').value || '').trim().toLowerCase();
    const papel = document.getElementById('acesso-papel').value;
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return fail('Digite um e-mail válido.');
    const { error } = await sync.supa.from('editores').upsert({ email, papel });
    if (error) return fail('Não foi possível liberar o acesso: ' + error.message);
    await carregarAcessos(); render();
    toast(`Acesso liberado para ${email} como ${PAPEL_LABEL[papel]}.`);
  },
  'acesso-del': async d => {
    if (!await ask({ title: `Remover o acesso de ${d.email}?`, body: 'A pessoa continua vendo o painel, mas não consegue mais lançar dados.', ok: 'Remover', danger: true })) return;
    const { error } = await sync.supa.from('editores').delete().eq('email', d.email);
    if (error) return fail('Não foi possível remover: ' + error.message);
    await carregarAcessos(); render();
    toast('Acesso removido.');
  },
  logout: async () => {
    await sync.supa.auth.signOut();
    toast('Você saiu. O painel fica só para visualização.');
  },

  /* Dados */
  export: () => {
    ask({
      title: 'Backup dos dados',
      body: 'Copie o texto abaixo e guarde num arquivo ou mensagem. Para restaurar, use "Importar backup" e cole o texto.',
      extra: `<textarea class="input backup-text" id="backup-out" readonly>${esc(JSON.stringify(db))}</textarea>
        <button type="button" class="btn soft sm" data-m="copy">Copiar backup</button>`,
      ok: 'Fechar', cancel: false,
    });
  },
  import: async () => {
    const res = await ask({
      title: 'Importar backup',
      body: 'Cole o texto do backup ou escolha o arquivo .json. Os dados atuais serão substituídos.',
      extra: `<textarea class="input backup-text" id="backup-in" name="backup" placeholder="Cole o backup aqui"></textarea>
        <label class="btn soft sm">Escolher arquivo<input id="file-import" type="file" accept="application/json,.json" hidden></label>`,
      ok: 'Importar', danger: true,
    });
    if (res && res.backup) importBackup(res.backup);
  },
  reset: async () => {
    if (!await ask({ title: 'Restaurar dados de exemplo?', body: 'Todos os dados atuais (receitas, produtos, vendas e compras) serão apagados. Exporte um backup antes, se quiser guardar.', ok: 'Apagar e restaurar', danger: true })) return;
    db = seed(); ui.recipeForm = ui.productForm = ui.saleForm = ui.compraForm = null; commit('Dados de exemplo restaurados.');
  },
};

/* =================== eventos =================== */
const valOf = t => (t.type === 'checkbox' ? t.checked : t.value);
document.addEventListener('input', e => {
  const t = e.target;
  if (!t.dataset.bind || t.type === 'checkbox' || t.tagName === 'SELECT' || t.type === 'date') return;
  setPath(ui, t.dataset.bind, valOf(t));
  syncDerived(t.dataset.bind);
  refreshPreviews();
});
document.addEventListener('change', e => {
  const t = e.target;
  if (t.dataset.bind) {
    setPath(ui, t.dataset.bind, valOf(t));
    syncDerived(t.dataset.bind);
    if ('rerender' in t.dataset) render(); else refreshPreviews();
  } else if (t.dataset.field === 'papel') {
    sync.supa.from('editores').update({ papel: t.value }).eq('email', t.dataset.email).then(async ({ error }) => {
      if (error) toast('Não foi possível mudar o papel: ' + error.message, true);
      else toast(`${t.dataset.email} agora é ${PAPEL_LABEL[t.value]}.`);
      await carregarAcessos(); render();
    });
  } else if (t.dataset.field === 'dataBaixa') {
    const v = db.vendas.find(x => x.id === t.dataset.id); if (v && t.value) { v.dataBaixa = t.value; save(); toast('Data da baixa atualizada.'); }
  } else if (t.id === 'file-import' && t.files[0]) {
    t.files[0].text().then(txt => { if (importBackup(txt)) document.querySelector('.modal-backdrop')?.remove(); })
      .catch(() => toast('Não foi possível ler o arquivo.', true)).finally(() => { t.value = ''; });
  } else if (t.id === 'file-photo' && t.files[0]) {
    const img = new Image();
    img.onload = () => {
      const s = 320, c = document.createElement('canvas'); c.width = c.height = s;
      const k = Math.max(s / img.width, s / img.height), w = img.width * k, h = img.height * k;
      c.getContext('2d').drawImage(img, (s - w) / 2, (s - h) / 2, w, h);
      setPhoto(c.toDataURL('image/jpeg', 0.85));
      URL.revokeObjectURL(img.src); render();
    };
    img.src = URL.createObjectURL(t.files[0]);
  }
});
document.addEventListener('click', e => {
  const el = e.target.closest('[data-action]');
  if (!el) return;
  const fn = ACTIONS[el.dataset.action];
  if (fn) { e.preventDefault(); fn(el.dataset, el); }
});
window.addEventListener('hashchange', () => { render(); window.scrollTo(0, 0); });

initStore();
