import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isAllowedUpload } from '../src/config/upload.js';

test('uploads accept PDFs and every common image format', () => {
  const ok = [
    ['application/pdf', 'agreement.pdf'],
    ['image/jpeg', 'photo.jpg'],
    ['image/png', 'scan.png'],
    ['image/webp', 'scan.webp'],
    ['image/gif', 'scan.gif'],
    ['image/bmp', 'scan.bmp'],
    ['image/tiff', 'scan.tiff'],
    ['image/heic', 'IMG_0001.HEIC'],
    ['image/avif', 'scan.avif'],
    ['application/octet-stream', 'IMG_0002.heic'], // phone photo with no MIME type
  ];
  for (const [mimetype, originalname] of ok) {
    assert.equal(isAllowedUpload({ mimetype, originalname }), true, `${originalname} (${mimetype})`);
  }
});

test('uploads reject SVG and non-document files', () => {
  const bad = [
    ['image/svg+xml', 'logo.svg'],
    ['application/octet-stream', 'logo.svg'],
    ['application/zip', 'files.zip'],
    ['application/x-msdownload', 'setup.exe'],
    ['text/html', 'page.html'],
  ];
  for (const [mimetype, originalname] of bad) {
    assert.equal(isAllowedUpload({ mimetype, originalname }), false, `${originalname} (${mimetype})`);
  }
});
