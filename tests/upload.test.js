import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isAllowedUpload, uploadContentType } from '../src/config/upload.js';

test('uploads accept PDFs and every common image format', () => {
  const ok = [
    ['application/pdf', 'agreement.pdf'],
    ['image/jpeg', 'photo.jpg'],
    ['image/jpeg', 'photo.JPEG'],
    ['image/png', 'scan.png'],
    ['image/webp', 'scan.webp'],
    ['image/gif', 'scan.gif'],
    ['image/bmp', 'scan.bmp'],
    ['image/tiff', 'scan.tiff'],
    ['image/heic', 'IMG_0001.HEIC'],
    ['image/avif', 'scan.avif'],
    ['application/octet-stream', 'IMG_0002.heic'], // phone photo with no MIME type
    ['', 'IMG_0003.heif'],
  ];
  for (const [mimetype, originalname] of ok) {
    assert.equal(isAllowedUpload({ mimetype, originalname }), true, `${originalname} (${mimetype})`);
  }
});

test('uploads reject SVG, non-documents, and a MIME type that contradicts the extension', () => {
  const bad = [
    ['image/svg+xml', 'logo.svg'],
    ['application/zip', 'files.zip'],
    ['text/html', 'page.html'],
    ['image/png', 'page.html'], // image MIME, HTML file
    ['text/html', 'fake.png'], // image name, HTML MIME
    ['application/octet-stream', 'fake.png'], // only HEIC/HEIF may arrive untyped
    ['image/png', 'no-extension'],
  ];
  for (const [mimetype, originalname] of bad) {
    assert.equal(isAllowedUpload({ mimetype, originalname }), false, `${originalname} (${mimetype})`);
  }
});

test('the stored content type comes from the extension, not the browser', () => {
  assert.equal(uploadContentType({ originalname: 'IMG_0002.heic', mimetype: 'application/octet-stream' }), 'image/heic');
  assert.equal(uploadContentType({ originalname: 'photo.JPG', mimetype: 'image/jpg' }), 'image/jpeg');
  assert.equal(uploadContentType({ originalname: 'agreement.pdf', mimetype: 'application/pdf' }), 'application/pdf');
});
