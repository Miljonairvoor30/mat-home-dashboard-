(() => {
  const cfg = window.MAT_HOME_CONFIG || {};
  const API = cfg.dashboardApi;
  const COMP_API = cfg.competitorSalesApi;
  const $ = (id) => document.getElementById(id);
  const euro = new Intl.NumberFormat("nl-NL",{style:"currency",currency:"EUR"});
  const num = new Intl.NumberFormat("nl-NL");
  const dec = new Intl.NumberFormat("nl-NL",{minimumFractionDigits:1,maximumFractionDigits:1});
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"}[c]));
  const shortDate = (s) => s ? new Intl.DateTimeFormat("nl-NL",{day:"2-digit",month:"short"}).format(new Date(s+"T12:00:00Z")) : "—";
  const time = (s) => s ? new Intl.DateTimeFormat("nl-NL",{hour:"2-digit",minute:"2-digit",timeZone:"Europe/Amsterdam"}).format(new Date(s)) : "—";
  const dateTime = (s) => s ? new Intl.DateTimeFormat("nl-NL",{dateStyle:"short",timeStyle:"short",timeZone:"Europe/Amsterdam"}).format(new Date(s)) : "—";
  const code = () => localStorage.getItem("mh_code") || "";
  const headers = () => ({"x-dashboard-code":code(),"content-type":"application/json"});

  async function request(url, options={}) {
    const r = await fetch(url,{...options,headers:{...headers(),...(options.headers||{})},cache:"no-store"});
    if(r.status===401){ localStorage.removeItem("mh_code"); showLogin(true); throw new Error("unauthorized"); }
    const data = await r.json().catch(()=>({}));
    if(!r.ok || data?.ok===false) throw new Error(data?.error || `API ${r.status}`);
    return data;
  }
  function showLogin(bad=false){$("app").classList.add("hidden");$("login").classList.remove("hidden");$("loginError").classList.toggle("hidden",!bad);}
  function showApp(){$("login").classList.add("hidden");$("app").classList.remove("hidden");}

  async function loadDashboard(refresh=false){
    if(!code()) return showLogin();
    const banner=$("statusBanner");
    if(refresh){banner.classList.remove("hidden");banner.textContent="Bol-data wordt ververst…";$("refresh").disabled=true;}
    try{
      const d=await request(API+(refresh?"?refresh=1":""));
      renderDashboard(d);showApp();
      if(refresh){banner.textContent=d.refreshed?"Bol-data is opnieuw gesynchroniseerd.":"Dashboard geladen; sync gaf geen bevestiging.";setTimeout(()=>banner.classList.add("hidden"),2800);}
    }catch(e){if(e.message!=="unauthorized"){banner.classList.remove("hidden");banner.textContent="Kon dashboarddata niet laden.";}}
    finally{$("refresh").disabled=false;}
  }

  function renderDashboard(d){
    $("revenue").textContent=euro.format(d.kpis?.revenueToday||0);
    $("revenueSub").textContent=`${num.format(d.kpis?.ordersToday||0)} bestelling${d.kpis?.ordersToday===1?"":"en"}`;
    $("orders").textContent=num.format(d.kpis?.ordersToday||0);
    $("visits").textContent=num.format(d.kpis?.visitsLatest||0);
    $("visitsSub").textContent=d.kpis?.latestMetricDate?`Laatste meetdag: ${shortDate(d.kpis.latestMetricDate)}`:"Nog geen bezoekdata";
    $("conversion").textContent=dec.format(d.kpis?.conversionLatest||0)+"%";
    const performanceDate=d.productPerformanceDate||d.kpis?.latestMetricDate||null;
    if(performanceDate){
      $("productPerformanceTitle").textContent=`Productprestaties · ${shortDate(performanceDate)}`;
      $("productOrdersHeader").textContent=`Orders · ${shortDate(performanceDate)}`;
    }
    const series=d.visitsSeries||[], max=Math.max(1,...series.map(x=>x.visits||0));
    $("chart").innerHTML=series.length?series.map(x=>`<div class="bar-col"><div class="bar" style="height:${Math.max(3,Math.round((x.visits||0)/max*165))}px" title="${num.format(x.visits||0)} bezoeken"></div><div class="x">${esc(shortDate(x.date))}</div></div>`).join(""):'<div class="empty">Nog geen bezoekdata.</div>';
    $("recentOrders").innerHTML=(d.recentOrders||[]).length?(d.recentOrders||[]).map(o=>`<div class="row"><div class="dot"></div><div><b>Order ${esc(String(o.bol_order_id||o.orderId||"").slice(-6))} · ${euro.format(Number(o.total_amount||o.amount||0))}</b><p>${esc(time(o.ordered_at||o.time))}</p></div></div>`).join(""):'<div class="empty">Nog geen orders vandaag.</div>';
    $("products").innerHTML=(d.products||[]).length?(d.products||[]).slice(0,25).map(p=>`<tr><td><b>${esc(p.variant||p.title||p.name)}</b><div class="hint">${esc(p.ean||"")}</div></td><td>${euro.format(Number(p.price||0))}</td><td>${num.format(p.stock||0)}</td><td>${num.format(p.visits||0)}</td><td>${num.format(p.ordersPerformance??p.ordersToday??0)}</td></tr>`).join(""):'<tr><td colspan="5" class="empty">Geen actieve producten.</td></tr>';
    $("competitors").innerHTML=(d.competitors||[]).length?(d.competitors||[]).map(x=>`<div class="row"><div class="dot warn"></div><div><b>${esc(x.competitor?.seller_name||x.competitor?.seller_id||"Concurrent")} · ${euro.format(Number(x.snapshot?.price||0))}</b><p>EAN ${esc(x.competitor?.ean||"")}${x.snapshot?.is_best_offer?" · beste aanbod":" · concurrent"}</p></div></div>`).join(""):'<div class="empty">Nog geen directe concurrent op dezelfde EAN gevonden.</div>';
    const ls=d.lastSync?.finished_at?dateTime(d.lastSync.finished_at):"onbekend";
    $("systemStatus").innerHTML=`<div class="row"><div class="dot"></div><div><b>${num.format(d.kpis?.activeProducts||0)} actieve producten</b><p>${num.format(d.kpis?.totalProducts||0)} producten bekend</p></div></div><div class="row"><div class="dot"></div><div><b>Bol API verbonden</b><p>Laatste sync: ${esc(ls)}</p></div></div><div class="row"><div class="dot"></div><div><b>Code onder eigen beheer</b><p>Frontend geschikt voor GitHub Pages</p></div></div>`;
  }

  async function loadCompetitorSales(){
    if(!code() || !COMP_API) return;
    try{
      const d=await request(COMP_API), targets=d.targets||[];
      $("comp24").textContent=num.format(targets.reduce((a,t)=>a+Number(t.estimatedSales24h||0),0));
      $("comp7").textContent=num.format(targets.reduce((a,t)=>a+Number(t.estimatedSales7d||0),0));
      $("compCount").textContent=num.format(targets.length);
      $("competitorSales").innerHTML=targets.length?targets.map(t=>`<article class="comp-card"><div class="comp-head"><div><b>${esc(t.name)}</b><div class="hint">${esc(t.sellerName||"Verkoper onbekend")}${t.ean?` · ${esc(t.ean)}`:""}</div></div><a href="${esc(t.productUrl||"#")}" target="_blank" rel="noopener">Open ↗</a></div>${t.restockDetected24h?'<div class="badge">Aanvulling/voorraadcorrectie gedetecteerd</div>':""}${Number(t.snapshotsCount||0)<2?'<div class="hint" style="margin-top:12px">Nog onvoldoende metingen voor sales-schatting.</div>':`<div class="metrics"><div class="metric"><span>Voorraad gemeten</span><strong>${t.latestStock??"—"}</strong></div><div class="metric"><span>Geschat 24u</span><strong>${t.restockDetected24h?"—":num.format(t.estimatedSales24h||0)}</strong></div><div class="metric"><span>Geschat 7 dagen</span><strong>${num.format(t.estimatedSales7d||0)}</strong></div><div class="metric"><span>Geschat / dag</span><strong>${dec.format(t.avgSalesPerDay7d||0)}</strong></div></div>`}<div class="hint">Laatste meting: ${esc(dateTime(t.latestCapturedAt))} · ${num.format(t.snapshotsCount||0)} metingen</div><form class="snapshot" data-target="${esc(t.id)}"><input type="number" min="0" step="1" inputmode="numeric" placeholder="Gemeten voorraad" required><button class="btn primary" type="submit">Opslaan</button></form></article>`).join(""):'<div class="empty">Nog geen concurrenten gevolgd.</div>';
      document.querySelectorAll(".snapshot").forEach(form=>form.addEventListener("submit",async e=>{e.preventDefault();const input=form.querySelector("input"),value=Number(input.value);if(!Number.isInteger(value)||value<0)return;const btn=form.querySelector("button");btn.disabled=true;try{await request(COMP_API,{method:"POST",body:JSON.stringify({action:"record_snapshot",targetId:form.dataset.target,availableStock:value})});input.value="";await loadCompetitorSales();}catch(e){alert("Voorraadmeting opslaan is niet gelukt.");}finally{btn.disabled=false;}}));
    }catch(e){if(e.message!=="unauthorized")$("competitorSales").innerHTML='<div class="empty">Concurrent-schattingen konden niet geladen worden.</div>';}
  }

  $("loginForm").addEventListener("submit",e=>{e.preventDefault();localStorage.setItem("mh_code",$("code").value.trim());Promise.all([loadDashboard(),loadCompetitorSales()]);});
  $("logout").addEventListener("click",()=>{localStorage.removeItem("mh_code");$("code").value="";showLogin();});
  $("refresh").addEventListener("click",async()=>{await loadDashboard(true);await loadCompetitorSales();});
  $("toggleAddCompetitor").addEventListener("click",()=>$("addCompetitorForm").classList.toggle("hidden"));
  $("saveCompetitor").addEventListener("click",async()=>{const name=$("compName").value.trim(),productUrl=$("compUrl").value.trim();if(!name||!productUrl){$("compFormMsg").textContent="Naam en product-URL zijn verplicht.";return;}$("saveCompetitor").disabled=true;try{await request(COMP_API,{method:"POST",body:JSON.stringify({action:"add_target",name,productUrl,sellerName:$("compSeller").value.trim()||undefined,ean:$("compEan").value.trim()||undefined})});["compName","compUrl","compSeller","compEan"].forEach(id=>$(id).value="");$("compFormMsg").textContent="Concurrent toegevoegd.";await loadCompetitorSales();}catch(e){$("compFormMsg").textContent="Toevoegen is niet gelukt.";}finally{$("saveCompetitor").disabled=false;}});

  if(code()){Promise.all([loadDashboard(),loadCompetitorSales()]);} else showLogin();
})();
