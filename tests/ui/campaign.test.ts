import {expect,it} from "vitest";
import {nextCampaignMission} from "../../src/ui/campaign.ts";
it("starts Spill after Hot Desk without entering standalone authoring fixtures",()=>{
  expect(nextCampaignMission([],2)?.id).toBe("hot-desk");
  expect(nextCampaignMission(["hot-desk"],2)?.id).toBe("spill");
  expect(nextCampaignMission(["hot-desk","spill"],2)).toBeUndefined();
});
