/**
 * services/nfse-xml.js — Gerador de XML DPS (SPED NFS-e v1.01)
 * =============================================================
 * Gera o XML do Documento de Prestacao de Servicos (DPS) no formato
 * do SPED NFS-e v1.01, conforme XSD oficial:
 *   https://dl.ellotecnologia.com/NFS-e/Schemas/PadraoNacional/1.01/
 *
 * Estrutura XSD (TCInfDPS -> ordem estrita):
 *   tpAmb, dhEmi, verAplic, serie, nDPS, dCompet, tpEmit,
 *   [cMotivoEmisTI], [chNFSeRej], cLocEmi, [subst],
 *   prest (TCInfoPrestador),
 *   toma (TCInfoPessoa, optional),
 *   serv (TCServ),
 *   valores (TCInfoValores),
 *   [IBSCBS]
 *
 * TCInfoPrestador ordem:
 *   CNPJ/CPF, [CAEPF], [IM], [xNome], [end], [fone], [email], regTrib
 *
 * TCInfoPessoa (toma) ordem:
 *   CNPJ/CPF, [CAEPF], [IM], xNome, [end], [fone], [email]
 *
 * TCEndereco ordem:
 *   endNac/endExt, xLgr, nro, [xCpl], xBairro
 *   (endNac requer cMun e CEP — CEP obrigatorio)
 *
 * Namespace: http://www.sped.fazenda.gov.br/nfse
 */

const config = require('../config');

const NS = 'http://www.sped.fazenda.gov.br/nfse';

// === Cache IBGE por CEP (ViaCEP) ===
const ibgeCache = {};

/** Busca codigo IBGE do municipio pelo CEP via ViaCEP (com cache) */
async function ibgeFromCep(cep) {
  const cepLimpo = limpaDoc(cep);
  if (!cepLimpo || cepLimpo.length !== 8) return null;
  if (ibgeCache[cepLimpo]) return ibgeCache[cepLimpo];
  try {
    const resp = await fetch('https://viacep.com.br/ws/' + cepLimpo + '/json/', {
      headers: { 'Accept': 'application/json' },
      signal: AbortSignal.timeout(5000),
    });
    const data = await resp.json();
    if (data && data.ibge) {
      ibgeCache[cepLimpo] = data.ibge;
      console.log('[NFSE-XML] ViaCEP: CEP=' + cepLimpo + ' -> IBGE=' + data.ibge + ' (' + (data.localidade || '') + '/' + (data.uf || '') + ')');
      return data.ibge;
    }
  } catch (e) {
    console.warn('[NFSE-XML] ViaCEP falhou para CEP ' + cepLimpo + ': ' + e.message);
  }
  return null;
}

// === Helpers de formatacao ===

/** Remove pontuacao de CNPJ/CPF */
function limpaDoc(doc) {
  if (!doc) return '';
  return String(doc).replace(/[^0-9]/g, '');
}

/** Formata valor monetario com 2 casas */
function fmtValor(v) {
  return Number(v || 0).toFixed(2);
}

