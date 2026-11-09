// 极简版 JWT 签名与验证 (使用 HMAC-SHA256)
const encoder = new TextEncoder();

async function getCryptoKey(secret) {
  return await crypto.subtle.importKey(
    'raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']
  );
}

function base64UrlEncode(str) {
  return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlDecode(str) {
  str = str.replace(/-/g, '+').replace(/_/g, '/');
  while (str.length % 4) str += '=';
  return atob(str);
}

export async function signToken(payload, secret) {
  const header = base64UrlEncode(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payloadStr = base64UrlEncode(JSON.stringify(payload));
  const data = `${header}.${payloadStr}`;
  const key = await getCryptoKey(secret);
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(data));
  
  // 修复：避免 String.fromCharCode(...bytes) 在 Cloudflare Workers 中栈溢出
  const bytes = new Uint8Array(signature);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  const signatureStr = base64UrlEncode(binary);
  return `${data}.${signatureStr}`;
}

export async function verifyToken(token, secret) {
  try {
    const [header, payload, signature] = token.split('.');
    const data = `${header}.${payload}`;
    const key = await getCryptoKey(secret);
    const sigBuffer = Uint8Array.from(base64UrlDecode(signature), c => c.charCodeAt(0));
    const isValid = await crypto.subtle.verify('HMAC', key, sigBuffer, encoder.encode(data));
    if (!isValid) return null;
    return JSON.parse(base64UrlDecode(payload));
  } catch (e) {
    return null;
  }
}