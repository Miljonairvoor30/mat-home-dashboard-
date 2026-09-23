import { chromium } from "playwright";

const API_URL = process.env.MAT_HOME_WORKER_URL;
const OIDC_TOKEN = process.env.MAT_HOME_OIDC_TOKEN;
if (!API_URL || !OIDC_TOKEN) throw new Error("Missing worker URL or OIDC token");

async function api(method, body) {
  const r = await fetch(API_URL, {
    method,
    headers: {
      authorization: `Bearer ${OIDC_TOKEN}`,
      "content-type": "application/json"
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok || data?.ok === false) throw new Error(`Worker API ${r.status}: ${data?.error || "unknown"}`);
  return data;
}

async function dismissCookies(page) {
  for (const re of [/alles accepteren/i,/accepteer alle/i,/akkoord/i,/accepteren/i,/doorgaan zonder accepteren/i]) {
    const btn=page.getByRole("button",{name:re}).first();
    if(await btn.count()){
      try{if(await btn.isVisible({timeout:600})){await btn.click({timeout:2500});await page.waitForTimeout(350);return}}catch{}
    }
  }
}

function parseLimitText(text) {
  for (const re of [
    /maximaal\s+(\d{1,5})\s+(?:stuks?|artikelen?)/i,
    /maximum\s+(?:van\s+)?(\d{1,5})/i,
    /je kunt\s+(?:er\s+)?maximaal\s+(\d{1,5})/i,
    /nog\s+(\d{1,5})\s+(?:stuks?|exemplaren?)\s+(?:beschikbaar|op voorraad)/i,
    /slechts\s+(\d{1,5})\s+(?:stuks?|exemplaren?)\s+(?:beschikbaar|op voorraad)/i,
    /(\d{1,5})\s+(?:stuks?|exemplaren?)\s+op voorraad/i
  ]) {
    const m=text.match(re);
    if(m){const n=Number(m[1]);if(Number.isInteger(n)&&n>=0&&n<=10000)return n}
  }
  return null;
}

async function visibleInputCandidates(page) {
  return page.locator("input").evaluateAll((els)=>els.map((el,i)=>{
    const s=getComputedStyle(el);
    const visible=!!(el.offsetWidth||el.offsetHeight||el.getClientRects().length)&&s.visibility!=="hidden"&&s.display!=="none";
    const attrs=[el.getAttribute("name"),el.getAttribute("aria-label"),el.getAttribute("data-test"),el.getAttribute("data-testid"),el.getAttribute("id"),el.getAttribute("class"),el.getAttribute("inputmode"),el.getAttribute("type")].filter(Boolean).join(" ").toLowerCase();
    let score=0;
    if(/quantity|aantal|qty/.test(attrs))score+=8;
    if(el.getAttribute("type")==="number")score+=4;
    if(el.getAttribute("inputmode")==="numeric")score+=2;
    if(String(el.value)==="1")score+=1;
    return {i,visible,score,value:String(el.value||""),attrs:attrs.slice(0,220)};
  }).filter(x=>x.visible&&x.score>0).sort((a,b)=>b.score-a.score));
}

async function visibleSelectCandidates(page) {
  return page.locator("select").evaluateAll((els)=>els.map((el,i)=>{
    const s=getComputedStyle(el);
    const visible=!!(el.offsetWidth||el.offsetHeight||el.getClientRects().length)&&s.visibility!=="hidden"&&s.display!=="none";
    const attrs=[el.getAttribute("name"),el.getAttribute("aria-label"),el.getAttribute("data-test"),el.getAttribute("data-testid"),el.getAttribute("id"),el.getAttribute("class")].filter(Boolean).join(" ").toLowerCase();
    let score=0;
    if(/quantity|aantal|qty/.test(attrs))score+=8;
    const opts=[...el.options].map(o=>({value:o.value,text:(o.textContent||"").trim()}));
    if(opts.some(o=>/^\d+$/.test(o.value)||/^\d+$/.test(o.text)))score+=2;
    return {i,visible,score,value:String(el.value||""),attrs:attrs.slice(0,220),opts};
  }).filter(x=>x.visible&&x.score>0).sort((a,b)=>b.score-a.score));
}

async function readNetworkQuantityCandidates(responses) {
  const candidates=[];
  for(const item of responses.slice(-30)){
    if(!item||typeof item!=="object")continue;
    const stack=[item];let seen=0;
    while(stack.length&&seen<1500){
      seen++;const v=stack.pop();
      if(Array.isArray(v)){for(const x of v.slice(0,100))if(x&&typeof x==="object")stack.push(x);continue}
      if(!v||typeof v!=="object")continue;
      for(const [k,val] of Object.entries(v)){
        if(typeof val==="number"&&Number.isInteger(val)&&val>=0&&val<=10000&&/^(availableQuantity|availableStock|maxQuantity|maximumQuantity|stock|stockLevel|quantityAvailable)$/i.test(k))candidates.push({key:k,value:val});
        else if(val&&typeof val==="object")stack.push(val);
      }
    }
  }
  const exact=candidates.filter(x=>/availableQuantity|availableStock|maxQuantity|maximumQuantity|quantityAvailable/i.test(x.key));
  const values=[...new Set(exact.map(x=>x.value))];
  return values.length===1?values[0]:null;
}

async function cartHref(page) {
  const links=await page.locator("a[href]").evaluateAll(els=>els.map(el=>el.getAttribute("href")).filter(Boolean));
  const href=links.find(h=>/basket|winkelwagen|\/cart(?:\/|\?|$)/i.test(h));
  return href?new URL(href,page.url()).href:null;
}

async function clickAddToCart(page) {
  await page.waitForTimeout(1800);
  await page.waitForLoadState("networkidle",{timeout:5000}).catch(()=>{});
  const locators=[
    page.getByRole("button",{name:/in winkelwagen/i}).first(),
    page.getByRole("link",{name:/in winkelwagen/i}).first(),
    page.getByText(/^in winkelwagen$/i).first(),
    page.getByRole("button",{name:/voeg.*winkelwagen/i}).first(),
    page.locator('button:has-text("In winkelwagen"),a:has-text("In winkelwagen")').first(),
    page.locator('[aria-label*="winkelwagen" i],[data-test*="add-to-basket"],[data-testid*="add-to-basket"],[data-test*="add-to-cart"]').first(),
    page.locator('form[action*="basket" i] button,form[action*="cart" i] button').first(),
    page.locator('input[type="submit"][value*="winkelwagen" i]').first()
  ];
  for(const loc of locators){
    if(await loc.count()){
      try{
        if(await loc.isVisible({timeout:1200})){
          await loc.scrollIntoViewIfNeeded().catch(()=>{});
          await loc.click({timeout:8000});
          return true;
        }
      }catch{}
    }
  }
  return false;
}

async function forceLargeQuantity(page,networkPayloads) {
  await page.waitForTimeout(900);
  let body=await page.locator("body").innerText().catch(()=>"");
  let textLimit=parseLimitText(body);
  if(textLimit!==null)return {stock:textLimit,method:"cart_limit_text"};

  const inputs=await visibleInputCandidates(page);
  for(const c of inputs.slice(0,4)){
    const input=page.locator("input").nth(c.i);
    try{
      await input.scrollIntoViewIfNeeded();
      await input.fill("999");
      await input.press("Enter").catch(()=>{});
      await input.blur().catch(()=>{});
      await page.waitForTimeout(1800);
      body=await page.locator("body").innerText().catch(()=>"");
      textLimit=parseLimitText(body);
      if(textLimit!==null)return {stock:textLimit,method:"cart_input_limit_message"};
      const value=Number(await input.inputValue().catch(()=>NaN));
      if(Number.isInteger(value)&&value>=0&&value<999)return {stock:value,method:"cart_input_adjusted"};
    }catch{}
  }

  const selects=await visibleSelectCandidates(page);
  for(const c of selects.slice(0,4)){
    const select=page.locator("select").nth(c.i);
    try{
      const special=c.opts.find(o=>/meer|anders|10\+|20\+/i.test(o.text)||/more|other/i.test(o.value));
      if(special){
        await select.selectOption(special.value);
        await page.waitForTimeout(500);
        const after=await visibleInputCandidates(page);
        if(after.length){
          const input=page.locator("input").nth(after[0].i);
          await input.fill("999");
          await input.press("Enter").catch(()=>{});
          await input.blur().catch(()=>{});
          await page.waitForTimeout(1800);
          body=await page.locator("body").innerText().catch(()=>"");
          textLimit=parseLimitText(body);
          if(textLimit!==null)return {stock:textLimit,method:"cart_select_more_limit_message"};
          const value=Number(await input.inputValue().catch(()=>NaN));
          if(Number.isInteger(value)&&value>=0&&value<999)return {stock:value,method:"cart_select_more_adjusted"};
        }
      }
      const numeric=c.opts.map(o=>Number(/^\d+$/.test(o.value)?o.value:(/^\d+$/.test(o.text)?o.text:NaN))).filter(Number.isFinite);
      if(numeric.length){
        const max=Math.max(...numeric);
        const nonNumericChoice=c.opts.some(o=>!/^\d+$/.test(o.value)&&!/^\d+$/.test(o.text)&&o.value);
        if(!nonNumericChoice&&max<10)return {stock:max,method:"cart_select_exact_small_stock"};
      }
    }catch{}
  }

  const qtyButtons=page.locator('button[aria-label*="aantal" i],button[data-test*="quantity" i],button[data-testid*="quantity" i]');
  if(await qtyButtons.count()){
    try{
      await qtyButtons.first().click({timeout:3000});
      await page.waitForTimeout(400);
      const after=await visibleInputCandidates(page);
      if(after.length){
        const input=page.locator("input").nth(after[0].i);
        await input.fill("999");
        await input.press("Enter").catch(()=>{});
        await input.blur().catch(()=>{});
        await page.waitForTimeout(1800);
        body=await page.locator("body").innerText().catch(()=>"");
        textLimit=parseLimitText(body);
        if(textLimit!==null)return {stock:textLimit,method:"cart_quantity_button_limit_message"};
        const value=Number(await input.inputValue().catch(()=>NaN));
        if(Number.isInteger(value)&&value>=0&&value<999)return {stock:value,method:"cart_quantity_button_adjusted"};
      }
    }catch{}
  }

  const networkStock=await readNetworkQuantityCandidates(networkPayloads);
  if(networkStock!==null)return {stock:networkStock,method:"cart_network_quantity"};
  return null;
}

async function measureTarget(browser,target) {
  const started=Date.now();
  const context=await browser.newContext({
    locale:"nl-NL",
    timezoneId:"Europe/Amsterdam",
    viewport:{width:1365,height:900},
    userAgent:"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
    extraHTTPHeaders:{"Accept-Language":"nl-NL,nl;q=0.9,en;q=0.8"}
  });
  const page=await context.newPage();
  const networkPayloads=[];
  page.on("response",async response=>{
    try{
      if(!/basket|cart|quantity|order|checkout/i.test(response.url()))return;
      const type=response.headers()["content-type"]||"";
      if(!type.includes("json"))return;
      networkPayloads.push(await response.json());
    }catch{}
  });

  try{
    await page.goto(target.productUrl,{waitUntil:"domcontentloaded",timeout:35000});
    await dismissCookies(page);
    const productText=await page.locator("body").innerText().catch(()=>"");
    if(/captcha|ben je een robot|robotcontrole|ongebruikelijk verkeer/i.test(productText))throw new Error("Bol anti-bot/captcha detected");

    if(!await clickAddToCart(page)){
      const title=await page.title().catch(()=>"");
      const body=(await page.locator("body").innerText().catch(()=>"")).replace(/\s+/g," ").slice(0,700);
      const buttons=await page.locator("button,a,input[type=submit]").evaluateAll(els=>els.slice(0,80).map(el=>({
        tag:el.tagName,
        text:(el.textContent||el.getAttribute("value")||el.getAttribute("aria-label")||"").trim().replace(/\s+/g," ").slice(0,120),
        href:el.getAttribute("href")||"",
        test:el.getAttribute("data-test")||el.getAttribute("data-testid")||""
      })).filter(x=>x.text||x.test)).catch(()=>[]);
      throw new Error(`Add-to-cart button not found; title=${title}; url=${page.url()}; body=${body}; controls=${JSON.stringify(buttons).slice(0,1600)}`);
    }
    await page.waitForTimeout(1200);

    let cart=await cartHref(page);
    if(cart){
      await page.goto(cart,{waitUntil:"domcontentloaded",timeout:25000});
    }else{
      for(const candidate of ["https://www.bol.com/nl/nl/basket/","https://www.bol.com/nl/nl/winkelwagen/"]){
        try{const r=await page.goto(candidate,{waitUntil:"domcontentloaded",timeout:12000});if(r&&r.status()<400){cart=candidate;break}}catch{}
      }
    }
    await dismissCookies(page);

    const result=await forceLargeQuantity(page,networkPayloads);
    if(!result){
      const controls={inputs:await visibleInputCandidates(page).catch(()=>[]),selects:await visibleSelectCandidates(page).catch(()=>[])};
      throw new Error(`Could not infer stock; cart=${page.url()} controls=${JSON.stringify(controls).slice(0,900)}`);
    }
    return {targetId:target.id,availableStock:result.stock,method:result.method,durationMs:Date.now()-started};
  }finally{
    await context.close().catch(()=>{});
  }
}

const startedAt=new Date().toISOString();
const {targets}=await api("GET");
console.log(`Tracking ${targets.length} active competitor products`);
const browser=await chromium.launch({headless:true});
const results=[];
try{
  for(const [i,target] of targets.entries()){
    process.stdout.write(`[${i+1}/${targets.length}] ${target.name}: `);
    try{
      const r=await measureTarget(browser,target);
      results.push(r);
      console.log(`stock=${r.availableStock} (${r.method})`);
    }catch(e){
      const error=String(e?.message||e).slice(0,1000);
      results.push({targetId:target.id,error,durationMs:0});
      console.log(`FAILED - ${error}`);
    }
    await new Promise(resolve=>setTimeout(resolve,1200));
  }
}finally{
  await browser.close().catch(()=>{});
}
const finishedAt=new Date().toISOString();
const summary=await api("POST",{action:"submit_run",startedAt,finishedAt,results});
console.log("Tracking result:",JSON.stringify(summary));
if(summary.successes===0)process.exitCode=1;
