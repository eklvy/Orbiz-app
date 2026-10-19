import { Router } from 'express';
import path from 'node:path';
import fs from 'node:fs';
import type { Env } from '../../config/env.js';
import { requireRole } from '../../middleware/auth.js';
import { AppError } from '../../lib/errors.js';
import {
  buildUploadMiddleware,
  checkMagicBytes,
  photoPublicUrl,
} from './upload.service.js';

/**
 * POST /uploads/review-photos — upload a single review photo.
 * GET  /uploads/:filename       — serve an uploaded file.
 *
 * Only STUDENT (and equivalent ordering roles) may upload.
 * GET is intentionally public so review photos are viewable without a session.
 */
export function uploadsRouter(config: Env): Router {
  const router = Router();
  const upload = buildUploadMiddleware(config);

  /** Serve uploaded files (no auth required — URLs are not guessable). */
  router.get('/:filename', (req, res) => {
    const filename = path.basename(req.params.filename ?? '');
    if (!filename) {
      res.status(404).json({ error: 'NOT_FOUND', message: 'File not found' });
      return;
    }
    const filePath = path.join(config.UPLOAD_DIR, filename);
    if (!fs.existsSync(filePath)) {
      res.status(404).json({ error: 'NOT_FOUND', message: 'File not found' });
      return;
    }
    res.sendFile(filePath);
  });

  /** Upload a review photo. Returns the public URL to embed in the review. */
  router.post(
    '/review-photos',
    requireRole('STUDENT', 'FACULTY', 'STAFF', 'EXECUTIVE'),
    (req, res, next) => {
      upload.single('photo')(req, res, (err) => {
        if (err) {
          next(err);
          return;
        }

        const file = req.file;
        if (!file) {
          next(new AppError(400, 'NO_FILE', 'No photo file was included in the request.'));
          return;
        }

        // Validate magic bytes after the file is on disk.
        if (!checkMagicBytes(file.path, file.mimetype)) {
          fs.unlinkSync(file.path);
          next(
            new AppError(
              415,
              'INVALID_FILE',
              'The file contents do not match its declared type.',
            ),
          );
          return;
        }

        const url = photoPublicUrl(config, file.filename);
        res.status(201).json({ url, filename: file.filename });
      });
    },
  );

  return router;
}
