'use strict';

/**
 * appleJws.js
 *
 * Verifica crittografica dei payload JWS firmati da Apple (usati sia dalle
 * App Store Server Notifications V2 sia, al loro interno, dal campo
 * signedTransactionInfo). Senza questa verifica chiunque potrebbe inviare
 * un payload finto all'endpoint /api/iap/apple-notifications e attivarsi
 * un abbonamento gratis a tempo indeterminato.
 *
 * Il payload è un JWS con l'header x5c contenente la catena di certificati
 * (leaf → intermedio → root) usata per firmarlo. La verifichiamo fino alla
 * Apple Root CA - G3, scaricata dal sito ufficiale Apple e tenuta in cache.
 */

const crypto = require('crypto');
const { importX509, decodeProtectedHeader, compactVerify } = require('jose');

const APPLE_ROOT_CA_URL = 'https://www.apple.com/certificateauthority/AppleRootCA-G3.cer';

let cachedRootCert = null;

async function getAppleRootCert() {
  if (cachedRootCert) return cachedRootCert;
  const res = await fetch(APPLE_ROOT_CA_URL);
  if (!res.ok) throw new Error(`Download Apple Root CA G3 fallito: HTTP ${res.status}`);
  const der = Buffer.from(await res.arrayBuffer());
  cachedRootCert = new crypto.X509Certificate(der);
  return cachedRootCert;
}

function certFromX5cEntry(base64Der) {
  return new crypto.X509Certificate(Buffer.from(base64Der, 'base64'));
}

/** Verifica la catena leaf→...→root e che punti davvero alla Apple Root CA G3. Ritorna il certificato leaf. */
async function verifyCertChain(x5c) {
  if (!Array.isArray(x5c) || x5c.length === 0) {
    throw new Error('Header JWS senza x5c: impossibile verificare la provenienza Apple');
  }

  const certs = x5c.map(certFromX5cEntry);
  const now = new Date();
  for (const cert of certs) {
    if (now < new Date(cert.validFrom) || now > new Date(cert.validTo)) {
      throw new Error('Certificato scaduto o non ancora valido nella catena x5c');
    }
  }

  for (let i = 0; i < certs.length - 1; i++) {
    if (!certs[i].checkIssued(certs[i + 1])) {
      throw new Error(`Catena certificati non valida: il certificato ${i} non risulta emesso dal successivo`);
    }
  }

  const root = await getAppleRootCert();
  const last = certs[certs.length - 1];
  const lastIsRoot = last.fingerprint256 === root.fingerprint256;
  if (!lastIsRoot && !last.checkIssued(root)) {
    throw new Error('La catena di certificati non riconduce alla Apple Root CA G3');
  }

  return certs[0];
}

/**
 * Verifica un JWS compatto firmato da Apple (formato header.payload.signature)
 * e ritorna il payload decodificato come oggetto JS.
 * Lancia un errore se la firma o la catena di certificati non sono valide.
 */
async function verifyAppleJWS(token) {
  if (!token || typeof token !== 'string') {
    throw new Error('Token JWS mancante o non valido');
  }

  const header = decodeProtectedHeader(token);
  const leafCert = await verifyCertChain(header.x5c);

  const leafKey = await importX509(leafCert.toString(), header.alg || 'ES256');
  const { payload } = await compactVerify(token, leafKey);

  return JSON.parse(Buffer.from(payload).toString('utf8'));
}

module.exports = { verifyAppleJWS };
