"use strict";
const page = document.body.dataset.page, objectId = document.body.dataset.object;
const content = document.getElementById("content"), notice = document.getElementById("notice");
let currentUser, offset = 0, selectedTable = "cmdb_ci", selectedSeverity = "", pollTimer, chatHistory = [];
const esc = v => String(v ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const badge = v => '<span class="badge '+esc(String(v||"unknown").toLowerCase().replace(/[^a-z_]/g,""))+'">'+esc(v||"unknown")+'</span>';
const date = v => v ? new Date(v).toLocaleString() : "?";
const panel = (title,body,extra="") => '<section class="panel"><div class="panel-head"><h2>'+esc(title)+'</h2>'+extra+'</div>'+body+'</section>';
const table = (heads,rows) => '<div class="table-scroll"><table><thead><tr>'+heads.map(h=>'<th>'+esc(h)+'</th>').join("")+'</tr></thead><tbody>'+rows.map(r=>'<tr>'+r.map(c=>'<td>'+c+'</td>').join("")+'</tr>').join("")+'</tbody></table></div>';
const empty = text => '<div class="empty">'+esc(text)+'</div>';
const json = value => '<pre>'+esc(JSON.stringify(value,null,2))+'</pre>';
const seconds = value => {value=Number(value)||0; const m=Math.floor(value/60), s=value%60; return m?m+"m "+s+"s":s+"s";};
async function api(path, options={}) {
  const response = await fetch(path, {...options, credentials:"same-origin"});
  if(response.status===401){location.assign("/login");throw new Error("Sign in required");}
  let data; try{data=await response.json();}catch{throw new Error("Server returned an unreadable response");}
  if(!response.ok) throw new Error(typeof data.detail==="string"?data.detail:JSON.stringify(data.detail||data));
  return data;
}
function message(text,error=false){notice.innerHTML='<div class="banner '+(error?'error':'')+'">'+esc(text)+'</div>';}
function coverageRows(coverage){
 return Object.values(coverage||{}).map(c=>[esc(c.table),badge(c.status),esc(c.records??"?"),esc(c.reported_total??"?"),
 esc(c.error || (c.missing_fields?.length ? "Missing fields: "+c.missing_fields.join(", ") : c.scope || "Not requested"))]);
}
function findingRows(rows){
 return rows.map(f=>['<a href="/findings/'+esc(f.id)+'">'+esc(f.title)+'</a>',badge(f.severity),esc(f.domain),esc(Math.round(f.confidence*100)+"%")]);
}
function cards(values){return '<div class="cards">'+values.map(([label,value,hint])=>'<div class="card"><div class="label">'+esc(label)+'</div><div class="value">'+esc(value??"?")+'</div><div class="hint">'+esc(hint)+'</div></div>').join("")+'</div>';}
function progressPanel(run){
 const p=run?.manifest?.progress||{}, percent=Number(p.percent||0), eta=p.eta_seconds==null?"calculating":seconds(p.eta_seconds);
 return '<div class="live-progress"><div class="live-progress-head"><div><strong>'+esc(p.stage||run.phase||"queued")+'</strong><span>Run '+esc(String(run.id).slice(0,8))+' · '+esc(run.status)+'</span></div><div>'+esc(percent)+'%</div></div>'+
  '<div class="progress-track"><span style="width:'+esc(Math.max(0,Math.min(100,percent)))+'%"></span></div>'+
  '<div class="progress-meta"><span>Table: '+esc(p.current_table||"waiting")+'</span><span>Fetched rows: '+esc(p.fetched_rows||0)+'</span><span>Chunks: '+esc(p.stored_chunks||0)+'</span><span>Elapsed: '+esc(seconds(p.elapsed_seconds))+'</span><span>ETA: '+esc(eta)+'</span></div></div>';
}
function pct(value){return Math.max(0,Math.min(100,Number(value)||0));}
function gauge(title,score,detail,count,label,active=false){
 const p=pct(score), red=100-p;
 return '<article class="health-card '+(active?'active':'')+'"><div class="health-head"><h3>'+esc(title)+'</h3><button class="icon subtle" data-popover="'+esc(title.toLowerCase())+'" title="View calculation details">i</button></div>'+
  '<div class="health-body"><div><p>'+esc(detail)+'</p><div class="health-score">'+esc(p)+'%</div><div class="trend">0% since latest scan</div></div>'+
  '<div class="donut" style="background:conic-gradient(#28a956 0 '+p+'%, #ed1f3b '+p+'% 100%)"><span>'+esc(count)+'</span><small>'+esc(label)+'</small></div></div>'+
  '<div class="metrics-tabs"><span>Duplicate CIs</span><span>Orphan CIs</span><span>Stale CIs</span></div></article>';
}
function healthDashboard(data){
 const m=data.metrics||{}, diag=data.diagnostics||{}, chains=diag.chains||[];
 const duplicate=(chains.find(c=>c.key==="duplicate_bad_ci")||{}).score??0;
 const service=(chains.find(c=>c.key==="service_mapping")||{}).score??0;
 const discovery=(chains.find(c=>c.key==="discovery")||{}).score??0;
 const correctness=Math.round((duplicate+service+discovery)/3);
 const completeness=Math.round((Object.values(data.coverage||{}).filter(c=>c.status==="complete").length/Math.max(1,Object.keys(data.coverage||{}).length))*100);
 const compliance=Math.round((100+Math.min(100,diag.overall_score||0))/2);
 return '<div class="cmdb-toolbar"><span>Management</span><span>Health Dashboard</span></div>'+
  '<div class="view-row"><label>Class</label><select><option>Configuration Item</option></select><label>View</label><select><option>Health by diagnostic order</option></select></div>'+
  '<section class="health-section"><div class="section-title"><h2>CMDB Health for Configuration Item CIs</h2><span>Overall score '+esc(diag.overall_score??"?")+'%</span></div>'+
  '<div class="health-grid">'+
  gauge("Completeness",completeness,"Percentage of tables with complete visible REST coverage",Object.keys(data.coverage||{}).length,"tables evaluated")+
  gauge("Correctness",correctness,"Duplicate, orphan, stale and relationship diagnostic checks",m.visible_cis||0,"CIs evaluated",true)+
  gauge("Compliance",compliance,"Governance, security, integration and service mapping checks",data.open_findings,"findings evaluated")+
  '</div>'+
  '<div class="popover correctness-popover"><h3>Correctness calculation details</h3><div><strong>'+esc(duplicate)+'%</strong><small>Duplicate evaluation status</small></div><div><strong>'+esc(service)+'%</strong><small>Orphan/service mapping status</small></div><div><strong>'+esc(discovery)+'%</strong><small>Staleness/discovery status</small></div></div></section>';
}
function diagnosticChains(report){
 if(!report?.chains?.length)return panel("Diagnostic health",empty("Run live analysis to build diagnostic chains."));
 return panel("Core diagnostic order health",'<div class="diagnostic-grid">'+report.chains.map(chain=>
  '<article class="diag-card '+esc(chain.health)+'"><div class="diag-head"><div><h3>'+esc(chain.title)+'</h3><p>'+esc(chain.description)+'</p></div><strong>'+esc(chain.score)+'/100</strong></div>'+
  '<ol class="diag-steps">'+chain.steps.map(step=>
   '<li class="'+esc(step.status)+'"><span>'+esc(step.name)+'</span><small>'+badge(step.status)+' '+esc(step.table)+' · '+esc(step.finding_count)+' findings</small>'+
   (step.top_findings?.length?'<div class="diag-findings">'+step.top_findings.map(f=>'<a href="/findings/'+esc(f.id)+'">'+esc(f.title)+'</a>').join("")+'</div>':'')+
   '</li>').join("")+'</ol>'+
  '<div class="fix-choice"><button class="subtle" data-fix="ai">AI assisted draft</button><button class="subtle" data-fix="manual">Manual fix path</button></div></article>').join("")+'</div>'+
  '<p class="small muted">Overall diagnostic health: '+esc(report.overall_score??"?")+'/100 · GPT: '+esc(report.llm?.status||"unknown")+' · Source: stored ServiceNow database chunks</p>');
}
const descriptions = {
 dashboard:["Estate overview","A clear view of your ServiceNow estate, grounded in extracted records."],
 cmdb:["CMDB overview","Versioned CI quality and relationship evidence."],
 itom:["Operations overview","Operational findings derived from accessible ServiceNow tables."],
 findings:["Findings","Deterministic findings with traceable source records and rule versions."],
 estate:["Estate explorer","Browse the records in your latest live extraction."],
 remediation:["Remediation guides","Evidence and prerequisites for a human-reviewed change."],
 agents:["Analysis runs","Extraction progress, coverage, reproducibility and run history."],
 audit:["Audit trail","Recorded user actions and analysis outcomes."],
 settings:["Connection & settings","ServiceNow REST configuration and table access."],
 finding:["Finding evidence","Inspect the exact source values behind this finding."],
 plan:["Remediation guide","Review the snapshot, affected records and validation criteria."],
 executions:["Target access","This release operates with read-only ServiceNow access."]
};

function ensureModal(){
 let modal=document.getElementById("fix-modal");
 if(modal)return modal;
 modal=document.createElement("div");
 modal.id="fix-modal";
 modal.className="modal-backdrop";
 modal.innerHTML='<div class="modal-card" role="dialog" aria-modal="true" aria-labelledby="fix-modal-title"><button class="modal-close subtle" aria-label="Close">?</button><div id="fix-modal-content"></div></div>';
 document.body.appendChild(modal);
 modal.querySelector(".modal-close").onclick=closeModal;
 modal.onclick=e=>{if(e.target===modal)closeModal();};
 return modal;
}
function openModal(html){
 const modal=ensureModal();
 modal.querySelector("#fix-modal-content").innerHTML=html;
 modal.classList.add("open");
}
function closeModal(){const modal=document.getElementById("fix-modal"); if(modal)modal.classList.remove("open");}
function decisionHtml(title,result,actions=""){
 const d=result.decision||{}, steps=d.steps||[], validation=d.validation||[], risks=d.risks||[];
 return '<h2 id="fix-modal-title">'+esc(title)+'</h2><p class="muted">'+esc(result.message||"")+'</p>'+
  (d.llm_error?'<div class="banner warning">GPT response unavailable right now, showing stored fallback plan. '+esc(d.llm_error)+'</div>':'')+
  '<div class="decision-grid"><div><h3>Problem</h3><p>'+esc(d.problem||"Problem details unavailable.")+'</p></div><div><h3>Solution</h3><p>'+esc(d.solution||"Solution details unavailable.")+'</p></div></div>'+
  '<h3>Fix steps</h3><ol class="fix-steps">'+(steps.length?steps.map(s=>'<li><strong>'+esc(s.title||"Step")+'</strong><span>'+esc(s.detail||"")+'</span></li>').join(""):'<li><strong>Review</strong><span>No generated steps returned.</span></li>')+'</ol>'+
  '<div class="decision-grid"><div><h3>Validation</h3><ul>'+validation.map(x=>'<li>'+esc(x)+'</li>').join("")+'</ul></div><div><h3>Risk guardrails</h3><ul>'+risks.map(x=>'<li>'+esc(x)+'</li>').join("")+'</ul></div></div>'+
  '<p class="small muted">Generated by '+esc(d.model||"gpt-oss:120b-cloud")+' ? Source: '+esc(d.source||"stored plan")+'</p>'+actions;
}
async function showFixDecision(id,mode){
 openModal('<h2 id="fix-modal-title">Preparing '+esc(mode)+' fix...</h2><p class="muted">gpt-oss:120b-cloud is generating problem, solution and steps.</p>');
 try{
  const result=await api("/api/remediation/"+encodeURIComponent(id)+"/mode/"+mode,{method:"POST"});
  if(mode==="ai"){
   openModal(decisionHtml("AI fix",result,'<div class="fix-choice"><button id="execute-ai-fix">Run automatic ServiceNow fix</button><button class="subtle" id="close-fix-modal">Review only</button></div><div id="execute-result"></div>'));
   document.getElementById("close-fix-modal").onclick=closeModal;
   document.getElementById("execute-ai-fix").onclick=()=>executeAiFix(id);
  }else{
   openModal(decisionHtml("Manual fix plan",result,'<div class="fix-choice"><button class="subtle" id="close-fix-modal">Close</button></div>'));
   document.getElementById("close-fix-modal").onclick=closeModal;
  }
  const out=document.getElementById("fix-mode-result"); if(out)out.textContent=result.message;
 }catch(e){openModal('<h2 id="fix-modal-title">Fix plan unavailable</h2><div class="banner error">'+esc(e.message)+'</div>');}
}
async function executeAiFix(id){
 const target=document.getElementById("execute-result"), btn=document.getElementById("execute-ai-fix");
 if(btn)btn.disabled=true;
 target.innerHTML='<div class="banner">Sending AI fix request to ServiceNow Table REST API...</div>';
 try{
  const result=await api("/api/remediation/"+encodeURIComponent(id)+"/execute",{method:"POST"});
  target.innerHTML='<div class="banner">'+esc(result.message||"AI fix request sent to ServiceNow.")+'</div>'+json(result);
 }catch(e){target.innerHTML='<div class="banner error">'+esc(e.message)+'</div>';}
 finally{if(btn)btn.disabled=false;}
}

async function dashboard(){
 const [data,runsData]=await Promise.all([api("/api/dashboard/summary"), api("/api/analysis/runs?limit=5")]), m=data.metrics||{};
 const active=(runsData.runs||[]).find(r=>["queued","running"].includes(r.status)&&(!data.source_instance||r.source_instance===data.source_instance)) || (runsData.runs||[]).find(r=>["queued","running"].includes(r.status));
 const recentFailed=(runsData.runs||[]).find(r=>r.status==="failed"&&(!data.source_instance||r.source_instance===data.source_instance));
 if(data.status==="not_scanned"){
  content.innerHTML=(active?progressPanel(active):"")+(recentFailed?'<div class="banner error">Latest extraction failed: '+esc(recentFailed.error||recentFailed.phase)+'</div>':"")+cards([["Visible CIs",null,"Awaiting first extraction"],["Findings",null,"No analysis yet"],["CMDB quality",null,"Not assessed"],["Review guides",null,"No plans yet"]])+panel("Connect your estate",empty("Run live analysis to extract ServiceNow tables. No sample records or scores are displayed."));
  clearTimeout(pollTimer); if(active)pollTimer=setTimeout(load,3000);
  return;
 }
 content.innerHTML=(active?progressPanel(active):"")+(recentFailed?'<div class="banner error">Latest extraction failed: '+esc(recentFailed.error||recentFailed.phase)+'</div>':"")+'<div class="banner '+(data.status==="partial"?"warning":"")+'">'+esc(data.narrative)+' <strong>'+esc(data.status.toUpperCase())+'</strong><br><span class="small">Snapshot collected '+esc(date(data.completed_at))+' ? '+esc(data.source_instance)+'</span></div>'+
 healthDashboard(data)+
 cards([["Visible CIs",m.visible_cis,"In this extraction"],["Stored DB chunks",m.stored_chunks?.chunk_count,"Analyzer input"],["Findings",data.open_findings,"Latest snapshot"],["Health score",data.diagnostics?.overall_score,"Diagnostic order"],["Fix plans",data.ai_plans,"Manual or AI draft"]])+
 diagnosticChains(data.diagnostics)+
 '<div class="split">'+panel("Findings by domain",'<div class="panel-body">'+Object.entries(data.domain_breakdown||{}).map(([key,value])=>'<div class="bar-row"><div class="bar-label"><span>'+esc(key)+'</span><strong>'+esc(value)+'</strong></div><meter min="0" max="'+esc(data.open_findings||1)+'" value="'+esc(value)+'">'+esc(value)+'</meter></div>').join("")+'</div>')+
 panel("Evidence & coverage",'<div class="panel-body"><p class="muted">'+esc(m.score_definition)+'</p><p>Accessible tables: <strong>'+Object.values(data.coverage||{}).filter(c=>c.records!==null&&c.records!==undefined).length+'</strong></p><p>Stored rows: <strong>'+esc(m.stored_chunks?.record_count??"?")+'</strong> across '+esc(m.stored_chunks?.chunk_count??"?")+' chunks</p><p>AI explanation: '+badge(data.llm?.status)+'</p><a href="/agents">Inspect run manifest ?</a></div>')+'</div>'+
 panel("Priority findings",data.recent_findings.length?table(["Finding","Severity","Domain","Confidence"],findingRows(data.recent_findings)):empty("No rules triggered in the assessed scope."),'<a href="/findings">View all ?</a>')+
 panel("Table coverage",table(["Table","Status","Fetched","Reported total","Coverage note"],coverageRows(data.coverage)));
 for(const b of document.querySelectorAll("[data-fix='ai']"))b.onclick=()=>location.assign("/remediation");
 for(const b of document.querySelectorAll("[data-fix='manual']"))b.onclick=()=>location.assign("/remediation");
 clearTimeout(pollTimer); if(active)pollTimer=setTimeout(load,3000);
}
async function findings(){
 const data=await api("/api/findings?limit=50&offset="+offset+(selectedSeverity?"&severity="+selectedSeverity:""));
 content.innerHTML='<div class="toolbar"><label for="severity">Severity</label><select id="severity"><option value="">All severities</option>'+["CRITICAL","HIGH","MEDIUM","LOW","INFO"].map(s=>'<option '+(selectedSeverity===s?'selected ':'')+'value="'+s+'">'+s+'</option>').join("")+'</select><span class="count">'+data.total+' findings</span></div>'+
 panel("Finding register",data.findings.length?table(["Finding","Severity","Domain","Confidence"],findingRows(data.findings)):empty("No findings for this snapshot and filter."))+
 '<div class="toolbar"><button class="subtle" id="prev" '+(offset===0?"disabled":"")+'>Previous</button><span>'+esc(offset+1)+'?'+esc(Math.min(offset+50,data.total))+'</span><button class="subtle" id="next" '+(offset+50>=data.total?"disabled":"")+'>Next</button></div>';
 document.getElementById("severity").onchange=e=>{selectedSeverity=e.target.value;offset=0;load();};
 document.getElementById("prev").onclick=()=>{offset=Math.max(0,offset-50);load();};
 document.getElementById("next").onclick=()=>{offset+=50;load();};
}
async function finding(){
 const f=await api("/api/findings/"+encodeURIComponent(objectId));
 document.getElementById("page-title").textContent=f.title;
 content.innerHTML=cards([["Severity",f.severity,f.rule_id],["Confidence",Math.round(f.confidence*100)+"%","Computed by rule"],["Reachable CIs",f.affected_ci_ids.length,"Within three graph hops"],["Reachable services",f.affected_service_ids.length,"Topology reachability"]])+
 panel("Rule explanation",'<div class="panel-body"><p>'+esc(f.description)+'</p><p class="small muted">Snapshot '+esc(f.snapshot_id)+' ? Rule pack '+esc(f.rule_pack_version)+'</p><p>'+esc(f.ai_recommendation)+'</p>'+(f.ai_summary?'<h3>AI explanation</h3><p>'+esc(f.ai_summary)+'</p>':"")+'</div>')+
 panel("Source evidence",table(["Table","Source record","Field","Observed value","Collected"],f.evidence.map(e=>[esc(e.sn_table),'<span class="mono">'+esc(e.sn_sys_id)+'</span>',esc(e.field_name),esc(e.field_value),esc(date(e.collected_at))])))+
 panel("Attached remediation guides",'<div class="panel-body">'+f.remediation_plans.map(p=>'<p><a href="/remediation/'+esc(p.id)+'">'+esc(p.title)+'</a> '+badge(p.status)+'</p>').join("")+'</div>');
}
async function estate(){
 const config=await api("/api/connection"), data=await api("/api/estate/records?table="+encodeURIComponent(selectedTable)+"&offset="+offset);
 const fields=[...new Set(data.records.flatMap(r=>Object.keys(r)))];
 content.innerHTML='<div class="toolbar"><label for="table-select">ServiceNow table</label><select id="table-select">'+config.tables.map(t=>'<option value="'+esc(t.table)+'" '+(t.table===selectedTable?"selected":"")+'>'+esc(t.table)+'</option>').join("")+'</select>'+badge(data.coverage?.status||"not_scanned")+'<span class="count">'+esc(data.coverage?.records??"?")+' records fetched</span></div>'+
 (data.coverage?.error?'<div class="banner warning">'+esc(data.coverage.error)+'</div>':"")+
 panel(selectedTable,data.records.length?table(fields,data.records.map(r=>fields.map(f=>esc(r[f])))):empty("No visible records for this table. Check run coverage for permissions or extraction errors."))+
 '<div class="toolbar"><button class="subtle" id="prev" '+(offset===0?"disabled":"")+'>Previous</button><span>Offset '+offset+'</span><button class="subtle" id="next" '+(data.records.length<50?"disabled":"")+'>Next</button></div>';
 document.getElementById("table-select").onchange=e=>{selectedTable=e.target.value;offset=0;load();};
 document.getElementById("prev").onclick=()=>{offset=Math.max(0,offset-50);load();};
 document.getElementById("next").onclick=()=>{offset+=50;load();};
}
async function runs(){
 const data=await api("/api/analysis/runs");
 const active=data.runs.find(r=>["queued","running"].includes(r.status));
 if(active)message("Run "+active.id.slice(0,8)+" ? "+active.phase+". Queued runs require the analysis worker.");
 content.innerHTML=panel("Extraction history",data.runs.length?table(["Run","Status","Phase","Findings","Created","Actions"],data.runs.map(r=>[
 '<button class="subtle inspect" data-id="'+esc(r.id)+'">'+esc(r.id.slice(0,8))+'</button>',badge(r.status),esc(r.phase),
 esc(r.manifest.findings_stored??"?"),esc(date(r.created_at)),
 '<button class="subtle download" data-id="'+esc(r.id)+'">Manifest</button>'+(["queued","running"].includes(r.status)&&currentUser.can_execute?' <button class="subtle cancel" data-id="'+esc(r.id)+'">Cancel</button>':"")
 ])):empty("No analysis runs. Start a live extraction."))+(active?progressPanel(active):"")+'<div id="run-detail"></div>';
 for(const b of document.querySelectorAll(".inspect")) b.onclick=async()=>{try{
  const run=await api("/api/analysis/runs/"+b.dataset.id);
  const chunks=await api("/api/analysis/runs/"+b.dataset.id+"/chunks");
  document.getElementById("run-detail").innerHTML=panel("Run "+run.id,
    '<div class="panel-body">'+(run.error?'<div class="banner error">'+esc(run.error)+'</div>':"")+'<p>'+esc(run.manifest.narrative||run.phase)+'</p></div>'+
    table(["Table","Status","Fetched","Reported","Note"],coverageRows(run.manifest.coverage))+
    table(["Chunk table","Sequence","Rows","Hash","Status"],chunks.chunks.map(c=>[esc(c.table),esc(c.sequence),esc(c.record_count),'<span class="mono">'+esc(c.record_hash.slice(0,16))+'</span>',badge(c.coverage_status)]))+
    '<div class="panel-body"><details><summary>Full reproducibility manifest</summary>'+json(run.manifest)+'</details></div>');
 }catch(e){message(e.message,true);}};
 for(const b of document.querySelectorAll(".download")) b.onclick=()=>download(b.dataset.id);
 for(const b of document.querySelectorAll(".cancel")) b.onclick=async()=>{try{await api("/api/analysis/runs/"+b.dataset.id+"/cancel",{method:"POST"});load();}catch(e){message(e.message,true);}};
 clearTimeout(pollTimer); if(active)pollTimer=setTimeout(load,4000);
}
async function download(id){
 try{const data=await api("/api/analysis/runs/"+id+"/report");const url=URL.createObjectURL(new Blob([JSON.stringify(data,null,2)],{type:"application/json"}));const a=document.createElement("a");a.href=url;a.download="saos-"+id+".json";a.click();URL.revokeObjectURL(url);}catch(e){message(e.message,true);}
}
async function remediation(){
 const data=await api("/api/remediation");
 content.innerHTML='<div class="banner">Each finding has a review guide. ServiceNow writes are disabled; proposed changes require a customer decision and change process.</div>'+
 panel("Remediation center",data.plans.length?table(["Guide","Priority","Risk","Status","Targets"],data.plans.map(p=>['<a href="/remediation/'+esc(p.id)+'">'+esc(p.title)+'</a>',esc(p.priority),badge(p.risk),badge(p.status),esc(p.target_ids.length)])):empty("No remediation guides yet. Run live analysis first."));
}
async function plan(){
 const p=await api("/api/remediation/"+encodeURIComponent(objectId));
 document.getElementById("page-title").textContent=p.title;
 content.innerHTML='<div class="banner">Choose manual fix to review GPT-generated steps, or AI fix to create/update records in ServiceNow through the Table REST API.</div>'+
 panel("Fix decision",'<div class="panel-body"><div class="fix-choice"><button id="ai-mode">AI fix in ServiceNow</button><button id="manual-mode" class="subtle">Manual fix plan</button></div><p id="fix-mode-result" class="muted"></p></div>')+
 panel("Review steps",'<div class="panel-body"><p>'+esc(p.description)+'</p><h3>Prerequisites</h3><ul>'+p.prerequisites.map(x=>'<li>'+esc(x)+'</li>').join("")+'</ul><h3>Implementation</h3><ol>'+p.implementation_steps.map(x=>'<li>'+esc(x)+'</li>').join("")+'</ol><h3>Validation</h3><ul>'+p.validation_criteria.map(x=>'<li>'+esc(x)+'</li>').join("")+'</ul><p class="small muted">Plan integrity SHA-256: '+esc(p.plan_hash)+'</p></div>')+
 panel("Extracted before state",'<div class="panel-body">'+json(p.before_state)+'</div>')+
 panel("Decision & related records",'<div class="panel-body">'+json(p.proposed_state)+'</div>');
 document.getElementById("ai-mode").onclick=()=>showFixDecision(p.id,"ai");
 document.getElementById("manual-mode").onclick=()=>showFixDecision(p.id,"manual");
}
async function audit(){
 const data=await api("/api/audit");
 content.innerHTML=panel("Audit events",data.events.length?table(["When","Event","Action","Object"],data.events.map(e=>[esc(date(e.timestamp)),esc(e.event_type),esc(e.action),esc(e.object_id)])):empty("No audit events."));
}
async function settingsPage(){
 const c=await api("/api/connection");
 content.innerHTML=panel("ServiceNow connection",'<div class="panel-body"><p>Instance: <strong>'+esc(c.instance||"Not configured")+'</strong></p><p>Authentication: '+esc(c.auth_type)+' ? '+badge(c.configured?"configured":"missing")+'</p><p>Mode: live Table REST API ? Writes: disabled</p><p>Page size: '+esc(c.page_size)+' ? Per-table extraction limit: '+esc(c.max_records_per_table)+'</p><p>AI explanation: '+esc(c.llm_enabled?c.model:"Disabled ? deterministic analysis remains available")+'</p><p class="muted">Configure credentials in the server environment or secret manager. Restart the app and worker after configuration changes.</p>'+(currentUser.can_execute?'<button id="test-connection">Test live connection</button>':"")+'</div>')+
 panel("Table allow-list",table(["Table","Required","Enabled","Requested fields"],c.tables.map(t=>[esc(t.table),esc(t.required?"Yes":"Optional"),esc(t.enabled?"Yes":"No"),esc(t.fields.join(", "))])));
 const b=document.getElementById("test-connection");if(b)b.onclick=async()=>{b.disabled=true;try{const d=await api("/api/connection/test",{method:"POST"});message("ServiceNow connection verified. Table: "+d.table);}catch(e){message(e.message,true);}finally{b.disabled=false;}};
}
async function load(){
 try{
  if(["dashboard","cmdb","itom"].includes(page))await dashboard();
  else if(page==="findings")await findings();
  else if(page==="finding")await finding();
  else if(page==="estate")await estate();
  else if(page==="agents")await runs();
  else if(page==="remediation")await remediation();
  else if(page==="plan")await plan();
  else if(page==="audit")await audit();
  else if(page==="settings")await settingsPage();
  else content.innerHTML=panel("Read-only target access",empty("Review remediation guides and apply changes through your ServiceNow change process."));
 }catch(e){message(e.message,true);content.innerHTML=empty("Unable to load this view. Check the error above and retry.");}
 finally{content.setAttribute("aria-busy","false");}
}

function renderChat(){
 if(document.getElementById("saos-chat"))return;
 const box=document.createElement("aside");
 box.id="saos-chat";
 box.className="chat-widget";
 box.innerHTML='<button id="chat-toggle" aria-label="Open analysis chat">Chat</button><div class="chat-panel" aria-live="polite"><div class="chat-head"><div><strong>Analysis Chat</strong><span>English | live ServiceNow context | gpt-oss:120b-cloud</span></div><button class="subtle" id="chat-close">Close</button></div><div class="chat-quick"><button data-q="Show the current run progress">Run progress</button><button data-q="Why is the CMDB health score low?">Health reason</button><button data-q="Show incidents">Incidents</button><button data-q="Show problems">Problems</button><button data-q="Show changes">Changes</button></div><div id="chat-messages" class="chat-messages"><div class="chat-msg assistant">Ask me about CMDB health, ITOM issues, extraction progress, remediation plans, or ServiceNow records. You can also ask me to create or show incidents, problems, and changes.</div></div><form id="chat-form"><input id="chat-input" autocomplete="off" placeholder="Ask or create: incident, problem, change..."><button type="submit">Send</button></form></div>';
 document.body.appendChild(box);
 document.getElementById("chat-toggle").onclick=()=>box.classList.toggle("open");
 document.getElementById("chat-close").onclick=()=>box.classList.remove("open");
 document.getElementById("chat-form").onsubmit=e=>{e.preventDefault(); sendChat(document.getElementById("chat-input").value);};
 for(const b of box.querySelectorAll(".chat-quick button"))b.onclick=()=>sendChat(b.dataset.q);
}
function addChat(role,text,loading=false){
 const wrap=document.getElementById("chat-messages"); if(!wrap)return null;
 const div=document.createElement("div"); div.className="chat-msg "+role+(loading?" loading":""); div.textContent=text; wrap.appendChild(div); wrap.scrollTop=wrap.scrollHeight; return div;
}
async function sendChat(text){
 const input=document.getElementById("chat-input"), msg=String(text||"").trim();
 if(!msg)return;
 const widget=document.getElementById("saos-chat"); if(widget)widget.classList.add("open");
 if(input){input.value=""; input.focus();}
 addChat("user",msg);
 chatHistory.push({role:"user",content:msg});
 const loading=addChat("assistant","Checking the latest stored ServiceNow data...",true);
 try{
  const result=await api("/api/chat",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({message:msg,history:chatHistory.slice(-8),page,object_id:objectId})});
  loading.classList.remove("loading"); loading.textContent=result.answer;
  if(result.source==="deterministic_fallback")loading.dataset.source="fallback";
  chatHistory.push({role:"assistant",content:result.answer});
 }catch(e){
  loading.classList.remove("loading"); loading.classList.add("error"); loading.textContent=e.message;
 }
}

async function init(){
 try{
  currentUser=await api("/api/auth/me");
  renderChat();
  document.getElementById("user-name").textContent=currentUser.full_name+" ? "+currentUser.role;
  const d=descriptions[page]||descriptions.dashboard;
  document.getElementById("page-title").textContent=d[0];document.getElementById("breadcrumb").textContent=d[0];document.getElementById("page-description").textContent=d[1];
  for(const a of document.querySelectorAll("nav a"))if(a.pathname==="/"+page)a.classList.add("active");
  document.getElementById("logout").onclick=async()=>{await api("/api/auth/logout",{method:"POST"});location.assign("/login");};
  const start=document.getElementById("start-run");start.hidden=!currentUser.can_execute;
  start.onclick=async()=>{start.disabled=true;try{const result=await api("/api/agents/runs/start",{method:"POST"});message("Run "+result.run_id+" queued. Progress will update here while the worker processes it.");await load();}catch(e){message(e.message,true);}finally{start.disabled=false;}};
  await load();
 }catch(e){message(e.message,true);}
}
init();
