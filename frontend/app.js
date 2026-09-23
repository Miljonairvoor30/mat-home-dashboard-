(() => {
  const cfg=window.MAT_HOME_CONFIG||{},API=cfg.dashboardApi,COMP_API=cfg.competitorSalesApi;
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
  let latestMetricDate=null;

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

  async function loadInitial(refresh=false){
    if(!code())return showLogin();
    const banner=$("statusBanner");
    if(refresh){banner.classList.remove("hidden");banner.textContent="Bol-data wordt ververst…";$("refresh").disabled=true}
    try{
      const d=await request(withRange(API,null,refresh));
      latestMetricDate=d.kpis?.latestMetricDate||null;
      renderOverview(d,false);renderProducts(d);showApp();
      if(refresh){banner.textContent=d.refreshed?"Bol-data is opnieuw gesynchroniseerd.":"Dashboard geladen; sync gaf geen bevestiging.";setTimeout(()=>banner.classList.add("hidden"),2800)}
    }catch(e){if(e.message!=="unauthorized"){banner.classList.remove("hidden");banner.textContent="Kon dashboarddata niet laden."}}
    finally{$("refresh").disabled=false}
  }

  function renderOverview(d,filtered=true){
    const r=d.selectedRange||{from:d.today,to:d.today};
    const label=periodLabel(r.from,r.to);
    document.querySelector(".kpis .card:nth-child(1) .label").textContent=`Omzet · ${label}`;
    document.querySelector(".kpis .card:nth-child(2) .label").textContent=`Orders · ${label}`;
    $("revenue").textContent=euro.format(d.kpis?.revenueToday||0);
    $("revenueSub").textContent=`${num.format(d.kpis?.ordersToday||0)} bestelling${d.kpis?.ordersToday===1?"":"en"}`;
    $("orders").textContent=num.format(d.kpis?.ordersToday||0);
    $("visits").textContent=num.format(d.kpis?.visitsLatest||0);
    $("visitsSub").textContent=filtered?`Periode: ${label}`:(d.kpis?.latestMetricDate?`Laatste meetdag: ${shortDate(d.kpis.latestMetricDate)}`:"Nog geen bezoekdata");
    $("conversion").textContent=dec.format(d.kpis?.conversionLatest||0)+"%";
    const series=d.ordersSeries||[],max=Math.max(1,...series.map(x=>x.orders||0));
    const chartRange=d.ordersSeriesRange;
    $("ordersChartTitle").textContent=`Bestellingen per dag · ${chartRange?periodLabel(chartRange.from,chartRange.to):label}`;
    $("chart").innerHTML=series.length?series.map(x=>`<div class="bar-col"><div class="bar" style="min-height:0;height:${Math.round((x.orders||0)/max*165)}px" title="${esc(shortDate(x.date))}: ${num.format(x.orders||0)} ${x.orders===1?"bestelling":"bestellingen"}"></div><div class="x">${esc(shortDate(x.date))}</div></div>`).join(""):'<div class="empty">Geen besteldata voor deze periode.</div>';
    $("recentOrders").innerHTML=(d.recentOrders||[]).length?(d.recentOrders||[]).map(o=>`<div class="row"><div class="dot"></div><div><b>Order ${esc(String(o.bol_order_id||o.orderId||"").slice(-6))} · ${euro.format(Number(o.total_amount||o.amount||0))}</b><p>${esc(shortDate(String(o.ordered_at||"").slice(0,10)))} · ${esc(time(o.ordered_at||o.time))}</p></div></div>`).join(""):'<div class="empty">Geen orders in deze periode.</div>';
    const ls=d.lastSync?.finished_at?dateTime(d.lastSync.finished_at):"onbekend";
    $("competitors").innerHTML=(d.competitors||[]).length?(d.competitors||[]).map(x=>`<div class="row"><div class="dot warn"></div><div><b>${esc(x.competitor?.seller_name||x.competitor?.seller_id||"Concurrent")} · ${euro.format(Number(x.snapshot?.price||0))}</b><p>EAN ${esc(x.competitor?.ean||"")}${x.snapshot?.is_best_offer?" · beste aanbod":" · concurrent"}</p></div></div>`).join(""):'<div class="empty">Nog geen directe concurrent op dezelfde EAN gevonden.</div>';
    $("systemStatus").innerHTML=`<div class="row"><div class="dot"></div><div><b>${num.format(d.kpis?.activeProducts||0)} actieve producten</b><p>${num.format(d.kpis?.totalProducts||0)} producten bekend</p></div></div><div class="row"><div class="dot"></div><div><b>Bol API verbonden</b><p>Laatste sync: ${esc(ls)}</p></div></div><div class="row"><div class="dot"></div><div><b>Code onder eigen beheer</b><p>Frontend via GitHub Pages</p></div></div>`;
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
    $("applyOverviewPeriod").disabled=true;
    try{const d=await request(withRange(API,range));renderOverview(d,true)}catch(e){if(e.message!=="unauthorized")alert("Periode laden is niet gelukt.")}
    finally{$("applyOverviewPeriod").disabled=false}
  }
  async function applyProducts(){
    const preset=$("productPreset").value,range=makeRange(preset,"productFrom","productTo");
    if(!range)return alert("Kies een begin- en einddatum.");
    $("applyProductPeriod").disabled=true;
    try{const d=await request(withRange(API,range));renderProducts(d)}catch(e){if(e.message!=="unauthorized")alert("Productperiode laden is niet gelukt.")}
    finally{$("applyProductPeriod").disabled=false}
  }

  async function loadCompetitorSales(){
    if(!code()||!COMP_API)return;
    const preset=$("competitorPreset")?.value||"7d",range=makeRange(preset,"competitorFrom","competitorTo");
    if(!range)return;
    try{
      const d=await request(withRange(COMP_API,range)),targets=d.targets||[];
      const est=targets.reduce((a,t)=>a+Number(t.estimatedSalesRange||0),0);
      const avg=targets.reduce((a,t)=>a+Number(t.avgSalesPerDayRange||0),0);
      $("compRangeLabel").textContent=`Geschat · ${periodLabel(range.from,range.to)}`;
      $("comp24").textContent=num.format(est);$("comp7").textContent=dec.format(avg);$("compCount").textContent=num.format(targets.length);
      const ts=d.trackingStatus;
      $("compTrackingStatus").textContent=ts
        ? `Automatische meting: ${num.format(ts.successes||0)}/${num.format(ts.targets_total||0)} gelukt · ${dateTime(ts.finished_at)}`
        : "Automatische metingen worden ingericht.";
      $("competitorSales").innerHTML=targets.length?targets.map(t=>{
        const enough=Number(t.rangeSnapshotsCount||0)>=2;
        return `<article class="comp-card"><div class="comp-head"><div><b>${esc(t.name)}</b><div class="hint">${esc(t.sellerName||"Verkoper onbekend")}${t.ean?` · ${esc(t.ean)}`:""}</div></div><a href="${esc(t.productUrl||"#")}" target="_blank" rel="noopener">Open ↗</a></div>${t.restockDetectedRange?'<div class="badge">Aanvulling/voorraadcorrectie in geselecteerde periode</div>':""}${!enough?'<div class="hint" style="margin-top:12px">Nog onvoldoende metingen voor deze periode.</div>':`<div class="metrics"><div class="metric"><span>Voorraad nu</span><strong>${t.latestStock??"—"}</strong></div><div class="metric"><span>Geschat periode</span><strong>${num.format(t.estimatedSalesRange||0)}</strong></div><div class="metric"><span>Geschat / dag</span><strong>${dec.format(t.avgSalesPerDayRange||0)}</strong></div><div class="metric"><span>Metingen periode</span><strong>${num.format(t.rangeSnapshotsCount||0)}</strong></div></div>`}<div class="hint">Laatste meting: ${esc(dateTime(t.latestCapturedAt))}</div><form class="snapshot" data-target="${esc(t.id)}"><input type="number" min="0" step="1" inputmode="numeric" placeholder="Gemeten voorraad" required><button class="btn primary" type="submit">Opslaan</button></form></article>`;
      }).join(""):'<div class="empty">Nog geen concurrenten gevolgd.</div>';
      document.querySelectorAll(".snapshot").forEach(form=>form.addEventListener("submit",async e=>{e.preventDefault();const input=form.querySelector("input"),value=Number(input.value);if(!Number.isInteger(value)||value<0)return;const btn=form.querySelector("button");btn.disabled=true;try{await request(COMP_API,{method:"POST",body:JSON.stringify({action:"record_snapshot",targetId:form.dataset.target,availableStock:value})});input.value="";await loadCompetitorSales()}catch(e){alert("Voorraadmeting opslaan is niet gelukt.")}finally{btn.disabled=false}}));
    }catch(e){if(e.message!=="unauthorized")$("competitorSales").innerHTML='<div class="empty">Concurrent-schattingen konden niet geladen worden.</div>'}
  }

  function bindCustom(selectId,boxId){$(selectId).addEventListener("change",()=>$(boxId).classList.toggle("hidden",$(selectId).value!=="custom"))}
  bindCustom("overviewPreset","overviewCustom");bindCustom("productPreset","productCustom");bindCustom("competitorPreset","competitorCustom");
  $("applyOverviewPeriod").addEventListener("click",applyOverview);
  $("applyProductPeriod").addEventListener("click",applyProducts);
  $("applyCompetitorPeriod").addEventListener("click",loadCompetitorSales);

  $("loginForm").addEventListener("submit",e=>{e.preventDefault();localStorage.setItem("mh_code",$("code").value.trim());Promise.all([loadInitial(),loadCompetitorSales()])});
  $("logout").addEventListener("click",()=>{localStorage.removeItem("mh_code");$("code").value="";showLogin()});
  $("refresh").addEventListener("click",async()=>{await loadInitial(true);await loadCompetitorSales()});
  $("toggleAddCompetitor").addEventListener("click",()=>$("addCompetitorForm").classList.toggle("hidden"));
  $("saveCompetitor").addEventListener("click",async()=>{const name=$("compName").value.trim(),productUrl=$("compUrl").value.trim();if(!name||!productUrl){$("compFormMsg").textContent="Naam en product-URL zijn verplicht.";return}$("saveCompetitor").disabled=true;try{await request(COMP_API,{method:"POST",body:JSON.stringify({action:"add_target",name,productUrl,sellerName:$("compSeller").value.trim()||undefined,ean:$("compEan").value.trim()||undefined})});["compName","compUrl","compSeller","compEan"].forEach(id=>$(id).value="");$("compFormMsg").textContent="Concurrent toegevoegd.";await loadCompetitorSales()}catch(e){$("compFormMsg").textContent="Toevoegen is niet gelukt."}finally{$("saveCompetitor").disabled=false}});

  const t=today();$("overviewFrom").value=t;$("overviewTo").value=t;
  $("productFrom").value=shift(t,-1);$("productTo").value=shift(t,-1);
  $("competitorFrom").value=shift(t,-6);$("competitorTo").value=t;
  if(code()){Promise.all([loadInitial(),loadCompetitorSales()])}else showLogin();
})();