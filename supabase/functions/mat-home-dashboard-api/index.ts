import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const SESSION_HASH = "0ec2e20ddc7228bdd348bdd256114f79e46df6044db9c0267645acebbd2a4829";

async function sha256(s:string){
  const b = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(b)).map(x=>x.toString(16).padStart(2,"0")).join("");
}
async function api(path:string){
  const r=await fetch(`${SUPABASE_URL}/rest/v1/${path}`,{headers:{
    "apikey":SERVICE_ROLE,
    "Authorization":`Bearer ${SERVICE_ROLE}`
  }});
  if(!r.ok) throw new Error(`DB ${r.status} ${path}`);
  return r.json();
}
function localDate(d:any){
  return new Intl.DateTimeFormat("sv-SE",{timeZone:"Europe/Amsterdam",year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date(d));
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
  if(await sha256(code)!==SESSION_HASH){
    return new Response(JSON.stringify({ok:false,error:"unauthorized"}),{status:401,headers:cors});
  }

  const url=new URL(req.url);
  let refreshed=false;
  if(url.searchParams.get("refresh")==="1"){
    try{
      const r=await fetch(`${SUPABASE_URL}/functions/v1/bol-sync-mvp`,{
        headers:{"Authorization":`Bearer ${SERVICE_ROLE}`,"apikey":SERVICE_ROLE}
      });
      refreshed=r.ok;
    }catch(_){}
  }

  const [products,orders,items,metrics,comps,snaps,syncs]=await Promise.all([
    api("products?select=id,offer_id,ean,title,variant,active,current_price,stock,updated_at&order=active.desc,updated_at.desc"),
    api("orders?select=id,bol_order_id,ordered_at,total_amount,status&order=ordered_at.desc&limit=100"),
    api("order_items?select=id,order_id,product_id,quantity,unit_price,status&limit=500"),
    api("product_metrics?select=product_id,metric_date,visits,sales,conversion_rate,revenue,buy_box_percentage&order=metric_date.desc&limit=1000"),
    api("competitors?select=id,ean,seller_id,seller_name,offer_id,last_seen_at&limit=200"),
    api("competitor_snapshots?select=competitor_id,captured_at,price,delivery_date,is_best_offer,availability&order=captured_at.desc&limit=500"),
    api("sync_runs?select=source,status,finished_at,records_written&order=started_at.desc&limit=5")
  ]);

  const today=localDate(new Date());
  const todaysOrders=orders.filter((o:any)=>localDate(o.ordered_at)===today);
  const revenue=todaysOrders.reduce((s:number,o:any)=>s+Number(o.total_amount||0),0);
  const latestMetricDate=metrics.reduce((m:string,x:any)=>x.metric_date>m?x.metric_date:m,"");
  const latestMetrics=metrics.filter((x:any)=>x.metric_date===latestMetricDate);
  const visits=latestMetrics.reduce((s:number,x:any)=>s+Number(x.visits||0),0);
  const metricSales=latestMetrics.reduce((s:number,x:any)=>s+Number(x.sales||0),0);
  const conversion=visits>0?(metricSales/visits*100):0;
  const activeProducts=products.filter((p:any)=>p.active);

  const productPerformanceDate=latestMetricDate || today;
  const performanceOrders=orders.filter((o:any)=>localDate(o.ordered_at)===productPerformanceDate);
  const performanceOrderIds=new Set(performanceOrders.map((o:any)=>o.id));
  const performanceItemByProduct=new Map<string,{qty:number,revenue:number}>();
  for(const it of items){
    if(!performanceOrderIds.has(it.order_id)||!it.product_id) continue;
    const v=performanceItemByProduct.get(it.product_id)||{qty:0,revenue:0};
    v.qty+=Number(it.quantity||0);
    v.revenue+=Number(it.quantity||0)*Number(it.unit_price||0);
    performanceItemByProduct.set(it.product_id,v);
  }

  const productRows=activeProducts.map((p:any)=>{
    const pm=latestMetrics.find((m:any)=>m.product_id===p.id);
    const pd=performanceItemByProduct.get(p.id)||{qty:0,revenue:0};
    return {
      id:p.id,ean:p.ean,title:p.title,variant:p.variant,price:Number(p.current_price||0),
      stock:Number(p.stock||0),visits:Number(pm?.visits||0),buyBox:Number(pm?.buy_box_percentage||0),
      performanceDate:productPerformanceDate,
      ordersPerformance:pd.qty,revenuePerformance:pd.revenue,
      ordersToday:pd.qty,revenueToday:pd.revenue
    };
  }).sort((a:any,b:any)=>b.revenuePerformance-a.revenuePerformance || b.visits-a.visits);

  const dates=[...new Set(metrics.map((m:any)=>m.metric_date))].sort().slice(-14);
  const visitsSeries=dates.map((d:string)=>({
    date:d,
    visits:metrics.filter((m:any)=>m.metric_date===d).reduce((s:number,m:any)=>s+Number(m.visits||0),0)
  }));

  const latestSnapByComp=new Map<string,any>();
  for(const s of snaps){ if(!latestSnapByComp.has(s.competitor_id)) latestSnapByComp.set(s.competitor_id,s); }
  const competitors=comps.map((c:any)=>({competitor:c,snapshot:latestSnapByComp.get(c.id)})).filter((x:any)=>x.snapshot).slice(0,12);

  const lastSync=syncs.find((s:any)=>s.source==="bol_mvp"&&s.status==="success")||syncs[0]||null;

  return new Response(JSON.stringify({
    ok:true,refreshed,today,
    kpis:{
      revenueToday:revenue,
      ordersToday:todaysOrders.length,
      visitsLatest:visits,
      conversionLatest:conversion,
      latestMetricDate,
      activeProducts:activeProducts.length,
      totalProducts:products.length
    },
    recentOrders:todaysOrders.slice(0,8),
    productPerformanceDate,
    products:productRows,
    visitsSeries,
    competitors,
    lastSync
  }),{headers:{...cors,"Cache-Control":"no-store"}});
});