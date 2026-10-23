import type { SimInput } from "../sim/contract.ts";
import type { Keyboard } from "../input/keyboard.ts";

/** Presentation snapshots are supplied by the owning simulation lanes. */
export interface MapPoint { readonly x:number; readonly z:number }
export interface MapNode extends MapPoint { readonly id:string }
export interface MapEdge { readonly from:string; readonly to:string; readonly length?:number }
export interface MapBlip extends MapPoint { readonly id:string; readonly kind:"water"|"mission"|"safehouse"|"bounty"|"wash"|"robot"; readonly label:string; readonly confirmed?:boolean }
export interface MapView {
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
export type PhoneApp="map"|"botBounty"|"botCheck"|"ride"|"radio"|"fogcast"|"messages"|"bank"|"playlists"|"settings";
export interface UiView {
  readonly tick:number;
  readonly playerId:string;
  readonly x:number;
  readonly z:number;
  readonly heading:number;
  readonly speedMps:number;
  readonly runwayMonths:number;
  readonly cashCents:number;
  readonly reputation:number;
  readonly waterLitres:number;
  readonly capacityLitres:number;
  readonly salt:boolean;
  readonly threat:number;
  readonly vcStars?:number;
  readonly objective?:ObjectiveView;
  readonly scan?:ScanView;
  readonly map?:MapView;
  readonly vendor?:readonly VendorView[];
  readonly bounties?:readonly BountyView[];
  readonly popups?:readonly PopupView[];
  readonly phoneApps?:readonly PhoneApp[];
  readonly airPlaneMode?:boolean;
  readonly performance?:{readonly fps:number;readonly drawCalls:number;readonly triangles:number;readonly simMs?:number};
}
export type UiCopy=(key:string,values?:Readonly<Record<string,string|number>>)=>string;
export interface UiCallbacks {
  readonly purchase?:(itemId:string)=>void;
  readonly startup?:(kitId:string)=>void;
  readonly closeAd?:(popupId:string)=>void;
  readonly waypoint?:(point:MapPoint)=>void;
  readonly pause?:(paused:boolean)=>void;
  readonly app?:(app:PhoneApp)=>void;
}
export interface UiMountOptions {
  readonly copy:UiCopy;
  readonly callbacks?:UiCallbacks;
  readonly touch?:boolean;
  readonly showPerformance?:boolean;
  readonly document?:Document;
  /** Share the host's keyboard when camera controls already use one. */
  readonly keyboard?:Keyboard;
}
export interface MountedGameUI {
  readonly element:HTMLElement;
  update(view:UiView):void;
  sampleInput():SimInput;
  setPhoneOpen(open:boolean):void;
  setVendorOpen(open:boolean):void;
  showStartup():void;
  dispose():void;
}
