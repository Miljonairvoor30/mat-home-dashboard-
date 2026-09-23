import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createRemoteJWKSet, jwtVerify } from "npm:jose@5.9.6";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const EXPECTED_REPOSITORY = "miljonairvoor30/mat-home-dashboard-";
const EXPECTED_REF = "refs/heads/main";
const EXPECTED_WORKFLOW = ".github/workflows/competitor-stock.yml";
const OIDC_AUDIENCE = "mat-home-competitor-tracker";
const GITHUB_JWKS = createRemoteJWKSet(new URL("https://token.actions.githubusercontent.com/.well-known/jwks"));

async function rest(path:string, init:RequestInit={}){
  const r=await fetch(`${SUPABASE_URL}/rest/v1/${path}`,{
    ...init,
    headers:{
      apikey:SERVICE_ROLE,
      Authorization:`Bearer ${SERVICE_ROLE}`,
      "Content-Type":"application/json",
      ...(init.headers||{})
    }
  });
  if(!r.ok) throw new Error(`DB ${r.status}: ${(await r.text()).slice(0,500)}`);
  const text=await r.text();
  return text?JSON.parse(text):null;
}

async function verifyGithub(req:Request){
  const auth=req.headers.get("authorization")||"";
  if(!auth.toLowerCase().startsWith("bearer ")) throw new Error("missing bearer token");
  const token=auth.slice(7).trim();
  const { payload }=await jwtVerify(token,GITHUB_JWKS,{
    issuer:"https://token.actions.githubusercontent.com",
    audience:OIDC_AUDIENCE
  });
  const repository=String(payload.repository||"").toLowerCase();
  const ref=String(payload.ref||"");
  const workflowRef=String(payload.workflow_ref||"").toLowerCase();
  if(repository!==EXPECTED_REPOSITORY) throw new Error("unexpected repository");
  if(ref!==EXPECTED_REF) throw new Error("unexpected ref");
  if(!workflowRef.includes(`/${EXPECTED_WORKFLOW.toLowerCase()}@`)) throw new Error("unexpected workflow");
  return payload;
}

function json(data:unknown,status=200){
  return new Response(JSON.stringify(data),{
    status,
    headers:{"Content-Type":"application/json","Cache-Control":"no-store"}
  });
}

Deno.serve(async(req)=>{
  try{
    const claims=await verifyGithub(req);

    if(req.method==="GET"){
      const targets=await rest("competitor_sales_targets?select=id,name,product_url,bol_product_id,ean,seller_name,active&active=eq.true&order=created_at.asc");
      return json({
        ok:true,
        repository:claims.repository,
        targets:(targets||[]).map((t:any)=>({
          id:t.id,
          name:t.name,
          productUrl:t.product_url,
          bolProductId:t.bol_product_id,
          ean:t.ean,
          sellerName:t.seller_name
        }))
      });
    }

    if(req.method==="POST"){
      const body=await req.json();
      if(body?.action!=="submit_run") return json({ok:false,error:"unknown action"},400);
      const startedAt=new Date(body?.startedAt||Date.now());
      const finishedAt=new Date(body?.finishedAt||Date.now());
      if(Number.isNaN(startedAt.getTime())||Number.isNaN(finishedAt.getTime())) return json({ok:false,error:"invalid timestamps"},400);

      const results=Array.isArray(body?.results)?body.results:[];
      const targetRows=await rest("competitor_sales_targets?select=id&active=eq.true");
      const allowed=new Set((targetRows||[]).map((x:any)=>String(x.id)));
      const successful:any[]=[];
      const details:any[]=[];

      for(const row of results.slice(0,100)){
        const targetId=String(row?.targetId||"");
        const stock=Number(row?.availableStock);
        const ok=allowed.has(targetId)&&Number.isInteger(stock)&&stock>=0&&stock<=10000;
        if(ok){
          successful.push({
            target_id:targetId,
            available_stock:stock,
            source:"cart_inference_auto",
            note:row?.method?String(row.method).slice(0,160):"github_actions_cart_probe"
          });
          details.push({
            targetId,
            ok:true,
            stock,
            method:String(row?.method||"").slice(0,100),
            durationMs:Number(row?.durationMs||0)
          });
        }else{
          details.push({
            targetId,
            ok:false,
            error:String(row?.error||"measurement_failed").slice(0,500),
            durationMs:Number(row?.durationMs||0)
          });
        }
      }

      if(successful.length){
        await rest("competitor_stock_snapshots",{
          method:"POST",
          headers:{Prefer:"return=minimal"},
          body:JSON.stringify(successful)
        });
      }

      const total=results.length;
      const successes=successful.length;
      const failures=Math.max(0,total-successes);
      const status=successes===total&&total>0?"success":successes>0?"partial":"failed";
      const run=await rest("competitor_tracking_runs",{
        method:"POST",
        headers:{Prefer:"return=representation"},
        body:JSON.stringify({
          started_at:startedAt.toISOString(),
          finished_at:finishedAt.toISOString(),
          source:"github_actions_cart_probe",
          status,
          targets_total:total,
          successes,
          failures,
          details
        })
      });

      return json({ok:true,status,targetsTotal:total,successes,failures,runId:run?.[0]?.id||null});
    }

    return json({ok:false,error:"method not allowed"},405);
  }catch(e){
    console.error(e);
    return json({ok:false,error:"unauthorized or invalid request"},401);
  }
});