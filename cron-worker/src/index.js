export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runAutomatedPipeline(env));
  },
  async fetch(request, env) {
    if (new URL(request.url).pathname === '/trigger') {
      await runAutomatedPipeline(env);
      return new Response('✅ 智能榨干版采集完成', { status: 200 });
    }
    return new Response('运行中', { status: 200 });
  }
};

async function runAutomatedPipeline(env) {
  const { DB } = env;
  if (!DB) return console.error('❌ 找不到 D1 数据库绑定');

  console.log('🟢 [1/5] 智能采集任务启动...');
  let allCandidateItems = [];

  // ================= 引擎 1：Awesome 宝藏库 =================
  const awesomeUrls = [
    'https://raw.githubusercontent.com/sindresorhus/awesome/main/readme.md',
    'https://raw.githubusercontent.com/awesome-selfhosted/awesome-selfhosted/master/README.md'
  ];
  for (const url of awesomeUrls.sort(() => 0.5 - Math.random()).slice(0, 1)) {
    try {
      const text = await (await fetch(url)).text();
      const regex = /\[([^\]]+)\]\((https?:\/\/[^\)]+)\)/g;
      let match, count = 0;
      while ((match = regex.exec(text)) !== null && count < 20) {
        allCandidateItems.push({ url: match[2], originalTitle: match[1] });
        count++;
      }
    } catch (e) {}
  }

  // ================= 引擎 2：中外综合 RSS =================
  const rssFeeds = [
    { url: 'https://sspai.com/feed' },
    { url: 'https://36kr.com/feed' },
    { url: 'https://www.ithome.com/rss/' },
    { url: 'https://www.v2ex.com/index.xml' }
  ];
  for (const feed of rssFeeds.sort(() => 0.5 - Math.random()).slice(0, 2)) {
    try {
      const xml = await (await fetch(feed.url, { headers: { 'User-Agent': 'Mozilla/5.0' } })).text();
      const itemRegex = /<item>[\s\S]*?<title>(.*?)<\/title>[\s\S]*?<link>(.*?)<\/link>[\s\S]*?<\/item>/g;
      let match, count = 0;
      while ((match = itemRegex.exec(xml)) !== null && count < 15) {
        const title = match[1].replace(/<!\[CDATA\[|\]\]>/g, '').trim();
        const link = match[2].trim();
        if (link.startsWith('http')) {
          allCandidateItems.push({ url: link, originalTitle: title });
          count++;
        }
      }
    } catch (e) {}
  }

  // ================= 引擎 3：高强度外链蜘蛛 =================
  try {
    // 每次随机抽 3 个已有站点去爬
    const { results } = await DB.prepare(`SELECT url FROM sites ORDER BY RANDOM() LIMIT 3`).all();
    for (const site of results) {
      try {
        const res = await fetch(site.url, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(4000) });
        if (!res.ok) continue;
        const html = await res.text();
        const regex = /<a[^>]+href=["'](https?:\/\/[^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
        let match, count = 0;
        while ((match = regex.exec(html)) !== null && count < 10) {
          const title = match[2].replace(/<[^>]+>/g, '').trim();
          if (title.length > 1) { // 必须有文字，跳过纯图标链接
            allCandidateItems.push({ url: match[1], originalTitle: title });
            count++;
          }
        }
      } catch (e) {}
    }
  } catch (e) {}

  console.log(`🟡 [2/5] 总计获取 ${allCandidateItems.length} 条原始数据，开始智能净化与去重...`);

  // ================= 核心清洗与黑名单 =================
  const uniqueCandidates = [];
  const seenDomains = new Set();
  
  for (const item of allCandidateItems) {
    const cleanUrl = normalizeUrl(item.url);
    if (!cleanUrl) continue; // 被黑名单拦截或格式不对

    let hostname = '';
    try {
      hostname = new URL(cleanUrl).hostname.toLowerCase().replace(/^www\./, '');
    } catch (e) { continue; }
    
    if (seenDomains.has(hostname)) continue;
    seenDomains.add(hostname);
    
    const existing = await DB.prepare('SELECT id FROM sites WHERE registrable_domain = ?').bind(hostname).first();
    if (existing) continue; 
    
    uniqueCandidates.push({ 
      url: cleanUrl, 
      hostname: hostname, 
      originalTitle: item.originalTitle 
    });
  }

  console.log(`🟡 [3/5] 净化后，发现 ${uniqueCandidates.length} 个新域名。开始验证与 SEO 抓取...`);

  // ================= 验证、抓取真实信息、智能分类 =================
  const itemsToVerify = uniqueCandidates.slice(0, 30);
  let insertedCount = 0;
  
  for (let i = 0; i < itemsToVerify.length; i += 5) {
    const batch = itemsToVerify.slice(i, i + 5);
    await Promise.all(batch.map(async (item) => {
      // 爬取真实网页的 SEO 信息（不仅验证死活，还拿标题和描述）
      const seoData = await fetchSeoInfo(item.url);
      
      if (!seoData) {
        console.log(`⚠️ 无法访问: ${item.hostname}`);
        return;
      }
      
      // 组合最完美的标题和描述
      const finalTitle = seoData.title || item.originalTitle || item.hostname;
      const finalDesc = seoData.description || '优质网站自动收录';
      
      // 🧠 智能分类引擎（根据抓到的文字自动打标签）
      const categoryId = autoCategorize(finalTitle, finalDesc, item.url);

      try {
        await DB.prepare(`INSERT INTO sites (url, registrable_domain, title, description, category_id, status) VALUES (?, ?, ?, ?, ?, 'active')`).bind(item.url, item.hostname, finalTitle, finalDesc, categoryId).run();
        await DB.prepare(`INSERT INTO submissions (user_id, url, registrable_domain, title, description, category_id, status) VALUES (999, ?, ?, ?, ?, ?, 'published')`).bind(item.url, item.hostname, finalTitle, finalDesc, categoryId).run();
        insertedCount++;
        console.log(`✅ 入库: [${finalTitle}] ${item.hostname} (分类:${categoryId})`);
      } catch (dbErr) { }
    }));
  }
  
  console.log(`🏁 [4/5] 任务结束！本轮成功新增 ${insertedCount} 个站点。`);
}

