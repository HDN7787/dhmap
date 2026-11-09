const encoder = new TextEncoder();

async function signToken(payload, secret) {
  const header = btoa(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const payloadStr = btoa(JSON.stringify(payload)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const data = `${header}.${payloadStr}`;
  const key = await crypto.subtle.importKey(
    'raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(data));
  const bytes = new Uint8Array(signature);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  const signatureStr = btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `${data}.${signatureStr}`;
}

export async function onRequest(context) {
  const { env, request } = context;
  if (request.method !== 'POST') return new Response('Method Not Allowed', { status: 405 });

  try {
    const { email, password } = await request.json();
    if (!email || !password) return Response.json({ message: '邮箱和密码必填' }, { status: 400 });

    // 1. 查用户
    const user = await env.DB.prepare('SELECT * FROM users WHERE email = ?').bind(email).first();
    if (!user) return Response.json({ message: '邮箱或密码错误' }, { status: 401 });

    // 2. 验证密码
    const msgBuffer = encoder.encode(password);
    const hashBuffer = await crypto.subtle.digest('SHA-256', msgBuffer);
    const passwordHash = Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, '0')).join('');

    if (passwordHash !== user.password_hash) {
      return Response.json({ message: '邮箱或密码错误' }, { status: 401 });
    }

    // 3. 生成 Token (直接传入环境变量中的 JWT_SECRET)
    if (!env.JWT_SECRET) {
      throw new Error('后台未配置 JWT_SECRET 环境变量');
    }
    const token = await signToken({ userId: user.id, email: user.email }, env.JWT_SECRET);
    
    return Response.json({ success: true, token, email: user.email });

  } catch (err) {
    console.error('[login] 捕获到错误:', err);
    // 把真实错误发给前端，方便我们排查
    return Response.json({ message: '服务器错误: ' + err.message }, { status: 500 });
  }
}