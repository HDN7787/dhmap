export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runAutomatedPipeline(env));
  },
  async fetch(request, env) {
    if (new URL(request.url).pathname === '/trigger') {
      await runAutomatedPipeline(env);
      return new Response('✅ 采集触发成功，请去 Cloudflare 后台看日志！', { status: 200 });
    }
    return new Response('运行中', { status: 200 });
  }
};

async function runAutomatedPipeline(env) {
  const { DB } = env;
  if (!DB) {
    console.error('❌ 致命错误: 找不到 D1 数据库绑定');
    return;
  }

  console.log('🟢 [1/5] 采集任务开始启动...');
  let allCandidateItems = [];

  // 固定源：少数派 RSS
  try {
    console.log('🟢 [2/5] 正在抓取 少数派 RSS...');
    const xml = await (await fetch('https://sspai.com/feed', { headers: { 'User-Agent': 'Mozilla/5.0' } })).text();
    const regex = /<link>(https?:\/\/[^<]+)<\/link>/g;
    let match;
    while ((match = regex.exec(xml)) !== null) {
      if (!match[1].includes('.xml') && match[1] !== 'https://sspai.com/feed') {
        allCandidateItems.push({ url: match[1], title: '最新资讯', description: 'RSS资讯', categoryId: 5 });
      }
    }
    console.log(`🔵 RSS 抓取完成，获取了 ${allCandidateItems.length} 个候选网址`);
  } catch (e) {
    console.error('❌ RSS 抓取失败:', e.message);
  }

  // 固定源：Awesome 库
  try {
    console.log('🟢 [3/5] 正在抓取 GitHub Awesome 库...');
    const text = await (await fetch('https://raw.githubusercontent.com/sindresorhus/awesome/main/readme.md')).text();
    const regex = /\[([^\]]+)\]\((https?:\/\/[^\)]+)\)/g;
    let match, count = 0;
    while ((match = regex.exec(text)) !== null && count < 20) {
      if (!match[2].includes('github.com')) {
        allCandidateItems.push({ url: match[2], title: match[1], description: '开源精选', categoryId: 5 });
        count++;
      }
    }
    console.log(`🔵 Awesome 抓取完成，获取了 ${count} 个候选网址`);
  } catch (e) {
    console.error('❌ Awesome 抓取失败:', e.message);
  }

  console.log(`🟡 [4/5] 总计获取 ${allCandidateItems.length} 个原始数据，开始去重...`);

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
    if (existing) {
      continue; // 数据库已有，跳过
    }
    
    uniqueCandidates.push({ url: item.url, hostname, title: item.title || hostname, description: item.description || '自动收录', categoryId: item.categoryId || 7 });
  }

  console.log(`🟡 去重后，发现 ${uniqueCandidates.length} 个全新域名。准备验证...`);

  const itemsToVerify = uniqueCandidates.slice(0, 15);
  let insertedCount = 0;
  
  for (const item of itemsToVerify) {
    console.log(`🟢 [5/5] 正在验证死活: ${item.hostname}...`);
    const isAlive = await verifyUrl(item.url);
    
    if (isAlive) {
      try {
        await DB.prepare(`INSERT INTO sites (url, registrable_domain, title, description, category_id, status) VALUES (?, ?, ?, ?, ?, 'active')`).bind(item.url, item.hostname, item.title, item.description, item.categoryId).run();
        await DB.prepare(`INSERT INTO submissions (user_id, url, registrable_domain, title, description, category_id, status) VALUES (999, ?, ?, ?, ?, ?, 'published')`).bind(item.url, item.hostname, item.title, item.description, item.categoryId).run();
        insertedCount++;
        console.log(`✅ 入库成功: ${item.hostname}`);
      } catch (dbErr) {
        console.error(`❌ 数据库写入失败 [${item.hostname}]:`, dbErr.message);
      }
    } else {
      console.log(`⚠️ 验证失败(死链/超时): ${item.hostname}`);
    }
  }
  
  console.log(`🏁 任务结束！本轮成功新增 ${insertedCount} 个站点。`);
}

async function verifyUrl(url) {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 4000);
    const res = await fetch(url, { method: 'GET', redirect: 'follow', signal: controller.signal, headers: { 'User-Agent': 'Mozilla/5.0' } });
    clearTimeout(timeoutId);
    return [200, 201, 202, 204, 301, 302, 304, 401, 403, 429].includes(res.status);
  } catch (err) { return false; }
}