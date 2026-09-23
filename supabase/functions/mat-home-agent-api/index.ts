import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const SESSION_HASH = "0ec2e20ddc7228bdd348bdd256114f79e46df6044db9c0267645acebbd2a4829";

const cors = {
  "Access-Control-Allow-Origin":"*",
  "Access-Control-Allow-Headers":"content-type,x-dashboard-code",
  "Access-Control-Allow-Methods":"POST,OPTIONS",
  "Content-Type":"application/json"
};

async function sha256(s:string){
  const b=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(s));
  return Array.from(new Uint8Array(b)).map(x=>x.toString(16).padStart(2,"0")).join("");
}
async function api(path:string){
  const r=await fetch(SUPABASE_URL+"/rest/v1/"+path,{headers:{apikey:SERVICE_ROLE,Authorization:"Bearer "+SERVICE_ROLE}});
  if(!r.ok) throw new Error("DB "+r.status+" "+path);
  return r.json();
}
function localDate(v:any){
  return new Intl.DateTimeFormat("sv-SE",{timeZone:"Europe/Amsterdam",year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date(v));
}
function shiftDate(date:string,days:number){
  const d=new Date(date+"T12:00:00Z"); d.setUTCDate(d.getUTCDate()+days); return d.toISOString().slice(0,10);
}
function dayDiff(a:string,b:string){
  return Math.round((Date.parse(b+"T12:00:00Z")-Date.parse(a+"T12:00:00Z"))/86400000);
}
function nlDate(date:string){
  return new Intl.DateTimeFormat("nl-NL",{weekday:"long",day:"numeric",month:"short"}).format(new Date(date+"T12:00:00Z"));
}
function money(n:number){return new Intl.NumberFormat("nl-NL",{style:"currency",currency:"EUR"}).format(n||0)}
function nfmt(n:number,digits=0){return new Intl.NumberFormat("nl-NL",{minimumFractionDigits:digits,maximumFractionDigits:digits}).format(n||0)}
function norm(s:string){return String(s||"").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g,"").replace(/[?!.:,;]/g," ").replace(/\s+/g," ").trim()}
function pct(cur:number,prev:number){return prev>0?((cur-prev)/prev*100):(cur>0?100:0)}
function clampText(s:string,max=1200){return s.length>max?s.slice(0,max-1)+"…":s}

type Daily = {date:string;orders:number;revenue:number;visits:number;metricSales:number;conversion:number};
type ProductDay = {productId:string;name:string;date:string;orders:number;revenue:number;visits:number};

function latestWeekday(base:string,target:number){
  const d=new Date(base+"T12:00:00Z");
  const cur=d.getUTCDay();
  const back=(cur-target+7)%7;
  d.setUTCDate(d.getUTCDate()-back);
  return d.toISOString().slice(0,10);
}
function dateFromQuestion(q:string,base:string){
  if(q.includes("vandaag")) return base;
  if(q.includes("gisteren")) return shiftDate(base,-1);
  if(q.includes("eergisteren")) return shiftDate(base,-2);
  const days:[string,number][]=[["zondag",0],["maandag",1],["dinsdag",2],["woensdag",3],["donderdag",4],["vrijdag",5],["zaterdag",6]];
  for(const [name,idx] of days) if(q.includes(name)) return latestWeekday(base,idx);
  const m=q.match(/\b(\d{1,2})[-\/ ](\d{1,2})(?:[-\/ ](\d{2,4}))?\b/);
  if(m){
    const year=m[3]?Number(m[3].length===2?"20"+m[3]:m[3]):Number(base.slice(0,4));
    const mm=String(Number(m[2])).padStart(2,"0"),dd=String(Number(m[1])).padStart(2,"0");
    return year+"-"+mm+"-"+dd;
  }
  return null;
}
function metricLine(d:Daily){
  return nlDate(d.date)+": "+d.orders+" sales, "+money(d.revenue)+", "+d.visits+" bezoeken, "+nfmt(d.conversion,1)+"% conversie";
}

