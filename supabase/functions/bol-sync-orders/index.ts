import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const BOL_CLIENT_ID = Deno.env.get("BOL_CLIENT_ID")!;
const BOL_CLIENT_SECRET = Deno.env.get("BOL_CLIENT_SECRET")!;

async function db(path: string, init: RequestInit = {}) {
  return fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...init,
    headers: {
      "apikey": SERVICE_ROLE,
      "Authorization": `Bearer ${SERVICE_ROLE}`,
      "Content-Type": "application/json",
      ...(init.headers || {})
    }
  });
}

Deno.serve(async () => {
  const started = new Date().toISOString();
  if (!BOL_CLIENT_ID || !BOL_CLIENT_SECRET) return Response.json({ok:false,error:"Bol credentials missing"},{status:500});

  const tokenRes = await fetch("https://login.bol.com/token", {
    method:"POST",
    headers:{
      "Authorization": `Basic ${btoa(`${BOL_CLIENT_ID}:${BOL_CLIENT_SECRET}`)}`,
      "Accept":"application/json",
      "Content-Type":"application/x-www-form-urlencoded",
      "User-Agent":"MAT-Home-Dashboard/0.1"
    },
    body:"grant_type=client_credentials"
  });
  if (!tokenRes.ok) return Response.json({ok:false,stage:"authentication",status:tokenRes.status},{status:502});

  const token = await tokenRes.json();
  let ordersSeen = 0;
  let itemsSeen = 0;

  for (let page = 1; page <= 4; page++) {
    const res = await fetch(`https://api.bol.com/retailer/orders?fulfilment-method=ALL&status=ALL&page=${page}`, {
      headers:{
        "Authorization": `Bearer ${token.access_token}`,
        "Accept":"application/vnd.retailer.v10+json",
        "User-Agent":"MAT-Home-Dashboard/0.1"
      }
    });
    if (!res.ok) return Response.json({ok:false,stage:"orders",page,status:res.status},{status:502});

    const payload = await res.json();
    const orders = Array.isArray(payload?.orders) ? payload.orders : [];
    if (orders.length === 0) break;

    for (const order of orders) {
      const orderUpsert = await db("orders?on_conflict=bol_order_id", {
        method:"POST",
        headers:{ "Prefer":"resolution=merge-duplicates,return=representation" },
        body:JSON.stringify({
          bol_order_id:String(order.orderId),
          ordered_at:order.orderPlacedDateTime,
          status:"CURRENT",
          currency:"EUR"
        })
      });
      if (!orderUpsert.ok) return Response.json({ok:false,stage:"db_order",status:orderUpsert.status},{status:500});
      const dbOrderId = (await orderUpsert.json())?.[0]?.id;
      if (!dbOrderId) return Response.json({ok:false,stage:"db_order_id"},{status:500});

      const orderItems = Array.isArray(order.orderItems) ? order.orderItems : [];
      for (const item of orderItems) {
        const itemUpsert = await db("order_items?on_conflict=bol_order_item_id", {
          method:"POST",
          headers:{ "Prefer":"resolution=merge-duplicates,return=minimal" },
          body:JSON.stringify({
            order_id:dbOrderId,
            bol_order_item_id:String(item.orderItemId),
            ean:item.ean ?? null,
            quantity:item.quantity ?? 1,
            status:item.fulfilmentStatus ?? null
          })
        });
        if (!itemUpsert.ok) return Response.json({ok:false,stage:"db_item",status:itemUpsert.status},{status:500});
        itemsSeen++;
      }
      ordersSeen++;
    }
    if (orders.length < 50) break;
  }

  await db("sync_runs", {
    method:"POST",
    headers:{ "Prefer":"return=minimal" },
    body:JSON.stringify({
      source:"bol_orders",
      started_at:started,
      finished_at:new Date().toISOString(),
      status:"success",
      records_written:itemsSeen
    })
  });

  return Response.json({ok:true,orders_seen:ordersSeen,items_seen:itemsSeen});
});
