const PDFDocument = require("pdfkit");
const fs = require("fs");
const path = require("path");
const express = require("express");
const cors = require("cors");
const Database = require("better-sqlite3");
const crypto = require("crypto");
const { AsyncLocalStorage } = require("async_hooks");
 
const app = express();
const requestContext = new AsyncLocalStorage();
 
app.use(cors());
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ limit: "10mb", extended: true }));
 
// Arquivos públicos necessários para a interface.
// Não servimos a pasta inteira para evitar expor server.js ou vidracaria.db.
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});
 
app.get("/index.html", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});
 
["logo.png", "fundo.png", "fundo-mobile.png"].forEach((arquivo) => {
  app.get(`/${arquivo}`, (req, res) => {
    res.sendFile(path.join(__dirname, arquivo));
  });
});
 
app.use("/imagens de projetos", express.static(path.join(__dirname, "imagens de projetos")));
app.use("/imagens-projetos", express.static(path.join(__dirname, "imagens-projetos")));
app.use("/imagens_projetos", express.static(path.join(__dirname, "imagens_projetos")));
 
const DB_PATH = process.env.DB_PATH || "vidracaria.db";
const db = new Database(DB_PATH);
 
// ============================
// BANCO
// ============================
 
db.prepare(`
CREATE TABLE IF NOT EXISTS produtos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nome TEXT UNIQUE,
  preco REAL
)
`).run();
 
db.prepare(`
CREATE TABLE IF NOT EXISTS estoque (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  material TEXT,
  sobra_mm REAL
)
`).run();
 
db.prepare(`
CREATE TABLE IF NOT EXISTS config (
  chave TEXT PRIMARY KEY,
  valor TEXT
)
`).run();
 
db.prepare(`
CREATE TABLE IF NOT EXISTS tabela_precos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nome TEXT UNIQUE,
  valor REAL
)
`).run();
 
db.prepare(`
CREATE TABLE IF NOT EXISTS orcamentos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  cliente TEXT,
  obra TEXT,
  valor_total REAL,
  dados TEXT,
  criado_em TEXT
)
`).run();
 
// ============================
// USUÁRIOS / LOGIN / MULTIEMPRESA
// ============================
 
db.prepare(`
CREATE TABLE IF NOT EXISTS usuarios (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nome_responsavel TEXT,
  nome_empresa TEXT,
  telefone TEXT,
  email TEXT UNIQUE,
  senha_hash TEXT,
  senha_salt TEXT,
  endereco TEXT,
  cidade_bairro TEXT,
  logo_base64 TEXT,
  criado_em TEXT,
  teste_ate TEXT,
  ativo INTEGER DEFAULT 1
)
`).run();
 
db.prepare(`
CREATE TABLE IF NOT EXISTS sessoes (
  token TEXT PRIMARY KEY,
  usuario_id INTEGER,
  criado_em TEXT
)
`).run();
 
function tabelaTemColuna(tabela, coluna) {
  return db.prepare(`PRAGMA table_info(${tabela})`).all().some(c => c.name === coluna);
}
 
function hashSenha(senha, salt = crypto.randomBytes(16).toString("hex")) {
  const hash = crypto.pbkdf2Sync(String(senha || ""), salt, 120000, 64, "sha512").toString("hex");
  return { salt, hash };
}
 
function senhaConfere(senha, salt, hash) {
  const h = hashSenha(senha, salt).hash;
  return crypto.timingSafeEqual(Buffer.from(h), Buffer.from(hash));
}
 
function criarToken(usuarioId) {
  const token = crypto.randomBytes(32).toString("hex");
  db.prepare(`INSERT INTO sessoes (token, usuario_id, criado_em) VALUES (?, ?, ?)`)
    .run(token, usuarioId, new Date().toISOString());
  return token;
}
 
function diasTesteRestantes(usuario) {
  const fim = new Date(usuario.teste_ate || usuario.criado_em || new Date().toISOString()).getTime();
  const agora = Date.now();
  return Math.max(0, Math.ceil((fim - agora) / (1000 * 60 * 60 * 24)));
}
 
function usuarioExpirado(usuario) {
  return diasTesteRestantes(usuario) <= 0 || Number(usuario.ativo || 0) !== 1;
}
 
function usuarioAtualId() {
  return requestContext.getStore()?.usuario_id || null;
}
 
function usuarioAtual() {
  const id = usuarioAtualId();
  if (!id) return null;
  return db.prepare("SELECT * FROM usuarios WHERE id=?").get(id) || null;
}
 
function perfilEmpresaAtual() {
  const u = usuarioAtual();
  if (!u) {
    return {
      nome: "VB Vidraçaria Batista",
      emitidoPor: "Thiago Batista",
      telefone: "(61) 99682-3909",
      email: "vb.vidracariabatista@gmail.com",
      endereco: "Quadra 406, Conjunto Z, Casa 25 - Recanto das Emas - Brasília/DF",
      logo_base64: ""
    };
  }
  return {
    nome: u.nome_empresa || "Minha Vidraçaria",
    emitidoPor: u.nome_responsavel || u.nome_empresa || "Responsável",
    telefone: u.telefone || "",
    email: u.email || "",
    endereco: u.endereco || u.cidade_bairro || "",
    logo_base64: u.logo_base64 || ""
  };
}
 
function migrarTabelaProdutos() {
  const cols = db.prepare("PRAGMA table_info(produtos)").all();
  if (!cols.some(c => c.name === "usuario_id")) {
    db.exec(`
      ALTER TABLE produtos RENAME TO produtos_antiga;
      CREATE TABLE produtos (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        usuario_id INTEGER,
        nome TEXT,
        preco REAL,
        UNIQUE(usuario_id, nome)
      );
      INSERT INTO produtos (id, usuario_id, nome, preco)
      SELECT id, 1, nome, preco FROM produtos_antiga;
      DROP TABLE produtos_antiga;
    `);
  }
}
 
function migrarTabelaConfig() {
  const cols = db.prepare("PRAGMA table_info(config)").all();
  if (!cols.some(c => c.name === "usuario_id")) {
    db.exec(`
      ALTER TABLE config RENAME TO config_antiga;
      CREATE TABLE config (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        usuario_id INTEGER,
        chave TEXT,
        valor TEXT,
        UNIQUE(usuario_id, chave)
      );
      INSERT INTO config (usuario_id, chave, valor)
      SELECT 1, chave, valor FROM config_antiga;
      DROP TABLE config_antiga;
    `);
  }
}
 
function garantirColunaUsuario(tabela) {
  if (!tabelaTemColuna(tabela, "usuario_id")) {
    db.prepare(`ALTER TABLE ${tabela} ADD COLUMN usuario_id INTEGER DEFAULT 1`).run();
  }
}
 
// Usuário inicial para preservar seus dados atuais.
// Depois você pode criar outros usuários pela tela de cadastro.
if (!db.prepare("SELECT id FROM usuarios WHERE email=?").get("vb.vidracariabatista@gmail.com")) {
  const senha = hashSenha("123456");
  const criado = new Date().toISOString();
  const testeAte = new Date(Date.now() + 3650 * 24 * 60 * 60 * 1000).toISOString();
  db.prepare(`
    INSERT INTO usuarios (nome_responsavel, nome_empresa, telefone, email, senha_hash, senha_salt, endereco, cidade_bairro, criado_em, teste_ate, ativo)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
  `).run(
    "Thiago Batista",
    "VB Vidraçaria Batista",
    "(61) 99682-3909",
    "vb.vidracariabatista@gmail.com",
    senha.hash,
    senha.salt,
    "Quadra 406, Conjunto Z, Casa 25 - Recanto das Emas - Brasília/DF",
    "Recanto das Emas - Brasília/DF",
    criado,
    testeAte
  );
}
 
