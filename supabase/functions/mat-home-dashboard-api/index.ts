import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const SESSION_HASH = "0ec2e20ddc7228bdd348bdd256114f79e46df6044db9c0267645acebbd2a4829";

async function sha256(s:string){
  const b=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(s));
  return Array.from(new Uint8Array(b)).map(x=>x.toString(16).padStart(2,"0")).join("");
}
async function api(path:string){
  const r=await fetch(`${SUPABASE_URL}/rest/v1/${path}`,{headers:{
    apikey:SERVICE_ROLE,Authorization:`Bearer ${SERVICE_ROLE}`
  }});
  if(!r.ok) throw new Error(`DB ${r.status} ${path}`);
  return r.json();
}
function localDate(d:any){
  return new Intl.DateTimeFormat("sv-SE",{timeZone:"Europe/Amsterdam",year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date(d));
}
function validDate(v:string|null){return !!v && /^\d{4}-\d{2}-\d{2}$/.test(v);}
function inRange(date:string,from:string,to:string){return date>=from&&date<=to;}
function daysBetween(from:string,to:string){
  return Math.max(1,Math.round((Date.parse(to+"T12:00:00Z")-Date.parse(from+"T12:00:00Z"))/86400000)+1);
}
function shiftDate(date:string,days:number){
  const d=new Date(date+"T12:00:00Z");
  d.setUTCDate(d.getUTCDate()+days);
  return d.toISOString().slice(0,10);
}
async function dailyOrders(from:string,to:string){
  const counts=new Map<string,number>();
  // Include the UTC boundary around Amsterdam midnight, then filter by local date.
  const query=`orders?select=id,ordered_at&ordered_at=gte.${shiftDate(from,-1)}T00:00:00Z&ordered_at=lt.${shiftDate(to,1)}T00:00:00Z&order=ordered_at.asc,id.asc`;
  let offset=0;
  while(true){
    const page=await api(`${query}&limit=1000&offset=${offset}`);
    if(!page.length) break;
    for(const order of page){
      const date=localDate(order.ordered_at);
      if(inRange(date,from,to)) counts.set(date,(counts.get(date)||0)+1);
    }
    offset+=page.length;
  }
  return Array.from({length:daysBetween(from,to)},(_,i)=>{
    const date=shiftDate(from,i);
    return {date,orders:counts.get(date)||0};
  });
}
const cors={
  "Access-Control-Allow-Origin":"*",
  "Access-Control-Allow-Headers":"content-type,x-dashboard-code",
  "Access-Control-Allow-Methods":"GET,POST,OPTIONS",
  "Content-Type":"application/json"
};

Deno.serve(async(req)=>{
  if(req.method==="OPTIONS") return new Response("ok",{headers:cors});
  const code=req.headers.get("x-dashboard-code")||"";
  if(await sha256(code)!==SESSION_HASH)
    return new Response(JSON.stringify({ok:false,error:"unauthorized"}),{status:401,headers:cors});

  const url=new URL(req.url);
  let refreshed=false;
  if(url.searchParams.get("refresh")==="1"){
    try{
      const r=await fetch(`${SUPABASE_URL}/functions/v1/bol-sync-mvp`,{
        headers:{Authorization:`Bearer ${SERVICE_ROLE}`,apikey:SERVICE_ROLE}
      });
      refreshed=r.ok;
    }catch(_){}
  }

  const [products,orders,items,metrics,comps,snaps,syncs]=await Promise.all([
    api("products?select=id,offer_id,ean,title,variant,active,current_price,stock,updated_at&order=active.desc,updated_at.desc"),
    api("orders?select=id,bol_order_id,ordered_at,total_amount,status&order=ordered_at.desc&limit=1000"),
    api("order_items?select=id,order_id,product_id,quantity,unit_price,status&limit=5000"),
    api("product_metrics?select=product_id,metric_date,visits,sales,conversion_rate,revenue,buy_box_percentage&order=metric_date.desc&limit=5000"),
    api("competitors?select=id,ean,seller_id,seller_name,offer_id,last_seen_at&limit=200"),
    api("competitor_snapshots?select=competitor_id,captured_at,price,delivery_date,is_best_offer,availability&order=captured_at.desc&limit=500"),
    api("sync_runs?select=source,status,finished_at,records_written&order=started_at.desc&limit=5")
  ]);

  const today=localDate(new Date());
  const latestMetricDate=metrics.reduce((m:string,x:any)=>x.metric_date>m?x.metric_date:m,"");
  const qFrom=url.searchParams.get("from"),qTo=url.searchParams.get("to");
  const hasRange=validDate(qFrom)&&validDate(qTo);
  const from=hasRange?qFrom!:today;
  const to=hasRange?qTo!:today;
  if(from>to) return new Response(JSON.stringify({ok:false,error:"Ongeldige periode"}),{status:400,headers:cors});

  const rangeOrders=orders.filter((o:any)=>inRange(localDate(o.ordered_at),from,to));
  const rangeMetrics=metrics.filter((m:any)=>inRange(m.metric_date,from,to));
  const revenueRange=rangeOrders.reduce((s:number,o:any)=>s+Number(o.total_amount||0),0);
  const visitsRange=rangeMetrics.reduce((s:number,m:any)=>s+Number(m.visits||0),0);
  const salesRange=rangeMetrics.reduce((s:number,m:any)=>s+Number(m.sales||0),0);
  const conversionRange=visitsRange>0?salesRange/visitsRange*100:0;
  const activeProducts=products.filter((p:any)=>p.active);

  const performanceFrom=hasRange?from:(latestMetricDate||today);
  const performanceTo=hasRange?to:(latestMetricDate||today);
  const performanceOrders=orders.filter((o:any)=>inRange(localDate(o.ordered_at),performanceFrom,performanceTo));
  const performanceOrderIds=new Set(performanceOrders.map((o:any)=>o.id));
  const performanceMetrics=metrics.filter((m:any)=>inRange(m.metric_date,performanceFrom,performanceTo));
  const performanceItemByProduct=new Map<string,{qty:number,revenue:number}>();
  for(const it of items){
    if(!performanceOrderIds.has(it.order_id)||!it.product_id) continue;
    const v=performanceItemByProduct.get(it.product_id)||{qty:0,revenue:0};
    v.qty+=Number(it.quantity||0);
    v.revenue+=Number(it.quantity||0)*Number(it.unit_price||0);
    performanceItemByProduct.set(it.product_id,v);
  }

  const productRows=activeProducts.map((p:any)=>{
    const pms=performanceMetrics.filter((m:any)=>m.product_id===p.id);
    const pd=performanceItemByProduct.get(p.id)||{qty:0,revenue:0};
    const pVisits=pms.reduce((s:number,m:any)=>s+Number(m.visits||0),0);
    const pBuyBox=pms.length?pms.reduce((s:number,m:any)=>s+Number(m.buy_box_percentage||0),0)/pms.length:0;
    return {
      id:p.id,ean:p.ean,title:p.title,variant:p.variant,price:Number(p.current_price||0),
      stock:Number(p.stock||0),visits:pVisits,buyBox:pBuyBox,
      performanceFrom,performanceTo,
      ordersPerformance:pd.qty,revenuePerformance:pd.revenue
    };
  }).sort((a:any,b:any)=>b.revenuePerformance-a.revenuePerformance||b.visits-a.visits);

  const seriesFrom=hasRange?from:[...new Set(metrics.map((m:any)=>m.metric_date))].sort().slice(-14)[0]||latestMetricDate;
  const seriesTo=hasRange?to:latestMetricDate;
  const dates=[...new Set(metrics.map((m:any)=>m.metric_date))]
    .filter((d:any)=>d>=seriesFrom&&d<=seriesTo).sort();
  const visitsSeries=dates.map((d:string)=>({
    date:d,
    visits:metrics.filter((m:any)=>m.metric_date===d).reduce((s:number,m:any)=>s+Number(m.visits||0),0)
  }));
  const ordersSeriesRange={from:hasRange?from:shiftDate(today,-13),to:hasRange?to:today};
  const ordersSeries=await dailyOrders(ordersSeriesRange.from,ordersSeriesRange.to);

  const latestSnapByComp=new Map<string,any>();
  for(const s of snaps) if(!latestSnapByComp.has(s.competitor_id)) latestSnapByComp.set(s.competitor_id,s);
  const competitors=comps.map((c:any)=>({competitor:c,snapshot:latestSnapByComp.get(c.id)})).filter((x:any)=>x.snapshot).slice(0,12);
  const lastSync=syncs.find((s:any)=>s.source==="bol_mvp"&&s.status==="success")||syncs[0]||null;

  return new Response(JSON.stringify({
    ok:true,refreshed,today,
    selectedRange:{from,to,days:daysBetween(from,to),custom:hasRange},
    kpis:{
      revenueToday:revenueRange,ordersToday:rangeOrders.length,
      visitsLatest:visitsRange,conversionLatest:conversionRange,
      latestMetricDate,activeProducts:activeProducts.length,totalProducts:products.length
    },
    recentOrders:rangeOrders.slice(0,20),
    productPerformanceDate:performanceFrom===performanceTo?performanceFrom:null,
    productPerformanceRange:{from:performanceFrom,to:performanceTo},
    products:productRows,visitsSeries,ordersSeries,ordersSeriesRange,competitors,lastSync
  }),{headers:{...cors,"Cache-Control":"no-store"}});
});
