import type { DoomClockState } from "../progression/doom-clock.ts";
import type { CombatActor } from "../combat-contract.ts";
import type { MissionObservedState } from "../missions/observed.ts";
import type { MissionParkingWorld, MissionParkingState } from "../missions/mechanics/runtime.ts";
import type { MissionBellState } from "../missions/mechanics/bell.ts";
import type { ParkingProgress } from "../missions/mechanics/parking.ts";
import type { RngState } from "../contract.ts";
import type { CoitContext, CoitViewerSession } from "../activities/coit-viewer.ts";
import type { Mission } from "../../content/missions.ts";
import type { Position, GameplayBody, GameplayFact, GameplayCommand, GameplayEvent, RewardActor, PlayerObservation } from "../gameplay-contract.ts";
export type { Position, GameplayBody, GameplayFact, GameplayCommand, GameplayEvent, RewardActor, PlayerObservation } from "../gameplay-contract.ts";

export interface VendorItem { rank?:number; id:string; kind:string; tier?:number; priceCents:number; wave:number; requires?:string; effect:Readonly<Record<string,number>> }
export interface GameplaySite extends Position { id:string; kind:"safehouse"|"garage"|"vendor"|"carWash"|"repairKiosk"; wave:number; radius:number; priceCents?:number; free?:boolean; vendorItems?:readonly string[] }
export interface DirectorCard { id:string; fromWave:number; radiusM:number; cooldownS:number; protectedAreas:boolean; when?:{time?:"any"|"morning"|"day"|"evening"|"night";playerState?:"any"|"onFoot"|"inCar"} }
export interface ActivityDefinition extends Position { maxSpeedMps?:number; id:string; kind:string; wave:number; radius:number; rewardCents?:number; rewardXp?:number; objective?:{event:string;count:number}; checkpoints?:readonly (Position&{id:string;radius:number})[]; timeLimitS?:number; repeatable?:boolean; cooldownS?:number }
export type GameplayMode="freeRoam"|"botSweep"|"cleanStreets"|"hideInTheCrowd"|"fogRoyale"|"otherPvP";
export interface GameplayContext { simVersion?:number; associatesAnswer?:boolean; mode?:GameplayMode; hasCoastline?:boolean; modeRoles?:Readonly<Record<string,"spotter"|"hider">>; gameWeek?:number; wave:number; bodies:readonly GameplayBody[]; observations:readonly PlayerObservation[]; actors:readonly RewardActor[]; facts:readonly GameplayFact[]; commands:readonly GameplayCommand[]; missions:readonly Mission[]; items:readonly VendorItem[]; sites:readonly GameplaySite[]; directorCards:readonly DirectorCard[]; activities:readonly ActivityDefinition[]; validKitIds:readonly string[]; day:number; month:number; gameDay?:number; doomPayFactor?:number; hour?:number; minute?:number; actions?:Readonly<Record<string,number>>; actorBodies?:readonly CombatActor[]; rustByActor?:Readonly<Record<string,number>>; missionParking?:MissionParkingWorld; waterTraces?:readonly WaterTrace[]; coit?:CoitContext }
export interface PlayerStatus { status:"active"|"bridge"|"down"|"acqui-hired"; bridgeUntil:number; resumeTick:number; safehouseId:string; startupKitId:string; downRounds:number; commandSequence:number; watchingActorId:string; watchedTicks:number }
export interface PlayerGameplayState { version:1; tick:number; nextId:number; players:Record<string,PlayerStatus>; events:GameplayEvent[] }
export interface Wallet { microclimatePaidWeek?:number; microclimateActive?:boolean; microclimateNoticeWeek?:number; cashCents:number; runwayMonths:number; reputation:number; paidActorIds:string[]; ownedItemIds:string[]; ownedSiteIds:string[]; commandSequence:number }
export interface EconomyState { settledModeIds?:string[]; version:1; tick:number; nextId:number; players:Record<string,Wallet>; factCursors:Record<string,number>; grantCursors:Record<string,number>; events:GameplayEvent[] }
export interface HeatStatus { threat:number; vcQuarters:number; lastSeenTick:number; lastAssociateSeenTick:number; recentMelts:number[]; levelMelts:number; spawnSequence:number; commandSequence:number; lastWashId?:string }
export interface HeatState { grantCursors?:Record<string,number>; version:1; tick:number; nextId:number; players:Record<string,HeatStatus>; factCursors:Record<string,number>; events:GameplayEvent[] }
export interface MissionProgress { pausedTicks?:number; stepPausedTicks?:number; missionId:string; stepId:string; status:"idle"|"active"|"complete"|"retry"|"failed"; startedTick:number; stepStartedTick:number; deadlineTick:number; questionIndex:number; objectiveCount:number; objectiveIds:string[]; meters:Record<string,number>; completedIds:string[]; rewardedIds:string[]; retryFrom:string; outcome:string; commandSequence:number; visits:number; actorAttempt?:string; pendingCampaignId?:string; observed?:MissionObservedState }
export interface MissionState { parking?:MissionParkingState; bell?:MissionBellState; version:1; tick:number; nextId:number; players:Record<string,MissionProgress>; factCursors:Record<string,number>; events:GameplayEvent[] }
export interface Progression { earnedStreaks?:string[]; achievements?:string[]; pendingStreak?:{kind:import("../progression/rules.ts").StreakId;sequence:number}; streakHeld?:boolean; xp:number; rank:number; tankTier:0|1|2; flowTier:0|1; scannerTier:1|2|3|4; nozzle:"standard"|"pressure"|"wide"; gadget:"balloon"|"sprinkler"|"speaker"; gear:"none"|"boots"|"airplane"|"microclimate"; perks:string[]; streaks:string[]; streakPoints:number; streakSequence:number; banked:Record<string,number>; commandSequence:number }
export interface ProgressionState { doom?:DoomClockState; factCursors?:Record<string,number>; version:1; tick:number; nextId:number; players:Record<string,Progression>; grantCursors:Record<string,number>; events:GameplayEvent[] }
/** One tick of the player's own water: where a stream particle went, with heights above the ground. */
export interface WaterTrace { playerId:string; ax:number; az:number; ah:number; bx:number; bz:number; bh:number }
/** A Plain Words run (src/sim/activities/plain-words.ts). word: the ladder index shown, -1 for plain words. */
/** A Coit Tower Recon run (src/sim/activities/recon.ts). */
export interface ReconRun { found:string[]; scanning:string; scanTicks:number; viewer?:CoitViewerSession; viewerCommandSequence?:number }
export interface PlainWordsRun { boards:{id:string;word:number;wash:number;sprayedUntil:number;qualified?:boolean}[]; rung:number; rebrands:number; washed:number; spinnerIds:string[]; rusted:string[]; nextRebrandTick:number }
export interface PlayerActivities { ruleFailed?:boolean; pausedTicks?:number; activityUntilTick?:number; nextDirectorTick:number; directorRng:RngState; activeCardId:string; cardUntilTick:number; cardCooldowns:Record<string,number>; activeActivityId:string; activityStartedTick:number; completedIds:string[]; commandSequence:number; checkpointIndex?:number; objectiveCount?:number; cooldowns?:Record<string,number>; officeHoursBookings?:{day:number;count:number}; officeHoursSequence?:number; plainWords?:PlainWordsRun; parking?:{ progress:ParkingProgress; interacting:boolean; tick:number }; recon?:ReconRun }
export interface ActivitiesState { version:1; tick:number; nextId:number; players:Record<string,PlayerActivities>; factCursors:Record<string,number>; events:GameplayEvent[] }
export interface GameplaySnapshot { player:PlayerGameplayState; economy:EconomyState; heat:HeatState; missions:MissionState; progression:ProgressionState; activities:ActivitiesState }
