FROM python:3.10-slim

# Librerie di sistema richieste da PaddleOCR/OpenCV
RUN apt-get update && apt-get install -y --no-install-recommends \
    libgl1 libglib2.0-0 libgomp1 \
    && rm -rf /var/lib/apt/lists/*

# Versioni pinnate (combinazione stabile). paddlepaddle 2.6.2 = ultima della serie 2.x.
RUN pip install --no-cache-dir \
    paddlepaddle==2.6.2 \
    paddleocr==2.7.3 \
    "fastapi==0.110.0" \
    "uvicorn[standard]==0.29.0" \
    pillow==10.2.0 \
    python-multipart==0.0.9

WORKDIR /app
COPY app.py /app/app.py

EXPOSE 8868
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8868"]
