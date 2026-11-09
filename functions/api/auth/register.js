export async function onRequest(context) {
  const { env, request } = context;
  if (request.method !== 'POST') return new Response('Method Not Allowed', { status: 405 });

  try {
    const { email, password, turnstileToken } = await request.json();

    if (!email || !password || !turnstileToken) {
      return Response.json({ message: '参数不完整' }, { status: 400 });
    }

    // 1. 验证 Turnstile
    const verifyRes = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        secret: env.TURNSTILE_SECRET,
        response: turnstileToken
      })
    });
    const verifyData = await verifyRes.json();
    
    if (!verifyData.success) {
      console.warn('[register] Turnstile 验证失败:', verifyData);
      return Response.json({ message: '人机验证失败，请刷新重试' }, { status: 400 });
    }

    // 2. 检查邮箱是否已存在
    const existing = await env.DB.prepare('SELECT id FROM users WHERE email = ?').bind(email).first();
    if (existing) {
      return Response.json({ message: '该邮箱已注册' }, { status: 409 });
    }

    // 3. 密码哈希 (使用 Web Crypto SHA-256)
    const msgBuffer = new TextEncoder().encode(password);
    const hashBuffer = await crypto.subtle.digest('SHA-256', msgBuffer);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    const passwordHash = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');

    // 4. 写入数据库
    await env.DB.prepare(
      'INSERT INTO users (email, password_hash) VALUES (?, ?)'
    ).bind(email, passwordHash).run();

    return Response.json({ success: true, message: '注册成功' });
    
  } catch (err) {
    console.error('[register] 错误:', err);
    return Response.json({ message: '服务器内部错误' }, { status: 500 });
  }
}