// ================= 超级工具库 =================

// 1. URL 净化器：去伪存真，只留纯净主域名，拉黑垃圾站
function normalizeUrl(rawUrl) {
  try {
    const u = new URL(rawUrl);
    const domain = u.hostname.toLowerCase();

    // 🚫 强力黑名单（社交、条款、订阅、大厂内部页）
    const blacklist = [
      'facebook.com', 'twitter.com', 'x.com', 'instagram.com', 'youtube.com', 
      'linkedin.com', 'pinterest.com', 'feedburner.com', 'w3.org', 'wikipedia.org',
      'google.com', 'baidu.com', 'github.com', 'gitee.com' // 纯导航站收录这些大厂首页意义不大，如果有特定子站另行处理
    ];
    if (blacklist.some(b => domain.includes(b))) return null;

    const path = u.pathname.toLowerCase();
    // 🚫 路径黑名单
    const badPaths = ['/terms', '/privacy', '/login', '/signup', '/about', '/contact', '/service', '/agreement'];
    if (badPaths.some(p => path.includes(p))) return null;
    
    // 🚫 垃圾后缀
    if (path.endsWith('.xml') || path.endsWith('.rss') || path.endsWith('.json')) return null;

    // ✂️ 核心截断：无论 URL 多长，强制变成 协议 + 域名 + 根路径
    return `${u.protocol}//${u.hostname}/`;
  } catch (e) {
    return null;
  }
}

// 2. 智能分类引擎
function autoCategorize(title, desc, url) {
  const text = (title + ' ' + desc + ' ' + url).toLowerCase();
  if (/小说|阅读|文学|书|novel|book|read|chapter/i.test(text)) return 1;
  if (/影视|电影|视频|剧|movie|film|tv|video|bilibili|douban/i.test(text)) return 2;
  if (/音乐|歌|audio|music|radio|song|163\.com|qq\.com\/music/i.test(text)) return 3;
  if (/游戏|电竞|game|play|steam|手游/i.test(text)) return 4;
  if (/新闻|资讯|媒体|news|info/i.test(text)) return 6;
  if (/工具|开发|下载|软件|tool|utility|api|dev/i.test(text)) return 5;
  return 7; // 实在认不出来，扔到“其他”
}

// 3. 验证与抓取 SEO
async function fetchSeoInfo(url) {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);
    
    const res = await fetch(url, { 
      method: 'GET', 
      redirect: 'follow', 
      signal: controller.signal, 
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0' } 
    });
    
    clearTimeout(timeoutId);
    
    // 只要不是 404/500，算活着
    if (![200, 201, 202, 204, 301, 302, 304, 401, 403, 429].includes(res.status)) {
      return null; 
    }

    if (!res.headers.get('content-type')?.includes('text/html')) {
      return { title: '', description: '' }; 
    }

    const html = await res.text();
    
    let title = '';
    const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    if (titleMatch) title = titleMatch[1].trim().replace(/\s+/g, ' ').substring(0, 50);

    let description = '';
    const descMatch = html.match(/<meta[^>]*name=["']description["'][^>]*content=["']([\s\S]*?)["']/i) || 
                      html.match(/<meta[^>]*content=["']([\s\S]*?)["'][^>]*name=["']description["']/i);
    if (descMatch) description = descMatch[1].trim().replace(/\s+/g, ' ').substring(0, 150);

    return { title, description };
  } catch (err) {
    return null;
  }
}