migrarTabelaProdutos();
migrarTabelaConfig();
garantirColunaUsuario("estoque");
garantirColunaUsuario("tabela_precos");
garantirColunaUsuario("orcamentos");
 
function carregarUsuarioPorToken(token) {
  if (!token) return null;
  const sessao = db.prepare("SELECT usuario_id FROM sessoes WHERE token=?").get(token);
  if (!sessao) return null;
  return db.prepare("SELECT * FROM usuarios WHERE id=?").get(sessao.usuario_id) || null;
}
 
function requireAuth(req, res, next) {
  let token = "";
  const auth = req.headers.authorization || "";
  if (auth.startsWith("Bearer ")) token = auth.slice(7);
  if (!token && req.body && req.body.token) token = req.body.token;
  if (!token && req.query && req.query.token) token = req.query.token;
 
  const usuario = carregarUsuarioPorToken(token);
  if (!usuario) {
    return res.status(401).json({ erro: "Faça login para continuar" });
  }
 
  const rotaLiberada = req.path === "/auth/me" || req.path === "/auth/logout" || req.path === "/perfil";
  if (usuarioExpirado(usuario) && !rotaLiberada) {
    return res.status(403).json({ erro: "Seu teste grátis expirou. Solicite a liberação do acesso." });
  }
 
  req.usuario = usuario;
  requestContext.run({ usuario_id: usuario.id }, () => next());
}
 
app.post("/auth/register", (req, res) => {
  const { nomeEmpresa, nomeResponsavel, telefone, email, senha } = req.body;
 
  if (!nomeEmpresa || !email || !senha) {
    return res.status(400).json({ erro: "Informe empresa, email e senha" });
  }
 
  const emailLimpo = String(email).trim().toLowerCase();
  if (db.prepare("SELECT id FROM usuarios WHERE email=?").get(emailLimpo)) {
    return res.status(400).json({ erro: "Este email já possui cadastro" });
  }
 
  const senhaNova = hashSenha(senha);
  const criado = new Date().toISOString();
  const testeAte = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
 
  const result = db.prepare(`
    INSERT INTO usuarios (nome_responsavel, nome_empresa, telefone, email, senha_hash, senha_salt, criado_em, teste_ate, ativo)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)
  `).run(nomeResponsavel || "", nomeEmpresa, telefone || "", emailLimpo, senhaNova.hash, senhaNova.salt, criado, testeAte);
 
  const token = criarToken(result.lastInsertRowid);
  res.json({ ok: true, token, dias_restantes: 7 });
});
 
app.post("/auth/login", (req, res) => {
  const email = String(req.body.email || "").trim().toLowerCase();
  const senha = String(req.body.senha || "");
  const usuario = db.prepare("SELECT * FROM usuarios WHERE email=?").get(email);
 
  if (!usuario || !senhaConfere(senha, usuario.senha_salt, usuario.senha_hash)) {
    return res.status(401).json({ erro: "Email ou senha inválidos" });
  }
 
  const token = criarToken(usuario.id);
  res.json({ ok: true, token, dias_restantes: diasTesteRestantes(usuario), expirado: usuarioExpirado(usuario) });
});
 
app.get("/auth/me", requireAuth, (req, res) => {
  const u = req.usuario;
  res.json({
    ok: true,
    usuario: {
      id: u.id,
      nome_responsavel: u.nome_responsavel,
      nome_empresa: u.nome_empresa,
      telefone: u.telefone,
      email: u.email,
      endereco: u.endereco,
      cidade_bairro: u.cidade_bairro,
      logo_base64: u.logo_base64,
      criado_em: u.criado_em,
      teste_ate: u.teste_ate,
      dias_restantes: diasTesteRestantes(u),
      expirado: usuarioExpirado(u)
    }
  });
});
 
app.post("/auth/logout", requireAuth, (req, res) => {
  const auth = req.headers.authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : req.body.token;
  if (token) db.prepare("DELETE FROM sessoes WHERE token=?").run(token);
  res.json({ ok: true });
});
 
app.get("/perfil", requireAuth, (req, res) => {
  res.json({ ok: true, perfil: perfilEmpresaAtual(), dias_restantes: diasTesteRestantes(req.usuario), expirado: usuarioExpirado(req.usuario) });
});
 
app.post("/perfil", requireAuth, (req, res) => {
  const { nomeEmpresa, nomeResponsavel, telefone, emailEmpresa, endereco, cidadeBairro, logoBase64 } = req.body;
  db.prepare(`
    UPDATE usuarios
    SET nome_empresa=?, nome_responsavel=?, telefone=?, email=?, endereco=?, cidade_bairro=?, logo_base64=?
    WHERE id=?
  `).run(
    nomeEmpresa || "",
    nomeResponsavel || "",
    telefone || "",
    String(emailEmpresa || req.usuario.email).trim().toLowerCase(),
    endereco || "",
    cidadeBairro || "",
    logoBase64 || req.usuario.logo_base64 || "",
    req.usuario.id
  );
 
  res.json({ ok: true });
});
 
// Daqui para baixo, todo o sistema exige login.
app.use(requireAuth);
 
 
// ============================
// PRODUTOS
// ============================
 
app.post("/config/produto", (req, res) => {
  let { nome, preco } = req.body;
  preco = String(preco).replace(",", ".");
  const usuarioId = usuarioAtualId();
 
  db.prepare(`
    INSERT INTO produtos (usuario_id, nome, preco)
    VALUES (?, ?, ?)
    ON CONFLICT(usuario_id, nome)
    DO UPDATE SET preco=excluded.preco
  `).run(usuarioId, nome, Number(preco));
 
  res.json({ ok: true });
});
 
app.get("/config/produtos", (req, res) => {
  res.json(db.prepare("SELECT * FROM produtos WHERE usuario_id=? ORDER BY nome").all(usuarioAtualId()));
});
 
app.put("/config/produto/:id", (req, res) => {
  const id = req.params.id;
  let { nome, preco } = req.body;
  preco = String(preco).replace(",", ".");
 
  db.prepare(`
    UPDATE produtos
    SET nome=?, preco=?
    WHERE id=? AND usuario_id=?
  `).run(nome, Number(preco), id, usuarioAtualId());
 
  res.json({ ok: true });
});
 
app.delete("/config/produto/:id", (req, res) => {
  db.prepare("DELETE FROM produtos WHERE id=? AND usuario_id=?").run(req.params.id, usuarioAtualId());
  res.json({ ok: true });
});
 
// ============================
// ORÇAMENTOS SALVOS
// ============================
 
