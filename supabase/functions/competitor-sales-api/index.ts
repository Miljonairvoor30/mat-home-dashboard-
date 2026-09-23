import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const SUPABASE_URL=Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE=Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const SESSION_HASH="0ec2e20ddc7228bdd348bdd256114f79e46df6044db9c0267645acebbd2a4829";

async function sha256(s:string){
  const b=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(s));
  return Array.from(new Uint8Array(b)).map(x=>x.toString(16).padStart(2,"0")).join("");
}
const cors={
  "Access-Control-Allow-Origin":"*","Access-Control-Allow-Headers":"content-type,x-dashboard-code",
  "Access-Control-Allow-Methods":"GET,POST,OPTIONS","Content-Type":"application/json"
};
async function rest(path:string,init:RequestInit={}){
  const r=await fetch(`${SUPABASE_URL}/rest/v1/${path}`,{...init,headers:{
    apikey:SERVICE_ROLE,Authorization:`Bearer ${SERVICE_ROLE}`,"Content-Type":"application/json",...(init.headers||{})
  }});
  if(!r.ok) throw new Error(`DB ${r.status}: ${(await r.text()).slice(0,300)}`);
  const text=await r.text(); return text?JSON.parse(text):null;
}
function positiveDrops(snaps:any[]){
  let sold=0;
  for(let i=1;i<snaps.length;i++){
    const prev=Number(snaps[i-1].available_stock),cur=Number(snaps[i].available_stock);
    if(Number.isFinite(prev)&&Number.isFinite(cur)&&cur<prev) sold+=prev-cur;
  }
  return sold;
}
function validDate(v:string|null){return !!v&&/^\d{4}-\d{2}-\d{2}$/.test(v);}
function dateOnly(s:any){
  return new Intl.DateTimeFormat("sv-SE",{timeZone:"Europe/Amsterdam",year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date(s));
}
function daysBetween(from:string,to:string){
  return Math.max(1,Math.round((Date.parse(to+"T12:00:00Z")-Date.parse(from+"T12:00:00Z"))/86400000)+1);
}

Deno.serve(async(req)=>{
  if(req.method==="OPTIONS") return new Response("ok",{headers:cors});
  const code=req.headers.get("x-dashboard-code")||"";
  if(await sha256(code)!==SESSION_HASH)
    return new Response(JSON.stringify({ok:false,error:"unauthorized"}),{status:401,headers:cors});

  try{
    if(req.method==="POST"){
      const body=await req.json(),action=String(body?.action||"");
      if(action==="add_target"){
        const name=String(body?.name||"").trim(),productUrl=String(body?.productUrl||"").trim();
        if(!name||!productUrl) return new Response(JSON.stringify({ok:false,error:"Naam en productURL zijn verplicht"}),{status:400,headers:cors});
        const saved=await rest("competitor_sales_targets?on_conflict=product_url",{method:"POST",headers:{"Prefer":"resolution=merge-duplicates,return=representation"},body:JSON.stringify({
          name,product_url:productUrl,bol_product_id:body?.bolProductId||null,ean:body?.ean||null,seller_name:body?.sellerName||null,
          active:true,tracking_mode:"cart_inference",updated_at:new Date().toISOString()
        })});
        return new Response(JSON.stringify({ok:true,target:saved?.[0]||null}),{headers:cors});
      }
      if(action==="record_snapshot"){
        const targetId=String(body?.targetId||""),stock=Number(body?.availableStock);
        if(!targetId||!Number.isInteger(stock)||stock<0) return new Response(JSON.stringify({ok:false,error:"Ongeldige voorraadmeting"}),{status:400,headers:cors});
        const saved=await rest("competitor_stock_snapshots",{method:"POST",headers:{"Prefer":"return=representation"},body:JSON.stringify({
          target_id:targetId,available_stock:stock,source:"cart_inference",note:body?.note||null
        })});
        return new Response(JSON.stringify({ok:true,snapshot:saved?.[0]||null}),{headers:cors});
      }
      return new Response(JSON.stringify({ok:false,error:"Onbekende actie"}),{status:400,headers:cors});
    }

    const url=new URL(req.url),qFrom=url.searchParams.get("from"),qTo=url.searchParams.get("to");
    const hasRange=validDate(qFrom)&&validDate(qTo);
    if(hasRange&&qFrom!>qTo!) return new Response(JSON.stringify({ok:false,error:"Ongeldige periode"}),{status:400,headers:cors});

    const [targets,snaps,runs]=await Promise.all([
      rest("competitor_sales_targets?select=id,name,product_url,bol_product_id,ean,seller_name,active,tracking_mode,created_at,updated_at&active=eq.true&order=created_at.asc"),
      rest("competitor_stock_snapshots?select=id,target_id,captured_at,available_stock,source,note&order=captured_at.asc&limit=5000"),
      rest("competitor_tracking_runs?select=id,started_at,finished_at,status,targets_total,successes,failures,source&order=started_at.desc&limit=1")
    ]);

    const now=Date.now(),sevenDaysAgo=now-7*86400000;
    const rows=(targets||[]).map((t:any)=>{
      const all=(snaps||[]).filter((s:any)=>s.target_id===t.id).sort((a:any,b:any)=>new Date(a.captured_at).getTime()-new Date(b.captured_at).getTime());
      const latest=all.at(-1)||null,previous=all.length>1?all.at(-2):null;
      const estimate24h=(latest&&previous&&Number(latest.available_stock)<Number(previous.available_stock))?Number(previous.available_stock)-Number(latest.available_stock):0;
      const restock24h=Boolean(latest&&previous&&Number(latest.available_stock)>Number(previous.available_stock));
      const week=all.filter((s:any)=>new Date(s.captured_at).getTime()>=sevenDaysAgo),estimate7d=positiveDrops(week);

      let rangeSnaps:any[]=[],estimateRange=0,rangeRestock=false;
      if(hasRange){
        const before=all.filter((s:any)=>dateOnly(s.captured_at)<qFrom!).at(-1);
        const within=all.filter((s:any)=>dateOnly(s.captured_at)>=qFrom!&&dateOnly(s.captured_at)<=qTo!);
        rangeSnaps=before?[before,...within]:within;
        estimateRange=positiveDrops(rangeSnaps);
        for(let i=1;i<rangeSnaps.length;i++) if(Number(rangeSnaps[i].available_stock)>Number(rangeSnaps[i-1].available_stock)) rangeRestock=true;
      }

      return {
        id:t.id,name:t.name,productUrl:t.product_url,bolProductId:t.bol_product_id,ean:t.ean,sellerName:t.seller_name,trackingMode:t.tracking_mode,
        snapshotsCount:all.length,latestStock:latest?.available_stock??null,previousStock:previous?.available_stock??null,latestCapturedAt:latest?.captured_at??null,
        estimatedSales24h:estimate24h,estimatedSales7d:estimate7d,avgSalesPerDay7d:Math.round(estimate7d/7*10)/10,restockDetected24h:restock24h,
        estimatedSalesRange:hasRange?estimateRange:null,
        avgSalesPerDayRange:hasRange?Math.round(estimateRange/daysBetween(qFrom!,qTo!)*10)/10:null,
        rangeSnapshotsCount:hasRange?rangeSnaps.length:null,
        restockDetectedRange:hasRange?rangeRestock:false
      };
    });

    return new Response(JSON.stringify({
      ok:true,selectedRange:hasRange?{from:qFrom,to:qTo,days:daysBetween(qFrom!,qTo!)}:null,
      methodology:{label:"Geschatte sales via voorraadmutatie",formula:"positieve voorraad-daling tussen metingen",caveat:"Voorraadcorrecties, retouren en aanvullingen kunnen de schatting beïnvloeden."},
      trackingStatus:(runs||[])[0]||null,
      targets:rows
    }),{headers:{...cors,"Cache-Control":"no-store"}});
  }catch(e){
    return new Response(JSON.stringify({ok:false,error:String(e)}),{status:500,headers:cors});
  }
});