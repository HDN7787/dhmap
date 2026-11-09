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
    const payload = JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
    userId = payload.userId;
  } catch (e) { return Response.json({ message: '登录无效' }, { status: 401 }); }

  try {
    const body = await request.json();
    const { url, title, description, category_id } = body;

    if (!url || !title || !category_id) return Response.json({ message: '缺少必填字段' }, { status: 400 });

    let domain = '';
    try { domain = new URL(url).hostname.replace(/^www\./, ''); } 
    catch (e) { return Response.json({ message: '网址格式不正确' }, { status: 400 }); }

    // 查重
    const existingSite = await env.DB.prepare('SELECT id FROM sites WHERE registrable_domain = ?').bind(domain).first();
    if (existingSite) return Response.json({ message: '该网址已在首页收录，无需重复提交' }, { status: 409 });

    const existingSub = await env.DB.prepare("SELECT id FROM submissions WHERE registrable_domain = ? AND status = 'published'").bind(domain).first();
    if (existingSub) return Response.json({ message: '该网址已发布，请勿重复提交' }, { status: 409 });

    // 核心：自动验证网址是否存活 (6秒超时)
    console.log(`[api/submissions] 验证用户提交: ${url}`);
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 6000);
    let isAlive = false;
    try {
      const res = await fetch(url, { method: 'GET', signal: controller.signal, redirect: 'follow', headers: { 'User-Agent': 'Mozilla/5.0' } });
      // 容忍 401, 403 等反爬状态码
      isAlive = [200, 201, 202, 204, 301, 302, 304, 401, 403, 429].includes(res.status);
    } catch (e) { isAlive = false; } finally { clearTimeout(timeoutId); }

    if (!isAlive) {
      // 验证失败，写入流水表记录为 rejected
      await env.DB.prepare(
        "INSERT INTO submissions (user_id, url, registrable_domain, title, description, category_id, status) VALUES (?, ?, ?, ?, ?, ?, 'rejected')"
      ).bind(userId, url, domain, title, description, category_id).run();
      return Response.json({ message: '无法访问该网址（已超时或被拦截），提交被拒绝' }, { status: 400 });
    }

    // 验证成功：直接写入 sites 表，状态 active
    await env.DB.prepare(`
      INSERT INTO sites (url, registrable_domain, title, description, category_id, status, is_user_submitted)
      VALUES (?, ?, ?, ?, ?, 'active', 1)
    `).bind(url, domain, title, description, category_id).run();

    // 写入 submissions 流水表，状态直接是 published
    await env.DB.prepare(
      "INSERT INTO submissions (user_id, url, registrable_domain, title, description, category_id, status) VALUES (?, ?, ?, ?, ?, ?, 'published')"
    ).bind(userId, url, domain, title, description, category_id).run();

    return Response.json({ success: true, message: '发布成功' });

  } catch (err) {
    return Response.json({ message: '服务器错误: ' + err.message }, { status: 500 });
  }
}