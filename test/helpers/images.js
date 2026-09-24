// Synthetic durable attachment seam; no real files, credentials or image I/O.
import assert from 'node:assert/strict';
export const imageData = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1sAAAAASUVORK5CYII=', 'base64');
export const imageRef = Object.freeze({ attachmentId: 'fixture-image', mediaType: 'image/png', bytes: imageData.length, width: 1, height: 1 });
export const imageBlock = () => ({ type: 'image', attachment: { ...imageRef } });
export function fakeAttachments() {
  const reads = [];
  return { reads, imageHostPath: () => '/synthetic/fixture-image.png', async readImageRequest(ref, policy, signal) {
    signal?.throwIfAborted();
    assert.deepEqual(ref, imageRef);
    // The real store rejects omitted request-policy defaults with this code.
    for (const key of ['width', 'height', 'maxBytes']) {
      if (!Number.isSafeInteger(policy?.[key]) || policy[key] <= 0) throw Object.assign(new Error(`${key} must be positive`), { code: 'INVALID_ATTACHMENT_REF' });
    }
    reads.push({ ref, policy });
    return { attachment: ref, variantId: 'fixture-variant', data: imageData, mediaType: 'image/png', bytes: imageData.length, width: 1, height: 1, depth: 'uchar', space: 'srgb', hasAlpha: true };
  } };
}
