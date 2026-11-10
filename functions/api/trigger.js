export async function onRequest(context) {
  try {
    // 让 Pages 后台去请求你的 Worker
    const res = await fetch('https://nav-site-cron.83262110.workers.dev/trigger');
    const text = await res.text();
    return new Response('触发结果: ' + text, { status: 200 });
  } catch (err) {
    return new Response('触发失败: ' + err.message, { status: 500 });
  }
}