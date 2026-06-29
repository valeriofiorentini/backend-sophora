const { S3Client, PutObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const path = require('path');

const s3 = new S3Client({
  region: process.env.AWS_REGION,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
});

const storage = multer.memoryStorage();
const upload = multer({
  storage,
  // 12MB: le foto da galleria (non sempre compresse bene come quelle da camera)
  // possono superare i 5MB e venivano rifiutate → "errore server" lato app.
  limits: { fileSize: 12 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ['.jpg', '.jpeg', '.png', '.webp', '.heic', '.heif'];
    const ext = path.extname(file.originalname || '').toLowerCase();
    // Se l'estensione non è riconoscibile (es. nome generico) ma il mimetype è
    // un'immagine, accetta lo stesso — l'app a volte invia "receipt.jpg" o blob.
    const mimeOk = (file.mimetype || '').startsWith('image/');
    if (allowed.includes(ext) || mimeOk) cb(null, true);
    else cb(new Error('Solo immagini JPG, PNG o WEBP'));
  },
});

// Wrapper per upload.single che traduce gli errori multer (file troppo grande,
// formato non valido) in messaggi JSON chiari invece di un 500 "errore server".
function uploadReceiptImage(field) {
  return (req, res, next) => {
    upload.single(field)(req, res, err => {
      if (!err) return next();
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(413).json({ success: false, message: 'Immagine troppo grande (max 12MB). Riprova con una foto più piccola.' });
      }
      return res.status(400).json({ success: false, message: err.message || 'Immagine non valida' });
    });
  };
}

async function uploadToS3(file, folder = 'uploads') {
  if (!process.env.AWS_REGION || !process.env.AWS_ACCESS_KEY_ID || !process.env.AWS_S3_BUCKET) {
    console.warn('[S3] Credenziali AWS mancanti — immagine non caricata');
    return null;
  }
  const key = `${folder}/${uuidv4()}${path.extname(file.originalname)}`;
  await s3.send(new PutObjectCommand({
    Bucket: process.env.AWS_S3_BUCKET,
    Key: key,
    Body: file.buffer,
    ContentType: file.mimetype,
  }));
  return `https://${process.env.AWS_S3_BUCKET}.s3.${process.env.AWS_REGION}.amazonaws.com/${key}`;
}

async function deleteFromS3(url) {
  const key = url.split('.amazonaws.com/')[1];
  if (!key) return;
  await s3.send(new DeleteObjectCommand({ Bucket: process.env.AWS_S3_BUCKET, Key: key }));
}

module.exports = { upload, uploadReceiptImage, uploadToS3, deleteFromS3 };
