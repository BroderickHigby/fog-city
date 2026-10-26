/// <reference types="vite/client" />
import {MISSIONS} from "../../src/content/catalog.ts";
import {uiText} from "../../src/content/ui.ts";
import {mountGameUI,gameplayCallbacks,type UiView} from "../../src/ui/index.ts";
import type {MapPoint} from "../../src/ui/types.ts";
import type {GameplayCommandEvent} from "../../src/sim/gameplay-contract.ts";
import gameShell from "../../index.html?raw";
// Exercise the production container and canvas CSS too: a broad #game canvas rule
// previously stretched the phone map while this isolated fixture stayed green.
const shellStyle=document.createElement("style");shellStyle.textContent=new DOMParser().parseFromString(gameShell,"text/html").querySelector("style")!.textContent;document.head.append(shellStyle);
const uiHost=document.querySelector<HTMLElement>("#app")!;uiHost.id="game";
const events:GameplayCommandEvent[]=[];
const waypoints:MapPoint[]=[];
const view:UiView={tick:1,playerId:"p1",x:0,z:0,heading:0,speedMps:12,runwayMonths:9,cashCents:10000,reputation:45,waterLitres:8,capacityLitres:8,salt:false,threat:2,phoneApps:["map","botBounty","botCheck"],map:{nodes:[{id:"a",x:0,z:0},{id:"b",x:50,z:0},{id:"c",x:50,z:50}],edges:[{from:"a",to:"b"},{from:"b",to:"c"}],blips:[{id:"water",kind:"water",x:30,z:30,label:"Water"},{id:"hidden",kind:"robot",x:20,z:20,label:"Hidden robot",confirmed:false}]},vendor:[{id:"nozzle",title:"Nozzle",description:"A focused stream",priceCents:500,owned:false,available:true},{id:"too-expensive",title:"Big tank",description:"More water",priceCents:100000,owned:false,available:true}],bounties:[{id:"b1",title:"Confirmed firmware",detail:"Dock robot",multiplier:2,confirmed:true}],popups:[{id:"ad1",title:"A desk with a view",detail:"The view is another desk."}]};
const form=MISSIONS.find(mission=>mission.id==="hot-desk")?.steps.find(step=>step.type==="form");
const ui=mountGameUI(uiHost,{copy:uiText,startupChoices:form?.type==="form"?form.form.multipleChoice:undefined,callbacks:{...gameplayCallbacks({playerId:"p1",tick:()=>view.tick,emit:e=>events.push(e)}),waypoint:point=>waypoints.push(point)},touch:true});ui.update(view);
Object.assign(window,{ui,events,view,waypoints});
