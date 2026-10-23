import { afterEach, describe, expect, it, vi } from 'vitest';

const cloudinaryState = vi.hoisted(() => ({
  urlOptions: null,
  destroyOptions: null,
  url: 'https://api.cloudinary.test/signed-download',
}));

vi.mock('cloudinary', () => ({
  v2: {
    config: vi.fn(),
    utils: {
      private_download_url: vi.fn((_publicId, _format, options) => {
        cloudinaryState.urlOptions = options;
        return cloudinaryState.url;
      }),
    },
    uploader: {
      destroy: vi.fn(async (_publicId, options) => {
        cloudinaryState.destroyOptions = options;
        return { result: 'ok' };
      }),
    },
  },
}));

const { downloadStoredFile, removeStoredFile } = await import('../src/services/documentStorage.js');
const publicId = 'docchat/00000000-0000-4000-8000-000000000001.pdf';

afterEach(() => {
  vi.unstubAllGlobals();
  cloudinaryState.urlOptions = null;
  cloudinaryState.destroyOptions = null;
});

describe('Cloudinary document storage access', () => {
  it('downloads through a short-lived signed URL without redirects', async () => {
    const fetchMock = vi.fn(async () => new Response(Buffer.from('private pdf')));
    vi.stubGlobal('fetch', fetchMock);

    const result = await downloadStoredFile(publicId, 'raw', 'authenticated');

    expect(result.toString()).toBe('private pdf');
    expect(cloudinaryState.urlOptions).toMatchObject({
      resource_type: 'raw', type: 'authenticated', secure: true,
    });
    expect(cloudinaryState.urlOptions.expires_at).toBeGreaterThan(Math.floor(Date.now() / 1000));
    expect(fetchMock).toHaveBeenCalledWith(cloudinaryState.url, { redirect: 'error' });
  });

  it('uses the stored delivery type when deleting Cloudinary assets', async () => {
    await removeStoredFile(publicId, 'raw', 'authenticated');
    expect(cloudinaryState.destroyOptions).toMatchObject({ resource_type: 'raw', type: 'authenticated' });
  });

  it('rejects invalid storage references before making a network request', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(downloadStoredFile('../outside.pdf', 'raw', 'authenticated')).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
