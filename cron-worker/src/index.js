export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runAutomatedPipeline(env));
  },
  async fetch(request, env) {
    if (new URL(request.url).pathname === '/trigger') {
      await runAutomatedPipeline(env);
      return new Response('✅ 采集完成，请去 Observability 看日志', { status: 200 });
    }
    return new Response('运行中', { status: 200 });
  }
};

async function runAutomatedPipeline(env) {
  const { DB } = env;
  if (!DB) return console.error('❌ 找不到 D1 数据库绑定');

  console.log('🟢 [1/5] 任务启动，开始抓取源...');
  let allCandidateItems = [];

  // 引擎 1：社区小说源
  try {
    console.log('📖 抓取小说源...');
    const res = await fetch('https://raw.githubusercontent.com/entr0pia/MyLegadoSource/master/bookSource.json', { signal: AbortSignal.timeout(4000) });
    if (res.ok) {
      const data = await res.json();
      // 稍微扩大一点提取数量
      for (const book of data.slice(0, 30)) {
        const u = book.bookSourceUrl;
        if (u && u.startsWith('http')) allCandidateItems.push({ url: u, originalTitle: book.bookSourceName || '小说站点', categoryId: 1 });
      }
      console.log(`✅ 小说源成功，提取 ${Math.min(data.length, 30)} 条`);
    }
  } catch (e) { console.error('❌ 小说源异常:', e.message); }

  // 引擎 2：B站排行榜 (加入更逼真的伪装头)
  try {
    console.log('📺 抓取 B站排行榜...');
    const res = await fetch('https://www.bilibili.com/v/popular/rank/all', { 
      headers: { 
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Referer': 'https://www.bilibili.com/',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8'
      }, 
      signal: AbortSignal.timeout(4000) 
    });
    if (res.ok) {
      const html = await res.text();
      const regex = /href="(\/\/www\.bilibili\.com\/video\/[a-zA-Z0-9]+)"[^>]*>[\s\S]*?class="title">([^<]+)<\/a>/g;
      let match, count = 0;
      while ((match = regex.exec(html)) !== null && count < 10) {
        allCandidateItems.push({ url: `https:${match[1]}`, originalTitle: match[2], categoryId: 2 });
        count++;
      }
      console.log(`✅ B站成功，提取 ${count} 条`);
    } else {
      console.error(`❌ B站拉取失败，状态码: ${res.status}`);
    }
  } catch (e) { console.error('❌ B站异常:', e.message); }

  // 引擎 3：百度千帆 AI 搜索
  try {
    console.log('🔍 调用百度千帆搜索...');
    const baiduItems = await collectBaiduSearch(env);
    allCandidateItems.push(...baiduItems);
    console.log(`✅ 百度搜索成功，提取 ${baiduItems.length} 条`);
  } catch (e) { console.error('❌ 百度搜索异常:', e.message); }

  console.log(`🟡 [2/5] 总计获取 ${allCandidateItems.length} 个原始数据，开始清洗...`);

  const uniqueCandidates = [];
  const seenDomains = new Set();
  const sensitiveWords = ['成人', '色情', 'av', 'porn', '博彩', '赌场', '六合彩', '福利'];
  const badDomains = ['baijiahao.baidu.com', 'zhuanlan.zhihu.com', 'www.zhihu.com', 'mp.weixin.qq.com'];
  
  const now = Date.now();

  for (const item of allCandidateItems) {
    if (!item.url) continue;
    if (item.originalTitle && sensitiveWords.some(w => item.originalTitle.toLowerCase().includes(w))) continue;

    let hostname = '';
    try { hostname = new URL(item.url).hostname.toLowerCase().replace(/^www\./, ''); } catch (e) { continue; }

    if (badDomains.includes(hostname)) continue;
    
    // 强制截断回主域名
    if (hostname.endsWith('.163.com')) hostname = '163.com';
    if (hostname.endsWith('.sina.com.cn')) hostname = 'sina.com.cn';
    if (hostname.endsWith('.sohu.com')) hostname = 'sohu.com';
    if (hostname.endsWith('.qq.com') && hostname !== 'y.qq.com' && hostname !== 'v.qq.com') hostname = 'qq.com';
    if (hostname.startsWith('m.')) hostname = hostname.replace(/^m\./, '');
    if (hostname.startsWith('wap.')) hostname = hostname.replace(/^wap\./, '');
    if (hostname.startsWith('shouyou.')) hostname = hostname.replace(/^shouyou\./, '');
    if (hostname.endsWith('.3dmgame.com')) hostname = '3dmgame.com';
    if (hostname.endsWith('.gamersky.com')) hostname = 'gamersky.com';

    if (seenDomains.has(hostname)) continue;
    seenDomains.add(hostname);
    
    // 1. 查主表
    const existing = await DB.prepare('SELECT id FROM sites WHERE registrable_domain = ?').bind(hostname).first();
    if (existing) continue; 

    // 2. 查黑名单
    const isDead = await DB.prepare('SELECT domain FROM dead_domains WHERE domain = ? AND expire_at > ?').bind(hostname, now).first();
    if (isDead) {
      console.log(`⏩ 跳过黑名单: ${hostname}`);
      continue;
    }
    
    uniqueCandidates.push({ 
      url: `https://${hostname}/`, hostname: hostname, 
      originalTitle: item.originalTitle, description: item.description || '', categoryId: item.categoryId 
    });
  }

  console.log(`🟡 [3/5] 净化后剩余 ${uniqueCandidates.length} 个新域名，开始验证...`);

  const itemsToVerify = uniqueCandidates.slice(0, 25);
  let insertedCount = 0;
  
  for (let i = 0; i < itemsToVerify.length; i += 5) {
    const batch = itemsToVerify.slice(i, i + 5);
    await Promise.all(batch.map(async (item) => {
      const result = await fetchAndDecodeSeo(item.url);
      
      if (result.status === 'DEAD') {
        const expireAt = Date.now() + 30 * 24 * 60 * 60 * 1000; 
        await DB.prepare('INSERT OR REPLACE INTO dead_domains (domain, expire_at) VALUES (?, ?)').bind(item.hostname, expireAt).run();
        console.log(`⚠️ 真死链入狱: ${item.hostname}`);
        return;
      }
      
      const finalTitle = result.title || item.originalTitle;
      const finalDesc = result.description || item.description || '精选优质站点';
      
      if (sensitiveWords.some(w => (finalTitle + finalDesc).toLowerCase().includes(w))) return;
      
      try {
        await DB.prepare(`INSERT INTO sites (url, registrable_domain, title, description, category_id, status) VALUES (?, ?, ?, ?, ?, 'active')`).bind(item.url, item.hostname, finalTitle, finalDesc, item.categoryId).run();
        await DB.prepare(`INSERT INTO submissions (user_id, url, registrable_domain, title, description, category_id, status) VALUES (999, ?, ?, ?, ?, ?, 'published')`).bind(item.url, item.hostname, finalTitle, finalDesc, item.categoryId).run();
        
        await DB.prepare('DELETE FROM dead_domains WHERE domain = ?').bind(item.hostname).run();
        
        insertedCount++;
        console.log(`✅ 入库成功: [${finalTitle}] ${item.hostname}`);
      } catch (dbErr) { }
    }));
  }
  console.log(`🏁 [5/5] 任务结束！本轮成功新增 ${insertedCount} 个站点。`);
}

