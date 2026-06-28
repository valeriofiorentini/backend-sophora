# Shopora OCR — microservizio PaddleOCR (self-hosted)

OCR AI gratuito e illimitato per gli scontrini. Legge l'immagine e ritorna il
testo esatto; poi il backend lo dà all'LLM che lo struttura (nomi/prezzi/sconti).

## Requisiti VPS
- ~2 GB di RAM liberi (PaddleOCR carica i modelli in memoria)
- Docker installato
- Connessione internet al **primo** avvio (scarica i modelli ~200 MB), poi gira offline

## Build & run (sul server)
```bash
cd ~/workspace/sophora/backend-sophora/ocr-service
docker build -t shopora-ocr .
docker run -d --restart unless-stopped --name shopora-ocr \
  -p 127.0.0.1:8868:8868 shopora-ocr
```
Bind su `127.0.0.1` = raggiungibile solo dal server, non esposto a internet.

## Collega il backend
Nel `.env` del backend:
```
OCR_PROVIDER=selfhosted
OCR_URL=http://127.0.0.1:8868/ocr
```
Poi `pm2 restart shopora-backend`.

## Test rapido
```bash
# salute
curl http://127.0.0.1:8868/health
# OCR di un'immagine
curl -s -F "file=@/percorso/scontrino.jpg" http://127.0.0.1:8868/ocr
```
Deve ritornare `{"text":"...righe dello scontrino..."}`.

## Note
- Primo avvio del container: qualche minuto (scarica i modelli). I successivi sono veloci.
- Se la RAM è poca, valuta uno swap o resta su OCR.space free (25k/mese).
- Logs: `docker logs -f shopora-ocr`
