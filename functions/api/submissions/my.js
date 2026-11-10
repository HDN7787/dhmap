export async function onRequest(context) {
  const { env, request } = context;
  if (request.method !== 'GET') return new Response('Method Not Allowed', { status: 405 });

  const auth = request.headers.get('Authorization');
  if (!auth || !auth.startsWith('Bearer ')) return Response.json({ message: '未登录' }, { status: 401 });

  try {
    const token = auth.split(' ')[1];
    const payloadBase64 = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    const payload = JSON.parse(atob(payloadBase64));
    const userId = payload.userId;

    const sql = `
      SELECT s.id, s.url, s.title, s.description, s.status, 
             datetime(s.created_at, '+8 hours') AS created_at, 
             c.name AS category_name
      FROM submissions s
      JOIN categories c ON s.category_id = c.id
      WHERE s.user_id = ? AND s.status != 'deleted'
      ORDER BY s.id DESC
    `;
    const { results } = await env.DB.prepare(sql).bind(userId).all();
    return Response.json(results);
  } catch (err) {
    return Response.json({ message: '服务器错误: ' + err.message }, { status: 500 });
  }
}