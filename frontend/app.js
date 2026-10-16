(() => {
  const cfg=window.MAT_HOME_CONFIG||{},API=cfg.dashboardApi,AGENT_API=cfg.agentApi,CHAT_API=cfg.agentChatApi;
  const $=id=>document.getElementById(id);
  const euro=new Intl.NumberFormat("nl-NL",{style:"currency",currency:"EUR"});
  const num=new Intl.NumberFormat("nl-NL"),dec=new Intl.NumberFormat("nl-NL",{minimumFractionDigits:1,maximumFractionDigits:1});
  const esc=s=>String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"}[c]));
  const shortDate=s=>s?new Intl.DateTimeFormat("nl-NL",{day:"2-digit",month:"short"}).format(new Date(s+"T12:00:00Z")):"—";
  const time=s=>s?new Intl.DateTimeFormat("nl-NL",{hour:"2-digit",minute:"2-digit",timeZone:"Europe/Amsterdam"}).format(new Date(s)):"—";
  const dateTime=s=>s?new Intl.DateTimeFormat("nl-NL",{dateStyle:"short",timeStyle:"short",timeZone:"Europe/Amsterdam"}).format(new Date(s)):"—";
  const today=()=>new Intl.DateTimeFormat("sv-SE",{timeZone:"Europe/Amsterdam",year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date());
  const shift=(iso,days)=>{const d=new Date(iso+"T12:00:00Z");d.setUTCDate(d.getUTCDate()+days);return d.toISOString().slice(0,10)};
  const code=()=>localStorage.getItem("mh_code")||"";
  const headers=()=>({"x-dashboard-code":code(),"content-type":"application/json"});
  let latestMetricDate=null,latestDashboard=null;
  let dashboardLoading=false,dashboardRevision=0,overviewSelection=null,productSelection=null;

  async function request(url,options={}){
    const r=await fetch(url,{...options,headers:{...headers(),...(options.headers||{})},cache:"no-store"});
    if(r.status===401){localStorage.removeItem("mh_code");showLogin(true);throw new Error("unauthorized")}
    const data=await r.json().catch(()=>({}));
    if(!r.ok||data?.ok===false) throw new Error(data?.error||`API ${r.status}`);
    return data;
  }
  function showLogin(bad=false){$("app").classList.add("hidden");$("login").classList.remove("hidden");$("loginError").classList.toggle("hidden",!bad)}
  function showApp(){$("login").classList.add("hidden");$("app").classList.remove("hidden")}
  function makeRange(preset,fromEl,toEl){
    const t=today();
    if(preset==="today") return {from:t,to:t};
    if(preset==="yesterday"){const y=shift(t,-1);return {from:y,to:y}}
    if(preset==="24h"){const y=shift(t,-1);return {from:y,to:t}}
    if(preset==="7d") return {from:shift(t,-6),to:t};
    if(preset==="30d") return {from:shift(t,-29),to:t};
    if(preset==="month") return {from:t.slice(0,8)+"01",to:t};
    if(preset==="latest"&&latestMetricDate) return {from:latestMetricDate,to:latestMetricDate};
    const from=$(fromEl)?.value,to=$(toEl)?.value;
    return from&&to?{from,to}:null;
  }
  function withRange(url,range,refresh=false){
    const u=new URL(url);
    if(range){u.searchParams.set("from",range.from);u.searchParams.set("to",range.to)}
    if(refresh)u.searchParams.set("refresh","1");
    return u.toString();
  }
  function periodLabel(from,to){return from===to?shortDate(from):`${shortDate(from)} t/m ${shortDate(to)}`}

  function selectionRange(selection){
    if(!selection)return null;
    if(selection.preset==="custom")return {from:selection.from,to:selection.to};
    return makeRange(selection.preset,selection.fromId,selection.toId);
  }
  function chosenSelection(prefix){
    return {preset:$(prefix+"Preset").value,from:$(prefix+"From").value,to:$(prefix+"To").value,fromId:prefix+"From",toId:prefix+"To"};
  }
  async function loadInitial(refresh=false){
    if(!code())return showLogin();
    if(dashboardLoading)return;
    dashboardLoading=true;
    const revision=dashboardRevision,session=code(),banner=$("statusBanner");
    if(refresh){banner.classList.remove("hidden");banner.textContent="Bol-data wordt ververst…";$("refresh").disabled=true}
    try{
      const d=await request(withRange(API,null,refresh));
      if(code()!==session)return;
      latestMetricDate=d.kpis?.latestMetricDate||null;
      const overviewRange=selectionRange(overviewSelection),productRange=selectionRange(productSelection);
      const [overview,products]=await Promise.all([
        overviewRange?request(withRange(API,overviewRange)):Promise.resolve(d),
        productRange?request(withRange(API,productRange)):Promise.resolve(d)
      ]);
      if(code()!==session||revision!==dashboardRevision)return;
      latestDashboard=d;
      renderOverview(overview,!!overviewRange);renderProducts(products);renderBusinessInsights(d);showApp();
      if(refresh){banner.textContent=d.refreshed?"Bol-data is opnieuw gesynchroniseerd.":"Synchronisatie loopt al of kon niet worden afgerond; de laatste gegevens worden getoond.";setTimeout(()=>banner.classList.add("hidden"),4000)}
      else if(banner.textContent.startsWith("Automatisch bijwerken"))banner.classList.add("hidden");
    }catch(e){if(e.message!=="unauthorized"&&code()===session){banner.classList.remove("hidden");banner.textContent="Automatisch bijwerken is tijdelijk niet gelukt. Je gegevens blijven staan; we proberen het opnieuw."}}
    finally{dashboardLoading=false;$("refresh").disabled=false}
  }
  function refreshVisibleData(){
    if(document.hidden||!code())return;
    loadInitial();
  }

  function renderOverview(d,filtered=true){
    const r=d.selectedRange||{from:d.today,to:d.today};
    const label=periodLabel(r.from,r.to);
    document.querySelector(".kpis .card:nth-child(1) .label").textContent=`Omzet · ${label}`;
    document.querySelector(".kpis .card:nth-child(2) .label").textContent=`Orders · ${label}`;
    $("revenue").textContent=euro.format(d.kpis?.revenueToday||0);
    $("revenueSub").textContent=`${num.format(d.kpis?.ordersToday||0)} bestelling${d.kpis?.ordersToday===1?"":"en"}`;
    $("orders").textContent=num.format(d.kpis?.ordersToday||0);
    renderReturns(d.returns,label);
    // Bezoeken en conversie staan nu in MAT HOME UPDATE en de MAT Agent.
    const series=d.ordersSeries||[],max=Math.max(1,...series.map(x=>x.orders||0));
    const chartRange=d.ordersSeriesRange;
    $("ordersChartTitle").textContent=`Bestellingen per dag · ${chartRange?periodLabel(chartRange.from,chartRange.to):label}`;
    $("chart").innerHTML=series.length?series.map(x=>`<div class="bar-col" tabindex="0" aria-label="${esc(shortDate(x.date))}: ${num.format(x.orders||0)} bestellingen, ${esc(euro.format(Number(x.revenue||0)))} omzet"><div class="chart-tip"><b>${esc(shortDate(x.date))}</b><span>${num.format(x.orders||0)} ${x.orders===1?"bestelling":"bestellingen"}</span><span>${esc(euro.format(Number(x.revenue||0)))} omzet</span></div><div class="bar" style="min-height:0;height:${Math.round((x.orders||0)/max*165)}px"></div><div class="x">${esc(shortDate(x.date))}</div></div>`).join(""):'<div class="empty">Geen besteldata voor deze periode.</div>';
    $("recentOrders").innerHTML=(d.recentOrders||[]).length?(d.recentOrders||[]).map(o=>`<div class="row"><div class="dot"></div><div><b>Order ${esc(String(o.bol_order_id||o.orderId||"").slice(-6))} · ${euro.format(Number(o.total_amount||o.amount||0))}</b><p>${esc(shortDate(String(o.ordered_at||"").slice(0,10)))} · ${esc(time(o.ordered_at||o.time))}</p></div></div>`).join(""):'<div class="empty">Geen orders in deze periode.</div>';
    const lastGood=d.lastSuccessfulSync||((d.lastSync?.status==="success")?d.lastSync:null);
    const ls=lastGood?.finished_at?dateTime(lastGood.finished_at):"onbekend";
    const syncStale=!lastGood?.finished_at||Date.now()-Date.parse(lastGood.finished_at)>15*60000;
    const syncLabel=d.lastSync?.status==="error"?"Synchronisatie mislukt; nieuwe poging volgt":syncStale?"Gegevens wachten op synchronisatie":"Automatisch bijgewerkt";
    $("systemStatus").innerHTML=`<div class="row"><div class="dot"></div><div><b>${num.format(d.kpis?.activeProducts||0)} actieve producten</b><p>${num.format(d.kpis?.totalProducts||0)} producten bekend</p></div></div><div class="row"><div class="dot"></div><div><b>${esc(syncLabel)}</b><p>Laatste geslaagde sync: ${esc(ls)} · elke 5 minuten</p></div></div><div class="row"><div class="dot"></div><div><b>Code onder eigen beheer</b><p>Frontend via GitHub Pages</p></div></div>`;
  }

  function renderReturns(returns,label){
    $("returnsPeriodLabel").textContent=`Totale retouren · ${label}`;
    const available=returns?.available===true&&Number.isFinite(returns.open)&&Number.isFinite(returns.total);
    $("returnsOpen").textContent=available?num.format(returns.open):"—";
    $("returnsTotal").textContent=available?num.format(returns.total):"—";
    const status=$("returnsSyncStatus");
    status.classList.toggle("returns-warning",!available||returns?.stale===true);
    if(!available)status.textContent="Retourgegevens tijdelijk niet beschikbaar.";
    else if(returns.stale)status.textContent=`Verversen niet gelukt · laatste gegevens: ${returns.lastSyncedAt?dateTime(returns.lastSyncedAt):"onbekend"}.`;
    else status.textContent=`Bijgewerkt ${dateTime(returns.lastSyncedAt)}`;
  }

  function trendText(value,suffix="%"){
    const n=Number(value||0),sign=n>0?"+":"";
    return `${sign}${dec.format(n)}${suffix}`;
  }

  function renderBusinessInsights(d){
    const i=d.businessInsights;
    if(!i)return;
    $("insightPeriod").textContent=`Laatste 7 complete meetdagen · ${periodLabel(i.period.from,i.period.to)}`;
    $("insightGenerated").textContent=`Bijgewerkt ${dateTime(i.generatedAt)}`;

    const weekSales=Number(i.salesThisWeek??i.sales7d??0);
    const gap=Math.max(0,Number(i.weeklyTarget||14)-weekSales);
    const paceDelta=Number(i.paceDelta||0);
    const weekLabel=i.week?`${shortDate(i.week.from)} t/m ${shortDate(i.week.to)}`:"ma t/m zo";
    $("insightPeriod").textContent=`Weekdoel: 2 sales per dag · ${weekLabel} · overige analyse laatste 7 meetdagen`;
    if(gap===0){
      $("insightHero").innerHTML=`<div><span class="status-dot good"></span><b>Weekdoel van 14 sales is gehaald.</b></div><strong>${num.format(weekSales)} / ${num.format(i.weeklyTarget||14)}</strong>`;
    }else if(paceDelta>=0){
      $("insightHero").innerHTML=`<div><span class="status-dot good"></span><b>Deze week lig je op of boven het tempo van 2 sales per dag. Nog ${num.format(gap)} voor het weekdoel.</b></div><strong>${num.format(weekSales)} / ${num.format(i.weeklyTarget||14)}</strong>`;
    }else{
      $("insightHero").innerHTML=`<div><span class="status-dot watch"></span><b>Deze week ${num.format(Math.abs(paceDelta))} sale${Math.abs(paceDelta)===1?"":"s"} achter op tempo. Nog ${num.format(gap)} voor het weekdoel.</b></div><strong>${num.format(weekSales)} / ${num.format(i.weeklyTarget||14)}</strong>`;
    }

    $("insightSales").textContent=`${num.format(weekSales)} / ${num.format(i.weeklyTarget||14)}`;
    $("insightSalesSub").textContent=`${trendText(i.salesWeekTrendPct)} vs zelfde dagen vorige week`;
    $("insightRevenue").textContent=euro.format(Number(i.revenue7d||0));
    $("insightRevenueSub").textContent=`${trendText(i.revenueTrendPct)} vs vorige 7d`;
    $("insightVisits").textContent=num.format(i.visits7d||0);
    $("insightVisitsSub").textContent=`${trendText(i.visitsTrendPct)} vs vorige 7d`;
    $("insightConversion").textContent=dec.format(i.conversion7d||0)+"%";
    $("insightConversionSub").textContent=`${trendText(i.conversionTrendPp," pp")} vs vorige 7d`;

    const actions=[];
    if(i.topProduct) actions.push({kind:"good",title:"Sterkste product",text:`${i.topProduct.name}: ${num.format(i.topProduct.sales||0)} sales uit ${num.format(i.topProduct.visits||0)} bezoeken (${dec.format(i.topProduct.conversion||0)}%).`});
    if(i.opportunity){
      const noSales=Number(i.opportunity.sales||0)===0;
      actions.push({kind:"watch",title:"Grootste conversiekans",text:noSales
        ? `${i.opportunity.name} kreeg ${num.format(i.opportunity.visits||0)} bezoeken maar nog geen sale. Eerste kandidaat voor hoofdafbeelding, prijs/USP of contenttest.`
        : `${i.opportunity.name} converteert ${dec.format(i.opportunity.conversion||0)}% op ${num.format(i.opportunity.visits||0)} bezoeken. Hier valt relatief veel winst te boeken.`});
    }
    if(Number(i.visitsTrendPct||0)<-10) actions.push({kind:"watch",title:"Verkeer daalt",text:`Bezoeken liggen ${Math.abs(Number(i.visitsTrendPct||0)).toFixed(1).replace(".",",")}% onder de vorige 7 dagen. Focus op vindbaarheid en relevante zoektermen voordat je prijs verlaagt.`});
    else if(Number(i.visitsTrendPct||0)>10) actions.push({kind:"good",title:"Meer bereik",text:`Bezoeken zijn ${dec.format(i.visitsTrendPct||0)}% gestegen. Controleer vooral of de conversie meegroeit; anders zit de winst in de listing zelf.`});
    $("insightActions").innerHTML=actions.slice(0,4).map(a=>`<div class="insight-action ${a.kind}"><div class="insight-icon"></div><div><b>${esc(a.title)}</b><p>${esc(a.text)}</p></div></div>`).join("");

    const s=i.searchVolume||{},terms=s.topTerms||[];
    if(!s.latestDate||!terms.length) $("searchVolumeBox").innerHTML='<div class="empty">Nog geen zoekvolume. Klik op “Ververs Bol-data” om de nieuwste zoektermen op te halen.</div>';
    else{
      const trend=s.trackedVolumeTrendPct==null?"":` · ${trendText(s.trackedVolumeTrendPct)} vs dag ervoor`;
      $("searchVolumeBox").innerHTML=`<div class="search-head"><div><strong>${num.format(s.trackedVolume||0)}</strong><span>zoekopdrachten in gevolgde termen${trend}</span></div><small>Meetdag ${esc(shortDate(s.latestDate))}</small></div><div class="search-terms">${terms.map(t=>`<div class="search-term"><span>${esc(t.term)}</span><strong>${num.format(t.volume||0)}</strong><small>${t.changePct==null?"":trendText(t.changePct)}</small></div>`).join("")}</div><div class="search-note">${esc(s.note||"")}</div>`;
    }

    const opportunities=i.conversionOpportunities||[];
    const oppVisits=opportunities.reduce((sum,p)=>sum+Number(p.visits||0),0);
    const oppGap=opportunities.reduce((sum,p)=>sum+Number(p.salesGap||0),0);
    $("oppCount").textContent=num.format(opportunities.length);
    $("oppVisits").textContent=num.format(oppVisits);
    $("oppSalesGap").textContent=num.format(oppGap);
    $("conversionOpportunities").innerHTML=opportunities.length?opportunities.map(p=>{
      const conv=Number(p.conversion||0).toLocaleString("nl-NL",{minimumFractionDigits:2,maximumFractionDigits:2});
      return `<tr><td><b>${esc(p.name||"Onbekend product")}</b></td><td>${num.format(p.visits||0)}</td><td>${num.format(p.sales||0)}</td><td>${conv}%</td><td><b>+${num.format(p.salesGap||0)}</b></td></tr>`;
    }).join(""):'<tr><td colspan="5" class="empty">Geen listing met minimaal 10 bezoeken zit onder 2,5% conversie.</td></tr>';
  }

  function renderProducts(d){
    const pr=d.productPerformanceRange||{from:d.productPerformanceDate,to:d.productPerformanceDate};
    const label=periodLabel(pr.from,pr.to);
    $("productPerformanceTitle").textContent=`Productprestaties · ${label}`;
    $("productOrdersHeader").textContent=`Orders · ${label}`;
    $("products").innerHTML=(d.products||[]).length?(d.products||[]).slice(0,50).map(p=>`<tr><td><b>${esc(p.variant||p.title||p.name)}</b><div class="hint">${esc(p.ean||"")}</div></td><td>${euro.format(Number(p.price||0))}</td><td>${num.format(p.stock||0)}</td><td>${num.format(p.visits||0)}</td><td>${num.format(p.ordersPerformance||0)}</td></tr>`).join(""):'<tr><td colspan="5" class="empty">Geen productdata voor deze periode.</td></tr>';
  }

  async function applyOverview(){
    const preset=$("overviewPreset").value,range=makeRange(preset,"overviewFrom","overviewTo");
    if(!range)return alert("Kies een begin- en einddatum.");
    overviewSelection=chosenSelection("overview");
    const revision=++dashboardRevision;
    $("applyOverviewPeriod").disabled=true;
    try{const d=await request(withRange(API,range));if(revision===dashboardRevision)renderOverview(d,true)}catch(e){if(e.message!=="unauthorized")alert("Periode laden is niet gelukt.")}
    finally{$("applyOverviewPeriod").disabled=false}
  }
  async function applyProducts(){
    const preset=$("productPreset").value,range=makeRange(preset,"productFrom","productTo");
    if(!range)return alert("Kies een begin- en einddatum.");
    productSelection=chosenSelection("product");
    const revision=++dashboardRevision;
    $("applyProductPeriod").disabled=true;
    try{const d=await request(withRange(API,range));if(revision===dashboardRevision)renderProducts(d)}catch(e){if(e.message!=="unauthorized")alert("Productperiode laden is niet gelukt.")}
    finally{$("applyProductPeriod").disabled=false}
  }

  const AGENT_CHAT_KEY="mh_agent_chat_v1";
  const AGENT_CHAT_DAY_KEY="mh_agent_chat_day_v1";

  function amsterdamMidnightUtcMs(dateIso){
    const guess=Date.parse(dateIso+"T00:00:00Z");
    const parts=new Intl.DateTimeFormat("en-CA",{
      timeZone:"Europe/Amsterdam",year:"numeric",month:"2-digit",day:"2-digit",
      hour:"2-digit",minute:"2-digit",second:"2-digit",hour12:false
    }).formatToParts(new Date(guess)).reduce((a,p)=>(a[p.type]=p.value,a),{});
    const localAsUtc=Date.UTC(Number(parts.year),Number(parts.month)-1,Number(parts.day),Number(parts.hour)%24,Number(parts.minute),Number(parts.second));
    const offset=localAsUtc-guess;
    return Date.parse(dateIso+"T00:00:00Z")-offset;
  }

  function renderAgentHistory(messages){
    const box=$("agentMessages");
    if(!box)return;
    if(!Array.isArray(messages)||!messages.length){
      box.innerHTML='<div class="agent-message agent">Vraag bijvoorbeeld: “sales deze week?”, “beste product?” of “waar valt winst?”</div>';
      return;
    }
    box.innerHTML="";
    messages.forEach(m=>{
      const div=document.createElement("div");
      const who=(m.who||m.role)==="user"?"user":"agent";
      div.className="agent-message "+who;
      div.textContent=String(m.text||m.content||"");
      box.appendChild(div);
    });
    box.scrollTop=box.scrollHeight;
  }

  function localAgentHistory(){
    try{
      const messages=JSON.parse(localStorage.getItem(AGENT_CHAT_KEY)||"[]");
      return Array.isArray(messages)?messages:[];
    }catch(_){return []}
  }

  async function clearAgentChat(syncServer=true){
    localStorage.removeItem(AGENT_CHAT_KEY);
    localStorage.setItem(AGENT_CHAT_DAY_KEY,today());
    renderAgentHistory([]);
    if(syncServer&&CHAT_API&&code()){
      try{await request(CHAT_API,{method:"POST",body:JSON.stringify({action:"clear"})})}catch(_){}
    }
  }

  async function loadAgentChat(){
    const currentDay=today();
    if(localStorage.getItem(AGENT_CHAT_DAY_KEY)!==currentDay){
      localStorage.removeItem(AGENT_CHAT_KEY);
      localStorage.setItem(AGENT_CHAT_DAY_KEY,currentDay);
    }
    if(!CHAT_API||!code()){
      renderAgentHistory(localAgentHistory());
      return;
    }
    try{
      const data=await request(CHAT_API);
      const messages=(data.messages||[]).map(m=>({who:m.role,text:m.content,ts:m.created_at}));
      localStorage.setItem(AGENT_CHAT_KEY,JSON.stringify(messages.slice(-200)));
      localStorage.setItem(AGENT_CHAT_DAY_KEY,data.day||currentDay);
      renderAgentHistory(messages);
    }catch(_){
      renderAgentHistory(localAgentHistory());
    }
  }

  function saveAgentMessage(text,who){
    let messages=localAgentHistory();
    const msg={text:String(text),who:who==="user"?"user":"agent",ts:Date.now()};
    messages.push(msg);
    if(messages.length>200)messages=messages.slice(-200);
    localStorage.setItem(AGENT_CHAT_KEY,JSON.stringify(messages));
    localStorage.setItem(AGENT_CHAT_DAY_KEY,today());
    if(CHAT_API&&code()){
      request(CHAT_API,{
        method:"POST",
        body:JSON.stringify({action:"save",role:msg.who,content:msg.text})
      }).catch(()=>{});
    }
  }

  function scheduleAgentMidnightReset(){
    const nextDay=shift(today(),1);
    const delay=Math.max(1000,amsterdamMidnightUtcMs(nextDay)-Date.now());
    setTimeout(async()=>{
      await clearAgentChat(true);
      scheduleAgentMidnightReset();
    },delay);
  }

  function agentAdd(text,who="agent",persist=true){
    const box=$("agentMessages");
    if(!box)return;
    const div=document.createElement("div");
    div.className="agent-message "+who;
    div.textContent=text;
    box.appendChild(div);
    if(persist)saveAgentMessage(text,who);
    box.scrollTop=box.scrollHeight;
  }

  function norm(s){return String(s||"").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g,"").trim()}

  function productMatch(q){
    const d=latestDashboard;
    if(!d?.products?.length)return null;
    const nq=norm(q);
    const stop=["hoeveel","heeft","sales","orders","bezoeken","omzet","product","deze","week","vandaag"];
    const words=nq.split(/\s+/).filter(function(w){return w.length>2&&!stop.includes(w)});
    return d.products.map(function(p){
      const hay=norm((p.variant||"")+" "+(p.title||""));
      const score=words.reduce(function(s,w){return s+(hay.includes(w)?1:0)},0);
      return {p:p,score:score};
    }).filter(function(x){return x.score>0}).sort(function(a,b){return b.score-a.score})[0]?.p||null;
  }

  function agentAnswer(question){
    const d=latestDashboard;
    if(!d)return "De dashboarddata is nog niet geladen.";
    const q=norm(question),i=d.businessInsights||{},k=d.kpis||{};
    const weekSales=Number(i.salesThisWeek??0),weekTarget=Number(i.weeklyTarget||14);
    const gap=Math.max(0,weekTarget-weekSales);

    if(/(sales|orders|bestellingen).*(deze week|week)|deze week.*(sales|orders|bestellingen)/.test(q))
      return "Deze week sta je op "+num.format(weekSales)+" van "+num.format(weekTarget)+" sales. Nog "+num.format(gap)+" nodig voor je weekdoel.";

    if(/(sales|orders|bestellingen).*(vandaag)|vandaag.*(sales|orders|bestellingen)/.test(q))
      return "Vandaag: "+num.format(k.ordersToday||0)+" bestelling"+(Number(k.ordersToday||0)===1?"":"en")+".";

    if(/omzet.*vandaag|vandaag.*omzet/.test(q))
      return "Omzet vandaag: "+euro.format(Number(k.revenueToday||0))+".";

    if(/omzet.*(week|7|zeven)|(week|7|zeven).*omzet/.test(q))
      return "Omzet over de laatste 7 meetdagen: "+euro.format(Number(i.revenue7d||0))+" ("+trendText(i.revenueTrendPct)+" versus de 7 dagen ervoor).";

    if(/bezoek|traffic|verkeer/.test(q))
      return "Laatste 7 meetdagen: "+num.format(i.visits7d||0)+" bezoeken ("+trendText(i.visitsTrendPct)+" versus de 7 dagen ervoor).";

    if(/convers/.test(q))
      return "Conversie over de laatste 7 meetdagen: "+dec.format(i.conversion7d||0)+"%. Verandering: "+trendText(i.conversionTrendPp," pp")+".";

    if(/doel|target|tempo/.test(q))
      return "Je doel is 2 sales per dag = 14 per maandag-zondagweek. Nu: "+num.format(weekSales)+"/"+num.format(weekTarget)+"; "+(gap?("nog "+num.format(gap)+" nodig"):"doel gehaald")+".";

    if(/beste product|sterkste product|top product|hardloper/.test(q)){
      const p=i.topProduct;
      return p?(p.name+" is nu het sterkste product: "+num.format(p.sales||0)+" sales uit "+num.format(p.visits||0)+" bezoeken ("+dec.format(p.conversion||0)+"% conversie)."):"Nog geen productanalyse beschikbaar.";
    }

    if(/waar.*winst|kans|verbeter|optimal/.test(q)){
      const p=i.opportunity;
      if(!p)return "Ik zie nog geen duidelijke productkans in de huidige meetdata.";
      return Number(p.sales||0)===0
        ? "Grootste kans: "+p.name+". "+num.format(p.visits||0)+" bezoeken en nog 0 sales. Eerst hoofdafbeelding, USP/tekst en prijspositionering testen."
        : "Grootste kans: "+p.name+". "+num.format(p.visits||0)+" bezoeken met "+dec.format(p.conversion||0)+"% conversie. Hier zou ik de listing als eerste optimaliseren.";
    }

    if(/zoekvolume|zoekwoord|search/.test(q)){
      const s=i.searchVolume||{},terms=s.topTerms||[];
      if(!terms.length)return "Nog geen zoekvolume geladen. Gebruik eerst ‘Ververs Bol-data’.";
      return "Hoogste gevolgde zoekterm: “"+terms[0].term+"” met "+num.format(terms[0].volume||0)+" zoekopdrachten op de laatste meetdag. Ik volg "+num.format(s.trackedTerms||terms.length)+" termen.";
    }

    const p=productMatch(q);
    if(p)return (p.variant||p.title)+": "+num.format(p.visits||0)+" bezoeken en "+num.format(p.ordersPerformance||0)+" orders in de momenteel gekozen productperiode.";

    return "Ik kan nu korte vragen beantwoorden over sales, omzet, weekdoel, bezoeken, conversie, producten en zoekvolume.";
  }

  async function askAgent(q){
    agentAdd(q,"user");
    const input=$("agentInput");
    if(input)input.value="";
    const box=$("agentMessages");
    const thinking=document.createElement("div");
    thinking.className="agent-message agent thinking";
    thinking.textContent="Ik analyseer sales, verkeer, conversie en producten…";
    box.appendChild(thinking);
    box.scrollTop=box.scrollHeight;
    try{
      if(!AGENT_API)throw new Error("agent api ontbreekt");
      const data=await request(AGENT_API,{method:"POST",body:JSON.stringify({question:q})});
      thinking.remove();
      agentAdd(data.answer||agentAnswer(q),"agent");
    }catch(e){
      thinking.remove();
      agentAdd(agentAnswer(q),"agent");
    }
  }

  $("agentForm")?.addEventListener("submit",function(e){
    e.preventDefault();
    const input=$("agentInput"),q=input.value.trim();
    if(!q)return;
    askAgent(q);
  });
  document.querySelectorAll("[data-agent-q]").forEach(function(btn){
    btn.addEventListener("click",function(){askAgent(btn.dataset.agentQ)});
  });
  function bindCustom(selectId,boxId){$(selectId).addEventListener("change",()=>$(boxId).classList.toggle("hidden",$(selectId).value!=="custom"))}
  bindCustom("overviewPreset","overviewCustom");bindCustom("productPreset","productCustom");
  $("applyOverviewPeriod").addEventListener("click",applyOverview);
  $("applyProductPeriod").addEventListener("click",applyProducts);
  setInterval(refreshVisibleData,60000);

  $("loginForm").addEventListener("submit",e=>{e.preventDefault();localStorage.setItem("mh_code",$("code").value.trim());Promise.all([loadInitial(),loadAgentChat()])});
  $("logout").addEventListener("click",()=>{dashboardRevision++;overviewSelection=null;productSelection=null;localStorage.removeItem("mh_code");$("code").value="";showLogin()});
  $("refresh").addEventListener("click",async()=>{await loadInitial(true)});

  scheduleAgentMidnightReset();
  document.addEventListener("visibilitychange",()=>{if(!document.hidden){loadAgentChat();refreshVisibleData()}});

  const t=today();$("overviewFrom").value=t;$("overviewTo").value=t;
  $("productFrom").value=shift(t,-1);$("productTo").value=shift(t,-1);
  if(code()){Promise.all([loadInitial(),loadAgentChat()])}else showLogin();
})();

