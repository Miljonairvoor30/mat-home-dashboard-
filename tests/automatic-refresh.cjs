const fs=require('fs'),vm=require('vm'),assert=require('assert/strict');
const els=new Map(),timers=[],requests=[],storage=new Map();
function element(id){if(!els.has(id))els.set(id,{value:'',textContent:'',innerHTML:'',disabled:false,classList:{add(){},remove(){},toggle(){}},addEventListener(){}});return els.get(id)}
const document={hidden:false,getElementById:element,querySelector:s=>s==='.snapshot input:focus'?null:element(s),querySelectorAll:()=>[],addEventListener(){}};
const fixture={ok:true,today:'2026-09-28',kpis:{latestMetricDate:'2026-09-27'},products:[],ordersSeries:[],lastSync:{status:'success',finished_at:new Date().toISOString()},productPerformanceDate:'2026-09-27'};
let fail=false,hold=null;
const context={window:{MAT_HOME_CONFIG:{dashboardApi:'https://example.test/api'}},document,localStorage:{getItem:k=>storage.get(k)||null,setItem:(k,v)=>storage.set(k,v),removeItem:k=>storage.delete(k)},Intl,Date,URL,Map,Set,console,alert:()=>{},setTimeout:()=>0,setInterval:(fn,ms)=>timers.push({fn,ms}),fetch:async url=>{requests.push(url);if(hold)await hold;if(fail)throw Error('network');const u=new URL(url);return {ok:true,status:200,json:async()=>({...fixture,selectedRange:u.searchParams.has('from')?{from:u.searchParams.get('from'),to:u.searchParams.get('to')}:undefined})}}};
let source=fs.readFileSync('frontend/app.js','utf8').replace(/\}\)\(\);\s*$/,'window.test={loadInitial,applyOverview,applyProducts,refreshVisibleData};})();');
vm.runInNewContext(source,context);storage.set('mh_code','test');
(async()=>{
 await context.window.test.loadInitial();
 element('overviewPreset').value='custom';element('overviewFrom').value='2026-09-01';element('overviewTo').value='2026-09-03';await context.window.test.applyOverview();
 element('productPreset').value='custom';element('productFrom').value='2026-09-10';element('productTo').value='2026-09-12';await context.window.test.applyProducts();
 requests.length=0;await context.window.test.loadInitial();
 assert.equal(requests.length,3);assert(requests.some(x=>x.includes('from=2026-09-01&to=2026-09-03')));assert(requests.some(x=>x.includes('from=2026-09-10&to=2026-09-12')));
 assert.equal(timers.length,1);assert.equal(timers[0].ms,60000);
 document.hidden=true;requests.length=0;timers[0].fn();assert.equal(requests.length,0);document.hidden=false;
 let release;hold=new Promise(r=>release=r);const a=context.window.test.loadInitial();await context.window.test.loadInitial();assert.equal(requests.length,1);release();await a;hold=null;
 const previous=element('productPerformanceTitle').textContent;fail=true;await context.window.test.loadInitial();assert.equal(element('productPerformanceTitle').textContent,previous);assert(element('statusBanner').textContent.includes('proberen het opnieuw'));fail=false;
 storage.clear();requests.length=0;timers[0].fn();assert.equal(requests.length,0);
 console.log('PASS: automatic refresh, independent date filters, hidden tab, overlap prevention, network recovery, logged-out state');
})().catch(e=>{console.error(e);process.exitCode=1});
