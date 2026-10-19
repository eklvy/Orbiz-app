import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import multer from 'multer';
import type { Env } from '../../config/env.js';
import { AppError } from '../../lib/errors.js';

// ─── Allowed MIME types and their magic bytes ────────────────────────────────

const ALLOWED_TYPES = new Map<string, Buffer[]>([
  ['image/jpeg', [Buffer.from([0xff, 0xd8, 0xff])]],
  ['image/png', [Buffer.from([0x89, 0x50, 0x4e, 0x47])]],
  [
    'image/webp',
    // RIFF????WEBP: bytes 0-3 = "RIFF", bytes 8-11 = "WEBP"
    [Buffer.from('RIFF')],
  ],
]);

const EXT_BY_MIME: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
};

/** Reads the first 12 bytes of a file and confirms the magic bytes match the declared MIME type. */
export function checkMagicBytes(filePath: string, mimeType: string): boolean {
  const magic = ALLOWED_TYPES.get(mimeType);
  if (!magic) return false;
  let fd: number;
  try {
    fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(12);
    fs.readSync(fd, buf, 0, 12, 0);
    fs.closeSync(fd);

    if (mimeType === 'image/webp') {
      // RIFF at 0..3 and WEBP at 8..11
      return buf.slice(0, 4).toString('ascii') === 'RIFF' && buf.slice(8, 12).toString('ascii') === 'WEBP';
    }
    return magic[0] ? buf.slice(0, magic[0].length).equals(magic[0]) : false;
  } catch {
    return false;
  }
}

// ─── Multer configuration ─────────────────────────────────────────────────────

export function buildUploadMiddleware(config: Env) {
  const uploadDir = config.UPLOAD_DIR;
  fs.mkdirSync(uploadDir, { recursive: true });

  const storage = multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, uploadDir),
    filename: (_req, file, cb) => {
      const ext = EXT_BY_MIME[file.mimetype] ?? path.extname(file.originalname);
      cb(null, `${crypto.randomUUID()}${ext}`);
    },
  });

  return multer({
    storage,
    limits: { fileSize: config.UPLOAD_MAX_SIZE_MB * 1024 * 1024 },
    fileFilter: (_req, file, cb) => {
      if (!ALLOWED_TYPES.has(file.mimetype)) {
        cb(
          new AppError(
            415,
            'UNSUPPORTED_MEDIA_TYPE',
            'Only JPEG, PNG and WebP images are accepted.',
          ),
        );
        return;
      }
      cb(null, true);
    },
  });
}

/** Constructs the public URL for an uploaded file. */
export function photoPublicUrl(config: Env, filename: string): string {
  return `${config.BACKEND_URL}/api/v1/uploads/${filename}`;
}
