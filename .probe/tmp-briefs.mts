import { ROLE_SPECS } from "../src/platform/identity/role.js";
import { expandCapabilities } from "../src/platform/harness/capability.js";
import { toolBriefs } from "../src/platform/tools/briefs.js";

for (const role of ["business_manager", "research_worker"] as const) {
  const names = expandCapabilities(ROLE_SPECS[role].ceiling);
  const briefs = toolBriefs(names);
  console.log(`\n== ${role} (${briefs.length} 个)`);
  for (const b of briefs) {
    console.log(`[${b.group}] ${b.name} (${b.capability}, ${b.source}) :: ${b.purpose.slice(0, 36)}`);
  }
}