Deno.serve(async(req)=>{
  if(req.method==="OPTIONS") return new Response("ok",{headers:cors});
  if(req.method!=="POST") return new Response(JSON.stringify({ok:false,error:"method not allowed"}),{status:405,headers:cors});
  const code=req.headers.get("x-dashboard-code")||"";
  if(await sha256(code)!==SESSION_HASH) return new Response(JSON.stringify({ok:false,error:"unauthorized"}),{status:401,headers:cors});

  try{
    const body=await req.json().catch(()=>({}));
    const question=clampText(String(body?.question||"").trim(),500);
    if(!question) return new Response(JSON.stringify({ok:false,error:"Vraag ontbreekt"}),{status:400,headers:cors});
    const q=norm(question);

    const [orders,items,products,metrics,searchMetrics,trackingRuns]=await Promise.all([
      api("orders?select=id,ordered_at,total_amount,status&order=ordered_at.desc&limit=2000"),
      api("order_items?select=order_id,product_id,quantity,unit_price,status&limit=6000"),
      api("products?select=id,title,variant,ean,active,current_price,stock&order=active.desc,updated_at.desc&limit=300"),
      api("product_metrics?select=product_id,metric_date,visits,sales,revenue,conversion_rate&order=metric_date.desc&limit=8000"),
      api("search_term_metrics?select=search_term,metric_date,search_volume,country_code&country_code=eq.NL&order=metric_date.desc&limit=1200"),
      api("competitor_tracking_runs?select=started_at,finished_at,status,targets_total,successes,failures&order=started_at.desc&limit=1")
    ]);

    const today=localDate(new Date());
    const latestMetric=metrics.reduce((m:string,x:any)=>x.metric_date>m?x.metric_date:m,"");
    const base=latestMetric||today;
    const start=shiftDate(base,-34);

    const byDay=new Map<string,Daily>();
    for(let i=0;i<=34;i++){const date=shiftDate(start,i);byDay.set(date,{date,orders:0,revenue:0,visits:0,metricSales:0,conversion:0})}
    for(const o of orders){
      const date=localDate(o.ordered_at); const d=byDay.get(date); if(!d) continue;
      d.orders+=1; d.revenue+=Number(o.total_amount||0);
    }
    for(const m of metrics){
      const d=byDay.get(m.metric_date); if(!d) continue;
      d.visits+=Number(m.visits||0); d.metricSales+=Number(m.sales||0);
    }
    for(const d of byDay.values()) d.conversion=d.visits>0?d.orders/d.visits*100:0;
    const daily=[...byDay.values()].sort((a,b)=>a.date.localeCompare(b.date));

    const prodById=new Map(products.map((p:any)=>[p.id,p]));
    const orderById=new Map(orders.map((o:any)=>[o.id,o]));
    const productDayMap=new Map<string,ProductDay>();
    function pdKey(pid:string,date:string){return pid+"|"+date}
    for(const it of items){
      if(!it.product_id) continue;
      const o=orderById.get(it.order_id); if(!o) continue;
      const date=localDate(o.ordered_at); if(date<start||date>today) continue;
      const p:any=prodById.get(it.product_id)||{};
      const key=pdKey(it.product_id,date);
      const row=productDayMap.get(key)||{productId:it.product_id,name:p.variant||p.title||p.ean||"Product",date,orders:0,revenue:0,visits:0};
      row.orders+=Number(it.quantity||0); row.revenue+=Number(it.quantity||0)*Number(it.unit_price||0); productDayMap.set(key,row);
    }
    for(const m of metrics){
      const p:any=prodById.get(m.product_id)||{}; const key=pdKey(m.product_id,m.metric_date);
      const row=productDayMap.get(key)||{productId:m.product_id,name:p.variant||p.title||p.ean||"Product",date:m.metric_date,orders:0,revenue:0,visits:0};
      row.visits+=Number(m.visits||0); productDayMap.set(key,row);
    }
    const productDays=[...productDayMap.values()];

    const latestSearchDate=searchMetrics.reduce((m:string,x:any)=>x.metric_date>m?x.metric_date:m,"");
    const latestSearch=searchMetrics.filter((x:any)=>x.metric_date===latestSearchDate).sort((a:any,b:any)=>Number(b.search_volume||0)-Number(a.search_volume||0));

    function getDay(date:string|null){return date?byDay.get(date)||null:null}
    function productSummary(date:string){
      return productDays.filter(p=>p.date===date&&p.orders>0).sort((a,b)=>b.orders-a.orders||b.revenue-a.revenue);
    }
    function avgDays(rows:Daily[]){
      const valid=rows.filter(Boolean);
      if(!valid.length)return {orders:0,revenue:0,visits:0,conversion:0};
      const orders=valid.reduce((s,d)=>s+d.orders,0)/valid.length;
      const revenue=valid.reduce((s,d)=>s+d.revenue,0)/valid.length;
      const visits=valid.reduce((s,d)=>s+d.visits,0)/valid.length;
      const conversion=visits>0?(valid.reduce((s,d)=>s+d.orders,0)/valid.reduce((s,d)=>s+d.visits,0))*100:0;
      return {orders,revenue,visits,conversion};
    }

    const requestedDate=dateFromQuestion(q,base);
    const refDay=getDay(requestedDate);
    const why=/waarom|hoe (komt|kan)|waardoor|verklaar|afname|daling|gedaald|stijging|gestegen|piek|ineens/.test(q);

    if(why && refDay){
      const after=daily.filter(d=>d.date>refDay.date&&d.date<=base&&d.visits>0).slice(0,4);
      const before=daily.filter(d=>d.date<refDay.date&&d.visits>0).slice(-3);
      const nextAvg=avgDays(after);
      const prevAvg=avgDays(before);
      const salesDrop=after.length?pct(nextAvg.orders,refDay.orders):0;
      const visitsDrop=after.length?pct(nextAvg.visits,refDay.visits):0;
      const convPp=after.length?nextAvg.conversion-refDay.conversion:0;
      let driver="";
      if(after.length){
        if(Math.abs(convPp)>=2 && Math.abs(visitsDrop)<25) driver="De grootste verklaring zit in de conversie, niet alleen in het verkeer.";
        else if(visitsDrop<=-25 && Math.abs(convPp)<2) driver="De grootste verklaring zit in minder verkeer.";
        else if(visitsDrop<0&&convPp<0) driver="Zowel verkeer als conversie zijn daarna teruggevallen.";
        else driver="De verandering komt niet uit één duidelijke factor; verkeer en conversie bewegen gemengd.";
      }
      const prods=productSummary(refDay.date).slice(0,4);
      const prodText=prods.length?" Op die dag kwamen de sales vooral uit "+prods.map(p=>p.name+" ("+p.orders+")").join(", ")+".":"";
      const afterText=after.length?" Daarna gemiddeld: "+nfmt(nextAvg.orders,1)+" sales/dag, "+nfmt(nextAvg.visits,0)+" bezoeken/dag en "+nfmt(nextAvg.conversion,1)+"% conversie.":"";
      const beforeText=before.length?" De drie meetdagen ervoor zaten gemiddeld op "+nfmt(prevAvg.orders,1)+" sales/dag en "+nfmt(prevAvg.conversion,1)+"% conversie.":"";
      const answer=metricLine(refDay)+". "+driver+afterText+beforeText+prodText+
        (after.length?" Verandering t.o.v. die piek: sales "+(salesDrop>=0?"+":"")+nfmt(salesDrop,0)+"%, bezoeken "+(visitsDrop>=0?"+":"")+nfmt(visitsDrop,0)+"% en conversie "+(convPp>=0?"+":"")+nfmt(convPp,1)+" procentpunt.":"");
      return new Response(JSON.stringify({ok:true,answer,mode:"trend_explanation",evidence:{date:refDay.date,after:after.map(d=>d.date)}}),{headers:{...cors,"Cache-Control":"no-store"}});
    }

    if(why && !refDay){
      const recent=daily.filter(d=>d.visits>0&&d.date<=base).slice(-8);
      const peak=[...recent].sort((a,b)=>b.orders-a.orders||b.revenue-a.revenue)[0];
      if(peak){
        const after=recent.filter(d=>d.date>peak.date);
        const av=avgDays(after);
        const answer="De opvallendste recente piek was "+metricLine(peak)+". "+
          (after.length?"Daarna lag het gemiddelde op "+nfmt(av.orders,1)+" sales/dag, "+nfmt(av.visits,0)+" bezoeken/dag en "+nfmt(av.conversion,1)+"% conversie. ":"")+
          "Als je een specifieke dag noemt, vergelijk ik die direct met de dagen ervoor en erna.";
        return new Response(JSON.stringify({ok:true,answer,mode:"auto_peak"}),{headers:{...cors,"Cache-Control":"no-store"}});
      }
    }

    if(/beste product|sterkste product|hardloper|top product/.test(q)){
      const from=shiftDate(base,-6);
      const rows=new Map<string,{name:string,orders:number,visits:number,revenue:number}>();
      for(const p of productDays.filter(x=>x.date>=from&&x.date<=base)){
        const r=rows.get(p.productId)||{name:p.name,orders:0,visits:0,revenue:0};
        r.orders+=p.orders;r.visits+=p.visits;r.revenue+=p.revenue;rows.set(p.productId,r);
      }
      const top=[...rows.values()].sort((a,b)=>b.orders-a.orders||b.revenue-a.revenue)[0];
      const answer=top?top.name+" is over de laatste 7 meetdagen het sterkst: "+top.orders+" sales uit "+top.visits+" bezoeken ("+nfmt(top.visits?top.orders/top.visits*100:0,1)+"% conversie), omzet "+money(top.revenue)+".":"Nog onvoldoende productdata.";
      return new Response(JSON.stringify({ok:true,answer,mode:"top_product"}),{headers:{...cors,"Cache-Control":"no-store"}});
    }

    if(/waar.*winst|kans|verbeter|optimal|wat.*aanpassen|wat.*doen/.test(q)){
      const from=shiftDate(base,-6);
      const rows=new Map<string,{name:string,orders:number,visits:number,revenue:number}>();
      for(const p of productDays.filter(x=>x.date>=from&&x.date<=base)){
        const r=rows.get(p.productId)||{name:p.name,orders:0,visits:0,revenue:0};
        r.orders+=p.orders;r.visits+=p.visits;r.revenue+=p.revenue;rows.set(p.productId,r);
      }
      const candidates=[...rows.values()].filter(x=>x.visits>=10).map(x=>({...x,conv:x.visits?x.orders/x.visits*100:0})).sort((a,b)=>a.conv-b.conv||b.visits-a.visits);
      const c=candidates[0];
      let answer=c?"Mijn eerste optimalisatiekans is "+c.name+": "+c.visits+" bezoeken, "+c.orders+" sales, "+nfmt(c.conv,1)+"% conversie in 7 meetdagen. Test daar eerst hoofdafbeelding/USP en titel; verander niet tegelijk prijs én content.":"Nog te weinig productbezoeken om één duidelijke winnaar voor optimalisatie aan te wijzen.";
      if(latestSearch.length) answer+=" Zoekvolume-signaal: hoogste gevolgde term is “"+latestSearch[0].search_term+"” met "+latestSearch[0].search_volume+" zoekopdrachten op "+nlDate(latestSearchDate)+".";
      return new Response(JSON.stringify({ok:true,answer,mode:"opportunity"}),{headers:{...cors,"Cache-Control":"no-store"}});
    }

    if(/zoekvolume|zoekwoord|search/.test(q)){
      const top=latestSearch.slice(0,5);
      const answer=top.length?"Laatste zoekvolumemeting ("+nlDate(latestSearchDate)+"): "+top.map((x:any)=>"“"+x.search_term+"” "+x.search_volume).join(", ")+". Dit zijn exacte gevolgde termen en kunnen onderling overlappen.":"Er staat nog geen zoekvolumedata in de database.";
      return new Response(JSON.stringify({ok:true,answer,mode:"search"}),{headers:{...cors,"Cache-Control":"no-store"}});
    }

    if(/concurrent/.test(q)){
      const tr=trackingRuns?.[0];
      const answer=tr
        ? "Laatste automatische concurrentmeting: "+tr.successes+"/"+tr.targets_total+" gelukt ("+tr.status+"). Zolang er geen twee betrouwbare voorraadmetingen per product zijn, behandel concurrent-sales als schatting en niet als feit."
        : "Nog geen automatische concurrentmeting beschikbaar.";
      return new Response(JSON.stringify({ok:true,answer,mode:"competitor"}),{headers:{...cors,"Cache-Control":"no-store"}});
    }

    if(refDay){
      const prods=productSummary(refDay.date).slice(0,5);
      let answer=metricLine(refDay)+".";
      if(prods.length) answer+=" Producten met sales: "+prods.map(p=>p.name+" ("+p.orders+")").join(", ")+".";
      return new Response(JSON.stringify({ok:true,answer,mode:"day"}),{headers:{...cors,"Cache-Control":"no-store"}});
    }

    if(/week|doel|target|tempo/.test(q)){
      const d=new Date(today+"T12:00:00Z"),daysSinceMonday=(d.getUTCDay()+6)%7,weekFrom=shiftDate(today,-daysSinceMonday);
      const weekRows=daily.filter(x=>x.date>=weekFrom&&x.date<=today);
      const sales=weekRows.reduce((s,x)=>s+x.orders,0),target=14,gap=Math.max(0,target-sales),pace=(daysSinceMonday+1)*2;
      const answer="Deze maandag-zondagweek: "+sales+"/"+target+" sales. "+(sales>=pace?"Je ligt op of boven het tempo van 2 per dag.":"Je ligt "+(pace-sales)+" sales achter op het huidige tempo.")+" Nog "+gap+" nodig voor het weekdoel.";
      return new Response(JSON.stringify({ok:true,answer,mode:"week"}),{headers:{...cors,"Cache-Control":"no-store"}});
    }

    if(/bezoek|verkeer|traffic|convers|omzet|sales|orders|bestellingen/.test(q)){
      const recent=daily.filter(d=>d.visits>0&&d.date<=base).slice(-7);
      const av=avgDays(recent);
      const totalOrders=recent.reduce((s,d)=>s+d.orders,0),totalRevenue=recent.reduce((s,d)=>s+d.revenue,0),totalVisits=recent.reduce((s,d)=>s+d.visits,0);
      const answer="Laatste 7 meetdagen: "+totalOrders+" sales, "+money(totalRevenue)+", "+totalVisits+" bezoeken en "+nfmt(totalVisits?totalOrders/totalVisits*100:0,1)+"% conversie. Gemiddeld "+nfmt(av.orders,1)+" sales per meetdag.";
      return new Response(JSON.stringify({ok:true,answer,mode:"summary"}),{headers:{...cors,"Cache-Control":"no-store"}});
    }

    const recent=daily.filter(d=>d.visits>0&&d.date<=base).slice(-7);
    const totalOrders=recent.reduce((s,d)=>s+d.orders,0);
    const answer="Ik kan je vraag analyseren met je live sales-, omzet-, bezoek-, conversie-, product- en zoekvolumedata. De laatste 7 meetdagen bevatten "+totalOrders+" sales. Noem eventueel een dag, product, daling/piek, zoekwoord of doel voor een gerichte analyse.";
    return new Response(JSON.stringify({ok:true,answer,mode:"fallback"}),{headers:{...cors,"Cache-Control":"no-store"}});
  }catch(e){
    console.error(e);
    return new Response(JSON.stringify({ok:false,error:"Analyse kon niet worden uitgevoerd"}),{status:500,headers:cors});
  }
});