/** Formata data ISO 8601 com timezone */
function fmtDataHora(d) {
  const dt = d ? new Date(d) : new Date();
  // XSD exige TSDateTimeUTC: AAAA-MM-DDThh:mm:ssTZD
  // BRT = -03:00
  const iso = dt.toISOString();
  const utcDate = new Date(iso);
  const brtDate = new Date(utcDate.getTime() - 3 * 60 * 60 * 1000);
  const yyyy = brtDate.getUTCFullYear();
  const MM = String(brtDate.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(brtDate.getUTCDate()).padStart(2, '0');
  const hh = String(brtDate.getUTCHours()).padStart(2, '0');
  const mm = String(brtDate.getUTCMinutes()).padStart(2, '0');
  const ss = String(brtDate.getUTCSeconds()).padStart(2, '0');
  return `${yyyy}-${MM}-${dd}T${hh}:${mm}:${ss}-03:00`;
}

/** Formata data competencia YYYY-MM-DD */
function fmtDataCompet(d) {
  const dt = d ? new Date(d) : new Date();
  const brt = new Date(dt.getTime() - 3 * 60 * 60 * 1000);
  const yyyy = brt.getUTCFullYear();
  const MM = String(brt.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(brt.getUTCDate()).padStart(2, '0');
  return `${yyyy}-${MM}-${dd}`;
}

/** Extrai codigo IBGE do city_id do Odoo (fallback: busca ViaCEP pelo CEP) */
function ibgeFromCity(cityId) {
  // Sem l10n_br_city_id no Odoo Online, sempre usa fallback
  return null; // null sinaliza para usar ViaCEP
}

/** Extrai numero do endereco */
function extraiNumero(street, street2, number) {
  if (number && String(number).trim()) return String(number).trim();
  if (street2 && String(street2).trim() && /^\d+$/.test(street2.trim())) return street2.trim();
  const match = String(street || '').match(/[,\s]+(\d+)[\s,]*$/);
  return match ? match[1] : 'S/N';
}

/** Limpa logradouro removendo numero final */
function limpaLogradouro(street) {
  if (!street) return '';
  return String(street).replace(/[,\s]+\d+[\s,]*$/, '').trim();
}

/** Escapa caracteres especiais XML */
function escXml(s) {
  if (!s) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** Gera bloco de endereco (TCEndereco) - ordem XSD: endNac/endExt, xLgr, nro, [xCpl], xBairro */
function xmlEndereco(cMun, cep, xLgr, nro, xBairro, xCpl) {
  // CEP e obrigatorio no XSD dentro de endNac — sem CEP, omite o endereco inteiro
  if (!cep) {
    console.warn('[NFSE-XML] CEP ausente — endereco omitido do XML (logradouro: ' + (xLgr || 'n/a') + ')');
    return '';
  }
  let s = `\n        <end>\n          <endNac>\n            <cMun>${cMun}</cMun>`;
  s += `\n            <CEP>${cep}</CEP>`;
  s += `\n          </endNac>`;
  s += `\n          <xLgr>${escXml(xLgr)}</xLgr>`;
  s += `\n          <nro>${escXml(nro)}</nro>`;
  if (xCpl) s += `\n          <xCpl>${escXml(xCpl)}</xCpl>`;
  s += `\n          <xBairro>${escXml(xBairro)}</xBairro>`;
  s += `\n        </end>`;
  return s;
}

// === Gerador do DPS ===

/**
 * Gera o XML DPS conforme XSD v1.01 do SPED NFS-e Nacional.
 */
async function gerarXmlDPS(dados) {
  const { move, company, partner, lines, products, nDPS } = dados;
  const c = config.nfse;

  const cnpjPrest = limpaDoc(company._cnpj);
  const ibge = c.codigo_ibge;
  const serie = c.serie;
  const dhEmi = fmtDataHora(move.invoice_date);
  const dCompet = fmtDataCompet(move.invoice_date);

  // ID do infDPS (formato XSD TSIdDPS: DPS + cMun 7d + tpInsc 1d + InscFed 14d + serie 5d + nDPS 15d = 45 chars)
  // tpInsc: 2=CNPJ, 1=CPF (conforme nfse-js referencia oficial SPED)
  const tpInscPrest = cnpjPrest.length === 14 ? '2' : '1';
  const nDPSIdFmt = String(nDPS).padStart(15, '0');
  const serieFmt = String(serie).padStart(5, '0').slice(-5);
  const infDpsId = `DPS${ibge}${tpInscPrest}${cnpjPrest}${serieFmt}${nDPSIdFmt}`;

  // --- Prestador (TCInfoPrestador) ---
  // Ordem XSD: CNPJ, [CAEPF], [IM], [xNome], [end], [fone], [email], regTrib
  const fonePrest = limpaDoc(company.phone || '');
  const emailPrest = company.email || '';
  const fonePrestXml = fonePrest.length >= 10 ? `\n      <fone>${fonePrest}</fone>` : '';
  const emailPrestXml = emailPrest ? `\n      <email>${escXml(emailPrest)}</email>` : '';

  // Endereco do prestador (opcional no XSD)
  const logrPrest = limpaLogradouro(company.street);
  const nroPrest = extraiNumero(company.street, company.street2);
  const bairroPrest = company.district || company.street2 || '';
  const cepPrest = limpaDoc(company.zip || '');
  const endPrestXml = (logrPrest || nroPrest !== 'S/N') ?
    xmlEndereco(ibge, cepPrest, logrPrest, nroPrest, bairroPrest) : '';

  // --- Tomador (TCInfoPessoa) ---
  // Ordem XSD: CNPJ/CPF, [CAEPF], [IM], xNome, [end], [fone], [email]
  const docTomador = limpaDoc(partner._cnpj || partner.vat || '');
  const isCpfTomador = docTomador.length === 11;
  const docTomadorTag = isCpfTomador ? 'CPF' : 'CNPJ';
  const nomeTomador = partner.legal_name || partner.name || '';
  const emailTomador = partner.email || '';
  const foneTomador = limpaDoc(partner.phone || '');
  const nroTomador = extraiNumero(partner.street, partner.street2, partner.number);
  const logrTomador = limpaLogradouro(partner.street);
  const bairroTomador = partner.district || partner.street2 || '';
  const cepTomador = limpaDoc(partner.zip || '');
  let ibgeTomador = ibgeFromCity(partner.city_id || partner._cidade);
  // Se nao achou pelo Odoo, busca pelo CEP via ViaCEP
  if (!ibgeTomador && cepTomador) {
    ibgeTomador = await ibgeFromCep(cepTomador);
  }
  // Fallback final: codigo do prestador (so funciona se tomador for do mesmo municipio)
  if (!ibgeTomador) ibgeTomador = ibge;

  // --- Servico (TCServ) ---
  const firstProduct = lines[0] && lines[0].product_id ? (products[lines[0].product_id[0]] || {}) : {};
  const cTribNac = firstProduct.x_nytro_codigo_tributacao || c.c_trib_nac_padrao;
  const cNBS = firstProduct.x_nytro_c_nbs || c.c_nbs_padrao;

  // Descricao do servico (xDescServ) — obrigatória, NAO pode ser vazia
  // Fallbacks: campo custom NFSe > nome das linhas > nome do produto > narracao > padrao
  let xDescServ = firstProduct.x_nytro_descricao_nfse || '';
  if (!xDescServ) {
    xDescServ = lines.map(l => l.name || '').filter(Boolean).join('; ');
  }
  if (!xDescServ && firstProduct.name) {
    xDescServ = String(firstProduct.name);
  }
  if (!xDescServ && move.narration) {
    xDescServ = String(move.narration).substring(0, 2000);
  }
  if (!xDescServ) {
    xDescServ = 'Servico prestado conforme contrato';
  }
  // Remove tags HTML da descricao (narration do Odoo pode conter HTML)
  xDescServ = xDescServ.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  if (xDescServ.length > 2000) xDescServ = xDescServ.substring(0, 2000);

  console.log('[NFSE-XML] xDescServ=' + xDescServ.substring(0, 80) + (xDescServ.length > 80 ? '...' : ''));

  // --- Valores (TCInfoValores) ---
  // Ordem XSD: vServPrest, [vDescCondIncond], [vDedRed], trib
  // TCVServPrest: [vReceb], vServ
  // TCInfoTributacao: tribMun, [tribFed], totTrib
  // TCTribMunicipal: tribISSQN, [cPaisResult], [tpImunidade], [exigSusp], [BM], tpRetISSQN, [pAliq]
  // TCTribTotal (choice): vTotTrib | pTotTrib | indTotTrib | pTotTribSN
  const vServ = fmtValor(move.amount_untaxed || move.amount_total);
  // tpRetISSQN: 1=Nao Retido, 2=Retido pelo Tomador, 3=Retido pelo Intermediario
  const tpRetISSQN = firstProduct.x_nytro_iss_retido === true ? '2' : '1';
  const pTotTribSN = fmtValor(c.p_tot_trib_sn);

  // --- Monta o XML conforme XSD ---
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<DPS versao="${c.versao}" xmlns="${NS}">
  <infDPS Id="${infDpsId}">
    <tpAmb>${c.tp_amb}</tpAmb>
    <dhEmi>${dhEmi}</dhEmi>
    <verAplic>${escXml(c.ver_aplic)}</verAplic>
    <serie>${escXml(serie)}</serie>
    <nDPS>${nDPS}</nDPS>
    <dCompet>${dCompet}</dCompet>
    <tpEmit>1</tpEmit>
    <cLocEmi>${ibge}</cLocEmi>
    <prest>
      <CNPJ>${cnpjPrest}</CNPJ>${fonePrestXml}${emailPrestXml}
      <regTrib>
        <opSimpNac>${c.op_simp_nac}</opSimpNac>
        <regApTribSN>${c.reg_ap_trib_sn}</regApTribSN>
        <regEspTrib>${c.reg_esp_trib}</regEspTrib>
      </regTrib>
    </prest>
    <toma>
      <${docTomadorTag}>${docTomador}</${docTomadorTag}>
      <xNome>${escXml(nomeTomador)}</xNome>${xmlEndereco(ibgeTomador, cepTomador, logrTomador, nroTomador, bairroTomador)}${foneTomador.length >= 10 ? '\n      <fone>' + foneTomador + '</fone>' : ''}${emailTomador ? '\n      <email>' + escXml(emailTomador) + '</email>' : ''}
    </toma>
    <serv>
      <locPrest>
        <cLocPrestacao>${ibge}</cLocPrestacao>
      </locPrest>
      <cServ>
        <cTribNac>${escXml(cTribNac)}</cTribNac>
        <xDescServ>${escXml(xDescServ)}</xDescServ>
        <cNBS>${escXml(cNBS)}</cNBS>
      </cServ>
    </serv>
    <valores>
      <vServPrest>
        <vServ>${vServ}</vServ>
      </vServPrest>
      <trib>
        <tribMun>
          <tribISSQN>1</tribISSQN>
          <tpRetISSQN>${tpRetISSQN}</tpRetISSQN>
        </tribMun>
        <totTrib>
          <pTotTribSN>${pTotTribSN}</pTotTribSN>
        </totTrib>
      </trib>
    </valores>
  </infDPS>
</DPS>`;

  console.log('[NFSE-XML] DPS gerado. infDpsId=' + infDpsId + ' nDPS=' + nDPS + ' vServ=' + vServ);
  return { xml, infDpsId };
}

module.exports = { gerarXmlDPS, NS };