// ================= 百度搜索 (加入 429 熔断机制) =================
async function collectBaiduSearch(env) {
  const apiKey = env.BAIDU_API_KEY;
  if (!apiKey) return [];
  
  const keywordMap = [
    { kw: '在线小说阅读', cat: 1 }, { kw: '免费影视网站', cat: 2 },
    { kw: '音乐播放器', cat: 3 }, { kw: '单机游戏下载', cat: 4 },
    { kw: '在线工具', cat: 5 }, { kw: '科技新闻资讯', cat: 6 }
  ];
  let items = [];
  for (const { kw, cat } of keywordMap) {
    try {
      const res = await fetch('https://qianfan.baidubce.com/v2/ai_search/web_search', {
        method: 'POST', headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: [{ role: 'user', content: kw }], resource_type_filter: [{ type: 'web', top_k: 10 }], search_source: 'baidu_search_v2', edition: 'standard' }),
        signal: AbortSignal.timeout(8000)
      });
      
      // 🔥 核心熔断：一旦发现 429 额度耗尽，立刻停止后续请求，不浪费一丝时间
      if (res.status === 429) {
        console.error(`❌ 百度API 触发 429 限流！额度耗尽，立即终止后续搜索。`);
        break; 
      }

      if (!res.ok) {
        console.error(`❌ 百度API 报错 (状态码 ${res.status})`);
        continue;
      }

      const data = await res.json();
      for (const ref of data.references || []) {
        if (!ref.url || (ref.type && ref.type !== 'web')) continue;
        items.push({ url: ref.url, originalTitle: ref.title || kw, description: ref.snippet || '', categoryId: cat });
      }
      await new Promise(r => setTimeout(r, 500)); // 礼貌延迟
    } catch (e) { }
  }
  return items;
}

// ================= 验证与转码 =================
async function fetchAndDecodeSeo(url) {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);
    
    const res = await fetch(url, { 
      method: 'GET', redirect: 'follow', signal: controller.signal, 
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0' } 
    });
    clearTimeout(timeoutId);
    
    if ([403, 429, 412, 503].includes(res.status)) return { status: 'ALIVE_BLOCKED', title: '', description: '' };
    if (res.status !== 200) return { status: 'DEAD' };
    if (!res.headers.get('content-type')?.includes('text/html')) return { status: 'ALIVE_BLOCKED', title: '', description: '' };

    const buffer = await res.arrayBuffer();
    const utf8Decoder = new TextDecoder('utf-8');
    const utf8Html = utf8Decoder.decode(buffer);
    let charset = 'utf-8';
    const charsetMatch = utf8Html.match(/<meta[^>]*charset=["']?([a-zA-Z0-9-]+)["']?/i);
    if (charsetMatch) charset = charsetMatch[1].toLowerCase();

    let html = utf8Html;
    if (charset.includes('gbk') || charset.includes('gb2312') || charset.includes('gb18030')) {
      html = new TextDecoder('gbk').decode(buffer);
    }

    let title = '', description = '';
    const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    if (titleMatch) title = titleMatch[1].trim().substring(0, 50);
    const descMatch = html.match(/<meta[^>]*name=["']description["'][^>]*content=["']([\s\S]*?)["']/i);
    if (descMatch) description = descMatch[1].trim().substring(0, 150);

    title = title.replace(/[\u0000-\u001F\u007F-\u009F]/g, '');
    
    const badWords = ['Redirecting', '403 Forbidden', '404 Not Found', 'Just a moment', 'Verify Yourself', 'Cloudflare', 'Blocked', 'Access Denied', 'Site Not Found'];
    if (badWords.some(w => title.toLowerCase().includes(w.toLowerCase()))) return { status: 'ALIVE_BLOCKED', title: '', description: '' };

    return { status: 'SUCCESS', title, description };
  } catch (err) { 
    return { status: 'DEAD' }; 
  }
}