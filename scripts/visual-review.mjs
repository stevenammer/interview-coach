// Optional visual QA tool; no production dependency or build step.
// Run against a local static server on port 4173. All API data below is fictional.
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
const output = process.env.VISUAL_OUTPUT_DIR || 'docs/screens';
await mkdir(output, { recursive: true });
const browser = await chromium.launch({executablePath:'/usr/bin/google-chrome',headless:true,args:['--no-sandbox']});
const errors=[];
for (const [name,width,height] of [['phone',390,844],['desktop',1440,1000]]) {
  const context=await browser.newContext({viewport:{width,height},colorScheme:'light'});
  const page=await context.newPage();
  page.on('pageerror',e=>errors.push(e.message));
  let facts=[
    {id:'f1',source_id:'r1',source_title:'Fictional resume',line_quote:'Led front-desk scheduling and trained new team members.',line_start:0,line_end:56,verbatim_quote:'Led front-desk scheduling.',domain:'candidate',status:'from_document',review_state:'accepted',lifecycle:'active'},
    {id:'f2',source_id:'r1',source_title:'Fictional resume',line_quote:'Led front-desk scheduling and trained new team members.',line_start:0,line_end:56,verbatim_quote:'Trained new team members.',domain:'candidate',status:'from_document',review_state:'pending',lifecycle:'active'},
    {id:'f3',source_id:'r1',source_title:'Fictional resume',line_quote:'Coordinated a service recovery with housekeeping.',line_start:57,line_end:106,verbatim_quote:'Coordinated a service recovery with housekeeping.',domain:'candidate',status:'user_confirmed',review_state:'accepted',lifecycle:'active'}
  ];
  const scenes=['The Monday standup','A staffing shortfall','The owner’s call','Your first 90 days'].map((title,i)=>({id:`s${i}`,day:['Monday','Tuesday','Thursday','Friday'][i],title,situation:'The front desk is busy, housekeeping is stretched, and your team needs a decision. Before you move people around, decide what you need to learn.',ask:'Where do you put your attention first?',details:[{text:'Coordinate operations across departments.',provenance:'jd'},{text:'A team lead asks for help covering the next shift.',provenance:'typical'}],choices:[{id:'c1',label:'Ask the team leads where the pressure is highest.'},{id:'c2',label:'Step onto the floor and observe the bottleneck.'}]}));
  let sceneIndex=0; const history=[];
  const immersion=()=>({id:'imm1',plan:{scenes},state:{sceneId:`s${sceneIndex}`,history,complete:sceneIndex>=4},companySources:{},debrief:{tradeoffs:['Immediate cover versus a repeatable staffing plan.'],first90Days:'Start by listening to the team and checking the operating data.',caseQuestion:'Explain the trade-off behind your first decision.'}});
  let reviewed=false;
  const report={contentScores:Object.fromEntries(['relevance','ownership','evidence','outcome','structure'].map(k=>[k,{score:3,reason:k==='evidence'?'Your scheduling decision is specific. The result needs a clearer observation or source-backed measure.':'A clear example with room for more detail.'}])),deliveryScores:{clarity:{score:4,reason:'Easy to follow.'},concision:{score:3,reason:'Lead with the decision.'}},unassessed:['Vocal delivery'],feedback:'Keep your personal decision at the center. Add only an outcome you can support.',unsupportedClaims:[],factGate:[],rewrite:{ready:true,text:'Led front-desk scheduling.'}};
  await page.route('**/api?*',async route=>{
    const op=new URL(route.request().url()).searchParams.get('op');
    const body=route.request().postDataJSON()||{};
    let result;
    switch(op){
      case 'session': return route.fulfill({json:{user:null}});
      case 'paste': result={workspace:{id:'w1'},resume:{source:{id:'r1'},dropped:[]},jd:{source:{id:'jd1'},dropped:[]},facts};break;
      case 'ledger':result=facts;break;
      case 'fact_conflicts':case 'job_hunt_history':result=[];break;
      case 'review': facts=facts.map(f=>f.id===body.factId?{...f,review_state:'accepted'}:f);result=facts;break;
      case 'workspaces':result=[{id:'w1',label:'Director of Operations · fictional demo'}];break;
      case 'requirements':result=['direct','adjacent','none'].map((category,i)=>({type:'responsibility',text:['Lead front-desk operations','Coordinate multiple departments','Own the operating budget'][i],category,competency:['Leadership','Cross-functional operations','Finance'][i],rationale:['Your scheduling work directly supports this requirement.','Service recovery connects teams; broader scope needs explanation.','No confirmed budget example is in the ledger yet.'][i],evidence_needed:['A decision and its result','Scope of the collaboration','A real budget decision'][i],start_offset:0,end_offset:40,fact_ids:i===2?[]:[i===0?'f1':'f3']}));break;
      case 'immerse_get':case 'immerse_start':result=immersion();break;
      case 'immerse_act':history.push({sceneId:`s${sceneIndex}`,consequence:'The team leads identify the pinch point. You gain context, while the queue still needs immediate cover.'});sceneIndex++;result=immersion();break;
      case 'start':result={interview:{id:'i1'},question:'Tell me about a time you had to balance guest experience with a staffing constraint. What did you personally decide?'};break;
      case 'turn':result={done:true,facts};break;
      case 'debrief':result=report;break;
      case 'drills':case 'drill_build':result={hoursUntilInterview:null,cram:false,gaps:[],cards:reviewed?[]:[{id:'d1',kind:'story',prompt:'Front-desk scheduling. Start from the decision.'},{id:'d2',kind:'intro',targetSeconds:45,prompt:'Tell me about yourself. About 45 seconds.'}]};break;
      case 'drill_review':reviewed=true;result={hitIds:['f1'],missedIds:['f2'],note:'You recalled the scheduling decision. Bring back who you trained.',due:Date.now()+86400000};break;
      default: throw Error(`Unhandled mock ${op}`);
    }
    await route.fulfill({json:{result,state:{demo:true}}});
  });
  const navigate=async route=>{
    if (width < 900) await page.locator('#rail-toggle').click();
    await page.locator(`#app-rail a[href="#/${route}"]`).click();
  };
  const shot=async screen=>{
    await page.evaluate(()=>document.fonts.ready);
    // Scroll naturally so IntersectionObserver reveals each below-the-fold card.
    for (let y=0; y < await page.evaluate(()=>document.documentElement.scrollHeight); y+=height*.75) {
      await page.evaluate(y=>scrollTo(0,y), y);
      await page.waitForTimeout(80);
    }
    await page.evaluate(()=>scrollTo(0,0));
    await page.waitForTimeout(650);
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,`${screen} ${name} overflow`);
    await page.screenshot({path:`${output}/${screen}-${name}.png`,fullPage:true});
  };
  await page.goto('http://localhost:4173');
  await page.locator('#landing').waitFor({state:'visible'});
  await shot('landing');
  await navigate('start');
  await page.getByRole('button',{name:'02 · Practice',exact:true}).click();
  await page.getByRole('heading',{name:'Put me in that moment.'}).waitFor();
  await page.keyboard.press('Tab');
  assert.ok(await page.evaluate(()=>document.activeElement.tagName==='BUTTON'));
  await navigate('story');
  await page.locator('#try-guest').click();
  await shot('setup');
  await page.locator('#job-label').fill('Fictional Director of Operations');
  await page.locator('#resume').fill('Fictional resume used only for visual QA.');
  await page.locator('#jd').fill('Fictional job description used only for visual QA.');
  await page.locator('#paste-form button[type=submit]').click();
  await page.locator('#ledger').waitFor({state:'visible'});
  await shot('story-bank');
  await page.getByRole('button',{name:'Confirm',exact:true}).click();
  await page.getByText('3 confirmed / 3 career details',{exact:true}).waitFor();
  assert.equal(await page.locator('#progress-note').isVisible(),true);
  await shot('proof-found');
  await page.locator('#open-workspaces-ledger').click();
  await page.locator('#workspaces').waitFor({state:'visible'});
  await shot('evidence-map');
  await page.locator('.hub-tile[data-go="open-immerser"]').click();
  await page.locator('#immerser').waitFor({state:'visible'});
  await shot('immerser');
  await page.locator('#immerser-response').fill('I would ask the team leads what they are seeing before reallocating coverage.');
  await page.locator('#immerser-action button[type=submit]').click();
  await page.getByRole('heading',{name:'A staffing shortfall',exact:true}).waitFor();
  await shot('immerser-next');
  await page.locator('#immerser-ledger').click();
  await page.locator('#ledger-practice').click();
  page.once('dialog', dialog=>dialog.accept());
  await page.locator('#start-interview').click();
  await page.locator('#interview').waitFor({state:'visible'});
  await shot('interview');
  await page.locator('#answer').fill('I reassigned coverage at the front desk and checked with the team afterward.');
  await page.locator('#answer-form button[type=submit]').click();
  await page.locator('#debrief').waitFor({state:'visible'});
  await shot('debrief');
  await page.locator('#review-proposals').click();
  await navigate('drills');
  await page.locator('#drills').waitFor({state:'visible'});
  await shot('practice');
  await page.getByRole('button',{name:'Flip to practice ↻'}).first().click();
  await page.locator('#drill-list textarea').first().fill('I led front-desk scheduling.');
  await page.getByRole('button',{name:'Check what I remembered',exact:true}).first().click();
  await page.getByText('Review complete',{exact:true}).waitFor();
  await shot('practice-complete');
  await page.getByRole('button',{name:'Continue with due cards'}).click();
  await page.getByText("You're caught up. Nothing is due right now.",{exact:false}).waitFor();
  await page.locator('#end-session').click();
  // Single light theme now ; the theme toggle is hidden.
  await shot('landing-end');
  await page.emulateMedia({reducedMotion:'reduce'});
  assert.equal(await page.locator('.demo-card').evaluate(e=>getComputedStyle(e).transform),'none');
  await context.close();
}
assert.deepEqual(errors,[]);
await browser.close();
console.log('Visual flows passed at 390px and 1440px; no page errors or horizontal overflow.');