app.post("/orcamentos", (req, res) => {
  const { cliente, obra, valor_total, dados } = req.body;
 
  const criado_em = new Date().toISOString();
 
  const result = db.prepare(`
    INSERT INTO orcamentos (usuario_id, cliente, obra, valor_total, dados, criado_em)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    usuarioAtualId(),
    cliente || "",
    obra || "",
    Number(valor_total || 0),
    JSON.stringify(dados || {}),
    criado_em
  );
 
  res.json({ ok: true, id: result.lastInsertRowid });
});
 
app.get("/orcamentos", (req, res) => {
  const lista = db.prepare(`
    SELECT id, cliente, obra, valor_total, criado_em
    FROM orcamentos
    WHERE usuario_id=?
    ORDER BY id DESC
  `).all(usuarioAtualId());
 
  res.json(lista);
});
 
app.get("/orcamentos/:id", (req, res) => {
  const item = db.prepare("SELECT * FROM orcamentos WHERE id=? AND usuario_id=?").get(req.params.id, usuarioAtualId());
 
  if (!item) {
    return res.json({ erro: "Orçamento não encontrado" });
  }
 
  item.dados = JSON.parse(item.dados || "{}");
 
  res.json(item);
});
 
app.put("/orcamentos/:id", (req, res) => {
  const { cliente, obra, valor_total, dados } = req.body;
 
  db.prepare(`
    UPDATE orcamentos
    SET cliente=?, obra=?, valor_total=?, dados=?
    WHERE id=? AND usuario_id=?
  `).run(
    cliente || "",
    obra || "",
    Number(valor_total || 0),
    JSON.stringify(dados || {}),
    req.params.id,
    usuarioAtualId()
  );
 
  res.json({ ok: true });
});
 
app.delete("/orcamentos/:id", (req, res) => {
  db.prepare("DELETE FROM orcamentos WHERE id=? AND usuario_id=?").run(req.params.id, usuarioAtualId());
  res.json({ ok: true });
});
 
// ============================
// CONFIG
// ============================
 
function getConfig(chave) {
  const c = db.prepare("SELECT valor FROM config WHERE usuario_id=? AND chave=?").get(usuarioAtualId() || 1, chave);
  return c ? c.valor : null;
}
 
function setConfig(chave, valor) {
  db.prepare(`
    INSERT INTO config (usuario_id, chave, valor)
    VALUES (?, ?, ?)
    ON CONFLICT(usuario_id, chave)
    DO UPDATE SET valor=excluded.valor
  `).run(usuarioAtualId() || 1, chave, valor);
}
 
app.post("/config", (req, res) => {
  const { usarSobra, usarMeia } = req.body;
 
  setConfig("usarSobra", usarSobra);
  setConfig("usarMeia", usarMeia);
 
  res.json({ ok: true });
});
 
app.get("/config", (req, res) => {
  res.json({
    usarSobra: getConfig("usarSobra") !== "false",
    usarMeia: getConfig("usarMeia") !== "false"
  });
});
 
// ============================
// FUNÇÕES
// ============================
 
function normalizarTexto(texto) {
  return String(texto || "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}
 
function getPreco(nome) {
  const nomeNormalizado = normalizarTexto(nome);
  const usuarioId = usuarioAtualId() || 1;
  const produtos = db.prepare("SELECT nome, preco FROM produtos WHERE usuario_id=?").all(usuarioId);
 
  const encontrado = produtos.find(p =>
    normalizarTexto(p.nome) === nomeNormalizado
  );
 
  return encontrado ? Number(encontrado.preco) : 0;
}
 
function getTabela(nome) {
  const usuarioId = usuarioAtualId() || 1;
  const item = db.prepare("SELECT valor FROM tabela_precos WHERE usuario_id=? AND nome=?").get(usuarioId, nome)
    || db.prepare("SELECT valor FROM tabela_precos WHERE nome=? LIMIT 1").get(nome);
  return item ? Number(item.valor) : 0;
}
 
function calcularAreaM2(largura, altura, quantidade = 1) {
  return ((largura * altura) / 1000000) * quantidade;
}
 
function definirPrazo(categoria, espessura = 8) {
  if (categoria === "pronta") return "Pronta entrega";
 
  if (categoria === "engenharia") {
    if (Number(espessura) === 8) return "5 a 10 dias úteis";
    if (Number(espessura) === 10) return "10 a 15 dias úteis";
    if (Number(espessura) >= 12) return "Até 30 dias úteis";
  }
 
  return "A combinar";
}
 
function labelCor(cor) {
  if (cor === "incolor") return "Incolor";
  if (cor === "verde") return "Verde";
  if (cor === "fume") return "Fumê";
  if (cor === "bronze") return "Bronze";
  return "Incolor";
}
 
function nomeVidro({ categoria, cor, espessura = 8 }) {
  const corNome = labelCor(cor);
 
  if (categoria === "pronta") {
    return `Vidro PE ${corNome}`;
  }
 
  return `Vidro ${corNome} ${espessura}mm`;
}
 
function nomePivotantePE(cor) {
  return `Porta Pivotante PE ${labelCor(cor)}`;
}
 
function nomeCCTP(corAluminio) {
  if (corAluminio === "preto") return "Cctp Preto";
  if (corAluminio === "branco") return "Cctp Branco";
  return "Cctp Natural Fosco";
}
 
function nomeSiliconeAcabamento(corAluminio) {
  if (corAluminio === "preto") return "Silicone Preto";
  if (corAluminio === "branco") return "Silicone Branco";
  return "Silicone Incolor";
}
 
function nomeKitBox({ largura, corAluminio = "natural_fosco" }) {
  const larguraNum = Number(largura) || 0;
  const tamanho = Math.ceil(larguraNum / 100) * 100;
 
  if (corAluminio === "preto") {
    return `Kit Box F1 Preto ${tamanho}`;
  }
 
  if (corAluminio === "branco") {
    return `Kit Box F1 Branco ${tamanho}`;
  }
 
  return `Kit Box F1 Fosco ${tamanho}`;
}
 
// ============================
// VIDROS CCTP
// ============================
 
function calcularVidrosCCTP({ largura, altura, folhas = 2, trilho = "sobreposto" }) {
  const larguraBase = largura / folhas;
 
  const alturaFixo = trilho === "embutido" ? altura - 25 : altura - 65;
  const alturaMovel = trilho === "embutido" ? altura : altura - 25;
 
  const quantidadeFixos = folhas === 4 ? 2 : 1;
  const quantidadeMoveis = folhas === 4 ? 2 : 1;
 
  const vidros = {
    fixo: {
      descricao: "Vidro fixo",
      quantidade: quantidadeFixos,
      largura: Math.round(larguraBase),
      altura: Math.round(alturaFixo),
      area_m2: calcularAreaM2(larguraBase, alturaFixo, quantidadeFixos)
    },
    movel: {
      descricao: "Vidro móvel",
      quantidade: quantidadeMoveis,
      largura: Math.round(larguraBase + 50),
      altura: Math.round(alturaMovel),
      area_m2: calcularAreaM2(larguraBase + 50, alturaMovel, quantidadeMoveis)
    }
  };
 
  return {
    trilho,
    folhas,
    vidros,
    area_total_m2: vidros.fixo.area_m2 + vidros.movel.area_m2
  };
}
 
// ============================
// ESTOQUE
// ============================
 
function usarEstoque(material, totalNecessario) {
  const sobras = db.prepare(`
    SELECT * FROM estoque
    WHERE usuario_id=? AND material=?
    ORDER BY sobra_mm DESC
  `).all(usuarioAtualId() || 1, material);
 
  for (let item of sobras) {
    if (item.sobra_mm >= totalNecessario) {
      db.prepare("DELETE FROM estoque WHERE id=?").run(item.id);
 
      const novaSobra = item.sobra_mm - totalNecessario;
 
      if (novaSobra > 0) {
        db.prepare(`
          INSERT INTO estoque (usuario_id, material, sobra_mm)
          VALUES (?, ?, ?)
        `).run(usuarioAtualId() || 1, material, novaSobra);
      }
 
      return { usado_estoque: true };
    }
  }
 
  return { usado_estoque: false };
}
 
function calcularMaterial(material, total) {
  const usarSobra = getConfig("usarSobra") !== "false";
  const usarMeia = getConfig("usarMeia") !== "false";
 
  const barraInteira = 6000;
  const meiaBarra = 3000;
 
  if (usarSobra) {
    const uso = usarEstoque(material, total);
 
    if (uso.usado_estoque) {
      return {
        barras: 0,
        tipo_barra: "estoque",
        barras_display: "estoque",
        sobra_mm: 0
      };
    }
  }
 
  if (usarMeia && total <= meiaBarra) {
    const sobra = meiaBarra - total;
 
    if (usarSobra) {
      db.prepare(`
        INSERT INTO estoque (usuario_id, material, sobra_mm)
        VALUES (?, ?, ?)
      `).run(usuarioAtualId() || 1, material, sobra);
    }
 
    return {
      barras: 1,
      tipo_barra: "meia",
      barras_display: "0.5 barra (3m)",
      sobra_mm: sobra
    };
  }
 
  const barras = Math.ceil(total / barraInteira);
  const sobra = (barras * barraInteira) - total;
 
  if (usarSobra) {
    db.prepare(`
      INSERT INTO estoque (usuario_id, material, sobra_mm)
      VALUES (?, ?, ?)
    `).run(usuarioAtualId() || 1, material, sobra);
  }
 
  return {
    barras,
    tipo_barra: "inteira",
    barras_display: `${barras} barra(s) (6m)`,
    sobra_mm: sobra
  };
}
 
// ============================
// CUSTOS
// ============================
 
function calcularCustoMaterial(item) {
  if (!item) return 0;
 
  if (item.calculo_manual) {
    return Number(item.custo || 0);
  }
 
  const preco = Number(item.preco || 0);
 
  if (!preco) return 0;
 
  if (item.tipo_barra === "estoque") return 0;
  if (item.tipo_barra === "meia") return preco * 0.5;
  if (item.tipo_barra === "inteira") return preco * Number(item.barras || 1);
 
  // Importante: quantidade 0 precisa continuar valendo 0.
  // Antes o sistema tratava 0 como falso e acabava cobrando 1 unidade.
  if (item.quantidade !== undefined && item.quantidade !== null) {
    return preco * Number(item.quantidade || 0);
  }
 
  return preco;
}
 
function calcularTotais(materiais, margem = 0) {
  let custo_total = 0;
 
  for (let nome in materiais) {
    const item = materiais[nome];
    item.custo = calcularCustoMaterial(item);
    custo_total += item.custo;
  }
 
  const lucro = custo_total * (margem / 100);
  const valor_venda = custo_total + lucro;
 
  return { custo_total, lucro, valor_venda };
}
 
function calcularCustoVidro({ categoria, cor, espessura, area_total_m2 }) {
  const chave = nomeVidro({ categoria, cor, espessura });
  const precoM2 = getPreco(chave);
 
  return {
    chave,
    preco_m2: precoM2,
    custo: area_total_m2 * precoM2
  };
}
 
function adicionarAvulsos(materiais, avulsos = []) {
  avulsos.forEach((item, index) => {
    if (!item.nome) return;
 
    const preco = getPreco(item.nome);
    let quantidade = Number(item.quantidade);
 
    if (!quantidade) quantidade = 1;
 
    // Compatibilidade para versões do HTML que enviem vidro avulso por medida.
    // Se vier largura/altura em mm, o sistema calcula a quantidade em m².
    const largura = Number(item.largura || 0);
    const altura = Number(item.altura || 0);
 
    if (largura > 0 && altura > 0) {
      quantidade = calcularAreaM2(largura, altura, quantidade);
    }
 
    materiais[`Avulso ${index + 1} - ${item.nome}`] = {
      quantidade: Number(quantidade.toFixed ? quantidade.toFixed(3) : quantidade),
      unidade: largura > 0 && altura > 0 ? "m²" : "un",
      preco,
      custo: preco * quantidade,
      calculo_manual: true
    };
  });
 
  return materiais;
}
 
// ============================
// MATERIAIS CCTP
// ============================
 
function montarMateriaisCCTP({ tipo, largura, altura, corAluminio = "natural_fosco" }) {
  const cctp = nomeCCTP(corAluminio);
  const siliconeAcabamento = nomeSiliconeAcabamento(corAluminio);
 
  const base = {
    [cctp]: {
      quantidade: 1,
      ...calcularMaterial(cctp, largura),
      preco: getPreco(cctp)
    },
    "Silicone Incolor": {
      quantidade: 1,
      preco: getPreco("Silicone Incolor")
    },
    "Parafuso": {
      quantidade: 15,
      preco: getPreco("Parafuso")
    },
    "Bucha": {
      quantidade: 15,
      preco: getPreco("Bucha")
    }
  };
 
  if (siliconeAcabamento !== "Silicone Incolor") {
    base[siliconeAcabamento] = {
      quantidade: 1,
      preco: getPreco(siliconeAcabamento)
    };
  }
 
  if (tipo === "porta4" || tipo === "porta4_puxador" || tipo === "porta4_sem_puxador" || tipo === "janela4") {
    return {
      "PU 8mm": {
        quantidade: 2,
        ...calcularMaterial("PU 8mm", altura * 2),
        preco: getPreco("PU 8mm")
      },
      "Veda Poeira": {
        quantidade: 2,
        ...calcularMaterial("Veda Poeira", altura * 2),
        preco: getPreco("Veda Poeira")
      },
      "Veda Press": {
        quantidade: 1,
        ...calcularMaterial("Veda Press", altura),
        preco: getPreco("Veda Press")
      },
      ...base,
      "Puxador": {
        quantidade: tipo === "porta4_sem_puxador" || tipo === "janela4" ? 0 : 2,
        preco: getPreco("Puxador")
      },
      "Fechadura 3530 V/V": {
        quantidade: 1,
        preco: getPreco("Fechadura 3530 V/V")
      },
      "Roldana": {
        quantidade: 4,
        preco: getPreco("Roldana")
      },
      "Batedor central": {
        quantidade: 1,
        preco: getPreco("Batedor central")
      },
      "Batedor inferior": {
        quantidade: 2,
        preco: getPreco("Batedor inferior")
      }
    };
  }
 
  if (tipo === "porta150" || tipo === "porta2" || tipo === "porta_esconder" || tipo === "janela2") {
    return {
      "PU 8mm": {
        quantidade: 1,
        ...calcularMaterial("PU 8mm", altura),
        preco: getPreco("PU 8mm")
      },
      "PU 10mm": {
        quantidade: 1,
        ...calcularMaterial("PU 10mm", altura),
        preco: getPreco("PU 10mm")
      },
      "Veda Poeira": {
        quantidade: 1,
        ...calcularMaterial("Veda Poeira", altura),
        preco: getPreco("Veda Poeira")
      },
      ...base,
      "Puxador": {
        quantidade: tipo === "janela2" ? 0 : 1,
        preco: getPreco("Puxador")
      },
      "Fechadura 3530 V/A": {
        quantidade: 1,
        preco: getPreco("Fechadura 3530 V/A")
      },
      "Bate-fecha v/v": {
        quantidade: tipo === "janela2" ? 1 : 0,
        preco: getPreco("Bate-fecha v/v")
      },
      "Bate-fecha v/a": {
        quantidade: tipo === "janela2" ? 1 : 0,
        preco: getPreco("Bate-fecha v/a")
      },
      "Roldana": {
        quantidade: 2,
        preco: getPreco("Roldana")
      },
      "Batedor central": {
        quantidade: 1,
        preco: getPreco("Batedor central")
      }
    };
  }
 
  return {};
}
 
 
function nomeTipoOrcamento(tipo, largura, altura) {
  if (tipo === "porta4" || tipo === "porta4_puxador") return `Porta 4 folhas com puxador ${largura}x${altura}`;
  if (tipo === "porta4_sem_puxador") return `Porta 4 folhas sem puxador ${largura}x${altura}`;
  if (tipo === "porta150" || tipo === "porta2") return `Porta 2 folhas ${largura}x${altura}`;
  if (tipo === "porta_esconder") return `Porta de esconder ${largura}x${altura}`;
  if (tipo === "janela4") return `Janela 4 folhas ${largura}x${altura}`;
  if (tipo === "janela2") return `Janela 2 folhas ${largura}x${altura}`;
  return `${tipo} ${largura}x${altura}`;
}
 
// ============================
// ORÇAMENTO
// ============================
 
app.get("/orcamento", (req, res) => {
  const tipo = req.query.tipo;
  const categoria = req.query.categoria || "pronta";
  const cor = req.query.cor || "incolor";
  const trilho = req.query.trilho || "sobreposto";
  const espessura = Number(req.query.espessura) || 8;
  const corAluminio = req.query.corAluminio || "natural_fosco";
 
  const largura = Number(req.query.largura);
  const altura = Number(req.query.altura);
  const margem = Number(req.query.margem) || 0;
 
  let avulsos = [];
 
  try {
    avulsos = JSON.parse(req.query.avulsos || "[]");
  } catch (e) {
    avulsos = [];
  }
 
  if (!largura || !altura) {
    return res.json({ erro: "Informe largura e altura" });
  }
 
  if (tipo === "porta4" || tipo === "porta4_puxador" || tipo === "porta4_sem_puxador" || tipo === "porta150" || tipo === "porta2" || tipo === "porta_esconder" || tipo === "janela2" || tipo === "janela4") {
    const folhas = (tipo === "porta4" || tipo === "porta4_puxador" || tipo === "porta4_sem_puxador" || tipo === "janela4") ? 4 : 2;
 
    let materiais = montarMateriaisCCTP({
      tipo,
      largura,
      altura,
      corAluminio
    });
 
    const calculoVidros = calcularVidrosCCTP({
      largura,
      altura,
      folhas,
      trilho
    });
 
    const custoVidro = calcularCustoVidro({
      cor,
      categoria,
      espessura,
      area_total_m2: calculoVidros.area_total_m2
    });
 
    materiais[custoVidro.chave] = {
      quantidade: Number(calculoVidros.area_total_m2.toFixed(2)),
      unidade: "m²",
      preco: custoVidro.preco_m2,
      custo: custoVidro.custo,
      calculo_manual: true
    };
 
    materiais = adicionarAvulsos(materiais, avulsos);
 
    const totais = calcularTotais(materiais, margem);
 
    return res.json({
      tipo: nomeTipoOrcamento(tipo, largura, altura),
      categoria,
      cor,
      corAluminio,
      trilho,
      espessura,
      prazo: definirPrazo(categoria, espessura),
      vidros: calculoVidros.vidros,
      area_total_vidro_m2: Number(calculoVidros.area_total_m2.toFixed(2)),
      preco_m2_vidro: custoVidro.preco_m2,
      produto_vidro: custoVidro.chave,
      ...totais,
      materiais
    });
  }
 
  if (tipo === "pivotante") {
    const area = (largura / 1000) * (altura / 1000);
 
    const chave =
      categoria === "pronta"
        ? nomePivotantePE(cor)
        : nomeVidro({ categoria, cor, espessura });
 
    let materiais = {
      [chave]: {
        quantidade: Number(area.toFixed(2)),
        unidade: "m²",
        preco: getPreco(chave),
        custo: area * getPreco(chave),
        calculo_manual: true
      },
      "Kit Pivotante": {
        quantidade: 1,
        preco: getPreco("Kit Pivotante")
      },
      "Puxador": {
        quantidade: 1,
        preco: getPreco("Puxador")
      },
      "Silicone Incolor": {
        quantidade: 1,
        preco: getPreco("Silicone Incolor")
      }
    };
 
    materiais = adicionarAvulsos(materiais, avulsos);
 
    const totais = calcularTotais(materiais, margem);
 
    return res.json({
      tipo: `Porta pivotante ${largura}x${altura}`,
      categoria,
      cor,
      corAluminio,
      espessura,
      prazo: definirPrazo(categoria, espessura),
      area_total_vidro_m2: Number(area.toFixed(2)),
      produto_vidro: chave,
      ...totais,
      materiais
    });
  }
 
  if (tipo === "espelho") {
    const modelo = req.query.tipoEspelho || req.query.modelo || "lapidado";
    const area = (largura / 1000) * (altura / 1000);
 
    let chave = "espelho_lapidado";
 
    if (modelo === "bisotado") chave = "espelho_bisotado";
    if (modelo === "redondo") chave = "espelho_redondo";
    if (modelo === "organico") chave = "espelho_organico";
 
    const precoM2 = getTabela(chave) || getPreco(chave);
    const custo_total = area * precoM2;
    const lucro = custo_total * (margem / 100);
    const valor_venda = custo_total + lucro;
 
    return res.json({
      tipo: `Espelho ${modelo}`,
      area_m2: Number(area.toFixed(2)),
      preco_m2: precoM2,
      custo_total,
      lucro,
      valor_venda,
      prazo: "A combinar"
    });
  }
 
  if (tipo === "box" || tipo === "box_canto") {
    const area = (largura / 1000) * (altura / 1000);
    const precoM2 = getTabela(`box_${cor}`) || getTabela("box") || getPreco(`Vidro ${labelCor(cor)} ${espessura}mm`);
    const kitBox = nomeKitBox({ largura, corAluminio });
 
    let materiais = {
      [`Vidro ${labelCor(cor)} ${espessura}mm`]: {
        quantidade: Number(area.toFixed(2)),
        unidade: "m²",
        preco: precoM2,
        custo: area * precoM2,
        calculo_manual: true
      },
      [kitBox]: {
        quantidade: 1,
        preco: getPreco(kitBox)
      },
      "Silicone Incolor": {
        quantidade: 1,
        preco: getPreco("Silicone Incolor")
      }
    };
 
    materiais = adicionarAvulsos(materiais, avulsos);
 
    const totais = calcularTotais(materiais, margem);
 
    return res.json({
      tipo: tipo === "box_canto" ? `Box de canto ${cor}` : `Box frontal ${cor}`,
      cor,
      area_m2: Number(area.toFixed(2)),
      preco_m2: precoM2,
      prazo: definirPrazo(categoria, espessura),
      ...totais,
      materiais
    });
  }
 
  res.json({ erro: "Tipo inválido" });
});
 
// ============================
// PDF
// ============================
 
function empresaParaPDF() {
  return perfilEmpresaAtual();
}
 
function logoBufferDaEmpresa(empresa) {
  if (!empresa || !empresa.logo_base64) return null;
  const texto = String(empresa.logo_base64);
  const m = texto.match(/^data:image\/[a-zA-Z0-9.+-]+;base64,(.+)$/);
  if (!m) return null;
  try {
    return Buffer.from(m[1], "base64");
  } catch (e) {
    return null;
  }
}
 
function dinheiro(valor) {
  return `R$ ${Number(valor || 0).toFixed(2)}`;
}
 
function textoSeguro(valor, padrao = "-") {
  const texto = String(valor || "").trim();
  return texto || padrao;
}
 
function formatarDataHora() {
  return new Date().toLocaleString("pt-BR", {
    timeZone: "America/Sao_Paulo",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  });
}
 
function desenharBox(doc, x, y, w, h) {
  doc.roundedRect(x, y, w, h, 6).strokeColor("#222").lineWidth(0.7).stroke();
}
 
 
 
function desenharLogoPDF(doc, logoSource, x, y, w, h, empresa = null) {
  desenharBox(doc, x, y, w, h);
 
  let podeUsarImagem = false;
  try {
    podeUsarImagem = Buffer.isBuffer(logoSource) || (typeof logoSource === "string" && fs.existsSync(logoSource));
  } catch (e) {
    podeUsarImagem = false;
  }
 
  if (podeUsarImagem) {
    try {
      const img = doc.openImage(logoSource);
      const scale = Math.max(w / img.width, h / img.height);
      const iw = img.width * scale;
      const ih = img.height * scale;
      const ix = x + (w - iw) / 2;
      const iy = y + (h - ih) / 2;
 
      doc.save();
      doc.roundedRect(x + 1.2, y + 1.2, w - 2.4, h - 2.4, 10).clip();
      doc.image(logoSource, ix, iy, { width: iw, height: ih });
      doc.restore();
 
      doc.roundedRect(x, y, w, h, 6).strokeColor("#222").lineWidth(0.7).stroke();
      return;
    } catch (e) {
      // Cai no texto abaixo se a imagem falhar.
    }
  }
 
  const nome = empresa?.nome || "VIDRAÇARIA";
  textoDentro(doc, nome, x + 12, y + 30, { bold: true, size: 12, color: "#003366", width: w - 24, align: "center" });
}
 
function ehItemAvulso(item) {
  const tipo = normalizarTexto(item?.formulario?.tipo || item?.resultado?.tipo || item?.nome || "");
  return item?.tipoAvulso === true || tipo.includes("avulso");
}
 
function resumoItemAvulso(item, mostrarValor = true) {
  const materiais = item?.resultado?.materiais || {};
  const nomes = Object.keys(materiais);
 
  if (!nomes.length) {
    return textoSeguro(item?.nome || item?.resultado?.tipo || "Item avulso");
  }
 
  return nomes.map(nome => {
    const m = materiais[nome] || {};
    const qtd = m.quantidade !== undefined ? m.quantidade : 1;
    const unidade = m.unidade ? ` ${m.unidade}` : "";
    const valor = mostrarValor ? ` | ${dinheiro(m.custo || ((m.preco || 0) * qtd))}` : "";
    return `${nome} | Qtd: ${qtd}${unidade}${valor}`;
  }).join("\n");
}
 
function textoDentro(doc, texto, x, y, opcoes = {}) {
  doc.fillColor(opcoes.color || "#111")
    .font(opcoes.bold ? "Helvetica-Bold" : "Helvetica")
    .fontSize(opcoes.size || 8)
    .text(texto, x, y, opcoes);
}
 
function descreverMateriaisResumo(materiais = {}) {
  const nomes = Object.keys(materiais || {});
  const vidro = nomes.find(n => normalizarTexto(n).includes("vidro")) || "Vidro conforme item";
  const aluminio = nomes.find(n =>
    normalizarTexto(n).includes("cctp") ||
    normalizarTexto(n).includes("kit box") ||
    normalizarTexto(n).includes("cantoneira") ||
    normalizarTexto(n).includes("pu ")
  ) || "Alumínio/acessórios conforme instalação";
 
  return {
    vidro,
    aluminio,
    descricao: `${vidro}; ${aluminio}.`
  };
}
 
 
function arquivoExiste(caminho) {
  try {
    return fs.existsSync(caminho);
  } catch (e) {
    return false;
  }
}
 
function candidatosImagemProjeto(item) {
  const tipoFormulario = normalizarTexto(item?.formulario?.tipo || "");
  const tipoTexto = normalizarTexto(item?.resultado?.tipo || item?.nome || "");
  const tipo = `${tipoFormulario} ${tipoTexto}`;
 
  if (tipo.includes("porta4_sem_puxador") || (tipo.includes("porta 4") && tipo.includes("sem puxador"))) {
    return ["porta4_sem_puxador.png", "Porta 4 folhas Sem Puxador.png", "porta 4 folhas sem puxador.png"];
  }
 
  if (tipo.includes("porta4") || tipo.includes("porta 4") || tipo.includes("porta4_puxador")) {
    return ["porta4_puxador.png", "Porta 4 folhas com Puxador.png", "porta 4 folhas com puxador.png"];
  }
 
  if (tipo.includes("janela4") || tipo.includes("janela 4")) {
    return ["janela4.png", "Janela 4 folhas.png", "janela quatro folhas.png"];
  }
 
  if (tipo.includes("porta_esconder") || tipo.includes("esconder")) {
    return ["porta_esconder.png", "Porta de Esconder.png", "porta de esconder.png"];
  }
 
  if (tipo.includes("porta2") || tipo.includes("porta150") || tipo.includes("porta 2") || tipo.includes("correr 2")) {
    return ["porta2.png", "Porta de Correr  2 Folhas.png", "Porta de Correr 2 Folhas.png", "porta de correr 2 folhas.png"];
  }
 
  if (tipo.includes("pivotante")) {
    return ["pivotante.png", "Porta pivotante.png", "porta_pivotante.png"];
  }
 
  if (tipo.includes("janela2") || tipo.includes("janela 2")) {
    return ["janela2.png", "Janela 2 folhas.png", "janela dois folhas.png"];
  }
 
  if (tipo.includes("box_canto") || tipo.includes("box de canto") || tipo.includes("canto")) {
    return ["box_canto.png", "Box de Canto.png", "box de canto.png"];
  }
 
  if (tipo.includes("box")) {
    return ["box.png", "box_frontal_2f.png", "Box Frontal 2 Folhas.png", "box frontal 2 folhas.png"];
  }
 
  if (tipo.includes("espelho")) {
    return ["espelho.png", "Espelho.png"];
  }
 
  return [];
}
 
function encontrarImagemProjeto(item) {
  const pastas = [
    path.join(__dirname, "imagens de projetos"),
    path.join(__dirname, "imagens-projetos"),
    path.join(__dirname, "imagens_projetos")
  ];
 
  const candidatos = candidatosImagemProjeto(item);
 
  for (const pasta of pastas) {
    for (const nome of candidatos) {
      const caminho = path.join(pasta, nome);
      if (arquivoExiste(caminho)) return caminho;
    }
  }
 
  return null;
}
 
function desenharElevacaoProjeto(doc, x, y, w, h, item) {
  const imagem = encontrarImagemProjeto(item);
 
  if (imagem) {
    try {
      doc.image(imagem, x, y, {
        fit: [w, h],
        align: "center",
        valign: "center"
      });
      return;
    } catch (e) {
      // Se a imagem falhar, usa o desenho simples abaixo para o PDF não quebrar.
    }
  }
 
  desenharElevacaoSimples(doc, x, y, w, h, item);
}
 
function desenharElevacaoSimples(doc, x, y, w, h, item) {
  doc.save();
  doc.strokeColor("#777").lineWidth(0.8);
  doc.rect(x, y, w, h).stroke();
 
  const tipo = normalizarTexto(item?.resultado?.tipo || item?.nome || "");
 
  if (tipo.includes("porta 4")) {
    for (let i = 1; i < 4; i++) {
      const xx = x + (w / 4) * i;
      doc.moveTo(xx, y).lineTo(xx, y + h).stroke();
    }
    doc.moveTo(x + w * 0.25, y + h * 0.08).lineTo(x + w * 0.55, y + h * 0.5).strokeColor("#b30000").stroke();
    doc.moveTo(x + w * 0.75, y + h * 0.08).lineTo(x + w * 0.45, y + h * 0.5).stroke();
  } else if (tipo.includes("box")) {
    doc.moveTo(x + w / 2, y).lineTo(x + w / 2, y + h).stroke();
    doc.strokeColor("#b30000").moveTo(x + w * 0.25, y + h * 0.55).lineTo(x + w * 0.75, y + h * 0.55).stroke();
  } else if (tipo.includes("pivotante")) {
    doc.circle(x + 6, y + 6, 2).stroke();
    doc.moveTo(x + 6, y + 6).lineTo(x + w - 8, y + h - 8).strokeColor("#b30000").stroke();
    doc.strokeColor("#777").circle(x + w - 10, y + h / 2, 1.7).stroke();
  } else if (tipo.includes("janela") || tipo.includes("porta 2")) {
    doc.moveTo(x + w / 2, y).lineTo(x + w / 2, y + h).stroke();
    doc.strokeColor("#b30000").moveTo(x + w * 0.25, y + h * 0.5).lineTo(x + w * 0.75, y + h * 0.5).stroke();
  } else {
    doc.moveTo(x, y).lineTo(x + w, y + h).strokeColor("#999").stroke();
    doc.moveTo(x + w, y).lineTo(x, y + h).stroke();
  }
 
  doc.restore();
}
 
function adicionarRodapePDF(doc) {
  const bottom = doc.page.height - 42;
  doc.moveTo(25, bottom - 8).lineTo(doc.page.width - 25, bottom - 8).strokeColor("#999").lineWidth(0.4).stroke();
  textoDentro(doc, "Observação: medidas e valores sujeitos à conferência técnica no local antes da produção.", 30, bottom, { size: 7, color: "#444" });
}
 
function criarPDFCliente(payload, res) {
  const dados = payload || {};
  const orcamento = dados.orcamento || {};
  const itens = orcamento.itens || [];
  const empresa = empresaParaPDF();
 
  const doc = new PDFDocument({ size: "A4", margin: 25 });
 
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", "inline; filename=proposta-orcamento-vb-vidracaria.pdf");
 
  doc.pipe(res);
 
  const pageW = doc.page.width;
  const logoPath = logoBufferDaEmpresa(empresa) || path.join(__dirname, "logo.png");
 
  // Cabeçalho
  desenharLogoPDF(doc, logoPath, 25, 25, 155, 78, empresa);
 
  desenharBox(doc, 185, 25, pageW - 210, 78);
  textoDentro(doc, "Proposta de Orçamento", 195, 39, { bold: true, size: 20, width: pageW - 230, align: "center" });
  doc.moveTo(190, 76).lineTo(pageW - 30, 76).strokeColor("#777").lineWidth(0.5).stroke();
  textoDentro(doc, `Emitido por: ${empresa.emitidoPor}`, 198, 84, { size: 7 });
  textoDentro(doc, formatarDataHora(), pageW - 155, 84, { size: 7, width: 120, align: "right" });
 
  // Dados cliente/empresa
  desenharBox(doc, 25, 118, pageW - 50, 83);
  textoDentro(doc, "Cliente:", 40, 132, { bold: true });
  textoDentro(doc, textoSeguro(dados.cliente), 82, 132, { width: 180 });
  textoDentro(doc, "Telefone:", 300, 132, { bold: true });
  textoDentro(doc, textoSeguro(dados.telefoneCliente), 350, 132, { width: 190 });
 
  textoDentro(doc, "Obra:", 40, 150, { bold: true });
  textoDentro(doc, textoSeguro(dados.obra), 82, 150, { width: 180 });
  textoDentro(doc, "Bairro:", 300, 150, { bold: true });
  textoDentro(doc, textoSeguro(dados.bairroObra), 350, 150, { width: 190 });
 
  textoDentro(doc, "End. obra:", 40, 168, { bold: true });
  textoDentro(doc, textoSeguro(dados.enderecoObra), 95, 168, { width: 445 });
  textoDentro(doc, "Contato VB:", 40, 186, { bold: true });
  textoDentro(doc, `${empresa.telefone}  |  ${empresa.email}`, 98, 186, { width: 440 });
 
  let y = 216;
 
  // Cabeçalho da tabela
  desenharBox(doc, 25, y, pageW - 50, 20);
  textoDentro(doc, "ELEVAÇÃO", 70, y + 6, { bold: true, size: 8 });
  textoDentro(doc, "DESCRIÇÃO", 300, y + 6, { bold: true, size: 8 });
  y += 30;
 
  itens.forEach((item, index) => {
    if (y > 675) {
      adicionarRodapePDF(doc);
      doc.addPage();
      y = 35;
    }
 
    const r = item.resultado || {};
    const f = item.formulario || {};
    const resumo = descreverMateriaisResumo(r.materiais || {});
 
    if (ehItemAvulso(item)) {
      const linhasAvulso = resumoItemAvulso(item, false).split("\n");
      const itemHAvulso = Math.max(54, 38 + (linhasAvulso.length * 12));
 
      textoDentro(doc, `Item ${index + 1}: Item avulso`, 55, y + 5, { bold: true, size: 9, width: 180 });
      textoDentro(doc, "Descrição:", 170, y + 5, { bold: true });
 
      let ly = y + 20;
      linhasAvulso.forEach((linha, idx) => {
        textoDentro(doc, `${idx + 1}. ${linha}`, 170, ly, { size: 8, width: 360 });
        ly += 12;
      });
 
      doc.moveTo(25, y + itemHAvulso - 6).lineTo(pageW - 25, y + itemHAvulso - 6).dash(2, { space: 3 }).strokeColor("#999").lineWidth(0.4).stroke();
      doc.undash();
      y += itemHAvulso;
      return;
    }
 
    const itemH = 112;
 
    desenharElevacaoProjeto(doc, 45, y + 8, 105, 72, item);
    textoDentro(doc, `${f.largura || "-"} mm`, 68, y + 73, { size: 7, width: 60, align: "center" });
    textoDentro(doc, `${f.altura || "-"} mm`, 30, y + 32, { size: 7, width: 40, align: "center" });
 
    textoDentro(doc, "Item:", 170, y + 5, { bold: true });
    textoDentro(doc, String(index + 1), 225, y + 5, { size: 8 });
    textoDentro(doc, "Tipo:", 170, y + 21, { bold: true });
    textoDentro(doc, textoSeguro(r.tipo || item.nome), 225, y + 21, { width: 310 });
    textoDentro(doc, "Localização:", 170, y + 37, { bold: true });
    textoDentro(doc, textoSeguro(f.localizacao || dados.obra || "Ambiente informado"), 225, y + 37, { width: 310 });
    textoDentro(doc, "L:", 170, y + 53, { bold: true });
    textoDentro(doc, `${f.largura || "-"}`, 190, y + 53, { width: 70 });
    textoDentro(doc, "H:", 270, y + 53, { bold: true });
    textoDentro(doc, `${f.altura || "-"}`, 290, y + 53, { width: 70 });
 
    textoDentro(doc, "Linha:", 365, y + 5, { bold: true });
    textoDentro(doc, resumo.vidro, 405, y + 5, { width: 140 });
    textoDentro(doc, "Alumínio:", 365, y + 21, { bold: true });
    textoDentro(doc, resumo.aluminio, 415, y + 21, { width: 130 });
    textoDentro(doc, "Descrição:", 365, y + 37, { bold: true });
    textoDentro(doc, resumo.descricao, 365, y + 51, { width: 175, size: 7 });
    doc.moveTo(25, y + itemH - 6).lineTo(pageW - 25, y + itemH - 6).dash(2, { space: 3 }).strokeColor("#999").lineWidth(0.4).stroke();
    doc.undash();
    y += itemH;
  });
 
  if (y > 635) {
    adicionarRodapePDF(doc);
    doc.addPage();
    y = 35;
  }
 
  desenharBox(doc, 25, y + 8, pageW - 50, 72);
  textoDentro(doc, "VALOR TOTAL DO ORÇAMENTO", 42, y + 21, { bold: true, size: 9 });
  textoDentro(doc, dinheiro(orcamento.valor_venda), 42, y + 40, { bold: true, size: 15, color: "#008000" });
 
  textoDentro(doc, "Condições de pagamento", 260, y + 21, { bold: true, size: 9 });
  textoDentro(doc, "Valor para pagamento à vista: Pix ou dinheiro.", 260, y + 38, { size: 8, width: 285 });
  textoDentro(doc, "Cartão de crédito: parcelamos em até 18x. Solicite simulação.", 260, y + 51, { size: 8, width: 285 });
  textoDentro(doc, "Taxa da maquininha fica por conta do cliente/comprador.", 260, y + 64, { bold: true, size: 8, width: 285, color: "#b30000" });
 
  textoDentro(doc, "Observação:", 25, y + 98, { bold: true });
  textoDentro(doc, "Proposta válida conforme medidas informadas. Não inclui serviços ou materiais não descritos nesta proposta.", 85, y + 98, { size: 8, width: 470 });
 
  adicionarRodapePDF(doc);
  doc.end();
}
 
 
 
function criarPDFTempera(payload, res) {
  const dados = payload || {};
  const orcamento = dados.orcamento || {};
  const itens = orcamento.itens || [];
  const empresa = empresaParaPDF();
 
  const doc = new PDFDocument({ size: "A4", margin: 25 });
 
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", "inline; filename=pedido-tempera-vb-vidracaria.pdf");
 
  doc.pipe(res);
 
  const pageW = doc.page.width;
  const logoPath = logoBufferDaEmpresa(empresa) || path.join(__dirname, "logo.png");
 
  desenharLogoPDF(doc, logoPath, 25, 25, 155, 78, empresa);
 
  desenharBox(doc, 185, 25, pageW - 210, 78);
  textoDentro(doc, "Pedido para Têmpera", 195, 39, { bold: true, size: 20, width: pageW - 230, align: "center" });
  doc.moveTo(190, 76).lineTo(pageW - 30, 76).strokeColor("#777").lineWidth(0.5).stroke();
  textoDentro(doc, `Emitido por: ${empresa.emitidoPor}`, 198, 84, { size: 7 });
  textoDentro(doc, formatarDataHora(), pageW - 155, 84, { size: 7, width: 120, align: "right" });
 
  desenharBox(doc, 25, 118, pageW - 50, 83);
  textoDentro(doc, "Cliente:", 40, 132, { bold: true });
  textoDentro(doc, textoSeguro(dados.cliente), 82, 132, { width: 180 });
  textoDentro(doc, "Telefone:", 300, 132, { bold: true });
  textoDentro(doc, textoSeguro(dados.telefoneCliente), 350, 132, { width: 190 });
 
  textoDentro(doc, "Obra:", 40, 150, { bold: true });
  textoDentro(doc, textoSeguro(dados.obra), 82, 150, { width: 180 });
  textoDentro(doc, "Bairro:", 300, 150, { bold: true });
  textoDentro(doc, textoSeguro(dados.bairroObra), 350, 150, { width: 190 });
 
  textoDentro(doc, "End. obra:", 40, 168, { bold: true });
  textoDentro(doc, textoSeguro(dados.enderecoObra), 95, 168, { width: 445 });
  textoDentro(doc, "Contato VB:", 40, 186, { bold: true });
  textoDentro(doc, `${empresa.telefone}  |  ${empresa.email}`, 98, 186, { width: 440 });
 
  let y = 216;
 
  desenharBox(doc, 25, y, pageW - 50, 20);
  textoDentro(doc, "ELEVAÇÃO", 70, y + 6, { bold: true, size: 8 });
  textoDentro(doc, "VIDROS / ALUMÍNIOS / ACESSÓRIOS PARA PRODUÇÃO", 235, y + 6, { bold: true, size: 8 });
  y += 30;
 
  itens.forEach((item, index) => {
    if (y > 660) {
      adicionarRodapePDF(doc);
      doc.addPage();
      y = 35;
    }
 
    const r = item.resultado || {};
    const f = item.formulario || {};
    const materiais = r.materiais || {};
    const materialNomes = Object.keys(materiais);
 
    if (ehItemAvulso(item)) {
      const linhasAvulso = resumoItemAvulso(item, false).split("\n");
      const alturaAvulso = Math.max(55, 38 + (linhasAvulso.length * 12));
 
      textoDentro(doc, `Item ${index + 1}: Itens avulsos`, 45, y + 5, { bold: true, size: 9, width: 140 });
      textoDentro(doc, "Lista de materiais avulsos:", 165, y + 5, { bold: true, size: 8 });
 
      let ly = y + 22;
      linhasAvulso.forEach((linha, idx) => {
        textoDentro(doc, `${idx + 1}. ${linha}`, 172, ly, { size: 7.5, width: 365 });
        ly += 12;
      });
 
      doc.moveTo(25, y + alturaAvulso - 6).lineTo(pageW - 25, y + alturaAvulso - 6).dash(2, { space: 3 }).strokeColor("#999").lineWidth(0.4).stroke();
      doc.undash();
      y += alturaAvulso;
      return;
    }
 
    const alturaBloco = Math.max(120, 70 + (materialNomes.length * 12));
 
    desenharElevacaoProjeto(doc, 38, y + 8, 105, 78, item);
    textoDentro(doc, `${f.largura || "-"} mm`, 58, y + 82, { size: 7, width: 70, align: "center" });
    textoDentro(doc, `${f.altura || "-"} mm`, 28, y + 38, { size: 7, width: 40, align: "center" });
 
    textoDentro(doc, `Item ${index + 1}: ${textoSeguro(r.tipo || item.nome)}`, 165, y + 5, { bold: true, size: 9, width: 370 });
    textoDentro(doc, `Medida geral: ${f.largura || "-"} x ${f.altura || "-"} mm`, 165, y + 22, { size: 8, width: 200 });
    textoDentro(doc, `Vidro/cor: ${labelCor(f.cor || r.cor || "incolor")} ${f.espessura || r.espessura || 8}mm`, 365, y + 22, { size: 8, width: 170 });
    textoDentro(doc, "Materiais calculados:", 165, y + 43, { bold: true, size: 8 });
 
    let my = y + 58;
    if (!materialNomes.length) {
      textoDentro(doc, "- Nenhum material calculado", 172, my, { size: 8, width: 350 });
      my += 12;
    }
 
    materialNomes.forEach(nome => {
      const m = materiais[nome] || {};
      const qtd = m.quantidade !== undefined ? m.quantidade : (m.barras_display || m.barras || 1);
      const unidade = m.unidade ? ` ${m.unidade}` : "";
      const linha = `- ${nome} | Qtd: ${qtd}${unidade}`;
 
      if (my > 745) {
        adicionarRodapePDF(doc);
        doc.addPage();
        my = 35;
      }
 
      textoDentro(doc, linha, 172, my, { size: 7.5, width: 365 });
      my += 12;
    });
 
    doc.moveTo(25, y + alturaBloco - 6).lineTo(pageW - 25, y + alturaBloco - 6).dash(2, { space: 3 }).strokeColor("#999").lineWidth(0.4).stroke();
    doc.undash();
    y += alturaBloco;
  });
 
  if (y > 690) {
    adicionarRodapePDF(doc);
    doc.addPage();
    y = 35;
  }
 
  desenharBox(doc, 25, y + 8, pageW - 50, 45);
  textoDentro(doc, "Observação para produção:", 42, y + 22, { bold: true });
  textoDentro(doc, "Conferir medidas, cores, espessuras, ferragens e acessórios antes de enviar para fabricação/têmpera.", 42, y + 38, { size: 8, width: 500 });
 
  adicionarRodapePDF(doc);
  doc.end();
}
 
app.post("/orcamento/pdf-cliente", (req, res) => {
  let payload = {};
 
  try {
    payload = JSON.parse(req.body.payload || "{}");
  } catch (e) {
    payload = {};
  }
 
  criarPDFCliente(payload, res);
});
 
 
 
app.post("/orcamento/pdf-tempera", (req, res) => {
  let payload = {};
 
  try {
    payload = JSON.parse(req.body.payload || "{}");
  } catch (e) {
    payload = {};
  }
 
  criarPDFTempera(payload, res);
});
 
app.get("/orcamento/pdf", (req, res) => {
  const payload = {
    cliente: req.query.cliente || "",
    obra: req.query.obra || "",
    telefoneCliente: req.query.telefoneCliente || "",
    enderecoObra: req.query.enderecoObra || "",
    bairroObra: req.query.bairroObra || "",
    orcamento: {
      tipo: req.query.tipo || "Orçamento",
      valor_venda: Number(req.query.valor || 0),
      custo_total: Number(req.query.valor || 0),
      itens: []
    }
  };
 
  criarPDFCliente(payload, res);
});
 
// ============================
// START / ONLINE
// ============================
 
// Railway usa a porta automática em process.env.PORT.
// No computador local continua funcionando na porta 3001.
const PORT = process.env.PORT || 3001;
 
app.listen(PORT, () => {
  console.log("Servidor rodando na porta " + PORT);
});
