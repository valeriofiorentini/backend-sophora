# HTTPS in produzione — guida passo-passo

Tempo stimato: **30-45 minuti**. Unico prerequisito: un dominio (~10€/anno,
es. su Cloudflare, Namecheap, OVH, Aruba).

Perché è obbligatorio:
- oggi i JWT viaggiano in chiaro (`http://167.233.96.153:3000`)
- Apple **rifiuta** app iOS che parlano HTTP (`NSAllowsArbitraryLoads`)
- Google Play segnala `usesCleartextTraffic="true"` in review

---

## 1. Dominio → DNS (5 min)

Compra il dominio e crea un record **A**:

| Tipo | Nome | Valore |
|------|------|--------|
| A | `api` | `167.233.96.153` |

Verifica (dopo qualche minuto): `nslookup api.TUODOMINIO.it` deve rispondere `167.233.96.153`.

## 2. nginx + certbot sul server (10 min)

```bash
ssh root@167.233.96.153

apt update && apt install -y nginx certbot python3-certbot-nginx

# Copia la config (il file è in questo repo: deploy/nginx-shopora.conf)
cp ~/workspace/sophora/backend-sophora/deploy/nginx-shopora.conf /etc/nginx/sites-available/shopora

# Sostituisci il placeholder col dominio vero
sed -i 's/api.TUODOMINIO.it/api.tuodominio.it/g' /etc/nginx/sites-available/shopora

ln -s /etc/nginx/sites-available/shopora /etc/nginx/sites-enabled/
rm -f /etc/nginx/sites-enabled/default
nginx -t                     # deve dire "syntax is ok"
```

⚠️ Il primo `nginx -t` fallirà sui certificati mancanti: normale.
Commenta temporaneamente il blocco `server { listen 443 ... }` oppure lascia
fare a certbot (passo 3), che sistema tutto da solo.

## 3. Certificato Let's Encrypt (5 min)

```bash
systemctl start nginx
certbot --nginx -d api.tuodominio.it
# → inserisci email, accetta ToS, scegli "redirect"
```

Il rinnovo è automatico (timer systemd). Verifica: `certbot renew --dry-run`.

## 4. Chiudi la porta 3000 al mondo (2 min)

Il backend deve essere raggiungibile SOLO tramite nginx:

```bash
ufw allow 22/tcp
ufw allow 80/tcp
ufw allow 443/tcp
ufw deny 3000/tcp
ufw enable
```

Test: `curl https://api.tuodominio.it/api/health` → ok;
`curl http://167.233.96.153:3000/api/health` da fuori → deve fallire.

## 5. Aggiorna l'app (5 min + rebuild)

1. **[src/apiHelper/endpoints.js](../../src/apiHelper/endpoints.js)** riga 2:
   ```js
   export const BASE_URL = 'https://api.tuodominio.it';
   ```
2. **android/app/src/main/AndroidManifest.xml**: rimuovi
   `android:usesCleartextTraffic="true"` (riga ~43).
3. **ios/DealCart/Info.plist**: `NSAllowsArbitraryLoads` → `<false/>`
   (lascia `NSAllowsLocalNetworking` per il dev con Metro).
4. Rebuild APK.

## 6. CORS backend (verifica)

Se il backend limita le origin, aggiungi il dominio della landing/webapp.
Per l'app mobile non serve nulla (le richieste native non hanno origin).
