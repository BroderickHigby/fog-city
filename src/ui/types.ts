import type { LoadoutView } from "./loadout.ts";
import type { SimInput } from "../sim/contract.ts";
import type { Keyboard } from "../input/keyboard.ts";
import type { SavePanelOptions } from "./save-panel.ts";
import type { RoadGraph } from "../render/types.ts";
import type { TileCollider } from "../sim/world.ts";
import type { BoundaryFile } from "../sim/boundary.ts";

/** Presentation snapshots are supplied by the owning simulation lanes. */
export interface MapPoint { readonly x:number; readonly z:number }
export interface MapNode extends MapPoint { readonly id:string }
export interface MapEdge {
  readonly from:string; readonly to:string; readonly length?:number;
  readonly id?:string; readonly name?:string; readonly widthM?:number; readonly kind?:string;
  /** Source polyline reference; reversed describes the directed return edge without copying vertices. */
  readonly points?:readonly (readonly [number,number])[]; readonly reversed?:boolean;
}
/** Immutable references to the same SF geography already loaded for the city. */
export interface MapGeography {
  readonly tiles:readonly TileCollider[]; readonly roads:RoadGraph|null;
  readonly boundary:BoundaryFile|null; readonly districts?:unknown;
  readonly landmarks?:readonly MapBlip[];
  readonly inlandWater?:readonly (readonly (readonly [number,number])[])[];
}
export interface MapBlip extends MapPoint { readonly id:string; readonly kind:"water"|"mission"|"safehouse"|"bounty"|"wash"|"robot"|"landmark"; readonly label:string; readonly confirmed?:boolean }
export interface MapView {
  readonly geography?:MapGeography;
  readonly nodes:readonly MapNode[];
  /** Every edge is directed; a two-way street is represented by two edges. */
  readonly edges:readonly MapEdge[];
  readonly blips:readonly MapBlip[];
  readonly waypoint?:MapPoint;
  readonly radius?:number;
}
export interface VendorView { readonly id:string; readonly title:string; readonly description:string; readonly priceCents:number; readonly owned:boolean; readonly available:boolean; readonly reason?:string }
export interface BountyView { readonly id:string; readonly title:string; readonly detail:string; readonly multiplier:number; readonly confirmed:boolean }
export interface ObjectiveView { readonly id:string; readonly title:string; readonly detail:string; readonly remainingTicks?:number; readonly complete?:boolean }
export interface PopupView { readonly id:string; readonly title:string; readonly detail:string }
export interface ScanView { readonly targetId:string; readonly bad:boolean; readonly confidence:number }
export interface InteractionView { readonly id:string;readonly title:string;readonly detail:string;readonly startup?:boolean;readonly choices:readonly {readonly id:string;readonly label:string}[] }
/** One Runway Run toast: `kind` picks the copy, `name`/`firm` the investor, `amount` dollars, `seconds` the runway change. */
export interface RunwayNoteView { readonly id:number; readonly kind:"pickup"|"check"|"downRound"|"scandal"|"over"; readonly name:string; readonly firm:string; readonly amount:number; readonly seconds:number }
/** Runway Run (src/ui/runway.ts). "idle": no run. `canStart`: at the wheel of a car and no run is going. */
export interface RunwayView {
  readonly phase:"idle"|"running"|"over";
  readonly canStart:boolean;
  /** An online match is on (set by the game, not the sim): runs open after it. */
  readonly inMatch?:boolean;
  readonly runwayS:number;
  readonly raised:number;
  readonly hype:number;
  readonly closed:number;
  readonly best:number;
  readonly stage:string;
  readonly carrying:boolean;
  readonly investor?:{readonly name:string;readonly firm:string};
  readonly target?:MapPoint;
  /** Straight-line metres to the target, and the turn from the car's heading to it (radians, + = right). */
  readonly targetM?:number;
  readonly targetTurn?:number;
  readonly notes:readonly RunwayNoteView[];
}
export type PhoneApp="runwayRun"|"taxi"|"loadout"|"map"|"botBounty"|"botCheck"|"ride"|"radio"|"fogcast"|"messages"|"bank"|"playlists"|"settings"|"officeHours";
export interface UiView {
  readonly loadout?:LoadoutView;
  readonly tick:number;
  readonly playerId:string;
  readonly x:number;
  readonly z:number;
  readonly heading:number;
  readonly speedMps:number;
  /** Presentation only; the simulation continues to own movement and vehicle control. */
  readonly travelMode?:"vehicle"|"foot";
  readonly streetName?:string;
  /** The occupied robotaxi, distinct from the player's parked car. */
  readonly vehicleControl?:"robotaxi-driver"|"robotaxi-passenger";
  readonly runwayMonths:number;
  readonly cashCents:number;
  readonly reputation:number;
  readonly waterLitres:number;
  readonly capacityLitres:number;
  readonly salt:boolean;
  readonly threat:number;
  readonly vcStars?:number;
  readonly objective?:ObjectiveView;
  readonly interaction?:InteractionView;
  readonly scan?:ScanView;
  readonly map?:MapView;
  readonly vendor?:readonly VendorView[];
  readonly vendorSiteId?:string;
  readonly bounties?:readonly BountyView[];
  readonly popups?:readonly PopupView[];
  readonly phoneApps?:readonly PhoneApp[];
  /** The host checks the actual Ramen door, unlock, cooldown and daily booking cap. */
  readonly officeHours?:{readonly available:boolean;readonly detail:string;readonly remaining:number;readonly destination:MapPoint};
  readonly runway?:RunwayView;
  readonly airPlaneMode?:boolean;
  readonly performance?:{readonly fps:number;readonly drawCalls:number;readonly triangles:number;readonly simMs?:number;readonly backend?:string;readonly shadowCascades?:number};
}
export type UiCopy=(key:string,values?:Readonly<Record<string,string|number>>)=>string;
export type UiLightingPreset="live"|"noon"|"golden"|"twilight"|"night";
export interface UiCallbacks {
  readonly loadout?:(itemId:string)=>void;
  readonly streak?:(itemId:string)=>void;
  readonly openTaxi?:()=>void;
  readonly lighting?:(preset:UiLightingPreset)=>void;
  readonly purchase?:(itemId:string,siteId?:string)=>void;
  readonly startup?:(kitId:string)=>void;
  readonly closeAd?:(popupId:string)=>void;
  readonly waypoint?:(point:MapPoint)=>void;
  readonly pause?:(paused:boolean)=>void;
  readonly app?:(app:PhoneApp)=>void;
  readonly bookOfficeHours?:()=>void;
  readonly interaction?:(choiceId:string)=>void;
  /** Runway Run: start a run (or a new one), end the running one, or leave a finished run's results. */
  readonly runway?:(action:"start"|"quit"|"clear")=>void;
}
export interface UiMountOptions {
  readonly copy:UiCopy;
  readonly callbacks?:UiCallbacks;
  readonly touch?:boolean;
  readonly showPerformance?:boolean;
  readonly lightingPreset?:UiLightingPreset;
  readonly document?:Document;
  /** Share the host's keyboard when camera controls already use one. */
  readonly keyboard?:Keyboard;
  readonly saves?:SavePanelOptions;
  readonly startupChoices?:readonly string[];
  /** Audio settings panel (src/ui/audio-settings.ts), shown in the pause screen and phone settings. */
  readonly audioSettings?:(doc:Document)=>{element:HTMLElement;dispose():void};
  /** Graphics choice/controller panel, shown in the phone's Settings app. */
  readonly graphicsSettings?:(doc:Document)=>{element:HTMLElement;dispose():void};
}
export interface MountedGameUI {
  readonly element:HTMLElement;
  update(view:UiView):void;
  sampleInput():SimInput;
  /** Clear targeting presentation when the fly camera owns input. */
  hideReticle():void;
  setPhoneOpen(open:boolean):void;
  setVendorOpen(open:boolean):void;
  showStartup():void;
  dispose():void;
}
