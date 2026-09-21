import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const BOL_CLIENT_ID = Deno.env.get("BOL_CLIENT_ID")!;
const BOL_CLIENT_SECRET = Deno.env.get("BOL_CLIENT_SECRET")!;

async function db(path:string, init:RequestInit={}) {
  return fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...init,
    headers:{"apikey":SERVICE_ROLE,"Authorization":`Bearer ${SERVICE_ROLE}`,"Content-Type":"application/json",...(init.headers||{})}
  });
}
async function upsert(table:string, rows:any, conflict:string) {
  const r=await db(`${table}?on_conflict=${encodeURIComponent(conflict)}`,{method:"POST",headers:{"Prefer":"resolution=merge-duplicates,return=representation"},body:JSON.stringify(rows)});
  if(!r.ok) throw new Error(`${table}: ${r.status} ${(await r.text()).slice(0,300)}`);
  return r.json();
}
async function token() {
  const r=await fetch("https://login.bol.com/token",{method:"POST",headers:{"Authorization":`Basic ${btoa(`${BOL_CLIENT_ID}:${BOL_CLIENT_SECRET}`)}`,"Accept":"application/json","Content-Type":"application/x-www-form-urlencoded","User-Agent":"MAT-Home-Dashboard/0.2"},body:"grant_type=client_credentials"});
  if(!r.ok) throw new Error(`auth ${r.status}`);
  return (await r.json()).access_token as string;
}
async function bol(url:string, accessToken:string, version=10) {
  const r=await fetch(url,{headers:{"Authorization":`Bearer ${accessToken}`,"Accept":`application/vnd.retailer.v${version}+json`,"User-Agent":"MAT-Home-Dashboard/0.2"}});
  if(!r.ok) throw new Error(`bol ${r.status} ${url} ${(await r.text()).slice(0,250)}`);
  return r.json();
}
function periodDate(p:any){
  if(!p?.year || !p?.month || !p?.day) return null;
  return `${String(Number(p.year)).padStart(4,"0")}-${String(Number(p.month)).padStart(2,"0")}-${String(Number(p.day)).padStart(2,"0")}`;
}

