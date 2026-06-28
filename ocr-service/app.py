"""
Microservizio OCR per Shopora — PaddleOCR esposto via HTTP.

Contratto (lo stesso che il backend Node si aspetta in ocrSelfHostedText):
  POST /ocr   multipart  file=<immagine>
  → { "text": "riga1\nriga2\n..." }

Health:
  GET /health → { "status": "ok" }

Italiano: lang='it'. Primo avvio: scarica i modelli (~200MB), poi è offline.
"""
import io
import numpy as np
from fastapi import FastAPI, UploadFile, File
from paddleocr import PaddleOCR

app = FastAPI(title="Shopora OCR")

# use_angle_cls: raddrizza il testo ruotato (foto storte). lang='it' = italiano.
_ocr = PaddleOCR(use_angle_cls=True, lang="it", show_log=False)


def _read_image(data: bytes):
    # decodifica l'immagine senza dipendere da OpenCV (usa Pillow)
    from PIL import Image
    img = Image.open(io.BytesIO(data)).convert("RGB")
    return np.array(img)


def _extract_lines(result):
    """Estrae il testo da qualsiasi forma di risultato PaddleOCR 2.x."""
    lines = []

    def walk(node):
        if node is None:
            return
        # forma riga: [box, (text, conf)]
        if (isinstance(node, (list, tuple)) and len(node) == 2
                and isinstance(node[1], (list, tuple)) and node[1]
                and isinstance(node[1][0], str)):
            lines.append(node[1][0])
            return
        if isinstance(node, (list, tuple)):
            for x in node:
                walk(x)

    walk(result)
    return lines


@app.get("/health")
def health():
    return {"status": "ok"}


@app.post("/ocr")
async def ocr(file: UploadFile = File(...)):
    data = await file.read()
    img = _read_image(data)
    result = _ocr.ocr(img, cls=True)
    lines = _extract_lines(result)
    return {"text": "\n".join(lines)}
