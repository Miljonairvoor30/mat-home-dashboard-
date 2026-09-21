import "jsr:@supabase/functions-js/edge-runtime.d.ts";

Deno.serve(async () => {
  const clientId = Deno.env.get("BOL_CLIENT_ID");
  const clientSecret = Deno.env.get("BOL_CLIENT_SECRET");
  if (!clientId || !clientSecret) {
    return Response.json({ ok:false, stage:"config" }, { status:500 });
  }
  const tokenResponse = await fetch("https://login.bol.com/token", {
    method:"POST",
    headers:{
      "Authorization": `Basic ${btoa(`${clientId}:${clientSecret}`)}`,
      "Accept":"application/json",
      "Content-Type":"application/x-www-form-urlencoded",
      "User-Agent":"MAT-Home-Dashboard/0.1"
    },
    body:"grant_type=client_credentials"
  });
  if (!tokenResponse.ok) return Response.json({ok:false,stage:"authentication",status:tokenResponse.status},{status:502});
  const token = await tokenResponse.json();
  const ordersResponse = await fetch("https://api.bol.com/retailer/orders?fulfilment-method=ALL&status=ALL&page=1",{
    headers:{
      "Authorization":`Bearer ${token.access_token}`,
      "Accept":"application/vnd.retailer.v10+json",
      "User-Agent":"MAT-Home-Dashboard/0.1"
    }
  });
  if (!ordersResponse.ok) return Response.json({ok:false,stage:"orders",status:ordersResponse.status},{status:502});
  const data = await ordersResponse.json();
  const orders = Array.isArray(data?.orders) ? data.orders : [];
  return Response.json({ok:true,authenticated:true,orders_endpoint:true,orders_on_first_page:orders.length});
});
