export async function onRequest(context) {
  const { env, request } = context;
  if (request.method !== 'POST') return new Response('Method Not Allowed', { status: 405 });

  const authHeader = request.headers.get('Authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return Response.json({ message: '未登录或登录已过期' }, { status: 401 });
  }

  const token = authHeader.split(' ')[1];
  let userId;
  try {
    const payloadBase64 = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    const payload = JSON.parse(atob(payloadBase64));
    userId = payload.userId;
    if (!userId) throw new Error('Invalid token');
  } catch (e) {
    return Response.json({ message: '登录凭证无效，请重新登录' }, { status: 401 });
  }

  try {
    const body = await request.json();
    const { url, title, description, category_id } = body;

    if (!url || !title || !category_id) {
      return Response.json({ message: '缺少必填字段' }, { status: 400 });
    }

    let domain = '';
    try {
      const u = new URL(url);
      domain = u.hostname.replace(/^www\./, '');
    } catch (e) {
      return Response.json({ message: '网址格式不正确' }, { status: 400 });
    }

    // 1. 查重：检查 sites 表（已收录）
    const existingSite = await env.DB.prepare('SELECT id FROM sites WHERE registrable_domain = ?').bind(domain).first();
    if (existingSite) {
      return Response.json({ message: '该网址已在首页收录，无需重复提交' }, { status: 409 });
    }

    // 2. 查重：检查 submissions 表（待审核队列）
    const existingSub = await env.DB.prepare("SELECT id FROM submissions WHERE registrable_domain = ? AND status IN ('pending', 'under_review')").bind(domain).first();
    if (existingSub) {
      return Response.json({ message: '该网址已在审核队列中，请耐心等待，勿重复提交' }, { status: 409 });
    }

    // 3. 写入数据库
    await env.DB.prepare(
      'INSERT INTO submissions (user_id, url, registrable_domain, title, description, category_id, status) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).bind(userId, url, domain, title, description, category_id, 'pending').run();

    return Response.json({ success: true, message: '投稿成功' });
  } catch (err) {
    console.error('[submissions] 错误:', err);
    return Response.json({ message: '服务器错误: ' + err.message }, { status: 500 });
  }
}