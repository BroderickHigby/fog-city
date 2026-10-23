import {expect,it} from "vitest";
import {nextCampaignMission} from "../../src/ui/campaign.ts";
it("offers Launch Day after Spill only once the implemented wave is enabled",()=>{
  expect(nextCampaignMission(["hot-desk","spill"],2)).toBeUndefined();
  expect(nextCampaignMission(["hot-desk","spill"],4)?.id).toBe("launch-day");
  expect(nextCampaignMission(["hot-desk","spill","launch-day"],4)?.id).toBe("demoed-correctly");
});
it("stops at the implemented wave instead of auto-starting a standalone mission",()=>{
  const completed=["hot-desk","spill","launch-day","demoed-correctly","demo-day","fleet-week","hill-climb"];
  expect(nextCampaignMission(completed,4)).toBeUndefined();
});
