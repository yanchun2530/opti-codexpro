import { createHash } from 'node:crypto';

export const CLOUDFLARED_VERSION = '2026.7.2';
export const CLOUDFLARED_MAX_ASSET_BYTES = 128 * 1024 * 1024;

const ASSETS = new Map([
  ['darwin/arm64', {
    file: 'cloudflared-darwin-arm64.tgz',
    archive: true,
    sha256: '0588df58494a6cadd38b9deb6078908a5054063c80784d92fdb8d4a5f3de1c67'
  }],
  ['darwin/x64', {
    file: 'cloudflared-darwin-amd64.tgz',
    archive: true,
    sha256: 'a5afb0ba3da859da47bebc9a918d5b196bf7e4aec23589419b46356731bcc75f'
  }],
  ['linux/arm64', {
    file: 'cloudflared-linux-arm64',
    archive: false,
    sha256: '405df476437e027fc6d18729a5a77155c0a33a6082aeee60a799a688f3052e66'
  }],
  ['linux/arm', {
    file: 'cloudflared-linux-arm',
    archive: false,
    sha256: '80dc01d7e284f269395824de841f8c7396c6641871eacc46add53a394b4548f4'
  }],
  ['linux/x64', {
    file: 'cloudflared-linux-amd64',
    archive: false,
    sha256: 'ec905ea7b7e327ff8abdde8cb64697a2152de74dbcdbf6aec9db8364eb3886cd'
  }],
  ['linux/ia32', {
    file: 'cloudflared-linux-386',
    archive: false,
    sha256: 'cbad04f2700ae4d4971fe07e9ded67327142f2d3338aef86ae04e6042f7ce990'
  }],
  ['win32/x64', {
    file: 'cloudflared-windows-amd64.exe',
    archive: false,
    sha256: 'cdb5d4432f6ae1595654a692a51308b69d2bf7af961f5578d9391837cf072df9'
  }],
  ['win32/ia32', {
    file: 'cloudflared-windows-386.exe',
    archive: false,
    sha256: '32decf512bb37dfcf8f915e923b8132803cb0f7262995d0b168495694b1ee2d7'
  }]
]);

export function cloudflaredReleaseAsset(platform = process.platform, arch = process.arch) {
  const asset = ASSETS.get(`${platform}/${arch}`);
  if (!asset) {
    throw new Error(
      `Automatic cloudflared install is not supported on ${platform}/${arch}. ` +
      'Install cloudflared manually or pass --cloudflared <path>.'
    );
  }
  return { ...asset };
}

export function cloudflaredReleaseUrl(asset) {
  return `https://github.com/cloudflare/cloudflared/releases/download/${CLOUDFLARED_VERSION}/${asset.file}`;
}

export function verifyCloudflaredAsset(asset, bytes) {
  const actual = createHash('sha256').update(bytes).digest('hex');
  if (actual !== asset.sha256) {
    throw new Error(
      `cloudflared ${CLOUDFLARED_VERSION} checksum mismatch for ${asset.file}: ` +
      `expected ${asset.sha256}, received ${actual}.`
    );
  }
  return actual;
}

export async function readCloudflaredAssetResponse(response, asset, maxBytes = CLOUDFLARED_MAX_ASSET_BYTES) {
  const declaredLength = Number(response.headers?.get?.('content-length') ?? 0);
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new Error(`Refusing oversized cloudflared asset ${asset.file}: ${declaredLength} bytes exceeds ${maxBytes}.`);
  }
  if (!response.body) throw new Error(`cloudflared download returned no response body for ${asset.file}.`);

  const chunks = [];
  let total = 0;
  for await (const chunk of response.body) {
    const bytes = Buffer.from(chunk);
    total += bytes.byteLength;
    if (total > maxBytes) {
      throw new Error(`Refusing oversized cloudflared asset ${asset.file}: response exceeds ${maxBytes} bytes.`);
    }
    chunks.push(bytes);
  }
  const buffer = Buffer.concat(chunks, total);
  verifyCloudflaredAsset(asset, buffer);
  return buffer;
}
