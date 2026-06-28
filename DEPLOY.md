# Deploy EasyMarket Backend

## Opzione A: Railway (più semplice, ~5 minuti)

### 1. Prepara il progetto
```bash
cd backend
cp .env.example .env
# Compila .env con le tue chiavi reali
```

### 2. Crea account Railway
- Vai su https://railway.app → Sign up con GitHub

### 3. Crea il progetto
```
New Project → Deploy from GitHub repo → seleziona il repo
```
- Root directory: `backend`
- Railway rileva automaticamente Node.js

### 4. Aggiungi PostgreSQL
```
New → Database → PostgreSQL
```
Railway aggiunge automaticamente `DATABASE_URL` alle variabili d'ambiente.

### 5. Imposta variabili d'ambiente
In Railway → Settings → Variables, aggiungi tutte le variabili da `.env.example`.

### 6. Esegui le migrazioni (una volta sola)
```bash
railway run npx prisma migrate deploy
railway run node prisma/seed.js
```

### 7. Ottieni l'URL del backend
Railway ti dà un URL tipo `https://easymarket-production.railway.app`.

---

## Opzione B: Docker su VPS (Hetzner, DigitalOcean, etc.)

### 1. Compra un VPS (minimo: 2GB RAM, Ubuntu 22.04)
- Hetzner CX22: ~4€/mese
- DigitalOcean Droplet: ~6$/mese

### 2. Installa Docker sul server
```bash
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER
```

### 3. Carica il codice sul server
```bash
git clone https://github.com/TUO_UTENTE/TUO_REPO.git
cd dealCartApp-main/backend
cp .env.example .env
nano .env  # compila con i valori reali
```

### 4. Avvia con Docker Compose
```bash
docker-compose up -d
```

### 5. Esegui le migrazioni
```bash
docker-compose exec api npx prisma migrate deploy
docker-compose exec api node prisma/seed.js
```

### 6. (Opzionale) Configura Nginx + SSL con Let's Encrypt
```bash
sudo apt install nginx certbot python3-certbot-nginx
sudo certbot --nginx -d api.tuodominio.com
```
Nel file nginx `/etc/nginx/sites-available/easymarket`:
```nginx
server {
    server_name api.tuodominio.com;
    location / {
        proxy_pass http://localhost:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }
}
```

---

## Variabili d'ambiente necessarie

| Variabile | Descrizione | Dove ottenerla |
|---|---|---|
| `DATABASE_URL` | URL PostgreSQL | Railway (automatica) o crea manualmente |
| `JWT_SECRET` | Stringa casuale sicura | `openssl rand -base64 32` |
| `JWT_REFRESH_SECRET` | Stringa casuale sicura | `openssl rand -base64 32` |
| `EMAIL_USER` | Gmail per invio OTP | Account Gmail |
| `EMAIL_PASS` | App Password Gmail | Gmail → Sicurezza → Password app |
| `AWS_ACCESS_KEY_ID` | AWS S3 per immagini | AWS Console → IAM |
| `AWS_SECRET_ACCESS_KEY` | AWS S3 | AWS Console → IAM |
| `AWS_S3_BUCKET` | Nome bucket S3 | Crea in AWS S3 |
| `STRIPE_SECRET_KEY` | Pagamenti | dashboard.stripe.com |
| `STRIPE_PREMIUM_PRICE_ID` | ID del piano premium | dashboard.stripe.com → Products |
| `FIREBASE_SERVICE_ACCOUNT_PATH` | Push notifications | Firebase Console → Project Settings |

---

## Aggiorna il frontend

Dopo il deploy, modifica `src/apiHelper/endpoints.js`:
```js
export const BASE_URL = 'https://TUO_URL_BACKEND';
```

---

## Pubblicare l'app mobile

### Android (Google Play)
1. Crea account Google Play Console: https://play.google.com/console (~25$ una tantum)
2. Build firmato:
```bash
cd android
./gradlew bundleRelease
```
3. Firma con keystore (segui guida: https://reactnative.dev/docs/signed-apk-android)
4. Carica `.aab` su Play Console

### iOS (App Store)
1. Apple Developer Program: https://developer.apple.com (~99$/anno)
2. Build con Xcode → Product → Archive
3. Carica con Transporter o Xcode direttamente
