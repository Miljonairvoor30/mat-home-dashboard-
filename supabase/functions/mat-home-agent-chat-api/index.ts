import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const SUPABASE_URL=Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE=Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const SESSION_HASH="0ec2e20ddc7228bdd348bdd256114f79e46df6044db9c0267645acebbd2a4829";

const cors={
  "Access-Control-Allow-Origin":"*",
  "Access-Control-Allow-Headers":"content-type,x-dashboard-code",
  "Access-Control-Allow-Methods":"GET,POST,OPTIONS",
  "Content-Type":"application/json"
};

async function sha256(s:string){
  const b=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(s));
  return Array.from(new Uint8Array(b)).map(x=>x.toString(16).padStart(2,"0")).join("");
}
async function db(path:string,init:RequestInit={}){
  const r=await fetch(SUPABASE_URL+"/rest/v1/"+path,{
    ...init,
    headers:{
      apikey:SERVICE_ROLE,
      Authorization:"Bearer "+SERVICE_ROLE,
      "Content-Type":"application/json",
      Prefer:"return=representation",
      ...(init.headers||{})
    }
  });
  if(!r.ok) throw new Error("DB "+r.status+" "+await r.text());
  const txt=await r.text();
  return txt?JSON.parse(txt):null;
}
function todayAmsterdam(){
  return new Intl.DateTimeFormat("sv-SE",{timeZone:"Europe/Amsterdam",year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date());
}
async function cleanup(today:string){
  await db("agent_chat_messages?chat_day=lt."+today,{method:"DELETE"});
}

Deno.serve(async(req)=>{
  if(req.method==="OPTIONS")return new Response("ok",{headers:cors});
  const code=req.headers.get("x-dashboard-code")||"";
  if(await sha256(code)!==SESSION_HASH)
    return new Response(JSON.stringify({ok:false,error:"unauthorized"}),{status:401,headers:cors});

  try{
    const today=todayAmsterdam();
    await cleanup(today);

    if(req.method==="GET"){
      const messages=await db("agent_chat_messages?select=id,role,content,created_at&chat_day=eq."+today+"&order=created_at.asc,id.asc&limit=200");
      return new Response(JSON.stringify({ok:true,day:today,messages:messages||[]}),{headers:{...cors,"Cache-Control":"no-store"}});
    }

    if(req.method==="POST"){
      const body=await req.json().catch(()=>({}));
      const action=String(body?.action||"save");

      if(action==="clear"){
        await db("agent_chat_messages?chat_day=eq."+today,{method:"DELETE"});
        return new Response(JSON.stringify({ok:true,day:today,messages:[]}),{headers:{...cors,"Cache-Control":"no-store"}});
      }

      if(action==="save"){
        const role=body?.role==="user"?"user":"agent";
        const content=String(body?.content||"").trim().slice(0,4000);
        if(!content)return new Response(JSON.stringify({ok:false,error:"Leeg bericht"}),{status:400,headers:cors});
        const rows=await db("agent_chat_messages",{
          method:"POST",
          body:JSON.stringify([{role,content,chat_day:today}])
        });
        return new Response(JSON.stringify({ok:true,day:today,message:rows?.[0]||null}),{headers:{...cors,"Cache-Control":"no-store"}});
      }

      return new Response(JSON.stringify({ok:false,error:"Onbekende actie"}),{status:400,headers:cors});
    }

    return new Response(JSON.stringify({ok:false,error:"method not allowed"}),{status:405,headers:cors});
  }catch(e){
    console.error(e);
    return new Response(JSON.stringify({ok:false,error:"Chat synchroniseren is niet gelukt"}),{status:500,headers:cors});
  }
});