Deno.serve(async()=>{
  const started=new Date().toISOString();
  let records=0;
  try{
    const accessToken=await token();
    let cursor:string|null=null;
    const allOffers:any[]=[];
    for(let i=0;i<5;i++){
      const u=new URL("https://api.bol.com/retailer/offers");
      u.searchParams.set("page-size","100");
      if(cursor) u.searchParams.set("cursor",cursor);
      const page=await bol(u.toString(),accessToken,11);
      const offers=Array.isArray(page?.offers)?page.offers:[];
      allOffers.push(...offers);
      cursor=page?.page?.nextCursor||null;
      if(!cursor||offers.length===0) break;
    }

    const productByOffer=new Map<string,any>();
    for(const o of allOffers){
      const nl=(o.countryAvailabilities||[]).find((x:any)=>x.countryCode==="NL");
      const price=(o.pricing?.bundlePrices||[]).find((x:any)=>Number(x.quantity)===1)?.unitPrice ?? null;
      const row={offer_id:o.offerId,ean:o.ean??null,title:o.reference||o.unknownProductTitle||o.ean||"Bol product",variant:o.reference??null,active:Boolean(nl?.forSale)&&!o.onHoldByRetailer,current_price:price,stock:o.stock?.correctedStock??o.stock?.amount??null,fulfillment_method:o.fulfilment?.method??null,delivery_code:o.fulfilment?.schedule??null};
      const saved=await upsert("products",row,"offer_id");
      if(saved?.[0]) productByOffer.set(o.offerId,saved[0]);
      records++;
    }

    const salesByProductDate=new Map<string,{sales:number,revenue:number}>();
    for(let page=1;page<=4;page++){
      const list=await bol(`https://api.bol.com/retailer/orders?fulfilment-method=ALL&status=ALL&page=${page}`,accessToken,10);
      const orders=Array.isArray(list?.orders)?list.orders:[];
      if(!orders.length) break;
      for(const summary of orders){
        const detail=await bol(`https://api.bol.com/retailer/orders/${encodeURIComponent(summary.orderId)}`,accessToken,10);
        const items=Array.isArray(detail?.orderItems)?detail.orderItems:[];
        const total=items.reduce((s:number,x:any)=>s+Number(x.totalPrice??(Number(x.unitPrice||0)*Number(x.quantity||0))),0);
        const ord=(await upsert("orders",{bol_order_id:String(detail.orderId),ordered_at:detail.orderPlacedDateTime,status:"CURRENT",total_amount:Math.round(total*100)/100,currency:"EUR"},"bol_order_id"))?.[0];
        const date=String(detail.orderPlacedDateTime||"").slice(0,10);
        for(const item of items){
          const offerId=item.offer?.offerId??null;
          let prod=offerId?productByOffer.get(offerId):null;
          if(offerId){
            const saved=await upsert("products",{offer_id:offerId,ean:item.product?.ean??null,title:item.product?.title||item.offer?.reference||item.product?.ean||"Bol product",variant:item.offer?.reference??null,active:prod?.active??true,current_price:Number(item.unitPrice??prod?.current_price??0)||null,stock:prod?.stock??null,fulfillment_method:item.fulfilment?.method??prod?.fulfillment_method??null,delivery_code:prod?.delivery_code??null},"offer_id");
            prod=saved?.[0]||prod;
            if(prod) productByOffer.set(offerId,prod);
          }
          await upsert("order_items",{order_id:ord.id,bol_order_item_id:String(item.orderItemId),product_id:prod?.id??null,offer_id:offerId,ean:item.product?.ean??null,quantity:Number(item.quantity||1),unit_price:Number(item.unitPrice||0),status:item.quantityCancelled>0?"CANCELLED":(item.quantityShipped>0?"SHIPPED":"OPEN")},"bol_order_item_id");
          if(prod?.id&&date){
            const key=`${prod.id}|${date}`;
            const v=salesByProductDate.get(key)||{sales:0,revenue:0};
            v.sales+=Number(item.quantity||1)-Number(item.quantityCancelled||0);
            v.revenue+=Number(item.totalPrice??(Number(item.unitPrice||0)*Number(item.quantity||0)));
            salesByProductDate.set(key,v);
          }
          records++;
        }
      }
      if(orders.length<50) break;
    }

    const activeOffers=allOffers.filter((o:any)=>{const nl=(o.countryAvailabilities||[]).find((x:any)=>x.countryCode==="NL");return Boolean(nl?.forSale)&&!o.onHoldByRetailer;}).slice(0,40);
    for(const o of activeOffers){
      const prod=productByOffer.get(o.offerId);
      if(!prod) continue;
      const visitsByDate=new Map<string,number>();
      const buyBoxByDate=new Map<string,number>();
      for(const name of ["PRODUCT_VISITS","BUY_BOX_PERCENTAGE"]){
        const u=new URL("https://api.bol.com/retailer/insights/offer");
        u.searchParams.set("offer-id",o.offerId);u.searchParams.set("period","DAY");u.searchParams.set("number-of-periods","14");u.searchParams.append("name",name);
        const insight=await bol(u.toString(),accessToken,10);
        for(const block of (insight?.offerInsights||[])) for(const p of (block?.periods||[])){
          const date=periodDate(p.period);if(!date) continue;
          if(block.name==="PRODUCT_VISITS") visitsByDate.set(date,Number(p.total||0));
          if(block.name==="BUY_BOX_PERCENTAGE") buyBoxByDate.set(date,Number(p.total||0));
        }
      }
      const dates=new Set<string>([...visitsByDate.keys(),...buyBoxByDate.keys()]);
      for(const date of dates){
        const sale=salesByProductDate.get(`${prod.id}|${date}`)||{sales:0,revenue:0};
        const visits=visitsByDate.get(date)??0;
        await upsert("product_metrics",{product_id:prod.id,metric_date:date,visits,sales:sale.sales,conversion_rate:visits>0?Math.round((sale.sales/visits*100)*10000)/10000:0,revenue:Math.round(sale.revenue*100)/100,buy_box_percentage:buyBoxByDate.get(date)??null},"product_id,metric_date");
      }

      if(o.ean){
        const comp=await bol(`https://api.bol.com/retailer/products/${encodeURIComponent(o.ean)}/offers?country-code=NL&condition=NEW&page=1`,accessToken,10);
        for(const c of (comp?.offers||[])){
          if(c.offerId===o.offerId) continue;
          const competitor=(await upsert("competitors",{ean:o.ean,seller_id:String(c.retailerId??""),seller_name:c.retailerId?("Retailer "+String(c.retailerId)):null,offer_id:c.offerId,last_seen_at:new Date().toISOString()},"ean,seller_id,offer_id"))?.[0];
          if(competitor) await db("competitor_snapshots",{method:"POST",headers:{"Prefer":"return=minimal"},body:JSON.stringify({competitor_id:competitor.id,price:c.price??null,delivery_date:c.minDeliveryDate??null,is_best_offer:Boolean(c.bestOffer),availability:c.fulfilmentMethod??null})});
        }
      }
    }

    await db("sync_runs",{method:"POST",headers:{"Prefer":"return=minimal"},body:JSON.stringify({source:"bol_mvp",started_at:started,finished_at:new Date().toISOString(),status:"success",records_written:records})});
    return Response.json({ok:true,offers:allOffers.length,activeOffers:activeOffers.length,records});
  }catch(e){
    await db("sync_runs",{method:"POST",headers:{"Prefer":"return=minimal"},body:JSON.stringify({source:"bol_mvp",started_at:started,finished_at:new Date().toISOString(),status:"error",records_written:records,error_message:String(e)})}).catch(()=>{});
    return Response.json({ok:false,error:String(e)},{status:500});
  }
});
