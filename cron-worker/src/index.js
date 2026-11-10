export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runAutomatedPipeline(env));
  },
  async fetch(request, env) {
    if (new URL(request.url).pathname === '/trigger') {
      await runAutomatedPipeline(env);
      return new Response('✅ 采集完毕，请刷新网页查看。', { status: 200 });
    }
    return new Response('运行中', { status: 200 });
  }
};

async function runAutomatedPipeline(env) {
  const { DB } = env;
  if (!DB) return;

  console.log('[cron] 🚀 开始采集...');
  let allCandidateItems = [];

  try { allCandidateItems.push(...await collectRSS()); } catch (e) { }
  try { allCandidateItems.push(...await collectAwesomeLists()); } catch (e) { }

  const uniqueCandidates = [];
  const seenDomains = new Set();
  
  for (const item of allCandidateItems) {
    if (!item.url || !item.url.startsWith('http')) continue;
    let hostname = '';
    try {
      const u = new URL(item.url);
      hostname = u.hostname.toLowerCase().replace(/^www\./, '');
      if (['localhost', '127.0.0.1'].some(b => hostname.includes(b))) continue;
    } catch (e) { continue; }
    
    if (seenDomains.has(hostname)) continue;
    seenDomains.add(hostname);
    
    const existing = await DB.prepare('SELECT id FROM sites WHERE registrable_domain = ?').bind(hostname).first();
    if (existing) continue;
    
    uniqueCandidates.push({ url: item.url, hostname, title: item.title || hostname, description: item.description || '自动收录', categoryId: item.categoryId || 7 });
  }

  const itemsToVerify = uniqueCandidates.slice(0, 10); // 每次只跑10个
  let insertedCount = 0;
  
  for (const item of itemsToVerify) {
    const isAlive = await verifyUrl(item.url);
    if (isAlive) {
      try {
        // 写入正式表
        await DB.prepare(`INSERT INTO sites (url, registrable_domain, title, description, category_id, status) VALUES (?, ?, ?, ?, ?, 'active')`).bind(item.url, item.hostname, item.title, item.description, item.categoryId).run();
        // 写入流水表
        await DB.prepare(`INSERT INTO submissions (user_id, url, registrable_domain, title, description, category_id, status) VALUES (999, ?, ?, ?, ?, ?, 'published')`).bind(item.url, item.hostname, item.title, item.description, item.categoryId).run();
        insertedCount++;
        console.log(`✅ 成功入库: ${item.hostname}`);
      } catch (dbErr) {
        // 🔥 把真实的数据库报错打印出来！
        console.error(`❌ 数据库写入失败 [${item.hostname}]:`, dbErr.message);
      }
    }
  }
  console.log(`[cron] 本批完成，新增: ${insertedCount} 个`);
}

async function collectRSS() {
  let items = [];
  try {
    const xml = await (await fetch('https://sspai.com/feed')).text();
    const regex = /<link>(https?:\/\/[^<]+)<\/link>/g;
    let match;
    while ((match = regex.exec(xml)) !== null) {
      if (!match[1].includes('.xml') && match[1] !== 'https://sspai.com/feed') items.push({ url: match[1], title: '最新资讯', description: 'RSS资讯', categoryId: 5 });
    }
  } catch (e) {}
  return items;
}

async function collectAwesomeLists() {
  let items = [];
  try {
    const text = await (await fetch('https://raw.githubusercontent.com/sindresorhus/awesome/main/readme.md')).text();
    const regex = /\[([^\]]+)\]\((https?:\/\/[^\)]+)\)/g;
    let match, count = 0;
    while ((match = regex.exec(text)) !== null && count < 15) {
      if (!match[2].includes('github.com')) {
        items.push({ url: match[2], title: match[1], description: '开源精选', categoryId: 5 });
        count++;
      }
    }
  } catch (e) {}
  return items;
}

async function verifyUrl(url) {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 3000);
    const res = await fetch(url, { method: 'GET', redirect: 'follow', signal: controller.signal, headers: { 'User-Agent': 'Mozilla/5.0' } });
    clearTimeout(timeoutId);
    return [200, 201, 202, 204, 301, 302, 304, 401, 403, 429].includes(res.status);
  } catch (err) { return false; }
}