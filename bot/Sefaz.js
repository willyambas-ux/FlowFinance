/**
 * Sefaz.js — consulta a NFC-e no portal da Secretaria da Fazenda do estado.
 *
 * Desde set/2025 o QR code da NFC-e (versão 3) é só "chave|3|1" nas notas
 * emitidas normalmente: dá para montar a consulta com a chave de acesso
 * impressa no cupom, sem precisar decodificar o QR.
 *
 * A página de cada estado tem um formato; por isso o texto da página vai para
 * a IA, que extrai os itens com a mesma ferramenta da foto.
 */
const Sefaz = (function () {
  // URL de consulta do QR code por código da UF (2 primeiros dígitos da chave).
  // Fonte: tabela de serviços do ACBr (ACBrNFeServicos.ini).
  const URL_QR = {
    '11': 'http://www.nfce.sefin.ro.gov.br/consultanfce/consulta.jsp',
    '12': 'http://www.sefaznet.ac.gov.br/nfce/qrcode',
    '13': 'http://sistemas.sefaz.am.gov.br/nfceweb/consultarNFCe.jsp',
    '14': 'https://www.sefaz.rr.gov.br/nfce/servlet/qrcode',
    '15': 'https://appnfc.sefa.pa.gov.br/portal/view/consultas/nfce/nfceForm.seam',
    '16': 'https://www.sefaz.ap.gov.br/nfce/nfcep.php',
    '17': 'http://apps.sefaz.to.gov.br/portal-nfce/qrcodeNFCe',
    '21': 'http://www.nfce.sefaz.ma.gov.br/portal/consultarNFCe.jsp',
    '22': 'http://webas.sefaz.pi.gov.br/nfceweb/consultarNFCe.jsf',
    '23': 'http://nfce.sefaz.ce.gov.br/pages/ShowNFCe.html',
    '24': 'https://nfce.sefaz.rn.gov.br/consultarNFCe.aspx',
    '25': 'http://www.sefaz.pb.gov.br/nfce',
    '26': 'http://nfce.sefaz.pe.gov.br/nfce-web/consultarNFCe',
    '27': 'http://nfce.sefaz.al.gov.br/QRCode/consultarNFCe.jsp',
    '28': 'http://www.nfce.se.gov.br/portal/consultarNFCe.jsp',
    '29': 'http://nfe.sefaz.ba.gov.br/servicos/nfce/modulos/geral/NFCEC_consulta_chave_acesso.aspx',
    '31': 'https://portalsped.fazenda.mg.gov.br/portalnfce/sistema/qrcode.xhtml',
    '32': 'http://app.sefaz.es.gov.br/ConsultaNFCe/qrcode.aspx',
    '33': 'https://consultadfe.fazenda.rj.gov.br/consultaNFCe/QRCode',
    '35': 'https://www.nfce.fazenda.sp.gov.br/NFCeConsultaPublica/Paginas/ConsultaQRCode.aspx',
    '41': 'http://www.dfeportal.fazenda.pr.gov.br/dfe-portal/rest/servico/consultaNFCe',
    '42': 'https://sat.sef.sc.gov.br/nfce/consulta',
    '43': 'https://www.sefaz.rs.gov.br/NFCE/NFCE-COM.aspx',
    '50': 'http://www.dfe.ms.gov.br/nfce/qrcode',
    '51': 'http://www.sefaz.mt.gov.br/nfce/consultanfce',
    '52': 'https://nfeweb.sefaz.go.gov.br/nfeweb/sites/nfce/danfeNFCe',
    '53': 'http://www.fazenda.df.gov.br/nfce/qrcode'
  };
  const SIGLA = { '11': 'RO', '12': 'AC', '13': 'AM', '14': 'RR', '15': 'PA', '16': 'AP', '17': 'TO', '21': 'MA', '22': 'PI', '23': 'CE', '24': 'RN', '25': 'PB', '26': 'PE', '27': 'AL', '28': 'SE', '29': 'BA', '31': 'MG', '32': 'ES', '33': 'RJ', '35': 'SP', '41': 'PR', '42': 'SC', '43': 'RS', '50': 'MS', '51': 'MT', '52': 'GO', '53': 'DF' };
  const LIMITE_TEXTO = 40000;
  // Endereços alternativos do mesmo portal: se um falhar (ex.: SSL antigo), tenta o outro.
  const ALTERNATIVOS = {
    'nfce.sefaz.rn.gov.br/consultarNFCe.aspx': ['nfce.sefaz.rn.gov.br/portalDFE/NFCe/mDadosNFCe.aspx', 'nfce.set.rn.gov.br/consultarNFCe.aspx'],
    'nfce.set.rn.gov.br/consultarNFCe.aspx': ['nfce.sefaz.rn.gov.br/consultarNFCe.aspx', 'nfce.sefaz.rn.gov.br/portalDFE/NFCe/mDadosNFCe.aspx']
  };

  function candidatos_(url) {
    const m = String(url).match(/^https?:\/\/([^?]+)(\?.*)?$/i);
    if (!m) return [url];
    const caminho = m[1], query = m[2] || '';
    const lista = [url];
    (ALTERNATIVOS[caminho] || []).forEach(alt => lista.push('https://' + alt + query));
    return lista;
  }

  /** Chave de 44 dígitos com dígito verificador (módulo 11) correto. */
  function chaveValida(chave) {
    const c = String(chave || '').replace(/\D/g, '');
    if (c.length !== 44) return false;
    let soma = 0, peso = 2;
    for (let i = 42; i >= 0; i--) {
      soma += Number(c.charAt(i)) * peso;
      peso = peso === 9 ? 2 : peso + 1;
    }
    const resto = soma % 11;
    const dv = resto < 2 ? 0 : 11 - resto;
    return dv === Number(c.charAt(43));
  }

  /** Modelo 65 = NFC-e (posições 21-22 da chave). */
  function ehNfce(chave) {
    return String(chave).replace(/\D/g, '').slice(20, 22) === '65';
  }

  function siglaUF(chave) {
    return SIGLA[String(chave).replace(/\D/g, '').slice(0, 2)] || '';
  }

  /** Endereço de consulta a partir da chave (QR code versão 3, emissão normal). */
  function urlDaChave(chave) {
    const c = String(chave || '').replace(/\D/g, '');
    const base = URL_QR[c.slice(0, 2)];
    if (!base || !chaveValida(c)) return '';
    return base + '?p=' + c + '|3|1';
  }

  /** Link de consulta de NFC-e dentro de um texto (ex.: QR lido pela câmera e compartilhado). */
  function urlDoTexto(texto) {
    const m = String(texto || '').match(/https?:\/\/[^\s<>"]+\?p=\d{44}[^\s<>"]*/i);
    return m ? m[0] : '';
  }

  function chaveDaUrl(url) {
    const m = String(url || '').match(/[?&]p=(\d{44})/);
    return m ? m[1] : '';
  }

  /** Só 44 dígitos (com ou sem espaços) e chave válida. */
  function chaveDoTexto(texto) {
    const t = String(texto || '').trim();
    if (!/^[\d\s.\-]{44,60}$/.test(t)) return '';
    const c = t.replace(/\D/g, '');
    return chaveValida(c) ? c : '';
  }

  function decodificarEntidades_(s) {
    const nomes = { nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", ordm: 'º', ordf: 'ª', ccedil: 'ç', Ccedil: 'Ç', atilde: 'ã', otilde: 'õ', aacute: 'á', eacute: 'é', iacute: 'í', oacute: 'ó', uacute: 'ú', acirc: 'â', ecirc: 'ê', ocirc: 'ô', agrave: 'à', Atilde: 'Ã', Aacute: 'Á', Eacute: 'É', Iacute: 'Í', Oacute: 'Ó', Uacute: 'Ú' };
    return s
      .replace(/&#x([0-9a-f]+);/gi, (m, h) => String.fromCharCode(parseInt(h, 16)))
      .replace(/&#(\d+);/g, (m, d) => String.fromCharCode(Number(d)))
      .replace(/&([a-z]+);/gi, (m, n) => (n in nomes ? nomes[n] : m));
  }

  /** HTML da página → texto legível, uma linha por bloco. */
  function htmlParaTexto(html) {
    let s = String(html || '');
    s = s.replace(/<(script|style|noscript|svg|head)[\s\S]*?<\/\1>/gi, ' ');
    s = s.replace(/<!--[\s\S]*?-->/g, ' ');
    s = s.replace(/<\s*br\s*\/?>/gi, '\n');
    s = s.replace(/<\/(tr|p|div|li|h\d|table|tbody|thead|section|dt|dd)>/gi, '\n');
    s = s.replace(/<\/(td|th|span|label|strong|b)>/gi, ' ');
    s = s.replace(/<[^>]+>/g, ' ');
    s = decodificarEntidades_(s);
    s = s.split('\n').map(l => l.replace(/[ \t\r\f\v]+/g, ' ').trim()).filter(Boolean).join('\n');
    return s.slice(0, LIMITE_TEXTO);
  }

  function ehXml_(conteudo, tipo) {
    return /xml/i.test(tipo || '') || /^\s*<\?xml/i.test(conteudo) || /<(nfeProc|NFe|infNFe)\b/.test(conteudo);
  }

  /**
   * XML da nota (alguns estados, como PE, devolvem a NFC-e em XML) → texto com
   * os nomes oficiais dos campos: xProd, qCom, uCom, vUnCom, vProd, vDesc, vNF...
   */
  function xmlParaTexto(xml) {
    let s = String(xml || '');
    s = s.replace(/<Signature[\s\S]*?<\/Signature>/gi, ' ');
    s = s.replace(/<\?[\s\S]*?\?>/g, ' ').replace(/<!--[\s\S]*?-->/g, ' ');
    s = s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
    s = s.replace(/<det\b[^>]*nItem="(\d+)"[^>]*>/gi, '\n--- item $1 ---\n');
    s = s.replace(/<(emit|dest|total|pag|detPag|ide|infAdic)\b[^>]*>/gi, '\n[$1]\n');
    // Folhas: <campo>valor</campo> vira "campo: valor"
    s = s.replace(/<([\w:.-]+)(?:\s[^>]*)?>([^<]*)<\/\1>/g, (m, tag, val) => '\n' + tag.replace(/^.*:/, '') + ': ' + val);
    s = s.replace(/<[^>]+>/g, '\n');
    s = decodificarEntidades_(s);
    s = s.split('\n').map(l => l.replace(/[ \t\r\f\v]+/g, ' ').trim()).filter(l => l && !/^[\w-]+:\s*$/.test(l)).join('\n');
    return s.slice(0, LIMITE_TEXTO);
  }

  function charset_(resp) {
    const h = resp.getHeaders() || {};
    const tipo = String(h['Content-Type'] || h['content-type'] || '');
    const m = tipo.match(/charset=([\w-]+)/i);
    return m ? m[1] : '';
  }

  const CABECALHOS = {
    'User-Agent': 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Mobile Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml',
    'Accept-Language': 'pt-BR,pt;q=0.9'
  };

  /** Uma tentativa de download sem seguir redirecionamento. Nunca lança erro. */
  function tentar_(url) {
    try {
      const resp = UrlFetchApp.fetch(url, {
        muteHttpExceptions: true,
        followRedirects: false,
        validateHttpsCertificates: false,
        headers: CABECALHOS
      });
      const h = resp.getHeaders() || {};
      return { url: url, status: resp.getResponseCode(), local: h.Location || h.location || '', resp: resp };
    } catch (e) {
      return { url: url, erro: String(e && e.message ? e.message : e).slice(0, 200) };
    }
  }

  function trocarProtocolo_(url) {
    return /^https:/i.test(url) ? url.replace(/^https:/i, 'http:') : url.replace(/^http:/i, 'https:');
  }

  /**
   * Segue os redirecionamentos à mão. Se o https falhar (SSL antigo do portal),
   * tenta o mesmo endereço em http, e vice-versa.
   */
  function baixar_(url) {
    const log = [];
    let atual = url;
    const vistos = {};
    for (let passo = 0; passo < 6; passo++) {
      let t = tentar_(atual);
      log.push(resumo_(t));
      if (t.erro) {
        const alt = trocarProtocolo_(atual);
        if (vistos[alt]) break;
        vistos[atual] = true;
        t = tentar_(alt);
        log.push(resumo_(t));
        if (t.erro) break;
        atual = alt;
      }
      vistos[atual] = true;
      if (t.status >= 300 && t.status < 400 && t.local) {
        const prox = /^https?:/i.test(t.local) ? t.local : atual.replace(/^(https?:\/\/[^\/]+).*$/i, '$1') + (t.local.charAt(0) === '/' ? '' : '/') + t.local;
        if (vistos[prox]) { log.push('laço de redirecionamento'); break; }
        atual = prox;
        continue;
      }
      return { resp: t.resp, status: t.status, log: log };
    }
    return { resp: null, status: 0, log: log };
  }

  function resumo_(t) {
    const base = t.url.split('?')[0];
    if (t.erro) return base + ' → erro: ' + t.erro;
    return base + ' → ' + t.status + (t.local ? ' (vai para ' + t.local.split('?')[0] + ')' : '');
  }

  /**
   * Baixa a página da nota e devolve o texto, ou lança erro com o motivo.
   */
  function buscarTexto(url) {
    // O Apps Script recusa "|" sem codificar na URL
    url = String(url).replace(/\|/g, '%7C');
    let r = null;
    const logs = [];
    for (const u of candidatos_(url)) {
      r = baixar_(u);
      logs.push(r.log.join(' | '));
      if (r.resp && r.status === 200) break;
    }
    console.log('SEFAZ: ' + logs.join(' || '));
    if (!r.resp) {
      const ultimo = logs.join(' ');
      throw new Error(/ssl|tls|handshake|certificate/i.test(ultimo)
        ? 'o portal da SEFAZ usa uma conexão segura que o Google não aceita'
        : 'não consegui abrir o portal da SEFAZ');
    }
    const resp = r.resp, status = r.status;
    let html;
    const cs = charset_(resp);
    try { html = cs ? resp.getContentText(cs) : resp.getContentText(); } catch (e) { html = resp.getContentText(); }
    // Páginas em ISO-8859-1 sem charset no cabeçalho
    if (!cs && /�/.test(html)) {
      try { html = resp.getContentText('ISO-8859-1'); } catch (e) { /* fica como está */ }
    }
    const xml = ehXml_(html, String((resp.getHeaders() || {})['Content-Type'] || ''));
    const texto = xml ? xmlParaTexto(html) : htmlParaTexto(html);
    console.log('SEFAZ ' + status + ' · ' + (xml ? 'XML' : 'HTML') + ' ' + html.length + ' bytes · ' + texto.length + ' de texto · início: ' + texto.slice(0, 120).replace(/\n/g, ' / '));
    if (status !== 200) throw new Error('a SEFAZ respondeu ' + status);
    if (xml && !/xProd:|vNF:/.test(texto)) throw new Error('a SEFAZ não devolveu a nota (resposta: ' + texto.slice(0, 60).replace(/\n/g, ' ') + ')');
    if (!xml && texto.length < 150) throw new Error('a página da SEFAZ veio vazia (pode depender de JavaScript)');
    if (/captcha/i.test(texto) && !/qtde|quantidade|vl\.? ?unit/i.test(texto)) throw new Error('a SEFAZ pediu captcha');
    return texto;
  }

  /** Diagnóstico: como cada portal responde ao Google (RN e PE por padrão). */
  function diagnosticar(ufs) {
    const saida = [];
    (ufs || ['24', '26']).forEach(cuf => {
      const base = URL_QR[cuf];
      if (!base) return;
      saida.push((SIGLA[cuf] || cuf) + ':');
      let r = null;
      for (const u of candidatos_(base + '?p=1')) {
        r = baixar_(u);
        r.log.forEach(l => saida.push('  ' + l));
        if (r.resp) break;
      }
      if (r && r.resp) {
        const bruto = r.resp.getContentText();
        const xml = ehXml_(bruto, String((r.resp.getHeaders() || {})['Content-Type'] || ''));
        const texto = xml ? xmlParaTexto(bruto) : htmlParaTexto(bruto);
        saida.push('  ' + (xml ? 'XML' : 'HTML') + ': ' + texto.length + ' caracteres · ' + texto.slice(0, 200).replace(/\n/g, ' / '));
        saida.push('  bruto: ' + bruto.slice(0, 300).replace(/\s+/g, ' '));
      }
    });
    return saida.join('\n');
  }

  return {
    chaveValida: chaveValida,
    ehNfce: ehNfce,
    siglaUF: siglaUF,
    urlDaChave: urlDaChave,
    urlDoTexto: urlDoTexto,
    chaveDaUrl: chaveDaUrl,
    chaveDoTexto: chaveDoTexto,
    htmlParaTexto: htmlParaTexto,
    xmlParaTexto: xmlParaTexto,
    buscarTexto: buscarTexto,
    diagnosticar: diagnosticar
  };
})();
